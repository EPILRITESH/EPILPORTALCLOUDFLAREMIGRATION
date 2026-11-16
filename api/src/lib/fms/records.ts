// Creating FMS rows: single (with notifications) and bulk (imports — planned in memory, batched).
import type { Env } from "../../types";
import { fail } from "../util";
import { parseInstant } from "./calendar";
import { coerceValues } from "./definitions";
import { evalCondition, history, j, plannedFor, progress, type Actor, type Bundle, type Condition } from "./engine";

export interface RowInput {
  data: Record<string, unknown>;
  uid?: string;
  /** imported step state, by step position (1-based) */
  steps?: Record<number, { planned?: unknown; actual?: unknown; status?: string; values?: Record<string, unknown> }>;
}

async function allocUids(env: Env, b: Bundle, n: number): Promise<string[]> {
  const r = await env.DB.prepare("UPDATE fms_definitions SET next_uid = next_uid + ? WHERE id = ? RETURNING next_uid").bind(n, b.def.id).first<{ next_uid: number }>();
  const last = r!.next_uid - 1;
  return Array.from({ length: n }, (_, i) => `${b.def.uid_prefix}${last - n + 1 + i}`);
}

const rowFields = (b: Bundle) => b.fields.filter((f) => f.step_id == null);
const startOf = (b: Bundle, data: Record<string, unknown>, fallback: string) => {
  const d = b.def.start_field ? parseInstant(data[b.def.start_field]) : null;
  return (d || new Date(fallback)).toISOString();
};

/** Create one row from a form: strict validation, then activate STEP-1 with notifications. */
export async function createRecord(env: Env, b: Bundle, input: Record<string, unknown>, actor: Actor) {
  const { values, errors } = coerceValues(rowFields(b), input, "strict");
  if (errors.length) fail(400, errors[0], { errors });
  const [uid] = await allocUids(env, b, 1);
  const now = new Date().toISOString();
  const rec = await env.DB.prepare(
    "INSERT INTO fms_records (fms_id, uid, data, priority, start_at, created_by, created_by_name) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id",
  ).bind(b.def.id, uid, JSON.stringify(values), b.def.priority, startOf(b, values, now), actor.employeeID, actor.name).first<{ id: number }>();
  if (b.steps.length) await env.DB.batch(b.steps.map((s) => env.DB.prepare("INSERT INTO fms_record_steps (record_id, step_id, position) VALUES (?, ?, ?)").bind(rec!.id, s.id, s.position)));
  await history(env, rec!.id, null, "created", actor, "", { uid });
  await progress(env, b, rec!.id, actor);
  return { id: rec!.id, uid };
}

/**
 * Bulk create (imports). Validation per mode; imported step state is kept (planned/actual/outcome),
 * the first unfinished step is activated with its imported planned time or a computed one.
 * No notifications (would flood doers with historical rows).
 */
export async function createRecordsBulk(env: Env, b: Bundle, rows: RowInput[], actor: Actor, mode: "strict" | "lenient") {
  const created: { row: number; uid: string }[] = [];
  const failed: { row: number; errors: string[] }[] = [];
  const valid: { idx: number; row: RowInput; values: Record<string, unknown> }[] = [];
  rows.forEach((row, idx) => {
    const { values, errors } = coerceValues(rowFields(b), row.data || {}, mode);
    if (errors.length) failed.push({ row: idx + 1, errors });
    else valid.push({ idx, row, values });
  });
  if (!valid.length) return { created, failed };

  // UIDs: keep imported ones that are free, allocate the rest
  const wanted = valid.map((v) => String(v.row.uid || "").trim()).filter(Boolean);
  const taken = new Set<string>();
  for (let i = 0; i < wanted.length; i += 90) {
    const chunk = wanted.slice(i, i + 90);
    (await env.DB.prepare(`SELECT uid FROM fms_records WHERE fms_id = ? AND uid IN (${chunk.map(() => "?").join(",")})`).bind(b.def.id, ...chunk).all<{ uid: string }>()).results.forEach((r) => taken.add(r.uid));
  }
  const seen = new Set<string>();
  const needNew = valid.filter((v) => { const u = String(v.row.uid || "").trim(); if (!u || taken.has(u) || seen.has(u)) return true; seen.add(u); return false; }).length;
  const fresh = needNew ? await allocUids(env, b, needNew) : [];
  const seen2 = new Set<string>();
  const uidOf = (v: (typeof valid)[number]) => { const u = String(v.row.uid || "").trim(); if (u && !taken.has(u) && !seen2.has(u)) { seen2.add(u); return u; } return fresh.shift()!; };

  const now = new Date().toISOString();
  const iso = (x: unknown) => { const d = parseInstant(x); return d ? d.toISOString() : ""; };
  for (let i = 0; i < valid.length; i += 40) {
    const chunk = valid.slice(i, i + 40);
    const plan = chunk.map((v) => {
      const uid = uidOf(v);
      const start = startOf(b, v.values, now);
      const allVals: Record<string, unknown> = { ...v.values };
      let lastActual = "", active = 0;
      const steps = b.steps.map((s) => {
        const imp = v.row.steps?.[s.position] || {};
        const sv = imp.values || {};
        Object.assign(allVals, sv);
        const actual = iso(imp.actual);
        const outcome = String(imp.status || "").trim();
        const finished = !!actual || /^(done|close|closed|completed|yes|ok)$/i.test(outcome);
        if (finished) {
          if (actual) lastActual = actual;
          return { s, status: "done", planned: iso(imp.planned), actual, outcome: outcome || "Done", values: sv };
        }
        if (active) return { s, status: "waiting", planned: "", actual: "", outcome: "", values: sv };
        if (!evalCondition(j<Condition | null>(s.condition, null), allVals)) return { s, status: "skipped", planned: "", actual: "", outcome: "", values: sv };
        active = s.position;
        const planned = iso(imp.planned) || plannedFor(s, b, start, lastActual, allVals);
        return { s, status: "pending", planned, actual: "", outcome: "", values: sv };
      });
      return { v, uid, start, steps, active, overdueAtImport: !!active && steps.some((x) => x.status === "pending" && x.planned && x.planned < now) };
    });
    const ins = await env.DB.batch(plan.map((p) => env.DB.prepare(
      "INSERT INTO fms_records (fms_id, uid, data, priority, status, current_step, start_at, created_by, created_by_name, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
    ).bind(b.def.id, p.uid, JSON.stringify(p.v.values), b.def.priority, p.active ? "open" : "completed", p.active, p.start, actor.employeeID, actor.name, p.active ? "" : now)));
    const stepRows: string[] = [];
    const args: unknown[] = [];
    plan.forEach((p, k) => {
      const recId = (ins[k].results[0] as { id: number }).id;
      for (const st of p.steps) {
        stepRows.push("(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
        const delay = st.planned && st.actual ? Math.max(0, Math.round((new Date(st.actual).getTime() - new Date(st.planned).getTime()) / 60_000)) : 0;
        // historical rows already overdue at import: mark reminded/escalated so the cron does not flood people
        const quiet = st.status === "pending" && p.overdueAtImport ? now : "";
        args.push(recId, st.s.id, st.s.position, st.status, st.outcome, st.planned, st.actual, JSON.stringify(st.values), delay, quiet);
      }
      created.push({ row: p.v.idx + 1, uid: p.uid });
    });
    const per = 10, maxRows = Math.floor(90 / per); // stay under D1's bound-parameter limit
    const stmts: D1PreparedStatement[] = [];
    for (let r = 0; r < stepRows.length; r += maxRows) {
      stmts.push(env.DB.prepare(`INSERT INTO fms_record_steps (record_id, step_id, position, status, outcome, planned_at, actual_at, step_values, delay_minutes, escalated_at) VALUES ${stepRows.slice(r, r + maxRows).join(", ")}`)
        .bind(...args.slice(r * per, (r + maxRows) * per)));
    }
    for (let s = 0; s < stmts.length; s += 100) await env.DB.batch(stmts.slice(s, s + 100));
  }
  return { created, failed };
}

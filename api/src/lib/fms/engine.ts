// FMS engine: assignment (WHO), planning (WHEN), step progression, approvals, notifications.
import type { Env } from "../../types";
import { addWorkingDays, addWorkingHours, beforeDate, normaliseCalendar, parseInstant, type FmsCalendar } from "./calendar";
import { normName } from "../util";
import { castResult, compareValues, evaluate, toDate, type V } from "./formula";

// ------------------------------------------------------------------ types
export interface AssignSpec { departments?: string[]; designations?: string[]; employees?: string[] }
export interface Tat { type?: "none" | "hours" | "days" | "before_field" | "after_field"; value?: number; field?: string; from?: "previous" | "start" }
export interface Condition { field: string; op: "eq" | "neq" | "in" | "not_in" | "empty" | "not_empty" | "contains" | "gt" | "gte" | "lt" | "lte"; value?: unknown }
export interface PlanRule { when?: Condition[]; base?: string; offset?: number; unit?: string; at_time?: string; formula?: string }
export interface Actor { employeeID: string; name: string; department: string; designation: string; role: "admin" | "employee" }

export interface DefRow {
  id: number; fms_id: string; code: string; name: string; category: string; description: string; instructions: string;
  priority: string; status: string; archived: number; deleted: number; is_template: number; access: string; calendar: string;
  frequency: string; schedule: string; start_date: string; due_date: string; start_field: string; uid_prefix: string;
  next_uid: number; settings: string; version: number; created_by: string; created_at: string; updated_at: string;
}
export interface StepRow {
  id: number; fms_id: number; position: number; code: string; name: string; seat_id: number | null; assign: string; how: string;
  tat: string; condition: string; requires_approval: number; approver: string; status_options: string; reminder: string; escalation: string; jumps: string; plan: string; depends_on: string;
}
export interface FieldRow {
  id: number; fms_id: number; step_id: number | null; key: string; label: string; type: string; options: string;
  required: number; default_value: string; help: string; position: number; in_list: number; formula: string;
}
export interface SeatMember { kind: "department" | "designation" | "employee"; value: string; start_date: string; end_date: string; active: number }
export interface Seat { id: number; code: string; name: string; active: number; members: SeatMember[] }
export interface Bundle {
  def: DefRow; steps: StepRow[]; fields: FieldRow[]; seats: Map<number, Seat>; holidays: Set<string>; calendar: FmsCalendar;
}

export const j = <T>(s: string | null | undefined, fallback: T): T => {
  if (!s) return fallback;
  try { const v = JSON.parse(s); return (v ?? fallback) as T; } catch { return fallback; }
};
const nowIso = () => new Date().toISOString();
const todayYmd = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);

// ------------------------------------------------------------------ loading
export async function loadSeats(env: Env): Promise<Map<number, Seat>> {
  const [s, m] = await env.DB.batch([
    env.DB.prepare("SELECT id, code, name, active FROM fms_seats"),
    env.DB.prepare("SELECT seat_id, kind, value, start_date, end_date, active FROM fms_seat_members"),
  ]);
  const seats = new Map<number, Seat>((s.results as any[]).map((x) => [x.id, { ...x, members: [] }]));
  for (const x of m.results as any[]) seats.get(x.seat_id)?.members.push(x);
  return seats;
}

export async function loadHolidays(env: Env): Promise<Set<string>> {
  return new Set((await env.DB.prepare("SELECT date FROM fms_holidays").all<{ date: string }>()).results.map((r) => r.date));
}

export async function loadBundle(env: Env, fmsDbId: number): Promise<Bundle | null> {
  const [d, st, fl] = await env.DB.batch([
    env.DB.prepare("SELECT * FROM fms_definitions WHERE id = ?").bind(fmsDbId),
    env.DB.prepare("SELECT * FROM fms_steps WHERE fms_id = ? ORDER BY position, id").bind(fmsDbId),
    env.DB.prepare("SELECT * FROM fms_fields WHERE fms_id = ? ORDER BY position, id").bind(fmsDbId),
  ]);
  const def = (d.results as DefRow[])[0];
  if (!def) return null;
  const [seats, holidays] = await Promise.all([loadSeats(env), loadHolidays(env)]);
  return { def, steps: st.results as StepRow[], fields: fl.results as FieldRow[], seats, holidays, calendar: normaliseCalendar(j(def.calendar, {})) };
}

// ------------------------------------------------------------------ WHO
const inList = (list: string[] | undefined, v: string) => !!list?.length && list.some((x) => normName(x) === normName(v) && normName(v) !== "");

export function matchesSpec(spec: AssignSpec | undefined, u: Pick<Actor, "employeeID" | "department" | "designation">): boolean {
  if (!spec) return false;
  return (spec.employees || []).includes(u.employeeID) || inList(spec.departments, u.department) || inList(spec.designations, u.designation);
}

export function seatMatches(seat: Seat | undefined, u: Pick<Actor, "employeeID" | "department" | "designation">, day = todayYmd()): boolean {
  if (!seat || !seat.active) return false;
  return seat.members.some((m) => m.active && (!m.start_date || m.start_date <= day) && (!m.end_date || m.end_date >= day)
    && (m.kind === "employee" ? m.value === u.employeeID : m.kind === "department" ? normName(m.value) === normName(u.department) : normName(m.value) === normName(u.designation)));
}

export const specEmpty = (s: AssignSpec | undefined) => !s || (!s.departments?.length && !s.designations?.length && !s.employees?.length);

/** Can this user do the step (before any per-row reassignment)? */
export function stepEligible(step: StepRow, seats: Map<number, Seat>, u: Actor): boolean {
  return (step.seat_id != null && seatMatches(seats.get(step.seat_id), u)) || matchesSpec(j<AssignSpec>(step.assign, {}), u);
}

/** Who can act on a row's step: the reassigned employee, else the step's seat/assignment. Admins always. */
export function canActOn(rs: { assigned_to: string }, step: StepRow, seats: Map<number, Seat>, u: Actor): boolean {
  if (u.role === "admin") return true;
  if (rs.assigned_to) return rs.assigned_to === u.employeeID;
  return stepEligible(step, seats, u);
}

export function canApprove(step: StepRow, seats: Map<number, Seat>, u: Actor): boolean {
  if (u.role === "admin") return true;
  const a = j<AssignSpec & { seat_id?: number | null }>(step.approver, {});
  return (a.seat_id != null && seatMatches(seats.get(Number(a.seat_id)), u)) || matchesSpec(a, u);
}

/** Can the user see this FMS in the doer panel / create rows in it? */
export function fmsVisible(b: Pick<Bundle, "def" | "steps" | "seats">, u: Actor): { view: boolean; create: boolean } {
  if (u.role === "admin") return { view: true, create: true };
  if (b.def.deleted || b.def.archived || b.def.status !== "active") return { view: false, create: false };
  // Seen by the FMS's "Visible to" departments / designations / employees AND by every doer or approver
  // of any step (each acts only on their own step). New entries: "Visible to" people and STEP-1 doers.
  const byAccess = matchesSpec(j<AssignSpec>(b.def.access, {}), u);
  const onStep = b.steps.some((s) => stepEligible(s, b.seats, u) || (!!s.requires_approval && !specEmpty(j<AssignSpec>(s.approver, {})) && canApprove(s, b.seats, u)));
  const first = b.steps.find((s) => !dependsOn(s).length) || b.steps[0];
  return { view: byAccess || onStep, create: byAccess || (!!first && stepEligible(first, b.seats, u)) };
}

/** Active employees (and optionally admins) matching a step's assignment — for notifications. */
export async function resolvePeople(env: Env, match: (u: Actor) => boolean): Promise<Actor[]> {
  const { results } = await env.DB.prepare("SELECT employee_id, name, department, designation, role FROM users WHERE is_active = 1").all<any>();
  return results.map((r) => ({ employeeID: r.employee_id, name: r.name, department: r.department, designation: r.designation, role: r.role }))
    .filter((u) => u.role === "employee" && match(u));
}

// ------------------------------------------------------------------ WHEN
export function evalCondition(cond: Condition | Condition[] | null | undefined, values: Record<string, unknown>): boolean {
  if (Array.isArray(cond)) return cond.every((c) => evalCondition(c, values));
  if (!cond || !cond.field) return true;
  const raw = lookup(values, cond.field);
  if (["gt", "gte", "lt", "lte"].includes(cond.op)) {
    if (raw === "" || raw === null || raw === undefined) return false;
    const c = compareValues(raw as V, cond.value as V);
    return cond.op === "gt" ? c > 0 : cond.op === "gte" ? c >= 0 : cond.op === "lt" ? c < 0 : c <= 0;
  }
  const norm = (x: unknown) => (x instanceof Date ? x.toISOString() : String(x ?? "")).trim().toLowerCase();
  const v = Array.isArray(raw) ? raw.map(norm) : norm(raw);
  const target = Array.isArray(cond.value) ? cond.value.map(norm) : norm(cond.value);
  const has = (t: string) => (Array.isArray(v) ? v.includes(t) : v === t);
  switch (cond.op) {
    case "eq": return Array.isArray(target) ? target.some(has) : has(target);
    case "neq": return Array.isArray(target) ? !target.some(has) : !has(target);
    case "in": return (Array.isArray(target) ? target : String(target).split(",").map((x) => x.trim())).some(has);
    case "not_in": return !(Array.isArray(target) ? target : String(target).split(",").map((x) => x.trim())).some(has);
    case "empty": return Array.isArray(v) ? v.length === 0 : v === "";
    case "not_empty": return Array.isArray(v) ? v.length > 0 : v !== "";
    case "contains": return (Array.isArray(v) ? v.join(" ") : v).includes(String(target));
  }
  return true;
}

const lookup = (values: Record<string, unknown>, key: string) => {
  if (key in values) return values[key];
  const k = key.trim().toLowerCase();
  return k in values ? values[k] : "";
};

/** Steps that must be finished before this one starts ('' = previous step, '[]' = none). */
export function dependsOn(step: Pick<StepRow, "position" | "depends_on">): number[] {
  if (!step.depends_on) return step.position > 1 ? [step.position - 1] : [];
  return j<number[]>(step.depends_on, []).map(Number).filter((n) => n > 0 && n !== step.position);
}

/**
 * Everything a condition / formula / plan rule can refer to: columns and step inputs by key,
 * stepN.actual|planned|status|outcome|done_by|remarks, row.start|created|uid.
 */
export function buildRefs(b: Pick<Bundle, "fields" | "steps">, rec: { data: Record<string, unknown>; uid?: string; start_at?: string; created_at?: string },
  rsteps: Pick<RecordStepRow, "step_id" | "position" | "status" | "outcome" | "planned_at" | "actual_at" | "done_by_name" | "remarks" | "step_values">[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const typeOf = new Map(b.fields.map((f) => [f.key, f.type]));
  const put = (k: string, v: unknown) => { const t = typeOf.get(k); out[k] = (t === "date" || t === "datetime") && v ? toDate(v as V) || v : v; };
  for (const [k, v] of Object.entries(rec.data || {})) put(k, v);
  for (const rs of rsteps) {
    for (const [k, v] of Object.entries(j<Record<string, unknown>>(rs.step_values, {}))) put(k, v);
    const p = `step${rs.position}`;
    out[`${p}.actual`] = rs.actual_at ? new Date(rs.actual_at) : "";
    out[`${p}.planned`] = rs.planned_at ? new Date(rs.planned_at) : "";
    out[`${p}.status`] = rs.status === "done" ? rs.outcome || "Done" : rs.status;
    out[`${p}.outcome`] = rs.outcome; out[`${p}.done_by`] = rs.done_by_name; out[`${p}.remarks`] = rs.remarks;
  }
  out["row.start"] = rec.start_at ? new Date(rec.start_at) : rec.created_at ? new Date(rec.created_at) : "";
  out["row.created"] = rec.created_at ? new Date(rec.created_at) : "";
  out["row.uid"] = rec.uid || "";
  return out;
}

export const formulaCtx = (b: Pick<Bundle, "calendar" | "holidays">, refs: Record<string, unknown>) =>
  ({ ref: (n: string) => (lookup(refs, n) ?? "") as V, cal: b.calendar, holidays: b.holidays });

/** Recompute calculated columns / step inputs in position order. Returns the changed data + step values. */
export function computeFormulas(b: Pick<Bundle, "fields" | "steps" | "calendar" | "holidays">, rec: { data: Record<string, unknown>; uid?: string; start_at?: string; created_at?: string },
  rsteps: RecordStepRow[]) {
  const calc = b.fields.filter((f) => f.formula);
  if (!calc.length) return { data: rec.data, stepValues: new Map<number, Record<string, unknown>>(), changed: false };
  const data = { ...rec.data };
  const stepValues = new Map<number, Record<string, unknown>>();
  const stepOfField = new Map(b.fields.map((f) => [f.key, f.step_id]));
  let changed = false;
  for (let pass = 0; pass < 2; pass++) { // second pass lets formulas use other formulas defined later
    for (const f of calc) {
      const refs = buildRefs(b, { ...rec, data }, rsteps.map((rs) => ({ ...rs, step_values: JSON.stringify({ ...j<Record<string, unknown>>(rs.step_values, {}), ...(stepValues.get(rs.step_id) || {}) }) })));
      let v: unknown;
      try { v = castResult(evaluate(f.formula, formulaCtx(b, refs)), f.type); } catch { v = "#ERROR"; }
      const sid = stepOfField.get(f.key);
      if (sid == null) { if (JSON.stringify(data[f.key]) !== JSON.stringify(v)) { data[f.key] = v; changed = true; } }
      else {
        const rs = rsteps.find((x) => x.step_id === sid);
        const cur = { ...j<Record<string, unknown>>(rs?.step_values, {}), ...(stepValues.get(sid) || {}) };
        if (rs && JSON.stringify(cur[f.key]) !== JSON.stringify(v)) { stepValues.set(sid, { ...(stepValues.get(sid) || {}), [f.key]: v }); changed = true; }
      }
    }
  }
  return { data, stepValues, changed };
}

/** Plan a step from its rules (first matching), else from its TAT. "" = cannot plan yet. */
export function planStep(step: StepRow, b: Pick<Bundle, "calendar" | "holidays" | "steps">, refs: Record<string, unknown>, prevActualIso: string, nowIso = new Date().toISOString()): string {
  const rules = j<{ rules?: PlanRule[] }>(step.plan, {}).rules || [];
  for (const r of rules) {
    if (!evalCondition(r.when || [], refs)) continue;
    try {
      let d: Date | null;
      const ctx = formulaCtx(b, refs);
      if (r.formula && r.formula.trim()) d = toDate(evaluate(r.formula, ctx));
      else {
        const base = r.base || "previous";
        let bv: unknown;
        if (base === "previous") bv = prevActualIso || refs["row.start"];
        else if (base === "start") bv = refs["row.start"];
        else if (base === "created") bv = refs["row.created"];
        else if (base === "activated") bv = nowIso;
        else if (base.startsWith("step:")) { const [, pos, what] = base.split(":"); bv = refs[`step${pos}.${what || "actual"}`]; }
        else if (base.startsWith("field:")) bv = lookup(refs, base.slice(6));
        const bd = toDate(bv as V);
        if (!bd) return "";
        const n = Number(r.offset || 0);
        const fn = { working_days: "ADDWORKDAYS", working_hours: "ADDWORKHOURS", days: "ADDDAYS", hours: "ADDHOURS", minutes: "ADDMINUTES" }[r.unit || "working_days"] || "ADDWORKDAYS";
        d = toDate(evaluate(`${fn}({__base}, ${n})`, { ...ctx, ref: (x) => (x === "__base" ? bd : ctx.ref(x)) }));
      }
      if (d && r.at_time && /^\d{1,2}:\d{2}$/.test(r.at_time)) d = toDate(evaluate(`SETTIME({__d}, "${r.at_time}")`, { ...ctx, ref: () => d }));
      return d ? d.toISOString() : "";
    } catch { return ""; }
  }
  return plannedFor(step, b as Bundle, String(refs["row.start"] instanceof Date ? (refs["row.start"] as Date).toISOString() : ""), prevActualIso, refs);
}

export function plannedFor(step: StepRow, b: Bundle, startIso: string, prevActualIso: string, values: Record<string, unknown>): string {
  const t = j<Tat>(step.tat, {});
  const type = t.type || "none";
  const n = Number(t.value || 0);
  const base = parseInstant(t.from === "start" ? startIso : prevActualIso || startIso);
  if (type === "hours" && base) return addWorkingHours(base, n, b.calendar, b.holidays).toISOString();
  if (type === "days" && base) return addWorkingDays(base, n, b.calendar, b.holidays).toISOString();
  if (type === "before_field" || type === "after_field") {
    const raw = values[t.field || ""];
    const fd = raw instanceof Date ? raw : parseInstant(raw);
    if (!fd) return "";
    return (type === "before_field" ? beforeDate(fd, n) : addWorkingDays(fd, n, b.calendar, b.holidays)).toISOString();
  }
  return "";
}

// ------------------------------------------------------------------ history + notifications
export async function history(env: Env, recordId: number, recordStepId: number | null, action: string, actor: Pick<Actor, "employeeID" | "name"> | null, remarks = "", detail: unknown = {}) {
  await env.DB.prepare("INSERT INTO fms_step_history (record_id, record_step_id, action, actor, actor_name, remarks, detail) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(recordId, recordStepId, action, actor?.employeeID || "system", actor?.name || "System", remarks, JSON.stringify(detail)).run();
}

export async function notify(env: Env, people: { employeeID: string; role?: string }[], n: { kind: string; title: string; body?: string; fms_id?: number; record_id?: number; record_step_id?: number }) {
  const uniq = [...new Map(people.map((p) => [`${p.role || "employee"}:${p.employeeID}`, p])).values()];
  const stmts = uniq.map((p) => env.DB.prepare(
    "INSERT INTO fms_notifications (recipient, recipient_role, kind, title, body, fms_id, record_id, record_step_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).bind(p.employeeID, p.role === "admin" ? "admin" : "employee", n.kind, n.title, n.body || "", n.fms_id ?? null, n.record_id ?? null, n.record_step_id ?? null));
  for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));
}

export async function admins(env: Env): Promise<{ employeeID: string; role: string }[]> {
  return (await env.DB.prepare("SELECT employee_id FROM users WHERE role = 'admin' AND is_active = 1").all<{ employee_id: string }>()).results
    .map((r) => ({ employeeID: r.employee_id, role: "admin" }));
}

export async function stepPeople(env: Env, b: Bundle, step: StepRow, assignedTo: string): Promise<{ employeeID: string }[]> {
  if (assignedTo) return [{ employeeID: assignedTo }];
  return resolvePeople(env, (u) => stepEligible(step, b.seats, u));
}

// ------------------------------------------------------------------ progression
export interface RecordStepRow {
  id: number; record_id: number; step_id: number; position: number; status: string; outcome: string; planned_at: string; actual_at: string;
  assigned_to: string; done_by: string; done_by_name: string; step_values: string; remarks: string; submitted_at: string;
  approved_by: string; approved_at: string; rejection_reason: string; delay_minutes: number; updated_at: string;
}

/** All values visible to conditions/TAT: row data + every step's inputs. */
export function allValues(data: Record<string, unknown>, rsteps: RecordStepRow[]): Record<string, unknown> {
  const out: Record<string, unknown> = { ...data };
  for (const rs of rsteps) Object.assign(out, j<Record<string, unknown>>(rs.step_values, {}));
  return out;
}

/** Recompute calculated columns of one row (any status) — after an admin edit or a formula change. */
export async function refreshFormulas(env: Env, b: Bundle, recordId: number) {
  const rec = await env.DB.prepare("SELECT * FROM fms_records WHERE id = ?").bind(recordId).first<any>();
  if (!rec) return;
  const rsteps = (await env.DB.prepare("SELECT * FROM fms_record_steps WHERE record_id = ? ORDER BY position").bind(recordId).all<RecordStepRow>()).results;
  const stmts = await saveFormulas(env, b, rec, rsteps);
  if (stmts) await env.DB.batch(stmts);
}

async function saveFormulas(env: Env, b: Bundle, rec: any, rsteps: RecordStepRow[]) {
  const f = computeFormulas(b, { data: j(rec.data, {}), uid: rec.uid, start_at: rec.start_at, created_at: rec.created_at }, rsteps);
  if (!f.changed) return 0;
  const stmts = [env.DB.prepare("UPDATE fms_records SET data = ? WHERE id = ?").bind(JSON.stringify(f.data), rec.id)];
  for (const [sid, vals] of f.stepValues) {
    const rs = rsteps.find((x) => x.step_id === sid)!;
    stmts.push(env.DB.prepare("UPDATE fms_record_steps SET step_values = ? WHERE id = ?").bind(JSON.stringify({ ...j<Record<string, unknown>>(rs.step_values, {}), ...vals }), rs.id));
  }
  return stmts;
}

/** Recompute calculated columns for a whole FMS, a page at a time. */
export async function refreshAllFormulas(env: Env, b: Bundle) {
  if (!b.fields.some((f) => f.formula)) return { rows: 0, changed: 0 };
  let last = 0, rows = 0, changed = 0;
  for (;;) {
    const recs = (await env.DB.prepare("SELECT * FROM fms_records WHERE fms_id = ? AND deleted = 0 AND id > ? ORDER BY id LIMIT 300").bind(b.def.id, last).all<any>()).results;
    if (!recs.length) break;
    const ids = recs.map((r) => r.id);
    const steps: RecordStepRow[] = [];
    for (let i = 0; i < ids.length; i += 90) {
      const chunk = ids.slice(i, i + 90);
      steps.push(...(await env.DB.prepare(`SELECT * FROM fms_record_steps WHERE record_id IN (${chunk.map(() => "?").join(",")}) ORDER BY position`).bind(...chunk).all<RecordStepRow>()).results);
    }
    const stmts: D1PreparedStatement[] = [];
    for (const r of recs) {
      const s = await saveFormulas(env, b, r, steps.filter((x) => x.record_id === r.id));
      if (s) { stmts.push(...s); changed++; }
    }
    for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));
    rows += recs.length; last = recs[recs.length - 1].id;
    if (recs.length < 300) break;
  }
  return { rows, changed };
}

const FINISHED = new Set(["done", "skipped"]);
const ACTIVE_STATES = new Set(["pending", "in_progress", "submitted", "rejected"]);

/**
 * Move a row forward. Recomputes calculated columns, then starts every waiting step whose
 * "starts after" steps are finished (skipping it when its condition is false), plans it from its
 * plan rules / TAT and notifies its doers; plans active steps that could not be planned before;
 * completes the row when nothing is left.
 */
export async function progress(env: Env, b: Bundle, recordId: number, actor: Actor | null) {
  const rec = await env.DB.prepare("SELECT * FROM fms_records WHERE id = ?").bind(recordId).first<any>();
  if (!rec || rec.status !== "open") return;
  const rsteps = (await env.DB.prepare("SELECT * FROM fms_record_steps WHERE record_id = ? ORDER BY position, id").bind(recordId).all<RecordStepRow>()).results;
  const stepById = new Map(b.steps.map((s) => [s.id, s]));
  let data = j<Record<string, unknown>>(rec.data, {});
  const recomputeFormulas = async () => {
    const f = computeFormulas(b, { data, uid: rec.uid, start_at: rec.start_at, created_at: rec.created_at }, rsteps);
    if (!f.changed) return;
    data = f.data;
    const stmts = [env.DB.prepare("UPDATE fms_records SET data = ?, updated_at = ? WHERE id = ?").bind(JSON.stringify(data), nowIso(), recordId)];
    for (const [sid, vals] of f.stepValues) {
      const rs = rsteps.find((x) => x.step_id === sid)!;
      rs.step_values = JSON.stringify({ ...j<Record<string, unknown>>(rs.step_values, {}), ...vals });
      stmts.push(env.DB.prepare("UPDATE fms_record_steps SET step_values = ? WHERE id = ?").bind(rs.step_values, rs.id));
    }
    await env.DB.batch(stmts);
  };
  await recomputeFormulas();
  const refsNow = () => buildRefs(b, { data, uid: rec.uid, start_at: rec.start_at, created_at: rec.created_at }, rsteps);
  const byPos = new Map(rsteps.map((r) => [r.position, r]));
  const prevActual = (deps: number[]) => deps.map((p) => byPos.get(p)?.actual_at || "").filter(Boolean).sort().pop() || "";

  for (let guard = 0, changed = true; changed && guard < 50; guard++) {
    changed = false;
    for (const rs of rsteps) {
      if (rs.status !== "waiting") continue;
      const step = stepById.get(rs.step_id);
      if (!step) continue;
      const deps = dependsOn(step);
      if (!deps.every((p) => !byPos.has(p) || FINISHED.has(byPos.get(p)!.status))) continue;
      const refs = refsNow();
      if (!evalCondition(j<Condition | null>(step.condition, null), refs)) {
        await env.DB.prepare("UPDATE fms_record_steps SET status = 'skipped', updated_at = ? WHERE id = ?").bind(nowIso(), rs.id).run();
        rs.status = "skipped"; changed = true;
        await history(env, recordId, rs.id, "skipped", null, "Condition not met");
        continue;
      }
      const planned = planStep(step, b, refs, prevActual(deps));
      await env.DB.prepare("UPDATE fms_record_steps SET status = 'pending', planned_at = ?, updated_at = ? WHERE id = ?").bind(planned, nowIso(), rs.id).run();
      rs.status = "pending"; rs.planned_at = planned; changed = true;
      await history(env, recordId, rs.id, "assigned", actor, "", { step: step.name, planned });
      const people = await stepPeople(env, b, step, rs.assigned_to);
      await notify(env, people, {
        kind: "assigned", title: `New task: ${step.name}`, body: `${b.def.name} · ${rec.uid}${planned ? ` · due ${planned}` : ""}`,
        fms_id: b.def.id, record_id: recordId, record_step_id: rs.id,
      });
    }
  }
  // active steps whose plan depended on something that only exists now (e.g. another step's actual)
  for (const rs of rsteps) {
    if (!ACTIVE_STATES.has(rs.status) || rs.planned_at) continue;
    const step = stepById.get(rs.step_id);
    if (!step) continue;
    const planned = planStep(step, b, refsNow(), prevActual(dependsOn(step)));
    if (planned) { await env.DB.prepare("UPDATE fms_record_steps SET planned_at = ?, updated_at = ? WHERE id = ?").bind(planned, nowIso(), rs.id).run(); rs.planned_at = planned; }
  }
  const active = rsteps.filter((r) => ACTIVE_STATES.has(r.status)).map((r) => r.position);
  if (active.length || rsteps.some((r) => r.status === "waiting")) {
    await env.DB.prepare("UPDATE fms_records SET current_step = ?, updated_at = ? WHERE id = ?").bind(active.length ? Math.min(...active) : 0, nowIso(), recordId).run();
    return;
  }
  await env.DB.prepare("UPDATE fms_records SET status = 'completed', current_step = 0, completed_at = ?, updated_at = ? WHERE id = ?").bind(nowIso(), nowIso(), recordId).run();
  await history(env, recordId, null, "completed", null);
}

/** A status option with a jump (e.g. "Close" → STEP-5) skips the waiting steps in between. */
export async function applyJump(env: Env, b: Bundle, recordId: number, step: StepRow, outcome: string, actor: Actor | null) {
  const to = Number(j<Record<string, number>>(step.jumps, {})[outcome] || 0);
  if (!to || to <= step.position + 1) return;
  const r = await env.DB.prepare("UPDATE fms_record_steps SET status = 'skipped', updated_at = ? WHERE record_id = ? AND position > ? AND position < ? AND status = 'waiting' RETURNING id")
    .bind(nowIso(), recordId, step.position, to).all<{ id: number }>();
  if (r.results.length) await history(env, recordId, null, "jumped", actor, `${outcome} → ${b.steps.find((s) => s.position === to)?.code || `STEP-${to}`}`, { skipped: r.results.length });
}

export const delayMinutes = (planned: string, actual: string) => {
  const p = planned ? new Date(planned).getTime() : NaN, a = actual ? new Date(actual).getTime() : NaN;
  return isNaN(p) || isNaN(a) ? 0 : Math.max(0, Math.round((a - p) / 60_000));
};

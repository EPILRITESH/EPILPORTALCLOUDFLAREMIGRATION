// Step actions (start / draft / complete / approve / reject / reassign / reopen / planned / extension / skip)
// and the doer's task queries.
import type { Env } from "../../types";
import { fail, str } from "../util";
import { coerceValues } from "./definitions";
import { parseInstant, istDay } from "./calendar";
import {
  admins, canActOn, canApprove, delayMinutes, history, j, loadBundle, loadSeats, notify, progress, resolvePeople, stepEligible,
  type Actor, type AssignSpec, type Bundle, type RecordStepRow, type Seat, type StepRow,
} from "./engine";

const now = () => new Date().toISOString();
const ACTIVE = ["pending", "in_progress", "rejected"];

export interface StepCtx { b: Bundle; rec: any; rs: RecordStepRow; step: StepRow }

export async function stepCtx(env: Env, rsId: number): Promise<StepCtx> {
  const rs = await env.DB.prepare("SELECT * FROM fms_record_steps WHERE id = ?").bind(rsId).first<RecordStepRow>();
  if (!rs) fail(404, "Task not found");
  const rec = await env.DB.prepare("SELECT * FROM fms_records WHERE id = ?").bind(rs.record_id).first<any>();
  if (!rec || rec.deleted) fail(404, "Row not found");
  const b = await loadBundle(env, rec.fms_id);
  if (!b || b.def.deleted) fail(404, "FMS not found");
  const step = b.steps.find((s) => s.id === rs.step_id);
  if (!step) fail(404, "Step not found");
  return { b, rec, rs, step };
}

const stepFields = (b: Bundle, stepId: number) => b.fields.filter((f) => f.step_id === stepId);

function mustAct(ctx: StepCtx, u: Actor) {
  if (!canActOn(ctx.rs, ctx.step, ctx.b.seats, u)) fail(403, "This step is not assigned to you");
  if (ctx.rec.status !== "open") fail(409, `This row is ${ctx.rec.status}`);
}

export async function startStep(env: Env, ctx: StepCtx, u: Actor) {
  mustAct(ctx, u);
  if (!["pending", "rejected"].includes(ctx.rs.status)) fail(409, `Step is ${ctx.rs.status}`);
  await env.DB.prepare("UPDATE fms_record_steps SET status = 'in_progress', updated_at = ? WHERE id = ?").bind(now(), ctx.rs.id).run();
  await history(env, ctx.rec.id, ctx.rs.id, "started", u);
}

/** Save step inputs + remarks without finishing (draft). */
export async function draftStep(env: Env, ctx: StepCtx, u: Actor, body: { values?: Record<string, unknown>; remarks?: string }) {
  mustAct(ctx, u);
  if (!ACTIVE.includes(ctx.rs.status)) fail(409, `Step is ${ctx.rs.status}`);
  const { values, errors } = coerceValues(stepFields(ctx.b, ctx.step.id), body.values || {}, "partial");
  if (errors.length) fail(400, errors[0], { errors });
  const merged = { ...j<Record<string, unknown>>(ctx.rs.step_values, {}), ...values };
  await env.DB.prepare("UPDATE fms_record_steps SET step_values = ?, remarks = ?, status = CASE WHEN status = 'pending' THEN 'in_progress' ELSE status END, updated_at = ? WHERE id = ?")
    .bind(JSON.stringify(merged), body.remarks !== undefined ? str(body.remarks).slice(0, 5000) : ctx.rs.remarks, now(), ctx.rs.id).run();
  await history(env, ctx.rec.id, ctx.rs.id, "draft_saved", u, str(body.remarks));
  return merged;
}

/** Finish the step: approval → submitted, otherwise done and the row moves to the next step. */
export async function completeStep(env: Env, ctx: StepCtx, u: Actor, body: { values?: Record<string, unknown>; remarks?: string; outcome?: string }) {
  mustAct(ctx, u);
  if (!ACTIVE.includes(ctx.rs.status)) fail(409, ctx.rs.status === "submitted" ? "Already submitted — waiting for approval" : `Step is ${ctx.rs.status}`);
  const merged = { ...j<Record<string, unknown>>(ctx.rs.step_values, {}), ...(body.values || {}) };
  const { values, errors } = coerceValues(stepFields(ctx.b, ctx.step.id), merged, "strict");
  if (errors.length) fail(400, errors[0], { errors });
  const options = j<string[]>(ctx.step.status_options, ["Done"]);
  const outcome = str(body.outcome).trim() || options[0] || "Done";
  if (options.length && !options.includes(outcome)) fail(400, `Status must be one of: ${options.join(", ")}`);
  const t = now();
  const remarks = body.remarks !== undefined ? str(body.remarks).slice(0, 5000) : ctx.rs.remarks;
  if (ctx.step.requires_approval) {
    await env.DB.prepare(`UPDATE fms_record_steps SET status = 'submitted', outcome = ?, step_values = ?, remarks = ?, submitted_at = ?, done_by = ?, done_by_name = ?,
      rejection_reason = '', updated_at = ? WHERE id = ?`).bind(outcome, JSON.stringify(values), remarks, t, u.employeeID, u.name, t, ctx.rs.id).run();
    await history(env, ctx.rec.id, ctx.rs.id, ctx.rs.status === "rejected" ? "resubmitted" : "submitted", u, remarks, { outcome });
    const a = j<AssignSpec & { seat_id?: number | null }>(ctx.step.approver, {});
    const approvers = await resolvePeople(env, (p) => canApprove(ctx.step, ctx.b.seats, p));
    await notify(env, [...approvers, ...(a.seat_id || a.employees?.length || a.departments?.length || a.designations?.length ? [] : await admins(env))], {
      kind: "approval", title: `Approval needed: ${ctx.step.name}`, body: `${ctx.b.def.name} · ${ctx.rec.uid} · by ${u.name}`,
      fms_id: ctx.b.def.id, record_id: ctx.rec.id, record_step_id: ctx.rs.id,
    });
    return { status: "submitted" };
  }
  await env.DB.prepare(`UPDATE fms_record_steps SET status = 'done', outcome = ?, step_values = ?, remarks = ?, actual_at = ?, submitted_at = ?, done_by = ?, done_by_name = ?,
    delay_minutes = ?, rejection_reason = '', updated_at = ? WHERE id = ?`)
    .bind(outcome, JSON.stringify(values), remarks, t, t, u.employeeID, u.name, delayMinutes(ctx.rs.planned_at, t), t, ctx.rs.id).run();
  await history(env, ctx.rec.id, ctx.rs.id, "completed", u, remarks, { outcome });
  await progress(env, ctx.b, ctx.rec.id, u);
  return { status: "done" };
}

function mustApprove(ctx: StepCtx, u: Actor) {
  if (!canApprove(ctx.step, ctx.b.seats, u)) fail(403, "You are not an approver for this step");
  if (ctx.rs.status !== "submitted") fail(409, "Nothing to approve — the step is not submitted");
}

export async function approveStep(env: Env, ctx: StepCtx, u: Actor, remarks: string) {
  mustApprove(ctx, u);
  const t = now();
  const actual = ctx.rs.submitted_at || t; // completion time is when the doer submitted
  await env.DB.prepare(`UPDATE fms_record_steps SET status = 'done', actual_at = ?, approved_by = ?, approved_at = ?, delay_minutes = ?, updated_at = ? WHERE id = ?`)
    .bind(actual, u.name, t, delayMinutes(ctx.rs.planned_at, actual), t, ctx.rs.id).run();
  await history(env, ctx.rec.id, ctx.rs.id, "approved", u, remarks);
  if (ctx.rs.done_by) await notify(env, [{ employeeID: ctx.rs.done_by }], { kind: "approved", title: `Approved: ${ctx.step.name}`, body: `${ctx.b.def.name} · ${ctx.rec.uid}`, fms_id: ctx.b.def.id, record_id: ctx.rec.id, record_step_id: ctx.rs.id });
  await progress(env, ctx.b, ctx.rec.id, u);
}

export async function rejectStep(env: Env, ctx: StepCtx, u: Actor, reason: string) {
  mustApprove(ctx, u);
  if (!reason.trim()) fail(400, "Rejection reason is required");
  await env.DB.prepare("UPDATE fms_record_steps SET status = 'rejected', rejection_reason = ?, approved_by = '', approved_at = '', updated_at = ? WHERE id = ?")
    .bind(reason.trim().slice(0, 2000), now(), ctx.rs.id).run();
  await history(env, ctx.rec.id, ctx.rs.id, "rejected", u, reason);
  const to = ctx.rs.done_by ? [{ employeeID: ctx.rs.done_by }] : [];
  await notify(env, to, { kind: "rejected", title: `Sent back: ${ctx.step.name}`, body: `${ctx.rec.uid} · ${reason.trim()}`, fms_id: ctx.b.def.id, record_id: ctx.rec.id, record_step_id: ctx.rs.id });
}

export async function reassignStep(env: Env, ctx: StepCtx, u: Actor, employeeId: string, reason: string) {
  if (u.role !== "admin") fail(403, "Admin access required");
  let name = "";
  if (employeeId) {
    const e = await env.DB.prepare("SELECT name FROM users WHERE employee_id = ? AND role = 'employee' AND is_active = 1").bind(employeeId).first<{ name: string }>();
    if (!e) fail(404, "Employee not found");
    name = e.name;
  }
  await env.DB.prepare("UPDATE fms_record_steps SET assigned_to = ?, updated_at = ? WHERE id = ?").bind(employeeId, now(), ctx.rs.id).run();
  await history(env, ctx.rec.id, ctx.rs.id, employeeId ? "reassigned" : "assignment_cleared", u, reason, { to: employeeId, name });
  if (employeeId && ACTIVE.concat("submitted").includes(ctx.rs.status)) {
    await notify(env, [{ employeeID: employeeId }], { kind: "assigned", title: `Task assigned to you: ${ctx.step.name}`, body: `${ctx.b.def.name} · ${ctx.rec.uid}`, fms_id: ctx.b.def.id, record_id: ctx.rec.id, record_step_id: ctx.rs.id });
  }
  return name;
}

/** Re-open a finished/skipped step: it becomes active again and every later step goes back to waiting. */
export async function reopenStep(env: Env, ctx: StepCtx, u: Actor, reason: string) {
  if (u.role !== "admin") fail(403, "Admin access required");
  if (!["done", "skipped", "submitted", "rejected"].includes(ctx.rs.status)) fail(409, "Only finished steps can be re-opened");
  const t = now();
  await env.DB.batch([
    env.DB.prepare(`UPDATE fms_record_steps SET status = 'pending', actual_at = '', outcome = '', approved_by = '', approved_at = '', submitted_at = '', delay_minutes = 0,
      reminded_at = '', escalated_at = '', updated_at = ? WHERE id = ?`).bind(t, ctx.rs.id),
    env.DB.prepare(`UPDATE fms_record_steps SET status = 'waiting', planned_at = '', actual_at = '', outcome = '', done_by = '', done_by_name = '', approved_by = '', approved_at = '',
      submitted_at = '', delay_minutes = 0, reminded_at = '', escalated_at = '', rejection_reason = '', updated_at = ? WHERE record_id = ? AND position > ?`).bind(t, ctx.rec.id, ctx.rs.position),
    env.DB.prepare("UPDATE fms_records SET status = 'open', current_step = ?, completed_at = '', updated_at = ? WHERE id = ?").bind(ctx.rs.position, t, ctx.rec.id),
  ]);
  await history(env, ctx.rec.id, ctx.rs.id, "reopened", u, reason);
}

export async function setPlanned(env: Env, ctx: StepCtx, u: Actor, planned: unknown, reason: string) {
  if (u.role !== "admin") fail(403, "Admin access required");
  const d = parseInstant(planned);
  if (!d) fail(400, "Give a valid planned date/time");
  await env.DB.prepare("UPDATE fms_record_steps SET planned_at = ?, reminded_at = '', escalated_at = '', updated_at = ? WHERE id = ?").bind(d.toISOString(), now(), ctx.rs.id).run();
  await history(env, ctx.rec.id, ctx.rs.id, "planned_changed", u, reason, { from: ctx.rs.planned_at, to: d.toISOString() });
  return d.toISOString();
}

export async function requestExtension(env: Env, ctx: StepCtx, u: Actor, requested: unknown, reason: string) {
  mustAct(ctx, u);
  if (!reason.trim()) fail(400, "Reason is required");
  const d = parseInstant(requested);
  if (!d) fail(400, "Give the date you need");
  await history(env, ctx.rec.id, ctx.rs.id, "extension_requested", u, reason, { requested: d.toISOString(), current: ctx.rs.planned_at });
  await notify(env, await admins(env), {
    kind: "extension", title: `Extension requested: ${ctx.step.name}`, body: `${ctx.rec.uid} · ${u.name} · ${reason.trim()}`,
    fms_id: ctx.b.def.id, record_id: ctx.rec.id, record_step_id: ctx.rs.id,
  });
}

export async function skipStep(env: Env, ctx: StepCtx, u: Actor, reason: string) {
  if (u.role !== "admin") fail(403, "Admin access required");
  if (!ACTIVE.concat("submitted", "waiting").includes(ctx.rs.status)) fail(409, `Step is ${ctx.rs.status}`);
  await env.DB.prepare("UPDATE fms_record_steps SET status = 'skipped', updated_at = ? WHERE id = ?").bind(now(), ctx.rs.id).run();
  await history(env, ctx.rec.id, ctx.rs.id, "skipped", u, reason);
  await progress(env, ctx.b, ctx.rec.id, u);
}

// ------------------------------------------------------------------ doer task queries
interface Light { steps: Map<number, StepRow>; defs: Map<number, any>; seats: Map<number, Seat> }

async function loadLight(env: Env): Promise<Light> {
  const [st, df] = await env.DB.batch([
    env.DB.prepare("SELECT s.* FROM fms_steps s JOIN fms_definitions d ON d.id = s.fms_id WHERE d.deleted = 0"),
    env.DB.prepare("SELECT id, fms_id, code, name, category, priority, status, archived, access, instructions FROM fms_definitions WHERE deleted = 0"),
  ]);
  return {
    steps: new Map((st.results as StepRow[]).map((s) => [s.id, s])),
    defs: new Map((df.results as any[]).map((d) => [d.id, d])),
    seats: await loadSeats(env),
  };
}

/** Is this step the user's own work (not the admin override)? */
const isMine = (rs: { assigned_to: string }, step: StepRow, seats: Map<number, Seat>, u: Actor) =>
  rs.assigned_to ? rs.assigned_to === u.employeeID : stepEligible(step, seats, { ...u, role: "employee" });

export function taskOut(row: any, l: Light, fieldsByFms?: Map<number, { key: string; label: string }[]>) {
  const step = l.steps.get(row.step_id)!;
  const def = l.defs.get(row.fms_id) || {};
  const t = Date.now();
  const planned = row.planned_at ? new Date(row.planned_at).getTime() : NaN;
  const data = j<Record<string, unknown>>(row.data, {});
  const cols = fieldsByFms?.get(row.fms_id) || [];
  return {
    id: row.id, record_id: row.record_id, uid: row.uid, status: row.status, outcome: row.outcome, planned_at: row.planned_at, actual_at: row.actual_at,
    submitted_at: row.submitted_at, rejection_reason: row.rejection_reason, remarks: row.remarks, priority: row.priority || def.priority || "Medium",
    done_by_name: row.done_by_name, delay_minutes: row.delay_minutes, assigned_to: row.assigned_to,
    overdue: ACTIVE.includes(row.status) && !isNaN(planned) && planned < t,
    due_today: !isNaN(planned) && istDay(new Date(planned)) === istDay(new Date()),
    fms: { id: def.id, fms_id: def.fms_id, code: def.code, name: def.name, category: def.category },
    step: { id: step.id, code: step.code, name: step.name, position: step.position, how: step.how, requires_approval: !!step.requires_approval },
    summary: cols.slice(0, 4).map((c) => ({ label: c.label, value: data[c.key] ?? "" })),
  };
}

async function listFields(env: Env, fmsIds: number[]) {
  const map = new Map<number, { key: string; label: string }[]>();
  if (!fmsIds.length) return map;
  const { results } = await env.DB.prepare(`SELECT fms_id, key, label FROM fms_fields WHERE step_id IS NULL AND in_list = 1 AND fms_id IN (${fmsIds.map(() => "?").join(",")}) ORDER BY position`)
    .bind(...fmsIds).all<{ fms_id: number; key: string; label: string }>();
  for (const r of results) { if (!map.has(r.fms_id)) map.set(r.fms_id, []); map.get(r.fms_id)!.push(r); }
  return map;
}

const OPEN_SQL = `SELECT rs.*, r.uid, r.data, r.priority, r.fms_id FROM fms_record_steps rs
  JOIN fms_records r ON r.id = rs.record_id JOIN fms_definitions d ON d.id = r.fms_id
  WHERE r.deleted = 0 AND r.status = 'open' AND d.deleted = 0 AND d.archived = 0 AND d.status = 'active'`;

/** Open work for a user (pending / in progress / rejected / submitted by them). */
export async function myOpenTasks(env: Env, u: Actor) {
  const l = await loadLight(env);
  const { results } = await env.DB.prepare(`${OPEN_SQL} AND rs.status IN ('pending','in_progress','rejected','submitted') ORDER BY rs.planned_at = '', rs.planned_at`).all<any>();
  const mine = results.filter((r) => {
    const step = l.steps.get(r.step_id);
    if (!step) return false;
    if (r.status === "submitted") return r.done_by === u.employeeID;
    return isMine(r, step, l.seats, u);
  });
  const fields = await listFields(env, [...new Set(mine.map((r) => r.fms_id))]);
  return mine.map((r) => taskOut(r, l, fields));
}

export async function myCompleted(env: Env, u: Actor, limit: number, offset: number) {
  const l = await loadLight(env);
  const { results } = await env.DB.prepare(`SELECT rs.*, r.uid, r.data, r.priority, r.fms_id FROM fms_record_steps rs JOIN fms_records r ON r.id = rs.record_id
    WHERE rs.done_by = ? AND rs.status = 'done' AND r.deleted = 0 ORDER BY rs.actual_at DESC LIMIT ? OFFSET ?`).bind(u.employeeID, limit, offset).all<any>();
  const total = (await env.DB.prepare("SELECT COUNT(*) AS n FROM fms_record_steps rs JOIN fms_records r ON r.id = rs.record_id WHERE rs.done_by = ? AND rs.status = 'done' AND r.deleted = 0").bind(u.employeeID).first<{ n: number }>())!.n;
  const fields = await listFields(env, [...new Set(results.map((r) => r.fms_id))]);
  return { items: results.filter((r) => l.steps.has(r.step_id)).map((r) => taskOut(r, l, fields)), total };
}

/** Submitted steps this user can approve. */
export async function myApprovals(env: Env, u: Actor) {
  const l = await loadLight(env);
  const { results } = await env.DB.prepare(`${OPEN_SQL} AND rs.status = 'submitted' ORDER BY rs.submitted_at`).all<any>();
  const list = results.filter((r) => { const s = l.steps.get(r.step_id); return s && canApprove(s, l.seats, u); });
  const fields = await listFields(env, [...new Set(list.map((r) => r.fms_id))]);
  return list.map((r) => taskOut(r, l, fields));
}

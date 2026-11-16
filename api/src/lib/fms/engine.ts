// FMS engine: assignment (WHO), planning (WHEN), step progression, approvals, notifications.
import type { Env } from "../../types";
import { addWorkingDays, addWorkingHours, beforeDate, normaliseCalendar, parseInstant, type FmsCalendar } from "./calendar";
import { normName } from "../util";

// ------------------------------------------------------------------ types
export interface AssignSpec { departments?: string[]; designations?: string[]; employees?: string[] }
export interface Tat { type?: "none" | "hours" | "days" | "before_field" | "after_field"; value?: number; field?: string; from?: "previous" | "start" }
export interface Condition { field: string; op: "eq" | "neq" | "in" | "not_in" | "empty" | "not_empty" | "contains"; value?: unknown }
export interface Actor { employeeID: string; name: string; department: string; designation: string; role: "admin" | "employee" }

export interface DefRow {
  id: number; fms_id: string; code: string; name: string; category: string; description: string; instructions: string;
  priority: string; status: string; archived: number; deleted: number; is_template: number; access: string; calendar: string;
  frequency: string; schedule: string; start_date: string; due_date: string; start_field: string; uid_prefix: string;
  next_uid: number; settings: string; version: number; created_by: string; created_at: string; updated_at: string;
}
export interface StepRow {
  id: number; fms_id: number; position: number; code: string; name: string; seat_id: number | null; assign: string; how: string;
  tat: string; condition: string; requires_approval: number; approver: string; status_options: string; reminder: string; escalation: string; jumps: string;
}
export interface FieldRow {
  id: number; fms_id: number; step_id: number | null; key: string; label: string; type: string; options: string;
  required: number; default_value: string; help: string; position: number; in_list: number;
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
  const access = j<AssignSpec>(b.def.access, {});
  const byAccess = matchesSpec(access, u);
  const anyStep = b.steps.some((s) => stepEligible(s, b.seats, u) || canApprove(s, b.seats, u));
  const firstStep = b.steps[0] ? stepEligible(b.steps[0], b.seats, u) : false;
  return { view: byAccess || anyStep, create: byAccess || (specEmpty(access) && firstStep) };
}

/** Active employees (and optionally admins) matching a step's assignment — for notifications. */
export async function resolvePeople(env: Env, match: (u: Actor) => boolean): Promise<Actor[]> {
  const { results } = await env.DB.prepare("SELECT employee_id, name, department, designation, role FROM users WHERE is_active = 1").all<any>();
  return results.map((r) => ({ employeeID: r.employee_id, name: r.name, department: r.department, designation: r.designation, role: r.role }))
    .filter((u) => u.role === "employee" && match(u));
}

// ------------------------------------------------------------------ WHEN
export function evalCondition(cond: Condition | null, values: Record<string, unknown>): boolean {
  if (!cond || !cond.field) return true;
  const raw = values[cond.field];
  const v = Array.isArray(raw) ? raw.map((x) => String(x).trim().toLowerCase()) : String(raw ?? "").trim().toLowerCase();
  const target = Array.isArray(cond.value) ? cond.value.map((x) => String(x).trim().toLowerCase()) : String(cond.value ?? "").trim().toLowerCase();
  const has = (t: string) => (Array.isArray(v) ? v.includes(t) : v === t);
  switch (cond.op) {
    case "eq": return Array.isArray(target) ? target.some(has) : has(target);
    case "neq": return Array.isArray(target) ? !target.some(has) : !has(target);
    case "in": return (Array.isArray(target) ? target : [target]).some(has);
    case "not_in": return !(Array.isArray(target) ? target : [target]).some(has);
    case "empty": return Array.isArray(v) ? v.length === 0 : v === "";
    case "not_empty": return Array.isArray(v) ? v.length > 0 : v !== "";
    case "contains": return (Array.isArray(v) ? v.join(" ") : v).includes(String(target));
  }
  return true;
}

export function plannedFor(step: StepRow, b: Bundle, startIso: string, prevActualIso: string, values: Record<string, unknown>): string {
  const t = j<Tat>(step.tat, {});
  const type = t.type || "none";
  const n = Number(t.value || 0);
  const base = parseInstant(t.from === "start" ? startIso : prevActualIso || startIso);
  if (type === "hours" && base) return addWorkingHours(base, n, b.calendar, b.holidays).toISOString();
  if (type === "days" && base) return addWorkingDays(base, n, b.calendar, b.holidays).toISOString();
  if (type === "before_field" || type === "after_field") {
    const fd = parseInstant(values[t.field || ""]);
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

/**
 * Move a row forward: activate the next step (or skip it when its condition is false),
 * plan its due time, notify its doers; complete the row after the last step.
 */
export async function progress(env: Env, b: Bundle, recordId: number, actor: Actor | null) {
  const rec = await env.DB.prepare("SELECT * FROM fms_records WHERE id = ?").bind(recordId).first<any>();
  if (!rec || rec.status !== "open") return;
  const rsteps = (await env.DB.prepare("SELECT * FROM fms_record_steps WHERE record_id = ? ORDER BY position, id").bind(recordId).all<RecordStepRow>()).results;
  const stepById = new Map(b.steps.map((s) => [s.id, s]));
  const data = j<Record<string, unknown>>(rec.data, {});
  let lastActual = "";
  for (const rs of rsteps) {
    if (rs.status === "done" || rs.status === "skipped") { if (rs.actual_at) lastActual = rs.actual_at; continue; }
    if (rs.status !== "waiting") { // already active
      await env.DB.prepare("UPDATE fms_records SET current_step = ?, updated_at = ? WHERE id = ?").bind(rs.position, nowIso(), recordId).run();
      return;
    }
    const step = stepById.get(rs.step_id);
    if (!step) continue;
    const values = allValues(data, rsteps);
    if (!evalCondition(j<Condition | null>(step.condition, null), values)) {
      await env.DB.prepare("UPDATE fms_record_steps SET status = 'skipped', updated_at = ? WHERE id = ?").bind(nowIso(), rs.id).run();
      rs.status = "skipped";
      await history(env, recordId, rs.id, "skipped", null, "Condition not met");
      continue;
    }
    const planned = plannedFor(step, b, rec.start_at || rec.created_at, lastActual, values);
    await env.DB.batch([
      env.DB.prepare("UPDATE fms_record_steps SET status = 'pending', planned_at = ?, updated_at = ? WHERE id = ?").bind(planned, nowIso(), rs.id),
      env.DB.prepare("UPDATE fms_records SET current_step = ?, updated_at = ? WHERE id = ?").bind(rs.position, nowIso(), recordId),
    ]);
    await history(env, recordId, rs.id, "assigned", actor, "", { step: step.name, planned });
    const people = await stepPeople(env, b, step, rs.assigned_to);
    await notify(env, people, {
      kind: "assigned", title: `New task: ${step.name}`, body: `${b.def.name} · ${rec.uid}${planned ? ` · due ${planned}` : ""}`,
      fms_id: b.def.id, record_id: recordId, record_step_id: rs.id,
    });
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

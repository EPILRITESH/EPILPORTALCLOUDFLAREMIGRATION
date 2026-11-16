// FMS background jobs:
//   runFmsReminders  (every 5 min) — "due soon" reminders, overdue alerts + escalation to admins/escalation list
//   runFmsRecurrence (hourly)      — create rows for recurring FMS (daily / weekly / monthly / quarterly / yearly / one-time)
import type { Env } from "../../types";
import { formatIST } from "./calendar";
import { admins, j, loadBundle, loadSeats, notify, resolvePeople, stepEligible, type Actor, type StepRow } from "./engine";
import { createRecord } from "./records";

const HOUR = 3_600_000;

export async function runFmsReminders(env: Env, nowMs = Date.now()) {
  const nowIso = new Date(nowMs).toISOString();
  const { results } = await env.DB.prepare(`SELECT rs.id, rs.record_id, rs.step_id, rs.status, rs.planned_at, rs.assigned_to, rs.reminded_at, rs.escalated_at,
      r.uid, r.fms_id, d.name AS fms_name, d.settings
    FROM fms_record_steps rs JOIN fms_records r ON r.id = rs.record_id JOIN fms_definitions d ON d.id = r.fms_id
    WHERE rs.status IN ('pending','in_progress','rejected') AND rs.planned_at != '' AND r.deleted = 0 AND r.status = 'open'
      AND d.deleted = 0 AND d.archived = 0 AND d.status = 'active' AND (rs.reminded_at = '' OR rs.escalated_at = '')
    LIMIT 500`).all<any>();
  if (!results.length) return { reminded: 0, escalated: 0 };
  const steps = new Map((await env.DB.prepare(`SELECT * FROM fms_steps WHERE id IN (${[...new Set(results.map((r) => r.step_id))].join(",")})`).all<StepRow>()).results.map((s) => [s.id, s]));
  const seats = await loadSeats(env);
  let people: Actor[] | null = null;
  const everyone = async () => (people ||= await resolvePeople(env, () => true));
  const adminList = await admins(env);
  let reminded = 0, escalated = 0;
  const updates: D1PreparedStatement[] = [];
  for (const r of results) {
    const step = steps.get(r.step_id);
    if (!step) continue;
    const settings = j<{ reminderHours?: number; escalationHours?: number }>(r.settings, {});
    const rem = j<{ beforeHours?: number; enabled?: boolean }>(step.reminder, {});
    const esc = j<{ afterHours?: number; notifyAdmins?: boolean; employees?: string[]; enabled?: boolean }>(step.escalation, {});
    const planned = new Date(r.planned_at).getTime();
    if (isNaN(planned)) continue;
    const doers = r.assigned_to ? [{ employeeID: r.assigned_to }] : (await everyone()).filter((u) => stepEligible(step, seats, u));
    const base = { fms_id: r.fms_id, record_id: r.record_id, record_step_id: r.id };
    // due soon
    const before = Number(rem.beforeHours ?? settings.reminderHours ?? 2);
    if (!r.reminded_at && rem.enabled !== false && planned > nowMs && planned - before * HOUR <= nowMs) {
      await notify(env, doers, { kind: "reminder", title: `Due soon: ${step.name}`, body: `${r.fms_name} · ${r.uid} · due ${formatIST(r.planned_at)}`, ...base });
      updates.push(env.DB.prepare("UPDATE fms_record_steps SET reminded_at = ? WHERE id = ?").bind(nowIso, r.id));
      reminded++;
    }
    // overdue → tell the doers, and escalate after the grace period
    const after = Number(esc.afterHours ?? settings.escalationHours ?? 0);
    if (!r.escalated_at && esc.enabled !== false && planned + after * HOUR <= nowMs) {
      await notify(env, doers, { kind: "overdue", title: `Overdue: ${step.name}`, body: `${r.fms_name} · ${r.uid} · was due ${formatIST(r.planned_at)}`, ...base });
      const to = [...(esc.notifyAdmins === false ? [] : adminList), ...(esc.employees || []).map((e) => ({ employeeID: e }))];
      if (to.length) await notify(env, to, { kind: "escalation", title: `Escalation: ${step.name} overdue`, body: `${r.fms_name} · ${r.uid} · due ${formatIST(r.planned_at)}`, ...base });
      updates.push(env.DB.prepare("UPDATE fms_record_steps SET escalated_at = ?, reminded_at = CASE WHEN reminded_at = '' THEN ? ELSE reminded_at END WHERE id = ?").bind(nowIso, nowIso, r.id));
      escalated++;
    }
  }
  for (let i = 0; i < updates.length; i += 100) await env.DB.batch(updates.slice(i, i + 100));
  return { reminded, escalated };
}

/** Which period key (for idempotency) a recurring FMS is due for today, or null. */
export function recurrenceDue(def: { frequency: string; schedule: string; start_date: string; due_date: string }, nowMs: number): string | null {
  const l = new Date(nowMs + 330 * 60_000); // IST wall clock
  const today = l.toISOString().slice(0, 10);
  if (def.start_date && today < def.start_date) return null;
  if (def.due_date && today > def.due_date) return null;
  const s = j<{ time?: string; days?: number[]; dates?: number[]; months?: number[] }>(def.schedule, {});
  const [hh, mm] = (s.time || "10:00").split(":").map(Number);
  if (l.getUTCHours() * 60 + l.getUTCMinutes() < (hh || 0) * 60 + (mm || 0)) return null;
  const dow = l.getUTCDay(), dom = l.getUTCDate(), mon = l.getUTCMonth() + 1;
  const dates = s.dates?.length ? s.dates : [1];
  switch (def.frequency) {
    case "one_time": return def.start_date && today >= def.start_date ? "once" : null;
    case "daily": return (s.days?.length ? s.days.includes(dow) : dow !== 0) ? today : null;
    case "weekly": return (s.days?.length ? s.days : [1]).includes(dow) ? today : null;
    case "monthly": return dates.includes(dom) ? today : null;
    case "quarterly": return [1, 4, 7, 10].includes(mon) && dates.includes(dom) ? today : null;
    case "yearly": return (s.months?.length ? s.months : [1]).includes(mon) && dates.includes(dom) ? today : null;
  }
  return null;
}

export async function runFmsRecurrence(env: Env, nowMs = Date.now()) {
  const { results } = await env.DB.prepare(`SELECT id, frequency, schedule, start_date, due_date FROM fms_definitions
    WHERE deleted = 0 AND archived = 0 AND is_template = 0 AND status = 'active' AND frequency != 'on_demand'`).all<any>();
  const created: string[] = [];
  const system: Actor = { employeeID: "system", name: "System (recurring)", department: "", designation: "", role: "admin" };
  for (const d of results) {
    const period = recurrenceDue(d, nowMs);
    if (!period) continue;
    const claim = await env.DB.prepare("INSERT OR IGNORE INTO job_runs (job, period, result) VALUES (?, ?, 'running') RETURNING job").bind(`fms:${d.id}`, period).first();
    if (!claim) continue; // already generated for this period
    try {
      const b = await loadBundle(env, d.id);
      if (!b) continue;
      const defaults = j<{ defaults?: Record<string, unknown> }>(d.schedule, {}).defaults || {};
      const data: Record<string, unknown> = {};
      for (const f of b.fields.filter((x) => x.step_id == null)) data[f.key] = defaults[f.key] ?? f.default_value ?? "";
      if (b.def.start_field && !data[b.def.start_field]) data[b.def.start_field] = new Date(nowMs).toISOString();
      const r = await createRecord(env, b, data, system);
      await env.DB.prepare("UPDATE job_runs SET result = ? WHERE job = ? AND period = ?").bind(r.uid, `fms:${d.id}`, period).run();
      created.push(`${b.def.code}:${r.uid}`);
    } catch (e) {
      // leave a note and release the claim so the next hour retries
      console.error("fms recurrence", d.id, (e as Error).message);
      await env.DB.prepare("DELETE FROM job_runs WHERE job = ? AND period = ?").bind(`fms:${d.id}`, period).run();
    }
  }
  return { created };
}

import type { Env } from "../types";
import { nanoid } from "./util";

// Recurrence engine for checklist templates (legacy routes/checklist.js
// create-template + auto-generate-next-month). Dates: "DD/MM/YYYY 23:59:59".

const DAYS: Record<string, number> = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
const p2 = (n: number) => String(n).padStart(2, "0");
const slot = (d: number, m: number, y: number) => `${p2(d)}/${p2(m)}/${y} 23:59:59`;

/**
 * Planned slots for a template in month `month` (1-12) of `year`, starting at day `fromDay`.
 * fromDay > 1 reproduces "remaining days of the current month" (create-template);
 * fromDay = 1 reproduces next-month generation (incl. clamping Monthly to month end).
 */
export function plannedSlots(freq: string, dayOrDate: string, month: number, year: number, fromDay = 1): string[] {
  const last = new Date(year, month, 0).getDate();
  const out: string[] = [];
  if (freq === "D") {
    for (let d = fromDay; d <= last; d++) out.push(slot(d, month, year));
  } else if (freq === "W" && dayOrDate) {
    const target = DAYS[dayOrDate.toLowerCase().trim()];
    if (target !== undefined) {
      for (let d = fromDay; d <= last; d++) if (new Date(year, month - 1, d).getDay() === target) out.push(slot(d, month, year));
    }
  } else if (freq === "M" && dayOrDate) {
    const target = parseInt(dayOrDate, 10);
    if (!isNaN(target)) {
      if (fromDay > 1) {
        if (target >= fromDay && target <= last) out.push(slot(target, month, year));
      } else out.push(slot(Math.min(target, last), month, year));
    }
  } else if (freq === "Y" && dayOrDate) {
    const target = parseInt(dayOrDate, 10);
    if (!isNaN(target) && target >= fromDay && target <= last) out.push(slot(target, month, year));
  }
  return out;
}

export interface TemplateRow { template_id: string; name: string; email: string; department: string; task: string; freq: string; day_or_date: string; }

/** Insert tasks for the given slots; a slot that already exists is skipped (idempotent). */
export async function insertSlots(env: Env, t: TemplateRow, slots: string[]) {
  const created: { taskId: string; task: string; planned: string; freq: string }[] = [];
  if (!slots.length) return created;
  const ids = slots.map(() => nanoid(6));
  const stmts = slots.map((planned, i) =>
    env.DB.prepare(
      `INSERT INTO checklist_tasks (task_id, name, email, department, freq, task, planned, actual, source, template_id)
       SELECT ?, ?, ?, ?, ?, ?, ?, '', 'AUTO', ?
       WHERE NOT EXISTS (SELECT 1 FROM checklist_tasks WHERE name = ? AND task = ? AND planned = ?)`,
    ).bind(ids[i], t.name, t.email, t.department, t.freq, t.task, planned, t.template_id, t.name, t.task, planned));
  // D1 batch limit safety: chunk in 50s
  for (let i = 0; i < stmts.length; i += 50) {
    const res = await env.DB.batch(stmts.slice(i, i + 50));
    res.forEach((r, j) => {
      if (r.meta.changes) created.push({ taskId: ids[i + j], task: t.task, planned: slots[i + j], freq: t.freq });
    });
  }
  return created;
}

/** Generate next month's tasks for all active templates (cron + manual trigger). */
export async function generateNextMonth(env: Env, today = new Date()) {
  let month = today.getMonth() + 2;
  let year = today.getFullYear();
  if (month > 12) { month = 1; year++; }
  const { results } = await env.DB.prepare("SELECT * FROM checklist_templates WHERE status = 'active'").all<TemplateRow>();
  const createdTasks: Awaited<ReturnType<typeof insertSlots>> = [];
  for (const t of results) createdTasks.push(...(await insertSlots(env, t, plannedSlots(t.freq, t.day_or_date, month, year, 1))));
  return { month, year, createdTasks };
}

/** Cron entry point: run at most once per calendar month (replaces last-generate.txt). */
export async function runMonthlyGeneration(env: Env, now = new Date()) {
  const period = `${now.getMonth() + 1}-${now.getFullYear()}`;
  const done = await env.DB.prepare("SELECT 1 FROM job_runs WHERE job = 'checklist-next-month' AND period = ?").bind(period).first();
  if (done) return { skipped: true, period };
  const result = await generateNextMonth(env, now);
  await env.DB.prepare("INSERT OR REPLACE INTO job_runs (job, period, result) VALUES ('checklist-next-month', ?, ?)")
    .bind(period, `generated ${result.createdTasks.length} tasks for ${result.month}/${result.year}`).run();
  return { skipped: false, period, ...result };
}

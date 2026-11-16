import { Hono } from "hono";
import type { AppEnv } from "../types";
import { isAdmin, requireAdmin, requireAuth, scopedName } from "../middleware/auth";
import { formatDateIST, getWeekRange, isoDay, parseDDMMYYYY } from "../lib/dates";
import { fail, jsonBody, lc, nanoid, NAME_SQL, normName, sameName, str } from "../lib/util";
import { generateNextMonth, insertSlots, plannedSlots, type TemplateRow } from "../lib/checklistGen";
import { audit } from "../lib/audit";

export const checklistRoutes = new Hono<AppEnv>();
checklistRoutes.use("*", requireAuth);

interface ChecklistRow {
  task_id: string; name: string; email: string; department: string; freq: string; task: string;
  planned: string; actual: string; source: string; template_id: string; archive: string;
}

// Legacy Master!I/J were read as EmailForBuddy/BuddyEmail but hold source/template id.
const mapChecklist = (r: ChecklistRow) => ({
  Name: r.name, Email: r.email, Department: r.department, TaskID: r.task_id, Freq: r.freq,
  Task: r.task, Planned: r.planned, Actual: r.actual, EmailForBuddy: r.source, BuddyEmail: r.template_id,
  Archive: r.archive,
});

/** GET /api/checklist — my open (not yet done) items */
checklistRoutes.get("/", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM checklist_tasks WHERE ${NAME_SQL("name")} = ? AND trim(actual) = '' ORDER BY rowid`,
  ).bind(normName(c.get("user").name)).all<ChecklistRow>();
  return c.json(results.map(mapChecklist));
});

/** GET /api/checklist/search/by-name?name= (admin, or self) */
checklistRoutes.get("/search/by-name", async (c) => {
  const name = c.req.query("name");
  if (!name || !name.trim()) fail(400, "Name is required");
  if (!isAdmin(c) && lc(name) !== lc(c.get("user").name)) fail(403, "Admin access required");
  const stmt = lc(name) === "all"
    ? c.env.DB.prepare("SELECT * FROM checklist_tasks ORDER BY rowid")
    : c.env.DB.prepare(`SELECT * FROM checklist_tasks WHERE ${NAME_SQL("name")} = ? ORDER BY rowid`).bind(normName(name));
  const { results } = await stmt.all<ChecklistRow>();
  return c.json(results.map(mapChecklist));
});

/** POST /api/checklist — ad-hoc item for myself */
checklistRoutes.post("/", async (c) => {
  const { Task, Freq } = await jsonBody(c.req);
  if (!Task || !Freq) fail(400, "Task and Freq are required");
  const d = new Date();
  if (Freq === "D") d.setDate(d.getDate() + 1);
  else if (Freq === "W") d.setDate(d.getDate() + 7);
  else if (Freq === "M") d.setMonth(d.getMonth() + 1);
  const p2 = (n: number) => String(n).padStart(2, "0");
  const planned = `${p2(d.getDate())}/${p2(d.getMonth() + 1)}/${d.getFullYear()} 23:59:59`;
  const me = c.get("user");
  const TaskID = nanoid(6);
  await c.env.DB.prepare(
    "INSERT INTO checklist_tasks (task_id, name, department, freq, task, planned, source) VALUES (?, ?, ?, ?, ?, ?, 'MANUAL')",
  ).bind(TaskID, me.name, me.department, str(Freq), str(Task), planned).run();
  return c.json({ ok: true, TaskID, Planned: planned });
});

/**
 * PATCH /api/checklist/done/:id
 * Legacy wrote (TaskID, date) to the "Consolidated" tab and a sheet formula filled Master!H.
 * Here the Actual date is written directly.
 */
checklistRoutes.patch("/done/:id", async (c) => {
  const id = c.req.param("id");
  const t = await c.env.DB.prepare("SELECT name FROM checklist_tasks WHERE task_id = ?").bind(id).first<{ name: string }>();
  if (!t || (!isAdmin(c) && !sameName(t.name, c.get("user").name))) fail(404, "Task not found");
  const doneAt = formatDateIST();
  await c.env.DB.prepare("UPDATE checklist_tasks SET actual = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE task_id = ?")
    .bind(doneAt, id).run();
  await audit(c.env, c.get("user").employeeID, "done", "checklist", id);
  return c.json({ ok: true, TaskID: id, DoneAt: doneAt });
});

/** GET /api/checklist/filter?month&week&selectedName */
checklistRoutes.get("/filter", async (c) => {
  const { month, week, selectedName } = c.req.query();
  if (!month || week === undefined) fail(400, "Month and Week are required");
  const target = scopedName(c, selectedName);
  if (target === null) fail(403, "Admin access required");
  const { weekStart, weekEnd } = getWeekRange(month, week);
  const { results } = await c.env.DB.prepare(`SELECT * FROM checklist_tasks WHERE ${NAME_SQL("name")} = ? ORDER BY rowid`)
    .bind(normName(target)).all<ChecklistRow>();
  const filtered = results.filter((t) => {
    const planned = parseDDMMYYYY(t.planned);
    const actual = parseDDMMYYYY(t.actual);
    return (planned && planned >= weekStart && planned <= weekEnd) || (actual && actual >= weekStart && actual <= weekEnd);
  });
  let completed = 0, pending = 0, onTime = 0, delayed = 0;
  for (const t of filtered) {
    const planned = parseDDMMYYYY(t.planned);
    const actual = parseDDMMYYYY(t.actual);
    if (actual && actual >= weekStart && actual <= weekEnd) {
      completed++;
      planned && actual <= planned ? onTime++ : delayed++;
    } else pending++;
  }
  const total = filtered.length;
  const pct = (n: number) => (total ? ((n / total) * 100).toFixed(2) : "0.00");
  return c.json({
    totalTasks: total, completedTasks: completed, pendingTasks: pending, onTimeTasks: onTime, delayedTasks: delayed,
    pendingPercentage: pct(pending), delayedPercentage: pct(delayed), onTimePercentage: pct(onTime),
    weekStart: isoDay(weekStart), weekEnd: isoDay(weekEnd),
    tasks: filtered.map((t) => ({
      Name: t.name, Email: t.email, Department: t.department, TaskID: t.task_id, Freq: t.freq, Task: t.task,
      Planned: t.planned, Actual: t.actual, Status: t.actual ? "Completed" : "Pending",
    })),
  });
});

/** POST /api/checklist/create-template (admin) — template + remaining slots of the current month */
checklistRoutes.post("/create-template", requireAdmin, async (c) => {
  const { task, freq, dayOrDate, employeeName } = await jsonBody(c.req);
  if (!task || !freq || !employeeName) fail(400, "Task, Freq and employeeName are required");
  if (!["D", "W", "M", "Y"].includes(String(freq))) fail(400, "Freq must be one of D, W, M, Y");
  const emp = await c.env.DB.prepare("SELECT department FROM users WHERE role='employee' AND name = ? LIMIT 1")
    .bind(String(employeeName)).first<{ department: string }>();
  const t: TemplateRow = {
    template_id: nanoid(8), name: String(employeeName), email: "", department: emp?.department || "",
    task: String(task), freq: String(freq), day_or_date: str(dayOrDate),
  };
  await c.env.DB.prepare(
    "INSERT INTO checklist_templates (template_id, name, email, department, task, freq, day_or_date, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'active')",
  ).bind(t.template_id, t.name, t.email, t.department, t.task, t.freq, t.day_or_date).run();

  // Legacy wrote these rows to an unused "TestMaster" tab, so they never reached doers. Fixed: real tasks.
  const today = new Date();
  const created = await insertSlots(c.env, t, plannedSlots(t.freq, t.day_or_date, today.getMonth() + 1, today.getFullYear(), today.getDate()));
  await audit(c.env, c.get("user").employeeID, "create-template", "checklist", t.template_id, t);
  return c.json({
    success: true,
    message: `Template created + ${created.length} tasks for current month`,
    templateId: t.template_id, employeeName: t.name, task: t.task, freq: t.freq, dayOrDate: t.day_or_date || "N/A",
    currentMonthTasks: created.map(({ taskId, task: tk, planned }) => ({ taskId, task: tk, planned })),
    note: created.length === 0 ? "No remaining tasks for this month." : `Created ${created.length} tasks`,
  });
});

/** GET /api/checklist/templates (admin; new) */
checklistRoutes.get("/templates", requireAdmin, async (c) => {
  const { results } = await c.env.DB.prepare("SELECT * FROM checklist_templates ORDER BY created_at DESC").all();
  return c.json({ ok: true, templates: results });
});

/** PATCH /api/checklist/templates/:id { status: 'active'|'inactive' } (admin; new) */
checklistRoutes.patch("/templates/:id", requireAdmin, async (c) => {
  const { status } = await jsonBody(c.req);
  if (!["active", "inactive"].includes(String(status))) fail(400, "status must be active or inactive");
  const r = await c.env.DB.prepare("UPDATE checklist_templates SET status = ? WHERE template_id = ?").bind(status, c.req.param("id")).run();
  if (!r.meta.changes) fail(404, "Template not found");
  return c.json({ ok: true });
});

/** POST /api/checklist/auto-generate-next-month (admin; legacy trusted an "x-cron-job" header) */
checklistRoutes.post("/auto-generate-next-month", requireAdmin, async (c) => {
  const r = await generateNextMonth(c.env);
  return c.json({ success: true, message: `Generated ${r.createdTasks.length} tasks for ${r.month}/${r.year}`, createdTasks: r.createdTasks });
});

/** DELETE /api/checklist/:id (admin) */
checklistRoutes.delete("/:id", requireAdmin, async (c) => {
  const r = await c.env.DB.prepare("DELETE FROM checklist_tasks WHERE task_id = ?").bind(c.req.param("id")).run();
  if (!r.meta.changes) fail(404, "Task not found");
  await audit(c.env, c.get("user").employeeID, "delete", "checklist", c.req.param("id"));
  return c.json({ ok: true });
});

checklistRoutes.get("/test", (c) => c.json({ ok: true, msg: "Route works!" }));

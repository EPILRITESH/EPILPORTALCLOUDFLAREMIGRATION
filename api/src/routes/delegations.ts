import { Hono } from "hono";
import type { AppEnv } from "../types";
import { isAdmin, requireAdmin, requireAuth, scopedName } from "../middleware/auth";
import { formatDateIST, getWeekRange, isoDay, parseDDMMYYYY } from "../lib/dates";
import { fail, jsonBody, lc, nanoid, str } from "../lib/util";
import { audit } from "../lib/audit";

export const delegationRoutes = new Hono<AppEnv>();
delegationRoutes.use("*", requireAuth);

export interface DelegationRow {
  task_id: string; name: string; task_name: string; created_date: string; deadline: string;
  revision1: string; revision2: string; final_date: string; revisions: number; priority: string;
  status: string; followup: string; done_week: string; approval: string;
}

export function mapTask(r: DelegationRow) {
  return {
    TaskID: r.task_id,
    Name: r.name,
    TaskName: r.task_name,
    CreatedDate: r.created_date,
    Deadline: r.deadline,
    Revision1: r.revision1,
    Revision2: r.revision2,
    FinalDate: r.final_date,
    Revisions: Number(r.revisions) || 0,
    Priority: r.priority,
    Status: r.status || "Pending",
    Followup: r.followup || "",
    Taskcompletedapproval: r.approval || "Pending",
  };
}

const getTask = (c: any, id: string) =>
  c.env.DB.prepare("SELECT * FROM delegations WHERE task_id = ?").bind(id).first() as Promise<DelegationRow | null>;

const touch = "updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')";

/** GET /api/delegations — my tasks */
delegationRoutes.get("/", async (c) => {
  const { results } = await c.env.DB.prepare("SELECT * FROM delegations WHERE name = ? ORDER BY rowid")
    .bind(c.get("user").name).all<DelegationRow>();
  return c.json(results.map(mapTask));
});

/** POST /api/delegations — create (employees can only create for themselves) */
delegationRoutes.post("/", async (c) => {
  const { TaskName, Deadline, Priority, Name, AssignBy } = await jsonBody(c.req);
  if (!TaskName || !Deadline) fail(400, "TaskName and Deadline are required");
  const target = scopedName(c, Name);
  if (target === null) fail(403, "You can only create delegations for yourself");
  const TaskID = nanoid(6);
  await c.env.DB.prepare(
    `INSERT INTO delegations (task_id, name, task_name, created_date, deadline, priority, status, followup, approval)
     VALUES (?, ?, ?, ?, ?, ?, 'Pending', ?, 'Pending')`,
  ).bind(TaskID, target, str(TaskName), formatDateIST(), str(Deadline), str(Priority), str(AssignBy)).run();
  await audit(c.env, c.get("user").employeeID, "create", "delegation", TaskID);
  return c.json({ ok: true, TaskID });
});

/** GET /api/delegations/filter?month&week&selectedName */
delegationRoutes.get("/filter", async (c) => {
  const { month, week, selectedName } = c.req.query();
  if (!month || week === undefined) fail(400, "Month and Week are required");
  const target = scopedName(c, selectedName);
  if (target === null) fail(403, "Admin access required");
  const { weekStart, weekEnd } = getWeekRange(month, week);
  const { results } = await c.env.DB.prepare("SELECT * FROM delegations WHERE lower(trim(name)) = ? ORDER BY rowid")
    .bind(lc(target)).all<DelegationRow>();

  const filtered = results.filter((t) => {
    const created = parseDDMMYYYY(t.created_date);
    const completed = t.final_date ? parseDDMMYYYY(t.final_date) : null;
    if (!created) return false;
    return created <= weekEnd && (!completed || completed >= weekStart);
  });

  let completedCount = 0, pendingCount = 0, onTime = 0, delayed = 0;
  for (const t of filtered) {
    const completed = t.final_date ? parseDDMMYYYY(t.final_date) : null;
    const deadline = parseDDMMYYYY(t.deadline);
    if (completed && completed >= weekStart && completed <= weekEnd) {
      completedCount++;
      deadline && completed <= deadline ? onTime++ : delayed++;
    } else pendingCount++;
  }
  const total = filtered.length;
  return c.json({
    totalWork: total,
    completedTaskCount: completedCount,
    pendingTaskCount: pendingCount,
    pendingTaskPercentage: total ? ((pendingCount / total) * 100).toFixed(2) : 0,
    onTimeCount: onTime,
    delayedWorkPercentage: completedCount ? ((delayed / completedCount) * 100).toFixed(2) : 0,
    weekStart: isoDay(weekStart),
    weekEnd: isoDay(weekEnd),
    tasks: filtered.map(mapTask),
  });
});

/** PUT /api/delegations/update/:id (admin) */
delegationRoutes.put("/update/:id", requireAdmin, async (c) => {
  const { TaskName, Deadline, Priority, Notes, Status } = await jsonBody(c.req);
  const t = await getTask(c, c.req.param("id"));
  if (!t) fail(404, "Task not found");
  const next = {
    task_name: TaskName ? str(TaskName) : t.task_name,
    deadline: Deadline ? str(Deadline) : t.deadline,
    priority: Priority ? str(Priority) : t.priority,
    status: Status ? str(Status) : t.status,
    followup: Notes !== undefined ? str(Notes) : t.followup,
  };
  await c.env.DB.prepare(`UPDATE delegations SET task_name=?, deadline=?, priority=?, status=?, followup=?, ${touch} WHERE task_id=?`)
    .bind(next.task_name, next.deadline, next.priority, next.status, next.followup, t.task_id).run();
  await audit(c.env, c.get("user").employeeID, "update", "delegation", t.task_id, next);
  return c.json({ ok: true, updatedTask: mapTask({ ...t, ...next }) });
});

/** DELETE /api/delegations/delete/:id (admin) */
delegationRoutes.delete("/delete/:id", requireAdmin, async (c) => {
  const r = await c.env.DB.prepare("DELETE FROM delegations WHERE task_id = ?").bind(c.req.param("id")).run();
  if (!r.meta.changes) fail(404, "Task not found");
  await audit(c.env, c.get("user").employeeID, "delete", "delegation", c.req.param("id"));
  return c.json({ ok: true, message: "Task deleted successfully" });
});

/** Doer can act on own task; admin on any. */
async function ownTask(c: any): Promise<DelegationRow> {
  const t = await getTask(c, c.req.param("id"));
  if (!t || (!isAdmin(c) && t.name !== c.get("user").name)) fail(404, "Task not found");
  return t;
}

/** PATCH /api/delegations/done/:id */
delegationRoutes.patch("/done/:id", async (c) => {
  const t = await ownTask(c);
  const now = new Date();
  const finalDate = formatDateIST(now);
  const monday = new Date(now);
  monday.setDate(now.getDate() - now.getDay() + 1);
  await c.env.DB.prepare(`UPDATE delegations SET final_date=?, status='Completed', done_week=?, ${touch} WHERE task_id=?`)
    .bind(finalDate, formatDateIST(monday), t.task_id).run();
  await audit(c.env, c.get("user").employeeID, "done", "delegation", t.task_id);
  return c.json({ ok: true });
});

/**
 * PATCH /api/delegations/shift/:id { newDeadline, revisionField? }
 * Legacy ignored revisionField so Revision1/Revision2 were never stored; now recorded.
 */
delegationRoutes.patch("/shift/:id", async (c) => {
  const { newDeadline, revisionField } = await jsonBody(c.req);
  if (!newDeadline) fail(400, "newDeadline is required");
  const t = await ownTask(c);
  const revisions = (Number(t.revisions) || 0) + 1;
  const field = revisionField === "Revision2" || (!revisionField && revisions >= 2) ? "revision2" : "revision1";
  await c.env.DB.prepare(`UPDATE delegations SET deadline=?, revisions=?, status='Shifted', ${field}=?, ${touch} WHERE task_id=?`)
    .bind(str(newDeadline), revisions, str(newDeadline), t.task_id).run();
  await audit(c.env, c.get("user").employeeID, "shift", "delegation", t.task_id, { newDeadline });
  return c.json({ ok: true });
});

/** GET /api/delegations/search/by-name?name=&assignBy= */
delegationRoutes.get("/search/by-name", async (c) => {
  const { name, assignBy } = c.req.query();
  if (!name) fail(400, "Name is required");
  if (!isAdmin(c) && lc(name) !== lc(c.get("user").name)) fail(403, "Admin access required");
  let sql = "SELECT * FROM delegations";
  const where: string[] = [];
  const args: string[] = [];
  if (lc(name) !== "all") { where.push("lower(name) = ?"); args.push(name.toLowerCase()); }
  if (assignBy && lc(assignBy) !== "all") { where.push("lower(followup) = ?"); args.push(assignBy.toLowerCase()); }
  if (where.length) sql += ` WHERE ${where.join(" AND ")}`;
  const { results } = await c.env.DB.prepare(`${sql} ORDER BY rowid`).bind(...args).all<DelegationRow>();
  return c.json(results.map(mapTask));
});

/** PATCH /api/delegations/approve/:id { approvalStatus } (admin) */
delegationRoutes.patch("/approve/:id", requireAdmin, async (c) => {
  const { approvalStatus } = await jsonBody(c.req);
  if (!approvalStatus) fail(400, "approvalStatus is required");
  const t = await getTask(c, c.req.param("id"));
  if (!t) fail(404, "Task not found");
  if (approvalStatus === "Approved") {
    await c.env.DB.prepare(`UPDATE delegations SET approval='Approved', status='Completed', ${touch} WHERE task_id=?`).bind(t.task_id).run();
  } else {
    await c.env.DB.prepare(`UPDATE delegations SET approval='Pending', final_date='', done_week='', status='Pending', ${touch} WHERE task_id=?`).bind(t.task_id).run();
  }
  await audit(c.env, c.get("user").employeeID, "approve", "delegation", t.task_id, { approvalStatus });
  const updated = await getTask(c, t.task_id);
  return c.json({ ok: true, updated: updated ? mapTask(updated) : null });
});

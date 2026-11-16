import { Hono, type Context } from "hono";
import type { AppEnv } from "../types";
import { isAdmin, requireAdmin, requireAuth, scopedName } from "../middleware/auth";
import { formatDateIST } from "../lib/dates";
import { publicFileUrl, storeUpload } from "../lib/files";
import { nextTicketIds, ticketWeekStats } from "../lib/tickets";
import { departmentOf } from "../lib/users";
import { fail, jsonBody, nanoid, str } from "../lib/util";
import { audit } from "../lib/audit";

// Support tickets go to EVERY MIS employee (one row each). Rows raised together
// share group_key and move through Pending → InProgress → Done → Approved together.
export const supportTicketRoutes = new Hono<AppEnv>();

interface SupportRow {
  ticket_id: string; group_key: string; created_by: string; assigned_to: string; issue: string; status: string;
  created_date: string; done_date: string; issue_photo: string; work_by: string; approval: string;
  problem: string; solution: string; department: string;
}

async function mapAll(c: Context<AppEnv>, rows: SupportRow[]) {
  return Promise.all(rows.map(async (r) => ({
    TicketID: r.ticket_id, CreatedBy: r.created_by, AssignedTo: r.assigned_to, Issue: r.issue,
    Status: r.status || "Pending", CreatedDate: r.created_date, DoneDate: r.done_date || "",
    IssuePhoto: await publicFileUrl(c, r.issue_photo), WorkBy: r.work_by || "",
    Taskcompletedapproval: r.approval || "Pending", Problem: r.problem || "", Solution: r.solution || "",
    Department: r.department || "",
  })));
}

supportTicketRoutes.get("/test", (c) => c.json({ message: "Support tickets route working", timestamp: new Date() }));
supportTicketRoutes.use("*", requireAuth);
supportTicketRoutes.get("/test-auth", (c) => c.json({ message: "Auth working", user: c.get("user") }));

/** POST /api/support-tickets/create (multipart: Issue, IssuePhoto?) */
supportTicketRoutes.post("/create", async (c) => {
  const body = (c.req.header("content-type") || "").includes("multipart/form-data") ? await c.req.parseBody() : await jsonBody(c.req);
  const Issue = str(body.Issue);
  if (!Issue) fail(400, "Issue description is required");
  const me = c.get("user");
  const photo = await storeUpload(c.env, body.IssuePhoto, "support_tickets");
  const { results: mis } = await c.env.DB.prepare(
    "SELECT name FROM users WHERE role='employee' AND is_active=1 AND department = 'MIS' AND name != ? ORDER BY id",
  ).bind(me.name).all<{ name: string }>();
  if (!mis.length) fail(400, "No MIS employees found to assign tickets");

  const department = await departmentOf(c.env, me.name);
  const ids = await nextTicketIds(c.env, "support_ticket", mis.length);
  const groupKey = `g:${nanoid(12)}`;
  const createdDate = formatDateIST();
  await c.env.DB.batch(mis.map((m, i) => c.env.DB.prepare(
    `INSERT INTO support_tickets (ticket_id, group_key, created_by, assigned_to, issue, status, created_date, issue_photo, approval, department)
     VALUES (?, ?, ?, ?, ?, 'Pending', ?, ?, 'Pending', ?)`,
  ).bind(ids[i], groupKey, me.name, m.name, Issue, createdDate, photo, department)));
  await audit(c.env, me.employeeID, "create", "support_ticket", groupKey, ids);
  return c.json({ ok: true, ticketIDs: ids, message: `${ids.length} ticket(s) created successfully` });
});

supportTicketRoutes.get("/created", async (c) => {
  const { results } = await c.env.DB.prepare("SELECT * FROM support_tickets WHERE created_by = ? ORDER BY rowid").bind(c.get("user").name).all<SupportRow>();
  return c.json(await mapAll(c, results));
});

/** GET /api/support-tickets/assigned — MIS see open items + items they own */
supportTicketRoutes.get("/assigned", async (c) => {
  const me = c.get("user");
  const { results } = await c.env.DB.prepare("SELECT * FROM support_tickets WHERE assigned_to = ? ORDER BY rowid").bind(me.name).all<SupportRow>();
  let tickets = await mapAll(c, results);
  if ((await departmentOf(c.env, me.name)) === "MIS") {
    tickets = tickets.filter((t) => {
      if (t.Status === "Pending" || t.Status === "Approved") return true;
      if (t.Status === "InProgress" || t.Status === "Done") return t.WorkBy === me.name;
      return false;
    });
  }
  return c.json(tickets);
});

/** GET /api/support-tickets/all (admin) */
supportTicketRoutes.get("/all", requireAdmin, async (c) => {
  const { assignedTo, createdBy, status } = c.req.query();
  const where: string[] = [];
  const args: string[] = [];
  if (assignedTo) { where.push("assigned_to = ?"); args.push(assignedTo); }
  if (createdBy) { where.push("created_by = ?"); args.push(createdBy); }
  if (status) { where.push("status = ?"); args.push(status); }
  const sql = `SELECT * FROM support_tickets ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY rowid`;
  const { results } = await c.env.DB.prepare(sql).bind(...args).all<SupportRow>();
  return c.json({ ok: true, tickets: await mapAll(c, results) });
});

async function loadTicket(c: Context<AppEnv>) {
  const id = decodeURIComponent(c.req.param("ticketID") || "").trim();
  const t = await c.env.DB.prepare("SELECT * FROM support_tickets WHERE ticket_id = ?").bind(id).first<SupportRow>();
  if (!t) fail(404, "Ticket not found");
  return t;
}

/** PATCH /api/support-tickets/status/:ticketID { Status } — workflow rules unchanged */
supportTicketRoutes.patch("/status/:ticketID", async (c) => {
  const { Status } = await jsonBody(c.req);
  if (!Status) fail(400, "Status is required");
  const t = await loadTicket(c);
  const me = c.get("user");
  const isMIS = (await departmentOf(c.env, me.name)) === "MIS";

  let newStatus = String(Status);
  let doneDate = t.done_date;
  let workBy = t.work_by || "";
  let approval = t.approval || "Pending";
  const current = t.status;

  if (isMIS) {
    if (Status === "InProgress" && current === "Pending") {
      workBy = me.name; doneDate = ""; approval = "Pending";
    } else if (Status === "Done" && current === "InProgress") {
      if (workBy && workBy !== me.name) fail(403, "You can only complete tickets you started");
      doneDate = formatDateIST(); approval = "Pending";
    } else fail(400, "MIS can only change Pending → InProgress or InProgress → Done");
  } else {
    // Approver: ticket creator or an admin (legacy allowed any non-MIS user).
    if (!isAdmin(c) && t.created_by !== me.name) fail(404, "Ticket not found");
    if (current !== "Done") fail(400, "You can only approve or reject completed tickets");
    if (Status === "Approved") { approval = "Approved"; newStatus = "Done"; }
    else if (Status === "Pending") { doneDate = ""; approval = "Pending"; newStatus = "Pending"; }
    else fail(400, "You can only change Done → Approved or Done → Pending");
  }

  // RETURNING gives the true row count (meta.changes also counts sync-queue trigger inserts)
  const { results: updated } = await c.env.DB.prepare(
    "UPDATE support_tickets SET status=?, done_date=?, work_by=?, approval=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE group_key=? RETURNING ticket_id",
  ).bind(newStatus, doneDate, workBy, approval, t.group_key).all();
  await audit(c.env, me.employeeID, "status", "support_ticket", t.ticket_id, { Status, newStatus });
  return c.json({ ok: true, message: `Updated ${updated.length} ticket(s)`, newStatus, workBy, doneDate, taskApproval: approval });
});

/** PATCH /api/support-tickets/done-details/:ticketID { Problem, Solution } */
supportTicketRoutes.patch("/done-details/:ticketID", async (c) => {
  const { Problem, Solution } = await jsonBody(c.req);
  if (!Problem || !Solution) fail(400, "Problem and Solution are required");
  const t = await loadTicket(c);
  const me = c.get("user");
  if (!isAdmin(c) && t.assigned_to !== me.name && t.work_by !== me.name) fail(404, "Ticket not found");
  const { results: updated } = await c.env.DB.prepare(
    "UPDATE support_tickets SET problem=?, solution=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE group_key=? RETURNING ticket_id",
  ).bind(String(Problem), String(Solution), t.group_key).all();
  return c.json({ ok: true, message: `Updated ${updated.length} ticket(s) with problem/solution`, problem: Problem, solution: Solution });
});

/** GET /api/support-tickets/filter */
supportTicketRoutes.get("/filter", async (c) => {
  const { month, week, selectedName } = c.req.query();
  if (!month || week === undefined) fail(400, "Month and Week are required");
  const target = scopedName(c, selectedName);
  if (target === null) fail(403, "Admin access required");
  const { results } = await c.env.DB.prepare("SELECT * FROM support_tickets ORDER BY rowid").all<SupportRow>();
  const mapped = new Map((await mapAll(c, results)).map((t) => [t.TicketID, t]));
  return c.json(ticketWeekStats(results, month, week, target, (r) => mapped.get(r.ticket_id)!, false));
});

import { Hono, type Context } from "hono";
import type { AppEnv } from "../types";
import { isAdmin, requireAdmin, requireAuth, scopedName } from "../middleware/auth";
import { formatDateIST } from "../lib/dates";
import { publicFileUrl, storeUpload } from "../lib/files";
import { nextTicketIds, ticketWeekStats } from "../lib/tickets";
import { fail, jsonBody, NAME_SQL, normName, sameName, str } from "../lib/util";
import { audit } from "../lib/audit";

export const helpTicketRoutes = new Hono<AppEnv>();
helpTicketRoutes.use("*", requireAuth);

interface HelpRow {
  ticket_id: string; created_by: string; assigned_to: string; issue: string; status: string;
  created_date: string; done_date: string; issue_photo: string;
}

async function mapAll(c: Context<AppEnv>, rows: HelpRow[]) {
  return Promise.all(rows.map(async (r) => ({
    TicketID: r.ticket_id, CreatedBy: r.created_by, AssignedTo: r.assigned_to, Issue: r.issue,
    Status: r.status, CreatedDate: r.created_date, DoneDate: r.done_date || "",
    IssuePhoto: await publicFileUrl(c, r.issue_photo),
  })));
}

/** POST /api/helpTickets/create (multipart: AssignedTo, Issue, IssuePhoto?) */
helpTicketRoutes.post("/create", async (c) => {
  const body = (c.req.header("content-type") || "").includes("multipart/form-data") ? await c.req.parseBody() : await jsonBody(c.req);
  const AssignedTo = str(body.AssignedTo).trim();
  const Issue = str(body.Issue);
  if (!AssignedTo || !Issue) fail(400, "AssignedTo and Issue required");
  const me = c.get("user");
  if (sameName(AssignedTo, me.name)) fail(400, "Cannot assign ticket to yourself");
  const photo = await storeUpload(c.env, body.IssuePhoto, "help_tickets");
  const [ticketID] = await nextTicketIds(c.env, "help_ticket");
  await c.env.DB.prepare(
    "INSERT INTO help_tickets (ticket_id, created_by, assigned_to, issue, status, created_date, done_date, issue_photo) VALUES (?, ?, ?, ?, 'Pending', ?, '', ?)",
  ).bind(ticketID, me.name, AssignedTo, Issue, formatDateIST(), photo).run();
  await audit(c.env, me.employeeID, "create", "help_ticket", ticketID);
  return c.json({ ok: true, ticketID });
});

helpTicketRoutes.get("/created", async (c) => {
  const { results } = await c.env.DB.prepare(`SELECT * FROM help_tickets WHERE ${NAME_SQL("created_by")} = ? ORDER BY rowid`).bind(normName(c.get("user").name)).all<HelpRow>();
  return c.json(await mapAll(c, results));
});

helpTicketRoutes.get("/assigned", async (c) => {
  const { results } = await c.env.DB.prepare(`SELECT * FROM help_tickets WHERE ${NAME_SQL("assigned_to")} = ? ORDER BY rowid`).bind(normName(c.get("user").name)).all<HelpRow>();
  return c.json(await mapAll(c, results));
});

/** GET /api/helpTickets/all?assignedTo&createdBy&status (admin) */
helpTicketRoutes.get("/all", requireAdmin, async (c) => {
  const { assignedTo, createdBy, status } = c.req.query();
  const where: string[] = [];
  const args: string[] = [];
  if (assignedTo) { where.push(`${NAME_SQL("assigned_to")} = ?`); args.push(normName(assignedTo)); }
  if (createdBy) { where.push(`${NAME_SQL("created_by")} = ?`); args.push(normName(createdBy)); }
  if (status) { where.push("status = ?"); args.push(status); }
  const sql = `SELECT * FROM help_tickets ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY rowid`;
  const { results } = await c.env.DB.prepare(sql).bind(...args).all<HelpRow>();
  return c.json({ ok: true, tickets: await mapAll(c, results) });
});

/** GET /api/helpTickets/filter?month&week&selectedName */
helpTicketRoutes.get("/filter", async (c) => {
  const { month, week, selectedName } = c.req.query();
  if (!month || week === undefined) fail(400, "Month and Week are required");
  const target = scopedName(c, selectedName);
  if (target === null) fail(403, "Admin access required");
  const { results } = await c.env.DB.prepare("SELECT * FROM help_tickets ORDER BY rowid").all<HelpRow>();
  const urls = new Map((await mapAll(c, results)).map((t) => [t.TicketID, t]));
  return c.json(ticketWeekStats(results, month, week, target, (r) => urls.get(r.ticket_id)!, true));
});

/** PATCH /api/helpTickets/status/:ticketID { Status } — assignee, creator or admin */
helpTicketRoutes.patch("/status/:ticketID", async (c) => {
  const { Status } = await jsonBody(c.req);
  if (!Status) fail(400, "Status required");
  const id = decodeURIComponent(c.req.param("ticketID")).trim();
  const t = await c.env.DB.prepare("SELECT * FROM help_tickets WHERE ticket_id = ?").bind(id).first<HelpRow>();
  if (!t) fail(404, "Ticket not found");
  const me = c.get("user");
  if (!isAdmin(c) && !sameName(t.assigned_to, me.name) && !sameName(t.created_by, me.name)) fail(404, "Ticket not found");
  await c.env.DB.prepare("UPDATE help_tickets SET status = ?, done_date = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE ticket_id = ?")
    .bind(String(Status), Status === "Done" ? formatDateIST() : "", id).run();
  await audit(c.env, me.employeeID, "status", "help_ticket", id, { Status });
  return c.json({ ok: true });
});

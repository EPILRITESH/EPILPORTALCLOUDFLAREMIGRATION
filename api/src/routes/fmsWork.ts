// FMS — doer side: accessible FMS, my tasks / approvals, step actions, comments, attachments, notifications.
// Every route runs after requireAuth (mounted under fmsRoutes); per-row checks via canActOn / canApprove / fmsVisible.
import { Hono } from "hono";
import type { AppEnv } from "../types";
import { isAdmin, requireAdmin } from "../middleware/auth";
import { fail, jsonBody, str } from "../lib/util";
import { storeUpload, publicFileUrl } from "../lib/files";
import { istDay } from "../lib/fms/calendar";
import { canActOn, fmsVisible, history, j, loadSeats, notify, admins, type Bundle } from "../lib/fms/engine";
import {
  approveStep, completeStep, draftStep, myApprovals, myCompleted, myOpenTasks, reassignStep, rejectStep, reopenStep,
  requestExtension, setPlanned, skipStep, startStep, stepCtx,
} from "../lib/fms/actions";
import { actor, bundleOr404, idParam, page } from "../lib/fms/http";

export const fmsWorkRoutes = new Hono<AppEnv>();

/** GET /accessible — FMS this user can see (doer dashboard cards) */
fmsWorkRoutes.get("/accessible", async (c) => {
  const u = actor(c);
  const [defs, steps] = await c.env.DB.batch([
    c.env.DB.prepare("SELECT * FROM fms_definitions WHERE deleted = 0 AND archived = 0 AND is_template = 0 AND status = 'active' ORDER BY name COLLATE NOCASE"),
    c.env.DB.prepare("SELECT s.* FROM fms_steps s JOIN fms_definitions d ON d.id = s.fms_id WHERE d.deleted = 0 ORDER BY s.position"),
  ]);
  const seats = await loadSeats(c.env);
  const tasks = await myOpenTasks(c.env, u);
  const items = (defs.results as any[]).map((def) => {
    const b = { def, steps: (steps.results as any[]).filter((s) => s.fms_id === def.id), seats } as unknown as Bundle;
    const v = fmsVisible(b, u);
    if (!v.view) return null;
    const mine = tasks.filter((t) => t.fms.id === def.id);
    return {
      id: def.id, fms_id: def.fms_id, code: def.code, name: def.name, category: def.category, description: def.description, priority: def.priority,
      can_create: v.create, steps: b.steps.length,
      my_pending: mine.filter((t) => t.status !== "submitted").length, my_overdue: mine.filter((t) => t.overdue).length,
      my_submitted: mine.filter((t) => t.status === "submitted").length,
    };
  }).filter(Boolean);
  return c.json({ success: true, items });
});

/** GET /my/summary — dashboard counters */
fmsWorkRoutes.get("/my/summary", async (c) => {
  const u = actor(c);
  const tasks = await myOpenTasks(c.env, u);
  const today = istDay(new Date());
  const monthStart = `${today.slice(0, 7)}-01T00:00:00+05:30`;
  const done = await c.env.DB.prepare(`SELECT COUNT(*) AS n, SUM(delay_minutes = 0) AS on_time FROM fms_record_steps WHERE done_by = ? AND status = 'done' AND actual_at >= ?`)
    .bind(u.employeeID, new Date(monthStart).toISOString()).first<{ n: number; on_time: number }>();
  const approvals = (await myApprovals(c.env, u)).length;
  const unread = (await c.env.DB.prepare("SELECT COUNT(*) AS n FROM fms_notifications WHERE recipient = ? AND recipient_role = ? AND read_at = ''")
    .bind(u.employeeID, u.role === "admin" ? "admin" : "employee").first<{ n: number }>())!.n;
  const active = tasks.filter((t) => t.status !== "submitted");
  return c.json({
    success: true,
    counts: {
      pending: active.length, overdue: active.filter((t) => t.overdue).length, due_today: active.filter((t) => t.due_today).length,
      in_progress: active.filter((t) => t.status === "in_progress").length, rejected: active.filter((t) => t.status === "rejected").length,
      submitted: tasks.filter((t) => t.status === "submitted").length, completed_this_month: done?.n || 0,
      on_time_this_month: Number(done?.on_time) || 0, approvals, unread_notifications: unread,
    },
    upcoming: active.slice(0, 8),
  });
});

/** GET /my/tasks?bucket=pending|overdue|today|upcoming|in_progress|rejected|submitted|completed&fms=&search=&page=&limit= */
fmsWorkRoutes.get("/my/tasks", async (c) => {
  const u = actor(c);
  const bucket = c.req.query("bucket") || "pending";
  const { limit, offset, page: p } = page(c, 500);
  if (bucket === "completed") {
    const r = await myCompleted(c.env, u, limit, offset);
    return c.json({ success: true, page: p, limit, ...r });
  }
  let list = await myOpenTasks(c.env, u);
  const today = istDay(new Date());
  const filters: Record<string, (t: (typeof list)[number]) => boolean> = {
    all: () => true,
    pending: (t) => t.status !== "submitted",
    overdue: (t) => t.overdue,
    today: (t) => t.status !== "submitted" && t.due_today,
    upcoming: (t) => t.status !== "submitted" && !t.overdue && !!t.planned_at && istDay(new Date(t.planned_at)) > today,
    in_progress: (t) => t.status === "in_progress",
    rejected: (t) => t.status === "rejected",
    submitted: (t) => t.status === "submitted",
  };
  list = list.filter(filters[bucket] || filters.pending);
  const fms = Number(c.req.query("fms"));
  if (fms) list = list.filter((t) => t.fms.id === fms);
  const step = str(c.req.query("step"));
  if (step) list = list.filter((t) => t.step.name === step);
  const prio = str(c.req.query("priority"));
  if (prio) list = list.filter((t) => t.priority === prio);
  const q = str(c.req.query("search")).trim().toLowerCase();
  if (q) list = list.filter((t) => [t.uid, t.fms.name, t.step.name, ...t.summary.map((s) => str(s.value))].join(" ").toLowerCase().includes(q));
  if (c.req.query("sort") === "priority") {
    const rank: Record<string, number> = { Critical: 0, High: 1, Medium: 2, Low: 3 };
    list.sort((a, b) => (rank[a.priority] ?? 9) - (rank[b.priority] ?? 9));
  }
  return c.json({ success: true, page: p, limit, total: list.length, items: list.slice(offset, offset + limit) });
});

/** GET /my/approvals — submitted steps waiting for this user's approval */
fmsWorkRoutes.get("/my/approvals", async (c) => {
  const items = await myApprovals(c.env, actor(c));
  return c.json({ success: true, total: items.length, items });
});

// ------------------------------------------------------------------ step actions
const sid = (c: any) => idParam(c, "sid");

fmsWorkRoutes.post("/steps/:sid/start", async (c) => {
  await startStep(c.env, await stepCtx(c.env, sid(c)), actor(c));
  return c.json({ success: true });
});

fmsWorkRoutes.post("/steps/:sid/draft", async (c) => {
  const values = await draftStep(c.env, await stepCtx(c.env, sid(c)), actor(c), await jsonBody(c.req));
  return c.json({ success: true, values });
});

fmsWorkRoutes.post("/steps/:sid/complete", async (c) => {
  const r = await completeStep(c.env, await stepCtx(c.env, sid(c)), actor(c), await jsonBody(c.req));
  return c.json({ success: true, ...r });
});

fmsWorkRoutes.post("/steps/:sid/approve", async (c) => {
  const b = await jsonBody(c.req);
  await approveStep(c.env, await stepCtx(c.env, sid(c)), actor(c), str(b.remarks));
  return c.json({ success: true });
});

fmsWorkRoutes.post("/steps/:sid/reject", async (c) => {
  const b = await jsonBody(c.req);
  await rejectStep(c.env, await stepCtx(c.env, sid(c)), actor(c), str(b.reason));
  return c.json({ success: true });
});

fmsWorkRoutes.post("/steps/:sid/extension", async (c) => {
  const b = await jsonBody(c.req);
  await requestExtension(c.env, await stepCtx(c.env, sid(c)), actor(c), b.requested_at, str(b.reason));
  return c.json({ success: true });
});

// admin-only step controls
fmsWorkRoutes.post("/steps/:sid/reassign", requireAdmin, async (c) => {
  const b = await jsonBody(c.req);
  const name = await reassignStep(c.env, await stepCtx(c.env, sid(c)), actor(c), str(b.employee_id).trim(), str(b.reason));
  return c.json({ success: true, name });
});

fmsWorkRoutes.post("/steps/:sid/reopen", requireAdmin, async (c) => {
  const b = await jsonBody(c.req);
  await reopenStep(c.env, await stepCtx(c.env, sid(c)), actor(c), str(b.reason));
  return c.json({ success: true });
});

fmsWorkRoutes.post("/steps/:sid/planned", requireAdmin, async (c) => {
  const b = await jsonBody(c.req);
  const planned = await setPlanned(c.env, await stepCtx(c.env, sid(c)), actor(c), b.planned_at, str(b.reason));
  return c.json({ success: true, planned_at: planned });
});

fmsWorkRoutes.post("/steps/:sid/skip", requireAdmin, async (c) => {
  const b = await jsonBody(c.req);
  await skipStep(c.env, await stepCtx(c.env, sid(c)), actor(c), str(b.reason));
  return c.json({ success: true });
});

// ------------------------------------------------------------------ comments + attachments
/** May the user see/write on this row? (FMS visibility or one of its steps is theirs) */
async function rowAccess(c: any, rid: number) {
  const rec = await c.env.DB.prepare("SELECT id, fms_id, uid, deleted FROM fms_records WHERE id = ?").bind(rid).first();
  if (!rec || rec.deleted) fail(404, "Row not found");
  const b = await bundleOr404(c, rec.fms_id);
  const u = actor(c);
  if (!fmsVisible(b, u).view) {
    const { results } = await c.env.DB.prepare("SELECT * FROM fms_record_steps WHERE record_id = ?").bind(rid).all();
    if (!results.some((s: any) => { const st = b.steps.find((x) => x.id === s.step_id); return st && canActOn(s, st, b.seats, u); })) fail(403, "You do not have access to this row");
  }
  return { rec, b };
}

fmsWorkRoutes.post("/records/:rid/comments", async (c) => {
  const rid = idParam(c, "rid");
  const { rec, b } = await rowAccess(c, rid);
  const body = await jsonBody(c.req);
  const text = str(body.body).trim();
  if (!text) fail(400, "Write a comment");
  const internal = isAdmin(c) && body.internal ? 1 : 0;
  const rsId = body.record_step_id ? Number(body.record_step_id) : null;
  const u = actor(c);
  const r = await c.env.DB.prepare("INSERT INTO fms_comments (record_id, record_step_id, author, author_name, body, internal) VALUES (?, ?, ?, ?, ?, ?) RETURNING *")
    .bind(rid, rsId, u.employeeID, u.name, text.slice(0, 5000), internal).first();
  // tell the people who worked on the row (not for internal notes)
  if (!internal) {
    const { results } = await c.env.DB.prepare("SELECT DISTINCT done_by FROM fms_record_steps WHERE record_id = ? AND done_by != '' AND done_by != ?").bind(rid, u.employeeID).all<{ done_by: string }>();
    const to = results.map((x) => ({ employeeID: x.done_by }));
    if (u.role !== "admin") to.push(...(await admins(c.env)));
    await notify(c.env, to, { kind: "comment", title: `Comment on ${rec.uid}`, body: `${u.name}: ${text.slice(0, 140)}`, fms_id: b.def.id, record_id: rid, record_step_id: rsId ?? undefined });
  }
  return c.json({ success: true, comment: r }, 201);
});

fmsWorkRoutes.delete("/comments/:id", async (c) => {
  const id = idParam(c);
  const cm = await c.env.DB.prepare("SELECT * FROM fms_comments WHERE id = ?").bind(id).first<any>();
  if (!cm) fail(404, "Comment not found");
  if (!isAdmin(c) && cm.author !== actor(c).employeeID) fail(403, "You can delete only your own comments");
  await c.env.DB.prepare("DELETE FROM fms_comments WHERE id = ?").bind(id).run();
  return c.json({ success: true });
});

/** POST /records/:rid/attachments (multipart: file, record_step_id?) */
fmsWorkRoutes.post("/records/:rid/attachments", async (c) => {
  const rid = idParam(c, "rid");
  await rowAccess(c, rid);
  const form = await c.req.formData().catch(() => fail(400, "Send the file as multipart/form-data"));
  const file = form.get("file") as unknown;
  if (!(file instanceof File) || !file.size) fail(400, "Choose a file");
  const ref = await storeUpload(c.env, file, "fms", { allowDocs: true });
  const u = actor(c);
  const rsId = form.get("record_step_id") ? Number(form.get("record_step_id")) : null;
  const row = await c.env.DB.prepare("INSERT INTO fms_attachments (record_id, record_step_id, url, name, mime, size, uploaded_by, uploaded_by_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *")
    .bind(rid, rsId, ref, file.name.slice(0, 200), file.type, file.size, u.employeeID, u.name).first<any>();
  await history(c.env, rid, rsId, "file_uploaded", u, "", { name: file.name });
  return c.json({ success: true, attachment: { ...row, url: await publicFileUrl(c, row.url) } }, 201);
});

/** GET /records/:rid/attachments — with browser-loadable URLs (signed when stored in R2) */
fmsWorkRoutes.get("/records/:rid/attachments", async (c) => {
  const rid = idParam(c, "rid");
  await rowAccess(c, rid);
  const { results } = await c.env.DB.prepare("SELECT * FROM fms_attachments WHERE record_id = ? ORDER BY id").bind(rid).all<any>();
  return c.json({ success: true, items: await Promise.all(results.map(async (a) => ({ ...a, url: await publicFileUrl(c, a.url) }))) });
});

fmsWorkRoutes.delete("/attachments/:id", async (c) => {
  const id = idParam(c);
  const a = await c.env.DB.prepare("SELECT * FROM fms_attachments WHERE id = ?").bind(id).first<any>();
  if (!a) fail(404, "File not found");
  if (!isAdmin(c) && a.uploaded_by !== actor(c).employeeID) fail(403, "You can remove only your own files");
  await c.env.DB.prepare("DELETE FROM fms_attachments WHERE id = ?").bind(id).run();
  await history(c.env, a.record_id, a.record_step_id, "file_removed", actor(c), "", { name: a.name });
  return c.json({ success: true });
});

// ------------------------------------------------------------------ notifications
fmsWorkRoutes.get("/notifications", async (c) => {
  const u = actor(c);
  const role = u.role === "admin" ? "admin" : "employee";
  const { limit, offset } = page(c, 100);
  const unreadOnly = c.req.query("unread") === "1";
  const [items, unread] = await c.env.DB.batch([
    c.env.DB.prepare(`SELECT * FROM fms_notifications WHERE recipient = ? AND recipient_role = ? ${unreadOnly ? "AND read_at = ''" : ""} ORDER BY id DESC LIMIT ? OFFSET ?`).bind(u.employeeID, role, limit, offset),
    c.env.DB.prepare("SELECT COUNT(*) AS n FROM fms_notifications WHERE recipient = ? AND recipient_role = ? AND read_at = ''").bind(u.employeeID, role),
  ]);
  return c.json({ success: true, items: items.results, unread: (unread.results[0] as any).n });
});

/** POST /notifications/read {ids?: number[], all?: true} */
fmsWorkRoutes.post("/notifications/read", async (c) => {
  const u = actor(c);
  const role = u.role === "admin" ? "admin" : "employee";
  const b = await jsonBody(c.req);
  const t = new Date().toISOString();
  if (b.all) {
    await c.env.DB.prepare("UPDATE fms_notifications SET read_at = ? WHERE recipient = ? AND recipient_role = ? AND read_at = ''").bind(t, u.employeeID, role).run();
  } else {
    const ids = (Array.isArray(b.ids) ? b.ids : []).map(Number).filter(Boolean).slice(0, 200);
    if (ids.length) await c.env.DB.prepare(`UPDATE fms_notifications SET read_at = ? WHERE recipient = ? AND recipient_role = ? AND id IN (${ids.map(() => "?").join(",")})`).bind(t, u.employeeID, role, ...ids).run();
  }
  return c.json({ success: true });
});

// ------------------------------------------------------------------ saved filters (per user)
fmsWorkRoutes.get("/filters", async (c) => {
  const { results } = await c.env.DB.prepare("SELECT * FROM fms_saved_filters WHERE owner = ? AND scope = ? ORDER BY name").bind(actor(c).employeeID, str(c.req.query("scope"))).all<any>();
  return c.json({ success: true, items: results.map((f) => ({ ...f, filters: j(f.filters, {}) })) });
});

fmsWorkRoutes.post("/filters", async (c) => {
  const b = await jsonBody(c.req);
  if (!str(b.name).trim()) fail(400, "Name the filter");
  const r = await c.env.DB.prepare("INSERT INTO fms_saved_filters (owner, scope, name, filters) VALUES (?, ?, ?, ?) RETURNING id")
    .bind(actor(c).employeeID, str(b.scope), str(b.name).trim().slice(0, 80), JSON.stringify(b.filters || {})).first<{ id: number }>();
  return c.json({ success: true, id: r!.id }, 201);
});

fmsWorkRoutes.delete("/filters/:id", async (c) => {
  await c.env.DB.prepare("DELETE FROM fms_saved_filters WHERE id = ? AND owner = ?").bind(idParam(c), actor(c).employeeID).run();
  return c.json({ success: true });
});

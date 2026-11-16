// FMS — admin side: seating, holidays, lookups, reports, audit, background job triggers.
// Mounted under fmsRoutes (requireAuth); everything here is requireAdmin except GET /lookups.
import { Hono } from "hono";
import type { AppEnv } from "../types";
import { isAdmin, requireAdmin } from "../middleware/auth";
import { fail, jsonBody, str } from "../lib/util";
import { audit } from "../lib/audit";
import { j, resolvePeople, seatMatches, loadSeats } from "../lib/fms/engine";
import { runFmsRecurrence, runFmsReminders } from "../lib/fms/cron";
import { actor, idParam } from "../lib/fms/http";

export const fmsAdminRoutes = new Hono<AppEnv>();
const nowIso = () => new Date().toISOString();
const KINDS = ["department", "designation", "employee"];
const ymdOk = (s: string) => !s || /^\d{4}-\d{2}-\d{2}$/.test(s);

/** GET /lookups — departments, designations, employees and seats for pickers (names only for doers) */
fmsAdminRoutes.get("/lookups", async (c) => {
  const [users, seats] = await c.env.DB.batch([
    c.env.DB.prepare("SELECT employee_id, name, department, designation FROM users WHERE role = 'employee' AND is_active = 1 ORDER BY name COLLATE NOCASE"),
    c.env.DB.prepare("SELECT id, code, name, active FROM fms_seats ORDER BY code COLLATE NOCASE"),
  ]);
  const list = users.results as any[];
  const uniq = (k: string) => [...new Set(list.map((u) => str(u[k]).trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  return c.json({
    success: true,
    departments: uniq("department"), designations: uniq("designation"),
    employees: isAdmin(c) ? list : list.map((u) => ({ employee_id: u.employee_id, name: u.name })),
    seats: seats.results,
  });
});

// ------------------------------------------------------------------ seating
interface MemberIn { kind: string; value: string; start_date?: string; end_date?: string; active?: boolean }
function cleanMembers(list: unknown): MemberIn[] {
  const out: MemberIn[] = [];
  for (const m of Array.isArray(list) ? list : []) {
    const kind = str(m?.kind), value = str(m?.value).trim();
    if (!KINDS.includes(kind)) fail(400, `Member type must be one of ${KINDS.join(", ")}`);
    if (!value) fail(400, "Every member needs a value");
    const start = str(m.start_date), end = str(m.end_date);
    if (!ymdOk(start) || !ymdOk(end)) fail(400, "Dates must be YYYY-MM-DD");
    if (start && end && end < start) fail(400, `${value}: end date is before start date`);
    out.push({ kind, value, start_date: start, end_date: end, active: m.active !== false });
  }
  return out;
}

async function seatList(c: any, id?: number) {
  const [s, m, used] = await c.env.DB.batch([
    c.env.DB.prepare(`SELECT * FROM fms_seats ${id ? "WHERE id = ?" : ""} ORDER BY code COLLATE NOCASE`).bind(...(id ? [id] : [])),
    c.env.DB.prepare(`SELECT * FROM fms_seat_members ${id ? "WHERE seat_id = ?" : ""} ORDER BY id`).bind(...(id ? [id] : [])),
    c.env.DB.prepare(`SELECT s.seat_id, s.name AS step, s.code AS step_code, d.id AS fms_id, d.name AS fms FROM fms_steps s JOIN fms_definitions d ON d.id = s.fms_id WHERE d.deleted = 0 AND s.seat_id IS NOT NULL`),
  ]);
  const people = await resolvePeople(c.env, () => true);
  const seatsMap = await loadSeats(c.env);
  return (s.results as any[]).map((seat) => ({
    ...seat, active: !!seat.active,
    members: (m.results as any[]).filter((x) => x.seat_id === seat.id).map((x) => ({ ...x, active: !!x.active })),
    used_in: (used.results as any[]).filter((x) => x.seat_id === seat.id),
    people_now: people.filter((p) => seatMatches(seatsMap.get(seat.id), p)).map((p) => ({ employee_id: p.employeeID, name: p.name, department: p.department, designation: p.designation })),
  }));
}

fmsAdminRoutes.get("/seats", requireAdmin, async (c) => c.json({ success: true, items: await seatList(c) }));

async function writeMembers(c: any, seatId: number, members: MemberIn[]) {
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM fms_seat_members WHERE seat_id = ?").bind(seatId),
    ...members.map((m) => c.env.DB.prepare("INSERT INTO fms_seat_members (seat_id, kind, value, start_date, end_date, active) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(seatId, m.kind, m.value, m.start_date || "", m.end_date || "", m.active === false ? 0 : 1)),
  ]);
}

fmsAdminRoutes.post("/seats", requireAdmin, async (c) => {
  const b = await jsonBody(c.req);
  const code = str(b.code).trim();
  if (!code) fail(400, "Seat code is required (e.g. CRM, PC-1)");
  if (await c.env.DB.prepare("SELECT 1 FROM fms_seats WHERE code = ?").bind(code).first()) fail(409, `Seat "${code}" already exists`);
  const members = cleanMembers(b.members);
  const r = await c.env.DB.prepare("INSERT INTO fms_seats (code, name, description, active) VALUES (?, ?, ?, ?) RETURNING id")
    .bind(code, str(b.name).trim() || code, str(b.description), b.active === false ? 0 : 1).first<{ id: number }>();
  await writeMembers(c, r!.id, members);
  await audit(c.env, actor(c).employeeID, "create", "fms_seat", String(r!.id), { code, members });
  return c.json({ success: true, seat: (await seatList(c, r!.id))[0] }, 201);
});

fmsAdminRoutes.put("/seats/:id", requireAdmin, async (c) => {
  const id = idParam(c);
  const cur = await c.env.DB.prepare("SELECT * FROM fms_seats WHERE id = ?").bind(id).first<any>();
  if (!cur) fail(404, "Seat not found");
  const b = await jsonBody(c.req);
  const code = str(b.code).trim() || cur.code;
  if (await c.env.DB.prepare("SELECT 1 FROM fms_seats WHERE code = ? AND id != ?").bind(code, id).first()) fail(409, `Seat "${code}" already exists`);
  const members = b.members !== undefined ? cleanMembers(b.members) : null;
  const before = (await seatList(c, id))[0];
  await c.env.DB.prepare("UPDATE fms_seats SET code = ?, name = ?, description = ?, active = ?, updated_at = ? WHERE id = ?")
    .bind(code, str(b.name ?? cur.name).trim() || code, str(b.description ?? cur.description), b.active === undefined ? cur.active : b.active ? 1 : 0, nowIso(), id).run();
  if (members) await writeMembers(c, id, members);
  await audit(c.env, actor(c).employeeID, "update", "fms_seat", String(id), { before: { code: before.code, members: before.members.map((m: any) => `${m.kind}:${m.value}`) }, after: { code, members: members?.map((m) => `${m.kind}:${m.value}`) } });
  return c.json({ success: true, seat: (await seatList(c, id))[0] });
});

/** DELETE /seats/:id — refused while steps use it unless ?force=1 (those steps then need a new WHO) */
fmsAdminRoutes.delete("/seats/:id", requireAdmin, async (c) => {
  const id = idParam(c);
  const used = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM fms_steps WHERE seat_id = ?").bind(id).first<{ n: number }>();
  if (used!.n && c.req.query("force") !== "1") fail(409, `This seat is used by ${used!.n} step(s). Change those steps first, or delete anyway.`);
  const r = await c.env.DB.prepare("DELETE FROM fms_seats WHERE id = ? RETURNING code").bind(id).first<{ code: string }>();
  if (!r) fail(404, "Seat not found");
  await audit(c.env, actor(c).employeeID, "delete", "fms_seat", String(id), { code: r.code });
  return c.json({ success: true });
});

fmsAdminRoutes.post("/seats/:id/duplicate", requireAdmin, async (c) => {
  const id = idParam(c);
  const [src] = await seatList(c, id);
  if (!src) fail(404, "Seat not found");
  const b = await jsonBody(c.req);
  let code = str(b.code).trim() || `${src.code}-COPY`;
  for (let n = 2; await c.env.DB.prepare("SELECT 1 FROM fms_seats WHERE code = ?").bind(code).first(); n++) code = `${src.code}-COPY${n}`;
  const r = await c.env.DB.prepare("INSERT INTO fms_seats (code, name, description, active) VALUES (?, ?, ?, ?) RETURNING id").bind(code, `${src.name} (copy)`, src.description, src.active ? 1 : 0).first<{ id: number }>();
  await writeMembers(c, r!.id, src.members);
  await audit(c.env, actor(c).employeeID, "duplicate", "fms_seat", String(r!.id), { from: id });
  return c.json({ success: true, seat: (await seatList(c, r!.id))[0] }, 201);
});

/** POST /seats/import {rows: [{code, name?, kind, value, start_date?, end_date?}], replace?: bool} */
fmsAdminRoutes.post("/seats/import", requireAdmin, async (c) => {
  const b = await jsonBody(c.req);
  const rows = Array.isArray(b.rows) ? b.rows : [];
  if (!rows.length) fail(400, "No rows to import");
  const errors: { row: number; error: string }[] = [];
  const bySeat = new Map<string, { code: string; name: string; members: MemberIn[] }>();
  rows.forEach((r: any, i: number) => {
    const code = str(r.code ?? r.seat ?? r.Seat).trim();
    if (!code) { errors.push({ row: i + 1, error: "Seat code missing" }); return; }
    const g = bySeat.get(code.toLowerCase()) || { code, name: str(r.name).trim() || code, members: [] };
    bySeat.set(code.toLowerCase(), g);
    const kind = str(r.kind ?? r.type).trim().toLowerCase();
    const value = str(r.value).trim();
    if (!kind && !value) return; // seat without members
    try { g.members.push(...cleanMembers([{ kind, value, start_date: str(r.start_date), end_date: str(r.end_date) }])); }
    catch (e: any) { errors.push({ row: i + 1, error: (e?.message as string) || "Invalid member" }); }
  });
  let created = 0, updated = 0;
  for (const [, g] of bySeat) {
    const code = g.code;
    const ex = await c.env.DB.prepare("SELECT id FROM fms_seats WHERE code = ?").bind(code).first<{ id: number }>();
    if (!ex) {
      const r = await c.env.DB.prepare("INSERT INTO fms_seats (code, name) VALUES (?, ?) RETURNING id").bind(code, g.name).first<{ id: number }>();
      await writeMembers(c, r!.id, g.members); created++;
    } else {
      const cur = b.replace ? [] : ((await c.env.DB.prepare("SELECT kind, value, start_date, end_date, active FROM fms_seat_members WHERE seat_id = ?").bind(ex.id).all<any>()).results as MemberIn[]);
      const key = (m: MemberIn) => `${m.kind}|${m.value.toLowerCase()}|${m.start_date || ""}|${m.end_date || ""}`;
      const merged = [...new Map([...cur, ...g.members].map((m) => [key(m), m])).values()];
      await writeMembers(c, ex.id, merged); updated++;
    }
  }
  await audit(c.env, actor(c).employeeID, "import", "fms_seat", "", { created, updated, errors: errors.length });
  return c.json({ success: true, created, updated, errors });
});

fmsAdminRoutes.get("/seats/:id/history", requireAdmin, async (c) => {
  const { results } = await c.env.DB.prepare("SELECT * FROM audit_log WHERE entity = 'fms_seat' AND entity_id = ? ORDER BY id DESC LIMIT 200").bind(String(idParam(c))).all<any>();
  return c.json({ success: true, items: results.map((r) => ({ ...r, detail: j(r.detail, r.detail) })) });
});

// ------------------------------------------------------------------ holidays (planning calendar)
fmsAdminRoutes.get("/holidays", async (c) => {
  const { results } = await c.env.DB.prepare("SELECT * FROM fms_holidays ORDER BY date").all();
  return c.json({ success: true, items: results });
});

/** POST /holidays {date, name} or {items: [{date, name}]} */
fmsAdminRoutes.post("/holidays", requireAdmin, async (c) => {
  const b = await jsonBody(c.req);
  const items = (Array.isArray(b.items) ? b.items : [b]).map((h: any) => ({ date: str(h.date).trim(), name: str(h.name).trim() }));
  const bad = items.find((h: any) => !/^\d{4}-\d{2}-\d{2}$/.test(h.date));
  if (bad) fail(400, `Invalid date "${bad.date}" (use YYYY-MM-DD)`);
  if (!items.length) fail(400, "Give at least one holiday");
  await c.env.DB.batch(items.map((h: any) => c.env.DB.prepare("INSERT INTO fms_holidays (date, name) VALUES (?, ?) ON CONFLICT(date) DO UPDATE SET name = excluded.name").bind(h.date, h.name)));
  await audit(c.env, actor(c).employeeID, "upsert", "fms_holiday", "", { count: items.length });
  return c.json({ success: true, saved: items.length });
});

fmsAdminRoutes.delete("/holidays/:date", requireAdmin, async (c) => {
  await c.env.DB.prepare("DELETE FROM fms_holidays WHERE date = ?").bind(c.req.param("date")).run();
  await audit(c.env, actor(c).employeeID, "delete", "fms_holiday", c.req.param("date"));
  return c.json({ success: true });
});

// ------------------------------------------------------------------ approvals overview, reports, audit
/** GET /approvals — every step waiting for approval (admin view) */
fmsAdminRoutes.get("/approvals", requireAdmin, async (c) => {
  const { results } = await c.env.DB.prepare(`SELECT rs.id, rs.record_id, rs.submitted_at, rs.planned_at, rs.done_by_name, rs.outcome, rs.remarks, r.uid, d.id AS fms_id, d.name AS fms_name, d.code, s.name AS step_name, s.code AS step_code
    FROM fms_record_steps rs JOIN fms_records r ON r.id = rs.record_id JOIN fms_definitions d ON d.id = r.fms_id JOIN fms_steps s ON s.id = rs.step_id
    WHERE rs.status = 'submitted' AND r.deleted = 0 AND d.deleted = 0 ORDER BY rs.submitted_at`).all();
  return c.json({ success: true, items: results });
});

/** GET /reports?fms=&from=YYYY-MM-DD&to=YYYY-MM-DD — summary, per step, per person, trend */
fmsAdminRoutes.get("/reports", requireAdmin, async (c) => {
  const fms = Number(c.req.query("fms")) || 0;
  const from = c.req.query("from"), to = c.req.query("to");
  const now = nowIso();
  const rw = ["r.deleted = 0", "d.deleted = 0"], ra: unknown[] = [];
  if (fms) { rw.push("r.fms_id = ?"); ra.push(fms); }
  if (from) { rw.push("COALESCE(NULLIF(r.start_at, ''), r.created_at) >= ?"); ra.push(new Date(`${from}T00:00:00+05:30`).toISOString()); }
  if (to) { rw.push("COALESCE(NULLIF(r.start_at, ''), r.created_at) <= ?"); ra.push(new Date(`${to}T23:59:59+05:30`).toISOString()); }
  const W = rw.join(" AND ");
  const J = "FROM fms_record_steps rs JOIN fms_records r ON r.id = rs.record_id JOIN fms_definitions d ON d.id = r.fms_id";
  const [byFms, bySteps, byPerson, trendIn, trendDone, totals] = await c.env.DB.batch([
    c.env.DB.prepare(`SELECT d.id, d.name, d.code, COUNT(*) AS total, SUM(r.status = 'open') AS open, SUM(r.status = 'completed') AS completed, SUM(r.status = 'cancelled') AS cancelled,
        SUM(EXISTS (SELECT 1 FROM fms_record_steps x WHERE x.record_id = r.id AND x.status IN ('pending','in_progress','rejected') AND x.planned_at != '' AND x.planned_at < ?)) AS overdue
      FROM fms_records r JOIN fms_definitions d ON d.id = r.fms_id WHERE ${W} GROUP BY d.id ORDER BY total DESC`).bind(now, ...ra),
    c.env.DB.prepare(`SELECT d.name AS fms, s.id AS step_id, s.position, s.code, s.name, COUNT(*) AS total,
        SUM(rs.status = 'done') AS done, SUM(rs.status = 'done' AND rs.delay_minutes = 0) AS on_time, SUM(rs.status = 'done' AND rs.delay_minutes > 0) AS late,
        SUM(rs.status IN ('pending','in_progress','rejected')) AS pending, SUM(rs.status = 'submitted') AS awaiting_approval,
        SUM(rs.status IN ('pending','in_progress','rejected') AND rs.planned_at != '' AND rs.planned_at < ?) AS overdue, SUM(rs.status = 'skipped') AS skipped,
        ROUND(AVG(CASE WHEN rs.status = 'done' THEN rs.delay_minutes END) / 60.0, 1) AS avg_delay_hours
      ${J} JOIN fms_steps s ON s.id = rs.step_id WHERE ${W} GROUP BY s.id ORDER BY d.name, s.position`).bind(now, ...ra),
    c.env.DB.prepare(`SELECT rs.done_by_name AS name, rs.done_by AS employee_id, COUNT(*) AS done, SUM(rs.delay_minutes = 0) AS on_time, SUM(rs.delay_minutes > 0) AS late,
        ROUND(AVG(rs.delay_minutes) / 60.0, 1) AS avg_delay_hours
      ${J} WHERE ${W} AND rs.status = 'done' AND rs.done_by_name != '' GROUP BY lower(rs.done_by_name) ORDER BY done DESC LIMIT 200`).bind(...ra),
    c.env.DB.prepare(`SELECT substr(datetime(COALESCE(NULLIF(r.start_at, ''), r.created_at), '+330 minutes'), 1, 10) AS day, COUNT(*) AS n
      FROM fms_records r JOIN fms_definitions d ON d.id = r.fms_id WHERE ${W} AND COALESCE(NULLIF(r.start_at, ''), r.created_at) >= ? GROUP BY day ORDER BY day`).bind(...ra, new Date(Date.now() - 30 * 86_400_000).toISOString()),
    c.env.DB.prepare(`SELECT substr(datetime(rs.actual_at, '+330 minutes'), 1, 10) AS day, COUNT(*) AS n ${J}
      WHERE ${W} AND rs.status = 'done' AND rs.actual_at >= ? GROUP BY day ORDER BY day`).bind(...ra, new Date(Date.now() - 30 * 86_400_000).toISOString()),
    c.env.DB.prepare(`SELECT COUNT(*) AS steps, SUM(rs.status = 'done') AS done, SUM(rs.status = 'done' AND rs.delay_minutes = 0) AS on_time,
        SUM(rs.status IN ('pending','in_progress','rejected')) AS pending, SUM(rs.status IN ('pending','in_progress','rejected') AND rs.planned_at != '' AND rs.planned_at < ?) AS overdue,
        SUM(rs.status = 'submitted') AS awaiting_approval ${J} WHERE ${W}`).bind(now, ...ra),
  ]);
  const num = (rows: any[]) => rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === "number" || v === null ? Number(v) || 0 : v])));
  const t = num(totals.results as any[])[0] as any;
  return c.json({
    success: true,
    totals: { ...t, on_time_pct: t.done ? Math.round((t.on_time / t.done) * 1000) / 10 : 0 },
    by_fms: num(byFms.results as any[]), by_step: num(bySteps.results as any[]), by_person: num(byPerson.results as any[]),
    trend: { created: trendIn.results, completed: trendDone.results },
  });
});

/** GET /audit?fms=&limit= — setup changes (FMS, seats, holidays) */
fmsAdminRoutes.get("/audit", requireAdmin, async (c) => {
  const fms = c.req.query("fms");
  const limit = Math.min(500, Number(c.req.query("limit")) || 200);
  const { results } = await c.env.DB.prepare(`SELECT a.*, u.name AS actor_name FROM audit_log a LEFT JOIN users u ON u.employee_id = a.actor AND u.role = 'admin'
    WHERE a.entity LIKE 'fms%' ${fms ? "AND a.entity = 'fms' AND a.entity_id = ?" : ""} ORDER BY a.id DESC LIMIT ?`).bind(...(fms ? [fms] : []), limit).all<any>();
  return c.json({ success: true, items: results.map((r) => ({ ...r, detail: j(r.detail, r.detail) })) });
});

/** POST /jobs/reminders | /jobs/recurrence — run the background jobs now */
fmsAdminRoutes.post("/jobs/reminders", requireAdmin, async (c) => c.json({ success: true, ...(await runFmsReminders(c.env)) }));
fmsAdminRoutes.post("/jobs/recurrence", requireAdmin, async (c) => c.json({ success: true, ...(await runFmsRecurrence(c.env)) }));

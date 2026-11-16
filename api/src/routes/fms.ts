// FMS (Flow Management System) API — mounted at /api/fms.
// Access: every route requires a login; admin-only routes use requireAdmin; doer routes check
// FMS visibility (fmsVisible) or step assignment (canActOn / canApprove) per row.
import { Hono, type Context } from "hono";
import type { AppEnv } from "../types";
import { isAdmin, requireAdmin, requireAuth } from "../middleware/auth";
import { fail, jsonBody, str } from "../lib/util";
import { audit } from "../lib/audit";
import { formatIST } from "../lib/fms/calendar";
import { coerceValues, getDefinition, normaliseDefinition, saveDefinition, toInput, type DefinitionInput, type StepInput } from "../lib/fms/definitions";
import { canActOn, canApprove, fmsVisible, history, j, type Bundle, type RecordStepRow } from "../lib/fms/engine";
import { actor, bundleOr404, idParam, mustView, page } from "../lib/fms/http";
import { createRecord, createRecordsBulk, type RowInput } from "../lib/fms/records";
import { analyzeGrid } from "../lib/fms/importer";
import { fmsWorkRoutes } from "./fmsWork";
import { fmsAdminRoutes } from "./fmsAdmin";

export const fmsRoutes = new Hono<AppEnv>();
fmsRoutes.use("*", requireAuth);

const nowIso = () => new Date().toISOString();

// ================================================================== definitions
const DEF_VIEWS: Record<string, string> = {
  all: "d.deleted = 0 AND d.archived = 0 AND d.is_template = 0",
  active: "d.deleted = 0 AND d.archived = 0 AND d.is_template = 0 AND d.status = 'active'",
  inactive: "d.deleted = 0 AND d.archived = 0 AND d.is_template = 0 AND d.status = 'inactive'",
  archived: "d.deleted = 0 AND d.archived = 1",
  templates: "d.deleted = 0 AND d.is_template = 1",
  deleted: "d.deleted = 1",
};
const SORTS: Record<string, string> = {
  updated: "d.updated_at DESC", created: "d.created_at DESC", name: "d.name COLLATE NOCASE", code: "d.code COLLATE NOCASE", priority:
    "CASE d.priority WHEN 'Critical' THEN 0 WHEN 'High' THEN 1 WHEN 'Medium' THEN 2 ELSE 3 END",
};

/** GET /definitions — admin list with search, filters, pagination and stats */
fmsRoutes.get("/definitions", requireAdmin, async (c) => {
  const { limit, offset, page: p } = page(c);
  const where = [DEF_VIEWS[c.req.query("view") || "all"] || DEF_VIEWS.all];
  const args: unknown[] = [];
  const q = str(c.req.query("search")).trim();
  if (q) { where.push("(d.name LIKE ? OR d.code LIKE ? OR d.fms_id LIKE ? OR d.category LIKE ? OR d.description LIKE ?)"); args.push(...Array(5).fill(`%${q}%`)); }
  for (const k of ["category", "priority", "frequency"] as const) { const v = c.req.query(k); if (v) { where.push(`d.${k} = ?`); args.push(v); } }
  const sql = `FROM fms_definitions d WHERE ${where.join(" AND ")}`;
  const [items, total, stats] = await c.env.DB.batch([
    c.env.DB.prepare(`SELECT d.*,
        (SELECT COUNT(*) FROM fms_records r WHERE r.fms_id = d.id AND r.deleted = 0) AS rows_total,
        (SELECT COUNT(*) FROM fms_records r WHERE r.fms_id = d.id AND r.deleted = 0 AND r.status = 'open') AS rows_open,
        (SELECT COUNT(*) FROM fms_record_steps rs JOIN fms_records r ON r.id = rs.record_id WHERE r.fms_id = d.id AND r.deleted = 0
           AND rs.status IN ('pending','in_progress','rejected') AND rs.planned_at != '' AND rs.planned_at < ?) AS overdue,
        (SELECT COUNT(*) FROM fms_steps s WHERE s.fms_id = d.id) AS step_count
      ${sql} ORDER BY ${SORTS[c.req.query("sort") || "updated"] || SORTS.updated} LIMIT ? OFFSET ?`).bind(nowIso(), ...args, limit, offset),
    c.env.DB.prepare(`SELECT COUNT(*) AS n ${sql}`).bind(...args),
    c.env.DB.prepare(`SELECT
        SUM(deleted = 0 AND archived = 0 AND is_template = 0) AS total, SUM(deleted = 0 AND archived = 0 AND is_template = 0 AND status = 'active') AS active,
        SUM(deleted = 0 AND archived = 0 AND is_template = 0 AND status = 'inactive') AS inactive, SUM(deleted = 0 AND archived = 1) AS archived,
        SUM(deleted = 0 AND is_template = 1) AS templates, SUM(deleted = 1) AS deleted FROM fms_definitions`),
  ]);
  const cats = await c.env.DB.prepare("SELECT DISTINCT category FROM fms_definitions WHERE category != '' AND deleted = 0 ORDER BY category").all<{ category: string }>();
  return c.json({
    success: true, page: p, limit, total: (total.results[0] as any).n,
    items: (items.results as any[]).map((d) => ({ ...d, archived: !!d.archived, deleted: !!d.deleted, is_template: !!d.is_template, access: j(d.access, {}), calendar: j(d.calendar, {}), schedule: j(d.schedule, {}), settings: j(d.settings, {}) })),
    stats: Object.fromEntries(Object.entries(stats.results[0] as any).map(([k, v]) => [k, Number(v) || 0])),
    categories: cats.results.map((r) => r.category),
  });
});

/** GET /definitions/:id — admins, or doers who can see the FMS (for forms and task context) */
fmsRoutes.get("/definitions/:id", async (c) => {
  const id = idParam(c);
  const b = await bundleOr404(c, id);
  mustView(c, b);
  const def = await getDefinition(c.env, id);
  const seats = [...b.seats.values()].map((s) => ({ id: s.id, code: s.code, name: s.name }));
  return c.json({ success: true, definition: def, seats, permissions: fmsVisible(b, actor(c)) });
});

fmsRoutes.post("/definitions", requireAdmin, async (c) => {
  const body = await jsonBody<DefinitionInput>(c.req);
  const n = normaliseDefinition(body);
  const id = await saveDefinition(c.env, n, actor(c).name);
  await audit(c.env, actor(c).employeeID, "create", "fms", String(id), { name: n.def.name });
  return c.json({ success: true, id, definition: await getDefinition(c.env, id) }, 201);
});

fmsRoutes.put("/definitions/:id", requireAdmin, async (c) => {
  const id = idParam(c);
  await bundleOr404(c, id);
  const n = normaliseDefinition(await jsonBody<DefinitionInput>(c.req));
  await saveDefinition(c.env, n, actor(c).name, id);
  await audit(c.env, actor(c).employeeID, "update", "fms", String(id), { name: n.def.name });
  return c.json({ success: true, id, definition: await getDefinition(c.env, id) });
});

/** PATCH /definitions/:id/state {status?, archived?, is_template?} */
fmsRoutes.patch("/definitions/:id/state", requireAdmin, async (c) => {
  const id = idParam(c);
  await bundleOr404(c, id);
  const b = await jsonBody(c.req);
  const sets: string[] = [], args: unknown[] = [];
  if (b.status !== undefined) { if (!["active", "inactive"].includes(b.status)) fail(400, "status must be active or inactive"); sets.push("status = ?"); args.push(b.status); }
  if (b.archived !== undefined) { sets.push("archived = ?"); args.push(b.archived ? 1 : 0); }
  if (b.is_template !== undefined) { sets.push("is_template = ?"); args.push(b.is_template ? 1 : 0); }
  if (!sets.length) fail(400, "Nothing to change");
  await c.env.DB.prepare(`UPDATE fms_definitions SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`).bind(...args, nowIso(), id).run();
  await audit(c.env, actor(c).employeeID, "state", "fms", String(id), b);
  return c.json({ success: true });
});

/** DELETE /definitions/:id — soft delete (restorable). ?purge=1 removes it and all rows permanently (must be deleted first). */
fmsRoutes.delete("/definitions/:id", requireAdmin, async (c) => {
  const id = idParam(c);
  const b = await bundleOr404(c, id);
  if (c.req.query("purge") === "1") {
    if (!b.def.deleted) fail(409, "Move the FMS to Deleted first, then delete permanently");
    await c.env.DB.prepare("DELETE FROM fms_definitions WHERE id = ?").bind(id).run();
    await audit(c.env, actor(c).employeeID, "purge", "fms", String(id), { name: b.def.name });
    return c.json({ success: true, purged: true });
  }
  await c.env.DB.prepare("UPDATE fms_definitions SET deleted = 1, updated_at = ? WHERE id = ?").bind(nowIso(), id).run();
  await audit(c.env, actor(c).employeeID, "delete", "fms", String(id), { name: b.def.name });
  return c.json({ success: true });
});

fmsRoutes.post("/definitions/:id/restore", requireAdmin, async (c) => {
  const id = idParam(c);
  await c.env.DB.prepare("UPDATE fms_definitions SET deleted = 0, updated_at = ? WHERE id = ?").bind(nowIso(), id).run();
  await audit(c.env, actor(c).employeeID, "restore", "fms", String(id));
  return c.json({ success: true });
});

/** POST /definitions/:id/duplicate {name?, code?, is_template?} — copies setup (not rows) */
fmsRoutes.post("/definitions/:id/duplicate", requireAdmin, async (c) => {
  const id = idParam(c);
  const def = await getDefinition(c.env, id);
  if (!def) fail(404, "FMS not found");
  const b = await jsonBody(c.req);
  const input = toInput(def, false);
  input.name = str(b.name).trim() || `${def.name} (copy)`;
  input.code = str(b.code).trim();
  input.is_template = b.is_template !== undefined ? !!b.is_template : false;
  const newId = await saveDefinition(c.env, normaliseDefinition(input), actor(c).name);
  await audit(c.env, actor(c).employeeID, b.is_template ? "save_template" : "duplicate", "fms", String(newId), { from: id });
  return c.json({ success: true, id: newId, definition: await getDefinition(c.env, newId) }, 201);
});

fmsRoutes.get("/definitions/:id/versions", requireAdmin, async (c) => {
  const { results } = await c.env.DB.prepare("SELECT id, version, created_by, created_at, snapshot FROM fms_versions WHERE fms_id = ? ORDER BY version DESC LIMIT 100").bind(idParam(c)).all<any>();
  return c.json({ success: true, items: results.map((v) => { const s = j<any>(v.snapshot, {}); return { id: v.id, version: v.version, created_by: v.created_by, created_at: v.created_at, name: s.name, steps: s.steps?.length || 0, fields: s.fields?.length || 0 }; }) });
});

/** POST /definitions/:id/versions/:vid/restore — restores the setup of an older version (rows untouched) */
fmsRoutes.post("/definitions/:id/versions/:vid/restore", requireAdmin, async (c) => {
  const id = idParam(c);
  const v = await c.env.DB.prepare("SELECT snapshot FROM fms_versions WHERE id = ? AND fms_id = ?").bind(idParam(c, "vid"), id).first<{ snapshot: string }>();
  if (!v) fail(404, "Version not found");
  const snap = JSON.parse(v.snapshot);
  const current = await getDefinition(c.env, id);
  const input = toInput(snap, true);
  // keep ids only for steps that still exist, so rows stay attached
  const live = new Set(current!.steps.map((s) => s.id));
  input.steps = (input.steps || []).map((s) => ({ ...s, id: s.id && live.has(s.id) ? s.id : undefined }));
  input.code = current!.code;
  await saveDefinition(c.env, normaliseDefinition(input), actor(c).name, id);
  await audit(c.env, actor(c).employeeID, "restore_version", "fms", String(id), { version: snap.version });
  return c.json({ success: true, definition: await getDefinition(c.env, id) });
});

// ================================================================== import (auto-create from a sheet)
/** POST /import/analyze {grid: Cell[][], name} → proposed FMS + parsed rows */
fmsRoutes.post("/import/analyze", requireAdmin, async (c) => {
  const b = await jsonBody(c.req);
  if (!Array.isArray(b.grid) || !b.grid.length) fail(400, "Upload a sheet with data");
  const a = analyzeGrid(b.grid, { name: str(b.name) });
  const seats = (await c.env.DB.prepare("SELECT id, code, name FROM fms_seats").all<any>()).results;
  const byCode = new Map(seats.map((s) => [s.code.toLowerCase(), s]));
  const seatCodes = [...new Set((a.definition.steps as { seat_code?: string }[]).map((s) => s.seat_code).filter(Boolean) as string[])];
  return c.json({ success: true, ...a, seats: seatCodes.map((code) => ({ code, existing: byCode.get(code.toLowerCase()) || null })) });
});

/**
 * POST /import/commit {definition} — creates the FMS (and any missing seats from the sheet's WHO row).
 * Rows are then sent in chunks to POST /definitions/:id/records/import.
 */
fmsRoutes.post("/import/commit", requireAdmin, async (c) => {
  const body = await jsonBody<{ definition: Omit<DefinitionInput, "steps"> & { steps?: (StepInput & { seat_code?: string })[] } }>(c.req);
  const def = body.definition;
  if (!def) fail(400, "definition is required");
  const createdSeats: string[] = [];
  for (const s of def.steps || []) {
    const code = str(s.seat_code).trim();
    const hasWho = s.seat_id || s.assign?.departments?.length || s.assign?.designations?.length || s.assign?.employees?.length;
    if (hasWho || !code) continue;
    let seat = await c.env.DB.prepare("SELECT id FROM fms_seats WHERE code = ?").bind(code).first<{ id: number }>();
    if (!seat) {
      seat = await c.env.DB.prepare("INSERT INTO fms_seats (code, name, description) VALUES (?, ?, 'Created by FMS import — add members in Seating') RETURNING id").bind(code, code).first<{ id: number }>();
      createdSeats.push(code);
      await audit(c.env, actor(c).employeeID, "create", "fms_seat", String(seat!.id), { code, via: "import" });
    }
    s.seat_id = seat!.id;
  }
  const n = normaliseDefinition(def);
  const id = await saveDefinition(c.env, n, actor(c).name);
  await audit(c.env, actor(c).employeeID, "import_create", "fms", String(id), { name: n.def.name, seats: createdSeats });
  return c.json({ success: true, id, createdSeats, definition: await getDefinition(c.env, id) }, 201);
});

// ================================================================== records
const recordOut = (r: any, steps: RecordStepRow[]) => ({
  id: r.id, uid: r.uid, status: r.status, priority: r.priority, current_step: r.current_step, start_at: r.start_at, created_at: r.created_at,
  updated_at: r.updated_at, created_by: r.created_by, created_by_name: r.created_by_name, completed_at: r.completed_at, deleted: !!r.deleted,
  data: j(r.data, {}),
  steps: steps.map((s) => ({
    id: s.id, step_id: s.step_id, position: s.position, status: s.status, outcome: s.outcome, planned_at: s.planned_at, actual_at: s.actual_at,
    assigned_to: s.assigned_to, done_by: s.done_by, done_by_name: s.done_by_name, delay_minutes: s.delay_minutes, values: j(s.step_values, {}),
    remarks: s.remarks, submitted_at: s.submitted_at, approved_by: s.approved_by, approved_at: s.approved_at, rejection_reason: s.rejection_reason,
  })),
});

async function stepsFor(c: Context<AppEnv>, ids: number[]) {
  const map = new Map<number, RecordStepRow[]>();
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    if (!chunk.length) continue;
    const { results } = await c.env.DB.prepare(`SELECT * FROM fms_record_steps WHERE record_id IN (${chunk.map(() => "?").join(",")}) ORDER BY position`).bind(...chunk).all<RecordStepRow>();
    for (const s of results) { if (!map.has(s.record_id)) map.set(s.record_id, []); map.get(s.record_id)!.push(s); }
  }
  return map;
}

/** Shared filter builder for list + export. Filters: search, status, step, overdue, from, to, doer, f.<key>=value, deleted */
function recordFilter(c: Context<AppEnv>, b: Bundle) {
  const where = ["r.fms_id = ?"];
  const args: unknown[] = [b.def.id];
  where.push(c.req.query("deleted") === "1" && isAdmin(c) ? "r.deleted = 1" : "r.deleted = 0");
  const q = str(c.req.query("search")).trim();
  if (q) { where.push("(r.uid LIKE ? OR r.data LIKE ? OR EXISTS (SELECT 1 FROM fms_record_steps x WHERE x.record_id = r.id AND (x.step_values LIKE ? OR x.remarks LIKE ? OR x.done_by_name LIKE ?)))"); args.push(...Array(5).fill(`%${q}%`)); }
  const status = c.req.query("status");
  if (status && ["open", "completed", "cancelled"].includes(status)) { where.push("r.status = ?"); args.push(status); }
  const step = Number(c.req.query("step"));
  if (step) { where.push("r.current_step = ? AND r.status = 'open'"); args.push(step); }
  if (c.req.query("overdue") === "1") { where.push("EXISTS (SELECT 1 FROM fms_record_steps x WHERE x.record_id = r.id AND x.status IN ('pending','in_progress','rejected') AND x.planned_at != '' AND x.planned_at < ?)"); args.push(nowIso()); }
  if (c.req.query("awaiting") === "1") { where.push("EXISTS (SELECT 1 FROM fms_record_steps x WHERE x.record_id = r.id AND x.status = 'submitted')"); }
  const from = c.req.query("from"), to = c.req.query("to");
  if (from) { where.push("COALESCE(NULLIF(r.start_at, ''), r.created_at) >= ?"); args.push(new Date(`${from}T00:00:00+05:30`).toISOString()); }
  if (to) { where.push("COALESCE(NULLIF(r.start_at, ''), r.created_at) <= ?"); args.push(new Date(`${to}T23:59:59+05:30`).toISOString()); }
  const doer = str(c.req.query("doer")).trim();
  if (doer) { where.push("EXISTS (SELECT 1 FROM fms_record_steps x WHERE x.record_id = r.id AND (x.done_by = ? OR x.assigned_to = ? OR x.done_by_name = ? COLLATE NOCASE))"); args.push(doer, doer, doer); }
  const keys = new Set(b.fields.map((f) => f.key));
  for (const [k, v] of Object.entries(c.req.queries())) {
    if (!k.startsWith("f.") || !keys.has(k.slice(2)) || !v[0]) continue;
    where.push(`CAST(json_extract(r.data, ?) AS TEXT) LIKE ?`);
    args.push(`$.${k.slice(2)}`, `%${v[0]}%`);
  }
  const sortKey = str(c.req.query("sort"));
  const dir = c.req.query("dir") === "asc" ? "ASC" : "DESC";
  let order = `r.id ${dir}`, orderArgs = 0;
  if (sortKey === "uid") order = `length(r.uid) ${dir}, r.uid ${dir}`;
  else if (sortKey === "start") order = `r.start_at ${dir}`;
  else if (sortKey === "updated") order = `r.updated_at ${dir}`;
  else if (keys.has(sortKey)) { order = `json_extract(r.data, ?) ${dir}`; args.push(`$.${sortKey}`); orderArgs = 1; }
  return { where: where.join(" AND "), args, order, orderArgs };
}

/** GET /definitions/:id/records — sheet-like grid with filters and pagination */
fmsRoutes.get("/definitions/:id/records", async (c) => {
  const b = await bundleOr404(c, idParam(c));
  mustView(c, b);
  const { limit, offset, page: p } = page(c, 500);
  const f = recordFilter(c, b);
  const countArgs = f.orderArgs ? f.args.slice(0, -1) : f.args;
  const [rows, total, counts] = await c.env.DB.batch([
    c.env.DB.prepare(`SELECT r.* FROM fms_records r WHERE ${f.where} ORDER BY ${f.order} LIMIT ? OFFSET ?`).bind(...f.args, limit, offset),
    c.env.DB.prepare(`SELECT COUNT(*) AS n FROM fms_records r WHERE ${f.where}`).bind(...countArgs),
    c.env.DB.prepare(`SELECT status, COUNT(*) AS n FROM fms_records WHERE fms_id = ? AND deleted = 0 GROUP BY status`).bind(b.def.id),
  ]);
  const list = rows.results as any[];
  const steps = await stepsFor(c, list.map((r) => r.id));
  return c.json({
    success: true, page: p, limit, total: (total.results[0] as any).n,
    counts: Object.fromEntries((counts.results as any[]).map((x) => [x.status, x.n])),
    items: list.map((r) => recordOut(r, steps.get(r.id) || [])),
  });
});

/** POST /definitions/:id/records — new row from the form (admins, or doers allowed to create) */
fmsRoutes.post("/definitions/:id/records", async (c) => {
  const b = await bundleOr404(c, idParam(c));
  if (!fmsVisible(b, actor(c)).create) fail(403, "You cannot add rows to this FMS");
  if (b.def.deleted || b.def.archived) fail(409, "This FMS is archived");
  if (b.def.status !== "active" && !isAdmin(c)) fail(409, "This FMS is inactive");
  const body = await jsonBody(c.req);
  const r = await createRecord(c.env, b, body.data || {}, actor(c));
  return c.json({ success: true, ...r }, 201);
});

/**
 * POST /definitions/:id/records/import {rows: RowInput[], mode, dedupe: {fields: string[], action: skip|update|create}, dryRun}
 * Bulk import with validation and duplicate detection. dryRun → report only.
 */
fmsRoutes.post("/definitions/:id/records/import", requireAdmin, async (c) => {
  const b = await bundleOr404(c, idParam(c));
  const body = await jsonBody<{ rows: RowInput[]; mode?: string; dedupe?: { fields?: string[]; action?: string }; dryRun?: boolean }>(c.req);
  if (!Array.isArray(body.rows)) fail(400, "rows must be a list");
  if (body.rows.length > 2000) fail(413, "Send at most 2000 rows per request");
  const mode = body.mode === "strict" ? "strict" : "lenient";
  const rowFields = b.fields.filter((f) => f.step_id == null);
  const dedupeFields = (body.dedupe?.fields || []).filter((k) => k === "uid" || rowFields.some((f) => f.key === k));
  const action = ["skip", "update", "create"].includes(str(body.dedupe?.action)) ? str(body.dedupe?.action) : "skip";

  const invalid: { row: number; errors: string[] }[] = [];
  body.rows.forEach((r, i) => { const { errors } = coerceValues(rowFields, r.data || {}, mode); if (errors.length) invalid.push({ row: i + 1, errors }); });

  // duplicate detection (against existing rows and inside the file)
  const keyOf = (uid: string, data: Record<string, unknown>) => dedupeFields.map((k) => (k === "uid" ? uid : str(Array.isArray(data[k]) ? (data[k] as unknown[]).join(",") : data[k]))).map((x) => x.trim().toLowerCase()).join("|");
  const existing = new Map<string, { id: number; uid: string }>();
  if (dedupeFields.length) {
    let last = 0;
    for (;;) {
      const { results } = await c.env.DB.prepare("SELECT id, uid, data FROM fms_records WHERE fms_id = ? AND deleted = 0 AND id > ? ORDER BY id LIMIT 2000").bind(b.def.id, last).all<any>();
      if (!results.length) break;
      for (const r of results) {
        const data = j<Record<string, unknown>>(r.data, {});
        const { values } = coerceValues(rowFields, data, "lenient");
        const k = keyOf(r.uid, values);
        if (k.replace(/\|/g, "")) existing.set(k, { id: r.id, uid: r.uid });
      }
      last = results[results.length - 1].id;
      if (results.length < 2000) break;
    }
  }
  const duplicates: { row: number; key: string; existing_uid: string; in_file: boolean }[] = [];
  const toCreate: RowInput[] = [], toUpdate: { id: number; data: Record<string, unknown> }[] = [];
  const createIdx: number[] = [];
  const seen = new Map<string, number>();
  const bad = new Set(invalid.map((x) => x.row));
  body.rows.forEach((r, i) => {
    if (bad.has(i + 1)) return;
    if (dedupeFields.length) {
      const { values } = coerceValues(rowFields, r.data || {}, "lenient");
      const k = keyOf(str(r.uid), values);
      if (k.replace(/\|/g, "")) {
        const ex = existing.get(k);
        const inFile = seen.has(k);
        if (ex || inFile) {
          duplicates.push({ row: i + 1, key: k, existing_uid: ex?.uid || "", in_file: !ex && inFile });
          if (action === "skip" || (inFile && !ex && action !== "create")) return;
          if (action === "update" && ex) { toUpdate.push({ id: ex.id, data: r.data || {} }); return; }
        }
        seen.set(k, i + 1);
      }
    }
    toCreate.push(r); createIdx.push(i + 1);
  });
  const report = { total: body.rows.length, valid: body.rows.length - invalid.length, invalid, duplicates, toCreate: toCreate.length, toUpdate: toUpdate.length };
  if (body.dryRun) return c.json({ success: true, dryRun: true, ...report });

  const res = await createRecordsBulk(c.env, b, toCreate, actor(c), mode);
  const created = res.created.map((x) => ({ row: createIdx[x.row - 1], uid: x.uid }));
  const updStmts: D1PreparedStatement[] = [];
  for (const u of toUpdate) {
    const cur = await c.env.DB.prepare("SELECT data FROM fms_records WHERE id = ?").bind(u.id).first<{ data: string }>();
    const { values } = coerceValues(rowFields, u.data, "lenient");
    updStmts.push(c.env.DB.prepare("UPDATE fms_records SET data = ?, updated_at = ? WHERE id = ?").bind(JSON.stringify({ ...j(cur?.data, {}), ...values }), nowIso(), u.id));
  }
  for (let i = 0; i < updStmts.length; i += 100) await c.env.DB.batch(updStmts.slice(i, i + 100));
  await audit(c.env, actor(c).employeeID, "import_rows", "fms", String(b.def.id), { created: created.length, updated: toUpdate.length, failed: invalid.length + res.failed.length, duplicates: duplicates.length });
  return c.json({ success: true, ...report, created, updated: toUpdate.length, failed: [...invalid, ...res.failed.map((x) => ({ ...x, row: createIdx[x.row - 1] }))] });
});

/** GET /definitions/:id/records/export — flattened rows (same filters as the grid) for CSV / Excel / PDF */
fmsRoutes.get("/definitions/:id/records/export", async (c) => {
  const b = await bundleOr404(c, idParam(c));
  mustView(c, b);
  const f = recordFilter(c, b);
  const { results } = await c.env.DB.prepare(`SELECT r.* FROM fms_records r WHERE ${f.where} ORDER BY ${f.order} LIMIT 20000`).bind(...f.args).all<any>();
  const steps = await stepsFor(c, results.map((r) => r.id));
  const rowFields = b.fields.filter((x) => x.step_id == null);
  const columns: { key: string; label: string }[] = [{ key: "uid", label: "UID" }, ...rowFields.map((x) => ({ key: x.key, label: x.label })), { key: "_status", label: "Row Status" }];
  for (const s of b.steps) {
    const p = s.code || `STEP-${s.position}`;
    columns.push({ key: `${s.id}.planned`, label: `${p} Planned` }, { key: `${s.id}.actual`, label: `${p} Actual` }, { key: `${s.id}.status`, label: `${p} Status` },
      { key: `${s.id}.delay`, label: `${p} Delay (h)` }, { key: `${s.id}.doer`, label: `${p} Done By` });
    for (const sf of b.fields.filter((x) => x.step_id === s.id)) columns.push({ key: `${s.id}.v.${sf.key}`, label: `${p} ${sf.label}` });
    columns.push({ key: `${s.id}.remarks`, label: `${p} Remarks` });
  }
  const fmt = (type: string, v: unknown) => {
    if (Array.isArray(v)) return v.join(", ");
    if (type === "datetime" && typeof v === "string" && /T/.test(v)) return formatIST(v);
    if (type === "date" && typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) return `${v.slice(8, 10)}/${v.slice(5, 7)}/${v.slice(0, 4)}`;
    return v ?? "";
  };
  const rows = results.map((r) => {
    const data = j<Record<string, unknown>>(r.data, {});
    const o: Record<string, unknown> = { uid: r.uid, _status: r.status };
    for (const x of rowFields) o[x.key] = fmt(x.type, data[x.key]);
    for (const rs of steps.get(r.id) || []) {
      const vals = j<Record<string, unknown>>(rs.step_values, {});
      o[`${rs.step_id}.planned`] = formatIST(rs.planned_at); o[`${rs.step_id}.actual`] = formatIST(rs.actual_at);
      o[`${rs.step_id}.status`] = rs.status === "done" ? rs.outcome || "Done" : rs.status;
      o[`${rs.step_id}.delay`] = rs.delay_minutes ? Math.round(rs.delay_minutes / 6) / 10 : "";
      o[`${rs.step_id}.doer`] = rs.done_by_name; o[`${rs.step_id}.remarks`] = rs.remarks;
      for (const sf of b.fields.filter((x) => x.step_id === rs.step_id)) o[`${rs.step_id}.v.${sf.key}`] = fmt(sf.type, vals[sf.key]);
    }
    return o;
  });
  await audit(c.env, actor(c).employeeID, "export", "fms", String(b.def.id), { rows: rows.length });
  return c.json({ success: true, name: b.def.name, code: b.def.code, columns, rows });
});

/** GET /definitions/:id/duplicates?fields=a,b — groups of rows sharing the same values */
fmsRoutes.get("/definitions/:id/duplicates", requireAdmin, async (c) => {
  const b = await bundleOr404(c, idParam(c));
  const rowFields = b.fields.filter((f) => f.step_id == null);
  const fields = str(c.req.query("fields")).split(",").map((s) => s.trim()).filter((k) => k === "uid" || rowFields.some((f) => f.key === k));
  if (!fields.length) fail(400, "Choose at least one column to compare");
  const groups = new Map<string, any[]>();
  let last = 0;
  for (;;) {
    const { results } = await c.env.DB.prepare("SELECT id, uid, data, status, created_at, created_by_name FROM fms_records WHERE fms_id = ? AND deleted = 0 AND id > ? ORDER BY id LIMIT 2000").bind(b.def.id, last).all<any>();
    for (const r of results) {
      const data = j<Record<string, unknown>>(r.data, {});
      const key = fields.map((k) => str(k === "uid" ? r.uid : Array.isArray(data[k]) ? (data[k] as unknown[]).join(",") : data[k]).trim().toLowerCase()).join(" | ");
      if (!key.replace(/[\s|]/g, "")) continue;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push({ id: r.id, uid: r.uid, status: r.status, created_at: r.created_at, created_by_name: r.created_by_name, data });
    }
    if (results.length < 2000) break;
    last = results[results.length - 1].id;
  }
  const dupes = [...groups.entries()].filter(([, v]) => v.length > 1).map(([key, records]) => ({ key, count: records.length, records }));
  return c.json({ success: true, fields, groups: dupes.slice(0, 500), totalGroups: dupes.length, totalRows: dupes.reduce((n, g) => n + g.count, 0) });
});

/** POST /definitions/:id/records/bulk {ids, action: delete|restore|cancel|reopen_row|priority, value} */
fmsRoutes.post("/definitions/:id/records/bulk", requireAdmin, async (c) => {
  const b = await bundleOr404(c, idParam(c));
  const body = await jsonBody(c.req);
  const ids = (Array.isArray(body.ids) ? body.ids : []).map(Number).filter((n: number) => Number.isInteger(n) && n > 0);
  if (!ids.length) fail(400, "Select at least one row");
  if (ids.length > 2000) fail(413, "At most 2000 rows at a time");
  const t = nowIso();
  const sql: Record<string, [string, unknown[]]> = {
    delete: ["deleted = 1", []], restore: ["deleted = 0", []],
    cancel: ["status = 'cancelled'", []],
    reactivate: ["status = CASE WHEN current_step > 0 THEN 'open' ELSE status END", []],
    priority: ["priority = ?", [body.value]],
  };
  if (body.action === "priority" && !["Low", "Medium", "High", "Critical"].includes(body.value)) fail(400, "Invalid priority");
  const op = sql[str(body.action)];
  if (!op) fail(400, "Unknown bulk action");
  let changed = 0;
  for (let i = 0; i < ids.length; i += 80) {
    const chunk = ids.slice(i, i + 80);
    const r = await c.env.DB.prepare(`UPDATE fms_records SET ${op[0]}, updated_at = ? WHERE fms_id = ? AND id IN (${chunk.map(() => "?").join(",")}) RETURNING id`)
      .bind(...op[1], t, b.def.id, ...chunk).all();
    changed += r.results.length;
    await c.env.DB.batch(r.results.map((x: any) => c.env.DB.prepare("INSERT INTO fms_step_history (record_id, action, actor, actor_name, remarks) VALUES (?, ?, ?, ?, ?)")
      .bind(x.id, `row_${body.action}`, actor(c).employeeID, actor(c).name, str(body.value))));
  }
  await audit(c.env, actor(c).employeeID, `bulk_${body.action}`, "fms", String(b.def.id), { count: changed });
  return c.json({ success: true, changed });
});

/** GET /records/:rid — full row: data, steps, history, comments, attachments, what the user may do */
fmsRoutes.get("/records/:rid", async (c) => {
  const rid = idParam(c, "rid");
  const rec = await c.env.DB.prepare("SELECT * FROM fms_records WHERE id = ?").bind(rid).first<any>();
  if (!rec || (rec.deleted && !isAdmin(c))) fail(404, "Row not found");
  const b = await bundleOr404(c, rec.fms_id);
  const u = actor(c);
  const steps = (await stepsFor(c, [rid])).get(rid) || [];
  const canAct = steps.some((s) => { const st = b.steps.find((x) => x.id === s.step_id); return st && canActOn(s, st, b.seats, u); });
  if (!fmsVisible(b, u).view && !canAct) fail(403, "You do not have access to this row");
  const [hist, com, att] = await c.env.DB.batch([
    c.env.DB.prepare("SELECT * FROM fms_step_history WHERE record_id = ? ORDER BY id DESC LIMIT 300").bind(rid),
    c.env.DB.prepare(`SELECT * FROM fms_comments WHERE record_id = ? ${isAdmin(c) ? "" : "AND internal = 0"} ORDER BY id`).bind(rid),
    c.env.DB.prepare("SELECT * FROM fms_attachments WHERE record_id = ? ORDER BY id").bind(rid),
  ]);
  const out = recordOut(rec, steps);
  return c.json({
    success: true,
    record: {
      ...out,
      steps: out.steps.map((s) => {
        const st = b.steps.find((x) => x.id === s.step_id)!;
        return { ...s, can_act: !!st && canActOn(s, st, b.seats, u), can_approve: !!st && !!st.requires_approval && s.status === "submitted" && canApprove(st, b.seats, u) };
      }),
    },
    history: (hist.results as any[]).map((h) => ({ ...h, detail: j(h.detail, {}) })),
    comments: com.results, attachments: att.results,
    fms: { id: b.def.id, fms_id: b.def.fms_id, code: b.def.code, name: b.def.name, instructions: b.def.instructions },
    // the setup needed to render the row and its step forms (doers may lack access to /definitions/:id)
    definition: await (async () => { const d = (await getDefinition(c.env, b.def.id))!; return { fields: d.fields, steps: d.steps, seats: [...b.seats.values()].map((s) => ({ id: s.id, code: s.code, name: s.name })) }; })(),
  });
});

/** PUT /records/:rid {data} — admin edits row data (partial) */
fmsRoutes.put("/records/:rid", requireAdmin, async (c) => {
  const rid = idParam(c, "rid");
  const rec = await c.env.DB.prepare("SELECT * FROM fms_records WHERE id = ?").bind(rid).first<any>();
  if (!rec) fail(404, "Row not found");
  const b = await bundleOr404(c, rec.fms_id);
  const body = await jsonBody(c.req);
  const { values, errors } = coerceValues(b.fields.filter((f) => f.step_id == null), body.data || {}, "partial");
  if (errors.length) fail(400, errors[0], { errors });
  const before = j<Record<string, unknown>>(rec.data, {});
  const merged = { ...before, ...values };
  const sets = ["data = ?", "updated_at = ?"], args: unknown[] = [JSON.stringify(merged), nowIso()];
  if (body.priority && ["Low", "Medium", "High", "Critical"].includes(body.priority)) { sets.push("priority = ?"); args.push(body.priority); }
  await c.env.DB.prepare(`UPDATE fms_records SET ${sets.join(", ")} WHERE id = ?`).bind(...args, rid).run();
  const changed = Object.keys(values).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(values[k]));
  await history(c.env, rid, null, "row_edited", actor(c), str(body.reason), { changed: Object.fromEntries(changed.map((k) => [k, { from: before[k] ?? "", to: values[k] }])) });
  return c.json({ success: true, data: merged });
});

/** DELETE /records/:rid — soft delete (bulk restore brings it back) */
fmsRoutes.delete("/records/:rid", requireAdmin, async (c) => {
  const rid = idParam(c, "rid");
  const r = await c.env.DB.prepare("UPDATE fms_records SET deleted = 1, updated_at = ? WHERE id = ? RETURNING id").bind(nowIso(), rid).first();
  if (!r) fail(404, "Row not found");
  await history(c.env, rid, null, "row_deleted", actor(c));
  return c.json({ success: true });
});

fmsRoutes.route("/", fmsWorkRoutes);
fmsRoutes.route("/", fmsAdminRoutes);

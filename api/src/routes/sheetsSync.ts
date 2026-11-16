import { Hono } from "hono";
import type { AppEnv } from "../types";
import { requireAdmin, requireAuth } from "../middleware/auth";
import { backfillQueue, pullEmSheet, runSheetsSync, syncStatus } from "../lib/sheetsSync";
import { runSheetsPull } from "../lib/sheetsPull";
import { fail, jsonBody } from "../lib/util";
import { audit } from "../lib/audit";

// Admin controls for the Google Sheets backup sync (all admin-only).
export const sheetsSyncRoutes = new Hono<AppEnv>();
sheetsSyncRoutes.use("*", requireAuth, requireAdmin);

/** GET /api/sheets-sync/status — enabled?, pending changes per table, last result per sheet */
sheetsSyncRoutes.get("/status", async (c) => c.json({ ok: true, ...(await syncStatus(c.env)) }));

/** POST /api/sheets-sync/run — push pending changes now (works even while scheduled sync is disabled) */
sheetsSyncRoutes.post("/run", async (c) => {
  const r = await runSheetsSync(c.env, { force: true });
  await audit(c.env, c.get("user").employeeID, "run", "sheets_sync", "", r);
  return c.json({ ok: true, ...r });
});

/** POST /api/sheets-sync/clear-queue — drop pending changes (e.g. after a bulk re-import) */
sheetsSyncRoutes.post("/clear-queue", async (c) => {
  const r = await c.env.DB.prepare("DELETE FROM sheet_sync_queue").run();
  await audit(c.env, c.get("user").employeeID, "clear-queue", "sheets_sync", "", { removed: r.meta.changes });
  return c.json({ ok: true, removed: r.meta.changes });
});

/** POST /api/sheets-sync/sync-now — the "Sync Now" button: Sheets → DB, then DB → Sheets */
sheetsSyncRoutes.post("/sync-now", async (c) => {
  const started = Date.now();
  const pull = await runSheetsPull(c.env, { force: true });
  const push = await runSheetsSync(c.env, { force: true });
  await audit(c.env, c.get("user").employeeID, "sync-now", "sheets_sync", "", { pull, push });
  return c.json({ ok: true, ms: Date.now() - started, pull, push, status: await syncStatus(c.env) });
});

/** POST /api/sheets-sync/pull { full? } — copy edits made in the sheets into D1 now */
sheetsSyncRoutes.post("/pull", async (c) => {
  const { full } = await jsonBody(c.req);
  const r = await runSheetsPull(c.env, { force: true, full: full === true });
  await audit(c.env, c.get("user").employeeID, "pull", "sheets_sync", "", r);
  return c.json({ ok: true, results: r });
});

/** POST /api/sheets-sync/backfill { since: ISO time } — re-queue rows changed since then */
sheetsSyncRoutes.post("/backfill", async (c) => {
  const { since } = await jsonBody(c.req);
  if (!since || isNaN(Date.parse(String(since)))) fail(400, "since (ISO date-time) is required");
  const queued = await backfillQueue(c.env, new Date(String(since)).toISOString());
  await audit(c.env, c.get("user").employeeID, "backfill", "sheets_sync", "", { since, queued });
  return c.json({ ok: true, queued });
});

/** POST /api/sheets-sync/pull-em-sheet — refresh the EM report from Google Sheets now */
sheetsSyncRoutes.post("/pull-em-sheet", async (c) => c.json({ ok: true, ...(await pullEmSheet(c.env)) }));

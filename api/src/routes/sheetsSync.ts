import { Hono } from "hono";
import type { AppEnv } from "../types";
import { requireAdmin, requireAuth } from "../middleware/auth";
import { pullEmSheet, runSheetsSync, syncStatus } from "../lib/sheetsSync";
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

/** POST /api/sheets-sync/pull-em-sheet — refresh the EM report from Google Sheets now */
sheetsSyncRoutes.post("/pull-em-sheet", async (c) => c.json({ ok: true, ...(await pullEmSheet(c.env)) }));

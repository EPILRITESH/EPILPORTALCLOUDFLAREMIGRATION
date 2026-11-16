import { Hono } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { HTTPException } from "hono/http-exception";
import type { AppEnv, Env } from "./types";
import { authRoutes, adminAuthRoutes } from "./routes/auth";
import { employeeRoutes } from "./routes/employee";
import { delegationRoutes } from "./routes/delegations";
import { checklistRoutes } from "./routes/checklist";
import { helpTicketRoutes } from "./routes/helpTickets";
import { supportTicketRoutes } from "./routes/supportTickets";
import { dashboardRoutes } from "./routes/dashboard";
import { worklistRoutes } from "./routes/worklist";
import { trainingRoutes } from "./routes/training";
import { featureRoutes, emSheetRoutes, whatsappRoutes } from "./routes/misc";
import { serveFile } from "./lib/files";
import { requireAdmin, requireAuth } from "./middleware/auth";
import { runMonthlyGeneration } from "./lib/checklistGen";
import { sheetsSyncRoutes } from "./routes/sheetsSync";
import { pullEmSheet, runSheetsSync, syncEnabled } from "./lib/sheetsSync";
import { pullEnabled, runSheetsPull } from "./lib/sheetsPull";

/**
 * Express matched routes case-insensitively and ignored trailing slashes, and
 * the frontends rely on that (e.g. "/additionalFeature/all", "/delegations/").
 * We lowercase only the module segment (/api/<module>) — IDs stay untouched.
 */
function getPath(req: Request): string {
  const url = new URL(req.url);
  let p = url.pathname.replace(/^\/api\/([^/]+)/, (_m, mod: string) => `/api/${mod.toLowerCase()}`);
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  return p;
}

const app = new Hono<AppEnv>({ getPath });

app.use("*", secureHeaders({ crossOriginResourcePolicy: "cross-origin" }));
app.use("*", async (c, next) => {
  const allowed = (c.env.CORS_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  return cors({
    origin: (origin) => (allowed.includes("*") || allowed.includes(origin) ? origin : null),
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization", "X-Admin-Registration-Key"],
    maxAge: 86400,
  })(c, next);
});

// Real-time backup: after any successful write, push the queued changes to Google Sheets
// in the background (the response is not delayed). The every-minute cron is the safety net.
app.use("/api/*", async (c, next) => {
  await next();
  if (c.req.method !== "GET" && c.req.method !== "OPTIONS" && c.res.status < 400 && syncEnabled(c.env)) {
    c.executionCtx.waitUntil(runSheetsSync(c.env).catch((e) => console.error("sheets sync", e.message)));
  }
});

app.get("/health", async (c) => {
  const now = new Date();
  const period = `${now.getMonth() + 1}-${now.getFullYear()}`;
  const db = await c.env.DB.prepare("SELECT 1 AS ok").first<{ ok: number }>().catch(() => null);
  const gen = await c.env.DB.prepare("SELECT 1 FROM job_runs WHERE job='checklist-next-month' AND period=?").bind(period).first().catch(() => null);
  return c.json({ status: db ? "ok" : "degraded", time: now.toISOString(), db: !!db, generated: gen ? "yes" : "no", month: now.getMonth() + 1, year: now.getFullYear() });
});

app.post("/admin/generate-now", requireAuth, requireAdmin, async (c) => c.json({ success: true, ...(await runMonthlyGeneration(c.env)) }));

app.get("/files/*", serveFile);

app.route("/api/auth", authRoutes);
app.route("/api/adminauth", adminAuthRoutes);
app.route("/api/additionalfeature", featureRoutes);
app.route("/api/delegations", delegationRoutes);
app.route("/api/support-tickets", supportTicketRoutes);
app.route("/api/checklist", checklistRoutes);
app.route("/api/employee", employeeRoutes);
app.route("/api/helptickets", helpTicketRoutes);
app.route("/api/alldashboard", dashboardRoutes);
app.route("/api/whatsapp", whatsappRoutes);
app.route("/api/worklist", worklistRoutes);
app.route("/api/training", trainingRoutes);
app.route("/api/em-sheet", emSheetRoutes);
app.route("/api/sheets-sync", sheetsSyncRoutes);

app.notFound((c) => c.json({ success: false, error: `Cannot ${c.req.method} ${c.req.path}` }, 404));

app.onError((err, c) => {
  if (err instanceof HTTPException) return err.getResponse();
  console.error(`[${new Date().toISOString()}] ${c.req.method} ${c.req.path}:`, err);
  return c.json({ success: false, error: "Internal server error" }, 500);
});

export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext) {
    if (event.cron === "0 * * * *") {
      ctx.waitUntil(runMonthlyGeneration(env).then((r) => console.log("checklist generation", JSON.stringify({ ...r, createdTasks: undefined, count: "createdTasks" in r ? r.createdTasks.length : 0 }))));
      return;
    }
    // every minute: Google Sheets backup; every 10 minutes: refresh the EM report from Sheets
    if (syncEnabled(env)) ctx.waitUntil(runSheetsSync(env).then((r) => { if (!("skipped" in r) && r.processed) console.log("sheets sync", JSON.stringify(r)); }));
    const minute = new Date(event.scheduledTime).getUTCMinutes();
    if (minute % 10 === 0) ctx.waitUntil(pullEmSheet(env).catch((e) => console.error("em pull", e.message)));
    // transition: copy old-portal changes from the sheets into D1 every 5 minutes
    if (minute % 5 === 2 && pullEnabled(env)) ctx.waitUntil(runSheetsPull(env).then((r) => console.log("sheets pull", JSON.stringify(r))).catch((e) => console.error("sheets pull", e.message)));
  },
} satisfies ExportedHandler<Env>;

export { app };

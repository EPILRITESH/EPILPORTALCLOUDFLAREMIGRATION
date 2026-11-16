import { Hono } from "hono";
import type { AppEnv, Env } from "../types";
import { requireAdmin, requireAuth } from "../middleware/auth";
import { fail, jsonBody, NAME_SQL, normName, str } from "../lib/util";
import { audit } from "../lib/audit";

// ---------------------------------------------------------------------
// Additional features — legacy routes/additionalFeature.js
// ---------------------------------------------------------------------
export const featureRoutes = new Hono<AppEnv>();
featureRoutes.use("*", requireAuth);

featureRoutes.post("/add", async (c) => {
  const { featureName, featureURL } = await jsonBody(c.req);
  if (!featureName || !featureURL) fail(400, "Feature name and URL are required");
  if (!/^https?:\/\//i.test(String(featureURL))) fail(400, "Feature URL must start with http:// or https://");
  await c.env.DB.prepare("INSERT INTO additional_features (added_by, feature_name, feature_url) VALUES (?, ?, ?)")
    .bind(c.get("user").name, String(featureName), String(featureURL)).run();
  return c.json({ message: "Feature added successfully" });
});

featureRoutes.get("/all", async (c) => {
  const { results } = await c.env.DB.prepare(`SELECT * FROM additional_features WHERE ${NAME_SQL("added_by")} = ? ORDER BY id`)
    .bind(normName(c.get("user").name)).all<any>();
  return c.json(results.map((r) => ({ AddedBy: r.added_by, FeatureName: r.feature_name, FeatureURL: r.feature_url, CreatedAt: r.created_at })));
});

// ---------------------------------------------------------------------
// EM sheet — legacy routes/emSheet.js (raw grid kept in em_sheet_rows)
// ---------------------------------------------------------------------
export const emSheetRoutes = new Hono<AppEnv>();
emSheetRoutes.use("*", requireAuth, requireAdmin);

emSheetRoutes.get("/em-sheet", async (c) => {
  const { results } = await c.env.DB.prepare("SELECT cells FROM em_sheet_rows ORDER BY row_index").all<{ cells: string }>();
  const rows: string[][] = results.map((r) => { try { return JSON.parse(r.cells); } catch { return []; } });
  if (!rows.length) fail(404, "No data found in the sheet");
  const result = { weekInfo: rows[0] as unknown, employees: [] as any[], footer: [] as any[] };
  const data = rows.slice(1);
  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    if (!row || !row.length) continue;
    const doer = str(row[1]).trim();
    if (doer.includes("WEEK NO.")) { result.weekInfo = doer; continue; }
    if (doer.includes("TOTAL DOER")) {
      for (let j = i; j < Math.min(i + 6, data.length); j++) {
        const f = data[j];
        if (f && f.length > 1 && str(f[1]).trim()) result.footer.push({ label: str(f[1]).trim(), value: str(f[2]).trim() });
      }
      break;
    }
    if (!doer) continue;
    result.employees.push({
      no: parseInt(row[0]) || result.employees.length + 1,
      doerName: doer,
      withoutDelegation: { totalTask: parseInt(row[2]) || 0, pendingTask: parseInt(row[3]) || 0, percent: row[4] || "0.00%", emRepetition: row[5] || "", nextTarget: row[6] || "" },
      delegation: { totalTask: parseInt(row[7]) || 0, pendingTask: parseInt(row[8]) || 0, percent: row[9] || "0.00%", emRepetition: row[10] || "", nextTarget: row[11] || "" },
      emDoer: row[12] || "NO",
    });
  }
  return c.json({ success: true, data: result, totalEmployees: result.employees.length });
});

/** PUT /api/em-sheet/em-sheet { rows: string[][] } — replace the grid (new: was edited in Google Sheets). */
emSheetRoutes.put("/em-sheet", async (c) => {
  const { rows } = await jsonBody(c.req);
  if (!Array.isArray(rows) || !rows.length) fail(400, "rows (2-D array, first row = header) is required");
  const stmts = [c.env.DB.prepare("DELETE FROM em_sheet_rows"),
    ...rows.slice(0, 1000).map((r: unknown[], i: number) =>
      c.env.DB.prepare("INSERT INTO em_sheet_rows (row_index, cells) VALUES (?, ?)").bind(i, JSON.stringify((Array.isArray(r) ? r : []).slice(0, 13).map(str))))];
  for (let i = 0; i < stmts.length; i += 100) await c.env.DB.batch(stmts.slice(i, i + 100));
  await audit(c.env, c.get("user").employeeID, "replace", "em_sheet", "", { rows: rows.length });
  return c.json({ ok: true, rows: Math.min(rows.length, 1000) });
});

// ---------------------------------------------------------------------
// WhatsApp — legacy routes/whatsapp.js + the bulk "workreport" that the admin
// dashboard used to send DIRECTLY from the browser with an exposed token.
// ---------------------------------------------------------------------
export const whatsappRoutes = new Hono<AppEnv>();
whatsappRoutes.use("*", requireAuth, requireAdmin);

async function sendTemplate(env: Env, to: string, template: string, params: string[]) {
  if (!env.META_WA_TOKEN || !env.META_WA_PHONE_ID) fail(503, "WhatsApp is not configured (META_WA_TOKEN / META_WA_PHONE_ID)");
  const res = await fetch(`https://graph.facebook.com/${env.WHATSAPP_API_VERSION || "v21.0"}/${env.META_WA_PHONE_ID}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.META_WA_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp", to, type: "template",
      template: { name: template, language: { code: "en" }, components: [{ type: "body", parameters: params.map((text) => ({ type: "text", text })) }] },
    }),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, data };
}

const normalizePhone = (n: unknown) => {
  const d = str(n).replace(/\D/g, "");
  return d.length === 10 ? `91${d}` : d;
};

function listMessage(items: string[]) {
  let s = items.map((t, i) => `${i + 1}️⃣ ${t}`).join("\n");
  if (s.length > 1000) s = `${s.slice(0, 1000)}...`;
  return s;
}

whatsappRoutes.post("/send-checklist", async (c) => {
  const { number, employeeName, tasks } = await jsonBody(c.req);
  if (!number || !employeeName || !Array.isArray(tasks)) return c.json({ success: false, message: "Missing fields or tasks must be array" }, 400);
  const r = await sendTemplate(c.env, normalizePhone(number), c.env.WHATSAPP_TEMPLATE_PENDING, [String(employeeName), String(tasks.length), listMessage(tasks)]);
  return r.ok ? c.json({ success: true, message: "WhatsApp checklist sent ✅", data: r.data })
    : c.json({ success: false, message: "WhatsApp checklist send failed", error: r.data }, 500);
});

whatsappRoutes.post("/send-delegation", async (c) => {
  const { number, employeeName, delegations } = await jsonBody(c.req);
  if (!number || !employeeName || !Array.isArray(delegations)) return c.json({ success: false, message: "Missing fields or delegations must be array" }, 400);
  const r = await sendTemplate(c.env, normalizePhone(number), c.env.WHATSAPP_TEMPLATE_PENDING, [String(employeeName), String(delegations.length), listMessage(delegations)]);
  return r.ok ? c.json({ success: true, message: "WhatsApp delegation sent ✅", data: r.data })
    : c.json({ success: false, message: "WhatsApp delegation send failed", error: r.data }, 500);
});

/** POST /api/whatsapp/send-workreport { number, params: [6 strings] } — server-side replacement */
whatsappRoutes.post("/send-workreport", async (c) => {
  const { number, params } = await jsonBody(c.req);
  if (!number || !Array.isArray(params) || params.length !== 6) return c.json({ success: false, message: "number and 6 params are required" }, 400);
  const r = await sendTemplate(c.env, normalizePhone(number), c.env.WHATSAPP_TEMPLATE_WORKREPORT, params.map(String));
  return r.ok ? c.json({ success: true, data: r.data }) : c.json({ success: false, error: r.data }, 502);
});

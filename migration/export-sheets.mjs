#!/usr/bin/env node
// STEP 1 — Export every legacy Google Sheet tab to out/sheets/<key>.json (raw 2-D grid,
// row 1 = header) using the SAME service account the old backend used.
//
// Usage:
//   cp ../../EPILBACKEND/.env .env.migration   # or export the variables yourself
//   node --env-file=.env.migration export-sheets.mjs
//
// Alternative without credentials: download each tab as CSV from Google Sheets
// (File → Download → CSV) into out/csv/<key>.csv — transform.mjs reads those too.
import { mkdir, writeFile } from "node:fs/promises";
import { JWT } from "google-auth-library";
import { SOURCES } from "./sources.mjs";

const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
const key = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n");
if (!email || !key) {
  console.error("GOOGLE_SERVICE_ACCOUNT_EMAIL and GOOGLE_PRIVATE_KEY are required");
  process.exit(1);
}

const auth = new JWT({ email, key, scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"] });
await mkdir("out/sheets", { recursive: true });

const summary = [];
for (const src of SOURCES) {
  const id = process.env[src.env];
  if (!id) {
    summary.push({ key: src.key, status: src.optional ? "skipped (no id)" : "MISSING SPREADSHEET ID" });
    continue;
  }
  const range = encodeURIComponent(`${src.tab}!${src.range}`);
  // FORMATTED_VALUE = exactly the strings the legacy API read.
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${range}?valueRenderOption=FORMATTED_VALUE&majorDimension=ROWS`;
  try {
    const res = await auth.request({ url });
    const rows = res.data.values || [];
    await writeFile(`out/sheets/${src.key}.json`, JSON.stringify({ source: { tab: src.tab, env: src.env }, exportedAt: new Date().toISOString(), rows }, null, 0));
    summary.push({ key: src.key, status: "ok", rows: Math.max(0, rows.length - 1) });
  } catch (e) {
    const msg = e?.response?.data?.error?.message || e.message;
    summary.push({ key: src.key, status: src.optional ? `skipped (${msg})` : `ERROR: ${msg}` });
  }
}
console.table(summary);
await writeFile("out/export-summary.json", JSON.stringify(summary, null, 2));
if (summary.some((s) => /^(ERROR|MISSING)/.test(s.status))) process.exit(2);

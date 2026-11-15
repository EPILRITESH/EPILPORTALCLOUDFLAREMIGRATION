#!/usr/bin/env node
// STEP 4 — Compare row counts in D1 against out/report.json after applying seed.sql.
// Usage: node verify.mjs --remote | --local   (run from the repo root or migration/)
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const DIR = process.env.MIGRATION_DIR || "out";
const target = process.argv.includes("--local") ? "--local" : "--remote";
const extra = process.argv.filter((a) => a.startsWith("--persist-to="));
const report = JSON.parse(readFileSync(`${DIR}/report.json`, "utf8"));
const apiDir = path.resolve(import.meta.dirname, "../api");
const tables = Object.keys(report.counts);
const sqlText = tables.map((t) => `SELECT '${t}' AS t, COUNT(*) AS n FROM ${t};`).join(" ");
const out = execFileSync("npx", ["wrangler", "d1", "execute", "epil-db", target, ...extra, "--json", "--command", sqlText], { cwd: apiDir, encoding: "utf8" });
const rows = JSON.parse(out).flatMap((r) => r.results);
let ok = true;
const table = rows.map((r) => {
  const expected = report.counts[r.t];
  if (expected !== r.n) ok = false;
  return { table: r.t, expected, actual: r.n, status: expected === r.n ? "OK" : "MISMATCH" };
});
console.table(table);
console.log(ok ? "✅ All row counts match." : "❌ Row count mismatch — do not cut over.");
process.exit(ok ? 0 : 1);

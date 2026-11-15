import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { SOURCES } from "./sources.mjs";

/** Minimal RFC-4180 CSV parser (quoted fields, embedded commas/newlines). */
export function parseCsv(text) {
  const rows = [];
  let row = [], field = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') q = false;
      else field += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += ch;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  // trim trailing empty cells like the Sheets API does
  return rows.map((r) => { let n = r.length; while (n && r[n - 1] === "") n--; return r.slice(0, n); });
}

/** Load a source grid from out/sheets/<key>.json or out/csv/<key>.csv. Header row removed. */
export async function loadGrid(dir, key) {
  const json = `${dir}/sheets/${key}.json`;
  const csv = `${dir}/csv/${key}.csv`;
  let rows = null;
  if (existsSync(json)) rows = JSON.parse(await readFile(json, "utf8")).rows;
  else if (existsSync(csv)) rows = parseCsv(await readFile(csv, "utf8"));
  if (!rows) {
    const src = SOURCES.find((s) => s.key === key);
    if (src && !src.optional) throw new Error(`Missing export for "${key}" (${src.tab}). Run export-sheets.mjs or add out/csv/${key}.csv`);
    return { header: [], rows: [] };
  }
  return { header: rows[0] || [], rows: rows.slice(1).map((r) => r.map((c) => (c === null || c === undefined ? "" : String(c)))) };
}

/** SQL string literal. */
export const q = (v) => (v === null || v === undefined ? "NULL" : typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`);

export const cell = (r, i) => (r[i] === undefined || r[i] === null ? "" : String(r[i]));
export const trimmed = (r, i) => cell(r, i).trim();
export const isBlankRow = (r) => !r || r.every((c) => String(c ?? "").trim() === "");

export const URL_RE = /^https?:\/\//i;
export const isCloudinary = (u) => /^https?:\/\/res\.cloudinary\.com\//i.test(String(u || "").trim());

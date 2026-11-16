// Sheets → D1 pull (two-way sync, the "sheet side").
//
// Every minute each legacy tab is read and compared with D1; edits made in Google Sheets
// (by hand or by the old portal) are copied into D1 so the portal shows them.
//   - cheap: each tab is fingerprinted in 500-row blocks; only changed blocks are compared with D1
//   - portal wins: a record with a pending portal change (sheet_sync_queue) is never overwritten,
//     checked atomically in the UPDATE itself
//   - no deletes: rows missing from a sheet are reported, never deleted from D1
//   - passwords are never taken from a sheet
//   - the pull's own D1 writes are not echoed back to the sheet
import type { Env } from "../types";
import { a1Tab, batchGet, googleConfigured } from "./google";
import { HR_AT } from "./sheetsSync";
import { normName } from "./util";

type SheetEnv = "GOOGLE_SHEET_ID" | "GOOGLE_SHEET_ID_CHECKLIST" | "GOOGLE_SHEET_ID_DELEGATION" | "GOOGLE_SHEET_ID_HELPTICKET"
  | "GOOGLE_SHEET_ID_SUPPORTTICKET" | "GOOGLE_SHEET_ID_WORKLIST" | "GOOGLE_SHEET_ID_TRAINING";
type Rec = Record<string, string | number>;
const BLOCK = 500;
const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
const HAS_UPDATED_AT = new Set(["users", "delegations", "checklist_tasks", "help_tickets", "support_tickets", "worklists"]);

interface PullSpec {
  id: string;                  // tab name (status key)
  sheet: SheetEnv;
  lastCol: string;             // read A2:<lastCol>
  table: string;               // D1 table
  queueTable: string;          // sheet_sync_queue.tbl for "portal wins"
  where?: string;              // extra filter for this tab's D1 rows (e.g. role)
  keyCols: string[];           // D1 columns forming the key
  /** key columns holding PERSON NAMES — matched with normName (legacy "Mohammad Sami " vs "Mohammad Sami") */
  nameKeys?: string[];
  queueKey: (r: Rec) => string;
  fromRow: (row: string[]) => Rec | null;   // sheet row → D1 values (null = skip row)
  /** D1 columns this tab owns (compared + updated). Must include keyCols. */
  cols: string[];
  numeric?: string[];
  insertDefaults?: (r: Rec) => Rec | null;  // extra NOT NULL values for new rows; null = never insert
  validate?: (r: Rec, ctx: Ctx) => boolean;
}
interface Ctx { templates: Set<string> }

const cell = (row: string[], i: number) => String(row[i] ?? "");
const pick = (row: string[], map: Record<number, string>): Rec => Object.fromEntries(Object.entries(map).map(([i, c]) => [c, cell(row, +i)]));
const isHash = (s: string) => /^\$2[aby]\$\d\d\$/.test(s) || s.startsWith("pbkdf2$");

// ------------------------------------------------------------------ tab specs (inverse of SPECS)
const PULLS: PullSpec[] = [
  { id: "DelegationMaster", sheet: "GOOGLE_SHEET_ID_DELEGATION", lastCol: "N", table: "delegations", queueTable: "delegations",
    keyCols: ["task_id"], queueKey: (r) => String(r.task_id), numeric: ["revisions"],
    cols: ["task_id", "name", "task_name", "created_date", "deadline", "revision1", "revision2", "final_date", "revisions", "priority", "status", "followup", "done_week", "approval"],
    fromRow: (row) => pick(row, { 0: "task_id", 1: "name", 2: "task_name", 3: "created_date", 4: "deadline", 5: "revision1", 6: "revision2", 7: "final_date", 8: "revisions", 9: "priority", 10: "status", 11: "followup", 12: "done_week", 13: "approval" }),
    insertDefaults: () => ({}) },
  // Master!H (Actual) is a formula → completions come from Consolidated (pullCompletions)
  { id: "Master", sheet: "GOOGLE_SHEET_ID_CHECKLIST", lastCol: "K", table: "checklist_tasks", queueTable: "checklist_tasks",
    keyCols: ["task_id"], queueKey: (r) => String(r.task_id),
    cols: ["task_id", "name", "email", "department", "freq", "task", "planned", "source", "template_id", "archive"],
    fromRow: (row) => (cell(row, 0).trim() && cell(row, 5).trim() ? pick(row, { 0: "name", 1: "email", 2: "department", 3: "task_id", 4: "freq", 5: "task", 6: "planned", 8: "source", 9: "template_id", 10: "archive" }) : null),
    insertDefaults: () => ({}) },
  { id: "MasterTasks", sheet: "GOOGLE_SHEET_ID_CHECKLIST", lastCol: "I", table: "checklist_templates", queueTable: "checklist_templates",
    keyCols: ["template_id"], queueKey: (r) => String(r.template_id),
    cols: ["template_id", "name", "email", "department", "task", "freq", "day_or_date", "status"],
    fromRow: (row) => ({ ...pick(row, { 0: "template_id", 1: "name", 2: "email", 3: "department", 4: "task", 6: "day_or_date", 8: "status" }), freq: cell(row, 5).trim().toUpperCase().charAt(0) }),
    validate: (r) => ["D", "W", "M", "Y"].includes(String(r.freq)) && !!String(r.task).trim(), insertDefaults: () => ({}) },
  { id: "HelpTicketsMaster", sheet: "GOOGLE_SHEET_ID_HELPTICKET", lastCol: "H", table: "help_tickets", queueTable: "help_tickets",
    keyCols: ["ticket_id"], queueKey: (r) => String(r.ticket_id),
    cols: ["ticket_id", "created_by", "assigned_to", "issue", "status", "created_date", "done_date", "issue_photo"],
    fromRow: (row) => pick(row, { 0: "ticket_id", 1: "created_by", 2: "assigned_to", 3: "issue", 4: "status", 5: "created_date", 6: "done_date", 7: "issue_photo" }),
    insertDefaults: () => ({}) },
  { id: "SupportTicketsMaster", sheet: "GOOGLE_SHEET_ID_SUPPORTTICKET", lastCol: "O", table: "support_tickets", queueTable: "support_tickets",
    keyCols: ["ticket_id"], queueKey: (r) => String(r.ticket_id),
    cols: ["ticket_id", "created_by", "assigned_to", "issue", "status", "created_date", "done_date", "issue_photo", "work_by", "approval", "col_k", "problem", "solution", "department"],
    fromRow: (row) => pick(row, { 0: "ticket_id", 1: "created_by", 2: "assigned_to", 3: "issue", 4: "status", 5: "created_date", 6: "done_date", 7: "issue_photo", 8: "work_by", 9: "approval", 10: "col_k", 12: "problem", 13: "solution", 14: "department" }),
    insertDefaults: (r) => ({ group_key: `legacy:${String(r.issue).trim()}` }) },
  { id: "WorkList", sheet: "GOOGLE_SHEET_ID_WORKLIST", lastCol: "J", table: "worklists", queueTable: "worklists",
    keyCols: ["worklist_id"], queueKey: (r) => String(r.worklist_id),
    cols: ["worklist_id", "employee_name", "worklist_name", "frequency", "working_time", "template_link", "remark", "schedule_days", "schedule_dates", "ai_time"],
    fromRow: (row) => pick(row, { 0: "worklist_id", 1: "employee_name", 2: "worklist_name", 3: "frequency", 4: "working_time", 5: "template_link", 6: "remark", 7: "schedule_days", 8: "schedule_dates", 9: "ai_time" }),
    validate: (r) => ["Daily", "Weekly", "Monthly", "Yearly"].includes(String(r.frequency)), insertDefaults: () => ({}) },
  { id: "AQData", sheet: "GOOGLE_SHEET_ID_TRAINING", lastCol: "H", table: "training_questions", queueTable: "training_questions",
    keyCols: ["qa_id"], queueKey: (r) => String(r.qa_id),
    cols: ["qa_id", "template_id", "question", "option_a", "option_b", "option_c", "option_d", "correct_option"],
    fromRow: (row) => pick(row, { 0: "template_id", 1: "qa_id", 2: "question", 3: "option_a", 4: "option_b", 5: "option_c", 6: "option_d", 7: "correct_option" }),
    validate: (r, ctx) => ctx.templates.has(String(r.template_id)) && !!String(r.question).trim(), insertDefaults: () => ({}) },
  { id: "EmployeeTrainingData", sheet: "GOOGLE_SHEET_ID_TRAINING", lastCol: "P", table: "training_records", queueTable: "training_records",
    keyCols: ["employee_name", "template_id"], nameKeys: ["employee_name"], queueKey: (r) => `${r.employee_name}|||${r.template_id}`,
    numeric: ["document_score", "video_score", "qa_score", "total_score"],
    cols: ["employee_name", "template_id", "designation", "template_name", "document_score", "video_score", "qa_score", "total_score", "status", "start_date", "end_date", "last_update", "tools_documents", "tools_translite", "tools_summary", "progress"],
    fromRow: (row) => pick(row, { 0: "employee_name", 1: "designation", 2: "template_name", 3: "template_id", 4: "document_score", 5: "video_score", 6: "qa_score", 7: "total_score", 8: "status", 9: "start_date", 10: "end_date", 11: "last_update", 12: "tools_documents", 13: "tools_translite", 14: "tools_summary", 15: "progress" }),
    validate: (r) => { try { JSON.parse(String(r.progress || "{}")); return true; } catch { return false; } }, insertDefaults: () => ({}) },
  // Employee / Admin: profile fields only — never passwords; new people only with a valid hash
  { id: "Employee", sheet: "GOOGLE_SHEET_ID", lastCol: "BW", table: "users", queueTable: "users", where: "role = 'employee'",
    keyCols: ["employee_id"], queueKey: (r) => `employee:${r.employee_id}`,
    cols: ["employee_id", "name", "mobile", "department", "company_name", "date_of_birth", "joining_date", "profile_picture", "designation", "doer_name", "shift_start_time", "shift_end_time", "total_working_hours", "hr_details"],
    fromRow: (row) => {
      if (!cell(row, 0).trim() || !cell(row, 1).trim()) return null;
      const hr: Record<string, string> = {};
      for (const [i, k] of Object.entries(HR_AT)) if (cell(row, +i) !== "") hr[k] = cell(row, +i);
      return { ...pick(row, { 0: "employee_id", 1: "name", 2: "mobile", 4: "department", 6: "company_name", 7: "date_of_birth", 8: "joining_date", 9: "profile_picture", 10: "designation", 11: "doer_name", 17: "shift_start_time", 18: "shift_end_time", 19: "total_working_hours" }),
        hr_details: JSON.stringify(Object.fromEntries(Object.entries(hr).sort())), _hash: cell(row, 3) };
    },
    insertDefaults: (r) => (isHash(String(r._hash)) ? { role: "employee", password_hash: String(r._hash) } : null) },
  { id: "Admin", sheet: "GOOGLE_SHEET_ID", lastCol: "G", table: "users", queueTable: "users", where: "role = 'admin'",
    keyCols: ["employee_id"], queueKey: (r) => `admin:${r.employee_id}`,
    cols: ["employee_id", "name", "mobile", "department", "company_name"],
    fromRow: (row) => (cell(row, 0).trim() && cell(row, 1).trim() ? { ...pick(row, { 0: "employee_id", 1: "name", 2: "mobile", 4: "department", 6: "company_name" }), _hash: cell(row, 3) } : null),
    insertDefaults: (r) => (isHash(String(r._hash)) ? { role: "admin", password_hash: String(r._hash) } : null) },
  { id: "AdditionalFeature", sheet: "GOOGLE_SHEET_ID", lastCol: "C", table: "additional_features", queueTable: "additional_features",
    keyCols: ["added_by", "feature_name", "feature_url"], nameKeys: ["added_by"], queueKey: (r) => `${r.added_by}|||${r.feature_name}|||${r.feature_url}`,
    cols: ["added_by", "feature_name", "feature_url"],
    fromRow: (row) => (cell(row, 0).trim() && cell(row, 2).trim() ? pick(row, { 0: "added_by", 1: "feature_name", 2: "feature_url" }) : null),
    insertDefaults: () => ({}) },
];

// ------------------------------------------------------------------ state helpers
async function getState(env: Env, name: string): Promise<string> {
  return (await env.DB.prepare("SELECT value FROM sheet_sync_state WHERE name = ?").bind(name).first<{ value: string }>())?.value ?? "";
}
async function setState(env: Env, name: string, value: unknown) {
  await env.DB.prepare(`INSERT INTO sheet_sync_state (name, value, updated_at) VALUES (?, ?, ${NOW}) ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
    .bind(name, typeof value === "string" ? value : JSON.stringify(value)).run();
}
async function sha1(s: string) {
  const d = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function runBatches(env: Env, stmts: D1PreparedStatement[]) {
  const out: D1Result[] = [];
  for (let i = 0; i < stmts.length; i += 100) out.push(...(await env.DB.batch(stmts.slice(i, i + 100))));
  return out;
}
/** Record key: ID parts trimmed, person-name parts normalised (case/whitespace-insensitive). */
const keyOf = (p: PullSpec, r: Rec) => p.keyCols.map((c) => (p.nameKeys?.includes(c) ? normName(r[c]) : String(r[c] ?? "").trim())).join("|||");

async function selectByKeys(env: Env, p: PullSpec, keys: Rec[]): Promise<Map<string, Rec>> {
  const out = new Map<string, Rec>();
  if (p.nameKeys?.length) { // name-keyed tabs are small: read the table and match normalised keys
    const { results } = await env.DB.prepare(`SELECT ${p.cols.join(", ")} FROM ${p.table}${p.where ? ` WHERE ${p.where}` : ""} ORDER BY rowid`).all<Rec>();
    const wanted = new Set(keys.map((k) => keyOf(p, k)));
    for (const r of results) { const k = keyOf(p, r); if (wanted.has(k) && !out.has(k)) out.set(k, r); }
    return out;
  }
  const kexpr = p.keyCols.length === 1 ? p.keyCols[0] : p.keyCols.join(" || '|||' || ");
  const list = [...new Set(keys.map((k) => p.keyCols.map((c) => String(k[c])).join("|||")))];
  if (list.length > 1500) { // first run / big change: one table read beats hundreds of keyed queries
    const wanted = new Set(list);
    const { results } = await env.DB.prepare(`SELECT ${p.cols.join(", ")} FROM ${p.table}${p.where ? ` WHERE ${p.where}` : ""}`).all<Rec>();
    for (const r of results) { const k = p.keyCols.map((c) => String(r[c])).join("|||"); if (wanted.has(k)) out.set(k, r); }
    return out;
  }
  for (let i = 0; i < list.length; i += 90) {
    const chunk = list.slice(i, i + 90);
    const { results } = await env.DB.prepare(`SELECT ${p.cols.join(", ")} FROM ${p.table} WHERE ${p.where ? `${p.where} AND ` : ""}(${kexpr}) IN (${chunk.map(() => "?").join(",")})`)
      .bind(...chunk).all<Rec>();
    for (const r of results) out.set(p.keyCols.map((c) => String(r[c])).join("|||"), r);
  }
  return out;
}

// ------------------------------------------------------------------ generic tab pull
async function pullTab(env: Env, p: PullSpec, ctx: Ctx, touched: Map<string, Set<string>>, full: boolean) {
  const sid = env[p.sheet];
  if (!sid) return { skipped: "not configured" };
  const [rows] = await batchGet(env, sid, [`${a1Tab(`${env.SHEETS_TAB_PREFIX || ""}${p.id}`)}!A2:${p.lastCol}`]);

  // fingerprint 500-row blocks; only blocks that changed since last time are compared with D1
  const hashes: string[] = [];
  for (let i = 0; i < rows.length; i += BLOCK) hashes.push(await sha1(JSON.stringify(rows.slice(i, i + BLOCK))));
  const prevRaw = full ? "" : await getState(env, `pullhash:${p.id}`);
  const prev: string[] = prevRaw ? JSON.parse(prevRaw) : [];
  const changedBlocks = hashes.map((h, i) => (h !== prev[i] ? i : -1)).filter((i) => i >= 0);
  if (!changedBlocks.length) return { unchanged: true, rows: rows.length };

  const candidates: { rec: Rec; key: string }[] = [];
  const seen = new Set<string>();
  rows.forEach((row, i) => {
    const rec = p.fromRow(row);
    if (!rec) return;
    const key = keyOf(p, rec);
    if (!key.replace(/\|/g, "") || seen.has(key)) return; // legacy duplicates: first row wins
    seen.add(key);
    for (const c of p.keyCols) if (!p.nameKeys?.includes(c)) rec[c] = String(rec[c]).trim(); // names kept as written
    if (changedBlocks.includes(Math.floor(i / BLOCK))) candidates.push({ rec, key });
  });

  const current = await selectByKeys(env, p, candidates.map((c) => c.rec));
  const stmts: D1PreparedStatement[] = [];
  const kinds: ("insert" | "update")[] = [];
  const keysOf: string[] = [];
  let invalid = 0;
  for (const { rec, key } of candidates) {
    if (p.validate && !p.validate(rec, ctx)) { invalid++; continue; }
    const vals = p.cols.map((c) => (p.numeric?.includes(c) ? parseInt(String(rec[c] ?? ""), 10) || 0 : String(rec[c] ?? "")));
    const cur = current.get(key);
    const qk = p.queueKey(cur || rec); // queue keys hold the STORED values
    if (!cur) {
      const extra = p.insertDefaults?.(rec);
      if (!extra) continue;
      const cols = [...p.cols, ...Object.keys(extra)];
      stmts.push(env.DB.prepare(`INSERT INTO ${p.table} (${cols.join(", ")}) SELECT ${cols.map(() => "?").join(", ")} WHERE NOT EXISTS (SELECT 1 FROM sheet_sync_queue WHERE tbl = ? AND k = ?)`)
        .bind(...vals, ...Object.values(extra), p.queueTable, qk));
      kinds.push("insert"); keysOf.push(qk);
      continue;
    }
    const diff = p.cols.filter((c, i) => !p.keyCols.includes(c) && String(cur[c] ?? "") !== String(vals[i]));
    // a name spelled differently (spaces/case) is the same person — never "fix" key spellings
    if (!diff.length) continue;
    const keyWhere = p.keyCols.map((c) => `${c} = ?`).join(" AND ");
    // portal wins: skip (atomically) when the portal has a pending change for this record
    stmts.push(env.DB.prepare(`UPDATE ${p.table} SET ${diff.map((c) => `${c} = ?`).join(", ")}${HAS_UPDATED_AT.has(p.table) ? `, updated_at = ${NOW}` : ""}
      WHERE ${p.where ? `${p.where} AND ` : ""}${keyWhere} AND NOT EXISTS (SELECT 1 FROM sheet_sync_queue WHERE tbl = ? AND k = ?)`)
      .bind(...diff.map((c) => vals[p.cols.indexOf(c)]), ...p.keyCols.map((c) => cur[c]), p.queueTable, qk)); // target the stored row exactly
    kinds.push("update"); keysOf.push(qk);
  }
  const res = await runBatches(env, stmts);
  let inserted = 0, updated = 0, skippedPending = 0;
  const mine = touched.get(p.queueTable) || new Set<string>();
  res.forEach((r, i) => {
    if (r.meta.changes > 0) { kinds[i] === "insert" ? inserted++ : updated++; mine.add(keysOf[i]); }
    else skippedPending++;
  });
  touched.set(p.queueTable, mine);
  await setState(env, `pullhash:${p.id}`, hashes);
  return { rows: rows.length, changedBlocks: changedBlocks.length, inserted, updated, skippedPending, invalid };
}

/** MasterTemplateData: one row per index → training_templates + training_indices (per template). */
async function pullTemplates(env: Env, ctx: Ctx, touched: Map<string, Set<string>>, full: boolean) {
  const sid = env.GOOGLE_SHEET_ID_TRAINING;
  if (!sid) return { skipped: "not configured" };
  const tab = "MasterTemplateData";
  const [rows] = await batchGet(env, sid, [`${a1Tab(`${env.SHEETS_TAB_PREFIX || ""}${tab}`)}!A2:H`]);
  const h = await sha1(JSON.stringify(rows));
  if (!full && h === (await getState(env, `pullhash:${tab}`))) return { unchanged: true, rows: rows.length };
  const groups = new Map<string, { t: Rec; idx: string[][] }>();
  for (const r of rows) {
    const id = cell(r, 0).trim();
    if (!id) continue;
    if (!groups.has(id)) groups.set(id, { t: { designation: "", training_name: "", score: "", approval: "Pending" }, idx: [] });
    const g = groups.get(id)!;
    if (cell(r, 1).trim()) g.t.designation = cell(r, 1).trim();
    if (!g.t.training_name) g.t.training_name = cell(r, 7) || cell(r, 2);
    if (!g.t.score && cell(r, 5)) g.t.score = cell(r, 5);
    if (cell(r, 6)) g.t.approval = cell(r, 6) === "Approved" ? "Approved" : "Pending";
    g.idx.push([cell(r, 2) || `Index ${g.idx.length + 1}`, cell(r, 3), cell(r, 4)]);
  }
  const pending = new Set((await env.DB.prepare("SELECT DISTINCT k FROM sheet_sync_queue WHERE tbl IN ('training_templates','training_indices')").all<{ k: string }>()).results.map((r) => r.k));
  const [tpls, idx] = await env.DB.batch([
    env.DB.prepare("SELECT template_id, designation, training_name, score, approval FROM training_templates"),
    env.DB.prepare("SELECT template_id, index_name, document, video FROM training_indices ORDER BY template_id, position, id"),
  ]);
  const curT = new Map((tpls.results as Rec[]).map((t) => [String(t.template_id), t]));
  const curI = new Map<string, string[][]>();
  for (const i of idx.results as Rec[]) {
    const k = String(i.template_id);
    if (!curI.has(k)) curI.set(k, []);
    curI.get(k)!.push([String(i.index_name), String(i.document), String(i.video)]);
  }
  const stmts: D1PreparedStatement[] = [];
  const mine = new Set<string>();
  let changed = 0;
  for (const [id, g] of groups) {
    if (pending.has(id)) continue;
    const ct = curT.get(id);
    const sameT = ct && ["designation", "training_name", "score", "approval"].every((c) => String(ct[c] ?? "") === String(g.t[c] ?? ""));
    const sameI = JSON.stringify(curI.get(id) || []) === JSON.stringify(g.idx);
    if (sameT && sameI) continue;
    changed++; mine.add(id);
    stmts.push(env.DB.prepare(`INSERT INTO training_templates (template_id, designation, training_name, score, approval) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(template_id) DO UPDATE SET designation = excluded.designation, training_name = excluded.training_name, score = excluded.score, approval = excluded.approval`)
      .bind(id, g.t.designation, g.t.training_name, String(g.t.score || "100"), g.t.approval));
    if (!sameI) {
      stmts.push(env.DB.prepare("DELETE FROM training_indices WHERE template_id = ?").bind(id));
      g.idx.forEach((ix, n) => stmts.push(env.DB.prepare("INSERT INTO training_indices (template_id, position, index_name, document, video) VALUES (?, ?, ?, ?, ?)").bind(id, n + 1, ...ix)));
    }
    ctx.templates.add(id);
  }
  await runBatches(env, stmts);
  touched.set("training_templates", mine);
  touched.set("training_indices", mine);
  await setState(env, `pullhash:${tab}`, h);
  return { rows: rows.length, templatesChanged: changed };
}

/** New rows appended to Consolidated → checklist_tasks.actual (first completion wins, like the VLOOKUP). */
async function pullCompletions(env: Env, touched: Map<string, Set<string>>) {
  const sid = env.GOOGLE_SHEET_ID_CHECKLIST;
  if (!sid) return { skipped: "not configured" };
  const mark = parseInt(await getState(env, "pull:Consolidated:rows"), 10) || 0;
  const [rows] = await batchGet(env, sid, [`${a1Tab(`${env.SHEETS_TAB_PREFIX || ""}Consolidated`)}!A${mark + 2}:B`]);
  if (!rows.length) return { unchanged: true };
  const fresh = new Map<string, string>();
  for (const r of rows) {
    const id = cell(r, 0).trim(), at = cell(r, 1).trim();
    if (id && at && !fresh.has(id)) fresh.set(id, at);
  }
  const todo = [...fresh];
  const res = await runBatches(env, todo.map(([id, at]) =>
    env.DB.prepare(`UPDATE checklist_tasks SET actual = ?, updated_at = ${NOW} WHERE task_id = ? AND trim(actual) = '' AND NOT EXISTS (SELECT 1 FROM sheet_sync_queue WHERE tbl = 'checklist_tasks' AND k = ?)`).bind(at, id, id)));
  const mine = touched.get("checklist_tasks") || new Set<string>();
  let applied = 0;
  res.forEach((x, j) => { if (x.meta.changes > 0) { applied++; mine.add(todo[j][0]); } });
  touched.set("checklist_tasks", mine);
  await setState(env, "pull:Consolidated:rows", String(mark + rows.length));
  return { newRows: rows.length, completionsApplied: applied };
}

export const pullEnabled = (env: Env) => env.SHEETS_PULL_ENABLED === "true" && googleConfigured(env);

/** Copy edits made in Google Sheets into D1 (all synced tabs). `full` ignores the block fingerprints. */
export async function runSheetsPull(env: Env, { force = false, full = false } = {}) {
  if (!force && !pullEnabled(env)) return { skipped: "disabled" };
  if (!googleConfigured(env)) return { skipped: "google credentials missing" };
  const started = Date.now();
  const before = (await env.DB.prepare("SELECT COALESCE(MAX(id), 0) AS m FROM sheet_sync_queue").first<{ m: number }>())!.m;
  const results: Record<string, unknown> = {};
  const touched = new Map<string, Set<string>>();
  const ctx: Ctx = { templates: new Set((await env.DB.prepare("SELECT template_id FROM training_templates").all<{ template_id: string }>()).results.map((r) => r.template_id)) };
  try { results.MasterTemplateData = await pullTemplates(env, ctx, touched, full); }
  catch (e) { results.MasterTemplateData = { error: (e as Error).message }; }
  for (const p of PULLS) {
    try { results[p.id] = await pullTab(env, p, ctx, touched, full); }
    catch (e) { results[p.id] = { error: (e as Error).message }; }
  }
  try { results.Consolidated = await pullCompletions(env, touched); }
  catch (e) { results.Consolidated = { error: (e as Error).message }; }

  // The pull's own writes queued sync entries; the sheet already has those values → drop exactly
  // those (same table + key, queued after the pull started) so they are not written back.
  const drops: D1PreparedStatement[] = [];
  for (const [tbl, keys] of touched) {
    const list = [...keys];
    for (let i = 0; i < list.length; i += 90) {
      const chunk = list.slice(i, i + 90);
      drops.push(env.DB.prepare(`DELETE FROM sheet_sync_queue WHERE id > ? AND tbl = ? AND k IN (${chunk.map(() => "?").join(",")})`).bind(before, tbl, ...chunk));
    }
  }
  await runBatches(env, drops);
  const ok = !Object.values(results).some((r) => (r as { error?: string }).error);
  await setState(env, "status:Pull from Sheets", { ok, at: new Date().toISOString(), ms: Date.now() - started, ...results });
  return results;
}

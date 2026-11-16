// Sheets → D1 "transition" pull.
//
// While the old portal (or anyone editing the sheets by hand) still writes to the legacy
// Google Sheets, this copies those changes into D1 so the new portal sees them:
//   - new / changed rows in DelegationMaster, HelpTicketsMaster, SupportTicketsMaster, WorkList
//   - new checklist completions appended to Consolidated (→ checklist_tasks.actual)
// Rules:
//   - portal wins: a key with a pending portal change (sheet_sync_queue) is never overwritten
//   - rows deleted in the sheet are NOT deleted in D1 (reported only)
//   - changes made by the pull are removed from the sync queue, so they are not written back
// Turn off (SHEETS_PULL_ENABLED=false) once the old portal is retired.
import type { Env } from "../types";
import { a1Tab, batchGet, googleConfigured } from "./google";
import { nanoid } from "./util";

type Col = string | null; // D1 column for each sheet column (null = ignore)

interface PullSpec {
  id: string;
  sheet: "GOOGLE_SHEET_ID_DELEGATION" | "GOOGLE_SHEET_ID_HELPTICKET" | "GOOGLE_SHEET_ID_SUPPORTTICKET" | "GOOGLE_SHEET_ID_WORKLIST";
  tab: string;
  table: string;
  key: string;              // D1 primary key column (= sheet column A)
  cols: Col[];              // sheet column index → D1 column
  numeric?: string[];       // columns stored as INTEGER
  defaults?: Record<string, string>; // NOT NULL columns without a sheet column (new rows)
  validate?: (row: Record<string, string>) => boolean;
}

const PULLS: PullSpec[] = [
  { id: "DelegationMaster", sheet: "GOOGLE_SHEET_ID_DELEGATION", tab: "DelegationMaster", table: "delegations", key: "task_id",
    cols: ["task_id", "name", "task_name", "created_date", "deadline", "revision1", "revision2", "final_date", "revisions", "priority", "status", "followup", "done_week", "approval"],
    numeric: ["revisions"] },
  { id: "HelpTicketsMaster", sheet: "GOOGLE_SHEET_ID_HELPTICKET", tab: "HelpTicketsMaster", table: "help_tickets", key: "ticket_id",
    cols: ["ticket_id", "created_by", "assigned_to", "issue", "status", "created_date", "done_date", "issue_photo"] },
  { id: "SupportTicketsMaster", sheet: "GOOGLE_SHEET_ID_SUPPORTTICKET", tab: "SupportTicketsMaster", table: "support_tickets", key: "ticket_id",
    cols: ["ticket_id", "created_by", "assigned_to", "issue", "status", "created_date", "done_date", "issue_photo", "work_by", "approval", "col_k", null, "problem", "solution", "department"],
    defaults: { group_key: "" } },
  { id: "WorkList", sheet: "GOOGLE_SHEET_ID_WORKLIST", tab: "WorkList", table: "worklists", key: "worklist_id",
    cols: ["worklist_id", "employee_name", "worklist_name", "frequency", "working_time", "template_link", "remark", "schedule_days", "schedule_dates", "ai_time"],
    numeric: [], validate: (r) => ["Daily", "Weekly", "Monthly", "Yearly"].includes(r.frequency) },
];

async function getState(env: Env, name: string): Promise<string> {
  return (await env.DB.prepare("SELECT value FROM sheet_sync_state WHERE name = ?").bind(name).first<{ value: string }>())?.value ?? "";
}
async function setState(env: Env, name: string, value: unknown) {
  await env.DB.prepare("INSERT INTO sheet_sync_state (name, value, updated_at) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now')) ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
    .bind(name, typeof value === "string" ? value : JSON.stringify(value)).run();
}
const maxQueueId = async (env: Env) => (await env.DB.prepare("SELECT COALESCE(MAX(id), 0) AS m FROM sheet_sync_queue").first<{ m: number }>())!.m;
const pendingKeys = async (env: Env, table: string) =>
  new Set((await env.DB.prepare("SELECT DISTINCT k FROM sheet_sync_queue WHERE tbl = ?").bind(table).all<{ k: string }>()).results.map((r) => r.k));

async function runBatches(env: Env, stmts: D1PreparedStatement[]) {
  for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));
}

async function pullTable(env: Env, p: PullSpec, touched: Map<string, Set<string>>) {
  const sid = env[p.sheet];
  if (!sid) return { skipped: "not configured" };
  const last = String.fromCharCode(64 + p.cols.length);
  const [rows] = await batchGet(env, sid, [`${a1Tab(`${env.SHEETS_TAB_PREFIX || ""}${p.tab}`)}!A2:${last}`]);
  const dbCols = p.cols.filter((c): c is string => !!c);
  const { results } = await env.DB.prepare(`SELECT ${dbCols.join(", ")} FROM ${p.table}`).all<Record<string, unknown>>();
  const db = new Map(results.map((r) => [String(r[p.key]), r]));
  const pending = await pendingKeys(env, p.table);
  const seen = new Set<string>();
  const stmts: D1PreparedStatement[] = [];
  let inserted = 0, updated = 0, skippedPending = 0;
  const mine = new Set<string>();
  for (const raw of rows) {
    const rec: Record<string, string> = {};
    p.cols.forEach((c, i) => { if (c) rec[c] = String(raw[i] ?? ""); });
    const key = rec[p.key].trim();
    if (!key || seen.has(key)) continue; // legacy duplicates: first row wins (as the legacy API read it)
    seen.add(key);
    if (p.validate && !p.validate(rec)) continue;
    const vals = dbCols.map((c) => (p.numeric?.includes(c) ? parseInt(rec[c], 10) || 0 : rec[c]));
    const cur = db.get(key);
    if (!cur) {
      const extra = Object.entries(p.defaults || {}).map(([c, v]) => [c, c === "group_key" ? `legacy:${rec.issue?.trim() ?? nanoid(8)}` : v]);
      stmts.push(env.DB.prepare(`INSERT INTO ${p.table} (${[...dbCols, ...extra.map((e) => e[0])].join(", ")}) VALUES (${[...dbCols, ...extra].map(() => "?").join(", ")})`)
        .bind(...vals, ...extra.map((e) => e[1])));
      inserted++;
      mine.add(key);
      continue;
    }
    if (dbCols.every((c, i) => String(cur[c] ?? "") === String(vals[i]))) continue;
    if (pending.has(key)) { skippedPending++; continue; } // portal change waiting → portal wins
    const sets = dbCols.filter((c) => c !== p.key);
    stmts.push(env.DB.prepare(`UPDATE ${p.table} SET ${sets.map((c) => `${c} = ?`).join(", ")}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE ${p.key} = ?`)
      .bind(...sets.map((c) => vals[dbCols.indexOf(c)]), key));
    updated++;
    mine.add(key);
  }
  await runBatches(env, stmts);
  touched.set(p.table, mine);
  const notInSheet = [...db.keys()].filter((k) => !seen.has(k) && !pending.has(k)).length;
  return { inserted, updated, skippedPending, notInSheet };
}

/** New rows appended to Consolidated since the last pull → checklist_tasks.actual (first completion wins, like the VLOOKUP). */
async function pullCompletions(env: Env, touched: Map<string, Set<string>>) {
  const sid = env.GOOGLE_SHEET_ID_CHECKLIST;
  if (!sid) return { skipped: "not configured" };
  const mark = parseInt(await getState(env, "pull:Consolidated:rows"), 10) || 0;
  const [rows] = await batchGet(env, sid, [`${a1Tab(`${env.SHEETS_TAB_PREFIX || ""}Consolidated`)}!A${mark + 2}:B`]);
  const fresh = new Map<string, string>();
  for (const r of rows) {
    const id = String(r[0] ?? "").trim(), at = String(r[1] ?? "").trim();
    if (id && at && !fresh.has(id)) fresh.set(id, at);
  }
  const pending = await pendingKeys(env, "checklist_tasks");
  const todo = [...fresh].filter(([id]) => !pending.has(id));
  const mine = new Set<string>();
  const stmts = todo.map(([id, at]) =>
    env.DB.prepare("UPDATE checklist_tasks SET actual = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE task_id = ? AND trim(actual) = ''").bind(at, id));
  let applied = 0;
  for (let i = 0; i < stmts.length; i += 100) {
    const res = await env.DB.batch(stmts.slice(i, i + 100));
    res.forEach((x, j) => { if (x.meta.changes > 0) { applied++; mine.add(todo[i + j][0]); } });
  }
  touched.set("checklist_tasks", mine);
  await setState(env, "pull:Consolidated:rows", String(mark + rows.length));
  return { newRows: rows.length, completionsApplied: applied };
}

export const pullEnabled = (env: Env) => env.SHEETS_PULL_ENABLED === "true" && googleConfigured(env);

/** Copy changes made directly in the legacy sheets into D1 (see header). */
export async function runSheetsPull(env: Env, { force = false } = {}) {
  if (!force && !pullEnabled(env)) return { skipped: "disabled" };
  if (!googleConfigured(env)) return { skipped: "google credentials missing" };
  const before = await maxQueueId(env);
  const results: Record<string, unknown> = {};
  const touched = new Map<string, Set<string>>();
  for (const p of PULLS) {
    try { results[p.id] = await pullTable(env, p, touched); }
    catch (e) { results[p.id] = { error: (e as Error).message }; }
  }
  try { results.Consolidated = await pullCompletions(env, touched); }
  catch (e) { results.Consolidated = { error: (e as Error).message }; }
  // The pull's own D1 writes queued sync entries; the sheet already has those values, so drop
  // exactly those (same table + key, queued after the pull started) — never other portal changes.
  const drops: D1PreparedStatement[] = [];
  for (const [tbl, keys] of touched) {
    const list = [...keys];
    for (let i = 0; i < list.length; i += 90) {
      const chunk = list.slice(i, i + 90);
      drops.push(env.DB.prepare(`DELETE FROM sheet_sync_queue WHERE id > ? AND tbl = ? AND k IN (${chunk.map(() => "?").join(",")})`).bind(before, tbl, ...chunk));
    }
  }
  await runBatches(env, drops);
  await setState(env, "status:Pull from Sheets", { ok: !Object.values(results).some((r) => (r as { error?: string }).error), at: new Date().toISOString(), ...results });
  return results;
}

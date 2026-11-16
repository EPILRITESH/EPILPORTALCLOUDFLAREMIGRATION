// D1 → Google Sheets backup sync (one-way).
//
// D1 triggers (migration 0003) record every changed row's natural key in
// sheet_sync_queue. runSheetsSync() drains the queue: for each affected sheet it
// reads the sheet's ID column, then updates the matching row in place, appends
// new rows, or clears rows deleted in the portal — the same way the legacy
// Express backend wrote these sheets. Formula columns are never written.
import type { Env } from "../types";
import { a1Tab, appendRows, batchClear, batchGet, batchUpdate, googleConfigured, sheetProps } from "./google";

type Row = unknown[];
type SheetEnv = "GOOGLE_SHEET_ID" | "GOOGLE_SHEET_ID_CHECKLIST" | "GOOGLE_SHEET_ID_DELEGATION" | "GOOGLE_SHEET_ID_HELPTICKET"
  | "GOOGLE_SHEET_ID_SUPPORTTICKET" | "GOOGLE_SHEET_ID_WORKLIST" | "GOOGLE_SHEET_ID_TRAINING";

export interface SheetSpec {
  id: string;                       // status name
  sheet: SheetEnv;                  // env var holding the spreadsheet ID
  tab: string;
  table: string;                    // queue table it listens to (users fans out by key prefix)
  extraTables?: string[];
  /** Map a queue key to this sheet's key (null = not for this sheet). */
  sheetKey?: (queueKey: string) => string | null;
  keyCols: number[];                // 0-based columns forming the row key
  segments: [number, number][];     // inclusive column ranges that are safe to write
  group?: boolean;                  // several rows share one key (training index rows)
  clearMissing?: boolean;           // clear sheet rows whose record no longer exists (default true)
  load: (env: Env, keys: string[]) => Promise<Map<string, Row[]>>;
}

// ------------------------------------------------------------------ helpers
const COL = (n: number): string => (n < 26 ? String.fromCharCode(65 + n) : COL(Math.floor(n / 26) - 1) + String.fromCharCode(65 + (n % 26)));

async function selectIn<T>(env: Env, sql: (ph: string) => string, keys: string[]): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < keys.length; i += 90) {
    const chunk = keys.slice(i, i + 90);
    const { results } = await env.DB.prepare(sql(chunk.map(() => "?").join(","))).bind(...chunk).all<T>();
    out.push(...results);
  }
  return out;
}
const one = (m: Map<string, Row[]>, k: string, r: Row) => { m.set(k, [r]); };

/** Text that Sheets (USER_ENTERED) would treat as a formula is forced to plain text. */
export function cellValue(v: unknown): string | number {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return v;
  const s = String(v);
  if (/^[=@]/.test(s) || (/^[+-]/.test(s) && !/^[+-]?\d+(\.\d+)?$/.test(s))) return `'${s}`;
  return s;
}

// Employee!A:BW layout (legacy register route) — index → hr_details key
const HR_AT: Record<number, string> = { 12: "gender", 13: "employeeType", 14: "workLocation", 15: "employeeStatus", 16: "shiftName", 20: "lunchBreak", 21: "weeklyOff", 22: "overtimeApplicable", 23: "overtimeRate", 24: "basicSalary", 25: "petrolAllowance", 26: "petrolAmount", 27: "foodAllowance", 28: "foodAmount", 29: "workingDays", 30: "pfApplicable", 31: "ptApplicable", 32: "advanceAllowed", 33: "advanceLimit", 34: "biometricId", 35: "graceTime", 36: "lateMarkAfter", 37: "halfDayAfter", 38: "minWorkingHours", 39: "punchRequired", 40: "autoAbsentAfter", 41: "paidLeave", 42: "casualLeave", 43: "sickLeave", 44: "earnedLeave", 45: "leaveCarryForward", 46: "leaveCarryMax", 47: "bankName", 48: "accountNumber", 49: "ifscCode", 50: "pfNumber", 51: "esicNumber", 53: "aadhaarNumber", 55: "panNumber", 57: "highestQualification", 58: "passingYear", 60: "previousCompany", 61: "previousDesignation", 62: "totalExperience", 64: "fatherName", 65: "motherName", 66: "spouseName", 67: "spouseDob", 68: "motherInLawName", 69: "fatherInLawName", 70: "emergencyContactName", 71: "emergencyContactNumber", 72: "permanentAddress", 73: "currentAddress", 74: "lastUpdatedAt" };
const DOC_AT: Record<string, number> = { bankPassbook: 52, aadhaarCard: 54, panCard: 56, educationCert: 59, experienceCert: 63 };

async function loadUsers(env: Env, keys: string[], role: "employee" | "admin") {
  const users = await selectIn<any>(env, (ph) => `SELECT * FROM users WHERE role = '${role}' AND employee_id IN (${ph})`, keys);
  const docs = role === "employee" && users.length
    ? await selectIn<any>(env, (ph) => `SELECT user_id, kind, file_ref FROM user_documents WHERE user_id IN (${ph})`, users.map((u) => String(u.id)))
    : [];
  const m = new Map<string, Row[]>();
  for (const u of users) {
    if (role === "admin") { one(m, u.employee_id, [u.employee_id, u.name, u.mobile, u.password_hash, u.department, u.created_at, u.company_name]); continue; }
    const r: Row = new Array(75).fill("");
    Object.assign(r, { 0: u.employee_id, 1: u.name, 2: u.mobile, 3: u.password_hash, 4: u.department, 5: u.created_at, 6: u.company_name, 7: u.date_of_birth, 8: u.joining_date, 9: u.profile_picture, 10: u.designation, 11: u.doer_name, 17: u.shift_start_time, 18: u.shift_end_time, 19: u.total_working_hours });
    let hr: Record<string, string> = {};
    try { hr = JSON.parse(u.hr_details || "{}"); } catch { /* keep empty */ }
    for (const [i, k] of Object.entries(HR_AT)) if (hr[k] !== undefined) r[+i] = hr[k];
    for (const d of docs) if (d.user_id === u.id && DOC_AT[d.kind] !== undefined) r[DOC_AT[d.kind]] = d.file_ref;
    one(m, u.employee_id, r);
  }
  return m;
}

const prefixKey = (p: string) => (k: string) => (k.startsWith(p) ? k.slice(p.length) : null);

// ------------------------------------------------------------------ sheet specs
export const SPECS: SheetSpec[] = [
  { id: "Employee", sheet: "GOOGLE_SHEET_ID", tab: "Employee", table: "users", sheetKey: prefixKey("employee:"),
    keyCols: [0], segments: [[0, 74]], load: (env, k) => loadUsers(env, k, "employee") },
  { id: "Admin", sheet: "GOOGLE_SHEET_ID", tab: "Admin", table: "users", sheetKey: prefixKey("admin:"),
    keyCols: [0], segments: [[0, 6]], load: (env, k) => loadUsers(env, k, "admin") },
  { id: "AdditionalFeature", sheet: "GOOGLE_SHEET_ID", tab: "AdditionalFeature", table: "additional_features",
    keyCols: [0, 1, 2], segments: [[0, 3]], load: async (env, keys) => {
      const m = new Map<string, Row[]>();
      const rows = await selectIn<any>(env, (ph) => `SELECT * FROM additional_features WHERE (added_by || '|||' || feature_name || '|||' || feature_url) IN (${ph})`, keys);
      for (const r of rows) one(m, `${r.added_by}|||${r.feature_name}|||${r.feature_url}`, [r.added_by, r.feature_name, r.feature_url, r.created_at]);
      return m;
    } },
  { id: "DelegationMaster", sheet: "GOOGLE_SHEET_ID_DELEGATION", tab: "DelegationMaster", table: "delegations",
    keyCols: [0], segments: [[0, 13]], load: async (env, keys) => {
      const m = new Map<string, Row[]>();
      for (const r of await selectIn<any>(env, (ph) => `SELECT * FROM delegations WHERE task_id IN (${ph})`, keys)) {
        one(m, r.task_id, [r.task_id, r.name, r.task_name, r.created_date, r.deadline, r.revision1, r.revision2, r.final_date, r.revisions, r.priority, r.status, r.followup, r.done_week, r.approval]);
      }
      return m;
    } },
  // Master!H (Actual) is an ARRAYFORMULA over Consolidated → never written here.
  { id: "Master", sheet: "GOOGLE_SHEET_ID_CHECKLIST", tab: "Master", table: "checklist_tasks",
    keyCols: [3], segments: [[0, 6], [8, 10]], load: async (env, keys) => {
      const m = new Map<string, Row[]>();
      for (const r of await selectIn<any>(env, (ph) => `SELECT * FROM checklist_tasks WHERE task_id IN (${ph})`, keys)) {
        // Master!H's formula skips rows whose column B is blank → fall back to the doer's name (as the legacy create-template did)
        one(m, r.task_id, [r.name, r.email || r.name, r.department, r.task_id, r.freq, r.task, r.planned, "", r.source, r.template_id, r.archive]);
      }
      return m;
    } },
  // Completion dates feed Master!H through the formula, exactly as the legacy "done" route did.
  { id: "Consolidated", sheet: "GOOGLE_SHEET_ID_CHECKLIST", tab: "Consolidated", table: "checklist_tasks",
    keyCols: [0], segments: [[0, 1]], clearMissing: false, load: async (env, keys) => {
      const m = new Map<string, Row[]>();
      for (const r of await selectIn<any>(env, (ph) => `SELECT task_id, actual FROM checklist_tasks WHERE trim(actual) != '' AND task_id IN (${ph})`, keys)) {
        one(m, r.task_id, [r.task_id, r.actual]);
      }
      return m;
    } },
  { id: "MasterTasks", sheet: "GOOGLE_SHEET_ID_CHECKLIST", tab: "MasterTasks", table: "checklist_templates",
    keyCols: [0], segments: [[0, 8]], load: async (env, keys) => {
      const m = new Map<string, Row[]>();
      for (const r of await selectIn<any>(env, (ph) => `SELECT * FROM checklist_templates WHERE template_id IN (${ph})`, keys)) {
        one(m, r.template_id, [r.template_id, r.name, r.email, r.department, r.task, r.freq, r.day_or_date, r.created_at, r.status]);
      }
      return m;
    } },
  { id: "HelpTicketsMaster", sheet: "GOOGLE_SHEET_ID_HELPTICKET", tab: "HelpTicketsMaster", table: "help_tickets",
    keyCols: [0], segments: [[0, 7]], load: async (env, keys) => {
      const m = new Map<string, Row[]>();
      for (const r of await selectIn<any>(env, (ph) => `SELECT * FROM help_tickets WHERE ticket_id IN (${ph})`, keys)) {
        one(m, r.ticket_id, [r.ticket_id, r.created_by, r.assigned_to, r.issue, r.status, r.created_date, r.done_date, r.issue_photo]);
      }
      return m;
    } },
  // Columns L (Unique), P (Month), Q (Week) are ARRAYFORMULAs → skipped.
  { id: "SupportTicketsMaster", sheet: "GOOGLE_SHEET_ID_SUPPORTTICKET", tab: "SupportTicketsMaster", table: "support_tickets",
    keyCols: [0], segments: [[0, 10], [12, 14]], load: async (env, keys) => {
      const m = new Map<string, Row[]>();
      for (const r of await selectIn<any>(env, (ph) => `SELECT * FROM support_tickets WHERE ticket_id IN (${ph})`, keys)) {
        one(m, r.ticket_id, [r.ticket_id, r.created_by, r.assigned_to, r.issue, r.status, r.created_date, r.done_date, r.issue_photo, r.work_by, r.approval, r.col_k, "", r.problem, r.solution, r.department]);
      }
      return m;
    } },
  { id: "WorkList", sheet: "GOOGLE_SHEET_ID_WORKLIST", tab: "WorkList", table: "worklists",
    keyCols: [0], segments: [[0, 9]], load: async (env, keys) => {
      const m = new Map<string, Row[]>();
      for (const r of await selectIn<any>(env, (ph) => `SELECT * FROM worklists WHERE worklist_id IN (${ph})`, keys)) {
        one(m, r.worklist_id, [r.worklist_id, r.employee_name, r.worklist_name, r.frequency, r.working_time, r.template_link, r.remark, r.schedule_days, r.schedule_dates, r.ai_time]);
      }
      return m;
    } },
  // One sheet row per training index; all rows of a template are rewritten together.
  { id: "MasterTemplateData", sheet: "GOOGLE_SHEET_ID_TRAINING", tab: "MasterTemplateData", table: "training_templates", extraTables: ["training_indices"],
    keyCols: [0], segments: [[0, 7]], group: true, load: async (env, keys) => {
      const m = new Map<string, Row[]>();
      const tpls = await selectIn<any>(env, (ph) => `SELECT * FROM training_templates WHERE template_id IN (${ph})`, keys);
      const idx = await selectIn<any>(env, (ph) => `SELECT * FROM training_indices WHERE template_id IN (${ph}) ORDER BY template_id, position, id`, keys);
      for (const t of tpls) {
        m.set(t.template_id, idx.filter((i) => i.template_id === t.template_id)
          .map((i) => [t.template_id, t.designation, i.index_name, i.document, i.video, t.score, t.approval, t.training_name]));
      }
      return m;
    } },
  { id: "AQData", sheet: "GOOGLE_SHEET_ID_TRAINING", tab: "AQData", table: "training_questions",
    keyCols: [1], segments: [[0, 7]], load: async (env, keys) => {
      const m = new Map<string, Row[]>();
      for (const r of await selectIn<any>(env, (ph) => `SELECT * FROM training_questions WHERE qa_id IN (${ph})`, keys)) {
        one(m, r.qa_id, [r.template_id, r.qa_id, r.question, r.option_a, r.option_b, r.option_c, r.option_d, r.correct_option]);
      }
      return m;
    } },
  { id: "EmployeeTrainingData", sheet: "GOOGLE_SHEET_ID_TRAINING", tab: "EmployeeTrainingData", table: "training_records",
    keyCols: [0, 3], segments: [[0, 15]], load: async (env, keys) => {
      const m = new Map<string, Row[]>();
      for (const r of await selectIn<any>(env, (ph) => `SELECT * FROM training_records WHERE (employee_name || '|||' || template_id) IN (${ph})`, keys)) {
        one(m, `${r.employee_name}|||${r.template_id}`, [r.employee_name, r.designation, r.template_name, r.template_id, r.document_score, r.video_score, r.qa_score, r.total_score, r.status, r.start_date, r.end_date, r.last_update, r.tools_documents, r.tools_translite, r.tools_summary, r.progress]);
      }
      return m;
    } },
];

// ------------------------------------------------------------------ engine
type Props = Awaited<ReturnType<typeof sheetProps>>;

async function syncSpec(env: Env, spec: SheetSpec, keys: string[], propsCache: Map<string, Props>) {
  const sid = env[spec.sheet];
  if (!sid) throw new Error(`${spec.sheet} is not configured`);
  if (!propsCache.has(sid)) propsCache.set(sid, await sheetProps(env, sid));
  const tabName = `${env.SHEETS_TAB_PREFIX || ""}${spec.tab}`;
  const props = propsCache.get(sid)!.get(tabName);
  if (!props) throw new Error(`Tab "${tabName}" not found in ${spec.sheet}`);
  const tab = a1Tab(tabName);

  // 1) where is each key today?
  const cols = await batchGet(env, sid, spec.keyCols.map((c) => `${tab}!${COL(c)}2:${COL(c)}${props.rowCount}`));
  const height = Math.max(0, ...cols.map((c) => c.length));
  const where = new Map<string, number[]>();
  for (let i = 0; i < height; i++) {
    const key = spec.keyCols.map((_, j) => String(cols[j][i]?.[0] ?? "").trim()).join("|||");
    if (!key.replace(/\|/g, "")) continue;
    if (!where.has(key)) where.set(key, []);
    where.get(key)!.push(i + 2);
  }

  // 2) what should be there?
  const want = await spec.load(env, keys);
  const writes: [number, Row][] = [];
  const clears: number[] = [];
  let next = height + 2;
  for (const key of keys) {
    const rows = want.get(key) || [];
    const have = where.get(key.trim()) || [];
    if (!rows.length) { if (spec.clearMissing !== false) clears.push(...have); continue; }
    if (spec.group) {
      for (let i = 0; i < Math.max(rows.length, have.length); i++) {
        if (i < rows.length) writes.push([have[i] ?? next++, rows[i]]);
        else clears.push(have[i]);
      }
    } else writes.push([have[0] ?? next++, rows[0]]);
  }

  // 3) grow the grid if appending past its end
  if (next - 1 > props.rowCount) {
    const add = next - 1 - props.rowCount + 500;
    await appendRows(env, sid, props.sheetId, add);
    props.rowCount += add;
  }

  // 4) write value columns only; clear deleted rows
  const data = writes.flatMap(([r, row]) => spec.segments.map(([s, e]) => ({
    range: `${tab}!${COL(s)}${r}:${COL(e)}${r}`,
    values: [Array.from({ length: e - s + 1 }, (_, i) => cellValue(row[s + i]))],
  })));
  for (let i = 0; i < data.length; i += 400) await batchUpdate(env, sid, data.slice(i, i + 400));
  const ranges = clears.flatMap((r) => spec.segments.map(([s, e]) => `${tab}!${COL(s)}${r}:${COL(e)}${r}`));
  for (let i = 0; i < ranges.length; i += 400) await batchClear(env, sid, ranges.slice(i, i + 400));
  return { written: writes.length, cleared: clears.length };
}

async function setState(env: Env, name: string, value: unknown) {
  await env.DB.prepare(
    "INSERT INTO sheet_sync_state (name, value, updated_at) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now')) ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
  ).bind(name, JSON.stringify(value)).run();
}

export const syncEnabled = (env: Env) => env.SHEETS_SYNC_ENABLED === "true" && googleConfigured(env);

/** Drain up to `limit` queue entries into Google Sheets. Safe to call concurrently (lease lock). */
export async function runSheetsSync(env: Env, { limit = 1500, force = false } = {}) {
  if (!force && !syncEnabled(env)) return { skipped: "disabled" as const };
  if (!googleConfigured(env)) return { skipped: "google credentials missing" as const };
  const now = Math.floor(Date.now() / 1000);
  const lock = await env.DB.prepare("UPDATE sheet_sync_state SET value = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE name = 'lock' AND CAST(value AS INTEGER) < ?")
    .bind(String(now + 240), now).run();
  if (!lock.meta.changes) return { skipped: "another sync is running" as const };
  try {
    let total = 0, totalFailed = 0;
    const all: Record<string, unknown> = {};
    // Keep draining while new changes arrive during the run (saves made while we held the lock).
    for (let round = 0; round < 4; round++) {
      const r = await syncRound(env, limit);
      total += r.processed; totalFailed += r.failed; Object.assign(all, r.results);
      if (!r.processed || r.failed || r.remaining === 0) break;
    }
    return { processed: total, failed: totalFailed, results: all };
  } finally {
    await env.DB.prepare("UPDATE sheet_sync_state SET value = '0' WHERE name = 'lock'").run();
  }
}

async function syncRound(env: Env, limit: number) {
  {
    const { results: queue } = await env.DB.prepare("SELECT id, tbl, k FROM sheet_sync_queue ORDER BY id LIMIT ?").bind(limit).all<{ id: number; tbl: string; k: string }>();
    if (!queue.length) return { processed: 0, failed: 0, results: {}, remaining: 0 };
    const failed = new Set<number>();
    const results: Record<string, unknown> = {};
    const propsCache = new Map<string, Props>();
    for (const spec of SPECS) {
      const tables = [spec.table, ...(spec.extraTables || [])];
      const mine = queue.filter((q) => tables.includes(q.tbl) && (spec.sheetKey ? spec.sheetKey(q.k) !== null : true));
      if (!mine.length) continue;
      const keys = [...new Set(mine.map((q) => (spec.sheetKey ? spec.sheetKey(q.k)! : q.k)))];
      try {
        const r = await syncSpec(env, spec, keys, propsCache);
        results[spec.id] = r;
        await setState(env, `status:${spec.id}`, { ok: true, at: new Date().toISOString(), ...r });
      } catch (e) {
        const error = (e as Error).message;
        results[spec.id] = { error };
        mine.forEach((q) => failed.add(q.id));
        await setState(env, `status:${spec.id}`, { ok: false, at: new Date().toISOString(), error });
        console.error("sheets sync", spec.id, error);
      }
    }
    const done = queue.filter((q) => !failed.has(q.id)).map((q) => q.id);
    for (let i = 0; i < done.length; i += 90) {
      const chunk = done.slice(i, i + 90);
      await env.DB.prepare(`DELETE FROM sheet_sync_queue WHERE id IN (${chunk.map(() => "?").join(",")})`).bind(...chunk).run();
    }
    const remaining = (await env.DB.prepare("SELECT COUNT(*) AS n FROM sheet_sync_queue").first<{ n: number }>())!.n;
    return { processed: done.length, failed: failed.size, results, remaining };
  }
}

/** Re-queue every row changed since `since` (ISO) — e.g. portal changes made before triggers existed. */
export async function backfillQueue(env: Env, since: string) {
  const sources: [string, string, string][] = [
    ["users", "role || ':' || employee_id", "updated_at"],
    ["delegations", "task_id", "updated_at"],
    ["checklist_tasks", "task_id", "updated_at"],
    ["checklist_templates", "template_id", "created_at"],
    ["help_tickets", "ticket_id", "updated_at"],
    ["support_tickets", "ticket_id", "updated_at"],
    ["worklists", "worklist_id", "updated_at"],
    ["training_templates", "template_id", "created_at"],
    ["additional_features", "added_by || '|||' || feature_name || '|||' || feature_url", "created_at"],
  ];
  const res = await env.DB.batch(sources.map(([t, k, ts]) =>
    env.DB.prepare(`INSERT INTO sheet_sync_queue (tbl, k) SELECT '${t}', ${k} FROM ${t} WHERE ${ts} > ?`).bind(since)));
  return Object.fromEntries(sources.map(([t], i) => [t, res[i].meta.changes]));
}

/** The EM report is computed BY formulas in Google Sheets → copy it into D1 (Sheets → D1). */
export async function pullEmSheet(env: Env) {
  const sid = env.GOOGLE_SHEET_ID_EMSHEET;
  if (!sid || !googleConfigured(env)) return { skipped: "not configured" };
  const tab = env.EM_SHEET_TAB_NAME || "EM SHEET WITH RITEH SIR"; // always the real report tab (read-only)
  const [rows] = await batchGet(env, sid, [`${a1Tab(tab)}!A1:M1000`]);
  if (!rows?.length) return { skipped: "empty sheet" };
  const cells = rows.map((r) => JSON.stringify(Array.from({ length: 13 }, (_, i) => String(r[i] ?? ""))));
  const stmts = [env.DB.prepare("DELETE FROM em_sheet_rows"), ...cells.map((c, i) => env.DB.prepare("INSERT INTO em_sheet_rows (row_index, cells) VALUES (?, ?)").bind(i, c))];
  for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));
  await setState(env, "status:EM pull", { ok: true, at: new Date().toISOString(), rows: cells.length });
  return { rows: cells.length };
}

export async function syncStatus(env: Env) {
  const [q, s] = await env.DB.batch([
    env.DB.prepare("SELECT tbl, COUNT(*) AS pending, MIN(at) AS oldest FROM sheet_sync_queue GROUP BY tbl"),
    env.DB.prepare("SELECT name, value, updated_at FROM sheet_sync_state WHERE name LIKE 'status:%' ORDER BY name"),
  ]);
  return {
    enabled: syncEnabled(env),
    googleConfigured: googleConfigured(env),
    pending: q.results,
    sheets: (s.results as any[]).map((r) => ({ sheet: r.name.slice(7), ...JSON.parse(r.value) })),
  };
}

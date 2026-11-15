#!/usr/bin/env node
// STEP 3 — Transform exported sheet grids into D1 SQL.
//   in : out/sheets/*.json | out/csv/*.csv, out/file-map.json (optional)
//   out: out/seed.sql      (apply with: wrangler d1 execute epil-db --remote --file out/seed.sql)
//        out/report.json   (row counts, every skipped/repaired row and why)
// Deterministic and side-effect free — safe to re-run.
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { loadGrid, q, cell, trimmed, isBlankRow, URL_RE } from "./lib.mjs";

const DIR = process.env.MIGRATION_DIR || "out";
const fileMap = existsSync(`${DIR}/file-map.json`) ? JSON.parse(await readFile(`${DIR}/file-map.json`, "utf8")) : {};
const report = { generatedAt: new Date().toISOString(), counts: {}, issues: [], unmigratedFiles: 0 };
const issue = (table, row, problem, action, extra = {}) => report.issues.push({ table, sheetRow: row, problem, action, ...extra });
const sql = [];
const ALPHA = "useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict";
const newId = (n) => [...randomBytes(n)].map((b) => ALPHA[b & 63]).join("");

/** Rewrite a file URL to its R2 ref when it was copied. */
function fileRef(v) {
  const s = String(v || "").trim();
  if (!s) return "";
  if (fileMap[s]) return fileMap[s];
  if (URL_RE.test(s) && /cloudinary/i.test(s)) report.unmigratedFiles++;
  return s;
}

/** Batched multi-row INSERT (keeps every statement well below D1's 100 KB limit). */
function insert(table, cols, rows, verb = "INSERT") {
  report.counts[table] = (report.counts[table] || 0) + rows.length;
  let batch = [], size = 0;
  const flush = () => {
    if (!batch.length) return;
    sql.push(`${verb} INTO ${table} (${cols.join(", ")}) VALUES\n${batch.join(",\n")};`);
    batch = []; size = 0;
  };
  for (const r of rows) {
    const tuple = `(${r.map(q).join(", ")})`;
    if (size + tuple.length > 80_000 || batch.length >= 200) flush();
    batch.push(tuple); size += tuple.length;
  }
  flush();
}

// =====================================================================
// USERS — Employee + Admin
// =====================================================================
const normH = (h) => String(h || "").trim().toLowerCase().replace(/[^a-z]/g, "");
function colIdx(header, names, fallback) {
  const n = header.map(normH);
  for (const x of names) { const i = n.indexOf(normH(x)); if (i !== -1) return i; }
  return fallback;
}

const emp = await loadGrid(DIR, "employee");
const DEPT = colIdx(emp.header, ["department", "dept", "depatment", "departmentname"], 4);
const DESIG = colIdx(emp.header, ["designation", "designations", "desig", "designition", "desgination", "post", "role", "title", "jobtitle", "position"], 10);

/** Legacy fallback: blank designation → first designation-looking cell in the row. */
function designationOf(r) {
  let d = trimmed(r, DESIG) || trimmed(r, 10);
  if (d) return d;
  for (const i of [10, 11, 12, 5, 6, 13, 14, 15, 16, 4, 3, 7]) {
    if (i === DESIG) continue;
    const v = trimmed(r, i);
    if (!v || /^\d{5,}$/.test(v.replace(/[\s+\-]/g, "")) || v.length > 60) continue;
    if (/^\d{1,2}\/\d{1,2}\/\d{2,4}/.test(v) || /^\d{4}-\d{2}-\d{2}/.test(v) || /^https?:\/\//i.test(v)) continue; // dates/ISO/links
    if (v.startsWith("$2")) continue; // bcrypt hash
    return v;
  }
  return "";
}
// (legacy picked the ISO "Created" timestamp as a designation for blank rows — now skipped)

const HR = { 12: "gender", 13: "employeeType", 14: "workLocation", 15: "employeeStatus", 16: "shiftName", 20: "lunchBreak", 21: "weeklyOff", 22: "overtimeApplicable", 23: "overtimeRate", 24: "basicSalary", 25: "petrolAllowance", 26: "petrolAmount", 27: "foodAllowance", 28: "foodAmount", 29: "workingDays", 30: "pfApplicable", 31: "ptApplicable", 32: "advanceAllowed", 33: "advanceLimit", 34: "biometricId", 35: "graceTime", 36: "lateMarkAfter", 37: "halfDayAfter", 38: "minWorkingHours", 39: "punchRequired", 40: "autoAbsentAfter", 41: "paidLeave", 42: "casualLeave", 43: "sickLeave", 44: "earnedLeave", 45: "leaveCarryForward", 46: "leaveCarryMax", 47: "bankName", 48: "accountNumber", 49: "ifscCode", 50: "pfNumber", 51: "esicNumber", 53: "aadhaarNumber", 55: "panNumber", 57: "highestQualification", 58: "passingYear", 60: "previousCompany", 61: "previousDesignation", 62: "totalExperience", 64: "fatherName", 65: "motherName", 66: "spouseName", 67: "spouseDob", 68: "motherInLawName", 69: "fatherInLawName", 70: "emergencyContactName", 71: "emergencyContactNumber", 72: "permanentAddress", 73: "currentAddress", 74: "lastUpdatedAt" };
const DOCS = { 52: "bankPassbook", 54: "aadhaarCard", 56: "panCard", 59: "educationCert", 63: "experienceCert" };

const userCols = ["employee_id", "role", "name", "mobile", "password_hash", "department", "designation", "company_name", "date_of_birth", "joining_date", "profile_picture", "doer_name", "shift_start_time", "shift_end_time", "total_working_hours", "hr_details", "created_at"];
const userRows = [];
const docRows = []; // [employee_id, kind, ref]
const seenIds = new Set();
const seenNames = { employee: new Map(), admin: new Map() };
const isoOr = (v) => (/^\d{4}-\d{2}-\d{2}T/.test(v) ? v : new Date().toISOString());

emp.rows.forEach((r, i) => {
  const row = i + 2;
  if (isBlankRow(r)) return;
  let id = trimmed(r, 0);
  const name = trimmed(r, 1);
  if (!name) return issue("users", row, "Employee row without name", "skipped");
  if (!cell(r, 3)) issue("users", row, `Employee "${name}" has no password hash`, "imported; cannot log in until an admin resets the password");
  if (!id) { id = newId(6); issue("users", row, `Employee "${name}" had no EmployeeID`, `assigned ${id}`); }
  if (seenIds.has(id)) return issue("users", row, `Duplicate EmployeeID ${id} ("${name}")`, "skipped (legacy login used the first row)");
  seenIds.add(id);
  if (seenNames.employee.has(name)) issue("users", row, `Duplicate employee name "${name}" (also row ${seenNames.employee.get(name)})`, "imported both; name-based features match both");
  seenNames.employee.set(name, row);
  const hr = {};
  for (const [k, v] of Object.entries(HR)) if (cell(r, +k)) hr[v] = cell(r, +k);
  for (const [k, kind] of Object.entries(DOCS)) if (trimmed(r, +k)) docRows.push([id, kind, fileRef(cell(r, +k))]);
  const desig = designationOf(r);
  if (!trimmed(r, DESIG) && !trimmed(r, 10)) issue("users", row, `Employee "${name}" has a blank Designation column`, desig ? `guessed "${desig}" (legacy heuristic) — please verify; training assignment depends on it` : "left blank — only COMMON trainings will be assigned");
  userRows.push([id, "employee", name, trimmed(r, 2), cell(r, 3), cell(r, DEPT) || cell(r, 4), desig, cell(r, 6), cell(r, 7), cell(r, 8), fileRef(cell(r, 9)), cell(r, 11), cell(r, 17), cell(r, 18), cell(r, 19), JSON.stringify(hr), isoOr(cell(r, 5))]);
});

const adm = await loadGrid(DIR, "admin");
adm.rows.forEach((r, i) => {
  const row = i + 2;
  if (isBlankRow(r)) return;
  let id = trimmed(r, 0);
  const name = trimmed(r, 1);
  if (!name) return issue("users", row, "Admin row without name", "skipped");
  if (!id) { id = newId(6); issue("users", row, `Admin "${name}" had no ID`, `assigned ${id}`); }
  if (seenIds.has(id)) {
    const fresh = `A${newId(5)}`;
    issue("users", row, `Admin ID ${id} ("${name}") collides with another user`, `admin re-numbered to ${fresh} — tell them their new login ID`);
    id = fresh;
  }
  seenIds.add(id);
  userRows.push([id, "admin", name, trimmed(r, 2), cell(r, 3), cell(r, 4), "", cell(r, 6), "", "", "", "", "", "", "", "{}", isoOr(cell(r, 5))]);
});
insert("users", userCols, userRows);
if (docRows.length) {
  report.counts.user_documents = docRows.length;
  for (const [eid, kind, ref] of docRows) sql.push(`INSERT INTO user_documents (user_id, kind, file_ref) SELECT id, ${q(kind)}, ${q(ref)} FROM users WHERE employee_id = ${q(eid)};`);
}

// =====================================================================
// DELEGATIONS
// =====================================================================
{
  const g = await loadGrid(DIR, "delegation");
  const seen = new Set();
  const rows = [];
  g.rows.forEach((r, i) => {
    const row = i + 2;
    if (isBlankRow(r)) return;
    let id = trimmed(r, 0);
    if (!trimmed(r, 1) && !trimmed(r, 2)) return issue("delegations", row, "Row without doer and task", "skipped");
    if (!id) { id = newId(6); issue("delegations", row, "Missing TaskID", `assigned ${id}`); }
    if (seen.has(id)) { const n = newId(6); issue("delegations", row, `Duplicate TaskID ${id}`, `re-numbered to ${n}`); id = n; }
    seen.add(id);
    rows.push([id, cell(r, 1), cell(r, 2), cell(r, 3), cell(r, 4), cell(r, 5), cell(r, 6), cell(r, 7), parseInt(cell(r, 8)) || 0, cell(r, 9), cell(r, 10) || "Pending", cell(r, 11), cell(r, 12), cell(r, 13) || "Pending", JSON.stringify(r.slice(14, 18))]);
  });
  insert("delegations", ["task_id", "name", "task_name", "created_date", "deadline", "revision1", "revision2", "final_date", "revisions", "priority", "status", "followup", "done_week", "approval", "extra"], rows);
}

// =====================================================================
// CHECKLIST — Master (+ Consolidated done dates) and MasterTasks templates
// =====================================================================
{
  const cons = await loadGrid(DIR, "checklist_consolidated");
  const doneAt = new Map(cons.rows.filter((r) => trimmed(r, 0)).map((r) => [trimmed(r, 0), cell(r, 1)]));
  const g = await loadGrid(DIR, "checklist_master");
  const seen = new Set(), slots = new Set();
  const rows = [];
  g.rows.forEach((r, i) => {
    const row = i + 2;
    if (isBlankRow(r)) return; // rows cleared by the legacy DELETE
    let id = trimmed(r, 3);
    if (!trimmed(r, 0) || !trimmed(r, 5)) return issue("checklist_tasks", row, "Row without name or task", "skipped");
    if (!id) { id = newId(6); issue("checklist_tasks", row, "Missing TaskID", `assigned ${id}`); }
    if (seen.has(id)) { const n = newId(6); issue("checklist_tasks", row, `Duplicate TaskID ${id}`, `re-numbered to ${n}`); id = n; }
    const slot = `${cell(r, 0)}|${cell(r, 5)}|${cell(r, 6)}`;
    if (slots.has(slot)) return issue("checklist_tasks", row, `Duplicate slot (${cell(r, 0)} / ${cell(r, 5)} / ${cell(r, 6)})`, "skipped (exact duplicate of an earlier row)");
    seen.add(id); slots.add(slot);
    const actual = cell(r, 7) || doneAt.get(trimmed(r, 3)) || "";
    rows.push([id, cell(r, 0), cell(r, 1), cell(r, 2), cell(r, 4), cell(r, 5), cell(r, 6), actual, cell(r, 8), cell(r, 9), cell(r, 10)]);
  });
  insert("checklist_tasks", ["task_id", "name", "email", "department", "freq", "task", "planned", "actual", "source", "template_id", "archive"], rows);

  const t = await loadGrid(DIR, "checklist_templates");
  const tpl = [];
  const tSeen = new Set();
  t.rows.forEach((r, i) => {
    const row = i + 2;
    if (isBlankRow(r)) return;
    const freq = trimmed(r, 5).toUpperCase().charAt(0);
    if (!trimmed(r, 0) || !trimmed(r, 4)) return issue("checklist_templates", row, "Row without TemplateID or task", "skipped");
    if (!["D", "W", "M", "Y"].includes(freq)) return issue("checklist_templates", row, `Unknown frequency "${cell(r, 5)}"`, "skipped");
    if (tSeen.has(trimmed(r, 0))) return issue("checklist_templates", row, `Duplicate TemplateID ${trimmed(r, 0)}`, "skipped");
    tSeen.add(trimmed(r, 0));
    tpl.push([trimmed(r, 0), cell(r, 1), cell(r, 2), cell(r, 3), cell(r, 4), freq, cell(r, 6), trimmed(r, 8) || "active", isoOr(cell(r, 7))]);
  });
  insert("checklist_templates", ["template_id", "name", "email", "department", "task", "freq", "day_or_date", "status", "created_at"], tpl);
}

// =====================================================================
// TICKETS
// =====================================================================
const ticketNum = (id) => (/^#\d+$/.test(id) ? parseInt(id.slice(1), 10) : 0);
{
  const g = await loadGrid(DIR, "help_tickets");
  const seen = new Set();
  const rows = [];
  let max = 0;
  g.rows.forEach((r) => { max = Math.max(max, ticketNum(trimmed(r, 0))); });
  g.rows.forEach((r, i) => {
    const row = i + 2;
    if (isBlankRow(r)) return;
    let id = trimmed(r, 0);
    if (!id || seen.has(id)) { const n = `#${String(++max).padStart(5, "0")}`; issue("help_tickets", row, id ? `Duplicate TicketID ${id}` : "Missing TicketID", `re-numbered to ${n}`); id = n; }
    seen.add(id);
    rows.push([id, cell(r, 1), cell(r, 2), cell(r, 3), cell(r, 4) || "Pending", cell(r, 5), cell(r, 6), fileRef(cell(r, 7))]);
  });
  insert("help_tickets", ["ticket_id", "created_by", "assigned_to", "issue", "status", "created_date", "done_date", "issue_photo"], rows);
  sql.push(`UPDATE counters SET value = ${max} WHERE name = 'help_ticket';`);
}
{
  const g = await loadGrid(DIR, "support_tickets");
  const seen = new Set();
  const rows = [];
  let max = 0;
  g.rows.forEach((r) => { max = Math.max(max, ticketNum(trimmed(r, 0))); });
  g.rows.forEach((r, i) => {
    const row = i + 2;
    if (isBlankRow(r)) return;
    let id = trimmed(r, 0);
    if (!id || seen.has(id)) { const n = `#${String(++max).padStart(5, "0")}`; issue("support_tickets", row, id ? `Duplicate TicketID ${id}` : "Missing TicketID", `re-numbered to ${n}`); id = n; }
    seen.add(id);
    // Legacy grouped "the same ticket across MIS staff" by identical Issue text.
    const group = `legacy:${cell(r, 3).trim()}`;
    rows.push([id, group, cell(r, 1), cell(r, 2), cell(r, 3), cell(r, 4) || "Pending", cell(r, 5), cell(r, 6), fileRef(cell(r, 7)), cell(r, 8), cell(r, 9) || "Pending", cell(r, 10), cell(r, 11), cell(r, 12), cell(r, 13), cell(r, 14)]);
  });
  insert("support_tickets", ["ticket_id", "group_key", "created_by", "assigned_to", "issue", "status", "created_date", "done_date", "issue_photo", "work_by", "approval", "col_k", "col_l", "problem", "solution", "department"], rows);
  sql.push(`UPDATE counters SET value = ${max} WHERE name = 'support_ticket';`);
}

// =====================================================================
// WORKLIST
// =====================================================================
{
  const g = await loadGrid(DIR, "worklist");
  const VALID = ["Daily", "Weekly", "Monthly", "Yearly"];
  const seen = new Set();
  const rows = [];
  g.rows.forEach((r, i) => {
    const row = i + 2;
    if (isBlankRow(r)) return;
    let id = trimmed(r, 0);
    const f = VALID.find((v) => v.toLowerCase() === trimmed(r, 3).toLowerCase());
    if (!f) return issue("worklists", row, `Invalid frequency "${cell(r, 3)}" for "${cell(r, 2)}"`, "skipped");
    if (!id || seen.has(id)) { const n = newId(8); issue("worklists", row, id ? `Duplicate WorkListId ${id}` : "Missing WorkListId", `assigned ${n}`); id = n; }
    seen.add(id);
    rows.push([id, cell(r, 1), cell(r, 2), f, cell(r, 4), cell(r, 5), cell(r, 6), cell(r, 7), cell(r, 8), cell(r, 9), i + 1]);
  });
  insert("worklists", ["worklist_id", "employee_name", "worklist_name", "frequency", "working_time", "template_link", "remark", "schedule_days", "schedule_dates", "ai_time", "position"], rows);
}

// =====================================================================
// TRAINING
// =====================================================================
{
  const m = await loadGrid(DIR, "training_master");
  const templates = new Map(); // id -> {desig, name, score, approval, indices[]}
  m.rows.forEach((r, i) => {
    if (isBlankRow(r)) return;
    const id = trimmed(r, 0);
    if (!id) return issue("training_indices", i + 2, "Index row without Template ID", "skipped");
    if (!templates.has(id)) templates.set(id, { desig: "", name: "", score: "", approval: "Pending", indices: [] });
    const t = templates.get(id);
    if (trimmed(r, 1)) t.desig = trimmed(r, 1);
    if (!t.name) t.name = cell(r, 7) || cell(r, 2);
    if (!t.score && cell(r, 5)) t.score = cell(r, 5);
    if (cell(r, 6)) t.approval = cell(r, 6); // approval was written to every index row
    t.indices.push([cell(r, 2) || `Index ${t.indices.length + 1}`, cell(r, 3), cell(r, 4)]);
  });
  const tRows = [], iRows = [];
  for (const [id, t] of templates) {
    if (!t.desig) issue("training_templates", "-", `Template ${id} has no designation`, "imported with blank designation — not assigned to anyone until an admin sets one");
    tRows.push([id, t.desig, t.name, t.score || "100", t.approval === "Approved" ? "Approved" : "Pending"]);
    t.indices.forEach((ix, n) => iRows.push([id, n + 1, ...ix]));
  }
  insert("training_templates", ["template_id", "designation", "training_name", "score", "approval"], tRows);
  insert("training_indices", ["template_id", "position", "index_name", "document", "video"], iRows);

  const qa = await loadGrid(DIR, "training_qa");
  const seenQa = new Set();
  const qRows = [];
  qa.rows.forEach((r, i) => {
    const row = i + 2;
    if (isBlankRow(r)) return;
    const tid = trimmed(r, 0);
    if (!templates.has(tid)) return issue("training_questions", row, `Question for unknown/deleted template "${tid}"`, "skipped (orphan)");
    let id = trimmed(r, 1);
    if (!id || seenQa.has(id)) { const n = `QA-${newId(8).toUpperCase()}`; issue("training_questions", row, id ? `Duplicate QA ID ${id}` : "Missing QA ID", `assigned ${n}`); id = n; }
    seenQa.add(id);
    if (!trimmed(r, 2) || !trimmed(r, 7)) return issue("training_questions", row, "Question without text or correct option", "skipped");
    qRows.push([id, tid, cell(r, 2), cell(r, 3), cell(r, 4), cell(r, 5), cell(r, 6), trimmed(r, 7), i + 1]);
  });
  insert("training_questions", ["qa_id", "template_id", "question", "option_a", "option_b", "option_c", "option_d", "correct_option", "position"], qRows);

  const et = await loadGrid(DIR, "training_records");
  const seenRec = new Set();
  const rRows = [];
  const n = (v) => parseInt(v || "0", 10) || 0;
  et.rows.forEach((r, i) => {
    const row = i + 2;
    if (isBlankRow(r)) return;
    const key = `${cell(r, 0)}|||${cell(r, 3)}`;
    if (!trimmed(r, 0) || !trimmed(r, 3)) return issue("training_records", row, "Record without employee or template", "skipped");
    if (seenRec.has(key)) return issue("training_records", row, `Duplicate record ${cell(r, 0)} / ${cell(r, 3)}`, "skipped (legacy read the first one)");
    seenRec.add(key);
    let progress = cell(r, 15) || "{}";
    try { JSON.parse(progress); } catch { issue("training_records", row, "Unreadable progress JSON", "reset to {}"); progress = "{}"; }
    rRows.push([cell(r, 0), cell(r, 1), cell(r, 2), cell(r, 3), n(cell(r, 4)), n(cell(r, 5)), n(cell(r, 6)), n(cell(r, 7)), cell(r, 8) || "In Progress", cell(r, 9), cell(r, 10), cell(r, 11), cell(r, 12), cell(r, 13), cell(r, 14), progress]);
  });
  insert("training_records", ["employee_name", "designation", "template_name", "template_id", "document_score", "video_score", "qa_score", "total_score", "status", "start_date", "end_date", "last_update", "tools_documents", "tools_translite", "tools_summary", "progress"], rRows);
}

// =====================================================================
// ADDITIONAL FEATURES + EM SHEET
// =====================================================================
{
  const g = await loadGrid(DIR, "additional_feature");
  insert("additional_features", ["added_by", "feature_name", "feature_url", "created_at"],
    g.rows.filter((r) => !isBlankRow(r) && trimmed(r, 0)).map((r) => [cell(r, 0), cell(r, 1), cell(r, 2), isoOr(cell(r, 3))]));
}
{
  const src = existsSync(`${DIR}/sheets/em_sheet.json`) ? JSON.parse(await readFile(`${DIR}/sheets/em_sheet.json`, "utf8")).rows : null;
  if (src) insert("em_sheet_rows", ["row_index", "cells"], src.map((r, i) => [i, JSON.stringify(Array.from({ length: 13 }, (_, k) => String(r[k] ?? "")))]));
}

// =====================================================================
// Cross-checks (names referenced by work items but not present in users)
// =====================================================================
const known = new Set(userRows.map((u) => u[2].trim().toLowerCase()));
const refs = new Map();
const note = (name, where) => { const k = String(name || "").trim(); if (k && !known.has(k.toLowerCase())) refs.set(k, (refs.get(k) || new Set()).add(where)); };
for (const k of ["delegation", "help_tickets", "support_tickets", "worklist", "checklist_master"]) {
  const g = await loadGrid(DIR, k);
  const cols = { delegation: [1], help_tickets: [1, 2], support_tickets: [1, 2], worklist: [1], checklist_master: [0] }[k];
  for (const r of g.rows) for (const c of cols) note(r[c], k);
}
report.unknownPeople = [...refs].map(([name, w]) => ({ name, referencedIn: [...w] }));

const header = `-- Generated by migration/transform.mjs at ${report.generatedAt}\n-- Apply to an EMPTY database that already has migrations/0001_initial.sql applied.\nPRAGMA defer_foreign_keys = true;\n`;
await writeFile(`${DIR}/seed.sql`, header + sql.join("\n") + "\n");
await writeFile(`${DIR}/report.json`, JSON.stringify(report, null, 2));
console.table(report.counts);
console.log(`Issues: ${report.issues.length} | Cloudinary files not yet in R2: ${report.unmigratedFiles} | Unknown people referenced: ${report.unknownPeople.length}`);
console.log(`Wrote ${DIR}/seed.sql and ${DIR}/report.json`);

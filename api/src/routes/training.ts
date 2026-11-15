import { Hono, type Context } from "hono";
import type { AppEnv } from "../types";
import { isAdmin, requireAdmin, requireAuth } from "../middleware/auth";
import { dateDMY, nowStamp } from "../lib/dates";
import { designationOf } from "../lib/users";
import { fail, jsonBody, nanoid, parseNum, str } from "../lib/util";
import { audit } from "../lib/audit";

// Port of routes/training.js. Assignment rule (unchanged): every employee gets
// all APPROVED "COMMON" templates + approved templates of their DESIGNATION.
// Learning rule (unchanged): each document/video needs 2 self views + 2 views
// with the doer, indices unlock sequentially, QA is scored server-side.

export const trainingRoutes = new Hono<AppEnv>();
trainingRoutes.use("*", requireAuth);

const REQUIRED_SELF = 2;
const REQUIRED_WITH_DOER = 2;
const norm = (d: unknown) => str(d).trim().toUpperCase();
const isCommon = (d: unknown) => norm(d) === "COMMON";
const same = (a: unknown, b: unknown) => norm(a) === norm(b);

// ---------------------------------------------------------------------
// Data access
// ---------------------------------------------------------------------
interface Template {
  TemplateId: string; Department: string; Designation: string; TemplateName: string; TemplateScore: string;
  Approval: string; indices: { IndexName: string; Document: string; Video: string }[]; QuestionCount?: number;
}

async function loadTemplates(c: Context<AppEnv>): Promise<Template[]> {
  const [tpls, idx] = await c.env.DB.batch([
    c.env.DB.prepare("SELECT * FROM training_templates ORDER BY rowid"),
    c.env.DB.prepare("SELECT * FROM training_indices ORDER BY template_id, position, id"),
  ]);
  const byTpl = new Map<string, any[]>();
  for (const i of idx.results as any[]) {
    if (!byTpl.has(i.template_id)) byTpl.set(i.template_id, []);
    byTpl.get(i.template_id)!.push({ IndexName: i.index_name, Document: i.document, Video: i.video });
  }
  return (tpls.results as any[]).map((t) => ({
    TemplateId: t.template_id,
    Department: t.designation,
    Designation: t.designation,
    TemplateName: t.training_name,
    TemplateScore: t.score,
    Approval: t.approval || "Pending",
    indices: byTpl.get(t.template_id) || [],
  }));
}

async function questionCounts(c: Context<AppEnv>): Promise<Map<string, number>> {
  const { results } = await c.env.DB.prepare("SELECT template_id, COUNT(*) AS n FROM training_questions GROUP BY template_id").all<{ template_id: string; n: number }>();
  return new Map(results.map((r) => [r.template_id, r.n]));
}

const mapQa = (r: any) => ({
  TemplateId: r.template_id, QaId: r.qa_id, Question: r.question, OptionA: r.option_a, OptionB: r.option_b,
  OptionC: r.option_c, OptionD: r.option_d, CorrectOption: r.correct_option,
});

interface RecordRow {
  id: number; employee_name: string; designation: string; template_name: string; template_id: string;
  document_score: number; video_score: number; qa_score: number; total_score: number; status: string;
  start_date: string; end_date: string; last_update: string; tools_documents: string; tools_translite: string;
  tools_summary: string; progress: string;
}

function mapRecord(r: RecordRow) {
  let progress: any = {};
  try { progress = JSON.parse(r.progress || "{}") || {}; } catch { progress = {}; }
  return {
    EmployeeName: r.employee_name, Department: r.designation, Designation: r.designation,
    TemplateName: r.template_name, TemplateId: r.template_id,
    DocumentScore: parseNum(r.document_score), VideoScore: parseNum(r.video_score),
    QaScore: parseNum(r.qa_score), TotalScore: parseNum(r.total_score),
    Status: r.status || "Pending", StartDate: r.start_date, EndDate: r.end_date, LastUpdate: r.last_update,
    ToolsDocuments: r.tools_documents, ToolsTranslite: r.tools_translite, ToolsSummary: r.tools_summary,
    Progress: progress,
  };
}

const loadRecords = async (c: Context<AppEnv>) =>
  (await c.env.DB.prepare("SELECT * FROM training_records ORDER BY id").all<RecordRow>()).results.map(mapRecord);

const loadEmployees = async (c: Context<AppEnv>) =>
  (await c.env.DB.prepare("SELECT name, department, designation FROM users WHERE role='employee' AND is_active=1 AND trim(name) != '' ORDER BY id")
    .all<{ name: string; department: string; designation: string }>()).results;

// ---------------------------------------------------------------------
// Assignment engine (unchanged business rules)
// ---------------------------------------------------------------------
const assignedFor = (approved: Template[], emp: { designation: string }) => [
  ...approved.filter((t) => isCommon(t.Designation)),
  ...approved.filter((t) => !isCommon(t.Designation) && same(t.Designation, emp.designation)),
];

function buildAssignedView(employees: { name: string; department: string; designation: string }[], approved: Template[], records: ReturnType<typeof mapRecord>[]) {
  const recMap = new Map(records.map((r) => [`${r.EmployeeName}|||${r.TemplateId}`, r]));
  const rows: any[] = [];
  for (const emp of employees) {
    for (const t of assignedFor(approved, emp)) {
      const rec = recMap.get(`${emp.name}|||${t.TemplateId}`);
      rows.push({
        EmployeeName: emp.name, Department: emp.department, Designation: emp.designation,
        TemplateId: t.TemplateId, TemplateName: t.TemplateName,
        TemplateDepartment: t.Designation, TemplateDesignation: t.Designation,
        Type: isCommon(t.Designation) ? "Common" : "Designation",
        DocumentScore: rec ? rec.DocumentScore : 0, VideoScore: rec ? rec.VideoScore : 0,
        QaScore: rec ? rec.QaScore : 0, TotalScore: rec ? rec.TotalScore : 0,
        Status: rec ? rec.Status : "Pending", Started: !!rec,
        StartDate: rec ? rec.StartDate : "", EndDate: rec ? rec.EndDate : "", LastUpdate: rec ? rec.LastUpdate : "",
      });
    }
  }
  return rows;
}

function summarizeAssigned(rows: any[]) {
  const mk = (arr: any[]) => {
    const groups = new Map<string, any[]>();
    for (const r of arr) {
      if (!groups.has(r.TemplateId)) groups.set(r.TemplateId, []);
      groups.get(r.TemplateId)!.push(r);
    }
    const g = [...groups.values()];
    const assigned = g.length;
    const completed = g.filter((rs) => rs.every((r) => r.Status === "Completed")).length;
    const inProgress = g.filter((rs) => rs.every((r) => r.Status !== "Completed") && rs.some((r) => r.Started || r.Status === "In Progress")).length;
    return {
      assigned, started: g.filter((rs) => rs.some((r) => r.Started)).length, completed, inProgress,
      pending: Math.max(0, assigned - completed - inProgress),
      totalMax: arr.length * 300, totalEarned: arr.reduce((s, r) => s + parseNum(r.TotalScore), 0),
    };
  };
  const common = mk(rows.filter((r) => r.Type === "Common"));
  const dept = mk(rows.filter((r) => r.Type !== "Common"));
  const total: any = {};
  for (const k of Object.keys(common) as (keyof typeof common)[]) total[k] = common[k] + dept[k];
  return { common, dept, total };
}

function applyScope(rows: any[], scope?: string) {
  if (!scope || scope === "all") return rows;
  if (scope.toLowerCase() === "common") return rows.filter((r) => r.Type === "Common");
  return rows.filter((r) => r.Type !== "Common" && same(r.TemplateDesignation, scope));
}

// ---------------------------------------------------------------------
// GET
// ---------------------------------------------------------------------
trainingRoutes.get("/templates", requireAdmin, async (c) => {
  const { department, designation, approval } = c.req.query();
  const f = designation || department;
  let templates = await loadTemplates(c);
  if (f && f !== "all") templates = templates.filter((t) => same(t.Designation, f));
  if (approval && approval !== "all") templates = templates.filter((t) => t.Approval === approval);
  const qc = await questionCounts(c);
  for (const t of templates) t.QuestionCount = qc.get(t.TemplateId) || 0;
  return c.json({ ok: true, templates, total: templates.length });
});

trainingRoutes.get("/templates/approved", async (c) => {
  const { department, designation } = c.req.query();
  const f = designation || department;
  let templates = (await loadTemplates(c)).filter((t) => t.Approval === "Approved");
  if (f && f !== "all") templates = templates.filter((t) => isCommon(t.Designation) || same(t.Designation, f));
  templates.sort((a, b) => (isCommon(a.Designation) === isCommon(b.Designation) ? 0 : isCommon(a.Designation) ? -1 : 1));
  const qc = await questionCounts(c);
  for (const t of templates) t.QuestionCount = qc.get(t.TemplateId) || 0;
  return c.json({ ok: true, templates, total: templates.length });
});

const listDesignations = async (c: Context<AppEnv>) => {
  const { results } = await c.env.DB.prepare("SELECT DISTINCT trim(designation) AS d FROM training_templates WHERE trim(designation) != '' ORDER BY d").all<{ d: string }>();
  const list = results.map((r) => r.d);
  return c.json({ ok: true, departments: list, designations: list });
};
trainingRoutes.get("/templates/departments", listDesignations);
trainingRoutes.get("/templates/designations", listDesignations);

/** Correct answers are only ever returned to admins. */
trainingRoutes.get("/qa/:templateId", async (c) => {
  const { results } = await c.env.DB.prepare("SELECT * FROM training_questions WHERE template_id = ? ORDER BY position, rowid")
    .bind(c.req.param("templateId")).all();
  const questions = results.map(mapQa);
  if (c.req.query("forTest") === "1" || !isAdmin(c)) for (const q of questions) q.CorrectOption = "";
  return c.json({ ok: true, questions, total: questions.length });
});

trainingRoutes.get("/records", requireAdmin, async (c) => {
  const { employeeName, status, scope } = c.req.query();
  const [templates, employees, records] = await Promise.all([loadTemplates(c), loadEmployees(c), loadRecords(c)]);
  const approved = templates.filter((t) => t.Approval === "Approved");
  const emps = employeeName && employeeName !== "all" ? employees.filter((e) => e.name === employeeName) : employees;
  const scoped = applyScope(buildAssignedView(emps, approved, records), scope);
  const summary = summarizeAssigned(scoped);
  let rows = scoped.map((r) => ({ ...r }));
  if (status && status !== "all") rows = rows.filter((r) => r.Status === status);
  rows.sort((a, b) => (b.LastUpdate || "").localeCompare(a.LastUpdate || ""));
  return c.json({ ok: true, records: rows, total: rows.length, summary });
});

trainingRoutes.get("/records/summary", requireAdmin, async (c) => {
  const { employeeName, scope, department } = c.req.query();
  const active = scope && scope !== "all" ? scope
    : department && department !== "all" ? (department.toLowerCase() === "common" ? "common" : department) : "all";
  const [templates, employees, records] = await Promise.all([loadTemplates(c), loadEmployees(c), loadRecords(c)]);
  const approved = templates.filter((t) => t.Approval === "Approved");
  const emps = employeeName && employeeName !== "all" ? employees.filter((e) => e.name === employeeName) : employees;
  const scoped = applyScope(buildAssignedView(emps, approved, records), active);
  const commonRows = scoped.filter((r) => r.Type === "Common");
  const deptRows = scoped.filter((r) => r.Type !== "Common");
  return c.json({
    ok: true,
    summary: {
      ...summarizeAssigned(scoped),
      templateCounts: {
        common: approved.filter((t) => isCommon(t.Department)).length,
        dept: approved.filter((t) => !isCommon(t.Department)).length,
        total: approved.length,
      },
      employeeCount: emps.length,
      commonAssigned: commonRows.length,
      deptAssigned: deptRows.length,
      commonCompleted: commonRows.filter((r) => r.Status === "Completed").length,
      deptCompleted: deptRows.filter((r) => r.Status === "Completed").length,
    },
  });
});

trainingRoutes.get("/my", async (c) => {
  const me = c.get("user");
  const [templates, records] = await Promise.all([loadTemplates(c), loadRecords(c)]);
  const approved = templates.filter((t) => t.Approval === "Approved");
  const designation = (await designationOf(c.env, me.name)) || me.designation;
  const assigned = buildAssignedView([{ name: me.name, department: me.department, designation }], approved, records);
  const progress = new Map(records.filter((r) => r.EmployeeName === me.name).map((r) => [r.TemplateId, r.Progress]));
  const rows = assigned.map((r) => ({ ...r, Progress: progress.get(r.TemplateId) || {} }));
  return c.json({ ok: true, records: rows, total: rows.length, summary: summarizeAssigned(assigned) });
});

// ---------------------------------------------------------------------
// ADMIN writes
// ---------------------------------------------------------------------
const cleanQ = (q: any) => ({
  question: str(q.question).trim(), optionA: str(q.optionA).trim(), optionB: str(q.optionB).trim(),
  optionC: str(q.optionC).trim(), optionD: str(q.optionD).trim(), correctOption: str(q.correctOption || "A").trim().toUpperCase(),
});
const qaInsert = (c: Context<AppEnv>, templateId: string, q: ReturnType<typeof cleanQ>, qaId = `QA-${nanoid(8).toUpperCase()}`) =>
  c.env.DB.prepare(
    `INSERT INTO training_questions (qa_id, template_id, question, option_a, option_b, option_c, option_d, correct_option, position)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(position), 0) + 1 FROM training_questions WHERE template_id = ?))`,
  ).bind(qaId, templateId, q.question, q.optionA, q.optionB, q.optionC, q.optionD, q.correctOption, templateId);

trainingRoutes.post("/templates", requireAdmin, async (c) => {
  const { department, designation, name, templateScore, indices, questions } = await jsonBody(c.req);
  const desig = str(designation || department).trim();
  if (!desig || !name) fail(400, "Designation and Template Name are required");
  if (!Array.isArray(indices) || !indices.length) fail(400, "At least one Index is required");
  const templateId = `TMP-${nanoid(8).toUpperCase()}`;
  const stmts: D1PreparedStatement[] = [
    c.env.DB.prepare("INSERT INTO training_templates (template_id, designation, training_name, score, approval) VALUES (?, ?, ?, ?, 'Pending')")
      .bind(templateId, desig, String(name), String(templateScore || 100)),
    ...indices.map((idx: any, i: number) => c.env.DB.prepare(
      "INSERT INTO training_indices (template_id, position, index_name, document, video) VALUES (?, ?, ?, ?, ?)",
    ).bind(templateId, i + 1, str(idx.name).trim() || `Index ${i + 1}`, str(idx.document), str(idx.video))),
  ];
  let added = 0;
  for (const q of Array.isArray(questions) ? questions : []) {
    if (!q.question || !q.correctOption) continue;
    stmts.push(qaInsert(c, templateId, { ...cleanQ(q), correctOption: str(q.correctOption) }));
    added++;
  }
  await c.env.DB.batch(stmts);
  await audit(c.env, c.get("user").employeeID, "create", "training_template", templateId);
  return c.json({ ok: true, templateId, message: "Template saved (Pending approval)", questionsAdded: added });
});

trainingRoutes.post("/indices", requireAdmin, async (c) => {
  const { templateId, name, document, video } = await jsonBody(c.req);
  if (!templateId || !name) fail(400, "templateId and index name are required");
  const t = await c.env.DB.prepare("SELECT 1 FROM training_templates WHERE template_id = ?").bind(templateId).first();
  if (!t) fail(404, "Template not found");
  await c.env.DB.prepare(
    `INSERT INTO training_indices (template_id, position, index_name, document, video)
     VALUES (?, (SELECT COALESCE(MAX(position), 0) + 1 FROM training_indices WHERE template_id = ?), ?, ?, ?)`,
  ).bind(templateId, templateId, String(name).trim(), str(document), str(video)).run();
  return c.json({ ok: true, message: "Index added" });
});

trainingRoutes.post("/qa", requireAdmin, async (c) => {
  const b = await jsonBody(c.req);
  if (!b.templateId || !b.question || !b.correctOption) fail(400, "templateId, question and correctOption are required");
  const qaId = `QA-${nanoid(8).toUpperCase()}`;
  await qaInsert(c, b.templateId, { ...cleanQ(b), question: String(b.question), correctOption: String(b.correctOption) }, qaId).run();
  return c.json({ ok: true, qaId, message: "Question added" });
});

trainingRoutes.post("/qa/bulk", requireAdmin, async (c) => {
  const { templateId, questions } = await jsonBody(c.req);
  if (!templateId) fail(400, "templateId is required");
  if (!Array.isArray(questions) || !questions.length) fail(400, "questions array is required");
  const clean = questions.map(cleanQ).filter((q) => q.question && q.optionA && q.optionB && ["A", "B", "C", "D"].includes(q.correctOption));
  if (!clean.length) fail(400, "Koi valid question nahi mila (Question + A + B + Correct A/B/C/D chahiye)");
  // sequential so positions stay ordered
  for (const q of clean) await qaInsert(c, templateId, q).run();
  return c.json({ ok: true, added: clean.length, message: `${clean.length} questions added` });
});

/** Heuristic draft generator (unchanged; no paid AI). See docs/ROADMAP.md for Workers AI upgrade. */
trainingRoutes.post("/qa/ai-generate", requireAdmin, async (c) => {
  const { topic, department, designation, count, documents, videos } = await jsonBody(c.req);
  const n = Math.max(1, Math.min(20, parseInt(count, 10) || 5));
  const docs = Array.isArray(documents) ? documents.filter(Boolean) : [];
  const vids = Array.isArray(videos) ? videos.filter(Boolean) : [];
  const title = str(topic || designation || department || "Training").trim() || "Training";
  const slug = (u: unknown) => {
    try {
      const p = str(u).split("?")[0].split("#")[0].split("/").filter(Boolean);
      return decodeURIComponent(p[p.length - 1] || "link").replace(/[-_+]+/g, " ").slice(0, 60) || "link";
    } catch { return "link"; }
  };
  const sources = [...docs.map((d: unknown) => ({ kind: "Document", label: slug(d) })), ...vids.map((v: unknown) => ({ kind: "Video", label: slug(v) }))];
  const bank = [
    (s: any, i: number) => ({ question: `${title}: ${s.kind} "${s.label}" ka mukhya uddeshya kya hai? (Q${i + 1})`, optionA: `${s.kind} me di gayi process ko step-by-step follow karna`, optionB: `${s.kind} ko bina dekhe kaam shuru kar dena`, optionC: `Sirf pehla page dekhna aur baaki skip karna`, optionD: `${s.kind} ko kisi aur ko forward karke bhool jana`, correctOption: "A" }),
    (s: any, i: number) => ({ question: `${title}: ${s.kind} dekhne/padhne ke baad pehla sahi kadam kya hoga? (Q${i + 1})`, optionA: `Apne doer ke saath discuss karke practical me apply karna`, optionB: `Kuch na karna aur next training ka wait karna`, optionC: `Bina samjhe QA test de dena`, optionD: `Document/video delete kar dena`, correctOption: "A" }),
    (s: any, i: number) => ({ question: `${title}: safety/quality ke hisaab se "${s.label}" me sabse mahatvapurna baat kya hai? (Q${i + 1})`, optionA: `Bataye gaye safety aur quality steps ka paalan karna`, optionB: `Shortcut lena taaki kaam jaldi ho`, optionC: `Safety steps ko optional samajhna`, optionD: `Bina PPE ke kaam karna`, correctOption: "A" }),
    (s: any, i: number) => ({ question: `${title}: agar "${s.label}" me koi step samajh na aaye to kya karna chahiye? (Q${i + 1})`, optionA: `Apne doer/supervisor se poochhkar clear karna`, optionB: `Andaza lagakar kaam kar lena`, optionC: `Us step ko chhod dena`, optionD: `Kisi ko bataye bina ruk jana`, correctOption: "A" }),
  ];
  const questions = Array.from({ length: n }, (_, i) => bank[i % bank.length](sources.length ? sources[i % sources.length] : { kind: "Training", label: title }, i));
  return c.json({ ok: true, questions, total: questions.length, note: "AI draft — admin edit/remove karke Save kare" });
});

trainingRoutes.put("/templates/approve/:templateId", requireAdmin, async (c) => {
  const { approval } = await jsonBody(c.req);
  if (!["Approved", "Pending"].includes(approval)) fail(400, "approval must be Approved or Pending");
  const r = await c.env.DB.prepare("UPDATE training_templates SET approval = ? WHERE template_id = ?").bind(approval, c.req.param("templateId")).run();
  if (!r.meta.changes) fail(404, "Template not found");
  await audit(c.env, c.get("user").employeeID, "approve", "training_template", c.req.param("templateId"), { approval });
  return c.json({ ok: true, message: `Template ${approval === "Approved" ? "Approved" : "Moved to Pending"}` });
});

/** indexNo is the 1-based position within the template (as before). */
async function indexAt(c: Context<AppEnv>, templateId: string, indexNo: string) {
  const { results } = await c.env.DB.prepare("SELECT id FROM training_indices WHERE template_id = ? ORDER BY position, id").bind(templateId).all<{ id: number }>();
  return { all: results, target: results[parseInt(indexNo, 10) - 1] };
}

trainingRoutes.put("/indices/:templateId/:indexNo", requireAdmin, async (c) => {
  const { target } = await indexAt(c, c.req.param("templateId"), c.req.param("indexNo"));
  if (!target) fail(404, "Index not found");
  const { name, document, video } = await jsonBody(c.req);
  const sets: string[] = [], args: unknown[] = [];
  if (name) { sets.push("index_name = ?"); args.push(String(name).trim()); }
  if (document !== undefined) { sets.push("document = ?"); args.push(str(document)); }
  if (video !== undefined) { sets.push("video = ?"); args.push(str(video)); }
  if (sets.length) await c.env.DB.prepare(`UPDATE training_indices SET ${sets.join(", ")} WHERE id = ?`).bind(...args, target.id).run();
  return c.json({ ok: true, message: "Index updated" });
});

trainingRoutes.put("/qa/:qaId", requireAdmin, async (c) => {
  const b = await jsonBody(c.req);
  const cols: Record<string, string> = { question: "question", optionA: "option_a", optionB: "option_b", optionC: "option_c", optionD: "option_d", correctOption: "correct_option" };
  const sets: string[] = [], args: unknown[] = [];
  for (const [k, col] of Object.entries(cols)) if (b[k] !== undefined) { sets.push(`${col} = ?`); args.push(str(b[k])); }
  const exists = await c.env.DB.prepare("SELECT 1 FROM training_questions WHERE qa_id = ?").bind(c.req.param("qaId")).first();
  if (!exists) fail(404, "Question not found");
  if (sets.length) await c.env.DB.prepare(`UPDATE training_questions SET ${sets.join(", ")} WHERE qa_id = ?`).bind(...args, c.req.param("qaId")).run();
  return c.json({ ok: true, message: "Question updated" });
});

trainingRoutes.delete("/templates/:templateId", requireAdmin, async (c) => {
  const id = c.req.param("templateId");
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM training_questions WHERE template_id = ?").bind(id),
    c.env.DB.prepare("DELETE FROM training_indices WHERE template_id = ?").bind(id),
    c.env.DB.prepare("DELETE FROM training_templates WHERE template_id = ?").bind(id),
  ]);
  await audit(c.env, c.get("user").employeeID, "delete", "training_template", id);
  return c.json({ ok: true, message: "Template deleted" });
});

trainingRoutes.delete("/indices/:templateId/:indexNo", requireAdmin, async (c) => {
  const { all, target } = await indexAt(c, c.req.param("templateId"), c.req.param("indexNo"));
  if (all.length <= 1) fail(400, "A template must have at least one index");
  if (!target) fail(404, "Index not found");
  await c.env.DB.prepare("DELETE FROM training_indices WHERE id = ?").bind(target.id).run();
  return c.json({ ok: true, message: "Index deleted" });
});

trainingRoutes.delete("/qa/:qaId", requireAdmin, async (c) => {
  const r = await c.env.DB.prepare("DELETE FROM training_questions WHERE qa_id = ?").bind(c.req.param("qaId")).run();
  if (!r.meta.changes) fail(404, "Question not found");
  return c.json({ ok: true, message: "Question deleted" });
});

// ---------------------------------------------------------------------
// DOER: start + progress
// ---------------------------------------------------------------------
const recordFor = (c: Context<AppEnv>, name: string, templateId: string) =>
  c.env.DB.prepare("SELECT * FROM training_records WHERE employee_name = ? AND template_id = ?").bind(name, templateId).first<RecordRow>();

trainingRoutes.post("/start", async (c) => {
  const { templateId } = await jsonBody(c.req);
  if (!templateId) fail(400, "templateId is required");
  const t = await c.env.DB.prepare("SELECT * FROM training_templates WHERE template_id = ?").bind(templateId).first<any>();
  if (!t) fail(404, "Template not found");
  if (t.approval !== "Approved") fail(403, "Template is not approved yet");
  const me = c.get("user");
  const existing = await recordFor(c, me.name, templateId);
  if (existing) return c.json({ ok: true, record: mapRecord(existing), alreadyStarted: true });
  const desig = str(me.designation).trim() || (await designationOf(c.env, me.name)) || me.department;
  await c.env.DB.prepare(
    `INSERT OR IGNORE INTO training_records (employee_name, designation, template_name, template_id, status, start_date, last_update, progress)
     VALUES (?, ?, ?, ?, 'In Progress', ?, ?, '{}')`,
  ).bind(me.name, desig, t.training_name, templateId, dateDMY(), nowStamp()).run();
  return c.json({ ok: true, record: mapRecord((await recordFor(c, me.name, templateId))!), alreadyStarted: false });
});

type Slot = { self: number; withDoer: number; lastAt: number };
function views(progress: any) {
  if (!progress.views || typeof progress.views !== "object") progress.views = { doc: {}, video: {} };
  if (!progress.views.doc || typeof progress.views.doc !== "object") progress.views.doc = {};
  if (!progress.views.video || typeof progress.views.video !== "object") progress.views.video = {};
  return progress.views;
}
function getSlot(progress: any, kind: string, index: string | number): Slot {
  const v = views(progress);
  const k = kind === "doc" ? "doc" : "video";
  const cur = v[k][String(index)];
  if (typeof cur === "number") { // legacy numeric count → split self/withDoer
    const total = parseNum(cur);
    const self = Math.min(REQUIRED_SELF, total);
    v[k][String(index)] = { self, withDoer: Math.min(REQUIRED_WITH_DOER, Math.max(0, total - self)), lastAt: 0 };
    return v[k][String(index)];
  }
  if (!cur || typeof cur !== "object") { v[k][String(index)] = { self: 0, withDoer: 0, lastAt: 0 }; return v[k][String(index)]; }
  return { self: parseNum(cur.self), withDoer: parseNum(cur.withDoer), lastAt: parseNum(cur.lastAt) };
}
const viewsComplete = (p: any, kind: string, i: string) => { const s = getSlot(p, kind, i); return s.self >= REQUIRED_SELF && s.withDoer >= REQUIRED_WITH_DOER; };
const validIdx = (list: unknown[], total: number) => (list || []).filter((x) => { const n = parseInt(String(x), 10); return n >= 1 && n <= total && String(n) === String(x); }).map(String);

trainingRoutes.put("/progress", async (c) => {
  const { templateId, docIndex, videoIndex, tools, qaAnswers, viewTick } = await jsonBody(c.req);
  if (!templateId) fail(400, "templateId is required");
  const tpl = (await loadTemplates(c)).find((t) => t.TemplateId === templateId);
  if (!tpl) fail(404, "Template not found");
  const totalIndices = tpl.indices.length || 1;
  const me = c.get("user");
  const row = await recordFor(c, me.name, templateId);
  if (!row) fail(404, "Training not started. Please start training first");
  const record = mapRecord(row);
  const progress: any = record.Progress && typeof record.Progress === "object" ? record.Progress : {};
  if (!Array.isArray(progress.docs)) progress.docs = [];
  if (!Array.isArray(progress.vids)) progress.vids = [];
  views(progress);
  const { results: qaRows } = await c.env.DB.prepare("SELECT * FROM training_questions WHERE template_id = ?").bind(templateId).all<any>();

  const save = async (docScore: number, vidScore: number, qaScore: number, allDone: boolean) => {
    const next = {
      document_score: docScore, video_score: vidScore, qa_score: qaScore, total_score: docScore + vidScore + qaScore,
      status: allDone ? "Completed" : "In Progress",
      start_date: row.start_date || dateDMY(),
      end_date: allDone && !row.end_date ? dateDMY() : row.end_date,
      last_update: nowStamp(),
      tools_documents: record.ToolsDocuments, tools_translite: record.ToolsTranslite, tools_summary: record.ToolsSummary,
      progress: JSON.stringify(progress),
    };
    await c.env.DB.prepare(
      `UPDATE training_records SET document_score=?, video_score=?, qa_score=?, total_score=?, status=?, start_date=?, end_date=?,
         last_update=?, tools_documents=?, tools_translite=?, tools_summary=?, progress=? WHERE id=?`,
    ).bind(next.document_score, next.video_score, next.qa_score, next.total_score, next.status, next.start_date, next.end_date,
      next.last_update, next.tools_documents, next.tools_translite, next.tools_summary, next.progress, row.id).run();
    return c.json({ ok: true, record: mapRecord({ ...row, ...next }), completed: allDone });
  };

  // ---- view tick only (instant count, no cooldown) ----
  if (viewTick && (viewTick.kind === "doc" || viewTick.kind === "video") && viewTick.index) {
    const k = viewTick.kind;
    const key = String(viewTick.index);
    const mode: "self" | "withDoer" = viewTick.mode === "withDoer" ? "withDoer" : "self";
    const slot = getSlot(progress, k, key);
    if (mode === "self" && slot.self >= REQUIRED_SELF) fail(400, "Self views complete (2/2). Now 2 views WITH your doer are required.", { views: progress.views });
    if (mode === "withDoer" && slot.withDoer >= REQUIRED_WITH_DOER) fail(400, "With-doer views complete (2/2).", { views: progress.views });
    slot[mode] = parseNum(slot[mode]) + 1;
    slot.lastAt = Date.now();
    progress.views[k][key] = slot;
    const docs = validIdx(progress.docs, totalIndices);
    const vids = validIdx(progress.vids, totalIndices);
    const qaDone = !!(progress.qa && progress.qa.attempted);
    const qaScore = qaRows.length && qaDone ? Math.round(((progress.qa.correct || 0) / qaRows.length) * 100) : 0;
    const allDone = docs.length >= totalIndices && vids.length >= totalIndices && qaDone;
    return save(Math.round((docs.length / totalIndices) * 100), Math.round((vids.length / totalIndices) * 100), qaScore, allDone);
  }

  // ---- sequential unlock ----
  const docsSet = new Set(progress.docs.map(String));
  const vidsSet = new Set(progress.vids.map(String));
  const prevComplete = (n: string) => {
    for (let i = 1; i < parseInt(n, 10); i++) if (!(docsSet.has(String(i)) && vidsSet.has(String(i)))) return false;
    return true;
  };

  if (docIndex) {
    const d = String(docIndex);
    const n = parseInt(d, 10);
    if (n > totalIndices || n < 1) fail(400, "Invalid doc index");
    if (!prevComplete(d)) fail(400, `Pehle Index ${n - 1} complete karein (Document + Video)`);
    if (!viewsComplete(progress, "doc", d)) {
      const s = getSlot(progress, "doc", d);
      fail(400, `Document needs 2 self reads + 2 with-doer reads (self ${s.self}/2, with doer ${s.withDoer}/2). Then Mark as Read works.`, { views: progress.views });
    }
    if (!progress.docs.map(String).includes(d)) progress.docs.push(d);
  }
  if (videoIndex) {
    const v = String(videoIndex);
    const n = parseInt(v, 10);
    if (n > totalIndices || n < 1) fail(400, "Invalid video index");
    if (!progress.docs.map(String).includes(v) && String(docIndex) !== v) fail(400, "Pehle isi Index ka Document complete karein, phir Video");
    if (!prevComplete(v)) fail(400, `Pehle Index ${n - 1} complete karein (Document + Video)`);
    if (!viewsComplete(progress, "video", v)) {
      const s = getSlot(progress, "video", v);
      fail(400, `Video needs 2 self views + 2 with-doer views (self ${s.self}/2, with doer ${s.withDoer}/2). Then Mark as Watched works.`, { views: progress.views });
    }
    if (!progress.vids.map(String).includes(v)) progress.vids.push(v);
  }
  if (tools) {
    if (tools.documents !== undefined) record.ToolsDocuments = str(tools.documents);
    if (tools.translite !== undefined) record.ToolsTranslite = str(tools.translite);
    if (tools.summary !== undefined) record.ToolsSummary = str(tools.summary);
  }
  if (qaAnswers && typeof qaAnswers === "object") {
    let correct = 0;
    for (const q of qaRows) if (qaAnswers[q.qa_id] && qaAnswers[q.qa_id] === q.correct_option) correct++;
    progress.qa = { attempted: true, correct, total: qaRows.length };
  }
  progress.docs = validIdx(progress.docs, totalIndices);
  progress.vids = validIdx(progress.vids, totalIndices);
  const qaTotal = progress.qa ? parseNum(progress.qa.total) : 0;
  const qaDone = qaTotal > 0 ? progress.qa.attempted === true : true;
  const qaScore = qaTotal > 0 ? Math.round((parseNum(progress.qa.correct) / qaTotal) * 100) : 0;
  const allDone = progress.docs.length >= totalIndices && progress.vids.length >= totalIndices && qaDone;
  return save(Math.round((progress.docs.length / totalIndices) * 100), Math.round((progress.vids.length / totalIndices) * 100), qaScore, allDone);
});

import { Hono, type Context } from "hono";
import type { AppEnv } from "../types";
import { isAdmin, requireAdmin, requireAuth, scopedName } from "../middleware/auth";
import { fail, jsonBody, nanoid, NAME_SQL, normName, sameName, str } from "../lib/util";
import { audit } from "../lib/audit";

export const worklistRoutes = new Hono<AppEnv>();
worklistRoutes.use("*", requireAuth);

const VALID = ["Daily", "Weekly", "Monthly", "Yearly"];
const STANDARD_DAY_MINUTES = 540; // legacy getEmployeeWorkingMinutes() constant

interface WlRow {
  worklist_id: string; employee_name: string; worklist_name: string; frequency: string; working_time: string;
  template_link: string; remark: string; schedule_days: string; schedule_dates: string; ai_time: string;
}

const map = (r: WlRow) => ({
  WorkListId: r.worklist_id, EmployeeName: r.employee_name, WorklistName: r.worklist_name,
  Frequency: r.frequency, WorkingTime: r.working_time, TemplateLink: r.template_link, Remark: r.remark,
  ScheduleDays: r.schedule_days, ScheduleDates: r.schedule_dates, AITime: r.ai_time,
});

const minutes = (t: string) => {
  const m = (t || "").match(/^(\d+)(?:M)?$/);
  return m ? parseInt(m[1], 10) : 0;
};

function appliesOn(w: WlRow, d: Date): boolean {
  const day = d.toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" }).toLowerCase();
  const monthName = d.toLocaleDateString("en-US", { month: "long", timeZone: "UTC" }).toLowerCase();
  const dom = d.getUTCDate();
  switch (w.frequency) {
    case "Daily": return true;
    case "Weekly": return (w.schedule_days || "").split(",").map((x) => x.trim().toLowerCase()).includes(day);
    case "Monthly": return (w.schedule_dates || "").split(",").map((x) => parseInt(x.trim(), 10)).includes(dom);
    case "Yearly": {
      const parts = (w.schedule_dates || "").split(" ");
      return parts.length === 2 && parts[0].toLowerCase() === monthName && parseInt(parts[1], 10) === dom;
    }
  }
  return false;
}

const all = async (c: Context<AppEnv>, employee?: string) => {
  const stmt = employee
    ? c.env.DB.prepare(`SELECT * FROM worklists WHERE ${NAME_SQL("employee_name")} = ? ORDER BY position, rowid`).bind(normName(employee))
    : c.env.DB.prepare("SELECT * FROM worklists ORDER BY position, rowid");
  return (await stmt.all<WlRow>()).results;
};

const getOne = (c: Context<AppEnv>, id: string) =>
  c.env.DB.prepare("SELECT * FROM worklists WHERE worklist_id = ?").bind(id).first<WlRow>();

function validate(w: Record<string, any>): string | null {
  if (!w.WorklistName || !String(w.WorklistName).trim()) return "WorklistName is required";
  if (!w.Frequency || !VALID.includes(w.Frequency)) return `Frequency must be one of: ${VALID.join(", ")}`;
  if (!w.WorkingTime || !String(w.WorkingTime).trim()) return "WorkingTime is required";
  if (w.Frequency === "Weekly" && !w.ScheduleDays) return "Please select at least one day for Weekly frequency";
  if (w.Frequency === "Monthly" && !w.ScheduleDates) return "Please select at least one date for Monthly frequency";
  if (w.Frequency === "Yearly" && !w.ScheduleDates) return "Please select month and date for Yearly frequency";
  return null;
}

const insertStmt = (c: Context<AppEnv>, id: string, emp: string, w: Record<string, any>) =>
  c.env.DB.prepare(
    `INSERT INTO worklists (worklist_id, employee_name, worklist_name, frequency, working_time, template_link, remark,
       schedule_days, schedule_dates, ai_time, position)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '', (SELECT COALESCE(MAX(position), 0) + 1 FROM worklists))`,
  ).bind(id, emp, String(w.WorklistName).trim(), w.Frequency, String(w.WorkingTime).trim(),
    str(w.TemplateLink), str(w.Remark), str(w.ScheduleDays), str(w.ScheduleDates));

// ---------------- GET ----------------
worklistRoutes.get("/my", async (c) => {
  const data = (await all(c, c.get("user").name)).map(map);
  return c.json({ ok: true, data, total: data.length });
});

worklistRoutes.get("/all", requireAdmin, async (c) => {
  const { employeeName, search } = c.req.query();
  let data = (await all(c, employeeName && employeeName !== "all" ? employeeName : undefined)).map(map);
  if (search) {
    const q = search.toLowerCase();
    data = data.filter((w) => w.WorklistName.toLowerCase().includes(q) || w.EmployeeName.toLowerCase().includes(q) || w.WorkListId.toLowerCase().includes(q));
  }
  return c.json({ ok: true, data, total: data.length });
});

worklistRoutes.get("/download", requireAdmin, async (c) => {
  const e = c.req.query("employeeName");
  const data = (await all(c, e && e !== "all" ? e : undefined)).map(map);
  return c.json({ ok: true, data, total: data.length });
});

worklistRoutes.get("/download/my", async (c) => {
  const data = (await all(c, c.get("user").name)).map(map);
  return c.json({ ok: true, data, total: data.length });
});

worklistRoutes.get("/admin/ai-sheet", requireAdmin, async (c) => {
  const e = c.req.query("employeeName");
  const data = (await all(c, e && e !== "all" ? e : undefined)).map((w) => {
    const o = minutes(w.working_time), a = minutes(w.ai_time);
    let pct = 0, reduced = "N/A";
    if (o > 0 && a > 0) { pct = Math.round(((o - a) / o) * 100); reduced = `${o - a}M`; }
    return {
      WorkListId: w.worklist_id, EmployeeName: w.employee_name, TaskName: w.worklist_name, Frequency: w.frequency,
      OriginalTime: w.working_time, AITime: w.ai_time || "N/A", ReducedTime: reduced, PercentageFaster: pct > 0 ? `${pct}%` : "N/A",
    };
  });
  return c.json({ ok: true, data, total: data.length });
});

worklistRoutes.get("/admin/occupancy", requireAdmin, async (c) => {
  const date = c.req.query("date");
  if (!date) fail(400, "date parameter required (YYYY-MM-DD)");
  const target = new Date(date);
  if (isNaN(target.getTime())) fail(400, "Invalid date format");
  const rows = await all(c);
  // one entry per person even if their name is spelled with different spacing/case across rows
  const byPerson = new Map<string, string>();
  for (const w of rows) if (w.employee_name.trim() && !byPerson.has(normName(w.employee_name))) byPerson.set(normName(w.employee_name), w.employee_name.trim());
  const occupancyList = [...byPerson].map(([key, employeeName]) => {
    const assigned = rows.filter((w) => normName(w.employee_name) === key && appliesOn(w, target)).reduce((s, w) => s + minutes(w.working_time), 0);
    const pctRaw = (assigned / STANDARD_DAY_MINUTES) * 100;
    return {
      employeeName,
      assignedMinutes: assigned,
      assignedHours: (assigned / 60).toFixed(1),
      workingMinutes: STANDARD_DAY_MINUTES,
      workingHours: (STANDARD_DAY_MINUTES / 60).toFixed(1),
      occupancyPercentage: Math.round(pctRaw),
      status: pctRaw > 100 ? "overload" : pctRaw < 50 ? "underload" : "normal",
    };
  }).sort((a, b) => b.occupancyPercentage - a.occupancyPercentage);
  const n = occupancyList.length;
  return c.json({
    ok: true, date, occupancyList,
    summary: {
      totalEmployees: n,
      averageOccupancy: n ? Math.round(occupancyList.reduce((s, o) => s + o.occupancyPercentage, 0) / n) : 0,
      overloadedCount: occupancyList.filter((o) => o.status === "overload").length,
      underloadedCount: occupancyList.filter((o) => o.status === "underload").length,
    },
  });
});

// ---------------- POST ----------------
worklistRoutes.post("/", async (c) => {
  const b = await jsonBody(c.req);
  const emp = scopedName(c, b.EmployeeName);
  if (emp === null) fail(403, "You can only create worklists for yourself");
  const err = validate(b);
  if (err) fail(400, err);
  const id = nanoid(8);
  await insertStmt(c, id, emp, b).run();
  return c.json({ ok: true, WorkListId: id, message: "Worklist created successfully" });
});

worklistRoutes.post("/bulk", async (c) => {
  const { worklists } = await jsonBody(c.req);
  if (!Array.isArray(worklists) || !worklists.length) fail(400, "worklists array is required");
  const existing = await all(c);
  const seen = new Set(existing.map((r) => `${normName(r.employee_name)}|${r.worklist_name.trim().toLowerCase()}`));
  const created: any[] = [], skipped: any[] = [], errors: any[] = [];
  const stmts: D1PreparedStatement[] = [];
  worklists.forEach((w: Record<string, any>, i: number) => {
    const emp = scopedName(c, w.EmployeeName);
    if (emp === null) return errors.push({ row: i + 1, errors: ["You can only upload your own worklists"] });
    if (!w.WorklistName || !String(w.WorklistName).trim()) return errors.push({ row: i + 1, errors: ["WorklistName is required"] });
    if (!w.Frequency || !VALID.includes(w.Frequency)) return errors.push({ row: i + 1, errors: ["Frequency must be Daily, Weekly, Monthly, or Yearly"] });
    if (!w.WorkingTime || !String(w.WorkingTime).trim()) return errors.push({ row: i + 1, errors: ["WorkingTime is required"] });
    const key = `${normName(emp)}|${String(w.WorklistName).trim().toLowerCase()}`;
    if (seen.has(key)) return skipped.push({ row: i + 1, WorklistName: w.WorklistName, reason: "Duplicate" });
    seen.add(key);
    const id = nanoid(8);
    stmts.push(insertStmt(c, id, emp, w));
    created.push({ row: i + 1, WorkListId: id, WorklistName: w.WorklistName });
  });
  for (let i = 0; i < stmts.length; i += 50) await c.env.DB.batch(stmts.slice(i, i + 50));
  return c.json({
    ok: true,
    summary: { total: worklists.length, created: created.length, skipped: skipped.length, errors: errors.length },
    created, skipped, errors,
  });
});

// ---------------- PUT / DELETE ----------------
worklistRoutes.put("/ai-time/:id", async (c) => {
  const { AITime } = await jsonBody(c.req);
  if (!AITime || !String(AITime).trim()) fail(400, "AITime is required");
  const w = await getOne(c, c.req.param("id"));
  if (!w || (!isAdmin(c) && !sameName(w.employee_name, c.get("user").name))) fail(404, "Worklist not found");
  await c.env.DB.prepare("UPDATE worklists SET ai_time = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE worklist_id = ?")
    .bind(String(AITime).trim(), w.worklist_id).run();
  return c.json({ ok: true, message: "AI Time updated successfully", worklist: map({ ...w, ai_time: String(AITime).trim() }) });
});

async function applyUpdate(c: Context<AppEnv>, w: WlRow, b: Record<string, any>, allowEmployee: boolean) {
  const next: WlRow = { ...w };
  if (b.WorklistName) next.worklist_name = String(b.WorklistName).trim();
  if (b.Frequency && VALID.includes(b.Frequency)) next.frequency = b.Frequency;
  if (b.WorkingTime) next.working_time = String(b.WorkingTime).trim();
  if (allowEmployee && b.EmployeeName) next.employee_name = String(b.EmployeeName).trim();
  if (b.TemplateLink !== undefined) next.template_link = str(b.TemplateLink);
  if (b.Remark !== undefined) next.remark = str(b.Remark);
  if (b.ScheduleDays !== undefined) next.schedule_days = str(b.ScheduleDays);
  if (b.ScheduleDates !== undefined) next.schedule_dates = str(b.ScheduleDates);
  await c.env.DB.prepare(
    `UPDATE worklists SET employee_name=?, worklist_name=?, frequency=?, working_time=?, template_link=?, remark=?,
       schedule_days=?, schedule_dates=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE worklist_id=?`,
  ).bind(next.employee_name, next.worklist_name, next.frequency, next.working_time, next.template_link, next.remark,
    next.schedule_days, next.schedule_dates, w.worklist_id).run();
  return map(next);
}

worklistRoutes.put("/admin/:id", requireAdmin, async (c) => {
  const w = await getOne(c, c.req.param("id"));
  if (!w) fail(404, "Worklist not found");
  const worklist = await applyUpdate(c, w, await jsonBody(c.req), true);
  return c.json({ ok: true, message: "Worklist updated by admin", worklist });
});

worklistRoutes.delete("/admin/:id", requireAdmin, async (c) => {
  const r = await c.env.DB.prepare("DELETE FROM worklists WHERE worklist_id = ?").bind(c.req.param("id")).run();
  if (!r.meta.changes) fail(404, "Worklist not found");
  await audit(c.env, c.get("user").employeeID, "delete", "worklist", c.req.param("id"));
  return c.json({ ok: true, message: "Worklist deleted by admin" });
});

worklistRoutes.put("/:id", async (c) => {
  const w = await getOne(c, c.req.param("id"));
  if (!w) fail(404, "Worklist not found");
  if (!sameName(w.employee_name, c.get("user").name)) fail(403, "You can only update your own worklist");
  const worklist = await applyUpdate(c, w, await jsonBody(c.req), false);
  return c.json({ ok: true, message: "Worklist updated", worklist });
});

/** DELETE /api/worklist/:id — doer services.js called this but it was never implemented */
worklistRoutes.delete("/:id", async (c) => {
  const w = await getOne(c, c.req.param("id"));
  if (!w || (!isAdmin(c) && !sameName(w.employee_name, c.get("user").name))) fail(404, "Worklist not found");
  await c.env.DB.prepare("DELETE FROM worklists WHERE worklist_id = ?").bind(w.worklist_id).run();
  return c.json({ ok: true, message: "Worklist deleted" });
});

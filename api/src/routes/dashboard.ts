import { Hono } from "hono";
import type { AppEnv } from "../types";
import { isAdmin, requireAuth } from "../middleware/auth";
import { getWeekRange, isoDay, parseDDMMYYYY } from "../lib/dates";
import { fail, lc, percent } from "../lib/util";

// Port of routes/allDashboard.js — identical scoring maths.
export const dashboardRoutes = new Hono<AppEnv>();
dashboardRoutes.use("*", requireAuth);

type Stats = { totalWork: number; completedWork: number; pendingWork: number; onTimeWork: number; pendingPercent: string; delayPercent: string };
const stats = (total: number, completed: number, pending: number, onTime: number, delayed: number): Stats => ({
  totalWork: total, completedWork: completed, pendingWork: pending, onTimeWork: onTime,
  pendingPercent: percent(pending, total), delayPercent: percent(delayed, completed),
});

function delegationCalc(rows: any[], key: string, ws: Date, we: Date): Stats {
  let total = 0, completed = 0, pending = 0, onTime = 0, delayed = 0;
  for (const r of rows) {
    if (lc(r.name) !== key) continue;
    const created = parseDDMMYYYY(r.created_date);
    const deadline = parseDDMMYYYY(r.deadline);
    const done = r.final_date ? parseDDMMYYYY(r.final_date) : null;
    if (!created || !(created <= we && (!done || done >= ws))) continue;
    total++;
    if (done && done >= ws && done <= we) { completed++; deadline && done <= deadline ? onTime++ : delayed++; } else pending++;
  }
  return stats(total, completed, pending, onTime, delayed);
}

function checklistCalc(rows: any[], key: string, ws: Date, we: Date): Stats {
  let total = 0, completed = 0, pending = 0, onTime = 0, delayed = 0;
  for (const r of rows) {
    if (lc(r.name) !== key) continue;
    const planned = parseDDMMYYYY(r.planned);
    const actual = parseDDMMYYYY(r.actual);
    const inRange = (planned && planned >= ws && planned <= we) || (actual && actual >= ws && actual <= we);
    if (!inRange) continue;
    total++;
    if (actual) { completed++; planned && actual <= planned ? onTime++ : delayed++; } else pending++;
  }
  return stats(total, completed, pending, onTime, delayed);
}

function ticketCalc(rows: any[], key: string, ws: Date, we: Date, col: "assigned_to" | "created_by"): Stats {
  let total = 0, completed = 0, pending = 0, onTime = 0, delayed = 0;
  for (const r of rows) {
    if (lc(r[col]) !== key) continue;
    const created = parseDDMMYYYY(r.created_date);
    const done = parseDDMMYYYY(r.done_date);
    if (!created || !(created <= we && (!done || done >= ws))) continue;
    total++;
    if (done && done >= ws && done <= we) {
      completed++;
      Math.ceil((done.getTime() - created.getTime()) / 86400000) <= 3 ? onTime++ : delayed++;
    } else pending++;
  }
  return stats(total, completed, pending, onTime, delayed);
}

/** GET /api/allDashboard/all-dashboard?month&week&selectedName */
dashboardRoutes.get("/all-dashboard", async (c) => {
  const { month, week, selectedName } = c.req.query();
  if (!month) fail(400, "Month & Week required");
  const me = c.get("user");
  // Employees only ever see their own scorecard.
  const wanted = isAdmin(c) ? selectedName : me.name;
  const { weekStart: ws, weekEnd: we } = getWeekRange(month, week ?? "all");

  const db = c.env.DB;
  const [emps, del, chk, help, sup] = await db.batch([
    db.prepare("SELECT name FROM users WHERE role='employee' AND is_active=1 ORDER BY id"),
    db.prepare("SELECT name, created_date, deadline, final_date FROM delegations"),
    db.prepare("SELECT name, planned, actual FROM checklist_tasks"),
    db.prepare("SELECT created_by, assigned_to, created_date, done_date FROM help_tickets"),
    db.prepare("SELECT created_by, assigned_to, created_date, done_date FROM support_tickets"),
  ]);

  let employees = (emps.results as { name: string }[])
    .filter((e) => e.name && e.name.trim())
    .map((e) => ({ name: e.name.trim(), key: lc(e.name) }));
  if (wanted && wanted !== "all") employees = employees.filter((e) => e.key === lc(wanted));
  if (!isAdmin(c) && !employees.length) employees = [{ name: me.name.trim(), key: lc(me.name) }];

  const data = employees.map((emp) => {
    const delegation = delegationCalc(del.results, emp.key, ws, we);
    const checklist = checklistCalc(chk.results, emp.key, ws, we);
    const helpA = ticketCalc(help.results, emp.key, ws, we, "assigned_to");
    const helpC = ticketCalc(help.results, emp.key, ws, we, "created_by");
    const supA = ticketCalc(sup.results, emp.key, ws, we, "assigned_to");
    const supC = ticketCalc(sup.results, emp.key, ws, we, "created_by");
    const totalWork = delegation.totalWork + checklist.totalWork + helpA.totalWork + supA.totalWork;
    const totalCompleted = delegation.completedWork + checklist.completedWork + helpA.completedWork + supA.completedWork;
    const totalPending = delegation.pendingWork + checklist.pendingWork + helpA.pendingWork + supA.pendingWork;
    const totalOnTime = delegation.onTimeWork + checklist.onTimeWork + helpA.onTimeWork + supA.onTimeWork;
    const pendingPercent = percent(totalPending, totalWork);
    const delayPercent = ((Number(delegation.delayPercent) + Number(checklist.delayPercent) + Number(helpA.delayPercent) + Number(supA.delayPercent)) / 4).toFixed(2);
    return {
      name: emp.name,
      delegation,
      checklist,
      helpTicket: { assigned: helpA, created: helpC },
      supportTicket: { assigned: supA, created: supC },
      overall: {
        totalWork, totalCompleted, totalPending, totalOnTime, pendingPercent, delayPercent,
        overallScore: (Number(pendingPercent) * 0.8 + Number(delayPercent) * 0.2).toFixed(2),
      },
    };
  });

  return c.json({ weekStart: isoDay(ws), weekEnd: isoDay(we), data });
});

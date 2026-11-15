import { Hono } from "hono";
import type { AppEnv } from "../types";
import { requireAdmin, requireAuth } from "../middleware/auth";
import { listByRole, findByEmployeeId } from "../lib/users";
import { publicFileUrl, storeUpload } from "../lib/files";
import { formatDateDMY } from "../lib/dates";
import { fail, str } from "../lib/util";
import { audit } from "../lib/audit";

export const employeeRoutes = new Hono<AppEnv>();
employeeRoutes.use("*", requireAuth);

/** GET /api/employee/all — same object shape as legacy empRowToObj */
employeeRoutes.get("/all", async (c) => {
  const rows = await listByRole(c.env, "employee");
  const out = await Promise.all(rows.map(async (e) => ({
    employeeID: e.employee_id,
    name: e.name,
    number: e.mobile,
    Department: e.department,
    CompanyName: e.company_name,
    DateofBirth: e.date_of_birth,
    JoiningDate: e.joining_date,
    ProfilePicture: await publicFileUrl(c, e.profile_picture),
    Designation: e.designation,
    DoerName: e.doer_name,
    ShiftStartTime: e.shift_start_time,
    ShiftEndTime: e.shift_end_time,
    TotalWorkingHours: e.total_working_hours,
  })));
  return c.json(out);
});

/** GET /api/employee/designations — COMMON first, then unique designations (admin) */
employeeRoutes.get("/designations", requireAdmin, async (c) => {
  const rows = await listByRole(c.env, "employee");
  const seen = new Map<string, string>();
  for (const e of rows) {
    const t = e.designation.trim();
    if (t && !seen.has(t.toUpperCase())) seen.set(t.toUpperCase(), t);
  }
  const designations = ["COMMON", ...[...seen.values()].sort((a, b) => a.localeCompare(b))];
  return c.json({ ok: true, designations, columnIndex: 10, header: [] });
});

/** GET /api/employee/profile */
employeeRoutes.get("/profile", async (c) => {
  const me = c.get("user");
  const e = await findByEmployeeId(c.env, me.role, me.employeeID);
  if (!e) fail(404, "Employee not found");
  return c.json({
    employeeID: e.employee_id,
    name: e.name,
    mobile: e.mobile,
    department: e.department,
    companyName: e.company_name,
    dateOfBirth: e.date_of_birth,
    joiningDate: e.joining_date,
    profilePicture: await publicFileUrl(c, e.profile_picture),
    designation: e.designation,
    doerName: e.doer_name,
    donorName: e.doer_name,
    shiftStartTime: e.shift_start_time,
    shiftEndTime: e.shift_end_time,
    totalWorkingHours: e.total_working_hours,
  });
});

/**
 * PUT /api/employee/update-profile (multipart)
 * The doer Topbar always called this but the Express backend never implemented it.
 */
employeeRoutes.put("/update-profile", async (c) => {
  const me = c.get("user");
  const e = await findByEmployeeId(c.env, me.role, me.employeeID);
  if (!e) fail(404, "Employee not found");
  const body = await c.req.parseBody();
  const has = (k: string) => body[k] !== undefined && str(body[k]).trim() !== "";
  const pic = await storeUpload(c.env, body.profilePicture, "employee_documents");
  const next = {
    company_name: has("companyName") ? str(body.companyName).trim() : e.company_name,
    designation: has("designation") ? str(body.designation).trim() : e.designation,
    joining_date: has("joiningDate") ? formatDateDMY(body.joiningDate) || str(body.joiningDate) : e.joining_date,
    date_of_birth: has("dateOfBirth") ? formatDateDMY(body.dateOfBirth) || str(body.dateOfBirth) : e.date_of_birth,
    doer_name: has("donorName") ? str(body.donorName).trim() : has("doerName") ? str(body.doerName).trim() : e.doer_name,
    profile_picture: pic || e.profile_picture,
  };
  await c.env.DB.prepare(
    `UPDATE users SET company_name=?, designation=?, joining_date=?, date_of_birth=?, doer_name=?, profile_picture=?,
       updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`,
  ).bind(next.company_name, next.designation, next.joining_date, next.date_of_birth, next.doer_name, next.profile_picture, e.id).run();
  await audit(c.env, me.employeeID, "update-profile", "user", me.employeeID);
  return c.json({ ok: true, profilePicture: await publicFileUrl(c, next.profile_picture) });
});

/** GET /api/employee/allAdmin — module path is case-insensitive, so register lowercase too */
const allAdmin = async (c: any) => {
  const rows = await listByRole(c.env, "admin");
  return c.json(rows.map((a) => ({ employeeID: a.employee_id, name: a.name })));
};
employeeRoutes.get("/allAdmin", allAdmin);
employeeRoutes.get("/alladmin", allAdmin);

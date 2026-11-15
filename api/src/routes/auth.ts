import { Hono } from "hono";
import type { AppEnv } from "../types";
import { formatDateDMY, parseDateFromDMY } from "../lib/dates";
import { publicFileUrl, storeUpload } from "../lib/files";
import { hashPassword, isLegacyHash, verifyPassword } from "../lib/password";
import { findByEmployeeId } from "../lib/users";
import { issueToken, requireAuth, isAdmin } from "../middleware/auth";
import { fail, jsonBody, nanoid, str } from "../lib/util";
import { audit } from "../lib/audit";

// ---------------------------------------------------------------------
// Employee (doer) auth — legacy routes/auth.js
// ---------------------------------------------------------------------
export const authRoutes = new Hono<AppEnv>();

const DOC_FIELDS = ["aadhaarCard", "panCard", "bankPassbook", "educationCert", "experienceCert"] as const;

// Employee!M..BV fields kept in hr_details (column letter in comments for traceability).
export const HR_FIELDS = [
  "gender", "employeeType", "workLocation", "employeeStatus", "shiftName",
  "lunchBreak", "weeklyOff", "overtimeApplicable", "overtimeRate", "basicSalary",
  "petrolAllowance", "petrolAmount", "foodAllowance", "foodAmount", "workingDays",
  "pfApplicable", "ptApplicable", "advanceAllowed", "advanceLimit", "biometricId",
  "graceTime", "lateMarkAfter", "halfDayAfter", "minWorkingHours", "punchRequired",
  "autoAbsentAfter", "paidLeave", "casualLeave", "sickLeave", "earnedLeave",
  "leaveCarryForward", "leaveCarryMax", "bankName", "accountNumber", "ifscCode",
  "pfNumber", "esicNumber", "aadhaarNumber", "panNumber", "highestQualification",
  "passingYear", "previousCompany", "previousDesignation", "totalExperience",
  "fatherName", "motherName", "spouseName", "spouseDob", "motherInLawName",
  "fatherInLawName", "emergencyContactName", "emergencyContactNumber",
  "permanentAddress", "currentAddress",
] as const;

/** POST /api/auth/register (multipart, public) */
authRoutes.post("/register", async (c) => {
  const ct = c.req.header("content-type") || "";
  const data: Record<string, unknown> = ct.includes("multipart/form-data")
    ? await c.req.parseBody()
    : await jsonBody(c.req);
  const f = (k: string) => str(data[k]).trim();

  if (!f("name")) fail(400, "Name required");
  if (!f("mobile")) fail(400, "Mobile required");
  if (!str(data.password)) fail(400, "Password required");
  if (!f("department")) fail(400, "Department required");
  if (f("mobile").length < 10) fail(400, "Valid mobile number required");
  if (str(data.password).length < 6) fail(400, "Password must be at least 6 characters");

  const dup = await c.env.DB.prepare(
    "SELECT name, mobile FROM users WHERE role='employee' AND (name = ? OR mobile = ?) LIMIT 1",
  ).bind(f("name"), f("mobile")).first<{ name: string; mobile: string }>();
  if (dup?.name === f("name")) fail(400, "UserName already registered");
  if (dup) fail(400, "Mobile already registered");

  // Upload files first (legacy behaviour: upload failure aborts registration).
  const profilePicture = await storeUpload(c.env, data.profilePicture, "employee_documents");
  const docs: [string, string][] = [];
  for (const k of DOC_FIELDS) {
    const ref = await storeUpload(c.env, data[k], "employee_documents");
    if (ref) docs.push([k, ref]);
  }

  const hr: Record<string, string> = {};
  for (const k of HR_FIELDS) hr[k] = k === "spouseDob" ? formatDateDMY(data[k]) : f(k);

  const employeeId = nanoid(6);
  const res = await c.env.DB.prepare(
    `INSERT INTO users (employee_id, role, name, mobile, password_hash, department, designation,
       company_name, date_of_birth, joining_date, profile_picture, doer_name,
       shift_start_time, shift_end_time, total_working_hours, hr_details)
     VALUES (?, 'employee', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
  ).bind(
    employeeId, f("name"), f("mobile"), await hashPassword(str(data.password)), f("department"),
    f("designation"), f("companyName"), formatDateDMY(data.dateOfBirth), formatDateDMY(data.joiningDate),
    profilePicture, f("doerName"), f("shiftStartTime"), f("shiftEndTime"), f("totalWorkingHours"),
    JSON.stringify(hr),
  ).first<{ id: number }>();

  if (docs.length && res) {
    await c.env.DB.batch(docs.map(([kind, ref]) =>
      c.env.DB.prepare("INSERT INTO user_documents (user_id, kind, file_ref) VALUES (?, ?, ?)").bind(res.id, kind, ref)));
  }
  await audit(c.env, employeeId, "register", "user", employeeId);
  return c.json({ ok: true, EmployeeID: employeeId });
});

/** POST /api/auth/login */
authRoutes.post("/login", async (c) => {
  const { employeeID, password } = await jsonBody(c.req);
  if (!employeeID || !password) fail(400, "EmployeeID and password required");
  const user = await findByEmployeeId(c.env, "employee", String(employeeID).trim());
  if (!user) fail(404, "User not found");
  if (!(await verifyPassword(String(password), user.password_hash))) fail(401, "Incorrect password");
  if (isLegacyHash(user.password_hash)) {
    c.executionCtx.waitUntil(c.env.DB.prepare("UPDATE users SET password_hash = ? WHERE id = ?")
      .bind(await hashPassword(String(password)), user.id).run());
  }
  const token = await issueToken(c.env, {
    employeeID: user.employee_id, name: user.name, department: user.department,
    designation: user.designation, role: "employee",
  });
  return c.json({
    ok: true,
    token,
    user: {
      employeeID: user.employee_id,
      name: user.name,
      department: user.department,
      designation: user.designation,
      mobile: user.mobile,
      companyName: user.company_name,
      dateOfBirth: parseDateFromDMY(user.date_of_birth),
      joiningDate: parseDateFromDMY(user.joining_date),
      profilePicture: await publicFileUrl(c, user.profile_picture),
      donorName: user.doer_name,
      sheet: `${user.name}_Delegations`,
      role: "employee",
    },
  });
});

/** POST /api/auth/change-password (new) */
authRoutes.post("/change-password", requireAuth, async (c) => {
  const { currentPassword, newPassword } = await jsonBody(c.req);
  if (!newPassword || String(newPassword).length < 6) fail(400, "Password must be at least 6 characters");
  const me = c.get("user");
  const user = await findByEmployeeId(c.env, me.role, me.employeeID);
  if (!user) fail(404, "User not found");
  if (!(await verifyPassword(String(currentPassword || ""), user.password_hash))) fail(401, "Incorrect password");
  await c.env.DB.prepare("UPDATE users SET password_hash = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?")
    .bind(await hashPassword(String(newPassword)), user.id).run();
  await audit(c.env, me.employeeID, "change-password", "user", me.employeeID);
  return c.json({ ok: true });
});

/** POST /api/auth/reset-password (admin resets an employee's password; new) */
authRoutes.post("/reset-password", requireAuth, async (c) => {
  if (!isAdmin(c)) fail(403, "Admin access required");
  const { employeeID, newPassword } = await jsonBody(c.req);
  if (!employeeID || !newPassword || String(newPassword).length < 6) fail(400, "employeeID and a 6+ character newPassword are required");
  const r = await c.env.DB.prepare("UPDATE users SET password_hash = ? WHERE employee_id = ?")
    .bind(await hashPassword(String(newPassword)), String(employeeID)).run();
  if (!r.meta.changes) fail(404, "User not found");
  await audit(c.env, c.get("user").employeeID, "reset-password", "user", String(employeeID));
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------
// Admin auth — legacy routes/adminAuth.js (mounted at /api/adminauth)
// ---------------------------------------------------------------------
export const adminAuthRoutes = new Hono<AppEnv>();

/**
 * POST /api/adminauth/admin/register
 * Legacy: completely public (anyone could become admin). Now allowed only when
 *  - no admin exists yet (first-time bootstrap), or
 *  - the caller is an authenticated admin, or
 *  - the body/header carries ADMIN_REGISTRATION_KEY.
 */
adminAuthRoutes.post("/admin/register", async (c) => {
  const body = await jsonBody(c.req);
  const { name, mobile, password, department } = body;
  if (!name || !mobile || !password || !department) fail(400, "All fields required");
  if (String(mobile).length < 10) fail(400, "Valid mobile number required");
  if (String(password).length < 6) fail(400, "Password must be at least 6 characters");

  const adminCount = (await c.env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE role='admin'").first<{ n: number }>())?.n || 0;
  let allowed = adminCount === 0;
  const key = String(body.registrationKey || c.req.header("X-Admin-Registration-Key") || "");
  if (!allowed && c.env.ADMIN_REGISTRATION_KEY && key && key === c.env.ADMIN_REGISTRATION_KEY) allowed = true;
  if (!allowed) {
    const token = (c.req.header("Authorization") || "").split(" ")[1];
    if (token) {
      try {
        const { verify } = await import("hono/jwt");
        const p = (await verify(token, c.env.JWT_SECRET, "HS256")) as { role?: string };
        allowed = p.role === "admin";
      } catch { /* fall through */ }
    }
  }
  if (!allowed) fail(403, "Admin registration requires a valid registration key or an existing admin");

  const dup = await c.env.DB.prepare(
    "SELECT name FROM users WHERE role='admin' AND (name = ? OR mobile = ?) LIMIT 1",
  ).bind(String(name), String(mobile)).first<{ name: string }>();
  if (dup?.name === String(name)) fail(400, "UserName already registered");
  if (dup) fail(400, "Mobile already registered");

  const employeeId = nanoid(6);
  await c.env.DB.prepare(
    "INSERT INTO users (employee_id, role, name, mobile, password_hash, department) VALUES (?, 'admin', ?, ?, ?, ?)",
  ).bind(employeeId, String(name).trim(), String(mobile).trim(), await hashPassword(String(password)), String(department).trim()).run();
  await audit(c.env, employeeId, "register-admin", "user", employeeId);
  return c.json({ ok: true, EmployeeID: employeeId });
});

/** POST /api/adminauth/admin/login */
adminAuthRoutes.post("/admin/login", async (c) => {
  const { employeeID, password } = await jsonBody(c.req);
  if (!employeeID || !password) fail(400, "EmployeeID and password required");
  const user = await findByEmployeeId(c.env, "admin", String(employeeID).trim());
  if (!user) fail(404, "User not found");
  if (!(await verifyPassword(String(password), user.password_hash))) fail(401, "Incorrect password");
  if (isLegacyHash(user.password_hash)) {
    c.executionCtx.waitUntil(c.env.DB.prepare("UPDATE users SET password_hash = ? WHERE id = ?")
      .bind(await hashPassword(String(password)), user.id).run());
  }
  const token = await issueToken(c.env, {
    employeeID: user.employee_id, name: user.name, department: user.department, designation: "", role: "admin",
  });
  return c.json({
    ok: true,
    token,
    user: {
      employeeID: user.employee_id,
      name: user.name,
      department: user.department,
      mobile: user.mobile,
      company: user.company_name,
      sheet: `${user.name}_Delegations`,
      role: "admin",
    },
  });
});

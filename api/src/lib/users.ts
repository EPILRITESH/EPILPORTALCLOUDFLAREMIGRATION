import type { Env, Role } from "../types";

export interface UserRow {
  id: number;
  employee_id: string;
  role: Role;
  name: string;
  mobile: string;
  password_hash: string;
  department: string;
  designation: string;
  company_name: string;
  date_of_birth: string;
  joining_date: string;
  profile_picture: string;
  doer_name: string;
  shift_start_time: string;
  shift_end_time: string;
  total_working_hours: string;
  hr_details: string;
  is_active: number;
  created_at: string;
}

export const findByEmployeeId = (env: Env, role: Role, employeeId: string) =>
  env.DB.prepare("SELECT * FROM users WHERE employee_id = ? AND role = ? AND is_active = 1")
    .bind(employeeId, role)
    .first<UserRow>();

export const listByRole = async (env: Env, role: Role) =>
  (await env.DB.prepare("SELECT * FROM users WHERE role = ? AND is_active = 1 ORDER BY id").bind(role).all<UserRow>()).results;

/** Department of an employee looked up by name (support-ticket MIS logic). */
export async function departmentOf(env: Env, name: string): Promise<string> {
  const r = await env.DB.prepare("SELECT department FROM users WHERE role = 'employee' AND name = ? LIMIT 1")
    .bind(name)
    .first<{ department: string }>();
  return r?.department || "";
}

/** Designation of an employee looked up by name (training assignment). */
export async function designationOf(env: Env, name: string): Promise<string> {
  const r = await env.DB.prepare("SELECT designation FROM users WHERE role = 'employee' AND name = ? LIMIT 1")
    .bind(name)
    .first<{ designation: string }>();
  return r?.designation || "";
}

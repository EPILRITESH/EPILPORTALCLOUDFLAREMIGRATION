// Departments / designations / employees used by FMS must exist among registered (active) employees.
// Free text would silently match nobody, so values are checked and normalised to the registered spelling.
import type { Env } from "../../types";
import { fail, normName, str } from "../util";

export interface Directory { departments: Map<string, string>; designations: Map<string, string>; employees: Set<string> }

export async function loadDirectory(env: Env): Promise<Directory> {
  const { results } = await env.DB.prepare("SELECT employee_id, department, designation FROM users WHERE role = 'employee' AND is_active = 1")
    .all<{ employee_id: string; department: string; designation: string }>();
  const dir: Directory = { departments: new Map(), designations: new Map(), employees: new Set() };
  for (const u of results) {
    dir.employees.add(u.employee_id);
    const d = str(u.department).trim(), g = str(u.designation).trim();
    if (d && !dir.departments.has(normName(d))) dir.departments.set(normName(d), d);
    if (g && !dir.designations.has(normName(g))) dir.designations.set(normName(g), g);
  }
  return dir;
}

type Spec = { departments?: string[]; designations?: string[]; employees?: string[]; [k: string]: unknown };

/** Canonicalise one spec; unknown values are reported in `errors`. */
export function canonSpec<T extends Spec>(dir: Directory, spec: T, where: string, errors: string[]): T {
  const map = (list: string[] | undefined, m: Map<string, string>, kind: string) => (list || []).map((v) => {
    const hit = m.get(normName(v));
    if (!hit) errors.push(`${where}: ${kind} "${v}" is not a registered ${kind}`);
    return hit || v;
  });
  const employees = (spec.employees || []).filter((e) => {
    if (!dir.employees.has(e)) { errors.push(`${where}: employee "${e}" is not a registered active employee`); return false; }
    return true;
  });
  return { ...spec, departments: [...new Set(map(spec.departments, dir.departments, "department"))], designations: [...new Set(map(spec.designations, dir.designations, "designation"))], employees };
}

/** Check every people list of a normalised definition (Visible to, step WHO, approvers). Throws 400 with all problems. */
export async function checkDefinitionPeople(env: Env, n: { def: { access: string }; steps: { code: string; assign: Spec; approver: Spec & { seat_id?: number | null } }[] }) {
  const dir = await loadDirectory(env);
  const errors: string[] = [];
  n.def.access = JSON.stringify(canonSpec(dir, JSON.parse(n.def.access || "{}"), "Visible to", errors));
  for (const s of n.steps) {
    s.assign = canonSpec(dir, s.assign, `${s.code} WHO`, errors);
    s.approver = canonSpec(dir, s.approver, `${s.code} approver`, errors);
  }
  if (errors.length) fail(400, errors[0], { errors });
}

/** Check seat members (department / designation / employee). */
export function canonMember(dir: Directory, kind: string, value: string, where: string, errors: string[]): string {
  if (kind === "employee") { if (!dir.employees.has(value)) errors.push(`${where}: employee "${value}" is not a registered active employee`); return value; }
  const m = kind === "department" ? dir.departments : dir.designations;
  const hit = m.get(normName(value));
  if (!hit) errors.push(`${where}: ${kind} "${value}" is not a registered ${kind}`);
  return hit || value;
}

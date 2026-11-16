// FMS definitions: validate + save (create/update with versioning), snapshot, duplicate,
// and typed validation of row / step values.
import type { Env } from "../../types";
import { fail, str } from "../util";
import { parseInstant } from "./calendar";
import { j, type DefRow, type FieldRow, type StepRow } from "./engine";

export const FIELD_TYPES = ["text", "textarea", "number", "date", "datetime", "select", "multiselect", "email", "phone", "url", "checkbox", "file", "employee"] as const;
const PRIORITIES = ["Low", "Medium", "High", "Critical"];
const FREQUENCIES = ["on_demand", "one_time", "daily", "weekly", "monthly", "quarterly", "yearly"];
const TAT_TYPES = ["none", "hours", "days", "before_field", "after_field"];
const OPS = ["eq", "neq", "in", "not_in", "empty", "not_empty", "contains"];

export interface FieldInput { id?: number; key?: string; label: string; type?: string; options?: string[]; required?: boolean; default_value?: string; help?: string; in_list?: boolean }
export interface StepInput {
  id?: number; name: string; code?: string; seat_id?: number | null; assign?: Record<string, string[]>; how?: string;
  tat?: { type?: string; value?: number; field?: string; from?: string }; condition?: { field: string; op: string; value?: unknown } | null;
  requires_approval?: boolean; approver?: Record<string, unknown>; status_options?: string[]; reminder?: Record<string, unknown>;
  escalation?: Record<string, unknown>; fields?: FieldInput[];
  /** status option → step position to continue at (steps in between are skipped), e.g. {"Close": 5} */
  jumps?: Record<string, number>;
}
export interface DefinitionInput {
  name: string; code?: string; category?: string; description?: string; instructions?: string; priority?: string; status?: string;
  is_template?: boolean; access?: Record<string, string[]>; calendar?: Record<string, unknown>; frequency?: string; schedule?: Record<string, unknown>;
  start_date?: string; due_date?: string; start_field?: string; uid_prefix?: string; settings?: Record<string, unknown>;
  fields?: FieldInput[]; steps?: StepInput[];
}

export const slugKey = (s: string) => str(s).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 48) || "field";
const strList = (v: unknown) => (Array.isArray(v) ? [...new Set(v.map((x) => str(x).trim()).filter(Boolean))] : []);
const spec = (v: unknown) => {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  return { departments: strList(o.departments), designations: strList(o.designations), employees: strList(o.employees) };
};

/** Validate and normalise a full definition payload. Throws 400 with a list of problems. */
export function normaliseDefinition(input: DefinitionInput) {
  const errors: string[] = [];
  const name = str(input.name).trim();
  if (!name) errors.push("FMS name is required");
  const priority = PRIORITIES.includes(str(input.priority)) ? str(input.priority) : "Medium";
  const frequency = FREQUENCIES.includes(str(input.frequency)) ? str(input.frequency) : "on_demand";
  const keys = new Set<string>();
  const normField = (f: FieldInput, where: string): FieldInput & { key: string; type: string } => {
    const label = str(f.label).trim();
    if (!label) errors.push(`${where}: every field needs a name`);
    let key = slugKey(f.key || label);
    let n = 2;
    while (keys.has(key)) key = `${slugKey(f.key || label)}_${n++}`;
    keys.add(key);
    const type = (FIELD_TYPES as readonly string[]).includes(str(f.type)) ? str(f.type) : "text";
    const options = strList(f.options);
    if ((type === "select" || type === "multiselect") && !options.length) errors.push(`${where}: "${label}" needs at least one option`);
    return { id: f.id, key, label, type, options, required: !!f.required, default_value: str(f.default_value), help: str(f.help), in_list: f.in_list !== false };
  };
  const fields = (input.fields || []).map((f, i) => normField(f, `Column ${i + 1}`));
  const steps = (input.steps || []).map((s, i) => {
    const where = `Step ${i + 1}`;
    if (!str(s.name).trim()) errors.push(`${where}: step name (WHAT) is required`);
    const tatType = TAT_TYPES.includes(str(s.tat?.type)) ? str(s.tat?.type) : "none";
    const tat = { type: tatType, value: Number(s.tat?.value || 0), field: str(s.tat?.field), from: s.tat?.from === "start" ? "start" : "previous" };
    if ((tatType === "hours" || tatType === "days") && !(tat.value >= 0)) errors.push(`${where}: TAT must be a number`);
    if ((tatType === "before_field" || tatType === "after_field") && !tat.field) errors.push(`${where}: choose the date column for the TAT`);
    let condition: StepInput["condition"] = null;
    if (s.condition && str(s.condition.field)) {
      if (!OPS.includes(str(s.condition.op))) errors.push(`${where}: unknown condition operator`);
      condition = { field: str(s.condition.field), op: str(s.condition.op), value: s.condition.value ?? "" };
    }
    const assign = spec(s.assign);
    const seatId = s.seat_id ? Number(s.seat_id) : null;
    if (!seatId && !assign.departments.length && !assign.designations.length && !assign.employees.length) errors.push(`${where} (${str(s.name)}): choose WHO — a seat, department, designation or employee`);
    const approver = { ...spec(s.approver), seat_id: s.approver && (s.approver as any).seat_id ? Number((s.approver as any).seat_id) : null };
    const statusOptions = strList(s.status_options);
    const jumps: Record<string, number> = {};
    for (const [opt, to] of Object.entries(s.jumps && typeof s.jumps === "object" ? s.jumps : {})) {
      const n = Number(to);
      if (!opt || !n) continue;
      if (!statusOptions.includes(opt)) errors.push(`${where}: "${opt}" is not one of its status options`);
      else if (!Number.isInteger(n) || n <= i + 2 || n > (input.steps || []).length) errors.push(`${where}: "${opt}" must jump to a later step (STEP-${i + 3} or after)`);
      else jumps[opt] = n;
    }
    return {
      id: s.id, name: str(s.name).trim(), code: str(s.code).trim() || `STEP-${i + 1}`, seat_id: seatId, assign, how: str(s.how), tat, condition,
      requires_approval: !!s.requires_approval, approver, status_options: statusOptions.length ? statusOptions : ["Done"],
      reminder: s.reminder || {}, escalation: s.escalation || {}, jumps, fields: (s.fields || []).map((f, k) => normField(f, `${where} input ${k + 1}`)),
    };
  });
  const allKeys = new Set([...fields.map((f) => f.key), ...steps.flatMap((s) => s.fields.map((f) => f.key))]);
  for (const s of steps) {
    if ((s.tat.type === "before_field" || s.tat.type === "after_field") && s.tat.field && !allKeys.has(s.tat.field)) errors.push(`${s.code}: TAT column "${s.tat.field}" does not exist`);
    if (s.condition && !allKeys.has(s.condition.field)) errors.push(`${s.code}: condition column "${s.condition.field}" does not exist`);
  }
  const startField = str(input.start_field);
  if (startField && !fields.some((f) => f.key === startField)) errors.push(`Start column "${startField}" does not exist`);
  if (errors.length) fail(400, errors[0], { errors });
  return {
    def: {
      name, code: str(input.code).trim(), category: str(input.category).trim(), description: str(input.description), instructions: str(input.instructions),
      priority, status: input.status === "inactive" ? "inactive" : "active", is_template: input.is_template ? 1 : 0,
      access: JSON.stringify(spec(input.access)), calendar: JSON.stringify(input.calendar || {}), frequency, schedule: JSON.stringify(input.schedule || {}),
      start_date: str(input.start_date), due_date: str(input.due_date), start_field: startField, uid_prefix: str(input.uid_prefix).trim() || "UID-",
      settings: JSON.stringify(input.settings || {}),
    },
    fields, steps,
  };
}

type Normalised = ReturnType<typeof normaliseDefinition>;

/** Full definition as the API returns it. */
export async function getDefinition(env: Env, id: number) {
  const [d, st, fl] = await env.DB.batch([
    env.DB.prepare("SELECT * FROM fms_definitions WHERE id = ?").bind(id),
    env.DB.prepare("SELECT * FROM fms_steps WHERE fms_id = ? ORDER BY position, id").bind(id),
    env.DB.prepare("SELECT * FROM fms_fields WHERE fms_id = ? ORDER BY position, id").bind(id),
  ]);
  const def = (d.results as DefRow[])[0];
  if (!def) return null;
  const fields = fl.results as FieldRow[];
  const outField = (f: FieldRow) => ({ id: f.id, key: f.key, label: f.label, type: f.type, options: j(f.options, []), required: !!f.required, default_value: f.default_value, help: f.help, in_list: !!f.in_list });
  return {
    ...def, archived: !!def.archived, deleted: !!def.deleted, is_template: !!def.is_template,
    access: j(def.access, {}), calendar: j(def.calendar, {}), schedule: j(def.schedule, {}), settings: j(def.settings, {}),
    fields: fields.filter((f) => f.step_id == null).map(outField),
    steps: (st.results as StepRow[]).map((s) => ({
      id: s.id, position: s.position, code: s.code, name: s.name, seat_id: s.seat_id, assign: j(s.assign, {}), how: s.how, tat: j(s.tat, {}),
      condition: j(s.condition, null), requires_approval: !!s.requires_approval, approver: j(s.approver, {}), status_options: j(s.status_options, ["Done"]),
      reminder: j(s.reminder, {}), escalation: j(s.escalation, {}), jumps: j<Record<string, number>>(s.jumps, {}), fields: fields.filter((f) => f.step_id === s.id).map(outField),
    })),
  };
}

async function snapshot(env: Env, id: number, by: string) {
  const def = await getDefinition(env, id);
  if (!def) return;
  await env.DB.prepare("INSERT INTO fms_versions (fms_id, version, snapshot, created_by) VALUES (?, ?, ?, ?)").bind(id, def.version, JSON.stringify(def), by).run();
}

/** Create or update a definition. Keeps step/field ids so existing rows stay attached. */
export async function saveDefinition(env: Env, n: Normalised, by: string, existingId?: number): Promise<number> {
  const db = env.DB;
  let id = existingId;
  if (!id) {
    const seq = await db.prepare("UPDATE counters SET value = value + 1 WHERE name = 'fms' RETURNING value").first<{ value: number }>();
    const fmsId = `FMS-${String(seq!.value).padStart(4, "0")}`;
    const code = n.def.code || fmsId;
    const dupe = await db.prepare("SELECT 1 FROM fms_definitions WHERE code = ?").bind(code).first();
    if (dupe) fail(409, `FMS code "${code}" already exists`);
    const r = await db.prepare(
      `INSERT INTO fms_definitions (fms_id, code, name, category, description, instructions, priority, status, is_template, access, calendar, frequency, schedule,
         start_date, due_date, start_field, uid_prefix, settings, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    ).bind(fmsId, code, n.def.name, n.def.category, n.def.description, n.def.instructions, n.def.priority, n.def.status, n.def.is_template, n.def.access,
      n.def.calendar, n.def.frequency, n.def.schedule, n.def.start_date, n.def.due_date, n.def.start_field, n.def.uid_prefix, n.def.settings, by).first<{ id: number }>();
    id = r!.id;
  } else {
    if (n.def.code) {
      const dupe = await db.prepare("SELECT 1 FROM fms_definitions WHERE code = ? AND id != ?").bind(n.def.code, id).first();
      if (dupe) fail(409, `FMS code "${n.def.code}" already exists`);
    }
    await snapshot(env, id, by);
    await db.prepare(
      `UPDATE fms_definitions SET code = COALESCE(NULLIF(?, ''), code), name = ?, category = ?, description = ?, instructions = ?, priority = ?, status = ?, is_template = ?,
         access = ?, calendar = ?, frequency = ?, schedule = ?, start_date = ?, due_date = ?, start_field = ?, uid_prefix = ?, settings = ?,
         version = version + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
    ).bind(n.def.code, n.def.name, n.def.category, n.def.description, n.def.instructions, n.def.priority, n.def.status, n.def.is_template, n.def.access,
      n.def.calendar, n.def.frequency, n.def.schedule, n.def.start_date, n.def.due_date, n.def.start_field, n.def.uid_prefix, n.def.settings, id).run();
  }

  // ---- steps (keep ids; new ones get record_steps for existing rows)
  const existing = (await db.prepare("SELECT id FROM fms_steps WHERE fms_id = ?").bind(id).all<{ id: number }>()).results.map((r) => r.id);
  const keep = new Set(n.steps.map((s) => s.id).filter((x): x is number => !!x && existing.includes(x)));
  const removed = existing.filter((x) => !keep.has(x));
  if (removed.length) await db.batch(removed.map((sid) => db.prepare("DELETE FROM fms_steps WHERE id = ?").bind(sid)));
  const stepIds: number[] = [];
  for (let i = 0; i < n.steps.length; i++) {
    const s = n.steps[i];
    const vals = [i + 1, s.code, s.name, s.seat_id, JSON.stringify(s.assign), s.how, JSON.stringify(s.tat), s.condition ? JSON.stringify(s.condition) : "",
      s.requires_approval ? 1 : 0, JSON.stringify(s.approver), JSON.stringify(s.status_options), JSON.stringify(s.reminder), JSON.stringify(s.escalation), JSON.stringify(s.jumps)];
    if (s.id && keep.has(s.id)) {
      await db.prepare(`UPDATE fms_steps SET position = ?, code = ?, name = ?, seat_id = ?, assign = ?, how = ?, tat = ?, condition = ?, requires_approval = ?, approver = ?,
        status_options = ?, reminder = ?, escalation = ?, jumps = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).bind(...vals, s.id).run();
      stepIds.push(s.id);
    } else {
      const r = await db.prepare(`INSERT INTO fms_steps (fms_id, position, code, name, seat_id, assign, how, tat, condition, requires_approval, approver, status_options, reminder, escalation, jumps)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`).bind(id, ...vals).first<{ id: number }>();
      stepIds.push(r!.id);
      // existing rows: new step is skipped where the row already passed that point, waiting otherwise
      await db.prepare(`INSERT OR IGNORE INTO fms_record_steps (record_id, step_id, position, status)
        SELECT r.id, ?, ?, CASE WHEN r.status != 'open' OR (r.current_step > 0 AND r.current_step > ?) THEN 'skipped' ELSE 'waiting' END
        FROM fms_records r WHERE r.fms_id = ?`).bind(r!.id, i + 1, i + 1, id).run();
    }
  }
  await db.prepare("UPDATE fms_record_steps SET position = (SELECT position FROM fms_steps WHERE fms_steps.id = fms_record_steps.step_id) WHERE record_id IN (SELECT id FROM fms_records WHERE fms_id = ?)").bind(id).run();

  // ---- fields (row fields + step inputs); keys are stable
  const all = [...n.fields.map((f) => ({ f, step: null as number | null })), ...n.steps.flatMap((s, i) => s.fields.map((f) => ({ f, step: stepIds[i] })))];
  const curFields = (await db.prepare("SELECT id, key FROM fms_fields WHERE fms_id = ?").bind(id).all<{ id: number; key: string }>()).results;
  const wantKeys = new Set(all.map((x) => x.f.key));
  const stmts: D1PreparedStatement[] = curFields.filter((f) => !wantKeys.has(f.key)).map((f) => db.prepare("DELETE FROM fms_fields WHERE id = ?").bind(f.id));
  all.forEach(({ f, step }, pos) => {
    stmts.push(db.prepare(`INSERT INTO fms_fields (fms_id, step_id, key, label, type, options, required, default_value, help, position, in_list) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(fms_id, key) DO UPDATE SET step_id = excluded.step_id, label = excluded.label, type = excluded.type, options = excluded.options, required = excluded.required,
        default_value = excluded.default_value, help = excluded.help, position = excluded.position, in_list = excluded.in_list`)
      .bind(id, step, f.key, f.label, f.type, JSON.stringify(f.options || []), f.required ? 1 : 0, f.default_value || "", f.help || "", pos + 1, f.in_list === false ? 0 : 1));
  });
  for (let i = 0; i < stmts.length; i += 100) await db.batch(stmts.slice(i, i + 100));
  return id!;
}

/** Turn a stored definition back into an input payload (duplicate / templates / version restore). */
export function toInput(def: NonNullable<Awaited<ReturnType<typeof getDefinition>>>, keepIds: boolean): DefinitionInput {
  return {
    name: def.name, code: def.code, category: def.category, description: def.description, instructions: def.instructions, priority: def.priority,
    status: def.status, is_template: def.is_template, access: def.access as any, calendar: def.calendar as any, frequency: def.frequency,
    schedule: def.schedule as any, start_date: def.start_date, due_date: def.due_date, start_field: def.start_field, uid_prefix: def.uid_prefix,
    settings: def.settings as any,
    fields: def.fields.map((f) => ({ ...f, id: keepIds ? f.id : undefined })),
    steps: def.steps.map((s) => ({ ...s, id: keepIds ? s.id : undefined, fields: s.fields.map((f) => ({ ...f, id: keepIds ? f.id : undefined })) })) as StepInput[],
  };
}

// ------------------------------------------------------------------ values
/**
 * Validate values for a set of fields. strict: types + required enforced (forms);
 * lenient: keep whatever came in as text (imports from sheets).
 */
export function coerceValues(fields: Pick<FieldRow, "key" | "label" | "type" | "options" | "required">[], input: Record<string, unknown>, mode: "strict" | "lenient" | "partial") {
  const values: Record<string, unknown> = {};
  const errors: string[] = [];
  for (const f of fields) {
    const has = Object.prototype.hasOwnProperty.call(input, f.key);
    if (!has && mode === "partial") continue;
    const raw = input[f.key];
    const empty = raw === undefined || raw === null || raw === "" || (Array.isArray(raw) && !raw.length);
    if (empty) {
      if (f.required && mode === "strict") errors.push(`${f.label} is required`);
      values[f.key] = f.type === "multiselect" ? [] : "";
      continue;
    }
    if (mode === "lenient") {
      // imports: never reject, but normalise what can be read so dates/numbers sort and filter like form entries
      if (f.type === "date" || f.type === "datetime") {
        const d = parseInstant(raw);
        values[f.key] = !d ? str(raw) : f.type === "date" ? new Date(d.getTime() + 330 * 60_000).toISOString().slice(0, 10) : d.toISOString();
      } else if (f.type === "number" && /^-?[\d,]+(\.\d+)?$/.test(str(raw).trim())) values[f.key] = Number(str(raw).replace(/,/g, ""));
      else if (f.type === "multiselect") values[f.key] = (Array.isArray(raw) ? raw : str(raw).split(",")).map((x) => str(x).trim()).filter(Boolean);
      else values[f.key] = Array.isArray(raw) ? raw.map(str).join(", ") : str(raw);
      continue;
    }
    const opts = j<string[]>(f.options, []);
    switch (f.type) {
      case "number": { const n = Number(String(raw).replace(/,/g, "")); if (isNaN(n)) errors.push(`${f.label} must be a number`); else values[f.key] = n; break; }
      case "date": { const d = parseInstant(raw); if (!d) errors.push(`${f.label} must be a date`); else values[f.key] = new Date(d.getTime() + 330 * 60_000).toISOString().slice(0, 10); break; }
      case "datetime": { const d = parseInstant(raw); if (!d) errors.push(`${f.label} must be a date and time`); else values[f.key] = d.toISOString(); break; }
      case "select": if (opts.length && !opts.includes(str(raw))) errors.push(`${f.label}: "${raw}" is not an allowed option`); else values[f.key] = str(raw); break;
      case "multiselect": { const arr = (Array.isArray(raw) ? raw : str(raw).split(",")).map((x) => str(x).trim()).filter(Boolean); const bad = arr.filter((x) => opts.length && !opts.includes(x)); if (bad.length) errors.push(`${f.label}: ${bad.join(", ")} not allowed`); else values[f.key] = arr; break; }
      case "email": if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(str(raw).trim())) errors.push(`${f.label} must be an email`); else values[f.key] = str(raw).trim(); break;
      case "phone": if (!/^[+\d][\d\s-]{6,}$/.test(str(raw).trim())) errors.push(`${f.label} must be a phone number`); else values[f.key] = str(raw).trim(); break;
      case "url": if (!/^https?:\/\//i.test(str(raw).trim())) errors.push(`${f.label} must start with http(s)://`); else values[f.key] = str(raw).trim(); break;
      case "checkbox": values[f.key] = raw === true || /^(true|yes|1|y)$/i.test(str(raw)); break;
      default: values[f.key] = str(raw).slice(0, 10000);
    }
  }
  return { values, errors };
}

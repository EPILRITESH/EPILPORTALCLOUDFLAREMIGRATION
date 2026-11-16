// FMS builder: basic info, access + schedule + calendar, dynamic columns, steps (WHAT / WHO / HOW / WHEN,
// conditions, approvals, reminders, step inputs), and a sheet-style preview.
import React, { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import api, { errMsg } from "./shared/api";
import { Btn, Spinner, Tabs, ErrorBox, Label, inputCls, MultiPick, useFlash, cx } from "./shared/ui";
import { FmsNav } from "./FmsAdmin";

const TYPES = [["text", "Text"], ["textarea", "Long text"], ["number", "Number"], ["date", "Date"], ["datetime", "Date & time"], ["select", "Dropdown"], ["multiselect", "Multi-select"],
  ["checkbox", "Yes / No"], ["email", "Email"], ["phone", "Phone"], ["url", "Link"], ["employee", "Employee"], ["file", "File note"]];
const OPS = [["eq", "is"], ["neq", "is not"], ["in", "is one of"], ["not_in", "is not one of"], ["empty", "is empty"], ["not_empty", "is filled"], ["contains", "contains"]];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const slug = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 48) || "field";
const blankDef = () => ({
  name: "", code: "", category: "", description: "", instructions: "", priority: "Medium", status: "active", is_template: false,
  access: { departments: [], designations: [], employees: [] }, calendar: { workStart: "10:00", workEnd: "19:00", weeklyOff: [0] },
  frequency: "on_demand", schedule: { time: "10:00", days: [], dates: [1], months: [1] }, start_date: "", due_date: "", start_field: "", uid_prefix: "UID-",
  settings: { reminderHours: 2, escalationHours: 0 }, fields: [], steps: [],
});
const newStep = (i) => ({ name: "", code: `STEP-${i + 1}`, seat_id: null, assign: { departments: [], designations: [], employees: [] }, how: "", tat: { type: "days", value: 1, from: "previous" }, condition: null, requires_approval: false, approver: { seat_id: null, departments: [], designations: [], employees: [] }, status_options: ["Done"], jumps: {}, reminder: {}, escalation: {}, fields: [] });
const move = (arr, i, d) => { const a = [...arr]; const j = i + d; if (j < 0 || j >= a.length) return a; [a[i], a[j]] = [a[j], a[i]]; return a; };

function FieldsEditor({ fields, onChange, allKeys, title }) {
  const set = (i, patch) => {
    const next = fields.map((f, k) => (k === i ? { ...f, ...patch } : f));
    if (patch.label !== undefined && !fields[i].id) {
      // new field: keep its key in step with the name (unique)
      const taken = new Set(allKeys.filter((k) => k !== fields[i].key));
      let key = slug(patch.label), n = 2;
      while (taken.has(key)) key = `${slug(patch.label)}_${n++}`;
      next[i].key = key;
    }
    onChange(next);
  };
  return (
    <div className="space-y-2">
      {fields.map((f, i) => (
        <div key={f.id || `n${i}`} className="grid items-start gap-2 rounded-md border bg-white p-2 md:grid-cols-12">
          <div className="md:col-span-3">
            <input className={inputCls} placeholder={`${title} name`} value={f.label} onChange={(e) => set(i, { label: e.target.value })} />
            <div className="mt-0.5 text-[11px] text-gray-400">key: {f.key || "—"}</div>
          </div>
          <select className={cx(inputCls, "md:col-span-2")} value={f.type} onChange={(e) => set(i, { type: e.target.value })}>
            {TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <div className="md:col-span-4">
            {["select", "multiselect"].includes(f.type)
              ? <MultiPick allowCustom options={f.options || []} value={f.options || []} onChange={(v) => set(i, { options: v })} placeholder="Type an option, Enter" />
              : <input className={inputCls} placeholder="Default value (optional)" value={f.default_value || ""} onChange={(e) => set(i, { default_value: e.target.value })} />}
            <input className={cx(inputCls, "mt-1")} placeholder="Help text (optional)" value={f.help || ""} onChange={(e) => set(i, { help: e.target.value })} />
          </div>
          <div className="flex flex-wrap items-center gap-3 text-sm md:col-span-2">
            <label className="flex items-center gap-1"><input type="checkbox" checked={!!f.required} onChange={(e) => set(i, { required: e.target.checked })} /> Required</label>
            {title === "Column" && <label className="flex items-center gap-1"><input type="checkbox" checked={f.in_list !== false} onChange={(e) => set(i, { in_list: e.target.checked })} /> In grid</label>}
          </div>
          <div className="flex gap-1 md:col-span-1">
            <Btn size="sm" kind="ghost" onClick={() => onChange(move(fields, i, -1))} title="Up">↑</Btn>
            <Btn size="sm" kind="ghost" onClick={() => onChange(move(fields, i, 1))} title="Down">↓</Btn>
            <Btn size="sm" kind="ghost" className="text-red-600" onClick={() => onChange(fields.filter((_, k) => k !== i))} title="Remove">✕</Btn>
          </div>
        </div>
      ))}
      <Btn kind="secondary" size="sm" onClick={() => onChange([...fields, { label: "", key: "", type: "text", options: [], required: false, in_list: true }])}>+ Add {title.toLowerCase()}</Btn>
    </div>
  );
}

function WhoPicker({ value, onChange, lk, withSeat = true }) {
  const v = value || {};
  return (
    <div className="grid gap-2 md:grid-cols-2">
      {withSeat && (
        <div>
          <Label>Seat</Label>
          <select className={inputCls} value={v.seat_id || ""} onChange={(e) => onChange({ ...v, seat_id: e.target.value ? Number(e.target.value) : null })}>
            <option value="">— No seat —</option>
            {lk.seats.map((s) => <option key={s.id} value={s.id}>{s.code}{s.name && s.name !== s.code ? ` · ${s.name}` : ""}</option>)}
          </select>
        </div>
      )}
      <div><Label>Departments</Label><MultiPick options={lk.departments} value={v.departments || []} onChange={(x) => onChange({ ...v, departments: x })} allowCustom /></div>
      <div><Label>Designations</Label><MultiPick options={lk.designations} value={v.designations || []} onChange={(x) => onChange({ ...v, designations: x })} allowCustom /></div>
      <div><Label>Employees</Label><MultiPick options={lk.employees.map((e) => ({ value: e.employee_id, label: `${e.name} (${e.department || "—"})` }))} value={v.employees || []} onChange={(x) => onChange({ ...v, employees: x })} /></div>
    </div>
  );
}

export default function FmsBuilder() {
  const { id } = useParams();
  const nav = useNavigate();
  const [def, setDef] = useState(id ? null : blankDef());
  const [lk, setLk] = useState({ departments: [], designations: [], employees: [], seats: [] });
  const [tab, setTab] = useState("basic");
  const [errors, setErrors] = useState([]);
  const [busy, setBusy] = useState(false);
  const [flash, flashNode] = useFlash();

  useEffect(() => {
    api.get("/lookups").then((r) => setLk(r.data)).catch(() => {});
    if (id) api.get(`/definitions/${id}`).then((r) => {
      const d = r.data.definition;
      setDef({ ...blankDef(), ...d, schedule: { ...blankDef().schedule, ...d.schedule }, calendar: { ...blankDef().calendar, ...d.calendar }, settings: { ...blankDef().settings, ...d.settings } });
    }).catch((e) => setErrors([errMsg(e)]));
  }, [id]);

  const allKeys = useMemo(() => (def ? [...def.fields.map((f) => f.key), ...def.steps.flatMap((s) => s.fields.map((f) => f.key))].filter(Boolean) : []), [def]);
  const dateFields = useMemo(() => (def ? [...def.fields, ...def.steps.flatMap((s) => s.fields)].filter((f) => f.type === "date" || f.type === "datetime") : []), [def]);
  if (!def) return <div><FmsNav /><ErrorBox>{errors[0]}</ErrorBox><Spinner /></div>;

  const set = (patch) => setDef({ ...def, ...patch });
  const noAccess = !def.access?.departments?.length && !def.access?.designations?.length;
  const setStep = (i, patch) => set({ steps: def.steps.map((s, k) => (k === i ? { ...s, ...patch } : s)) });
  const fieldsBefore = (i) => [...def.fields, ...def.steps.slice(0, i + 1).flatMap((s) => s.fields)].filter((f) => f.key);

  const save = async () => {
    if (noAccess) { setTab("basic"); setErrors(["Select at least one department or designation in “Visible to”"]); window.scrollTo(0, 0); return; }
    setBusy(true); setErrors([]);
    try {
      const body = { ...def, steps: def.steps.map((s, i) => ({ ...s, code: s.code || `STEP-${i + 1}` })) };
      const r = id ? await api.put(`/definitions/${id}`, body) : await api.post("/definitions", body);
      flash("Saved");
      if (!id) nav(`/fms/${r.data.id}`); else setDef({ ...def, ...r.data.definition });
    } catch (e) {
      setErrors(e.response?.data?.errors || [errMsg(e)]);
      window.scrollTo(0, 0);
    } finally { setBusy(false); }
  };

  return (
    <div>
      <FmsNav />{flashNode}
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-bold">{id ? `Edit · ${def.name}` : "New FMS"}{id && <span className="ml-2 text-sm font-normal text-gray-500">{def.fms_id} · v{def.version}</span>}</h1>
        <div className="flex gap-2">
          <Btn kind="secondary" onClick={() => nav(id ? `/fms/${id}` : "/fms")}>Cancel</Btn>
          <Btn busy={busy} onClick={save}>{id ? "Save changes" : "Create FMS"}</Btn>
        </div>
      </div>
      {errors.length > 0 && <div className="mb-3 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700"><b>Please fix:</b><ul className="ml-5 list-disc">{errors.map((e) => <li key={e}>{e}</li>)}</ul></div>}
      <Tabs value={tab} onChange={setTab} tabs={[{ value: "basic", label: "Basic" }, { value: "access", label: "Schedule & calendar" }, { value: "columns", label: "Columns", count: def.fields.length }, { value: "steps", label: "Steps", count: def.steps.length }, { value: "preview", label: "Preview" }]} />
      <div className="mt-4">
        {tab === "basic" && (
          <div className="grid gap-4 rounded-lg border bg-white p-4 md:grid-cols-2">
            <div><Label required>FMS name</Label><input className={inputCls} value={def.name} onChange={(e) => set({ name: e.target.value })} placeholder="e.g. CRM ACTIVITY FMS" /></div>
            <div><Label>Code</Label><input className={inputCls} value={def.code} onChange={(e) => set({ code: e.target.value })} placeholder="e.g. FMS-20 (auto if empty)" /></div>
            <div><Label>Category</Label><input className={inputCls} value={def.category} onChange={(e) => set({ category: e.target.value })} placeholder="e.g. CRM, Dispatch, HR" /></div>
            <div className="grid grid-cols-2 gap-2">
              <div><Label>Priority</Label><select className={inputCls} value={def.priority} onChange={(e) => set({ priority: e.target.value })}>{["Low", "Medium", "High", "Critical"].map((p) => <option key={p}>{p}</option>)}</select></div>
              <div><Label>Status</Label><select className={inputCls} value={def.status} onChange={(e) => set({ status: e.target.value })}><option value="active">Active</option><option value="inactive">Inactive</option></select></div>
            </div>
            <div className="md:col-span-2"><Label>Description</Label><textarea rows={2} className={inputCls} value={def.description} onChange={(e) => set({ description: e.target.value })} /></div>
            <div className="md:col-span-2"><Label>Instructions for doers</Label><textarea rows={3} className={inputCls} value={def.instructions} onChange={(e) => set({ instructions: e.target.value })} placeholder="Shown on every task of this FMS" /></div>
            <div><Label>UID prefix</Label><input className={inputCls} value={def.uid_prefix} onChange={(e) => set({ uid_prefix: e.target.value })} /></div>
            <div>
              <Label>Row start time (base for STEP-1 TAT)</Label>
              <select className={inputCls} value={def.start_field} onChange={(e) => set({ start_field: e.target.value })}>
                <option value="">When the row is created</option>
                {def.fields.filter((f) => f.key && (f.type === "date" || f.type === "datetime")).map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
              </select>
            </div>
            <div className={`rounded-md border p-3 md:col-span-2 ${noAccess ? "border-red-300 bg-red-50" : "border-blue-200 bg-blue-50/50"}`}>
              <Label required>Visible to — department / designation</Label>
              <p className="mb-2 text-xs text-gray-600">Only doers of these departments or designations see this FMS and can add entries (select at least one). Extra individual employees are optional. Admins always see everything.</p>
              <WhoPicker value={def.access} lk={lk} withSeat={false} onChange={(v) => set({ access: v })} />
            </div>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={!!def.is_template} onChange={(e) => set({ is_template: e.target.checked })} /> This is a template (not used for rows)</label>
          </div>
        )}

        {tab === "access" && (
          <div className="space-y-4">
            <div className="rounded-lg border bg-white p-4">
              <h3 className="mb-2 font-semibold">Working calendar (for TAT)</h3>
              <div className="grid gap-3 md:grid-cols-3">
                <div><Label>Work starts</Label><input type="time" className={inputCls} value={def.calendar.workStart} onChange={(e) => set({ calendar: { ...def.calendar, workStart: e.target.value } })} /></div>
                <div><Label>Work ends</Label><input type="time" className={inputCls} value={def.calendar.workEnd} onChange={(e) => set({ calendar: { ...def.calendar, workEnd: e.target.value } })} /></div>
                <div><Label>Weekly off</Label>
                  <div className="flex flex-wrap gap-2 pt-1">{DAYS.map((d, i) => <label key={d} className="flex items-center gap-1 text-sm"><input type="checkbox" checked={def.calendar.weeklyOff.includes(i)} onChange={(e) => set({ calendar: { ...def.calendar, weeklyOff: e.target.checked ? [...def.calendar.weeklyOff, i] : def.calendar.weeklyOff.filter((x) => x !== i) } })} />{d}</label>)}</div>
                </div>
              </div>
              <p className="mt-2 text-xs text-gray-500">Holidays are set once for all FMS under Seating &amp; Holidays.</p>
            </div>
            <div className="rounded-lg border bg-white p-4">
              <h3 className="mb-2 font-semibold">Recurrence</h3>
              <div className="grid gap-3 md:grid-cols-4">
                <div><Label>Frequency</Label>
                  <select className={inputCls} value={def.frequency} onChange={(e) => set({ frequency: e.target.value })}>
                    {[["on_demand", "On demand (rows added manually)"], ["one_time", "One time"], ["daily", "Daily"], ["weekly", "Weekly"], ["monthly", "Monthly"], ["quarterly", "Quarterly"], ["yearly", "Yearly"]].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </select>
                </div>
                <div><Label>Start date</Label><input type="date" className={inputCls} value={def.start_date} onChange={(e) => set({ start_date: e.target.value })} /></div>
                <div><Label>End / due date</Label><input type="date" className={inputCls} value={def.due_date} onChange={(e) => set({ due_date: e.target.value })} /></div>
                {def.frequency !== "on_demand" && <div><Label>Create at (IST)</Label><input type="time" className={inputCls} value={def.schedule.time || "10:00"} onChange={(e) => set({ schedule: { ...def.schedule, time: e.target.value } })} /></div>}
              </div>
              {["daily", "weekly"].includes(def.frequency) && (
                <div className="mt-3"><Label>{def.frequency === "daily" ? "On these days (empty = Mon–Sat)" : "On these weekdays"}</Label>
                  <div className="flex flex-wrap gap-2">{DAYS.map((d, i) => <label key={d} className="flex items-center gap-1 text-sm"><input type="checkbox" checked={(def.schedule.days || []).includes(i)} onChange={(e) => set({ schedule: { ...def.schedule, days: e.target.checked ? [...(def.schedule.days || []), i] : (def.schedule.days || []).filter((x) => x !== i) } })} />{d}</label>)}</div>
                </div>
              )}
              {["monthly", "quarterly", "yearly"].includes(def.frequency) && (
                <div className="mt-3 grid gap-3 md:grid-cols-2">
                  <div><Label>Day(s) of month</Label><input className={inputCls} value={(def.schedule.dates || []).join(", ")} onChange={(e) => set({ schedule: { ...def.schedule, dates: e.target.value.split(",").map((x) => Number(x.trim())).filter((n) => n >= 1 && n <= 31) } })} placeholder="e.g. 1, 15" /></div>
                  {def.frequency === "yearly" && <div><Label>Month(s) (1–12)</Label><input className={inputCls} value={(def.schedule.months || []).join(", ")} onChange={(e) => set({ schedule: { ...def.schedule, months: e.target.value.split(",").map((x) => Number(x.trim())).filter((n) => n >= 1 && n <= 12) } })} /></div>}
                </div>
              )}
              {def.frequency !== "on_demand" && <p className="mt-2 text-xs text-gray-500">A new row is created automatically each period (checked every hour). Column defaults are used as its values.</p>}
            </div>
            <div className="rounded-lg border bg-white p-4">
              <h3 className="mb-2 font-semibold">Reminders &amp; escalation (defaults for all steps)</h3>
              <div className="grid gap-3 md:grid-cols-2">
                <div><Label>Remind doers this many hours before due</Label><input type="number" min="0" className={inputCls} value={def.settings.reminderHours ?? 2} onChange={(e) => set({ settings: { ...def.settings, reminderHours: Number(e.target.value) } })} /></div>
                <div><Label>Escalate to admins this many hours after due</Label><input type="number" min="0" className={inputCls} value={def.settings.escalationHours ?? 0} onChange={(e) => set({ settings: { ...def.settings, escalationHours: Number(e.target.value) } })} /></div>
              </div>
            </div>
          </div>
        )}

        {tab === "columns" && (
          <div className="rounded-lg border bg-gray-50 p-4">
            <p className="mb-3 text-sm text-gray-600">The FMS's own data columns (filled when a row is created). Step inputs are added on each step.</p>
            <FieldsEditor title="Column" fields={def.fields} allKeys={allKeys} onChange={(fields) => set({ fields })} />
          </div>
        )}

        {tab === "steps" && (
          <div className="space-y-4">
            {def.steps.map((s, i) => (
              <div key={s.id || `n${i}`} className="rounded-lg border bg-white p-4 shadow-sm">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="rounded bg-gray-800 px-2 py-0.5 text-sm font-bold text-white">{s.code || `STEP-${i + 1}`}</span>
                    <input className={`${inputCls} w-28`} value={s.code} onChange={(e) => setStep(i, { code: e.target.value })} title="Step code" />
                  </div>
                  <div className="flex gap-1">
                    <Btn size="sm" kind="ghost" onClick={() => set({ steps: move(def.steps, i, -1) })}>↑ Up</Btn>
                    <Btn size="sm" kind="ghost" onClick={() => set({ steps: move(def.steps, i, 1) })}>↓ Down</Btn>
                    <Btn size="sm" kind="ghost" onClick={() => set({ steps: [...def.steps.slice(0, i + 1), { ...JSON.parse(JSON.stringify(s)), id: undefined, code: `STEP-${def.steps.length + 1}`, fields: [] }, ...def.steps.slice(i + 1)] })}>Duplicate</Btn>
                    <Btn size="sm" kind="ghost" className="text-red-600" onClick={() => set({ steps: def.steps.filter((_, k) => k !== i) })}>Remove</Btn>
                  </div>
                </div>
                <div className="grid gap-3 md:grid-cols-2">
                  <div><Label required>WHAT — step name</Label><input className={inputCls} value={s.name} onChange={(e) => setStep(i, { name: e.target.value })} placeholder="e.g. Confirm status from dispatch" /></div>
                  <div><Label>HOW — method / instruction</Label><input className={inputCls} value={s.how} onChange={(e) => setStep(i, { how: e.target.value })} placeholder="e.g. Phone call, WhatsApp" /></div>
                </div>
                <div className="mt-3"><Label required>WHO — doer (seat and/or department / designation / employees)</Label>
                  <WhoPicker value={{ seat_id: s.seat_id, ...s.assign }} lk={lk} onChange={(v) => setStep(i, { seat_id: v.seat_id, assign: { departments: v.departments || [], designations: v.designations || [], employees: v.employees || [] } })} />
                </div>
                <div className="mt-3 grid gap-3 md:grid-cols-4">
                  <div><Label>WHEN — TAT type</Label>
                    <select className={inputCls} value={s.tat?.type || "none"} onChange={(e) => setStep(i, { tat: { ...s.tat, type: e.target.value } })}>
                      <option value="none">No deadline</option><option value="hours">Working hours</option><option value="days">Working days</option>
                      <option value="before_field">Days before a date column (T-n)</option><option value="after_field">Working days after a date column</option>
                    </select>
                  </div>
                  {s.tat?.type !== "none" && <div><Label>{s.tat?.type === "hours" ? "Hours" : "Days"}</Label><input type="number" min="0" step="any" className={inputCls} value={s.tat?.value ?? 0} onChange={(e) => setStep(i, { tat: { ...s.tat, value: Number(e.target.value) } })} /></div>}
                  {["before_field", "after_field"].includes(s.tat?.type) && (
                    <div><Label>Date column</Label>
                      <select className={inputCls} value={s.tat?.field || ""} onChange={(e) => setStep(i, { tat: { ...s.tat, field: e.target.value } })}>
                        <option value="">— choose —</option>{dateFields.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
                      </select>
                    </div>
                  )}
                  {["hours", "days"].includes(s.tat?.type) && (
                    <div><Label>Counted from</Label>
                      <select className={inputCls} value={s.tat?.from || "previous"} onChange={(e) => setStep(i, { tat: { ...s.tat, from: e.target.value } })}>
                        <option value="previous">{i === 0 ? "Row start time" : "Previous step's actual"}</option><option value="start">Row start time</option>
                      </select>
                    </div>
                  )}
                </div>
                <div className="mt-3 grid gap-3 md:grid-cols-4">
                  <div className="md:col-span-4"><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={!!s.condition} onChange={(e) => setStep(i, { condition: e.target.checked ? { field: "", op: "eq", value: "" } : null })} /> Run this step only if… (otherwise it is skipped)</label></div>
                  {s.condition && (
                    <>
                      <select className={inputCls} value={s.condition.field} onChange={(e) => setStep(i, { condition: { ...s.condition, field: e.target.value } })}>
                        <option value="">— column —</option>{fieldsBefore(i - 1).map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
                      </select>
                      <select className={inputCls} value={s.condition.op} onChange={(e) => setStep(i, { condition: { ...s.condition, op: e.target.value } })}>{OPS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
                      {!["empty", "not_empty"].includes(s.condition.op) && <input className={`${inputCls} md:col-span-2`} value={Array.isArray(s.condition.value) ? s.condition.value.join(", ") : s.condition.value ?? ""} placeholder={["in", "not_in"].includes(s.condition.op) ? "values, comma separated" : "value"}
                        onChange={(e) => setStep(i, { condition: { ...s.condition, value: ["in", "not_in"].includes(s.condition.op) ? e.target.value.split(",").map((x) => x.trim()).filter(Boolean) : e.target.value } })} />}
                    </>
                  )}
                </div>
                <div className="mt-3 grid gap-3 md:grid-cols-2">
                  <div>
                    <Label>Status options for the doer</Label>
                    <MultiPick allowCustom options={s.status_options} value={s.status_options} onChange={(v) => setStep(i, { status_options: v })} placeholder="e.g. Done, Close" />
                    {i + 2 < def.steps.length && s.status_options.length > 0 && (
                      <div className="mt-2 space-y-1">
                        <p className="text-xs text-gray-500">Jump ahead (like “Close” in the sheet): steps in between are skipped</p>
                        {s.status_options.map((o) => (
                          <div key={o} className="flex items-center gap-2 text-sm">
                            <span className="w-28 truncate">{o} →</span>
                            <select className="rounded border px-2 py-1" value={s.jumps?.[o] || ""} onChange={(e) => { const j = { ...(s.jumps || {}) }; if (e.target.value) j[o] = Number(e.target.value); else delete j[o]; setStep(i, { jumps: j }); }}>
                              <option value="">next step</option>
                              {def.steps.map((t, k) => k >= i + 2 && <option key={k} value={k + 1}>{t.code || `STEP-${k + 1}`}: {t.name}</option>)}
                            </select>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div><Label>Reminder (hours before)</Label><input type="number" min="0" className={inputCls} value={s.reminder?.beforeHours ?? ""} placeholder="default" onChange={(e) => setStep(i, { reminder: { ...s.reminder, beforeHours: e.target.value === "" ? undefined : Number(e.target.value) } })} /></div>
                    <div><Label>Escalate (hours after)</Label><input type="number" min="0" className={inputCls} value={s.escalation?.afterHours ?? ""} placeholder="default" onChange={(e) => setStep(i, { escalation: { ...s.escalation, afterHours: e.target.value === "" ? undefined : Number(e.target.value) } })} /></div>
                  </div>
                </div>
                <div className="mt-3 rounded-md bg-gray-50 p-3">
                  <label className="flex items-center gap-2 text-sm font-medium"><input type="checkbox" checked={!!s.requires_approval} onChange={(e) => setStep(i, { requires_approval: e.target.checked })} /> Needs approval before the next step</label>
                  {s.requires_approval && <div className="mt-2"><p className="mb-1 text-xs text-gray-500">Approvers (empty = admins only; admins can always approve)</p><WhoPicker value={s.approver} lk={lk} onChange={(v) => setStep(i, { approver: v })} /></div>}
                </div>
                <div className="mt-3">
                  <Label>Step inputs (columns the doer fills in this step)</Label>
                  <FieldsEditor title="Input" fields={s.fields} allKeys={allKeys} onChange={(fields) => setStep(i, { fields })} />
                </div>
              </div>
            ))}
            <Btn onClick={() => set({ steps: [...def.steps, newStep(def.steps.length)] })}>+ Add step</Btn>
          </div>
        )}

        {tab === "preview" && (
          <div className="overflow-x-auto rounded-lg border bg-white">
            <table className="min-w-full border-collapse text-xs">
              <tbody>
                {[["WHAT", (s) => s.name], ["WHO", (s) => [lk.seats.find((x) => x.id === s.seat_id)?.code, ...(s.assign?.departments || []), ...(s.assign?.designations || [])].filter(Boolean).join(", ")], ["HOW", (s) => s.how], ["WHEN", (s) => ({ hours: `${s.tat?.value}h`, days: `${s.tat?.value}d`, before_field: `T-${s.tat?.value}`, after_field: `T+${s.tat?.value}` }[s.tat?.type] || "—")]].map(([label, fn]) => (
                  <tr key={label}>
                    <td className="border bg-gray-100 px-2 py-1 font-bold" colSpan={def.fields.length || 1}>{label}</td>
                    {def.steps.map((s, i) => <td key={i} className="border bg-yellow-50 px-2 py-1" colSpan={4 + s.fields.length}>{fn(s)}</td>)}
                  </tr>
                ))}
                <tr className="bg-gray-800 text-white">
                  {def.fields.length ? def.fields.map((f) => <th key={f.key} className="border px-2 py-1">{f.label}</th>) : <th className="border px-2 py-1">—</th>}
                  {def.steps.map((s, i) => <React.Fragment key={i}>{s.fields.map((f) => <th key={f.key} className="border px-2 py-1">{f.label}</th>)}<th className="border px-2 py-1">Planned</th><th className="border px-2 py-1">Actual</th><th className="border px-2 py-1">Status</th><th className="border px-2 py-1">Delay</th></React.Fragment>)}
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Btn kind="secondary" onClick={() => nav(id ? `/fms/${id}` : "/fms")}>Cancel</Btn>
        <Btn busy={busy} onClick={save}>{id ? "Save changes" : "Create FMS"}</Btn>
      </div>
    </div>
  );
}

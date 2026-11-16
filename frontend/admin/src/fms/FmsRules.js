// Builder pieces for Excel-style logic: formula box (with Test + reference help), plan rules,
// "starts after" (step order / parallel steps) and condition rows.
import React, { useEffect, useState } from "react";
import api, { errMsg } from "./shared/api";
import { Btn, Label, inputCls, cx } from "./shared/ui";

export const OPS = [["eq", "is"], ["neq", "is not"], ["in", "is one of"], ["not_in", "is not one of"], ["empty", "is empty"], ["not_empty", "is filled"], ["contains", "contains"],
  ["gt", ">"], ["gte", "≥"], ["lt", "<"], ["lte", "≤"]];
const UNITS = [["working_days", "working days"], ["working_hours", "working hours"], ["days", "calendar days"], ["hours", "hours"], ["minutes", "minutes"]];

/** References usable by step index `upto` (0-based; steps before it + its own inputs). */
export function refOptions(def, upto) {
  const out = def.fields.filter((f) => f.key).map((f) => ({ value: f.key, label: f.label, type: f.type }));
  def.steps.slice(0, Math.max(0, upto + 1)).forEach((s, k) => {
    for (const f of s.fields || []) if (f.key) out.push({ value: f.key, label: `${s.code || `STEP-${k + 1}`} · ${f.label}`, type: f.type });
  });
  def.steps.slice(0, Math.max(0, upto)).forEach((s, k) => {
    const n = k + 1, c = s.code || `STEP-${n}`;
    out.push({ value: `step${n}.status`, label: `${c} · status` }, { value: `step${n}.actual`, label: `${c} · actual (done time)`, type: "datetime" },
      { value: `step${n}.planned`, label: `${c} · planned`, type: "datetime" }, { value: `step${n}.done_by`, label: `${c} · done by` });
  });
  out.push({ value: "row.start", label: "Row start time", type: "datetime" }, { value: "row.created", label: "Row created time", type: "datetime" }, { value: "row.uid", label: "UID" });
  return out;
}

export function ConditionRows({ value = [], onChange, refs }) {
  const set = (k, patch) => onChange(value.map((c, j) => (j === k ? { ...c, ...patch } : c)));
  return (
    <div className="space-y-1">
      {value.map((c, k) => (
        <div key={k} className="flex flex-wrap items-center gap-1 text-sm">
          {k > 0 && <span className="text-xs font-semibold text-gray-500">AND</span>}
          <select className="rounded border px-2 py-1" value={c.field} onChange={(e) => set(k, { field: e.target.value })}>
            <option value="">— column —</option>{refs.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
          </select>
          <select className="rounded border px-2 py-1" value={c.op} onChange={(e) => set(k, { op: e.target.value })}>{OPS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
          {!["empty", "not_empty"].includes(c.op) && <input className="w-40 rounded border px-2 py-1" value={Array.isArray(c.value) ? c.value.join(", ") : c.value ?? ""} placeholder={["in", "not_in"].includes(c.op) ? "a, b, c" : "value"}
            onChange={(e) => set(k, { value: ["in", "not_in"].includes(c.op) ? e.target.value.split(",").map((x) => x.trim()).filter(Boolean) : e.target.value })} />}
          <button type="button" className="px-1 text-red-600" onClick={() => onChange(value.filter((_, j) => j !== k))}>✕</button>
        </div>
      ))}
      <Btn size="sm" kind="ghost" onClick={() => onChange([...value, { field: "", op: "eq", value: "" }])}>+ condition</Btn>
    </div>
  );
}

let FUNCS_CACHE = null;
export function FormulaBox({ value, onChange, refs, fmsId, type, placeholder }) {
  const [res, setRes] = useState(null);
  const [help, setHelp] = useState(false);
  const [funcs, setFuncs] = useState(FUNCS_CACHE || []);
  useEffect(() => { if (help && !funcs.length) api.get("/formula/help").then((r) => { FUNCS_CACHE = r.data.functions; setFuncs(r.data.functions); }).catch(() => {}); }, [help, funcs.length]);
  const test = async () => {
    try { const r = await api.post("/formula/test", { formula: value, type, fms_id: fmsId }); setRes({ ok: true, text: `= ${r.data.display === "" ? "(blank)" : String(r.data.display)}${r.data.row ? `   (row ${r.data.row})` : "   (no rows yet — references are blank)"}` }); }
    catch (e) { setRes({ ok: false, text: errMsg(e) }); }
  };
  return (
    <div>
      <textarea rows={2} className={cx(inputCls, "font-mono text-xs")} value={value || ""} placeholder={placeholder || 'e.g. IF({qty} > 100, "BIG", "SMALL")'} onChange={(e) => { onChange(e.target.value); setRes(null); }} />
      <div className="mt-1 flex flex-wrap items-center gap-2">
        <Btn size="sm" kind="secondary" disabled={!value} onClick={test}>Test</Btn>
        <select className="rounded border px-1 py-0.5 text-xs" value="" onChange={(e) => e.target.value && onChange(`${value || ""}{${e.target.value}}`)}>
          <option value="">+ insert reference…</option>{refs.map((r) => <option key={r.value} value={r.value}>{r.label} → {`{${r.value}}`}</option>)}
        </select>
        <Btn size="sm" kind="link" onClick={() => setHelp(!help)}>{help ? "Hide help" : "Formula help"}</Btn>
        {res && <span className={cx("text-xs", res.ok ? "text-green-700" : "text-red-600")}>{res.text}</span>}
      </div>
      {help && (
        <div className="mt-1 rounded border bg-gray-50 p-2 text-xs text-gray-700">
          <p>Write it like Excel. References go in braces: <code>{"{column_key}"}</code>, <code>{"{step2.actual}"}</code>, <code>{"{step2.status}"}</code>, <code>{"{row.start}"}</code>. Text in quotes, join with <code>&amp;</code>, compare with = &lt;&gt; &lt; &gt; &lt;= &gt;=. Date + 1 = next day; date − date = days.</p>
          <p className="mt-1">Examples: <code>{'IF({good_status} = "Available", ADDWORKDAYS({step1.actual}, 1), {delivery_date} - 1)'}</code> · <code>{'TEXT({date_time}, "MMM-YY")'}</code> · <code>{'{dealer_name} & "//" & {call_regarding}'}</code> · <code>{"WORKDAYS({row.start}, {step3.actual})"}</code></p>
          <p className="mt-1">Functions: {funcs.join(", ") || "…"}</p>
        </div>
      )}
    </div>
  );
}

export function StartsAfter({ step, index, steps, onChange }) {
  if (index === 0) return <p className="text-xs text-gray-500">STEP-1 starts when the row is created.</p>;
  const mode = step.depends_on == null ? "previous" : step.depends_on.length ? "custom" : "parallel";
  return (
    <div className="space-y-1 text-sm">
      <select className="rounded border px-2 py-1" value={mode} onChange={(e) => onChange(e.target.value === "previous" ? null : e.target.value === "parallel" ? [] : [index])}>
        <option value="previous">after the previous step is finished</option>
        <option value="parallel">together with the row (parallel, no waiting)</option>
        <option value="custom">after these steps are finished…</option>
      </select>
      {mode === "custom" && (
        <div className="flex flex-wrap gap-3">
          {steps.slice(0, index).map((s, k) => (
            <label key={k} className="flex items-center gap-1"><input type="checkbox" checked={step.depends_on.includes(k + 1)} onChange={(e) => onChange(e.target.checked ? [...step.depends_on, k + 1].sort((a, b) => a - b) : step.depends_on.filter((x) => x !== k + 1))} />{s.code || `STEP-${k + 1}`}</label>
          ))}
        </div>
      )}
    </div>
  );
}

export function PlanRules({ step, index, def, fmsId, onChange }) {
  const rules = step.plan?.rules || [];
  const refs = refOptions(def, index);
  const dateRefs = refs.filter((r) => r.type === "date" || r.type === "datetime").filter((r) => !r.value.includes("."));
  const set = (k, patch) => onChange({ rules: rules.map((r, j) => (j === k ? { ...r, ...patch } : r)) });
  const move = (k, d) => { const a = [...rules]; const t = k + d; if (t < 0 || t >= a.length) return; [a[k], a[t]] = [a[t], a[k]]; onChange({ rules: a }); };
  return (
    <div className="space-y-2">
      {rules.map((r, k) => (
        <div key={k} className="rounded-md border border-indigo-200 bg-indigo-50/40 p-2">
          <div className="mb-1 flex items-center justify-between text-xs font-semibold text-indigo-800">
            <span>Rule {k + 1}{r.when?.length ? " — when:" : " — always (if no rule above matched)"}</span>
            <span className="flex gap-1"><Btn size="sm" kind="ghost" onClick={() => move(k, -1)}>↑</Btn><Btn size="sm" kind="ghost" onClick={() => move(k, 1)}>↓</Btn><Btn size="sm" kind="ghost" className="text-red-600" onClick={() => onChange({ rules: rules.filter((_, j) => j !== k) })}>✕</Btn></span>
          </div>
          <ConditionRows value={r.when || []} refs={refs} onChange={(w) => set(k, { when: w })} />
          <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
            <label className="flex items-center gap-1"><input type="radio" checked={!r.formula_mode && !r.formula} onChange={() => set(k, { formula: "", formula_mode: false })} />Plan =</label>
            <select className="rounded border px-2 py-1" disabled={!!r.formula || r.formula_mode} value={r.base || "previous"} onChange={(e) => set(k, { base: e.target.value })}>
              <option value="previous">previous step's actual</option><option value="start">row start time</option><option value="created">row created time</option><option value="activated">when this step starts</option>
              {def.steps.slice(0, index).map((s, j) => <React.Fragment key={j}><option value={`step:${j + 1}:actual`}>{s.code || `STEP-${j + 1}`} actual</option><option value={`step:${j + 1}:planned`}>{s.code || `STEP-${j + 1}`} planned</option></React.Fragment>)}
              {dateRefs.map((f) => <option key={f.value} value={`field:${f.value}`}>column: {f.label}</option>)}
            </select>
            <span>+</span>
            <input type="number" step="any" className="w-20 rounded border px-2 py-1" disabled={!!r.formula || r.formula_mode} value={r.offset ?? 0} onChange={(e) => set(k, { offset: Number(e.target.value) })} title="Use a negative number for 'before'" />
            <select className="rounded border px-2 py-1" disabled={!!r.formula || r.formula_mode} value={r.unit || "working_days"} onChange={(e) => set(k, { unit: e.target.value })}>{UNITS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
            <span>at</span>
            <input type="time" className="rounded border px-2 py-1" value={r.at_time || ""} onChange={(e) => set(k, { at_time: e.target.value })} title="Optional fixed time of day" />
          </div>
          <div className="mt-2 text-sm">
            <label className="flex items-center gap-1"><input type="radio" checked={!!r.formula_mode || !!r.formula} onChange={() => set(k, { formula_mode: true })} />Plan = formula (any date expression)</label>
            {(r.formula_mode || r.formula) && <FormulaBox value={r.formula} refs={refs} fmsId={fmsId} type="datetime" placeholder='e.g. IF({good_status} = "Available", ADDWORKDAYS({step1.actual}, 1), {delivery_date} - 1)' onChange={(v) => set(k, { formula: v })} />}
          </div>
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-2">
        <Btn size="sm" kind="secondary" onClick={() => onChange({ rules: [...rules, { when: [], base: "previous", offset: 1, unit: "working_days", at_time: "", formula: "" }] })}>+ Add plan rule</Btn>
        <span className="text-xs text-gray-500">First rule whose conditions match decides the planned date; if none matches the TAT above is used.</span>
      </div>
    </div>
  );
}

export function FormulaToggle({ field, onChange, refs, fmsId }) {
  return (
    <div className="md:col-span-12">
      <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={field.formula !== undefined && field.formula !== null && (field.formula !== "" || field._calc)} onChange={(e) => onChange(e.target.checked ? { _calc: true, formula: field.formula || "" } : { _calc: false, formula: "" })} /> Calculated column (formula — filled automatically, not typed in)</label>
      {(field._calc || field.formula) && <div className="mt-1"><Label>Formula</Label><FormulaBox value={field.formula} refs={refs.filter((r) => r.value !== field.key)} fmsId={fmsId} type={field.type} onChange={(v) => onChange({ formula: v })} /></div>}
    </div>
  );
}

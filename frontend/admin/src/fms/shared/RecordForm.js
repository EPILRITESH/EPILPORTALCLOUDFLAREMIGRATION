// New-row form generated from an FMS definition's columns.
import React, { useEffect, useState } from "react";
import api, { errMsg } from "./api";
import { Btn, Modal, FieldInput, Label, ErrorBox } from "./ui";

export default function RecordForm({ definition, onClose, onCreated }) {
  const fields = (definition.fields || []).filter((f) => !f.formula); // calculated columns fill themselves
  const [data, setData] = useState(() => Object.fromEntries(fields.map((f) => {
    if (f.default_value) return [f.key, f.type === "multiselect" ? f.default_value.split(",").map((x) => x.trim()) : f.default_value];
    if (f.key === definition.start_field && f.type === "datetime") return [f.key, new Date().toISOString()];
    return [f.key, f.type === "multiselect" ? [] : ""];
  })));
  const [employees, setEmployees] = useState([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => { api.get("/lookups").then((r) => setEmployees(r.data.employees || [])).catch(() => {}); }, []);

  const save = async (another) => {
    setBusy(true); setErr("");
    try {
      const r = await api.post(`/definitions/${definition.id}/records`, { data });
      onCreated?.(r.data, another);
      if (another) setData(Object.fromEntries(fields.map((f) => [f.key, f.type === "multiselect" ? [] : f.default_value || ""])));
    } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  };

  return (
    <Modal open wide onClose={onClose} title={`New entry · ${definition.name}`}
      footer={<><Btn kind="secondary" onClick={onClose}>Cancel</Btn><Btn kind="secondary" busy={busy} onClick={() => save(true)}>Save &amp; add another</Btn><Btn busy={busy} onClick={() => save(false)}>Save</Btn></>}>
      {definition.instructions && <div className="mb-3 whitespace-pre-line rounded border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">{definition.instructions}</div>}
      <div className="grid gap-4 sm:grid-cols-2">
        {fields.map((f) => (
          <div key={f.key} className={f.type === "textarea" ? "sm:col-span-2" : ""}>
            <Label required={f.required}>{f.label}</Label>
            <FieldInput field={f} value={data[f.key]} employees={employees} onChange={(v) => setData({ ...data, [f.key]: v })} />
            {f.help && <p className="mt-0.5 text-xs text-gray-500">{f.help}</p>}
          </div>
        ))}
        {!fields.length && <p className="text-sm text-gray-500">This FMS has no columns — saving starts STEP-1 directly.</p>}
      </div>
      <div className="mt-3"><ErrorBox>{err}</ErrorBox></div>
    </Modal>
  );
}

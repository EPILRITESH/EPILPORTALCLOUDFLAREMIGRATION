// Seating (who sits on CRM, PC-1 …) and the holiday calendar used for TAT planning.
import React, { useCallback, useEffect, useState } from "react";
import * as XLSX from "xlsx";
import api, { errMsg, fmtDT, fmtD, readWorkbook, downloadTable } from "./shared/api";
import { Btn, Spinner, Modal, ErrorBox, Empty, Label, inputCls, Tabs, useDialog, useFlash, Badge } from "./shared/ui";
import { FmsNav } from "./FmsAdmin";

function SeatEditor({ seat, lk, onClose, onSaved }) {
  const [s, setS] = useState(() => seat ? { ...seat, members: seat.members.map((m) => ({ ...m })) } : { code: "", name: "", description: "", active: true, members: [] });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const setM = (i, patch) => setS({ ...s, members: s.members.map((m, k) => (k === i ? { ...m, ...patch } : m)) });
  const save = async () => {
    setBusy(true); setErr("");
    try {
      const body = { code: s.code, name: s.name, description: s.description, active: s.active, members: s.members.map(({ kind, value, start_date, end_date, active }) => ({ kind, value, start_date, end_date, active })) };
      if (seat) await api.put(`/seats/${seat.id}`, body); else await api.post("/seats", body);
      onSaved();
    } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  };
  const valueOptions = (kind) => (kind === "department" ? lk.departments : kind === "designation" ? lk.designations : null);
  return (
    <Modal open wide onClose={onClose} title={seat ? `Edit seat ${seat.code}` : "New seat"} footer={<><Btn kind="secondary" onClick={onClose}>Cancel</Btn><Btn busy={busy} onClick={save}>Save</Btn></>}>
      <div className="grid gap-3 md:grid-cols-3">
        <div><Label required>Seat code</Label><input className={inputCls} value={s.code} onChange={(e) => setS({ ...s, code: e.target.value })} placeholder="e.g. CRM, PC-1" /></div>
        <div><Label>Name</Label><input className={inputCls} value={s.name} onChange={(e) => setS({ ...s, name: e.target.value })} placeholder="e.g. Customer relations" /></div>
        <label className="flex items-center gap-2 pt-6 text-sm"><input type="checkbox" checked={!!s.active} onChange={(e) => setS({ ...s, active: e.target.checked })} /> Active</label>
        <div className="md:col-span-3"><Label>Description</Label><input className={inputCls} value={s.description} onChange={(e) => setS({ ...s, description: e.target.value })} /></div>
      </div>
      <h4 className="mb-1 mt-4 font-semibold">Who sits on this seat</h4>
      <p className="mb-2 text-xs text-gray-500">Anyone matching a row gets this seat's tasks. Add dates for temporary cover (leave, shifts) — outside those dates the row does not apply.</p>
      <div className="space-y-2">
        {s.members.map((m, i) => (
          <div key={i} className="grid items-center gap-2 rounded border p-2 md:grid-cols-12">
            <select className={`${inputCls} md:col-span-2`} value={m.kind} onChange={(e) => setM(i, { kind: e.target.value, value: "" })}>
              <option value="employee">Employee</option><option value="department">Department</option><option value="designation">Designation</option>
            </select>
            <div className="md:col-span-4">
              {m.kind === "employee" ? (
                <select className={inputCls} value={m.value} onChange={(e) => setM(i, { value: e.target.value })}>
                  <option value="">— choose employee —</option>{lk.employees.map((e) => <option key={e.employee_id} value={e.employee_id}>{e.name} ({e.department || "—"}{e.designation ? `, ${e.designation}` : ""})</option>)}
                </select>
              ) : (
                <>
                  <select className={inputCls} value={m.value} onChange={(e) => setM(i, { value: e.target.value })}>
                    <option value="">— choose {m.kind} —</option>
                    {m.value && !(valueOptions(m.kind) || []).includes(m.value) && <option value={m.value}>{m.value} (no active employee)</option>}
                    {(valueOptions(m.kind) || []).map((o) => <option key={o} value={o}>{o}</option>)}
                  </select>
                </>
              )}
            </div>
            <input type="date" className={`${inputCls} md:col-span-2`} value={m.start_date || ""} onChange={(e) => setM(i, { start_date: e.target.value })} title="From (optional)" />
            <input type="date" className={`${inputCls} md:col-span-2`} value={m.end_date || ""} onChange={(e) => setM(i, { end_date: e.target.value })} title="To (optional)" />
            <label className="flex items-center gap-1 text-sm md:col-span-1"><input type="checkbox" checked={m.active !== false} onChange={(e) => setM(i, { active: e.target.checked })} /> On</label>
            <Btn size="sm" kind="ghost" className="text-red-600 md:col-span-1" onClick={() => setS({ ...s, members: s.members.filter((_, k) => k !== i) })}>✕</Btn>
          </div>
        ))}
        <Btn size="sm" kind="secondary" onClick={() => setS({ ...s, members: [...s.members, { kind: "employee", value: "", start_date: "", end_date: "", active: true }] })}>+ Add member</Btn>
      </div>
      <div className="mt-3"><ErrorBox>{err}</ErrorBox></div>
    </Modal>
  );
}

function Seats() {
  const [items, setItems] = useState(null);
  const [lk, setLk] = useState({ departments: [], designations: [], employees: [] });
  const [edit, setEdit] = useState(undefined);
  const [hist, setHist] = useState(null);
  const [q, setQ] = useState("");
  const [err, setErr] = useState("");
  const [ask, dialog] = useDialog();
  const [flash, flashNode] = useFlash();
  const load = useCallback(() => api.get("/seats").then((r) => setItems(r.data.items)).catch((e) => setErr(errMsg(e))), []);
  useEffect(() => { load(); api.get("/lookups").then((r) => setLk(r.data)).catch(() => {}); }, [load]);
  const empName = (id) => lk.employees.find((e) => e.employee_id === id)?.name || id;

  const exportSeats = (format) => {
    const rows = [];
    for (const s of items) {
      if (!s.members.length) rows.push({ code: s.code, name: s.name, kind: "", value: "", start_date: "", end_date: "" });
      for (const m of s.members) rows.push({ code: s.code, name: s.name, kind: m.kind, value: m.kind === "employee" ? m.value : m.value, employee_name: m.kind === "employee" ? empName(m.value) : "", start_date: m.start_date, end_date: m.end_date });
    }
    downloadTable({ format, name: "FMS seating", XLSX, rows, columns: ["code", "name", "kind", "value", "employee_name", "start_date", "end_date"].map((k) => ({ key: k, label: k })) });
  };
  const importSeats = async (file) => {
    if (!file) return;
    try {
      const wb = await readWorkbook(XLSX, file);
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: "", raw: false }).map((r) => {
        const o = Object.fromEntries(Object.entries(r).map(([k, v]) => [k.toLowerCase().trim().replace(/\s+/g, "_"), String(v).trim()]));
        // allow employee by name: map to ID
        if ((o.kind || "").toLowerCase() === "employee" && o.value && !lk.employees.some((e) => e.employee_id === o.value)) {
          const hit = lk.employees.find((e) => e.name.toLowerCase() === o.value.toLowerCase());
          if (hit) o.value = hit.employee_id;
        }
        return o;
      });
      const r = await api.post("/seats/import", { rows });
      flash(`Seats created ${r.data.created}, updated ${r.data.updated}${r.data.errors.length ? `, ${r.data.errors.length} row errors` : ""}`, r.data.errors.length ? "error" : "ok");
      load();
    } catch (e) { flash(errMsg(e), "error"); }
  };

  const list = (items || []).filter((s) => !q || `${s.code} ${s.name} ${s.members.map((m) => m.value).join(" ")}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="space-y-3">
      {dialog}{flashNode}
      <div className="flex flex-wrap items-center gap-2">
        <input className={`${inputCls} max-w-xs`} placeholder="Search seats / members" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="ml-auto flex flex-wrap gap-2">
          <Btn onClick={() => setEdit(null)}>+ New seat</Btn>
          <label className="inline-flex cursor-pointer items-center rounded-md border border-gray-300 bg-white px-3.5 py-2 text-sm font-medium hover:bg-gray-50">Import Excel<input type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={(e) => { importSeats(e.target.files[0]); e.target.value = ""; }} /></label>
          <Btn kind="secondary" disabled={!items?.length} onClick={() => exportSeats("xlsx")}>Export Excel</Btn>
          <Btn kind="secondary" disabled={!items?.length} onClick={() => exportSeats("pdf")}>PDF</Btn>
        </div>
      </div>
      <p className="text-xs text-gray-500">Import columns: <code>code, name, kind (employee/department/designation), value (employee ID or name / department / designation), start_date, end_date</code>.</p>
      <ErrorBox>{err}</ErrorBox>
      {!items ? <Spinner /> : !list.length ? <Empty>No seats yet. Seats are created automatically when you import an FMS sheet, or add one here.</Empty> : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {list.map((s) => (
            <div key={s.id} className="rounded-lg border bg-white p-4 shadow-sm">
              <div className="flex items-start justify-between">
                <div><div className="text-lg font-bold">{s.code}</div><div className="text-sm text-gray-600">{s.name !== s.code && s.name}</div></div>
                {!s.active && <Badge className="bg-gray-200 text-gray-600">Inactive</Badge>}
              </div>
              {s.description && <p className="mt-1 text-xs text-gray-500">{s.description}</p>}
              <div className="mt-2 text-sm">
                <div className="text-xs font-semibold uppercase text-gray-500">Members</div>
                {!s.members.length ? <div className="text-amber-700">No one yet — tasks of this seat reach admins only.</div> : (
                  <ul className="mt-1 space-y-0.5">{s.members.map((m) => <li key={m.id} className={m.active ? "" : "text-gray-400 line-through"}><span className="text-gray-500">{m.kind}:</span> {m.kind === "employee" ? empName(m.value) : m.value}{(m.start_date || m.end_date) && <span className="text-xs text-gray-500"> ({fmtD(m.start_date) || "…"} → {fmtD(m.end_date) || "…"})</span>}</li>)}</ul>
                )}
                <div className="mt-2 text-xs text-gray-500">Today: {s.people_now.length ? s.people_now.map((p) => p.name).join(", ") : "nobody"}</div>
                {s.used_in.length > 0 && <div className="mt-1 text-xs text-gray-500">Used in: {s.used_in.map((u) => `${u.fms} · ${u.step_code}`).join("; ")}</div>}
              </div>
              <div className="mt-3 flex flex-wrap gap-x-3">
                <Btn kind="link" onClick={() => setEdit(s)}>Edit</Btn>
                <Btn kind="link" onClick={async () => { try { await api.post(`/seats/${s.id}/duplicate`, {}); flash("Seat duplicated"); load(); } catch (e) { flash(errMsg(e), "error"); } }}>Duplicate</Btn>
                <Btn kind="link" onClick={async () => { try { setHist({ s, items: (await api.get(`/seats/${s.id}/history`)).data.items }); } catch (e) { flash(errMsg(e), "error"); } }}>History</Btn>
                <Btn kind="link" className="!text-red-600" onClick={async () => {
                  const used = s.used_in.length;
                  if (!(await ask({ title: `Delete seat ${s.code}?`, message: used ? `It is used by ${used} step(s); those steps will have no seat until you set WHO again.` : "This cannot be undone.", danger: true, ok: "Delete" }))) return;
                  try { await api.delete(`/seats/${s.id}${used ? "?force=1" : ""}`); flash("Seat deleted"); load(); } catch (e) { flash(errMsg(e), "error"); }
                }}>Delete</Btn>
              </div>
            </div>
          ))}
        </div>
      )}
      {edit !== undefined && <SeatEditor seat={edit} lk={lk} onClose={() => setEdit(undefined)} onSaved={() => { setEdit(undefined); flash("Seat saved"); load(); }} />}
      {hist && (
        <Modal open onClose={() => setHist(null)} title={`History · ${hist.s.code}`}>
          {!hist.items.length ? <p className="text-sm text-gray-500">No changes recorded.</p> : (
            <ul className="divide-y text-sm">{hist.items.map((h) => <li key={h.id} className="py-2"><b className="capitalize">{h.action}</b> · {fmtDT(h.at)} · {h.actor}<pre className="mt-1 whitespace-pre-wrap break-words text-xs text-gray-600">{typeof h.detail === "string" ? h.detail : JSON.stringify(h.detail, null, 1)}</pre></li>)}</ul>
          )}
        </Modal>
      )}
    </div>
  );
}

function Holidays() {
  const [items, setItems] = useState(null);
  const [date, setDate] = useState("");
  const [name, setName] = useState("");
  const [err, setErr] = useState("");
  const [flash, flashNode] = useFlash();
  const load = useCallback(() => api.get("/holidays").then((r) => setItems(r.data.items)).catch((e) => setErr(errMsg(e))), []);
  useEffect(() => { load(); }, [load]);
  const toYmd = (v) => {
    const s = String(v).trim();
    let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
    if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
    m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/.exec(s);
    if (m) return `${m[3].length === 2 ? `20${m[3]}` : m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
    return "";
  };
  return (
    <div className="space-y-3">
      {flashNode}
      <div className="flex flex-wrap items-end gap-2 rounded-lg border bg-white p-3">
        <div><Label>Date</Label><input type="date" className={inputCls} value={date} onChange={(e) => setDate(e.target.value)} /></div>
        <div className="min-w-[14rem] flex-1"><Label>Name</Label><input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Diwali" /></div>
        <Btn disabled={!date} onClick={async () => { try { await api.post("/holidays", { date, name }); setDate(""); setName(""); flash("Holiday saved"); load(); } catch (e) { setErr(errMsg(e)); } }}>Add holiday</Btn>
        <label className="inline-flex cursor-pointer items-center rounded-md border border-gray-300 bg-white px-3.5 py-2 text-sm font-medium hover:bg-gray-50">Import Excel
          <input type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={async (e) => {
            const f = e.target.files[0]; e.target.value = ""; if (!f) return;
            try {
              const wb = await readWorkbook(XLSX, f);
              const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: false, defval: "" });
              const items2 = rows.map((r) => ({ date: toYmd(r[0]), name: String(r[1] || "") })).filter((x) => x.date);
              if (!items2.length) { setErr("No dates found (first column = date, second = name)"); return; }
              await api.post("/holidays", { items: items2 }); flash(`${items2.length} holidays imported`); load();
            } catch (x) { setErr(errMsg(x)); }
          }} />
        </label>
      </div>
      <p className="text-xs text-gray-500">Holidays are skipped when planning TAT for every FMS (like the sheet's WORKDAY.INTL holiday list). Import: first column date, second column name.</p>
      <ErrorBox>{err}</ErrorBox>
      {!items ? <Spinner /> : !items.length ? <Empty>No holidays added.</Empty> : (
        <ul className="divide-y rounded-lg border bg-white">
          {items.map((h) => (
            <li key={h.date} className="flex items-center justify-between px-3 py-2 text-sm">
              <span><b>{fmtD(h.date)}</b> · {new Date(`${h.date}T00:00:00`).toLocaleDateString("en-IN", { weekday: "long" })} {h.name && `· ${h.name}`}</span>
              <Btn kind="link" className="!text-red-600" onClick={async () => { try { await api.delete(`/holidays/${h.date}`); load(); } catch (e) { setErr(errMsg(e)); } }}>Remove</Btn>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function Seating() {
  const [tab, setTab] = useState("seats");
  return (
    <div>
      <FmsNav />
      <Tabs value={tab} onChange={setTab} tabs={[{ value: "seats", label: "Seating" }, { value: "holidays", label: "Holidays" }]} />
      <div className="mt-4">{tab === "seats" ? <Seats /> : <Holidays />}</div>
    </div>
  );
}

// FMS reports (summary, per FMS, per step, per person, 30-day trend) and the audit trail.
import React, { useCallback, useEffect, useState } from "react";
import * as XLSX from "xlsx";
import api, { errMsg, fmtDT, downloadTable } from "./shared/api";
import { Btn, Spinner, Stat, Tabs, ErrorBox, Label, inputCls, useFlash } from "./shared/ui";
import { FmsNav } from "./FmsAdmin";

function Table({ cols, rows, empty = "No data" }) {
  return (
    <div className="overflow-x-auto rounded-lg border bg-white">
      <table className="min-w-full text-sm">
        <thead className="bg-gray-50 text-left text-xs uppercase text-gray-500"><tr>{cols.map((c) => <th key={c.key} className="whitespace-nowrap px-3 py-2">{c.label}</th>)}</tr></thead>
        <tbody>
          {rows.map((r, i) => <tr key={i} className="border-t">{cols.map((c) => <td key={c.key} className="whitespace-nowrap px-3 py-1.5">{c.render ? c.render(r) : r[c.key]}</td>)}</tr>)}
          {!rows.length && <tr><td colSpan={cols.length} className="px-3 py-6 text-center text-gray-500">{empty}</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

function Bars({ title, data }) {
  const max = Math.max(1, ...data.map((d) => d.n));
  return (
    <div className="rounded-lg border bg-white p-3">
      <div className="mb-2 text-sm font-semibold">{title}</div>
      {!data.length ? <div className="py-4 text-center text-sm text-gray-500">No activity in the last 30 days</div> : (
        <div className="flex h-32 items-end gap-0.5">
          {data.map((d) => <div key={d.day} title={`${d.day}: ${d.n}`} className="flex-1 rounded-t bg-blue-500 hover:bg-blue-700" style={{ height: `${Math.max(3, (d.n / max) * 100)}%` }} />)}
        </div>
      )}
      {data.length > 0 && <div className="mt-1 flex justify-between text-[10px] text-gray-500"><span>{data[0].day}</span><span>{data[data.length - 1].day}</span></div>}
    </div>
  );
}

const pct = (a, b) => (b ? `${Math.round((a / b) * 1000) / 10}%` : "—");

function ReportView() {
  const [fmsList, setFmsList] = useState([]);
  const [f, setF] = useState({ fms: "", from: "", to: "" });
  const [r, setR] = useState(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [flash, flashNode] = useFlash();
  const load = useCallback(async () => {
    setBusy(true);
    try { setR((await api.get("/reports", { params: Object.fromEntries(Object.entries(f).filter(([, v]) => v)) })).data); setErr(""); } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  }, [f]);
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { api.get("/definitions", { params: { limit: 200, sort: "name" } }).then((x) => setFmsList(x.data.items)).catch(() => {}); }, []);

  const stepCols = [
    { key: "fms", label: "FMS" }, { key: "code", label: "Step" }, { key: "name", label: "WHAT" }, { key: "total", label: "Rows" }, { key: "done", label: "Done" },
    { key: "on_time", label: "On time" }, { key: "late", label: "Late" }, { key: "otp", label: "On-time %", render: (x) => pct(x.on_time, x.done) },
    { key: "pending", label: "Pending" }, { key: "overdue", label: "Overdue", render: (x) => (x.overdue ? <b className="text-red-600">{x.overdue}</b> : 0) },
    { key: "awaiting_approval", label: "Awaiting approval" }, { key: "skipped", label: "Skipped" }, { key: "avg_delay_hours", label: "Avg delay (h)" },
  ];
  const personCols = [
    { key: "name", label: "Doer" }, { key: "done", label: "Steps done" }, { key: "on_time", label: "On time" }, { key: "late", label: "Late" },
    { key: "otp", label: "On-time %", render: (x) => pct(x.on_time, x.done) }, { key: "avg_delay_hours", label: "Avg delay (h)" },
  ];
  const fmsCols = [
    { key: "name", label: "FMS" }, { key: "code", label: "Code" }, { key: "total", label: "Rows" }, { key: "open", label: "Open" }, { key: "completed", label: "Completed" },
    { key: "cancelled", label: "Cancelled" }, { key: "overdue", label: "Rows overdue", render: (x) => (x.overdue ? <b className="text-red-600">{x.overdue}</b> : 0) },
  ];
  const exportAll = () => {
    const wb = XLSX.utils.book_new();
    const add = (name, cols, rows) => XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([cols.map((c) => c.label), ...rows.map((x) => cols.map((c) => (c.key === "otp" ? pct(x.on_time, x.done) : x[c.key])))]), name);
    add("By FMS", fmsCols, r.by_fms); add("By step", stepCols, r.by_step); add("By person", personCols, r.by_person);
    XLSX.writeFile(wb, "FMS report.xlsx");
  };
  const t = r?.totals || {};
  return (
    <div className="space-y-4">
      {flashNode}
      <div className="flex flex-wrap items-end gap-2 rounded-lg border bg-white p-3">
        <div className="min-w-[14rem]"><Label>FMS</Label><select className={inputCls} value={f.fms} onChange={(e) => setF({ ...f, fms: e.target.value })}><option value="">All FMS</option>{fmsList.map((d) => <option key={d.id} value={d.id}>{d.code} · {d.name}</option>)}</select></div>
        <div><Label>From</Label><input type="date" className={inputCls} value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></div>
        <div><Label>To</Label><input type="date" className={inputCls} value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></div>
        <Btn busy={busy} onClick={load}>Show</Btn>
        {r && <Btn kind="secondary" onClick={exportAll}>Export Excel</Btn>}
        {r && <Btn kind="secondary" onClick={() => downloadTable({ format: "pdf", name: "FMS report by step", columns: stepCols.map((c) => ({ key: c.key, label: c.label })), rows: r.by_step.map((x) => ({ ...x, otp: pct(x.on_time, x.done) })), XLSX })}>PDF</Btn>}
        <Btn kind="ghost" className="ml-auto" onClick={async () => { try { const x = (await api.post("/jobs/reminders")).data; flash(`Reminders sent: ${x.reminded}, escalations: ${x.escalated}`); } catch (e) { flash(errMsg(e), "error"); } }}>Run reminders now</Btn>
        <Btn kind="ghost" onClick={async () => { try { const x = (await api.post("/jobs/recurrence")).data; flash(x.created.length ? `Created: ${x.created.join(", ")}` : "No recurring rows due right now"); } catch (e) { flash(errMsg(e), "error"); } }}>Run recurring now</Btn>
      </div>
      <ErrorBox>{err}</ErrorBox>
      {!r ? <Spinner /> : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <Stat label="Step tasks" value={t.steps} /><Stat label="Done" value={t.done} tone="green" /><Stat label="On-time %" value={`${t.on_time_pct}%`} tone="blue" />
            <Stat label="Pending" value={t.pending} tone="amber" /><Stat label="Overdue" value={t.overdue} tone="red" /><Stat label="Awaiting approval" value={t.awaiting_approval} tone="purple" />
          </div>
          <div className="grid gap-3 md:grid-cols-2"><Bars title="Rows started per day (30 days)" data={r.trend.created} /><Bars title="Steps completed per day (30 days)" data={r.trend.completed} /></div>
          <h3 className="font-semibold">By FMS</h3><Table cols={fmsCols} rows={r.by_fms} />
          <h3 className="font-semibold">By step</h3><Table cols={stepCols} rows={r.by_step} />
          <h3 className="font-semibold">By person</h3><Table cols={personCols} rows={r.by_person} empty="No completed steps yet" />
        </>
      )}
    </div>
  );
}

function Audit() {
  const [items, setItems] = useState(null);
  const [err, setErr] = useState("");
  useEffect(() => { api.get("/audit", { params: { limit: 500 } }).then((r) => setItems(r.data.items)).catch((e) => setErr(errMsg(e))); }, []);
  return (
    <div>
      <ErrorBox>{err}</ErrorBox>
      {!items ? <Spinner /> : (
        <Table rows={items} empty="No changes yet" cols={[
          { key: "at", label: "When", render: (x) => fmtDT(x.at) }, { key: "actor", label: "Who", render: (x) => x.actor_name || x.actor },
          { key: "action", label: "Action" }, { key: "entity", label: "What", render: (x) => `${x.entity.replace("fms_", "").replace("fms", "FMS")} ${x.entity_id}` },
          { key: "detail", label: "Detail", render: (x) => <span className="block max-w-xl truncate text-xs text-gray-600" title={typeof x.detail === "string" ? x.detail : JSON.stringify(x.detail)}>{typeof x.detail === "string" ? x.detail : JSON.stringify(x.detail)}</span> },
        ]} />
      )}
      <p className="mt-2 text-xs text-gray-500">Row-level actions (create, submit, approve, reject, reassign…) are in each row's History tab.</p>
    </div>
  );
}

export default function Reports() {
  const [tab, setTab] = useState("reports");
  return (
    <div>
      <FmsNav />
      <Tabs value={tab} onChange={setTab} tabs={[{ value: "reports", label: "Reports" }, { value: "audit", label: "Audit trail" }]} />
      <div className="mt-4">{tab === "reports" ? <ReportView /> : <Audit />}</div>
    </div>
  );
}

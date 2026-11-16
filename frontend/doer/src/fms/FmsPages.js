// Doer FMS pages: dashboard (counts + my FMS), My tasks (buckets, filters, list/kanban), approvals, FMS data view.
import React, { useCallback, useEffect, useState } from "react";
import { NavLink, useNavigate, useParams, useSearchParams } from "react-router-dom";
import api, { errMsg, fmtDT } from "./shared/api";
import { Btn, Spinner, Stat, Tabs, Pager, ErrorBox, Empty, inputCls, PriorityBadge } from "./shared/ui";
import TaskList from "./shared/TaskList";
import RecordView from "./shared/RecordView";
import RecordForm from "./shared/RecordForm";
import RecordsGrid from "./shared/RecordsGrid";
import NotificationBell from "./shared/NotificationBell";

function FmsNav() {
  const link = ({ isActive }) => `rounded-md px-3 py-1.5 text-sm font-medium ${isActive ? "bg-blue-600 text-white" : "text-gray-700 hover:bg-gray-200"}`;
  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-2 border-b pb-3">
      <div className="flex flex-wrap items-center gap-1">
        <span className="mr-2 text-lg font-bold text-gray-900">FMS</span>
        <NavLink end to="/fms" className={link}>Dashboard</NavLink>
        <NavLink to="/fms/tasks" className={link}>My tasks</NavLink>
        <NavLink to="/fms/approvals" className={link}>Approvals</NavLink>
      </div>
      <NotificationBell isAdmin={false} />
    </div>
  );
}

export function FmsHome() {
  const [sum, setSum] = useState(null);
  const [list, setList] = useState(null);
  const [err, setErr] = useState("");
  const [creating, setCreating] = useState(null);
  const [open, setOpen] = useState(null);
  const [msg, setMsg] = useState("");
  const nav = useNavigate();
  const load = useCallback(() => {
    api.get("/my/summary").then((r) => setSum(r.data)).catch((e) => setErr(errMsg(e)));
    api.get("/accessible").then((r) => setList(r.data.items)).catch((e) => setErr(errMsg(e)));
  }, []);
  useEffect(() => { load(); }, [load]);
  const c = sum?.counts || {};
  const go = (bucket) => nav(`/fms/tasks?bucket=${bucket}`);

  return (
    <div>
      <FmsNav />
      <ErrorBox>{err}</ErrorBox>
      {msg && <div className="mb-3 rounded bg-green-50 px-3 py-2 text-sm text-green-800">{msg}</div>}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-8">
        <Stat label="Pending" value={c.pending} tone="amber" onClick={() => go("pending")} />
        <Stat label="Overdue" value={c.overdue} tone="red" onClick={() => go("overdue")} />
        <Stat label="Due today" value={c.due_today} tone="blue" onClick={() => go("today")} />
        <Stat label="In progress" value={c.in_progress} tone="blue" onClick={() => go("in_progress")} />
        <Stat label="Sent back" value={c.rejected} tone="red" onClick={() => go("rejected")} />
        <Stat label="Awaiting approval" value={c.submitted} tone="purple" onClick={() => go("submitted")} />
        <Stat label="Done this month" value={c.completed_this_month} tone="green" onClick={() => go("completed")} />
        <Stat label="To approve" value={c.approvals} tone="purple" onClick={() => nav("/fms/approvals")} />
      </div>
      {c.completed_this_month > 0 && <p className="mt-2 text-sm text-gray-600">On-time this month: <b>{Math.round((c.on_time_this_month / c.completed_this_month) * 100)}%</b></p>}

      <h2 className="mb-2 mt-6 text-lg font-semibold text-gray-900">My FMS</h2>
      {!list ? <Spinner /> : !list.length ? <Empty>No FMS is assigned to you yet.</Empty> : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {list.map((f) => (
            <div key={f.id} className="rounded-lg border bg-white p-4 shadow-sm">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="text-xs text-gray-500">{f.code}{f.category && ` · ${f.category}`}</div>
                  <div className="font-semibold text-gray-900">{f.name}</div>
                </div>
                <PriorityBadge p={f.priority} />
              </div>
              {f.description && <p className="mt-1 line-clamp-2 text-sm text-gray-600">{f.description}</p>}
              <div className="mt-2 flex gap-3 text-sm">
                <span>Pending <b className="text-amber-700">{f.my_pending}</b></span>
                <span>Overdue <b className="text-red-600">{f.my_overdue}</b></span>
                <span>Awaiting <b className="text-purple-700">{f.my_submitted}</b></span>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <Btn size="sm" kind="secondary" onClick={() => nav(`/fms/tasks?fms=${f.id}`)}>My tasks</Btn>
                <Btn size="sm" kind="secondary" onClick={() => nav(`/fms/sheet/${f.id}`)}>View data</Btn>
                {f.can_create && <Btn size="sm" onClick={async () => { try { const r = await api.get(`/definitions/${f.id}`); setCreating(r.data.definition); } catch (e) { setErr(errMsg(e)); } }}>+ New entry</Btn>}
              </div>
            </div>
          ))}
        </div>
      )}

      {sum?.upcoming?.length > 0 && (
        <>
          <h2 className="mb-2 mt-6 text-lg font-semibold text-gray-900">Next up</h2>
          <TaskList items={sum.upcoming} onOpen={(t) => setOpen({ id: t.record_id, step: t.id })} />
        </>
      )}
      {creating && <RecordForm definition={creating} onClose={() => setCreating(null)} onCreated={(r, another) => { setMsg(`Entry ${r.uid} created`); load(); if (!another) setCreating(null); }} />}
      {open && <RecordView recordId={open.id} focusStepId={open.step} onClose={() => setOpen(null)} onChanged={load} />}
    </div>
  );
}

const BUCKETS = [
  ["pending", "All open"], ["overdue", "Overdue"], ["today", "Due today"], ["upcoming", "Upcoming"], ["in_progress", "In progress"],
  ["rejected", "Sent back"], ["submitted", "Awaiting approval"], ["completed", "Completed"],
];

export function MyTasks() {
  const [sp, setSp] = useSearchParams();
  const bucket = sp.get("bucket") || "pending";
  const fms = sp.get("fms") || "";
  const [search, setSearch] = useState("");
  const [priority, setPriority] = useState("");
  const [view, setView] = useState(() => { try { return localStorage.getItem("fmsTaskView") || "list"; } catch { return "list"; } });
  const [pg, setPg] = useState({ page: 1, limit: 50 });
  const [data, setData] = useState(null);
  const [counts, setCounts] = useState({});
  const [fmsList, setFmsList] = useState([]);
  const [err, setErr] = useState("");
  const [open, setOpen] = useState(null);

  const load = useCallback(async () => {
    try {
      const r = await api.get("/my/tasks", { params: { bucket: view === "kanban" && bucket !== "completed" ? "all" : bucket, fms, search, priority, page: pg.page, limit: pg.limit } });
      setData(r.data); setErr("");
      const s = await api.get("/my/summary");
      setCounts(s.data.counts);
    } catch (e) { setErr(errMsg(e)); }
  }, [bucket, fms, search, priority, pg, view]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { api.get("/accessible").then((r) => setFmsList(r.data.items)).catch(() => {}); }, []);
  const setParam = (k, v) => { const n = new URLSearchParams(sp); if (v) n.set(k, v); else n.delete(k); setSp(n); setPg({ ...pg, page: 1 }); };
  const countOf = { pending: counts.pending, overdue: counts.overdue, today: counts.due_today, in_progress: counts.in_progress, rejected: counts.rejected, submitted: counts.submitted, completed: counts.completed_this_month };

  return (
    <div>
      <FmsNav />
      <Tabs tabs={BUCKETS.map(([value, label]) => ({ value, label, count: countOf[value] }))} value={bucket} onChange={(v) => setParam("bucket", v)} />
      <div className="my-3 flex flex-wrap items-center gap-2">
        <input className={`${inputCls} max-w-xs`} placeholder="Search UID, FMS, step, data…" value={search} onChange={(e) => setSearch(e.target.value)} />
        <select className={`${inputCls} max-w-xs`} value={fms} onChange={(e) => setParam("fms", e.target.value)}>
          <option value="">All FMS</option>{fmsList.map((f) => <option key={f.id} value={f.id}>{f.code} · {f.name}</option>)}
        </select>
        <select className={`${inputCls} max-w-[10rem]`} value={priority} onChange={(e) => setPriority(e.target.value)}>
          <option value="">Any priority</option>{["Critical", "High", "Medium", "Low"].map((p) => <option key={p}>{p}</option>)}
        </select>
        <div className="ml-auto flex gap-1">
          {["list", "kanban"].map((v) => <Btn key={v} size="sm" kind={view === v ? "primary" : "secondary"} onClick={() => { setView(v); try { localStorage.setItem("fmsTaskView", v); } catch { /* ignore */ } }}>{v === "list" ? "List" : "Kanban"}</Btn>)}
        </div>
      </div>
      <ErrorBox>{err}</ErrorBox>
      {!data ? <Spinner /> : !data.items.length ? <Empty>No tasks here. 🎉</Empty> : <TaskList items={data.items} view={bucket === "completed" ? "list" : view} onOpen={(t) => setOpen({ id: t.record_id, step: t.id })} />}
      {data && <Pager page={pg.page} limit={pg.limit} total={data.total} onPage={(p) => setPg({ ...pg, page: p })} onLimit={(l) => setPg({ page: 1, limit: l })} />}
      {open && <RecordView recordId={open.id} focusStepId={open.step} onClose={() => setOpen(null)} onChanged={load} />}
    </div>
  );
}

export function MyApprovals() {
  const [items, setItems] = useState(null);
  const [err, setErr] = useState("");
  const [open, setOpen] = useState(null);
  const load = useCallback(() => api.get("/my/approvals").then((r) => setItems(r.data.items)).catch((e) => setErr(errMsg(e))), []);
  useEffect(() => { load(); }, [load]);
  return (
    <div>
      <FmsNav />
      <h2 className="mb-3 text-lg font-semibold">Waiting for my approval</h2>
      <ErrorBox>{err}</ErrorBox>
      {!items ? <Spinner /> : !items.length ? <Empty>Nothing to approve.</Empty> : (
        <>
          <p className="mb-2 text-sm text-gray-600">Open a task to approve it, or reject it with a reason. Submitted {items.length > 0 && `— oldest ${fmtDT(items[0].submitted_at)}`}</p>
          <TaskList items={items} onOpen={(t) => setOpen({ id: t.record_id, step: t.id })} />
        </>
      )}
      {open && <RecordView recordId={open.id} focusStepId={open.step} onClose={() => setOpen(null)} onChanged={load} />}
    </div>
  );
}

export function FmsSheet() {
  const { id } = useParams();
  const nav = useNavigate();
  return (
    <div>
      <FmsNav />
      <RecordsGrid fmsId={id} isAdmin={false} onBack={() => nav("/fms")} />
    </div>
  );
}

// Admin FMS: navigation, FMS list (search / filters / tabs / actions), data grid page, approvals.
import React, { useCallback, useEffect, useState } from "react";
import { NavLink, useNavigate, useParams } from "react-router-dom";
import api, { errMsg, fmtDT } from "./shared/api";
import { Btn, Spinner, Stat, Tabs, Pager, ErrorBox, Empty, inputCls, PriorityBadge, StatusBadge, Modal, useDialog, useFlash } from "./shared/ui";
import RecordsGrid from "./shared/RecordsGrid";
import RecordView from "./shared/RecordView";
import NotificationBell from "./shared/NotificationBell";

export function FmsNav() {
  const link = ({ isActive }) => `rounded-md px-3 py-1.5 text-sm font-medium ${isActive ? "bg-blue-600 text-white" : "text-gray-700 hover:bg-gray-200"}`;
  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-2 border-b pb-3">
      <div className="flex flex-wrap items-center gap-1">
        <span className="mr-2 text-lg font-bold text-gray-900">FMS</span>
        <NavLink end to="/fms" className={link}>All FMS</NavLink>
        <NavLink to="/fms/import" className={link}>Import Excel</NavLink>
        <NavLink to="/fms/seating" className={link}>Seating &amp; Holidays</NavLink>
        <NavLink to="/fms/approvals" className={link}>Approvals</NavLink>
        <NavLink to="/fms/reports" className={link}>Reports &amp; Audit</NavLink>
      </div>
      <NotificationBell isAdmin />
    </div>
  );
}

const VIEWS = [["all", "All"], ["active", "Active"], ["inactive", "Inactive"], ["archived", "Archived"], ["templates", "Templates"], ["deleted", "Deleted"]];

export function FmsList() {
  const nav = useNavigate();
  const [view, setView] = useState("all");
  const [q, setQ] = useState({ search: "", category: "", priority: "", frequency: "", sort: "updated" });
  const [pg, setPg] = useState({ page: 1, limit: 25 });
  const [data, setData] = useState(null);
  const [err, setErr] = useState("");
  const [versions, setVersions] = useState(null);
  const [ask, dialog] = useDialog();
  const [flash, flashNode] = useFlash();

  const load = useCallback(async () => {
    try { setData((await api.get("/definitions", { params: { view, ...q, page: pg.page, limit: pg.limit } })).data); setErr(""); }
    catch (e) { setErr(errMsg(e)); }
  }, [view, q, pg]);
  useEffect(() => { load(); }, [load]);

  const act = async (fn, ok) => { try { await fn(); flash(ok); load(); } catch (e) { flash(errMsg(e), "error"); } };
  const s = data?.stats || {};

  const actions = (d) => {
    const a = [];
    if (!d.deleted) {
      a.push(["Open data", () => nav(`/fms/${d.id}`)], ["Edit setup", () => nav(`/fms/${d.id}/edit`)]);
      a.push(["Duplicate", async () => {
        const name = await ask({ title: "Duplicate FMS", message: "Copies columns, steps and settings (not rows).", input: true, defaultValue: `${d.name} (copy)`, required: true });
        if (name) act(() => api.post(`/definitions/${d.id}/duplicate`, { name }), "Duplicated");
      }]);
      if (d.is_template) a.push(["Use template", async () => {
        const name = await ask({ title: "New FMS from template", input: true, required: true, placeholder: "FMS name" });
        if (name) { try { const r = await api.post(`/definitions/${d.id}/duplicate`, { name, is_template: false }); nav(`/fms/${r.data.id}/edit`); } catch (e) { flash(errMsg(e), "error"); } }
      }], ["Remove from templates", () => act(() => api.patch(`/definitions/${d.id}/state`, { is_template: false }), "No longer a template")]);
      else a.push(["Save as template", async () => {
        const name = await ask({ title: "Save as template", input: true, defaultValue: `${d.name} template`, required: true });
        if (name) act(() => api.post(`/definitions/${d.id}/duplicate`, { name, is_template: true }), "Template saved");
      }]);
      a.push([d.status === "active" ? "Deactivate" : "Activate", () => act(() => api.patch(`/definitions/${d.id}/state`, { status: d.status === "active" ? "inactive" : "active" }), "Status changed")]);
      a.push([d.archived ? "Unarchive" : "Archive", () => act(() => api.patch(`/definitions/${d.id}/state`, { archived: !d.archived }), d.archived ? "Unarchived" : "Archived")]);
      a.push(["Versions", async () => { try { setVersions({ d, items: (await api.get(`/definitions/${d.id}/versions`)).data.items }); } catch (e) { flash(errMsg(e), "error"); } }]);
      a.push(["Delete", async () => {
        if (await ask({ title: `Delete ${d.name}?`, message: "It moves to Deleted with all its rows and can be restored.", danger: true, ok: "Delete" })) act(() => api.delete(`/definitions/${d.id}`), "Moved to Deleted");
      }]);
    } else {
      a.push(["Restore", () => act(() => api.post(`/definitions/${d.id}/restore`), "Restored")]);
      a.push(["Delete permanently", async () => {
        const typed = await ask({ title: "Delete permanently?", message: `This removes ${d.name} and ALL its rows forever. Type the FMS code (${d.code}) to confirm.`, input: true, required: true, danger: true, ok: "Delete forever" });
        if (typed === d.code) act(() => api.delete(`/definitions/${d.id}?purge=1`), "Deleted permanently");
        else if (typed) flash("Code did not match — nothing deleted", "error");
      }]);
    }
    return a;
  };

  return (
    <div>
      <FmsNav />{dialog}{flashNode}
      <div className="mb-4 grid grid-cols-3 gap-3 sm:grid-cols-6">
        <Stat label="Total" value={s.total} onClick={() => setView("all")} active={view === "all"} />
        <Stat label="Active" value={s.active} tone="green" onClick={() => setView("active")} active={view === "active"} />
        <Stat label="Inactive" value={s.inactive} onClick={() => setView("inactive")} active={view === "inactive"} />
        <Stat label="Archived" value={s.archived} tone="amber" onClick={() => setView("archived")} active={view === "archived"} />
        <Stat label="Templates" value={s.templates} tone="purple" onClick={() => setView("templates")} active={view === "templates"} />
        <Stat label="Deleted" value={s.deleted} tone="red" onClick={() => setView("deleted")} active={view === "deleted"} />
      </div>
      <div className="flex flex-wrap items-end justify-between gap-2">
        <Tabs tabs={VIEWS.map(([value, label]) => ({ value, label }))} value={view} onChange={(v) => { setView(v); setPg({ ...pg, page: 1 }); }} />
        <div className="flex gap-2 pb-1">
          <Btn onClick={() => nav("/fms/new")}>+ New FMS</Btn>
          <Btn kind="secondary" onClick={() => nav("/fms/import")}>Import from Excel</Btn>
        </div>
      </div>
      <div className="my-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
        <input className={`${inputCls} lg:col-span-2`} placeholder="Search name, code, FMS ID, category…" value={q.search} onChange={(e) => { setQ({ ...q, search: e.target.value }); setPg({ ...pg, page: 1 }); }} />
        <select className={inputCls} value={q.category} onChange={(e) => setQ({ ...q, category: e.target.value })}>
          <option value="">All categories</option>{(data?.categories || []).map((c) => <option key={c}>{c}</option>)}
        </select>
        <select className={inputCls} value={q.priority} onChange={(e) => setQ({ ...q, priority: e.target.value })}>
          <option value="">Any priority</option>{["Critical", "High", "Medium", "Low"].map((p) => <option key={p}>{p}</option>)}
        </select>
        <select className={inputCls} value={q.sort} onChange={(e) => setQ({ ...q, sort: e.target.value })}>
          <option value="updated">Recently updated</option><option value="created">Newest</option><option value="name">Name A–Z</option><option value="code">Code</option><option value="priority">Priority</option>
        </select>
      </div>
      <ErrorBox>{err}</ErrorBox>
      {!data ? <Spinner /> : !data.items.length ? <Empty>No FMS here. Create one or import an FMS Excel file.</Empty> : (
        <div className="overflow-x-auto rounded-lg border bg-white">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50 text-left text-xs uppercase text-gray-500">
              <tr><th className="px-3 py-2">FMS</th><th className="px-3 py-2">Category</th><th className="px-3 py-2">Priority</th><th className="px-3 py-2">Status</th><th className="px-3 py-2">Steps</th><th className="px-3 py-2">Rows (open)</th><th className="px-3 py-2">Overdue</th><th className="px-3 py-2">Frequency</th><th className="px-3 py-2">Updated</th><th className="px-3 py-2">Actions</th></tr>
            </thead>
            <tbody>
              {data.items.map((d) => (
                <tr key={d.id} className="border-t align-top">
                  <td className="px-3 py-2">
                    <button type="button" className="text-left font-semibold text-blue-700 hover:underline" onClick={() => nav(d.deleted ? "#" : `/fms/${d.id}`)}>{d.name}</button>
                    <div className="text-xs text-gray-500">{d.code} · {d.fms_id}{d.is_template ? " · template" : ""}{d.archived ? " · archived" : ""}</div>
                  </td>
                  <td className="px-3 py-2">{d.category || "—"}</td>
                  <td className="px-3 py-2"><PriorityBadge p={d.priority} /></td>
                  <td className="px-3 py-2"><StatusBadge status={d.status} /></td>
                  <td className="px-3 py-2">{d.step_count}</td>
                  <td className="px-3 py-2">{d.rows_total} ({d.rows_open})</td>
                  <td className="px-3 py-2">{d.overdue ? <b className="text-red-600">{d.overdue}</b> : 0}</td>
                  <td className="px-3 py-2 capitalize">{d.frequency.replace("_", " ")}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-gray-500">{fmtDT(d.updated_at)}</td>
                  <td className="px-3 py-2">
                    <div className="flex max-w-xs flex-wrap gap-x-2 gap-y-0.5">{actions(d).map(([label, fn]) => <Btn key={label} kind="link" className={`text-xs ${/Delete/.test(label) ? "!text-red-600" : ""}`} onClick={fn}>{label}</Btn>)}</div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data && <Pager page={pg.page} limit={pg.limit} total={data.total} onPage={(p) => setPg({ ...pg, page: p })} onLimit={(l) => setPg({ page: 1, limit: l })} />}
      {versions && (
        <Modal open onClose={() => setVersions(null)} title={`Versions · ${versions.d.name} (current v${versions.d.version})`}>
          {!versions.items.length ? <p className="text-sm text-gray-500">No earlier versions yet — a version is saved every time the setup is edited.</p> : (
            <ul className="divide-y">
              {versions.items.map((v) => (
                <li key={v.id} className="flex items-center justify-between gap-2 py-2 text-sm">
                  <span><b>v{v.version}</b> · {v.name} · {v.fields} columns · {v.steps} steps<br /><span className="text-xs text-gray-500">{fmtDT(v.created_at)} by {v.created_by}</span></span>
                  <Btn size="sm" kind="secondary" onClick={async () => {
                    if (!(await ask({ title: `Restore v${v.version}?`, message: "The setup (columns, steps, settings) goes back to this version. Rows are kept. The current setup is saved as a new version first." }))) return;
                    act(() => api.post(`/definitions/${versions.d.id}/versions/${v.id}/restore`), `Restored v${v.version}`); setVersions(null);
                  }}>Restore</Btn>
                </li>
              ))}
            </ul>
          )}
        </Modal>
      )}
    </div>
  );
}

export function FmsData() {
  const { id } = useParams();
  const nav = useNavigate();
  return (
    <div>
      <FmsNav />
      <div className="mb-2 flex justify-end"><Btn size="sm" kind="secondary" onClick={() => nav(`/fms/${id}/edit`)}>Edit setup</Btn></div>
      <RecordsGrid fmsId={id} isAdmin onBack={() => nav("/fms")} />
    </div>
  );
}

export function FmsApprovals() {
  const [items, setItems] = useState(null);
  const [err, setErr] = useState("");
  const [open, setOpen] = useState(null);
  const [busy, setBusy] = useState(0);
  const [ask, dialog] = useDialog();
  const [flash, flashNode] = useFlash();
  const load = useCallback(() => api.get("/approvals").then((r) => setItems(r.data.items)).catch((e) => setErr(errMsg(e))), []);
  useEffect(() => { load(); }, [load]);
  const decide = async (it, approve) => {
    const text = await ask(approve ? { title: `Approve ${it.uid} · ${it.step_name}?`, input: "textarea", message: "Optional remarks" } : { title: `Reject ${it.uid} · ${it.step_name}`, input: "textarea", required: true, danger: true, ok: "Reject", message: "Reason (shown to the doer)" });
    if (text === null) return;
    setBusy(it.id);
    try { await api.post(`/steps/${it.id}/${approve ? "approve" : "reject"}`, approve ? { remarks: text } : { reason: text }); flash(approve ? "Approved" : "Sent back"); load(); }
    catch (e) { flash(errMsg(e), "error"); } finally { setBusy(0); }
  };
  return (
    <div>
      <FmsNav />{dialog}{flashNode}
      <h2 className="mb-3 text-lg font-semibold">Steps waiting for approval</h2>
      <ErrorBox>{err}</ErrorBox>
      {!items ? <Spinner /> : !items.length ? <Empty>Nothing is waiting for approval.</Empty> : (
        <div className="overflow-x-auto rounded-lg border bg-white">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50 text-left text-xs uppercase text-gray-500"><tr><th className="px-3 py-2">FMS</th><th className="px-3 py-2">UID</th><th className="px-3 py-2">Step</th><th className="px-3 py-2">Submitted by</th><th className="px-3 py-2">Submitted</th><th className="px-3 py-2">Planned</th><th className="px-3 py-2">Status / remarks</th><th className="px-3 py-2" /></tr></thead>
            <tbody>
              {items.map((it) => (
                <tr key={it.id} className="border-t">
                  <td className="px-3 py-2">{it.code} · {it.fms_name}</td>
                  <td className="px-3 py-2"><Btn kind="link" onClick={() => setOpen({ id: it.record_id, step: it.id })}>{it.uid}</Btn></td>
                  <td className="px-3 py-2">{it.step_code}: {it.step_name}</td>
                  <td className="px-3 py-2">{it.done_by_name}</td>
                  <td className="whitespace-nowrap px-3 py-2">{fmtDT(it.submitted_at)}</td>
                  <td className="whitespace-nowrap px-3 py-2">{fmtDT(it.planned_at)}</td>
                  <td className="px-3 py-2">{it.outcome}{it.remarks && <div className="text-xs text-gray-500">{it.remarks}</div>}</td>
                  <td className="whitespace-nowrap px-3 py-2">
                    <div className="flex gap-1">
                      <Btn size="sm" kind="success" busy={busy === it.id} onClick={() => decide(it, true)}>Approve</Btn>
                      <Btn size="sm" kind="danger" busy={busy === it.id} onClick={() => decide(it, false)}>Reject</Btn>
                      <Btn size="sm" kind="secondary" onClick={() => setOpen({ id: it.record_id, step: it.id })}>Open</Btn>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {open && <RecordView recordId={open.id} focusStepId={open.step} isAdmin onClose={() => setOpen(null)} onChanged={load} />}
    </div>
  );
}

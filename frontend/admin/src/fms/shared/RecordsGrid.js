// Sheet-like data grid of one FMS: filters, saved filters, pagination, row detail, new entry, export,
// and (admin) bulk actions, Excel/CSV row import with validation + duplicate detection, duplicate finder.
import React, { useCallback, useEffect, useMemo, useState } from "react";
import * as XLSX from "xlsx";
import api, { errMsg, fmtDT, showValue, delayText, downloadTable, readWorkbook, sheetToGrid } from "./api";
import { Btn, Modal, Spinner, StatusBadge, PriorityBadge, Pager, ErrorBox, Label, inputCls, MultiPick, useDialog, useFlash, cx } from "./ui";
import RecordView from "./RecordView";
import RecordForm from "./RecordForm";

const EMPTY = { search: "", status: "", step: "", overdue: false, awaiting: false, from: "", to: "", doer: "", fkey: "", fval: "", deleted: false, sort: "", dir: "desc" };

function ImportRows({ def, onClose, onDone }) {
  const [wb, setWb] = useState(null);
  const [sheet, setSheet] = useState("");
  const [analysis, setAnalysis] = useState(null);
  const [map, setMap] = useState({});        // analysis key -> definition key ('' = ignore)
  const [dedupe, setDedupe] = useState({ fields: ["uid"], action: "skip" });
  const [report, setReport] = useState(null);
  const [progress, setProgress] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const keys = def.fields.map((f) => f.key);
  const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

  const analyze = async (book, name) => {
    setBusy(true); setErr(""); setReport(null);
    try {
      const grid = sheetToGrid(XLSX, book.Sheets[name]);
      const r = await api.post("/import/analyze", { grid, name });
      setAnalysis(r.data);
      const m = {};
      for (const f of r.data.definition.fields) {
        const hit = def.fields.find((d) => d.key === f.key) || def.fields.find((d) => norm(d.label) === norm(f.label));
        m[f.key] = hit ? hit.key : "";
      }
      setMap(m);
    } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  };

  const rows = useMemo(() => {
    if (!analysis) return [];
    const sameSteps = analysis.kind === "fms" && analysis.definition.steps.length === def.steps.length;
    const uidKey = Object.keys(map).find((k) => map[k] === "uid") || analysis.definition.fields.find((f) => /^(uid|unique_id)$/.test(f.key))?.key;
    return analysis.rows.map((r) => {
      const data = {};
      for (const [from, to] of Object.entries(map)) if (to) data[to] = r.data[from];
      const out = { data, uid: r.uid || (uidKey ? String(r.data[uidKey] || "") : "") };
      if (sameSteps) {
        // map step inputs by label into the definition's step input keys
        out.steps = Object.fromEntries(Object.entries(r.steps || {}).map(([pos, s]) => {
          const target = def.steps[Number(pos) - 1];
          const src = analysis.definition.steps[Number(pos) - 1];
          const values = {};
          for (const sf of src?.fields || []) {
            const hit = (target?.fields || []).find((x) => x.key === sf.key || norm(x.label) === norm(sf.label));
            if (hit) values[hit.key] = s.values?.[sf.key];
          }
          return [pos, { ...s, values }];
        }));
      }
      return out;
    });
  }, [analysis, map, def]);

  const send = async (dryRun) => {
    setBusy(true); setErr("");
    const chunk = 500;
    const total = { total: 0, valid: 0, invalid: [], duplicates: [], toCreate: 0, toUpdate: 0, created: [], failed: [], updated: 0 };
    try {
      for (let i = 0; i < rows.length; i += chunk) {
        setProgress({ done: i, total: rows.length });
        const r = (await api.post(`/definitions/${def.id}/records/import`, { rows: rows.slice(i, i + chunk), dedupe, dryRun, mode: "lenient" })).data;
        const shift = (list) => (list || []).map((x) => ({ ...x, row: x.row + i }));
        total.total += r.total; total.valid += r.valid; total.toCreate += r.toCreate; total.toUpdate += r.toUpdate; total.updated += r.updated || 0;
        total.invalid.push(...shift(r.invalid)); total.duplicates.push(...shift(r.duplicates));
        total.created.push(...shift(r.created)); total.failed.push(...shift(r.failed));
      }
      setReport({ ...total, dryRun });
      if (!dryRun) onDone();
    } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); setProgress(null); }
  };

  return (
    <Modal open full onClose={onClose} title={`Import rows · ${def.name}`}
      footer={analysis && <>
        <Btn kind="secondary" onClick={onClose}>Close</Btn>
        <Btn kind="secondary" busy={busy} disabled={!rows.length} onClick={() => send(true)}>Validate (preview)</Btn>
        <Btn busy={busy} disabled={!rows.length || (report && !report.dryRun)} onClick={() => send(false)}>Import {rows.length} rows</Btn>
      </>}>
      <div className="space-y-4">
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <Label>Excel / CSV file</Label>
            <input type="file" accept=".xlsx,.xls,.csv" onChange={async (e) => {
              const f = e.target.files[0]; if (!f) return;
              try { const book = await readWorkbook(XLSX, f); setWb(book); const first = book.SheetNames[0]; setSheet(first); analyze(book, first); } catch (x) { setErr(`Could not read file: ${x.message}`); }
            }} />
          </div>
          {wb && wb.SheetNames.length > 1 && (
            <div>
              <Label>Sheet</Label>
              <select className={inputCls} value={sheet} onChange={(e) => { setSheet(e.target.value); analyze(wb, e.target.value); }}>
                {wb.SheetNames.map((n) => <option key={n}>{n}</option>)}
              </select>
            </div>
          )}
        </div>
        <ErrorBox>{err}</ErrorBox>
        {busy && !progress && <Spinner text="Reading…" />}
        {progress && <div className="h-2 w-full overflow-hidden rounded bg-gray-200"><div className="h-full bg-blue-600 transition-all" style={{ width: `${(progress.done / progress.total) * 100}%` }} /></div>}
        {analysis && (
          <>
            <div className="text-sm text-gray-700">Found <b>{analysis.totalRows}</b> rows ({analysis.kind === "fms" ? `FMS layout with ${analysis.definition.steps.length} steps` : "plain table"}).
              {analysis.kind === "fms" && analysis.definition.steps.length === def.steps.length ? " Step planned/actual/status will be imported too." : analysis.kind === "fms" ? " Step count differs from this FMS — only columns are imported." : ""}</div>
            <div>
              <Label>Column mapping (sheet column → FMS column)</Label>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {analysis.definition.fields.map((f) => (
                  <div key={f.key} className="flex items-center gap-2 text-sm">
                    <span className="w-40 truncate" title={f.label}>{f.label}</span>
                    <span>→</span>
                    <select className="flex-1 rounded border px-2 py-1" value={map[f.key] || ""} onChange={(e) => setMap({ ...map, [f.key]: e.target.value })}>
                      <option value="">— ignore —</option>
                      {def.fields.map((d) => <option key={d.key} value={d.key}>{d.label}</option>)}
                    </select>
                  </div>
                ))}
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label>Duplicate check on</Label>
                <MultiPick options={[{ value: "uid", label: "UID" }, ...def.fields.map((f) => ({ value: f.key, label: f.label }))]} value={dedupe.fields} onChange={(v) => setDedupe({ ...dedupe, fields: v })} placeholder="Choose columns…" />
              </div>
              <div>
                <Label>When a duplicate is found</Label>
                <select className={inputCls} value={dedupe.action} onChange={(e) => setDedupe({ ...dedupe, action: e.target.value })}>
                  <option value="skip">Skip it</option>
                  <option value="update">Update the existing row's columns</option>
                  <option value="create">Import it anyway</option>
                </select>
              </div>
            </div>
            <div>
              <Label>Preview (first 10 rows)</Label>
              <div className="overflow-x-auto rounded border">
                <table className="min-w-full text-xs">
                  <thead className="bg-gray-50"><tr>{["UID", ...def.fields.filter((f) => keys.includes(f.key)).map((f) => f.label)].map((h) => <th key={h} className="whitespace-nowrap px-2 py-1 text-left">{h}</th>)}</tr></thead>
                  <tbody>{rows.slice(0, 10).map((r, i) => <tr key={i} className="border-t">{[r.uid, ...def.fields.map((f) => showValue(f, r.data[f.key]))].map((v, k) => <td key={k} className="whitespace-nowrap px-2 py-1">{String(v ?? "")}</td>)}</tr>)}</tbody>
                </table>
              </div>
            </div>
          </>
        )}
        {report && (
          <div className="rounded-md border bg-gray-50 p-3 text-sm">
            <div className="font-semibold">{report.dryRun ? "Validation result (nothing saved yet)" : "Import finished"}</div>
            <div className="mt-1 flex flex-wrap gap-4">
              <span>Rows: <b>{report.total}</b></span><span>Valid: <b>{report.valid}</b></span>
              <span>{report.dryRun ? "Will create" : "Created"}: <b className="text-green-700">{report.dryRun ? report.toCreate : report.created.length}</b></span>
              <span>{report.dryRun ? "Will update" : "Updated"}: <b>{report.dryRun ? report.toUpdate : report.updated}</b></span>
              <span>Duplicates: <b className="text-amber-700">{report.duplicates.length}</b></span>
              <span>Errors: <b className="text-red-700">{report.invalid.length + (report.failed?.length || 0)}</b></span>
            </div>
            {[...report.invalid, ...(report.failed || [])].slice(0, 50).map((x, i) => <div key={i} className="text-red-700">Row {x.row}: {x.errors.join("; ")}</div>)}
            {report.duplicates.slice(0, 30).map((x, i) => <div key={`d${i}`} className="text-amber-700">Row {x.row}: duplicate of {x.existing_uid || "an earlier row in this file"}</div>)}
          </div>
        )}
      </div>
    </Modal>
  );
}

// Add / rename / remove columns straight from the data grid (saves the FMS setup; a version is kept).
function Columns({ fmsId, onClose, onDone }) {
  const [def, setDef] = useState(null);
  const [cols, setCols] = useState([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [ask, dialog] = useDialog();
  useEffect(() => { api.get(`/definitions/${fmsId}`).then((r) => { setDef(r.data.definition); setCols(r.data.definition.fields.map((f) => ({ ...f }))); }).catch((e) => setErr(errMsg(e))); }, [fmsId]);
  const TYPES = [["text", "Text"], ["textarea", "Long text"], ["number", "Number"], ["date", "Date"], ["datetime", "Date & time"], ["select", "Dropdown"], ["multiselect", "Multi-select"], ["checkbox", "Yes / No"], ["email", "Email"], ["phone", "Phone"], ["url", "Link"], ["employee", "Employee"]];
  const set = (i, patch) => setCols(cols.map((c, k) => (k === i ? { ...c, ...patch } : c)));
  const save = async () => {
    setBusy(true); setErr("");
    try { await api.put(`/definitions/${fmsId}`, { ...def, fields: cols }); onDone(); onClose(); }
    catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  };
  return (
    <Modal open wide onClose={onClose} title="Columns" footer={<><Btn kind="secondary" onClick={onClose}>Cancel</Btn><Btn busy={busy} disabled={!def} onClick={save}>Save columns</Btn></>}>
      {dialog}
      {!def && !err && <Spinner />}
      {def && (
        <div className="space-y-2">
          <p className="text-xs text-gray-500">Removing a column hides it everywhere; values already in rows are kept and come back if you add a column with the same key. Every save keeps a version (All FMS → Versions).</p>
          {cols.map((c, i) => (
            <div key={c.id || `n${i}`} className="flex flex-wrap items-center gap-2 rounded border px-2 py-1.5">
              <input className="min-w-[10rem] flex-1 rounded border px-2 py-1 text-sm" value={c.label} placeholder="Column name" onChange={(e) => set(i, { label: e.target.value })} />
              <select className="rounded border px-2 py-1 text-sm" value={c.type} disabled={!!c.formula} onChange={(e) => set(i, { type: e.target.value })}>{TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
              {["select", "multiselect"].includes(c.type) && <input className="w-56 rounded border px-2 py-1 text-sm" placeholder="Options: a, b, c" value={(c.options || []).join(", ")} onChange={(e) => set(i, { options: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) })} />}
              {c.formula && <span className="rounded bg-indigo-100 px-1.5 text-xs text-indigo-800" title={c.formula}>ƒ calculated</span>}
              <label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={!!c.required} onChange={(e) => set(i, { required: e.target.checked })} />required</label>
              <label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={c.in_list !== false} onChange={(e) => set(i, { in_list: e.target.checked })} />show in grid</label>
              <Btn size="sm" kind="ghost" className="text-red-600" onClick={async () => {
                if (c.id && !(await ask({ title: `Remove column "${c.label}"?`, message: "It disappears from the grid, forms and exports after you save.", danger: true, ok: "Remove" }))) return;
                setCols(cols.filter((_, k) => k !== i));
              }}>Remove</Btn>
            </div>
          ))}
          <Btn size="sm" kind="secondary" onClick={() => setCols([...cols, { label: "", type: "text", options: [], required: false, in_list: true }])}>+ Add column</Btn>
        </div>
      )}
      <div className="mt-3"><ErrorBox>{err}</ErrorBox></div>
    </Modal>
  );
}

function Duplicates({ def, onClose, onDone }) {
  const [fields, setFields] = useState([]);
  const [res, setRes] = useState(null);
  const [sel, setSel] = useState([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [ask, dialog] = useDialog();
  const find = async () => {
    setBusy(true); setErr(""); setSel([]);
    try { setRes((await api.get(`/definitions/${def.id}/duplicates`, { params: { fields: fields.join(",") } })).data); } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  };
  return (
    <Modal open wide onClose={onClose} title="Find duplicates"
      footer={<><Btn kind="secondary" onClick={onClose}>Close</Btn><Btn kind="danger" disabled={!sel.length} busy={busy} onClick={async () => {
        if (!(await ask({ title: "Delete selected rows?", message: `${sel.length} row(s) will be moved to Deleted (restorable).`, danger: true, ok: "Delete" }))) return;
        setBusy(true);
        try { await api.post(`/definitions/${def.id}/records/bulk`, { ids: sel, action: "delete" }); onDone(); find(); } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
      }}>Delete selected ({sel.length})</Btn></>}>
      {dialog}
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-[16rem] flex-1">
          <Label>Rows are duplicates when these columns match</Label>
          <MultiPick options={[{ value: "uid", label: "UID" }, ...def.fields.map((f) => ({ value: f.key, label: f.label }))]} value={fields} onChange={setFields} placeholder="Choose columns…" />
        </div>
        <Btn disabled={!fields.length} busy={busy} onClick={find}>Find</Btn>
      </div>
      <div className="mt-3"><ErrorBox>{err}</ErrorBox></div>
      {res && (
        <div className="mt-3 space-y-3">
          <div className="text-sm text-gray-700">{res.totalGroups} group(s), {res.totalRows} rows. Tick the copies to remove (keep one per group).</div>
          {res.groups.map((g) => (
            <div key={g.key} className="rounded border">
              <div className="bg-gray-50 px-3 py-1.5 text-sm font-medium">{g.key} <span className="text-gray-500">({g.count})</span></div>
              {g.records.map((r, i) => (
                <label key={r.id} className="flex items-center gap-3 border-t px-3 py-1.5 text-sm">
                  <input type="checkbox" checked={sel.includes(r.id)} onChange={(e) => setSel(e.target.checked ? [...sel, r.id] : sel.filter((x) => x !== r.id))} />
                  <b>{r.uid}</b><StatusBadge status={r.status} /><span className="text-gray-500">{fmtDT(r.created_at)} · {r.created_by_name}</span>{i === 0 && <span className="text-xs text-green-700">oldest</span>}
                </label>
              ))}
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

export default function RecordsGrid({ fmsId, isAdmin, onBack }) {
  const [def, setDef] = useState(null);
  const [perm, setPerm] = useState({});
  const [f, setF] = useState(EMPTY);
  const [applied, setApplied] = useState(EMPTY);
  const [pg, setPg] = useState({ page: 1, limit: 50 });
  const [data, setData] = useState(null);
  const [err, setErr] = useState("");
  const [open, setOpen] = useState(null);
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  const [dupes, setDupes] = useState(false);
  const [columns, setColumns] = useState(false);
  const [sel, setSel] = useState([]);
  const [busy, setBusy] = useState("");
  const [saved, setSaved] = useState([]);
  const [ask, dialog] = useDialog();
  const [flash, flashNode] = useFlash();

  useEffect(() => {
    api.get(`/definitions/${fmsId}`).then((r) => { setDef({ ...r.data.definition, seats: r.data.seats }); setPerm(r.data.permissions); }).catch((e) => setErr(errMsg(e)));
    api.get("/filters", { params: { scope: `records:${fmsId}` } }).then((r) => setSaved(r.data.items)).catch(() => {});
  }, [fmsId]);

  const params = useCallback((a) => {
    const p = { search: a.search, status: a.status, step: a.step, from: a.from, to: a.to, doer: a.doer, sort: a.sort, dir: a.dir };
    if (a.overdue) p.overdue = 1;
    if (a.awaiting) p.awaiting = 1;
    if (a.deleted) p.deleted = 1;
    if (a.fkey && a.fval) p[`f.${a.fkey}`] = a.fval;
    return Object.fromEntries(Object.entries(p).filter(([, v]) => v !== "" && v !== undefined));
  }, []);

  const load = useCallback(async () => {
    try {
      const r = await api.get(`/definitions/${fmsId}/records`, { params: { ...params(applied), page: pg.page, limit: pg.limit } });
      setData(r.data); setErr("");
    } catch (e) { setErr(errMsg(e)); }
  }, [fmsId, applied, pg, params]);
  useEffect(() => { load(); }, [load]);

  const apply = (next = f) => { setApplied(next); setPg({ ...pg, page: 1 }); setSel([]); };
  const listFields = useMemo(() => (def?.fields || []).filter((x) => x.in_list), [def]);

  const exportAs = async (format) => {
    setBusy(`exp-${format}`);
    try {
      const r = await api.get(`/definitions/${fmsId}/records/export`, { params: params(applied) });
      await downloadTable({ format, name: `${r.data.code} ${r.data.name}`, columns: r.data.columns, rows: r.data.rows, XLSX });
      flash(`Exported ${r.data.rows.length} rows`);
    } catch (e) { flash(errMsg(e), "error"); } finally { setBusy(""); }
  };

  const bulk = async (action, value) => {
    if (!sel.length) return;
    if (action === "delete" && !(await ask({ title: "Delete rows?", message: `${sel.length} row(s) will move to Deleted (restorable).`, danger: true, ok: "Delete" }))) return;
    setBusy("bulk");
    try { const r = await api.post(`/definitions/${fmsId}/records/bulk`, { ids: sel, action, value }); flash(`${r.data.changed} row(s) updated`); setSel([]); load(); }
    catch (e) { flash(errMsg(e), "error"); } finally { setBusy(""); }
  };

  if (err && !def) return <ErrorBox>{err}</ErrorBox>;
  if (!def) return <Spinner />;
  const items = data?.items || [];
  const allSel = items.length > 0 && items.every((r) => sel.includes(r.id));

  return (
    <div className="space-y-3">
      {dialog}{flashNode}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          {onBack && <Btn kind="link" onClick={onBack}>← All FMS</Btn>}
          <h1 className="text-xl font-bold text-gray-900">{def.name} <span className="text-sm font-normal text-gray-500">{def.code} · {def.fms_id}</span></h1>
          <div className="mt-1 flex flex-wrap gap-2 text-xs text-gray-600">
            <PriorityBadge p={def.priority} />{def.category && <span>{def.category}</span>}
            <span>· {def.steps.length} steps</span>
            {data?.counts && <span>· open {data.counts.open || 0} · completed {data.counts.completed || 0}{data.counts.cancelled ? ` · cancelled ${data.counts.cancelled}` : ""}</span>}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {perm.create && <Btn onClick={() => setAdding(true)}>+ New entry</Btn>}
          {isAdmin && <Btn kind="secondary" onClick={() => setImporting(true)}>Import rows</Btn>}
          {isAdmin && <Btn kind="secondary" onClick={() => setColumns(true)}>Columns</Btn>}
          {isAdmin && <Btn kind="secondary" onClick={() => setDupes(true)}>Duplicates</Btn>}
          <Btn kind="secondary" busy={busy === "exp-xlsx"} onClick={() => exportAs("xlsx")}>Excel</Btn>
          <Btn kind="secondary" busy={busy === "exp-csv"} onClick={() => exportAs("csv")}>CSV</Btn>
          <Btn kind="secondary" busy={busy === "exp-pdf"} onClick={() => exportAs("pdf")}>PDF</Btn>
        </div>
      </div>

      {/* filters */}
      <div className="rounded-lg border bg-white p-3">
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-6">
          <input className={cx(inputCls, "lg:col-span-2")} placeholder="Search UID, any column, remarks, doer…" value={f.search} onChange={(e) => setF({ ...f, search: e.target.value })} onKeyDown={(e) => e.key === "Enter" && apply()} />
          <select className={inputCls} value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>
            <option value="">All rows</option><option value="open">Open</option><option value="completed">Completed</option><option value="cancelled">Cancelled</option>
          </select>
          <select className={inputCls} value={f.step} onChange={(e) => setF({ ...f, step: e.target.value })}>
            <option value="">Any current step</option>
            {def.steps.map((s) => <option key={s.id} value={s.position}>At {s.code}: {s.name}</option>)}
          </select>
          <input type="date" className={inputCls} title="From" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} />
          <input type="date" className={inputCls} title="To" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} />
          <select className={inputCls} value={f.fkey} onChange={(e) => setF({ ...f, fkey: e.target.value })}>
            <option value="">Filter a column…</option>
            {def.fields.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}
          </select>
          {f.fkey ? (def.fields.find((x) => x.key === f.fkey)?.options?.length
            ? <select className={inputCls} value={f.fval} onChange={(e) => setF({ ...f, fval: e.target.value })}><option value="">Any</option>{def.fields.find((x) => x.key === f.fkey).options.map((o) => <option key={o}>{o}</option>)}</select>
            : <input className={inputCls} placeholder="contains…" value={f.fval} onChange={(e) => setF({ ...f, fval: e.target.value })} onKeyDown={(e) => e.key === "Enter" && apply()} />)
            : <input className={inputCls} placeholder="Doer name / ID" value={f.doer} onChange={(e) => setF({ ...f, doer: e.target.value })} onKeyDown={(e) => e.key === "Enter" && apply()} />}
          <select className={inputCls} value={`${f.sort}|${f.dir}`} onChange={(e) => { const [s, d] = e.target.value.split("|"); setF({ ...f, sort: s, dir: d }); }}>
            <option value="|desc">Newest first</option><option value="|asc">Oldest first</option>
            <option value="uid|asc">UID ↑</option><option value="uid|desc">UID ↓</option>
            <option value="start|desc">Start time ↓</option><option value="updated|desc">Recently updated</option>
            {def.fields.map((x) => <option key={x.key} value={`${x.key}|asc`}>{x.label} ↑</option>)}
          </select>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.overdue} onChange={(e) => setF({ ...f, overdue: e.target.checked })} /> Overdue only</label>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.awaiting} onChange={(e) => setF({ ...f, awaiting: e.target.checked })} /> Awaiting approval</label>
          {isAdmin && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.deleted} onChange={(e) => setF({ ...f, deleted: e.target.checked })} /> Deleted rows</label>}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Btn size="sm" onClick={() => apply()}>Apply filters</Btn>
          <Btn size="sm" kind="secondary" onClick={() => { setF(EMPTY); apply(EMPTY); }}>Reset</Btn>
          <Btn size="sm" kind="ghost" onClick={async () => {
            const name = await ask({ title: "Save these filters", input: true, required: true, placeholder: "e.g. Overdue at STEP-2" });
            if (!name) return;
            try { await api.post("/filters", { scope: `records:${fmsId}`, name, filters: f }); const r = await api.get("/filters", { params: { scope: `records:${fmsId}` } }); setSaved(r.data.items); flash("Filter saved"); } catch (e) { flash(errMsg(e), "error"); }
          }}>Save filter</Btn>
          {saved.map((s) => (
            <span key={s.id} className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-xs">
              <button type="button" className="text-blue-700 hover:underline" onClick={() => { const n = { ...EMPTY, ...s.filters }; setF(n); apply(n); }}>{s.name}</button>
              <button type="button" className="text-gray-400 hover:text-red-600" onClick={async () => { await api.delete(`/filters/${s.id}`); setSaved(saved.filter((x) => x.id !== s.id)); }}>×</button>
            </span>
          ))}
        </div>
      </div>

      {isAdmin && sel.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-md bg-blue-50 px-3 py-2 text-sm">
          <b>{sel.length} selected</b>
          {applied.deleted ? <Btn size="sm" kind="secondary" busy={busy === "bulk"} onClick={() => bulk("restore")}>Restore</Btn>
            : <Btn size="sm" kind="danger" busy={busy === "bulk"} onClick={() => bulk("delete")}>Delete</Btn>}
          <Btn size="sm" kind="secondary" onClick={() => bulk("cancel")}>Cancel rows</Btn>
          <Btn size="sm" kind="secondary" onClick={() => bulk("reactivate")}>Re-activate</Btn>
          <select className="rounded border px-2 py-1" value="" onChange={(e) => e.target.value && bulk("priority", e.target.value)}>
            <option value="">Set priority…</option>{["Low", "Medium", "High", "Critical"].map((p) => <option key={p}>{p}</option>)}
          </select>
          <Btn size="sm" kind="ghost" onClick={() => setSel([])}>Clear</Btn>
        </div>
      )}

      <ErrorBox>{err}</ErrorBox>
      {!data ? <Spinner /> : (
        <div className="overflow-x-auto rounded-lg border bg-white">
          <table className="min-w-full text-sm">
            <thead className="sticky top-0 bg-gray-800 text-xs text-white">
              <tr>
                {isAdmin && <th className="px-2 py-2"><input type="checkbox" checked={allSel} onChange={(e) => setSel(e.target.checked ? items.map((r) => r.id) : [])} /></th>}
                <th className="whitespace-nowrap px-2 py-2 text-left">UID</th>
                {listFields.map((x) => <th key={x.key} className="whitespace-nowrap px-2 py-2 text-left">{x.label}</th>)}
                {def.steps.map((s) => <th key={s.id} className="whitespace-nowrap border-l border-gray-600 px-2 py-2 text-left" title={s.how}>{s.code}<div className="font-normal text-gray-300">{s.name}</div></th>)}
                <th className="px-2 py-2 text-left">Row</th>
                {isAdmin && <th className="px-2 py-2" />}
              </tr>
            </thead>
            <tbody>
              {items.map((r) => (
                <tr key={r.id} className="cursor-pointer border-t hover:bg-blue-50" onClick={() => setOpen({ id: r.id })}>
                  {isAdmin && <td className="px-2 py-1.5" onClick={(e) => e.stopPropagation()}><input type="checkbox" checked={sel.includes(r.id)} onChange={(e) => setSel(e.target.checked ? [...sel, r.id] : sel.filter((x) => x !== r.id))} /></td>}
                  <td className="whitespace-nowrap px-2 py-1.5 font-medium text-blue-700">{r.uid}</td>
                  {listFields.map((x) => <td key={x.key} className="max-w-[16rem] truncate px-2 py-1.5" title={showValue(x, r.data[x.key])}>{showValue(x, r.data[x.key])}</td>)}
                  {def.steps.map((s) => {
                    const rs = r.steps.find((y) => y.step_id === s.id);
                    if (!rs) return <td key={s.id} className="border-l px-2" />;
                    const overdue = ["pending", "in_progress", "rejected"].includes(rs.status) && rs.planned_at && new Date(rs.planned_at) < new Date();
                    return (
                      <td key={s.id} className="whitespace-nowrap border-l px-2 py-1.5 text-xs" onClick={(e) => { e.stopPropagation(); setOpen({ id: r.id, step: rs.id }); }}>
                        <StatusBadge status={rs.status} overdue={overdue} />
                        {rs.planned_at && <div className="text-gray-500">P: {fmtDT(rs.planned_at)}</div>}
                        {rs.actual_at && <div className="text-gray-500">A: {fmtDT(rs.actual_at)}{rs.delay_minutes ? <span className="text-red-600"> +{delayText(rs.delay_minutes)}</span> : ""}</div>}
                      </td>
                    );
                  })}
                  <td className="px-2 py-1.5"><StatusBadge status={r.status} /></td>
                  {isAdmin && (
                    <td className="px-2 py-1.5" onClick={(e) => e.stopPropagation()}>
                      {r.deleted
                        ? <button type="button" title="Restore row" className="rounded px-1.5 py-0.5 text-blue-700 hover:bg-blue-100" onClick={async () => { try { await api.post(`/definitions/${fmsId}/records/bulk`, { ids: [r.id], action: "restore" }); flash(`${r.uid} restored`); load(); } catch (e) { flash(errMsg(e), "error"); } }}>↺</button>
                        : <button type="button" title="Delete row" className="rounded px-1.5 py-0.5 text-red-600 hover:bg-red-100" onClick={async () => {
                          if (!(await ask({ title: `Delete row ${r.uid}?`, message: "It moves to Deleted rows (tick “Deleted rows” to see and restore).", danger: true, ok: "Delete" }))) return;
                          try { await api.delete(`/records/${r.id}`); flash(`${r.uid} deleted`); load(); } catch (e) { flash(errMsg(e), "error"); }
                        }}>🗑</button>}
                    </td>
                  )}
                </tr>
              ))}
              {!items.length && <tr><td colSpan={99} className="px-3 py-10 text-center text-gray-500">No rows match.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
      {data && <Pager page={pg.page} limit={pg.limit} total={data.total} onPage={(p) => setPg({ ...pg, page: p })} onLimit={(l) => setPg({ page: 1, limit: l })} />}

      {open && <RecordView recordId={open.id} focusStepId={open.step} isAdmin={isAdmin} onClose={() => setOpen(null)} onChanged={load} />}
      {adding && <RecordForm definition={def} onClose={() => setAdding(false)} onCreated={(r, another) => { flash(`Row ${r.uid} created`); load(); if (!another) setAdding(false); }} />}
      {importing && <ImportRows def={def} onClose={() => setImporting(false)} onDone={load} />}
      {dupes && <Duplicates def={def} onClose={() => setDupes(false)} onDone={load} />}
      {columns && <Columns fmsId={fmsId} onClose={() => setColumns(false)} onDone={() => { api.get(`/definitions/${fmsId}`).then((r) => setDef({ ...r.data.definition, seats: r.data.seats })).catch(() => {}); load(); flash("Columns saved"); }} />}
    </div>
  );
}

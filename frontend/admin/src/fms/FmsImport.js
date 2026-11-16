// Auto-create an FMS from an Excel/CSV file: pick a sheet → the server reads the FMS layout
// (STEP / WHAT / WHO / HOW / WHEN rows, Planned / Actual / Status columns) → review → create + import rows.
import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import * as XLSX from "xlsx";
import api, { errMsg, readWorkbook, sheetToGrid } from "./shared/api";
import { Btn, Spinner, ErrorBox, Label, inputCls, cx, MultiPick } from "./shared/ui";
import { FmsNav } from "./FmsAdmin";

const TYPES = ["text", "textarea", "number", "date", "datetime", "select", "multiselect", "checkbox", "email", "phone", "url", "employee"];

export default function FmsImport() {
  const nav = useNavigate();
  const [file, setFile] = useState(null);
  const [wb, setWb] = useState(null);
  const [sheet, setSheet] = useState("");
  const [a, setA] = useState(null);         // analysis
  const [def, setDef] = useState(null);     // editable definition
  const [importRows, setImportRows] = useState(true);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [progress, setProgress] = useState(null);
  const [done, setDone] = useState(null);
  const [lk, setLk] = useState({ departments: [], designations: [] });
  useEffect(() => { api.get("/lookups").then((r) => setLk(r.data)).catch(() => {}); }, []);
  const access = def?.access || { departments: [], designations: [], employees: [] };
  const noAccess = !access.departments?.length && !access.designations?.length;

  const looksFms = (ws) => { const g = XLSX.utils.sheet_to_json(ws, { header: 1, range: 0, defval: "" }).slice(0, 15); return g.some((r) => r.some((c) => /^planned/i.test(String(c).trim()))); };

  const analyze = async (book, name) => {
    setBusy("analyze"); setErr(""); setA(null); setDef(null); setDone(null);
    try {
      const grid = sheetToGrid(XLSX, book.Sheets[name]);
      const r = await api.post("/import/analyze", { grid, name });
      setA(r.data);
      setDef((prev) => ({ ...r.data.definition, name: r.data.definition.name || name, code: "", category: "", access: prev?.access || { departments: [], designations: [], employees: [] } }));
    } catch (e) { setErr(errMsg(e)); } finally { setBusy(""); }
  };

  const onFile = async (f) => {
    if (!f) return;
    setFile(f); setErr("");
    try {
      const book = await readWorkbook(XLSX, f);
      setWb(book);
      const first = book.SheetNames.find((n) => looksFms(book.Sheets[n])) || book.SheetNames[0];
      setSheet(first);
      analyze(book, first);
    } catch (e) { setErr(`Could not read the file: ${e.message}`); }
  };

  const setField = (i, patch) => setDef({ ...def, fields: def.fields.map((f, k) => (k === i ? { ...f, ...patch } : f)) });
  const setStep = (i, patch) => setDef({ ...def, steps: def.steps.map((s, k) => (k === i ? { ...s, ...patch } : s)) });

  const create = async () => {
    setBusy("create"); setErr("");
    try {
      const c = await api.post("/import/commit", { definition: def });
      const id = c.data.id;
      let created = 0, failed = 0, dup = 0;
      if (importRows && a.rows.length) {
        const chunk = 400;
        for (let i = 0; i < a.rows.length; i += chunk) {
          setProgress({ done: i, total: a.rows.length });
          const r = await api.post(`/definitions/${id}/records/import`, { rows: a.rows.slice(i, i + chunk), mode: "lenient", dedupe: { fields: ["uid"], action: "skip" } });
          created += r.data.created.length; failed += r.data.failed.length; dup += r.data.duplicates.length;
        }
      }
      setProgress(null);
      setDone({ id, created, failed, dup, seats: c.data.createdSeats });
    } catch (e) { setErr(errMsg(e)); setProgress(null); } finally { setBusy(""); }
  };

  return (
    <div>
      <FmsNav />
      <h1 className="mb-1 text-xl font-bold">Import an FMS from Excel</h1>
      <p className="mb-4 text-sm text-gray-600">Upload your FMS sheet. The system reads the STEP-1…n blocks (WHAT / WHO / HOW / WHEN rows and Planned / Actual / Status columns), creates the FMS with its columns, steps, seats and TAT, and imports the existing rows. A plain table (just a header row) becomes an FMS with those columns — add steps afterwards.</p>
      <div className="flex flex-wrap items-end gap-3 rounded-lg border bg-white p-4">
        <div>
          <Label>Excel / CSV file</Label>
          <input type="file" accept=".xlsx,.xls,.csv" onChange={(e) => onFile(e.target.files[0])} />
        </div>
        {wb && (
          <div className="min-w-[14rem]">
            <Label>Sheet</Label>
            <select className={inputCls} value={sheet} onChange={(e) => { setSheet(e.target.value); analyze(wb, e.target.value); }}>
              {wb.SheetNames.map((n) => <option key={n} value={n}>{n}{looksFms(wb.Sheets[n]) ? "  (FMS layout)" : ""}</option>)}
            </select>
          </div>
        )}
        {file && <span className="text-sm text-gray-500">{file.name}</span>}
      </div>
      <div className="mt-3"><ErrorBox>{err}</ErrorBox></div>
      {busy === "analyze" && <Spinner text="Reading the sheet…" />}

      {done && (
        <div className="mt-4 rounded-lg border border-green-300 bg-green-50 p-4">
          <div className="text-lg font-semibold text-green-800">FMS created ✔</div>
          <div className="mt-1 text-sm text-green-900">Rows imported: <b>{done.created}</b>{done.dup ? ` · duplicates skipped: ${done.dup}` : ""}{done.failed ? ` · failed: ${done.failed}` : ""}</div>
          {done.seats?.length > 0 && <div className="mt-1 text-sm text-amber-800">New seats created: <b>{done.seats.join(", ")}</b> — open Seating and add who sits on them, so tasks reach the right people.</div>}
          <div className="mt-3 flex flex-wrap gap-2">
            <Btn onClick={() => nav(`/fms/${done.id}`)}>Open FMS data</Btn>
            <Btn kind="secondary" onClick={() => nav(`/fms/${done.id}/edit`)}>Review setup</Btn>
            {done.seats?.length > 0 && <Btn kind="secondary" onClick={() => nav("/fms/seating")}>Go to Seating</Btn>}
            {wb && wb.SheetNames.length > 1 && <Btn kind="ghost" onClick={() => { setDone(null); setA(null); setDef(null); }}>Import another sheet</Btn>}
          </div>
        </div>
      )}

      {a && def && !done && (
        <div className="mt-4 space-y-4">
          <div className="rounded-lg border bg-white p-4">
            <div className="mb-2 text-sm text-gray-700">Detected: <b>{a.kind === "fms" ? `FMS layout · ${def.steps.length} steps` : "plain table"}</b> · <b>{a.totalRows}</b> rows · header on row {a.headerRow + 1}</div>
            {a.warnings.length > 0 && <ul className="mb-3 list-disc rounded-md bg-amber-50 py-2 pl-8 pr-3 text-sm text-amber-900">{a.warnings.map((w) => <li key={w}>{w}</li>)}</ul>}
            <div className="grid gap-3 md:grid-cols-3">
              <div><Label required>FMS name</Label><input className={inputCls} value={def.name} onChange={(e) => setDef({ ...def, name: e.target.value })} /></div>
              <div><Label>Code</Label><input className={inputCls} value={def.code} placeholder="e.g. FMS-20 (auto if empty)" onChange={(e) => setDef({ ...def, code: e.target.value })} /></div>
              <div><Label>Category</Label><input className={inputCls} value={def.category} onChange={(e) => setDef({ ...def, category: e.target.value })} /></div>
            </div>
            <div className={`mt-3 rounded-md border p-3 ${noAccess ? "border-red-300 bg-red-50" : "border-blue-200 bg-blue-50/50"}`}>
              <Label required>Visible to — department / designation</Label>
              <p className="mb-2 text-xs text-gray-600">Only doers of these departments or designations will see this FMS (select at least one).</p>
              <div className="grid gap-2 md:grid-cols-2">
                <div><Label>Departments</Label><MultiPick placeholder="Choose department…" options={lk.departments} value={access.departments || []} onChange={(v) => setDef({ ...def, access: { ...access, departments: v } })} /></div>
                <div><Label>Designations</Label><MultiPick placeholder="Choose designation…" options={lk.designations} value={access.designations || []} onChange={(v) => setDef({ ...def, access: { ...access, designations: v } })} /></div>
              </div>
            </div>
          </div>

          {def.steps.length > 0 && (
            <div className="rounded-lg border bg-white p-4">
              <h3 className="mb-2 font-semibold">Steps</h3>
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead className="text-left text-xs uppercase text-gray-500"><tr><th className="px-2 py-1">Step</th><th className="px-2 py-1">WHAT</th><th className="px-2 py-1">WHO (seat)</th><th className="px-2 py-1">HOW</th><th className="px-2 py-1">WHEN</th><th className="px-2 py-1">Inputs</th></tr></thead>
                  <tbody>
                    {def.steps.map((s, i) => {
                      const seat = a.seats.find((x) => x.code === s.seat_code);
                      return (
                        <tr key={i} className="border-t align-top">
                          <td className="px-2 py-1 font-semibold">{s.code}</td>
                          <td className="px-2 py-1"><input className={inputCls} value={s.name} onChange={(e) => setStep(i, { name: e.target.value })} /></td>
                          <td className="px-2 py-1">
                            <input className={inputCls} value={s.seat_code || ""} onChange={(e) => setStep(i, { seat_code: e.target.value })} />
                            <div className={cx("text-xs", seat?.existing ? "text-green-700" : "text-amber-700")}>{seat?.existing ? "existing seat" : "new seat will be created"}</div>
                          </td>
                          <td className="px-2 py-1 text-gray-600">{s.how}</td>
                          <td className="px-2 py-1">
                            <div className="flex gap-1">
                              <select className="rounded border px-1 py-1" value={s.tat?.type || "none"} onChange={(e) => setStep(i, { tat: { ...s.tat, type: e.target.value } })}>
                                <option value="none">none</option><option value="hours">hours</option><option value="days">days</option><option value="before_field">days before</option><option value="after_field">days after</option>
                              </select>
                              <input type="number" step="any" className="w-16 rounded border px-1" value={s.tat?.value ?? 0} onChange={(e) => setStep(i, { tat: { ...s.tat, value: Number(e.target.value) } })} />
                            </div>
                            {["before_field", "after_field"].includes(s.tat?.type) && (
                              <select className="mt-1 w-full rounded border px-1 py-1" value={s.tat?.field || ""} onChange={(e) => setStep(i, { tat: { ...s.tat, field: e.target.value } })}>
                                <option value="">— date column —</option>{def.fields.filter((f) => f.type === "date" || f.type === "datetime").map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
                              </select>
                            )}
                          </td>
                          <td className="px-2 py-1 text-xs text-gray-600">{(s.fields || []).map((f) => `${f.label} (${f.type})`).join(", ") || "—"}
                            {s.jumps && Object.entries(s.jumps).map(([o, t]) => <div key={o} className="text-amber-700">“{o}” → STEP-{t}</div>)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="mt-2 text-xs text-gray-500">Conditions (e.g. “IF GOODS ARE NOT AVAILABLE”), approvals and reminders can be set in the builder after creating.</p>
            </div>
          )}

          <div className="rounded-lg border bg-white p-4">
            <h3 className="mb-2 font-semibold">Columns ({def.fields.length})</h3>
            <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
              {def.fields.map((f, i) => (
                <div key={f.key} className="flex items-center gap-2 rounded border px-2 py-1">
                  <input className="min-w-0 flex-1 rounded border px-2 py-1 text-sm" value={f.label} onChange={(e) => setField(i, { label: e.target.value })} />
                  <select className="rounded border px-1 py-1 text-sm" value={f.type} onChange={(e) => setField(i, { type: e.target.value, options: e.target.value === "select" || e.target.value === "multiselect" ? f.options || [] : [] })}>
                    {TYPES.map((t) => <option key={t}>{t}</option>)}
                  </select>
                  <label className="flex items-center gap-1 text-xs" title="Show in grid"><input type="checkbox" checked={f.in_list !== false} onChange={(e) => setField(i, { in_list: e.target.checked })} />grid</label>
                </div>
              ))}
            </div>
            <label className="mt-2 block text-sm">Row start time column:{" "}
              <select className="rounded border px-2 py-1" value={def.start_field || ""} onChange={(e) => setDef({ ...def, start_field: e.target.value })}>
                <option value="">When the row is created</option>{def.fields.filter((f) => f.type === "date" || f.type === "datetime").map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
              </select>
            </label>
          </div>

          <div className="rounded-lg border bg-white p-4">
            <h3 className="mb-2 font-semibold">Preview — first 8 rows</h3>
            <div className="overflow-x-auto">
              <table className="min-w-full text-xs">
                <thead className="bg-gray-50"><tr><th className="px-2 py-1 text-left">UID</th>{def.fields.slice(0, 10).map((f) => <th key={f.key} className="whitespace-nowrap px-2 py-1 text-left">{f.label}</th>)}{def.steps.map((s) => <th key={s.code} className="whitespace-nowrap px-2 py-1 text-left">{s.code} actual</th>)}</tr></thead>
                <tbody>{a.rows.slice(0, 8).map((r, i) => <tr key={i} className="border-t"><td className="px-2 py-1">{r.uid || "(new)"}</td>{def.fields.slice(0, 10).map((f) => <td key={f.key} className="max-w-[12rem] truncate whitespace-nowrap px-2 py-1">{String(r.data[f.key] ?? "")}</td>)}{def.steps.map((s, k) => <td key={s.code} className="whitespace-nowrap px-2 py-1">{String(r.steps?.[k + 1]?.actual ?? "")}</td>)}</tr>)}</tbody>
              </table>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-white p-4">
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={importRows} onChange={(e) => setImportRows(e.target.checked)} /> Also import the {a.totalRows} existing rows (duplicate UIDs are skipped; past steps keep their Planned/Actual/Status)</label>
            {noAccess && <span className="text-sm text-red-600">Select a department or designation above first</span>}
            <Btn size="lg" busy={busy === "create"} disabled={noAccess} onClick={create}>Create FMS{importRows ? ` & import ${a.totalRows} rows` : ""}</Btn>
          </div>
          {progress && (
            <div>
              <div className="mb-1 text-sm text-gray-600">Importing rows… {progress.done} / {progress.total}</div>
              <div className="h-2 w-full overflow-hidden rounded bg-gray-200"><div className="h-full bg-blue-600 transition-all" style={{ width: `${(progress.done / progress.total) * 100}%` }} /></div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

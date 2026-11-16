// One FMS row: data, step timeline with actions (doer + approver + admin), files, comments, history.
import React, { useCallback, useEffect, useState } from "react";
import api, { errMsg, fmtDT, showValue, delayText, toLocalInput, fromLocalInput } from "./api";
import { Btn, Modal, Spinner, StatusBadge, PriorityBadge, FieldInput, Label, inputCls, ErrorBox, useDialog, cx } from "./ui";

const whoText = (step, seats) => {
  const parts = [];
  if (step.seat_id) parts.push(`Seat ${seats.find((s) => s.id === step.seat_id)?.code || step.seat_id}`);
  const a = step.assign || {};
  if (a.departments?.length) parts.push(`Dept: ${a.departments.join(", ")}`);
  if (a.designations?.length) parts.push(`Desig: ${a.designations.join(", ")}`);
  if (a.employees?.length) parts.push(`${a.employees.length} employee(s)`);
  return parts.join(" · ") || "—";
};
const tatText = (t = {}) => ({
  hours: `${t.value} working hour(s)`, days: `${t.value} working day(s)`, before_field: `${t.value} day(s) before ${t.field}`, after_field: `${t.value} working day(s) after ${t.field}`,
}[t.type] || "No TAT");

function StepActions({ rs, step, onDone, flash, isAdmin, employees }) {
  const [values, setValues] = useState(rs.values || {});
  const [remarks, setRemarks] = useState(rs.remarks || "");
  const [outcome, setOutcome] = useState(rs.outcome || (step.status_options || ["Done"])[0]);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [ask, dialog] = useDialog();
  const active = ["pending", "in_progress", "rejected"].includes(rs.status);

  const run = async (name, fn, okText) => {
    setBusy(name); setErr("");
    try { await fn(); flash(okText); onDone(); } catch (e) { setErr(errMsg(e)); } finally { setBusy(""); }
  };
  const body = { values, remarks, outcome };

  const extension = async () => {
    const when = await ask({ title: "Request more time", message: "New date/time you need:", input: "datetime-local", required: true });
    if (!when) return;
    const reason = await ask({ title: "Reason", input: "textarea", required: true, placeholder: "Why is more time needed?" });
    if (!reason) return;
    run("ext", () => api.post(`/steps/${rs.id}/extension`, { requested_at: fromLocalInput(when), reason }), "Extension request sent to admins");
  };

  return (
    <div className="mt-3 space-y-3 rounded-md border border-blue-200 bg-blue-50/40 p-3">
      {dialog}
      {rs.can_act && active && (
        <>
          {rs.status === "rejected" && <div className="rounded bg-red-50 px-3 py-2 text-sm text-red-700"><b>Sent back:</b> {rs.rejection_reason}</div>}
          {step.how && <div className="text-sm text-gray-700"><b>HOW:</b> {step.how}</div>}
          {(step.fields || []).length > 0 && (
            <div className="grid gap-3 sm:grid-cols-2">
              {step.fields.map((f) => (
                <div key={f.key}>
                  <Label required={f.required && !f.formula}>{f.label}{f.formula && " (calculated)"}</Label>
                  {f.formula ? <div className="rounded border bg-gray-50 px-3 py-2 text-sm">{showValue(f, values[f.key]) || "—"}</div>
                    : <FieldInput field={f} value={values[f.key]} employees={employees} onChange={(v) => setValues({ ...values, [f.key]: v })} />}
                  {f.help && <p className="mt-0.5 text-xs text-gray-500">{f.help}</p>}
                </div>
              ))}
            </div>
          )}
          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <Label>Status</Label>
              <select className={inputCls} value={outcome} onChange={(e) => setOutcome(e.target.value)}>
                {(step.status_options || ["Done"]).map((o) => <option key={o}>{o}</option>)}
              </select>
              {step.jumps?.[outcome] && <p className="mt-0.5 text-xs text-amber-700">“{outcome}” skips ahead to STEP-{step.jumps[outcome]}</p>}
            </div>
            <div className="sm:col-span-2">
              <Label>Remarks</Label>
              <input className={inputCls} value={remarks} onChange={(e) => setRemarks(e.target.value)} placeholder="Optional note for this step" />
            </div>
          </div>
          <ErrorBox>{err}</ErrorBox>
          <div className="flex flex-wrap gap-2">
            {rs.status === "pending" && <Btn kind="secondary" busy={busy === "start"} onClick={() => run("start", () => api.post(`/steps/${rs.id}/start`), "Marked in progress")}>Start</Btn>}
            <Btn kind="secondary" busy={busy === "draft"} onClick={() => run("draft", () => api.post(`/steps/${rs.id}/draft`, { values, remarks }), "Draft saved")}>Save draft</Btn>
            <Btn kind="success" busy={busy === "done"} onClick={() => run("done", () => api.post(`/steps/${rs.id}/complete`, body), step.requires_approval ? "Submitted for approval" : "Step completed")}>
              {step.requires_approval ? (rs.status === "rejected" ? "Resubmit for approval" : "Submit for approval") : "Mark complete"}
            </Btn>
            <Btn kind="ghost" busy={busy === "ext"} onClick={extension}>Request extension</Btn>
          </div>
        </>
      )}
      {rs.can_approve && (
        <div className="space-y-2">
          <div className="text-sm text-gray-700">Submitted by <b>{rs.done_by_name}</b> on {fmtDT(rs.submitted_at)} · status <b>{rs.outcome}</b></div>
          <ErrorBox>{err}</ErrorBox>
          <div className="flex flex-wrap gap-2">
            <Btn kind="success" busy={busy === "approve"} onClick={async () => {
              const remarksA = await ask({ title: "Approve step", message: "Optional remarks:", input: "textarea" });
              if (remarksA === null) return;
              run("approve", () => api.post(`/steps/${rs.id}/approve`, { remarks: remarksA }), "Approved");
            }}>Approve</Btn>
            <Btn kind="danger" busy={busy === "reject"} onClick={async () => {
              const reason = await ask({ title: "Send back (reject)", message: "Tell the doer what to fix:", input: "textarea", required: true, danger: true, ok: "Reject" });
              if (!reason) return;
              run("reject", () => api.post(`/steps/${rs.id}/reject`, { reason }), "Sent back to the doer");
            }}>Reject</Btn>
          </div>
        </div>
      )}
      {isAdmin && (
        <div className="flex flex-wrap items-center gap-2 border-t border-blue-100 pt-2 text-sm">
          <span className="text-xs font-semibold uppercase text-gray-500">Admin:</span>
          {rs.status !== "done" && rs.status !== "skipped" && (
            <>
              <select className="rounded border px-2 py-1 text-sm" value={rs.assigned_to || ""} onChange={(e) => {
                const emp = e.target.value;
                run("reassign", () => api.post(`/steps/${rs.id}/reassign`, { employee_id: emp, reason: "Reassigned by admin" }), emp ? "Reassigned" : "Back to the step's seat / assignment");
              }}>
                <option value="">Assigned by seat / rule</option>
                {employees.map((e) => <option key={e.employee_id} value={e.employee_id}>{e.name}{e.department ? ` (${e.department})` : ""}</option>)}
              </select>
              <Btn kind="secondary" size="sm" busy={busy === "plan"} onClick={async () => {
                const v = await ask({ title: "Change planned date", input: "datetime-local", defaultValue: toLocalInput(rs.planned_at), required: true });
                if (!v) return;
                const reason = await ask({ title: "Reason (optional)", input: true });
                run("plan", () => api.post(`/steps/${rs.id}/planned`, { planned_at: fromLocalInput(v), reason: reason || "" }), "Planned date changed");
              }}>Change planned</Btn>
              <Btn kind="secondary" size="sm" busy={busy === "skip"} onClick={async () => {
                const reason = await ask({ title: "Skip this step?", message: "The row moves on to the next step.", input: true, placeholder: "Reason", ok: "Skip", danger: true });
                if (reason === null) return;
                run("skip", () => api.post(`/steps/${rs.id}/skip`, { reason }), "Step skipped");
              }}>Skip</Btn>
            </>
          )}
          {["done", "skipped", "submitted", "rejected"].includes(rs.status) && (
            <Btn kind="secondary" size="sm" busy={busy === "reopen"} onClick={async () => {
              const reason = await ask({ title: "Re-open this step?", message: "This step becomes pending again and every later step goes back to waiting.", input: true, placeholder: "Reason", ok: "Re-open", danger: true });
              if (reason === null) return;
              run("reopen", () => api.post(`/steps/${rs.id}/reopen`, { reason }), "Step re-opened");
            }}>Re-open</Btn>
          )}
          {!rs.can_act && !rs.can_approve && <ErrorBox>{err}</ErrorBox>}
        </div>
      )}
    </div>
  );
}

export default function RecordView({ recordId, focusStepId, onClose, onChanged, isAdmin }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState("");
  const [employees, setEmployees] = useState([]);
  const [tab, setTab] = useState("steps");
  const [comment, setComment] = useState("");
  const [internal, setInternal] = useState(false);
  const [editing, setEditing] = useState(null);
  const [busy, setBusy] = useState("");
  const [flashMsg, setFlashMsg] = useState("");
  const [ask, dialog] = useDialog();
  const flash = (t) => { setFlashMsg(t); setTimeout(() => setFlashMsg(""), 3000); };

  const load = useCallback(async () => {
    try {
      const r = await api.get(`/records/${recordId}`);
      setD(r.data); setErr("");
    } catch (e) { setErr(errMsg(e)); }
  }, [recordId]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { api.get("/lookups").then((r) => setEmployees(r.data.employees || [])).catch(() => {}); }, []);
  const changed = () => { load(); onChanged?.(); };

  const upload = async (file, rsId) => {
    if (!file) return;
    const fd = new FormData();
    fd.append("file", file);
    if (rsId) fd.append("record_step_id", rsId);
    setBusy("upload");
    try { await api.post(`/records/${recordId}/attachments`, fd, { headers: { "Content-Type": "multipart/form-data" } }); flash("File uploaded"); changed(); }
    catch (e) { setErr(errMsg(e)); } finally { setBusy(""); }
  };

  const rec = d?.record;
  const def = d?.definition;
  const stepDef = (id) => def?.steps.find((s) => s.id === id) || {};

  return (
    <Modal open onClose={onClose} full title={rec ? `${rec.uid} · ${d.fms.name}` : "Loading…"}>
      {dialog}
      {flashMsg && <div className="mb-3 rounded bg-green-50 px-3 py-2 text-sm text-green-800">{flashMsg}</div>}
      {err && <ErrorBox>{err}</ErrorBox>}
      {!d && !err && <Spinner />}
      {rec && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <StatusBadge status={rec.status} /> <PriorityBadge p={rec.priority} />
            {rec.deleted && <span className="rounded bg-red-100 px-2 py-0.5 text-xs text-red-700">Deleted</span>}
            {isAdmin && (
              <span className="ml-auto flex gap-2">
                {rec.deleted
                  ? <Btn size="sm" kind="secondary" busy={busy === "del"} onClick={async () => {
                    setBusy("del"); setErr("");
                    try { await api.post(`/definitions/${d.fms.id}/records/bulk`, { ids: [rec.id], action: "restore" }); flash("Row restored"); changed(); } catch (e) { setErr(errMsg(e)); } finally { setBusy(""); }
                  }}>Restore row</Btn>
                  : <Btn size="sm" kind="danger" busy={busy === "del"} onClick={async () => {
                    if (!(await ask({ title: `Delete row ${rec.uid}?`, message: "The row moves to Deleted rows and can be restored from there.", danger: true, ok: "Delete" }))) return;
                    setBusy("del"); setErr("");
                    try { await api.delete(`/records/${rec.id}`); onChanged?.(); onClose(); } catch (e) { setErr(errMsg(e)); } finally { setBusy(""); }
                  }}>Delete row</Btn>}
              </span>
            )}
            <span className="text-gray-500">Created {fmtDT(rec.created_at)} by {rec.created_by_name || "—"}</span>
            {rec.completed_at && <span className="text-gray-500">· Completed {fmtDT(rec.completed_at)}</span>}
          </div>
          {d.fms.instructions && <div className="whitespace-pre-line rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900"><b>Instructions:</b> {d.fms.instructions}</div>}

          {/* row data */}
          <div className="rounded-lg border">
            <div className="flex items-center justify-between border-b bg-gray-50 px-3 py-2">
              <span className="font-semibold text-gray-800">Row details</span>
              {isAdmin && !editing && <Btn kind="link" onClick={() => setEditing({ ...rec.data })}>Edit</Btn>}
              {isAdmin && editing && (
                <div className="flex gap-2">
                  <Btn kind="secondary" size="sm" onClick={() => setEditing(null)}>Cancel</Btn>
                  <Btn size="sm" busy={busy === "save"} onClick={async () => {
                    setBusy("save"); setErr("");
                    try { await api.put(`/records/${recordId}`, { data: editing }); setEditing(null); flash("Row updated"); changed(); } catch (e) { setErr(errMsg(e)); } finally { setBusy(""); }
                  }}>Save</Btn>
                </div>
              )}
            </div>
            <div className="grid gap-x-6 gap-y-2 p-3 sm:grid-cols-2 lg:grid-cols-3">
              {def.fields.map((f) => (
                <div key={f.key} className="min-w-0">
                  <div className="text-xs font-medium text-gray-500">{f.label}{f.formula && <span className="ml-1 text-indigo-600" title={f.formula}>ƒ</span>}{editing && f.required && !f.formula && <span className="text-red-600"> *</span>}</div>
                  {editing && !f.formula ? <FieldInput field={f} value={editing[f.key]} employees={employees} onChange={(v) => setEditing({ ...editing, [f.key]: v })} />
                    : <div className="break-words text-sm text-gray-900">{showValue(f, rec.data[f.key]) || <span className="text-gray-300">—</span>}</div>}
                </div>
              ))}
              {!def.fields.length && <div className="text-sm text-gray-500">This FMS has no columns.</div>}
            </div>
          </div>

          <div className="flex gap-1 border-b">
            {[["steps", `Steps (${rec.steps.length})`], ["files", `Files (${d.attachments.length})`], ["comments", `Comments (${d.comments.length})`], ["history", "History"]].map(([k, l]) => (
              <button type="button" key={k} onClick={() => setTab(k)} className={cx("-mb-px border-b-2 px-3 py-2 text-sm font-medium", tab === k ? "border-blue-600 text-blue-700" : "border-transparent text-gray-600")}>{l}</button>
            ))}
          </div>

          {tab === "steps" && (
            <ol className="space-y-3">
              {rec.steps.map((rs) => {
                const st = stepDef(rs.step_id);
                const overdue = ["pending", "in_progress", "rejected"].includes(rs.status) && rs.planned_at && new Date(rs.planned_at) < new Date();
                const showActions = rs.can_act && ["pending", "in_progress", "rejected"].includes(rs.status);
                return (
                  <li key={rs.id} className={cx("rounded-lg border p-3", rs.id === focusStepId && "ring-2 ring-blue-400", rs.status === "waiting" && "opacity-60")}>
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <div className="font-semibold text-gray-900">{st.code} · {st.name}</div>
                        <div className="text-xs text-gray-500">WHO: {whoText(st, def.seats)}{rs.assigned_to && <> · <b>assigned to {employees.find((e) => e.employee_id === rs.assigned_to)?.name || rs.assigned_to}</b></>} · WHEN: {tatText(st.tat)}{st.requires_approval && " · needs approval"}{st.condition && ` · only if ${st.condition.field} ${st.condition.op} ${st.condition.value ?? ""}`}</div>
                      </div>
                      <StatusBadge status={rs.status} overdue={overdue} />
                    </div>
                    <div className="mt-2 grid gap-2 text-sm sm:grid-cols-4">
                      <div><span className="text-gray-500">Planned:</span> {fmtDT(rs.planned_at) || "—"}</div>
                      <div><span className="text-gray-500">Actual:</span> {fmtDT(rs.actual_at) || "—"}</div>
                      <div><span className="text-gray-500">Delay:</span> {delayText(rs.delay_minutes) || (rs.status === "done" ? "On time" : "—")}</div>
                      <div><span className="text-gray-500">Done by:</span> {rs.done_by_name || "—"}{rs.approved_by && ` · approved by ${rs.approved_by}`}</div>
                    </div>
                    {(rs.outcome || Object.keys(rs.values || {}).length > 0 || rs.remarks) && !showActions && (
                      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm">
                        {rs.outcome && <span><span className="text-gray-500">Status:</span> {rs.outcome}</span>}
                        {(st.fields || []).map((f) => rs.values?.[f.key] !== undefined && rs.values[f.key] !== "" && <span key={f.key}><span className="text-gray-500">{f.label}:</span> {showValue(f, rs.values[f.key])}</span>)}
                        {rs.remarks && <span><span className="text-gray-500">Remarks:</span> {rs.remarks}</span>}
                      </div>
                    )}
                    {(showActions || rs.can_approve || isAdmin) && rs.status !== "waiting" && (
                      <StepActions rs={rs} step={st} isAdmin={isAdmin} employees={employees} flash={flash} onDone={changed} />
                    )}
                  </li>
                );
              })}
              {!rec.steps.length && <div className="text-sm text-gray-500">This FMS has no steps.</div>}
            </ol>
          )}

          {tab === "files" && (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <label className="inline-flex cursor-pointer items-center gap-2 rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700">
                  {busy === "upload" ? "Uploading…" : "Upload file"}
                  <input type="file" className="hidden" accept="image/*,.pdf,.xlsx,.xls,.csv,.doc,.docx,.ppt,.pptx,.txt"
                    onChange={(e) => { const f = e.target.files[0]; e.target.value = ""; const active = rec.steps.find((s) => s.can_act && ["pending", "in_progress", "rejected"].includes(s.status)); upload(f, active?.id); }} />
                </label>
                <span className="text-xs text-gray-500">Images, PDF, Excel, Word, PowerPoint, CSV · max 5 MB</span>
              </div>
              {d.attachments.length === 0 && <div className="text-sm text-gray-500">No files yet.</div>}
              <ul className="divide-y rounded border">
                {d.attachments.map((a) => (
                  <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                    <a href={a.url} target="_blank" rel="noreferrer" className="font-medium text-blue-700 hover:underline">{a.name || "file"}</a>
                    <span className="text-gray-500">{a.uploaded_by_name} · {fmtDT(a.created_at)}{a.record_step_id ? ` · ${stepDef(rec.steps.find((s) => s.id === a.record_step_id)?.step_id).code || "step"}` : ""}</span>
                    <Btn kind="link" onClick={async () => {
                      if (!(await ask({ title: "Remove file?", message: a.name, danger: true, ok: "Remove" }))) return;
                      try { await api.delete(`/attachments/${a.id}`); changed(); } catch (e) { setErr(errMsg(e)); }
                    }}>Remove</Btn>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {tab === "comments" && (
            <div className="space-y-3">
              <ul className="space-y-2">
                {d.comments.map((cm) => (
                  <li key={cm.id} className={cx("rounded-md border px-3 py-2 text-sm", cm.internal ? "border-amber-200 bg-amber-50" : "bg-gray-50")}>
                    <div className="flex justify-between gap-2 text-xs text-gray-500">
                      <span><b className="text-gray-700">{cm.author_name}</b> · {fmtDT(cm.created_at)}{cm.internal ? " · internal note" : ""}</span>
                      <Btn kind="link" onClick={async () => { try { await api.delete(`/comments/${cm.id}`); changed(); } catch (e) { setErr(errMsg(e)); } }}>Delete</Btn>
                    </div>
                    <div className="mt-1 whitespace-pre-line text-gray-900">{cm.body}</div>
                  </li>
                ))}
                {!d.comments.length && <li className="text-sm text-gray-500">No comments yet.</li>}
              </ul>
              <textarea rows={2} className={inputCls} placeholder="Write a comment…" value={comment} onChange={(e) => setComment(e.target.value)} />
              <div className="flex items-center justify-between">
                {isAdmin ? <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={internal} onChange={(e) => setInternal(e.target.checked)} /> Internal note (admins only)</label> : <span />}
                <Btn disabled={!comment.trim()} busy={busy === "comment"} onClick={async () => {
                  setBusy("comment");
                  try { await api.post(`/records/${recordId}/comments`, { body: comment, internal }); setComment(""); changed(); } catch (e) { setErr(errMsg(e)); } finally { setBusy(""); }
                }}>Add comment</Btn>
              </div>
            </div>
          )}

          {tab === "history" && (
            <ul className="divide-y rounded border text-sm">
              {d.history.map((h) => (
                <li key={h.id} className="flex flex-wrap gap-x-3 px-3 py-2">
                  <span className="w-36 shrink-0 text-gray-500">{fmtDT(h.at)}</span>
                  <span className="font-medium capitalize text-gray-800">{h.action.replace(/_/g, " ")}</span>
                  {h.record_step_id && <span className="text-gray-500">{stepDef(rec.steps.find((s) => s.id === h.record_step_id)?.step_id).name}</span>}
                  <span className="text-gray-600">by {h.actor_name}</span>
                  {h.remarks && <span className="italic text-gray-700">“{h.remarks}”</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Modal>
  );
}

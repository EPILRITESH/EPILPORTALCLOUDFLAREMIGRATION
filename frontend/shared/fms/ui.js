// Small UI kit for the FMS screens (Tailwind). Shared by Admin and Doer portals.
import React, { useEffect, useRef, useState } from "react";
import { STATUS_LABEL, STATUS_STYLE, PRIORITY_STYLE, toLocalInput, fromLocalInput } from "./api";

export const cx = (...a) => a.filter(Boolean).join(" ");

export function Btn({ kind = "primary", size = "md", className = "", busy, children, ...rest }) {
  const k = {
    primary: "bg-blue-600 text-white hover:bg-blue-700 disabled:bg-blue-300",
    secondary: "bg-white text-gray-800 border border-gray-300 hover:bg-gray-50 disabled:text-gray-400",
    danger: "bg-red-600 text-white hover:bg-red-700 disabled:bg-red-300",
    success: "bg-green-600 text-white hover:bg-green-700 disabled:bg-green-300",
    ghost: "text-gray-700 hover:bg-gray-100 disabled:text-gray-300",
    link: "text-blue-600 hover:underline disabled:text-gray-400",
  }[kind];
  const s = { sm: "px-2.5 py-1 text-xs", md: "px-3.5 py-2 text-sm", lg: "px-5 py-2.5 text-base" }[size];
  return (
    <button type="button" disabled={busy || rest.disabled} className={cx("inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition disabled:cursor-not-allowed", kind !== "link" && s, k, className)} {...rest}>
      {busy && <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />}
      {children}
    </button>
  );
}

export const Badge = ({ className = "", children }) => <span className={cx("inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium", className)}>{children}</span>;
export const StatusBadge = ({ status, overdue }) => (
  <Badge className={overdue ? "bg-red-600 text-white" : STATUS_STYLE[status] || "bg-gray-100 text-gray-700"}>{overdue ? "Overdue" : STATUS_LABEL[status] || status}</Badge>
);
export const PriorityBadge = ({ p }) => <Badge className={PRIORITY_STYLE[p] || PRIORITY_STYLE.Medium}>{p || "Medium"}</Badge>;

export const Spinner = ({ text = "Loading…" }) => (
  <div className="flex items-center justify-center gap-2 py-10 text-gray-500">
    <span className="h-5 w-5 animate-spin rounded-full border-2 border-blue-600 border-t-transparent" /> {text}
  </div>
);
export const Empty = ({ children }) => <div className="rounded-lg border border-dashed border-gray-300 bg-white py-10 text-center text-gray-500">{children}</div>;
export const ErrorBox = ({ children }) => (children ? <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{children}</div> : null);

export function Modal({ open, onClose, title, children, footer, wide, full }) {
  useEffect(() => {
    if (!open) return undefined;
    const h = (e) => e.key === "Escape" && onClose?.();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[200] flex items-start justify-center overflow-y-auto bg-black/40 p-2 sm:p-6" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className={cx("w-full rounded-lg bg-white shadow-xl", full ? "max-w-[96vw]" : wide ? "max-w-4xl" : "max-w-lg")}>
        <div className="flex items-center justify-between border-b px-4 py-3">
          <h3 className="text-lg font-semibold text-gray-900">{title}</h3>
          <button type="button" className="rounded p-1 text-2xl leading-none text-gray-400 hover:text-gray-700" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="max-h-[78vh] overflow-y-auto px-4 py-4">{children}</div>
        {footer && <div className="flex flex-wrap justify-end gap-2 border-t px-4 py-3">{footer}</div>}
      </div>
    </div>
  );
}

/** Promise-based confirm/prompt dialog. */
export function useDialog() {
  const [state, setState] = useState(null);
  const resolver = useRef(null);
  const ask = (opts) => new Promise((res) => { resolver.current = res; setState({ value: opts.defaultValue || "", ...opts }); });
  const close = (v) => { resolver.current?.(v); setState(null); };
  const node = state ? (
    <Modal open title={state.title || "Confirm"} onClose={() => close(null)}
      footer={<><Btn kind="secondary" onClick={() => close(null)}>Cancel</Btn>
        <Btn kind={state.danger ? "danger" : "primary"} disabled={state.input && state.required && !String(state.value).trim()} onClick={() => close(state.input ? state.value : true)}>{state.ok || "OK"}</Btn></>}>
      {state.message && <p className="mb-3 whitespace-pre-line text-sm text-gray-700">{state.message}</p>}
      {state.input && (state.input === "textarea"
        ? <textarea autoFocus rows={3} className={inputCls} value={state.value} placeholder={state.placeholder} onChange={(e) => setState({ ...state, value: e.target.value })} />
        : <input autoFocus type={state.input === true ? "text" : state.input} className={inputCls} value={state.value} placeholder={state.placeholder} onChange={(e) => setState({ ...state, value: e.target.value })} />)}
    </Modal>
  ) : null;
  return [ask, node];
}

export const inputCls = "w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:bg-gray-100";
export const Label = ({ children, required }) => <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-gray-600">{children}{required && <span className="text-red-600"> *</span>}</label>;

/** Tag-style multi select from a list (with free typing when allowCustom). */
export function MultiPick({ options = [], value = [], onChange, placeholder = "Add…", allowCustom }) {
  const [q, setQ] = useState("");
  const opts = options.map((o) => (typeof o === "string" ? { value: o, label: o } : o));
  const avail = opts.filter((o) => !value.includes(o.value) && o.label.toLowerCase().includes(q.toLowerCase())).slice(0, 50);
  const add = (v) => { if (v && !value.includes(v)) onChange([...value, v]); setQ(""); };
  return (
    <div className="rounded-md border border-gray-300 p-1.5">
      <div className="flex flex-wrap gap-1">
        {value.map((v) => (
          <span key={v} className="inline-flex items-center gap-1 rounded bg-blue-50 px-2 py-0.5 text-xs text-blue-800">
            {opts.find((o) => o.value === v)?.label || v}
            <button type="button" className="text-blue-500 hover:text-red-600" onClick={() => onChange(value.filter((x) => x !== v))}>×</button>
          </span>
        ))}
        <div className="relative min-w-[8rem] flex-1">
          <input className="w-full px-1 py-0.5 text-sm outline-none" value={q} placeholder={placeholder} onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); if (avail[0]) add(avail[0].value); else if (allowCustom && q.trim()) add(q.trim()); } }} />
          {q && (avail.length > 0 || allowCustom) && (
            <div className="absolute z-30 mt-1 max-h-56 w-64 overflow-y-auto rounded-md border bg-white shadow-lg">
              {avail.map((o) => <button type="button" key={o.value} className="block w-full px-3 py-1.5 text-left text-sm hover:bg-blue-50" onClick={() => add(o.value)}>{o.label}</button>)}
              {allowCustom && q.trim() && !opts.some((o) => o.value === q.trim()) && <button type="button" className="block w-full px-3 py-1.5 text-left text-sm text-blue-700 hover:bg-blue-50" onClick={() => add(q.trim())}>Add “{q.trim()}”</button>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** Input for one dynamic FMS field. value is the stored value; onChange(newValue). */
export function FieldInput({ field, value, onChange, employees = [], disabled }) {
  const v = value ?? "";
  const opts = field.options || [];
  switch (field.type) {
    case "textarea": return <textarea rows={3} className={inputCls} value={v} disabled={disabled} onChange={(e) => onChange(e.target.value)} />;
    case "number": return <input type="number" step="any" className={inputCls} value={v} disabled={disabled} onChange={(e) => onChange(e.target.value)} />;
    case "date": return <input type="date" className={inputCls} value={/^\d{4}-\d{2}-\d{2}/.test(v) ? String(v).slice(0, 10) : ""} disabled={disabled} onChange={(e) => onChange(e.target.value)} />;
    case "datetime": return <input type="datetime-local" className={inputCls} value={toLocalInput(v)} disabled={disabled} onChange={(e) => onChange(fromLocalInput(e.target.value))} />;
    case "select": return (
      <select className={inputCls} value={v} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
        <option value="">— Select —</option>
        {opts.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    );
    case "multiselect": return <MultiPick options={opts} value={Array.isArray(v) ? v : v ? String(v).split(",").map((x) => x.trim()) : []} onChange={onChange} placeholder="Choose…" />;
    case "checkbox": return <input type="checkbox" className="h-5 w-5" checked={v === true || v === "true"} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />;
    case "email": return <input type="email" className={inputCls} value={v} disabled={disabled} onChange={(e) => onChange(e.target.value)} />;
    case "phone": return <input type="tel" className={inputCls} value={v} disabled={disabled} onChange={(e) => onChange(e.target.value)} />;
    case "url": return <input type="url" placeholder="https://" className={inputCls} value={v} disabled={disabled} onChange={(e) => onChange(e.target.value)} />;
    case "employee": return (
      <select className={inputCls} value={v} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
        <option value="">— Select employee —</option>
        {employees.map((e) => <option key={e.employee_id} value={e.name}>{e.name}</option>)}
      </select>
    );
    default: return <input className={inputCls} value={v} disabled={disabled} onChange={(e) => onChange(e.target.value)} />;
  }
}

export function Pager({ page, limit, total, onPage, onLimit }) {
  const pages = Math.max(1, Math.ceil(total / limit));
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm text-gray-600">
      <span>{total ? `${(page - 1) * limit + 1}–${Math.min(total, page * limit)} of ${total}` : "0 results"}</span>
      <div className="flex items-center gap-1">
        {onLimit && (
          <select className="mr-2 rounded border px-1 py-1" value={limit} onChange={(e) => onLimit(Number(e.target.value))}>
            {[10, 25, 50, 100, 200].map((n) => <option key={n} value={n}>{n} / page</option>)}
          </select>
        )}
        <Btn kind="secondary" size="sm" disabled={page <= 1} onClick={() => onPage(1)}>«</Btn>
        <Btn kind="secondary" size="sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>‹ Prev</Btn>
        <span className="px-2">Page {page} / {pages}</span>
        <Btn kind="secondary" size="sm" disabled={page >= pages} onClick={() => onPage(page + 1)}>Next ›</Btn>
        <Btn kind="secondary" size="sm" disabled={page >= pages} onClick={() => onPage(pages)}>»</Btn>
      </div>
    </div>
  );
}

export const Tabs = ({ tabs, value, onChange }) => (
  <div className="flex flex-wrap gap-1 border-b border-gray-200">
    {tabs.map((t) => (
      <button type="button" key={t.value} onClick={() => onChange(t.value)}
        className={cx("-mb-px border-b-2 px-3 py-2 text-sm font-medium", value === t.value ? "border-blue-600 text-blue-700" : "border-transparent text-gray-600 hover:text-gray-900")}>
        {t.label}{t.count !== undefined && <span className={cx("ml-1.5 rounded-full px-1.5 text-xs", value === t.value ? "bg-blue-100" : "bg-gray-100")}>{t.count}</span>}
      </button>
    ))}
  </div>
);

export const Stat = ({ label, value, tone = "gray", onClick, active }) => {
  const t = { gray: "text-gray-900", red: "text-red-600", amber: "text-amber-600", green: "text-green-600", blue: "text-blue-600", purple: "text-purple-600" }[tone];
  return (
    <button type="button" disabled={!onClick} onClick={onClick} className={cx("rounded-lg border bg-white p-3 text-left shadow-sm", onClick && "hover:border-blue-400", active && "ring-2 ring-blue-500")}>
      <div className="text-xs font-medium uppercase tracking-wide text-gray-500">{label}</div>
      <div className={cx("mt-1 text-2xl font-bold", t)}>{value ?? "—"}</div>
    </button>
  );
};

/** Toast-free inline flash message. */
export function useFlash() {
  const [msg, setMsg] = useState(null);
  useEffect(() => { if (!msg) return undefined; const t = setTimeout(() => setMsg(null), msg.kind === "error" ? 8000 : 3500); return () => clearTimeout(t); }, [msg]);
  const node = msg ? (
    <div className={cx("fixed bottom-4 right-4 z-[300] max-w-md rounded-md px-4 py-3 text-sm text-white shadow-lg", msg.kind === "error" ? "bg-red-600" : "bg-green-600")} onClick={() => setMsg(null)}>{msg.text}</div>
  ) : null;
  return [(text, kind = "ok") => setMsg({ text, kind }), node];
}

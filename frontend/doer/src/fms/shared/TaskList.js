// A list / kanban of step tasks (doer "My tasks", approvals). items come from /my/tasks or /my/approvals.
import React from "react";
import { fmtDT, delayText } from "./api";
import { StatusBadge, PriorityBadge, cx } from "./ui";

export function TaskCard({ t, onOpen }) {
  return (
    <button type="button" onClick={() => onOpen(t)} className={cx("block w-full rounded-lg border bg-white p-3 text-left shadow-sm hover:border-blue-400", t.overdue && "border-red-300")}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-xs text-gray-500">{t.fms.code} · {t.fms.name}</div>
          <div className="font-semibold text-gray-900">{t.step.code}: {t.step.name}</div>
        </div>
        <StatusBadge status={t.status} overdue={t.overdue} />
      </div>
      <div className="mt-1 text-sm font-medium text-blue-700">{t.uid}</div>
      {t.summary.length > 0 && <div className="mt-1 space-y-0.5 text-xs text-gray-600">{t.summary.map((s) => s.value !== "" && <div key={s.label} className="truncate"><span className="text-gray-400">{s.label}:</span> {Array.isArray(s.value) ? s.value.join(", ") : String(s.value).includes("T") && !isNaN(Date.parse(s.value)) ? fmtDT(s.value) : String(s.value)}</div>)}</div>}
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-gray-500">
        <PriorityBadge p={t.priority} />
        {t.planned_at && <span className={t.overdue ? "font-semibold text-red-600" : ""}>Due {fmtDT(t.planned_at)}</span>}
        {t.actual_at && <span>Done {fmtDT(t.actual_at)}{t.delay_minutes ? ` (+${delayText(t.delay_minutes)})` : ""}</span>}
        {t.status === "submitted" && t.done_by_name && <span>by {t.done_by_name}</span>}
      </div>
      {t.status === "rejected" && t.rejection_reason && <div className="mt-1 rounded bg-red-50 px-2 py-1 text-xs text-red-700">Sent back: {t.rejection_reason}</div>}
    </button>
  );
}

export default function TaskList({ items, view = "list", onOpen }) {
  if (view === "kanban") {
    const cols = [["pending", "To do"], ["in_progress", "In progress"], ["rejected", "Sent back"], ["submitted", "Awaiting approval"]];
    return (
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {cols.map(([k, label]) => {
          const list = items.filter((t) => t.status === k);
          return (
            <div key={k} className="rounded-lg bg-gray-200/60 p-2">
              <div className="mb-2 flex items-center justify-between px-1 text-sm font-semibold text-gray-700">{label}<span className="rounded-full bg-white px-2 text-xs">{list.length}</span></div>
              <div className="space-y-2">{list.map((t) => <TaskCard key={t.id} t={t} onOpen={onOpen} />)}</div>
            </div>
          );
        })}
      </div>
    );
  }
  return <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">{items.map((t) => <TaskCard key={t.id} t={t} onOpen={onOpen} />)}</div>;
}

// FMS notification bell: unread count (polled), dropdown list, mark read, open the related row.
import React, { useCallback, useEffect, useRef, useState } from "react";
import api, { fmtDT } from "./api";
import { cx } from "./ui";
import RecordView from "./RecordView";

const ICON = { assigned: "📋", approval: "✅", approved: "👍", rejected: "↩️", reminder: "⏰", overdue: "⚠️", escalation: "🚨", comment: "💬", extension: "📅" };

export default function NotificationBell({ isAdmin }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState([]);
  const [unread, setUnread] = useState(0);
  const [view, setView] = useState(null);
  const box = useRef(null);

  const load = useCallback(async () => {
    try { const r = await api.get("/notifications", { params: { limit: 30 } }); setItems(r.data.items); setUnread(r.data.unread); } catch { /* offline */ }
  }, []);
  useEffect(() => { load(); const t = setInterval(load, 60000); return () => clearInterval(t); }, [load]);
  useEffect(() => {
    const h = (e) => { if (box.current && !box.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);

  const read = async (ids, all) => { await api.post("/notifications/read", all ? { all: true } : { ids }).catch(() => {}); load(); };

  return (
    <div className="relative" ref={box}>
      <button type="button" className="relative rounded-full p-2 text-xl hover:bg-gray-100" onClick={() => { setOpen(!open); if (!open) load(); }} aria-label="Notifications">
        🔔{unread > 0 && <span className="absolute -right-0.5 -top-0.5 rounded-full bg-red-600 px-1.5 text-xs font-bold text-white">{unread > 99 ? "99+" : unread}</span>}
      </button>
      {open && (
        <div className="absolute right-0 z-[150] mt-2 w-80 max-w-[92vw] rounded-lg border bg-white shadow-xl">
          <div className="flex items-center justify-between border-b px-3 py-2">
            <span className="font-semibold">Notifications</span>
            {unread > 0 && <button type="button" className="text-xs text-blue-700 hover:underline" onClick={() => read(null, true)}>Mark all read</button>}
          </div>
          <ul className="max-h-96 divide-y overflow-y-auto">
            {items.map((n) => (
              <li key={n.id}>
                <button type="button" className={cx("block w-full px-3 py-2 text-left text-sm hover:bg-gray-50", !n.read_at && "bg-blue-50/60")}
                  onClick={() => { if (!n.read_at) read([n.id]); if (n.record_id) { setView({ id: n.record_id, step: n.record_step_id }); setOpen(false); } }}>
                  <div className="font-medium text-gray-900">{ICON[n.kind] || "•"} {n.title}</div>
                  {n.body && <div className="text-gray-600">{n.body}</div>}
                  <div className="text-xs text-gray-400">{fmtDT(n.created_at)}</div>
                </button>
              </li>
            ))}
            {!items.length && <li className="px-3 py-6 text-center text-sm text-gray-500">No notifications</li>}
          </ul>
        </div>
      )}
      {view && <RecordView recordId={view.id} focusStepId={view.step} isAdmin={isAdmin} onClose={() => setView(null)} onChanged={load} />}
    </div>
  );
}

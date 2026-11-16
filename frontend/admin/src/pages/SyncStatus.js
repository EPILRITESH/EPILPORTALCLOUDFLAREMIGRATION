import React, { useCallback, useEffect, useState } from "react";
import axios from "../api/axios";

// Backup & Sync: live view of the two-way sync between the portal database (Cloudflare D1)
// and the Google Sheets backup, with a "Sync Now" button.

const PUSH_LABEL = {
  Employee: "Employees", Admin: "Admins", AdditionalFeature: "Additional features", DelegationMaster: "Delegations",
  Master: "Checklist tasks", Consolidated: "Checklist completions", MasterTasks: "Checklist templates",
  HelpTicketsMaster: "Help tickets", SupportTicketsMaster: "Support tickets", WorkList: "Worklist",
  MasterTemplateData: "Training templates", AQData: "Training questions", EmployeeTrainingData: "Training records",
};

function ago(iso) {
  if (!iso) return "never";
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(iso).toLocaleString();
}

function pullSummary(r) {
  if (!r) return "—";
  if (r.error) return r.error;
  if (r.skipped) return r.skipped;
  if (r.unchanged) return "No changes in sheet";
  const parts = [];
  if (r.inserted) parts.push(`${r.inserted} new`);
  if (r.updated) parts.push(`${r.updated} updated`);
  if (r.templatesChanged) parts.push(`${r.templatesChanged} templates updated`);
  if (r.completionsApplied) parts.push(`${r.completionsApplied} completions`);
  if (r.skippedPending) parts.push(`${r.skippedPending} kept portal version`);
  return parts.length ? parts.join(", ") : "Checked — already in sync";
}

const Pill = ({ on, children }) => (
  <span className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-sm font-medium ${on ? "bg-green-100 text-green-800" : "bg-gray-200 text-gray-600"}`}>
    <span className={`h-2 w-2 rounded-full ${on ? "bg-green-500" : "bg-gray-400"}`} />
    {children}: {on ? "ON" : "OFF"}
  </span>
);

export default function SyncStatus() {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [lastRun, setLastRun] = useState(null);
  const [, tick] = useState(0);

  const load = useCallback(async () => {
    try {
      const res = await axios.get("/sheets-sync/status");
      setStatus(res.data);
      setError("");
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 15000);
    const c = setInterval(() => tick((x) => x + 1), 5000); // refresh "x min ago"
    return () => { clearInterval(t); clearInterval(c); };
  }, [load]);

  const syncNow = async () => {
    setSyncing(true);
    setError("");
    try {
      const res = await axios.post("/sheets-sync/sync-now");
      setLastRun(res.data);
      setStatus(res.data.status);
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    } finally {
      setSyncing(false);
    }
  };

  const sheets = status?.sheets || [];
  const pull = sheets.find((s) => s.sheet === "Pull from Sheets");
  const em = sheets.find((s) => s.sheet === "EM pull");
  const push = sheets.filter((s) => PUSH_LABEL[s.sheet]);
  const pending = (status?.pending || []).reduce((n, p) => n + p.pending, 0);
  const lastPush = push.map((s) => s.at).sort().pop();
  const pushErrors = push.filter((s) => !s.ok);
  const pullErrors = pull ? Object.entries(pull).filter(([, v]) => v && typeof v === "object" && v.error) : [];
  const syncOn = status?.enabled && status?.googleConfigured;
  const healthy = syncOn && !pushErrors.length && !pullErrors.length && pending < 50;

  return (
    <div className="max-w-6xl mx-auto space-y-5">
      {/* header */}
      <div className="bg-white rounded-xl shadow p-5 flex flex-col md:flex-row md:items-center gap-4 justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-800">Backup &amp; Sync</h1>
          <p className="text-gray-500 text-sm mt-1">
            Portal database ⇄ Google Sheets. Runs automatically every minute; portal changes are sent within seconds.
          </p>
          <div className="flex flex-wrap gap-2 mt-3">
            <Pill on={status?.enabled}>Portal → Sheets</Pill>
            <Pill on={status?.pullEnabled}>Sheets → Portal</Pill>
          </div>
        </div>
        <div className="flex gap-2">
          <button onClick={load} className="px-4 py-2 rounded-lg border border-gray-300 hover:bg-gray-50 text-gray-700">Refresh</button>
          <button
            onClick={syncNow}
            disabled={syncing}
            className="px-5 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white font-semibold flex items-center gap-2"
          >
            {syncing && <span className="animate-spin h-4 w-4 border-2 border-white border-t-transparent rounded-full" />}
            {syncing ? "Syncing…" : "Sync Now"}
          </button>
        </div>
      </div>

      {error && <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg p-3 text-sm">{error}</div>}

      {lastRun && (
        <div className="bg-blue-50 border border-blue-200 text-blue-900 rounded-lg p-3 text-sm">
          Sync finished in {(lastRun.ms / 1000).toFixed(1)}s —{" "}
          Sheets → Portal: {Object.values(lastRun.pull || {}).reduce((n, r) => n + (r?.inserted || 0) + (r?.updated || 0) + (r?.templatesChanged || 0) + (r?.completionsApplied || 0), 0)} changes ·{" "}
          Portal → Sheets: {lastRun.push?.processed ?? 0} changes{lastRun.push?.failed ? `, ${lastRun.push.failed} failed` : ""}
        </div>
      )}

      {/* summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card title="Overall" value={!status ? "…" : !syncOn ? "Sync is OFF" : healthy ? "Healthy" : "Needs attention"}
          tone={!status ? "gray" : healthy ? "green" : "red"} sub={status && !status.googleConfigured ? "Google credentials not configured" : ""} />
        <Card title="Waiting to send to Sheets" value={status ? pending : "…"} tone={pending ? "amber" : "green"} sub={pending ? "sent within a minute" : "all sent"} />
        <Card title="Last sent to Sheets" value={ago(lastPush)} tone="gray" />
        <Card title="Last read from Sheets" value={ago(pull?.at)} tone={pull?.ok === false ? "red" : "gray"} sub={pull?.ms ? `took ${(pull.ms / 1000).toFixed(1)}s` : ""} />
      </div>

      {/* per sheet */}
      <div className="bg-white rounded-xl shadow overflow-hidden">
        <div className="px-5 py-3 border-b font-semibold text-gray-700">Per sheet</div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-600">
              <tr>
                <th className="text-left px-4 py-2">Data</th>
                <th className="text-left px-4 py-2">Portal → Sheets (last)</th>
                <th className="text-left px-4 py-2">Sheets → Portal (last check)</th>
                <th className="text-left px-4 py-2">Status</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {Object.keys(PUSH_LABEL).map((tab) => {
                const p = push.find((s) => s.sheet === tab);
                const r = pull?.[tab] || (tab === "Consolidated" ? pull?.Consolidated : null);
                const bad = (p && !p.ok) || r?.error;
                const link = status?.links?.[tab];
                return (
                  <tr key={tab} className="border-t">
                    <td className="px-4 py-2">
                      <div className="font-medium text-gray-800">{PUSH_LABEL[tab]}</div>
                      <div className="text-xs text-gray-400">{tab}</div>
                    </td>
                    <td className="px-4 py-2 text-gray-700">
                      {p ? <>{ago(p.at)}{p.ok ? ` · ${p.written || 0} written${p.cleared ? `, ${p.cleared} cleared` : ""}` : ""}</> : <span className="text-gray-400">no changes yet</span>}
                    </td>
                    <td className="px-4 py-2 text-gray-700">{r ? pullSummary(r) : <span className="text-gray-400">—</span>}</td>
                    <td className="px-4 py-2">
                      {bad ? (
                        <span className="text-red-600" title={p?.error || r?.error}>Error: {(p?.error || r?.error || "").slice(0, 80)}</span>
                      ) : (
                        <span className="text-green-700">OK</span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-right">
                      {link && <a href={link} target="_blank" rel="noreferrer" className="text-blue-600 hover:underline">Open sheet</a>}
                    </td>
                  </tr>
                );
              })}
              <tr className="border-t">
                <td className="px-4 py-2"><div className="font-medium text-gray-800">EM report</div><div className="text-xs text-gray-400">read from Sheets every 10 min</div></td>
                <td className="px-4 py-2 text-gray-400">—</td>
                <td className="px-4 py-2 text-gray-700">{em ? `${ago(em.at)} · ${em.rows} rows` : "—"}</td>
                <td className="px-4 py-2">{em && !em.ok ? <span className="text-red-600">Error</span> : <span className="text-green-700">OK</span>}</td>
                <td className="px-4 py-2 text-right">{status?.links?.["EM report"] && <a href={status.links["EM report"]} target="_blank" rel="noreferrer" className="text-blue-600 hover:underline">Open sheet</a>}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div className="bg-white rounded-xl shadow p-5 text-sm text-gray-600 space-y-1">
        <div className="font-semibold text-gray-700 mb-1">How it works</div>
        <div>• Any add / edit / delete in the portal is saved in the database and sent to Google Sheets within seconds.</div>
        <div>• Edits made directly in Google Sheets (or the old portal) are read into the portal every minute.</div>
        <div>• If the same record changed in both places at once, the portal's change wins.</div>
        <div>• Rows deleted in a sheet are not deleted from the portal. Passwords are never read from sheets.</div>
      </div>
    </div>
  );
}

function Card({ title, value, sub, tone }) {
  const tones = { green: "text-green-700", red: "text-red-600", amber: "text-amber-600", gray: "text-gray-800" };
  return (
    <div className="bg-white rounded-xl shadow p-4">
      <div className="text-xs uppercase tracking-wide text-gray-500">{title}</div>
      <div className={`text-xl font-bold mt-1 ${tones[tone] || tones.gray}`}>{value}</div>
      {sub && <div className="text-xs text-gray-400 mt-0.5">{sub}</div>}
    </div>
  );
}

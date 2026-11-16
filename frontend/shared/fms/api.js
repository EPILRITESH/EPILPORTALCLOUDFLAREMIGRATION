// FMS API client + formatting helpers, shared by the Admin and Doer portals.
// Edit here in frontend/shared/fms, then run `node frontend/sync-shared.mjs` to copy into both apps.
// Own axios instance: only 401 logs out (the portal's default client also logs out on 403, which FMS uses for "not your step").
import axios from "axios";

const api = axios.create({ baseURL: `${process.env.REACT_APP_BASE_URL}/api/fms` });
api.interceptors.request.use((config) => {
  const token = localStorage.getItem("token");
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});
api.interceptors.response.use(
  (r) => r,
  (error) => {
    if (error.response?.status === 401) {
      localStorage.removeItem("token");
      localStorage.removeItem("user");
      window.location.replace("/login");
    }
    return Promise.reject(error);
  },
);
export default api;

export const errMsg = (e) => {
  const d = e?.response?.data;
  if (d?.errors?.length > 1) return d.errors.slice(0, 5).join(" · ");
  return d?.error || d?.message || e?.message || "Something went wrong";
};

const IST = 330 * 60000;
const p2 = (n) => String(n).padStart(2, "0");
/** ISO → "DD/MM/YYYY HH:mm" in IST */
export function fmtDT(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  const l = new Date(d.getTime() + IST);
  return `${p2(l.getUTCDate())}/${p2(l.getUTCMonth() + 1)}/${l.getUTCFullYear()} ${p2(l.getUTCHours())}:${p2(l.getUTCMinutes())}`;
}
/** "YYYY-MM-DD" or ISO → "DD/MM/YYYY" */
export function fmtD(v) {
  if (!v) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return `${v.slice(8, 10)}/${v.slice(5, 7)}/${v.slice(0, 4)}`;
  return fmtDT(v).slice(0, 10);
}
/** ISO → value for <input type="datetime-local"> in IST */
export function toLocalInput(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return new Date(d.getTime() + IST).toISOString().slice(0, 16);
}
/** datetime-local (IST wall time) → ISO */
export const fromLocalInput = (v) => (v ? new Date(`${v}:00+05:30`).toISOString() : "");

/** Display a field value by type */
export function showValue(field, v) {
  if (v === undefined || v === null || v === "") return "";
  if (Array.isArray(v)) return v.join(", ");
  if (field?.type === "datetime") return /T/.test(String(v)) ? fmtDT(v) : String(v);
  if (field?.type === "date") return fmtD(String(v));
  if (field?.type === "checkbox") return v === true || v === "true" ? "Yes" : "No";
  return String(v);
}

export const delayText = (min) => {
  if (!min) return "";
  if (min < 60) return `${min}m`;
  if (min < 1440) return `${Math.round(min / 6) / 10}h`;
  return `${Math.round(min / 144) / 10}d`;
};

export const STATUS_STYLE = {
  waiting: "bg-gray-100 text-gray-500", pending: "bg-amber-100 text-amber-800", in_progress: "bg-blue-100 text-blue-800",
  submitted: "bg-purple-100 text-purple-800", rejected: "bg-red-100 text-red-800", done: "bg-green-100 text-green-800",
  skipped: "bg-gray-100 text-gray-400 line-through", open: "bg-blue-100 text-blue-800", completed: "bg-green-100 text-green-800",
  cancelled: "bg-gray-200 text-gray-600", active: "bg-green-100 text-green-800", inactive: "bg-gray-200 text-gray-600",
};
export const STATUS_LABEL = {
  waiting: "Waiting", pending: "Pending", in_progress: "In progress", submitted: "Awaiting approval", rejected: "Sent back",
  done: "Done", skipped: "Skipped", open: "Open", completed: "Completed", cancelled: "Cancelled",
};
export const PRIORITY_STYLE = { Low: "bg-gray-100 text-gray-700", Medium: "bg-sky-100 text-sky-800", High: "bg-orange-100 text-orange-800", Critical: "bg-red-600 text-white" };

/** Read a sheet with SheetJS into a grid of plain values (dates → IST wall-clock "YYYY-MM-DD HH:mm:ss"). */
export function sheetToGrid(XLSX, ws) {
  const raw = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: "" });
  const wall = (d) => {
    const t = new Date(Math.round(d.getTime() / 1000) * 1000);
    return `${t.getFullYear()}-${p2(t.getMonth() + 1)}-${p2(t.getDate())} ${p2(t.getHours())}:${p2(t.getMinutes())}:${p2(t.getSeconds())}`;
  };
  return raw.map((r) => r.map((c) => (c instanceof Date ? wall(c) : c)));
}

/** Read the first sheet (or a named one) of an uploaded file. */
export async function readWorkbook(XLSX, file) {
  const buf = await file.arrayBuffer();
  return XLSX.read(buf, { type: "array", cellDates: true });
}

/** Download rows as CSV / Excel / PDF. columns: [{key,label}] */
export async function downloadTable({ format, name, columns, rows, XLSX }) {
  const safe = String(name || "export").replace(/[^\w\- ]+/g, "").trim() || "export";
  if (format === "csv" || format === "xlsx") {
    const aoa = [columns.map((c) => c.label), ...rows.map((r) => columns.map((c) => r[c.key] ?? ""))];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Data");
    XLSX.writeFile(wb, `${safe}.${format}`, { bookType: format });
    return;
  }
  const { jsPDF } = await import("jspdf");
  const autoTable = (await import("jspdf-autotable")).default;
  const doc = new jsPDF({ orientation: "landscape", unit: "pt", format: columns.length > 14 ? "a3" : "a4" });
  doc.setFontSize(12);
  doc.text(`${name} - ${fmtDT(new Date().toISOString())}`, 30, 26);
  autoTable(doc, {
    startY: 36, head: [columns.map((c) => c.label)], body: rows.map((r) => columns.map((c) => String(r[c.key] ?? ""))),
    styles: { fontSize: columns.length > 20 ? 5 : 7, cellPadding: 2 }, headStyles: { fillColor: [31, 41, 55] }, margin: { left: 20, right: 20 },
  });
  doc.save(`${safe}.pdf`);
}

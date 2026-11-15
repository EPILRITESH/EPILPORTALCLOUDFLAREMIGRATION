// Exact port of EPILBACKEND/utils/dateHelpers.js plus the training helpers.
// Workers run in UTC (as the old Render deployment did), so "local" == UTC.

const pad = (n: number) => String(n).padStart(2, "0");

/** DD/MM/YYYY HH:mm:ss in IST (UTC+5:30). */
export function formatDateIST(date: Date = new Date()): string {
  const utc = date.getTime() + date.getTimezoneOffset() * 60000;
  const ist = new Date(utc + 5.5 * 60 * 60 * 1000);
  return `${pad(ist.getDate())}/${pad(ist.getMonth() + 1)}/${ist.getFullYear()} ${pad(ist.getHours())}:${pad(ist.getMinutes())}:${pad(ist.getSeconds())}`;
}

/** DD/MM/YYYY from anything Date can parse; "" when invalid. */
export function formatDateDMY(date: unknown): string {
  if (!date) return "";
  const d = new Date(date as string);
  if (isNaN(d.getTime())) return "";
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
}

/** Parse DD/MM/YYYY[ HH:mm:ss] → Date (date part only), or null. */
export function parseDDMMYYYY(str: unknown): Date | null {
  if (!str || typeof str !== "string") return null;
  const parts = str.split(" ")[0].split("/");
  if (parts.length !== 3) return null;
  const [d, m, y] = parts;
  const year = y.length === 2 ? 2000 + Number(y) : Number(y);
  const date = new Date(year, Number(m) - 1, Number(d));
  return isNaN(date.getTime()) ? null : date;
}

/** DD/MM/YYYY → YYYY-MM-DD, or null. */
export function parseDateFromDMY(dateStr: unknown): string | null {
  if (!dateStr || typeof dateStr !== "string") return null;
  const parts = dateStr.split("/");
  return parts.length === 3 ? `${parts[2]}-${parts[1]}-${parts[0]}` : null;
}

/**
 * Monday-based week N of a month (week "all" or empty = whole month).
 * Empty week is treated as "all" (the doer dashboard sends week="" for "all").
 */
export function getWeekRange(month: string | number, week: string | number, year = new Date().getFullYear()) {
  const m = Number(month) - 1;
  let weekStart: Date, weekEnd: Date;
  if (week === "all" || week === "" || week === undefined || week === null) {
    weekStart = new Date(year, m, 1);
    weekStart.setHours(0, 0, 0, 0);
    weekEnd = new Date(year, m + 1, 0);
    weekEnd.setHours(23, 59, 59, 999);
  } else {
    const firstDay = new Date(year, m, 1);
    const dow = firstDay.getDay();
    const diff = dow === 0 ? -6 : 1 - dow;
    const firstMonday = new Date(year, m, 1 + diff);
    weekStart = new Date(firstMonday);
    weekStart.setDate(firstMonday.getDate() + (Number(week) - 1) * 7);
    weekStart.setHours(0, 0, 0, 0);
    weekEnd = new Date(weekStart);
    weekEnd.setDate(weekStart.getDate() + 6);
    weekEnd.setHours(23, 59, 59, 999);
  }
  return { weekStart, weekEnd };
}

/** YYYY-MM-DD (what toLocaleDateString('en-CA') produced). */
export function isoDay(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Training: DD/MM/YYYY HH:mm:ss (server local). */
export function nowStamp(): string {
  const d = new Date();
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Training: DD/MM/YYYY (server local). */
export function dateDMY(): string {
  const d = new Date();
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

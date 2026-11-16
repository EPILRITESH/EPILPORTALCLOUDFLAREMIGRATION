// Working-time calendar for FMS planning — the code version of the sheet formulas
//   WORKDAY.INTL(base, n, "0000001") + time-of-day      → addWorkingDays
//   "E+2HOURS" inside the 10:00–19:00 window            → addWorkingHours
//   "T-1" (one day before a date column)                → beforeDate
// All instants are stored as ISO (UTC); the calendar itself runs in IST (UTC+05:30).

export interface FmsCalendar {
  workStart: string;   // "10:00"
  workEnd: string;     // "19:00"
  weeklyOff: number[]; // 0 = Sunday … 6 = Saturday
}

export const DEFAULT_CALENDAR: FmsCalendar = { workStart: "10:00", workEnd: "19:00", weeklyOff: [0] };
const IST = 330; // minutes
const DAY = 86_400_000;

const toLocal = (d: Date) => new Date(d.getTime() + IST * 60_000);   // read with getUTC*
const fromLocal = (l: Date) => new Date(l.getTime() - IST * 60_000);
const hm = (s: string, fallback: number) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || "").trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : fallback;
};
export const ymd = (l: Date) => `${l.getUTCFullYear()}-${String(l.getUTCMonth() + 1).padStart(2, "0")}-${String(l.getUTCDate()).padStart(2, "0")}`;

export function normaliseCalendar(raw: unknown): FmsCalendar {
  const c = (raw && typeof raw === "object" ? raw : {}) as Partial<FmsCalendar>;
  const off = Array.isArray(c.weeklyOff) ? c.weeklyOff.map(Number).filter((n) => n >= 0 && n <= 6) : DEFAULT_CALENDAR.weeklyOff;
  const start = hm(c.workStart as string, 600), end = hm(c.workEnd as string, 1140);
  const ok = end > start;
  return {
    workStart: ok ? String(c.workStart) : DEFAULT_CALENDAR.workStart,
    workEnd: ok ? String(c.workEnd) : DEFAULT_CALENDAR.workEnd,
    weeklyOff: off.length >= 7 ? DEFAULT_CALENDAR.weeklyOff : off,
  };
}

function isWorkingDay(local: Date, cal: FmsCalendar, holidays: Set<string>) {
  return !cal.weeklyOff.includes(local.getUTCDay()) && !holidays.has(ymd(local));
}

/** n working days after `base`, same time of day (WORKDAY.INTL semantics: base day not counted). */
export function addWorkingDays(base: Date, n: number, cal: FmsCalendar, holidays: Set<string>): Date {
  let l = toLocal(base);
  let left = Math.max(0, Math.round(n));
  let guard = 0;
  while (left > 0 && guard++ < 3660) {
    l = new Date(l.getTime() + DAY);
    if (isWorkingDay(l, cal, holidays)) left--;
  }
  return fromLocal(l);
}

/** Add working hours inside the daily window, rolling over off-days and holidays. */
export function addWorkingHours(base: Date, hours: number, cal: FmsCalendar, holidays: Set<string>): Date {
  const start = hm(cal.workStart, 600), end = hm(cal.workEnd, 1140);
  let left = Math.max(0, Math.round(hours * 60));
  let l = toLocal(base);
  const minuteOf = (x: Date) => x.getUTCHours() * 60 + x.getUTCMinutes();
  const dayStart = (x: Date) => new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate()) + start * 60_000);
  const nextDayStart = (x: Date) => { let d = new Date(dayStart(x).getTime() + DAY); let g = 0; while (!isWorkingDay(d, cal, holidays) && g++ < 3660) d = new Date(d.getTime() + DAY); return d; };
  // align into a working window
  if (!isWorkingDay(l, cal, holidays) || minuteOf(l) >= end) l = nextDayStart(l);
  else if (minuteOf(l) < start) l = dayStart(l);
  let guard = 0;
  while (left > 0 && guard++ < 3660) {
    const room = end - minuteOf(l);
    if (left <= room) { l = new Date(l.getTime() + left * 60_000); left = 0; }
    else { left -= room; l = nextDayStart(l); }
  }
  return fromLocal(l);
}

/** `n` calendar days before a date (sheet "T-n"). */
export const beforeDate = (d: Date, n: number) => new Date(d.getTime() - Math.round(n) * DAY);

/**
 * Parse what users type or sheets export into an instant. Accepts ISO (with/without zone),
 * DD/MM/YYYY[ HH:mm[:ss]], YYYY-MM-DD[ HH:mm], and Excel/Sheets serial numbers. Zone-less values are IST.
 */
export function parseInstant(v: unknown): Date | null {
  if (v === null || v === undefined || v === "") return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  if (typeof v === "number" || /^\d+(\.\d+)?$/.test(String(v).trim())) {
    const n = Number(v);
    if (n > 20000 && n < 80000) return fromLocal(new Date(Math.round((n - 25569) * DAY))); // sheet serial (IST wall time)
    return null;
  }
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}T.*(Z|[+-]\d{2}:?\d{2})$/.test(s)) { const d = new Date(s); return isNaN(d.getTime()) ? null : d; }
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(s);
  if (m) return fromLocal(new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0))));
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})(?:[ ,]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(s);
  if (m) {
    const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    const d = fromLocal(new Date(Date.UTC(y, +m[2] - 1, +m[1], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0))));
    return isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/** Display an instant as IST "DD/MM/YYYY HH:mm" (exports, notifications). */
export function formatIST(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const l = toLocal(d);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(l.getUTCDate())}/${p(l.getUTCMonth() + 1)}/${l.getUTCFullYear()} ${p(l.getUTCHours())}:${p(l.getUTCMinutes())}`;
}

/** IST calendar date (YYYY-MM-DD) of an instant. */
export const istDay = (d: Date) => ymd(toLocal(d));

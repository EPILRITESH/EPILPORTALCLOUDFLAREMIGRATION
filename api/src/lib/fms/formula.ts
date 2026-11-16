// Excel-style formulas for FMS: calculated columns and plan rules.
//
//   IF({good_status} = "Available", ADDWORKDAYS({step1.actual}, 1), {delivery_date} - 1)
//   TEXT({date_time}, "MMM-YY")          {dealer_name} & " // " & {call_regarding}
//
// References are written in braces: a column / step-input key ({dealer_name}), a step value
// ({step2.actual}, {step2.planned}, {step2.status}, {step2.done_by}, {step2.remarks}) or a row value
// ({row.start}, {row.created}, {row.uid}). Dates are IST; date ± number adds calendar days and
// date − date gives days. Strings compare case-insensitively. No loops, no I/O: safe to run on the server.
import { addWorkingDays, addWorkingHours, isWorkingDay, parseInstant, toIST, fromIST, ymd, type FmsCalendar } from "./calendar";

export type V = string | number | boolean | Date | null;
export interface FormulaCtx { ref: (name: string) => V; cal: FmsCalendar; holidays: Set<string>; now?: Date }

type Node =
  | { t: "num"; v: number } | { t: "str"; v: string } | { t: "bool"; v: boolean } | { t: "ref"; name: string }
  | { t: "call"; fn: string; args: Node[] } | { t: "neg"; e: Node } | { t: "bin"; op: string; a: Node; b: Node };

export class FormulaError extends Error {}
const DAY = 86_400_000;

// ------------------------------------------------------------------ parsing
function tokenize(src: string) {
  const out: { k: string; v: string }[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] ?? ""))) { const m = /^\d*\.?\d+/.exec(src.slice(i))!; out.push({ k: "num", v: m[0] }); i += m[0].length; continue; }
    if (c === '"' || c === "'") {
      let j = i + 1, s = "";
      for (;;) {
        if (j >= src.length) throw new FormulaError("Text is missing its closing quote");
        if (src[j] === c) { if (src[j + 1] === c) { s += c; j += 2; continue; } break; }
        s += src[j++];
      }
      out.push({ k: "str", v: s }); i = j + 1; continue;
    }
    if (c === "{") { const j = src.indexOf("}", i); if (j < 0) throw new FormulaError("A { reference } is not closed"); out.push({ k: "ref", v: src.slice(i + 1, j).trim() }); i = j + 1; continue; }
    const two = src.slice(i, i + 2);
    if (["<=", ">=", "<>", "!=", "==", "&&", "||"].includes(two)) { out.push({ k: "op", v: two }); i += 2; continue; }
    if ("+-*/&=<>(),".includes(c)) { out.push({ k: "op", v: c }); i++; continue; }
    const m = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(src.slice(i));
    if (m) { out.push({ k: "id", v: m[0] }); i += m[0].length; continue; }
    throw new FormulaError(`Unexpected character "${c}"`);
  }
  return out;
}

export function parseFormula(src: string): Node {
  const s = String(src || "").trim().replace(/^=/, "");
  if (!s) throw new FormulaError("Formula is empty");
  if (s.length > 2000) throw new FormulaError("Formula is too long");
  const tk = tokenize(s);
  let p = 0;
  const peek = () => tk[p];
  const eat = (v?: string) => { const t = tk[p]; if (!t || (v !== undefined && t.v !== v)) throw new FormulaError(v ? `Expected "${v}"` : "Formula ends too early"); p++; return t; };
  const isOp = (...vs: string[]) => peek()?.k === "op" && vs.includes(peek()!.v);
  const orE = (): Node => { let a = andE(); while (isOp("||")) { eat(); a = { t: "call", fn: "OR", args: [a, andE()] }; } return a; };
  const andE = (): Node => { let a = cmp(); while (isOp("&&")) { eat(); a = { t: "call", fn: "AND", args: [a, cmp()] }; } return a; };
  const cmp = (): Node => { let a = cat(); while (isOp("=", "==", "<>", "!=", "<", ">", "<=", ">=")) { const op = eat().v; a = { t: "bin", op, a, b: cat() }; } return a; };
  const cat = (): Node => { let a = add(); while (isOp("&")) { eat(); a = { t: "bin", op: "&", a, b: add() }; } return a; };
  const add = (): Node => { let a = mul(); while (isOp("+", "-")) { const op = eat().v; a = { t: "bin", op, a, b: mul() }; } return a; };
  const mul = (): Node => { let a = unary(); while (isOp("*", "/")) { const op = eat().v; a = { t: "bin", op, a, b: unary() }; } return a; };
  const unary = (): Node => (isOp("-") ? (eat(), { t: "neg", e: unary() }) : isOp("+") ? (eat(), unary()) : primary());
  const primary = (): Node => {
    const t = eat();
    if (t.k === "num") return { t: "num", v: Number(t.v) };
    if (t.k === "str") return { t: "str", v: t.v };
    if (t.k === "ref") return { t: "ref", name: t.v };
    if (t.k === "op" && t.v === "(") { const e = orE(); eat(")"); return e; }
    if (t.k === "id") {
      const up = t.v.toUpperCase();
      if (isOp("(")) {
        eat("(");
        const args: Node[] = [];
        if (!isOp(")")) { args.push(orE()); while (isOp(",")) { eat(); args.push(orE()); } }
        eat(")");
        if (!FUNCS[up]) throw new FormulaError(`Unknown function ${t.v}()`);
        return { t: "call", fn: up, args };
      }
      if (up === "TRUE" || up === "FALSE") return { t: "bool", v: up === "TRUE" };
      return { t: "ref", name: t.v }; // bare key
    }
    throw new FormulaError(`Unexpected "${t.v}"`);
  };
  const node = orE();
  if (p < tk.length) throw new FormulaError(`Unexpected "${tk[p].v}"`);
  return node;
}

/** Every {reference} a formula uses (for validation). */
export function formulaRefs(src: string): string[] {
  const refs = new Set<string>();
  const walk = (n: Node) => {
    if (n.t === "ref") refs.add(n.name);
    else if (n.t === "call") n.args.forEach(walk);
    else if (n.t === "neg") walk(n.e);
    else if (n.t === "bin") { walk(n.a); walk(n.b); }
  };
  walk(parseFormula(src));
  return [...refs];
}

// ------------------------------------------------------------------ values
const isBlank = (v: V) => v === null || v === undefined || v === "" || (typeof v === "number" && isNaN(v));
export function toDate(v: V): Date | null {
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  if (isBlank(v) || typeof v === "boolean") return null;
  return parseInstant(v);
}
function toNum(v: V): number {
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v instanceof Date) return v.getTime() / DAY;
  if (isBlank(v)) return 0;
  const n = Number(String(v).replace(/,/g, "").trim());
  return isNaN(n) ? 0 : n;
}
const p2 = (n: number) => String(n).padStart(2, "0");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function formatDate(d: Date, fmt = "DD/MM/YYYY"): string {
  const l = toIST(d);
  const map: Record<string, string> = {
    YYYY: String(l.getUTCFullYear()), YY: String(l.getUTCFullYear()).slice(2), MMMM: ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][l.getUTCMonth()],
    MMM: MONTHS[l.getUTCMonth()], MM: p2(l.getUTCMonth() + 1), DD: p2(l.getUTCDate()), HH: p2(l.getUTCHours()), mm: p2(l.getUTCMinutes()), ss: p2(l.getUTCSeconds()),
    DDD: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][l.getUTCDay()],
  };
  return fmt.replace(/YYYY|YY|MMMM|MMM|MM|DDD|DD|HH|mm|ss/g, (k) => map[k]);
}
export function toStr(v: V): string {
  if (isBlank(v)) return "";
  if (v instanceof Date) { const l = toIST(v); return l.getUTCHours() || l.getUTCMinutes() ? formatDate(v, "DD/MM/YYYY HH:mm") : formatDate(v); }
  if (typeof v === "number") return String(Math.round(v * 1e6) / 1e6);
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  return String(v);
}
const truthy = (v: V) => (typeof v === "boolean" ? v : typeof v === "number" ? v !== 0 : v instanceof Date ? true : !isBlank(v) && !/^(false|no|0)$/i.test(String(v).trim()));
export function compareValues(a: V, b: V): number { return compare(a, b); }
function compare(a: V, b: V): number {
  const da = a instanceof Date ? a : null, db = b instanceof Date ? b : null;
  if (da || db) { const x = toDate(a), y = toDate(b); if (x && y) return x.getTime() - y.getTime(); if (!x && !y) return 0; return x ? 1 : -1; }
  if ((typeof a === "number" || typeof b === "number") && !isBlank(a) && !isBlank(b) && !isNaN(Number(a)) && !isNaN(Number(b))) return toNum(a) - toNum(b);
  const x = toStr(a).trim().toLowerCase(), y = toStr(b).trim().toLowerCase();
  return x < y ? -1 : x > y ? 1 : 0;
}

// ------------------------------------------------------------------ functions
type Fn = (args: V[], ctx: FormulaCtx) => V;
const istParts = (d: Date) => { const l = toIST(d); return { y: l.getUTCFullYear(), m: l.getUTCMonth() + 1, d: l.getUTCDate(), dow: l.getUTCDay() }; };
const dateOrNull = (v: V, f: (d: Date) => V) => { const d = toDate(v); return d ? f(d) : null; };

const FUNCS: Record<string, Fn> = {
  IF: () => null, // lazy, handled in eval
  IFS: () => null,
  AND: (a) => a.every(truthy), OR: (a) => a.some(truthy), NOT: ([x]) => !truthy(x),
  ISBLANK: ([x]) => isBlank(x) || (typeof x === "string" && !x.trim()), BLANK: () => "",
  COALESCE: (a) => a.find((x) => !isBlank(x)) ?? null,
  CONCAT: (a) => a.map(toStr).join(""), UPPER: ([x]) => toStr(x).toUpperCase(), LOWER: ([x]) => toStr(x).toLowerCase(), TRIM: ([x]) => toStr(x).trim(),
  LEFT: ([x, n]) => toStr(x).slice(0, toNum(n ?? 1)), RIGHT: ([x, n]) => { const s = toStr(x); return s.slice(Math.max(0, s.length - toNum(n ?? 1))); },
  MID: ([x, s, n]) => toStr(x).substr(toNum(s) - 1, toNum(n)), LEN: ([x]) => toStr(x).length,
  CONTAINS: ([x, y]) => toStr(x).toLowerCase().includes(toStr(y).toLowerCase()),
  SUBSTITUTE: ([x, a, b]) => toStr(x).split(toStr(a)).join(toStr(b)),
  NUMBER: ([x]) => toNum(x), ROUND: ([x, n]) => { const k = 10 ** toNum(n ?? 0); return Math.round(toNum(x) * k) / k; },
  ROUNDUP: ([x]) => Math.ceil(toNum(x)), ROUNDDOWN: ([x]) => Math.floor(toNum(x)), ABS: ([x]) => Math.abs(toNum(x)),
  MIN: (a) => { const ds = a.map(toDate); if (a.length && a.every((x) => x instanceof Date || isNaN(Number(x))) && ds.some(Boolean)) return new Date(Math.min(...ds.filter(Boolean).map((d) => d!.getTime()))); return Math.min(...a.filter((x) => !isBlank(x)).map(toNum)); },
  MAX: (a) => { const ds = a.map(toDate); if (a.length && a.every((x) => x instanceof Date || isNaN(Number(x))) && ds.some(Boolean)) return new Date(Math.max(...ds.filter(Boolean).map((d) => d!.getTime()))); return Math.max(...a.filter((x) => !isBlank(x)).map(toNum)); },
  SUM: (a) => a.reduce<number>((s, x) => s + toNum(x), 0),
  TODAY: (_a, c) => { const l = toIST(c.now || new Date()); return fromIST(new Date(Date.UTC(l.getUTCFullYear(), l.getUTCMonth(), l.getUTCDate()))); },
  NOW: (_a, c) => c.now || new Date(),
  DATE: ([y, m, d]) => fromIST(new Date(Date.UTC(toNum(y), toNum(m) - 1, toNum(d)))),
  DATEVALUE: ([x]) => toDate(x),
  ADDDAYS: ([d, n]) => dateOrNull(d, (x) => new Date(x.getTime() + toNum(n) * DAY)),
  ADDHOURS: ([d, n]) => dateOrNull(d, (x) => new Date(x.getTime() + toNum(n) * 3_600_000)),
  ADDMINUTES: ([d, n]) => dateOrNull(d, (x) => new Date(x.getTime() + toNum(n) * 60_000)),
  ADDMONTHS: ([d, n]) => dateOrNull(d, (x) => { const l = toIST(x); const t = new Date(l); t.setUTCMonth(t.getUTCMonth() + toNum(n)); return fromIST(t); }),
  ADDWORKDAYS: ([d, n], c) => dateOrNull(d, (x) => {
    const k = toNum(n);
    if (k >= 0) return addWorkingDays(x, k, c.cal, c.holidays);
    let l = toIST(x), left = -Math.round(k), g = 0;
    while (left > 0 && g++ < 3660) { l = new Date(l.getTime() - DAY); if (isWorkingDay(l, c.cal, c.holidays)) left--; }
    return fromIST(l);
  }),
  ADDWORKHOURS: ([d, n], c) => dateOrNull(d, (x) => addWorkingHours(x, toNum(n), c.cal, c.holidays)),
  NEXTWORKDAY: ([d], c) => dateOrNull(d, (x) => { let l = toIST(x), g = 0; while (!isWorkingDay(l, c.cal, c.holidays) && g++ < 3660) l = new Date(l.getTime() + DAY); return fromIST(l); }),
  ISWORKDAY: ([d], c) => dateOrNull(d, (x) => isWorkingDay(toIST(x), c.cal, c.holidays)),
  SETTIME: ([d, t]) => dateOrNull(d, (x) => { const m = /^(\d{1,2}):(\d{2})/.exec(toStr(t)); const l = toIST(x); return fromIST(new Date(Date.UTC(l.getUTCFullYear(), l.getUTCMonth(), l.getUTCDate(), m ? +m[1] : 0, m ? +m[2] : 0))); }),
  DAYS: ([a, b]) => { const x = toDate(a), y = toDate(b); return x && y ? Math.round(((x.getTime() - y.getTime()) / DAY) * 100) / 100 : null; },
  HOURS: ([a, b]) => { const x = toDate(a), y = toDate(b); return x && y ? Math.round(((x.getTime() - y.getTime()) / 3_600_000) * 100) / 100 : null; },
  WORKDAYS: ([a, b], c) => {
    let x = toDate(a), y = toDate(b);
    if (!x || !y) return null;
    let sign = 1;
    if (x > y) { [x, y] = [y, x]; sign = -1; }
    let l = toIST(x); const end = ymd(toIST(y)); let n = 0, g = 0;
    while (ymd(l) <= end && g++ < 3660) { if (isWorkingDay(l, c.cal, c.holidays)) n++; l = new Date(l.getTime() + DAY); }
    return n * sign;
  },
  TEXT: ([d, f]) => { const x = d instanceof Date ? d : typeof d === "string" && /\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4}/.test(d) ? toDate(d) : null; return x ? formatDate(x, toStr(f) || "DD/MM/YYYY") : toStr(d); },
  YEAR: ([d]) => dateOrNull(d, (x) => istParts(x).y), MONTH: ([d]) => dateOrNull(d, (x) => istParts(x).m), DAY: ([d]) => dateOrNull(d, (x) => istParts(x).d),
  WEEKDAY: ([d]) => dateOrNull(d, (x) => istParts(x).dow + 1), // 1 = Sunday (Excel)
  WEEKNUM: ([d]) => dateOrNull(d, (x) => { const { y } = istParts(x); const l = toIST(x); const jan1 = Date.UTC(y, 0, 1); const start = jan1 - new Date(jan1).getUTCDay() * DAY; return Math.floor((Date.UTC(y, l.getUTCMonth(), l.getUTCDate()) - start) / (7 * DAY)) + 1; }),
  STARTOFMONTH: ([d]) => dateOrNull(d, (x) => { const { y, m } = istParts(x); return fromIST(new Date(Date.UTC(y, m - 1, 1))); }),
  ENDOFMONTH: ([d]) => dateOrNull(d, (x) => { const { y, m } = istParts(x); return fromIST(new Date(Date.UTC(y, m, 0))); }),
};
export const FUNCTION_NAMES = Object.keys(FUNCS).sort();

// ------------------------------------------------------------------ evaluation
export function evaluate(node: Node | string, ctx: FormulaCtx): V {
  const n = typeof node === "string" ? parseFormula(node) : node;
  const ev = (x: Node): V => {
    switch (x.t) {
      case "num": return x.v;
      case "str": return x.v;
      case "bool": return x.v;
      case "ref": return ctx.ref(x.name);
      case "neg": return -toNum(ev(x.e));
      case "call": {
        if (x.fn === "IF") { if (x.args.length < 2) throw new FormulaError("IF needs a condition and a value"); return truthy(ev(x.args[0])) ? ev(x.args[1]) : x.args[2] ? ev(x.args[2]) : ""; }
        if (x.fn === "IFS") { for (let i = 0; i + 1 < x.args.length; i += 2) if (truthy(ev(x.args[i]))) return ev(x.args[i + 1]); return x.args.length % 2 ? ev(x.args[x.args.length - 1]) : ""; }
        return FUNCS[x.fn](x.args.map(ev), ctx);
      }
      case "bin": {
        const a = ev(x.a), b = ev(x.b);
        switch (x.op) {
          case "&": return toStr(a) + toStr(b);
          case "=": case "==": return compare(a, b) === 0;
          case "<>": case "!=": return compare(a, b) !== 0;
          case "<": return compare(a, b) < 0;
          case ">": return compare(a, b) > 0;
          case "<=": return compare(a, b) <= 0;
          case ">=": return compare(a, b) >= 0;
          case "+": case "-": {
            const da = a instanceof Date ? a : null, db = b instanceof Date ? b : null;
            if (da && db) return x.op === "-" ? Math.round(((da.getTime() - db.getTime()) / DAY) * 1e4) / 1e4 : null;
            if (da && !isBlank(b)) return new Date(da.getTime() + (x.op === "-" ? -1 : 1) * toNum(b) * DAY);
            if (db && x.op === "+" && !isBlank(a)) return new Date(db.getTime() + toNum(a) * DAY);
            if ((da && isBlank(b)) || (db && isBlank(a))) return da || db;
            return x.op === "+" ? toNum(a) + toNum(b) : toNum(a) - toNum(b);
          }
          case "*": return toNum(a) * toNum(b);
          case "/": { const d = toNum(b); return d === 0 ? null : toNum(a) / d; }
        }
      }
    }
    return null;
  };
  return ev(n);
}

/** Store a formula result in a column of the given type. */
export function castResult(v: V, type: string): unknown {
  if (isBlank(v)) return "";
  switch (type) {
    case "date": { const d = toDate(v); return d ? ymd(toIST(d)) : toStr(v); }
    case "datetime": { const d = toDate(v); return d ? d.toISOString() : toStr(v); }
    case "number": { const n = typeof v === "number" ? v : Number(toStr(v).replace(/,/g, "")); return isNaN(n) ? toStr(v) : Math.round(n * 1e4) / 1e4; }
    case "checkbox": return truthy(v);
    default: return v instanceof Date ? toStr(v) : typeof v === "boolean" ? (v ? "TRUE" : "FALSE") : toStr(v);
  }
}

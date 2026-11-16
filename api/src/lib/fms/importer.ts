// Auto-create an FMS from an uploaded sheet.
//
// Understands EPIL's FMS layout:
//   row  "STEP-1 … STEP-n"            → steps (a step's columns run until the next STEP label)
//   rows "WHAT / WHO / HOW / WHEN"    → step name, seat (doer), method, TAT
//   header row with Planned/Actual/Status/Time Delay per step (+ extra step inputs like "GOOD STATUS?")
//   columns before STEP-1 / after the last step → the FMS's own data columns
// and plain tables (just a header row) → an FMS with those columns (steps added in the builder).
import { str } from "../util";
import { parseInstant } from "./calendar";
import { slugKey, type DefinitionInput, type FieldInput, type StepInput } from "./definitions";
import type { RowInput } from "./records";

type Cell = string | number | boolean | null;
export interface Analysis {
  kind: "fms" | "table";
  definition: DefinitionInput & { steps: (StepInput & { seat_code?: string })[] };
  rows: RowInput[];
  totalRows: number;
  headerRow: number;
  warnings: string[];
}

const S = (c: Cell | undefined) => (c === null || c === undefined ? "" : String(c)).trim();
const isPlanned = (h: string) => /^planned\s*\d*$/i.test(h);
const isActual = (h: string) => /^actual\s*\d*$/i.test(h);
const isStatus = (h: string) => /^status\s*\d*$/i.test(h);
const isDelay = (h: string) => /^time\s*delay\s*\d*$/i.test(h);
const isStepLabel = (h: string) => /^step[\s\-_]*\d+$/i.test(h);
const cleanLabel = (h: string) => h.replace(/\s*\d+\s*$/, "").replace(/\s+/g, " ").trim() || h;

/** "1" → 1 day · "0.25" (=6/24) → 6 hours · "T-1" → 1 day before a date column · text → none */
function parseWhen(raw: string): StepInput["tat"] & { needsField?: boolean } {
  const s = raw.replace(/\s+/g, "").toUpperCase();
  if (!s || /^WHEN/.test(s)) return { type: "none" };
  const t = /^T-(\d+(?:\.\d+)?)$/.exec(s);
  if (t) return { type: "before_field", value: Number(t[1]), needsField: true };
  const h = /^(\d+(?:\.\d+)?)(H|HR|HRS|HOUR|HOURS)$/.exec(s);
  if (h) return { type: "hours", value: Number(h[1]) };
  const d = /^(\d+(?:\.\d+)?)(D|DAY|DAYS)?$/.exec(s);
  if (d) { const n = Number(d[1]); return n > 0 && n < 1 ? { type: "hours", value: Math.round(n * 24 * 100) / 100 } : { type: "days", value: n }; }
  return { type: "none" };
}

function inferType(values: Cell[]): { type: string; options?: string[] } {
  const v = values.map(S).filter(Boolean);
  if (!v.length) return { type: "text" };
  // whole-cell dates only ("29/12/25 to 04/01/26" or "30/12/2025//DEALER" are text)
  const iso = /^\d{4}-\d{2}-\d{2}(?:[ T](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?)?(?:Z)?$/;
  const dmy = /^\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}(?: (\d{1,2}):(\d{2})(?::\d{2})?)?$/;
  const dates = v.filter((x) => iso.test(x) || dmy.test(x));
  if (dates.length / v.length > 0.8) {
    const timed = dates.some((x) => { const m = iso.exec(x) || dmy.exec(x); return !!m && !!m[1] && !(m[1] === "00" && m[2] === "00"); });
    return { type: timed ? "datetime" : "date" };
  }
  if (v.every((x) => /^-?\d+(\.\d+)?$/.test(x))) return { type: "number" };
  const distinct = [...new Set(v.map((x) => x.trim()))];
  if (v.length >= 10 && distinct.length <= 8 && distinct.every((x) => x.length <= 40)) return { type: "select", options: distinct };
  if (v.some((x) => x.length > 120)) return { type: "textarea" };
  return { type: "text" };
}

export function analyzeGrid(grid: Cell[][], opts: { name?: string; maxPreview?: number } = {}): Analysis {
  const warnings: string[] = [];
  const rowsTop = grid.slice(0, 20);
  const headerRow = rowsTop.findIndex((r) => (r || []).some((c) => isPlanned(S(c))));
  const width = Math.max(0, ...grid.slice(0, 200).map((r) => (r || []).length));

  if (headerRow < 0) {
    // ---- plain table: first row with 2+ cells is the header
    const h = rowsTop.findIndex((r) => (r || []).filter((c) => S(c)).length >= 2);
    if (h < 0) return { kind: "table", definition: { name: opts.name || "Imported FMS", fields: [], steps: [] }, rows: [], totalRows: 0, headerRow: -1, warnings: ["No header row found"] };
    const header = (grid[h] || []).map(S);
    const dataRows = grid.slice(h + 1).filter((r) => (r || []).some((c) => S(c)));
    const fields: FieldInput[] = [];
    const colKey: [number, string][] = [];
    const used = new Set<string>();
    header.forEach((label, c) => {
      if (!label) return;
      let key = slugKey(label); let n = 2; while (used.has(key)) key = `${slugKey(label)}_${n++}`; used.add(key);
      fields.push({ key, label, ...inferType(dataRows.slice(0, 300).map((r) => r[c] ?? null)) });
      colKey.push([c, key]);
    });
    warnings.push("No STEP / Planned columns found — imported as a plain table. Add steps (WHAT/WHO/WHEN) in the builder.");
    const rows = dataRows.map((r) => ({ data: Object.fromEntries(colKey.map(([c, k]) => [k, r[c] ?? ""])) }));
    return { kind: "table", definition: { name: opts.name || "Imported FMS", fields, steps: [] }, rows, totalRows: rows.length, headerRow: h, warnings };
  }

  // ---- FMS layout
  const header = Array.from({ length: width }, (_, c) => S(grid[headerRow]?.[c]));
  const labelRowIdx = rowsTop.slice(0, headerRow).findIndex((r) => (r || []).some((c) => isStepLabel(S(c))));
  const metaRow = (name: string) => rowsTop.slice(0, headerRow).findIndex((r) => (r || []).slice(0, 3).some((c) => S(c).toUpperCase().startsWith(name)));
  const rWhat = metaRow("WHAT"), rWho = metaRow("WHO"), rHow = metaRow("HOW"), rWhen = metaRow("WHEN");

  // step start columns: STEP-n labels, else the first column of each Planned group
  let starts: number[] = labelRowIdx >= 0 ? header.map((_, c) => c).filter((c) => isStepLabel(S(grid[labelRowIdx]?.[c]))) : [];
  if (!starts.length) starts = header.map((h, c) => (isPlanned(h) ? c : -1)).filter((c) => c >= 0);
  const firstPlanned = header.findIndex(isPlanned);
  if (starts[0] > firstPlanned) starts = [firstPlanned, ...starts.slice(1)];
  // a step's own inputs may sit just before its Planned column under the step label (e.g. "GOOD STATUS?")
  const groups = starts.map((start, i) => {
    const nextStart = i + 1 < starts.length ? starts[i + 1] : width;
    let end = nextStart - 1;
    if (i === starts.length - 1) {
      const delay = header.findIndex((h, c) => c >= start && isDelay(h));
      const status = header.findIndex((h, c) => c >= start && isStatus(h));
      const actual = header.findIndex((h, c) => c >= start && isActual(h));
      end = Math.max(delay, status, actual, header.findIndex((h, c) => c >= start && isPlanned(h)));
    }
    return { start, end };
  });

  const dataRows = grid.slice(headerRow + 1).filter((r) => {
    const cells = (r || []).slice(0, starts[0]).map(S);
    return cells.some(Boolean);
  });
  const sample = dataRows.slice(0, 400);

  // data columns: before the first step and after the last step
  const fields: FieldInput[] = [];
  const used = new Set<string>();
  const colKey: [number, string][] = [];
  const addField = (c: number, label: string, into: FieldInput[], keyMap: [number, string][]) => {
    let key = slugKey(label); let n = 2; while (used.has(key)) key = `${slugKey(label)}_${n++}`; used.add(key);
    into.push({ key, label, ...inferType(dataRows.map((r) => r[c] ?? null)) });
    keyMap.push([c, key]);
  };
  header.forEach((h, c) => { if (h && (c < starts[0] || c > groups[groups.length - 1].end)) addField(c, h, fields, colKey); });

  // steps
  const meta = (row: number, c: number) => (row >= 0 ? S(grid[row]?.[c]) : "");
  const steps: (StepInput & { seat_code?: string })[] = [];
  const stepCols: { planned: number; actual: number; status: number; inputs: [number, string][] }[] = [];
  groups.forEach((g, i) => {
    const cols = header.map((h, c) => ({ h, c })).filter(({ c }) => c >= g.start && c <= g.end);
    const find = (fn: (h: string) => boolean) => cols.find(({ h }) => fn(h))?.c ?? -1;
    const planned = find(isPlanned), actual = find(isActual), status = find(isStatus);
    const delay = find(isDelay);
    const inputs: [number, string][] = [];
    const stepFields: FieldInput[] = [];
    for (const { h, c } of cols) {
      if (!h || [planned, actual, status, delay].includes(c)) continue;
      addField(c, cleanLabel(h), stepFields, inputs);
    }
    const who = meta(rWho, g.start) || "UNASSIGNED";
    const whenRaw = meta(rWhen, g.start);
    const tat = parseWhen(whenRaw);
    const name = meta(rWhat, g.start) || S(grid[labelRowIdx]?.[g.start]) || `Step ${i + 1}`;
    const how = meta(rHow, g.start);
    const statusValues = status >= 0 ? [...new Set(sample.map((r) => S(r[status])).filter(Boolean))].slice(0, 6) : [];
    if (tat.needsField) {
      const dateField = fields.find((f) => /deliver|promise|due|date/i.test(f.label) && (f.type === "date" || f.type === "datetime") && !/^(date & time|timestamp)$/i.test(f.label));
      if (dateField) tat.field = dateField.key;
      else warnings.push(`${name}: WHEN "${whenRaw}" is relative to a date column — choose it in the builder.`);
    }
    if (/^\s*if\b/i.test(how)) warnings.push(`${name}: HOW says "${how}" — set this as the step's condition in the builder.`);
    delete (tat as { needsField?: boolean }).needsField;
    steps.push({ name, code: S(grid[labelRowIdx]?.[g.start]) || `STEP-${i + 1}`, seat_code: who, how, tat, status_options: statusValues.length ? statusValues : ["Done"], fields: stepFields });
    stepCols.push({ planned, actual, status, inputs });
  });

  // start column: the first date-time column named like "Date & Time"/"Timestamp"
  const startField = fields.find((f) => f.type === "datetime" && /date\s*&\s*time/i.test(f.label)) || fields.find((f) => f.type === "datetime" || f.type === "date");
  // working hours from the top row (EPIL sheets keep 10 and 19 there)
  const top = (grid[0] || []).map((c) => Number(c)).filter((n) => Number.isInteger(n) && n >= 5 && n <= 23);
  const calendar = top.length >= 2 && top[1] > top[0] ? { workStart: `${String(top[0]).padStart(2, "0")}:00`, workEnd: `${String(top[1]).padStart(2, "0")}:00`, weeklyOff: [0] } : { workStart: "10:00", workEnd: "19:00", weeklyOff: [0] };
  // UID: the UID-like column that is actually filled in (sheets often keep an empty "Unique ID" too)
  const uidCol = colKey.filter(([c]) => /^(uid|unique\s*id)$/i.test(header[c]))
    .map(([c, k]) => ({ c, k, filled: sample.filter((r) => S(r[c])).length }))
    .sort((a, b) => b.filled - a.filled).map((x) => [x.c, x.k] as [number, string]).find(([c]) => sample.some((r) => S(r[c])));
  if (!uidCol) warnings.push("No UID column found — new UIDs will be generated.");

  const rows: RowInput[] = dataRows.map((r) => ({
    uid: uidCol ? S(r[uidCol[0]]) : undefined,
    data: Object.fromEntries(colKey.map(([c, k]) => [k, r[c] ?? ""])),
    steps: Object.fromEntries(stepCols.map((sc, i) => [i + 1, {
      planned: sc.planned >= 0 ? r[sc.planned] : "", actual: sc.actual >= 0 ? r[sc.actual] : "", status: sc.status >= 0 ? S(r[sc.status]) : "",
      values: Object.fromEntries(sc.inputs.map(([c, k]) => [k, r[c] ?? ""])),
    }])),
  }));
  const titleCell = rowsTop.slice(0, headerRow).flatMap((r) => (r || []).slice(1, 3).map(S)).find((x) => /fms/i.test(x));
  return {
    kind: "fms",
    definition: { name: titleCell || opts.name || "Imported FMS", fields, steps, calendar, start_field: startField?.key || "", frequency: "on_demand" },
    rows, totalRows: rows.length, headerRow, warnings,
  };
}

/** Light check that a value looks like a date the engine can read (preview helper). */
export const looksLikeDate = (v: unknown) => !!parseInstant(v);
export const cellText = (v: unknown) => str(v);

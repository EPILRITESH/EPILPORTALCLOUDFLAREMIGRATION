import { env, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashPassword } from "../src/lib/password";
import { backfillQueue, cellValue, pullEmSheet, runSheetsSync } from "../src/lib/sheetsSync";
import { runSheetsPull } from "../src/lib/sheetsPull";
import { app } from "../src/index";
import { _resetGoogleTokenCache } from "../src/lib/google";

// ---------------------------------------------------------------- fake Google Sheets
type Grid = { sheetId: number; rows: string[][]; rowCount: number };
const SS = "SPREADSHEET1";
let tabs: Map<string, Grid>;
let calls: string[];
const colIdx = (s: string) => [...s].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
function parse(a1: string) {
  const m = decodeURIComponent(a1).match(/^'((?:[^']|'')+)'!([A-Z]+)(\d+):([A-Z]+)(\d+)?$/);
  if (!m) throw new Error(`bad range ${a1}`);
  return { tab: m[1].replace(/''/g, "'"), c1: colIdx(m[2]), r1: +m[3], c2: colIdx(m[4]), r2: m[5] ? +m[5] : Infinity };
}
function grid(tab: string) { const g = tabs.get(tab); if (!g) throw Object.assign(new Error("no tab"), { status: 400 }); return g; }
function setCell(g: Grid, r: number, c: number, v: string) {
  if (r > g.rowCount) throw Object.assign(new Error(`exceeds grid limits ${r} > ${g.rowCount}`), { status: 400 });
  while (g.rows.length < r) g.rows.push([]);
  const row = g.rows[r - 1];
  while (row.length <= c) row.push("");
  row[c] = v;
}
async function fakeGoogle(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input));
  const method = init?.method || "GET";
  calls.push(`${method} ${url.pathname.split("/").pop()}`);
  try {
    if (url.host === "oauth2.googleapis.com") {
      const assertion = new URLSearchParams(String(init!.body)).get("assertion")!;
      expect(assertion.split(".")).toHaveLength(3);
      return Response.json({ access_token: "fake-token", expires_in: 3600 });
    }
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer fake-token");
    const path = url.pathname;
    if (method === "GET" && path.endsWith(`/${SS}`)) {
      return Response.json({ sheets: [...tabs].map(([title, g]) => ({ properties: { title, sheetId: g.sheetId, gridProperties: { rowCount: g.rowCount, columnCount: 26 } } })) });
    }
    if (path.endsWith("values:batchGet")) {
      return Response.json({ valueRanges: url.searchParams.getAll("ranges").map((r) => {
        const p = parse(r); const g = grid(p.tab);
        const values = g.rows.slice(p.r1 - 1, Math.min(p.r2, g.rows.length)).map((row) => {
          const v = row.slice(p.c1, p.c2 + 1).map((x) => (x.startsWith("=") ? "(computed)" : x));
          while (v.length && v[v.length - 1] === "") v.pop();
          return v;
        });
        while (values.length && !values[values.length - 1].length) values.pop();
        return { range: r, values };
      }) });
    }
    const body = JSON.parse(String(init?.body || "{}"));
    if (path.endsWith("values:batchUpdate")) {
      expect(body.valueInputOption).toBe("USER_ENTERED");
      for (const d of body.data) { const p = parse(d.range); d.values[0].forEach((v: unknown, i: number) => setCell(grid(p.tab), p.r1, p.c1 + i, String(v))); }
      return Response.json({});
    }
    if (path.endsWith("values:batchClear")) {
      for (const r of body.ranges) { const p = parse(r); for (let c = p.c1; c <= p.c2; c++) if (grid(p.tab).rows[p.r1 - 1]) setCell(grid(p.tab), p.r1, c, ""); }
      return Response.json({});
    }
    if (path.endsWith(`${SS}:batchUpdate`)) {
      const a = body.requests[0].appendDimension;
      [...tabs.values()].find((g) => g.sheetId === a.sheetId)!.rowCount += a.length;
      return Response.json({});
    }
    return new Response("unhandled", { status: 404 });
  } catch (e) {
    return new Response(String((e as Error).message), { status: (e as { status?: number }).status || 500 });
  }
}

let PEM = "";
async function cfg() {
  if (!PEM) {
    const kp = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
    const der = new Uint8Array((await crypto.subtle.exportKey("pkcs8", (kp as CryptoKeyPair).privateKey)) as ArrayBuffer);
    PEM = `-----BEGIN PRIVATE KEY-----\\n${btoa(String.fromCharCode(...der))}\\n-----END PRIVATE KEY-----\\n`;
  }
  const ids = Object.fromEntries(["", "_CHECKLIST", "_DELEGATION", "_HELPTICKET", "_SUPPORTTICKET", "_WORKLIST", "_TRAINING", "_EMSHEET"].map((s) => [`GOOGLE_SHEET_ID${s}`, SS]));
  return { ...env, ...ids, GOOGLE_SERVICE_ACCOUNT_EMAIL: "sync@test.iam.gserviceaccount.com", GOOGLE_PRIVATE_KEY: PEM, SHEETS_SYNC_ENABLED: "true", EM_SHEET_TAB_NAME: "EM SHEET" };
}

const T = (title: string, sheetId: number, rows: string[][], rowCount = 20) => [title, { sheetId, rows, rowCount }] as const;
beforeEach(async () => {
  _resetGoogleTokenCache();
  calls = [];
  tabs = new Map([
    T("Employee", 1, [["  ", "Employee Name"]]),
    T("Admin", 2, [["User ID", "Admin Name"]]),
    T("AdditionalFeature", 3, [["Employee Name"]]),
    T("DelegationMaster", 4, [["Task ID", "Name"], ["OLD1", "Legacy Person", "kept as is"]], 2), // grid full
    T("Master", 5, [["Name", "Email", "Department", "Task ID", "Freq", "Task", "Planned", "Actual"], ["", "", "", "", "", "", "", "=arrayformula(...)"]]),
    T("Consolidated", 6, [["f", "Timestamp", "Email address"]]),
    T("MasterTasks", 7, [["Name"]]),
    T("HelpTicketsMaster", 8, [["TicketID"]]),
    T("SupportTicketsMaster", 9, [["TicketID", "CreatedBy", "AssignedTo", "Issue", "Status", "CreatedDate", "DoneDate", "Issuephoto", "WorkBy", "Taskcompletedapproval", "-", "Unique", "Where", "What", "Department", "Month", "Week"],
      ["", "", "", "", "", "", "", "", "", "", "", "=ARRAYFORMULA(L)", "", "", "", "=ARRAYFORMULA(P)", "=ARRAYFORMULA(Q)"]]),
    T("WorkList", 10, [["WorkList"]]),
    T("MasterTemplateData", 11, [["Template ID"]]),
    T("AQData", 12, [["Template ID", "QA ID"]]),
    T("EmployeeTrainingData", 13, [["Employee Name"]]),
    T("EM SHEET", 14, [["NO", "DOER NAME"], ["", "WEEK NO.-46"], ["1", "Asha", "10"]]),
  ]);
  await env.DB.prepare("DELETE FROM sheet_sync_queue").run();
  vi.spyOn(globalThis, "fetch").mockImplementation(fakeGoogle as typeof fetch);
});
afterEach(() => vi.restoreAllMocks());

// ---------------------------------------------------------------- helpers
async function api(method: string, path: string, token?: string, body?: unknown) {
  const r = await SELF.fetch(`https://api.test${path}`, { method, headers: { ...(token && { Authorization: `Bearer ${token}` }), ...(body !== undefined && { "Content-Type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: (await r.json()) as any };
}
async function tokens() {
  const h = await hashPassword("secret123");
  await env.DB.batch([
    env.DB.prepare("INSERT OR IGNORE INTO users (employee_id, role, name, mobile, password_hash, department, designation, hr_details) VALUES ('SYADM','admin','Boss','9100000001',?,'Mgmt','', '{}')").bind(h),
    env.DB.prepare("INSERT OR IGNORE INTO users (employee_id, role, name, mobile, password_hash, department, designation, hr_details) VALUES ('SYEMP','employee','Asha','9100000002',?,'Accounts','Accountant', '{\"bankName\":\"SBI\",\"gender\":\"F\"}')").bind(h),
    env.DB.prepare("INSERT OR IGNORE INTO users (employee_id, role, name, mobile, password_hash, department, designation, hr_details) VALUES ('SYMIS','employee','Ravi','9100000003',?,'MIS','MIS', '{}')").bind(h),
  ]);
  const login = async (id: string, admin = false) => (await api("POST", admin ? "/api/adminauth/admin/login" : "/api/auth/login", undefined, { employeeID: id, password: "secret123" })).json.token as string;
  return { admin: await login("SYADM", true), emp: await login("SYEMP"), mis: await login("SYMIS") };
}
const rowsOf = (tab: string) => tabs.get(tab)!.rows;
const findRow = (tab: string, col: number, key: string) => rowsOf(tab).filter((r) => r[col] === key);

// ---------------------------------------------------------------- tests
describe("Google Sheets backup sync", () => {
  it("formula-safe cell values", () => {
    expect(cellValue("=IMPORTXML(\"http://x\")")).toBe("'=IMPORTXML(\"http://x\")");
    expect(cellValue("@cmd")).toBe("'@cmd");
    expect(cellValue("+HYPERLINK(1)")).toBe("'+HYPERLINK(1)");
    expect(cellValue("+918000000000")).toBe("+918000000000");
    expect(cellValue("-5")).toBe("-5");
    expect(cellValue("02/03/2026 10:00:00")).toBe("02/03/2026 10:00:00");
    expect(cellValue(7)).toBe(7);
    expect(cellValue(null)).toBe("");
  });

  it("captures portal writes and mirrors them into the legacy sheet layouts", async () => {
    const c = await cfg();
    const { admin, emp, mis } = await tokens();

    // delegation: create → done → shift; checklist: template + done; support ticket workflow
    const d = await api("POST", "/api/delegations", admin, { TaskName: "=HYPERLINK(\"evil\")", Deadline: "31/12/2099", Name: "Asha", AssignBy: "Boss" });
    await api("PATCH", `/api/delegations/done/${d.json.TaskID}`, emp);
    await api("POST", "/api/checklist/create-template", admin, { task: "Cash count", freq: "D", employeeName: "Asha" });
    const open = (await api("GET", "/api/checklist", emp)).json;
    await api("PATCH", `/api/checklist/done/${open[0].TaskID}`, emp);
    const st = await api("POST", "/api/support-tickets/create", emp, { Issue: "VPN down" });
    await api("PATCH", `/api/support-tickets/status/${encodeURIComponent(st.json.ticketIDs[0])}`, mis, { Status: "InProgress" });
    await api("POST", "/api/additionalfeature/add", emp, { featureName: "Tally", featureURL: "https://tally.example" });

    const r = await runSheetsSync(c);
    expect(r).toMatchObject({ failed: 0 });
    expect((await env.DB.prepare("SELECT COUNT(*) n FROM sheet_sync_queue").first<{ n: number }>())!.n).toBe(0);

    // Delegation row in legacy column order, formula text neutralised, legacy row untouched
    const [del] = findRow("DelegationMaster", 0, d.json.TaskID);
    expect(del.slice(0, 3)).toEqual([d.json.TaskID, "Asha", "'=HYPERLINK(\"evil\")"]);
    expect(del[10]).toBe("Completed");
    expect(del[11]).toBe("Boss");
    expect(rowsOf("DelegationMaster")[1]).toEqual(["OLD1", "Legacy Person", "kept as is"]);
    expect(tabs.get("DelegationMaster")!.rowCount).toBeGreaterThan(2); // full grid was grown before appending

    // Checklist: Master never overwrites column H formula; completion goes to Consolidated
    expect(rowsOf("Master")[1][7]).toBe("=arrayformula(...)");
    const masterRows = rowsOf("Master").slice(1).filter((x) => x[3]);
    expect(masterRows.length).toBeGreaterThan(0);
    expect(masterRows.every((x) => (x[7] ?? "") === "" || x[7] === "=arrayformula(...)")).toBe(true);
    const [cons] = findRow("Consolidated", 0, open[0].TaskID);
    expect(cons[1]).toMatch(/^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}:\d{2}$/);
    expect(findRow("MasterTasks", 1, "Asha")).toHaveLength(1);

    // Support: 1 ticket (one MIS member), formula columns L/P/Q preserved
    const sup = rowsOf("SupportTicketsMaster");
    expect(sup[1][11]).toBe("=ARRAYFORMULA(L)");
    expect(sup[1][15]).toBe("=ARRAYFORMULA(P)");
    const [t] = findRow("SupportTicketsMaster", 0, st.json.ticketIDs[0]);
    expect(t[4]).toBe("InProgress");
    expect(t[8]).toBe("Ravi");
    expect(t[14]).toBe("Accounts");

    // Users: employee row has 75 legacy columns incl. HR fields; admin tab separate
    const [e] = findRow("Employee", 0, "SYEMP");
    expect([e[1], e[4], e[10], e[12], e[47]]).toEqual(["Asha", "Accounts", "Accountant", "F", "SBI"]);
    expect(findRow("Admin", 0, "SYADM")).toHaveLength(1);
    expect(findRow("AdditionalFeature", 1, "Tally")).toHaveLength(1);
  });

  it("updates rows in place (no duplicates) and clears deleted rows", async () => {
    const c = await cfg();
    const { admin } = await tokens();
    const d = await api("POST", "/api/delegations", admin, { TaskName: "First", Deadline: "01/01/2099", Name: "Asha" });
    await runSheetsSync(c);
    await api("PUT", `/api/delegations/update/${d.json.TaskID}`, admin, { TaskName: "Renamed" });
    await runSheetsSync(c);
    let rows = findRow("DelegationMaster", 0, d.json.TaskID);
    expect(rows).toHaveLength(1);
    expect(rows[0][2]).toBe("Renamed");
    await api("DELETE", `/api/delegations/delete/${d.json.TaskID}`, admin);
    await runSheetsSync(c);
    rows = findRow("DelegationMaster", 0, d.json.TaskID);
    expect(rows).toHaveLength(0); // cleared like the legacy delete
  });

  it("rewrites all index rows of a training template together", async () => {
    const c = await cfg();
    const { admin } = await tokens();
    const tpl = await api("POST", "/api/training/templates", admin, { designation: "COMMON", name: "Induction", indices: [{ name: "Safety" }, { name: "Quality" }], questions: [{ question: "Q?", optionA: "a", optionB: "b", correctOption: "A" }] });
    await runSheetsSync(c);
    expect(findRow("MasterTemplateData", 0, tpl.json.templateId).map((r) => r[2])).toEqual(["Safety", "Quality"]);
    expect(findRow("AQData", 0, tpl.json.templateId)).toHaveLength(1);
    await api("PUT", `/api/training/templates/approve/${tpl.json.templateId}`, admin, { approval: "Approved" });
    await api("DELETE", `/api/training/indices/${tpl.json.templateId}/2`, admin);
    await runSheetsSync(c);
    const rows = findRow("MasterTemplateData", 0, tpl.json.templateId);
    expect(rows.map((r) => [r[2], r[6]])).toEqual([["Safety", "Approved"]]);
  });

  it("keeps the queue and reports the error when a sheet fails, then recovers", async () => {
    const c = await cfg();
    const { admin } = await tokens();
    tabs.delete("WorkList");
    await api("POST", "/api/worklist", admin, { WorklistName: "Daily MIS", Frequency: "Daily", WorkingTime: "30M", EmployeeName: "Asha" });
    await api("POST", "/api/delegations", admin, { TaskName: "Other", Deadline: "01/01/2099", Name: "Asha" });
    const r1 = await runSheetsSync(c);
    expect(r1).toMatchObject({ results: { WorkList: { error: expect.stringMatching(/WorkList" not found/) } } });
    const left = await env.DB.prepare("SELECT tbl FROM sheet_sync_queue").all<{ tbl: string }>();
    expect(left.results.map((x) => x.tbl)).toEqual(["worklists"]); // only the failed sheet's changes remain
    const status = await api("GET", "/api/sheets-sync/status", admin);
    expect(status.json.sheets.find((s: any) => s.sheet === "WorkList")).toMatchObject({ ok: false });

    tabs.set("WorkList", { sheetId: 10, rows: [["WorkList"]], rowCount: 20 });
    const r2 = await runSheetsSync(c);
    expect(r2).toMatchObject({ failed: 0, processed: 1 });
    expect(findRow("WorkList", 2, "Daily MIS")).toHaveLength(1);
  });

  it("never runs two syncs at once and does nothing while disabled", async () => {
    const c = await cfg();
    expect(await runSheetsSync({ ...c, SHEETS_SYNC_ENABLED: "false" })).toEqual({ skipped: "disabled" });
    await env.DB.prepare("UPDATE sheet_sync_state SET value = ? WHERE name = 'lock'").bind(String(Math.floor(Date.now() / 1000) + 60)).run();
    expect(await runSheetsSync(c)).toEqual({ skipped: "another sync is running" });
    await env.DB.prepare("UPDATE sheet_sync_state SET value = '0' WHERE name = 'lock'").run();
  });

  it("pulls the formula-driven EM report from Sheets into D1", async () => {
    const c = await cfg();
    const { admin } = await tokens();
    expect(await pullEmSheet(c)).toEqual({ rows: 3 });
    const em = await api("GET", "/api/em-sheet/em-sheet", admin);
    expect(em.json.data.weekInfo).toBe("WEEK NO.-46");
    expect(em.json.data.employees[0]).toMatchObject({ doerName: "Asha" });
  });

  it("sync controls are admin-only", async () => {
    const { emp } = await tokens();
    for (const [m, p] of [["GET", "/api/sheets-sync/status"], ["POST", "/api/sheets-sync/run"], ["POST", "/api/sheets-sync/clear-queue"]] as const) {
      expect((await api(m, p, emp, m === "POST" ? {} : undefined)).status).toBe(403);
    }
  });

  it("pulls old-portal changes from the sheets into D1 (portal wins, no echo back)", async () => {
    const c = await cfg();
    const { admin } = await tokens();
    // D1 has two delegations; one also has a pending portal edit
    const a = await api("POST", "/api/delegations", admin, { TaskName: "Portal task", Deadline: "01/12/2026", Name: "Asha" });
    const b = await api("POST", "/api/delegations", admin, { TaskName: "Edited in portal", Deadline: "01/12/2026", Name: "Asha" });
    await runSheetsSync(c); // both now in the sheet, queue empty
    await api("PUT", `/api/delegations/update/${b.json.TaskID}`, admin, { TaskName: "Edited in portal v2" }); // pending
    // old portal: completes A, edits B, creates a brand-new task
    const g = tabs.get("DelegationMaster")!;
    const rowA = g.rows.find((r) => r[0] === a.json.TaskID)!;
    rowA[7] = "16/11/2026 09:01:33"; rowA[10] = "Completed";
    g.rows.find((r) => r[0] === b.json.TaskID)![2] = "Edited in OLD portal";
    g.rows.push(["OLDNEW", "Ravi", "Created in old portal", "16/11/2026 10:00:00", "20/11/2026", "", "", "", "0", "High", "Pending", "Boss", "", "Pending"]);
    g.rowCount = g.rows.length + 5;

    const r = await runSheetsPull(c, { force: true });
    // exact counts can include rows from other test files (shared D1) — assert the outcomes below
    expect((r.DelegationMaster as any).inserted).toBeGreaterThanOrEqual(1);
    expect((r.DelegationMaster as any).skippedPending).toBeGreaterThanOrEqual(1);
    const get = (id: string) => env.DB.prepare("SELECT task_name, status, final_date FROM delegations WHERE task_id = ?").bind(id).first<any>();
    expect(await get(a.json.TaskID)).toMatchObject({ status: "Completed", final_date: "16/11/2026 09:01:33" });
    expect((await get(b.json.TaskID))!.task_name).toBe("Edited in portal v2"); // portal wins
    expect(await get("OLDNEW")).toMatchObject({ task_name: "Created in old portal" });
    // pulled rows are not queued to be written back; the portal's pending edit still is
    const q = (await env.DB.prepare("SELECT k FROM sheet_sync_queue WHERE tbl = 'delegations'").all<{ k: string }>()).results.map((x) => x.k);
    expect(q).toEqual([b.json.TaskID]);
    // second pull: nothing new
    const again = (await runSheetsPull(c, { force: true })).DelegationMaster as any;
    expect(again.inserted).toBe(0); // idempotent: nothing new on a second pull
    // next sync pushes the portal's version over the old-portal edit
    await runSheetsSync(c);
    expect(findRow("DelegationMaster", 0, b.json.TaskID)[0][2]).toBe("Edited in portal v2");
  });

  it("applies new checklist completions from Consolidated once (resume point)", async () => {
    const c = await cfg();
    await env.DB.prepare("INSERT OR IGNORE INTO checklist_tasks (task_id, name, task, planned) VALUES ('CK1','Asha','Count','16/11/2026 23:59:59'), ('CK2','Asha','Count','17/11/2026 23:59:59')").run();
    await env.DB.prepare("DELETE FROM sheet_sync_queue").run();
    await env.DB.prepare("DELETE FROM sheet_sync_state WHERE name = 'pull:Consolidated:rows'").run();
    tabs.get("Consolidated")!.rows.push(["CK1", "16/11/2026 10:10:41"], ["CK1", "16/11/2026 11:00:00"]);
    let r = await runSheetsPull(c, { force: true });
    expect(r.Consolidated).toMatchObject({ newRows: 2, completionsApplied: 1 });
    expect((await env.DB.prepare("SELECT actual FROM checklist_tasks WHERE task_id='CK1'").first<any>())!.actual).toBe("16/11/2026 10:10:41"); // first wins (VLOOKUP)
    tabs.get("Consolidated")!.rows.push(["CK2", "16/11/2026 12:00:00"]);
    r = await runSheetsPull(c, { force: true });
    expect(r.Consolidated).toMatchObject({ newRows: 1, completionsApplied: 1 }); // only rows after the resume point
    expect((await env.DB.prepare("SELECT COUNT(*) n FROM sheet_sync_queue WHERE tbl='checklist_tasks'").first<any>())!.n).toBe(0);
  });

  it("backfill re-queues rows changed since a time", async () => {
    await tokens();
    const before = new Date(Date.now() - 1000).toISOString();
    await env.DB.prepare("INSERT INTO delegations (task_id, name, task_name) VALUES ('BF1','Asha','x')").run();
    await env.DB.prepare("DELETE FROM sheet_sync_queue").run();
    const q = await backfillQueue(env, before);
    expect(q.delegations).toBeGreaterThanOrEqual(1);
    expect((await env.DB.prepare("SELECT COUNT(*) n FROM sheet_sync_queue WHERE tbl='delegations' AND k='BF1'").first<any>())!.n).toBe(1);
  });

  it("syncs to Sheets immediately after a write (no waiting for the cron)", async () => {
    const c = await cfg();
    const { admin } = await tokens();
    const waits: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => waits.push(p), passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;
    const res = await app.request("/api/delegations", { method: "POST", headers: { Authorization: `Bearer ${admin}`, "Content-Type": "application/json" }, body: JSON.stringify({ TaskName: "Instant", Deadline: "01/12/2026", Name: "Asha" }) }, c, ctx);
    const { TaskID } = (await res.json()) as any;
    await Promise.all(waits);
    expect(findRow("DelegationMaster", 0, TaskID)).toHaveLength(1);
    // reads do not trigger a sync
    const n = waits.length;
    await app.request("/api/delegations", { headers: { Authorization: `Bearer ${admin}` } }, c, ctx);
    expect(waits.length).toBe(n);
  });
});


import { env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "../src/lib/password";
import { addWorkingDays, addWorkingHours, DEFAULT_CALENDAR, formatIST, parseInstant } from "../src/lib/fms/calendar";
import { recurrenceDue, runFmsRecurrence } from "../src/lib/fms/cron";
import { analyzeGrid } from "../src/lib/fms/importer";

const BASE = "https://api.test";

async function call(method: string, path: string, opts: { token?: string; body?: unknown; form?: FormData } = {}) {
  const headers: Record<string, string> = {};
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  let body: BodyInit | undefined;
  if (opts.form) body = opts.form;
  else if (opts.body !== undefined) { headers["Content-Type"] = "application/json"; body = JSON.stringify(opts.body); }
  const res = await SELF.fetch(`${BASE}${path}`, { method, headers, body });
  const text = await res.text();
  let json: any = text;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json };
}

const login = async (id: string, admin = false) => {
  const r = await call("POST", admin ? "/api/adminauth/admin/login" : "/api/auth/login", { body: { employeeID: id, password: "secret123" } });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return r.json.token as string;
};

let admin = "", asha = "", ravi = "", meena = "";
beforeAll(async () => {
  const pw = await hashPassword("secret123");
  const users = [
    ["FADM1", "admin", "Ritesh F", "9100000001", "Management", ""],
    ["FEMP1", "employee", "Asha F", "9100000002", "Accounts", "Accountant"],
    ["FEMP2", "employee", "Ravi F", "9100000003", "MIS ", "MIS Executive"],   // trailing space on purpose
    ["FEMP3", "employee", "Meena F", "9100000004", "mis", "MIS Executive"],
  ];
  await env.DB.batch(users.map(([id, role, name, mobile, dept, desig]) =>
    env.DB.prepare("INSERT OR IGNORE INTO users (employee_id, role, name, mobile, password_hash, department, designation) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(id, role, name, mobile, pw, dept, desig)));
  [admin, asha, ravi, meena] = [await login("FADM1", true), await login("FEMP1"), await login("FEMP2"), await login("FEMP3")];
});

describe("FMS calendar (sheet formula parity)", () => {
  const ist = (s: string) => parseInstant(s)!;
  it("adds working days skipping Sundays and holidays (WORKDAY.INTL)", () => {
    // Sat 03/01/2026 10:00 + 1 day → Mon 05/01 (Sunday off)
    expect(formatIST(addWorkingDays(ist("03/01/2026 10:00"), 1, DEFAULT_CALENDAR, new Set()).toISOString())).toBe("05/01/2026 10:00");
    expect(formatIST(addWorkingDays(ist("03/01/2026 10:00"), 1, DEFAULT_CALENDAR, new Set(["2026-01-05"])).toISOString())).toBe("06/01/2026 10:00");
  });
  it("adds working hours inside 10:00–19:00", () => {
    // 15:18 + 6h → 19:00 uses 3h42, rest 2h18 next working day → 12:18
    expect(formatIST(addWorkingHours(ist("31/12/2025 15:18"), 6, DEFAULT_CALENDAR, new Set()).toISOString())).toBe("01/01/2026 12:18");
    // after hours on Saturday → Monday 10:00 + 2h
    expect(formatIST(addWorkingHours(ist("03/01/2026 20:00"), 2, DEFAULT_CALENDAR, new Set()).toISOString())).toBe("05/01/2026 12:00");
  });
  it("parses sheet values as IST", () => {
    expect(parseInstant("2026-01-01 12:30:00")!.toISOString()).toBe("2026-01-01T07:00:00.000Z");
    expect(parseInstant("01/01/2026")!.toISOString()).toBe("2025-12-31T18:30:00.000Z");
    expect(parseInstant("not a date")).toBeNull();
  });
  it("decides recurrence periods", () => {
    const at = (s: string) => new Date(s).getTime();
    const daily = { frequency: "daily", schedule: '{"time":"10:00"}', start_date: "", due_date: "" };
    expect(recurrenceDue(daily, at("2026-01-05T05:00:00Z"))).toBe("2026-01-05");     // Mon 10:30 IST
    expect(recurrenceDue(daily, at("2026-01-05T03:00:00Z"))).toBeNull();             // 08:30 IST, before time
    expect(recurrenceDue(daily, at("2026-01-04T06:00:00Z"))).toBeNull();             // Sunday
    expect(recurrenceDue({ ...daily, frequency: "monthly", schedule: '{"dates":[5]}' }, at("2026-01-05T06:00:00Z"))).toBe("2026-01-05");
    expect(recurrenceDue({ ...daily, frequency: "weekly", schedule: '{"days":[2]}' }, at("2026-01-05T06:00:00Z"))).toBeNull();
  });
});

describe("FMS workflow", () => {
  let fmsId = 0, seatId = 0;

  it("blocks doers from admin endpoints (RBAC)", async () => {
    for (const [m, p] of [
      ["GET", "/api/fms/definitions"], ["POST", "/api/fms/definitions"], ["GET", "/api/fms/seats"], ["POST", "/api/fms/seats"],
      ["POST", "/api/fms/import/analyze"], ["POST", "/api/fms/import/commit"], ["GET", "/api/fms/reports"], ["GET", "/api/fms/audit"],
      ["POST", "/api/fms/holidays"], ["GET", "/api/fms/approvals"], ["POST", "/api/fms/jobs/reminders"], ["POST", "/api/fms/steps/1/reassign"],
      ["POST", "/api/fms/steps/1/reopen"], ["POST", "/api/fms/steps/1/planned"], ["DELETE", "/api/fms/records/1"], ["PUT", "/api/fms/records/1"],
    ] as const) {
      expect((await call(m, p, { token: asha, body: m === "GET" ? undefined : {} })).status, `${m} ${p}`).toBe(403);
    }
    expect((await call("GET", "/api/fms/accessible")).status).toBe(401);
  });

  it("creates a seat and an FMS with dynamic columns, steps, approval and a condition", async () => {
    const s = await call("POST", "/api/fms/seats", { token: admin, body: { code: "CRMX", name: "CRM desk", members: [{ kind: "department", value: "MIS" }] } });
    expect(s.status, JSON.stringify(s.json)).toBe(201);
    seatId = s.json.seat.id;
    expect(s.json.seat.people_now.map((p: any) => p.employee_id).sort()).toEqual(["FEMP2", "FEMP3"]); // name matching ignores case/space

    const bad = await call("POST", "/api/fms/definitions", { token: admin, body: { name: "Bad", steps: [{ name: "No who" }] } });
    expect(bad.status).toBe(400);
    expect(bad.json.errors[0]).toMatch(/WHO/);

    const d = await call("POST", "/api/fms/definitions", {
      token: admin,
      body: {
        name: "Delivery Promise", code: "FMS-T1", category: "CRM", priority: "High", start_field: "date_time",
        fields: [
          { label: "Date & Time", type: "datetime", required: true },
          { label: "Dealer Name", type: "text", required: true },
          { label: "Delivery Date", type: "date", required: true },
        ],
        steps: [
          { name: "Confirm with dispatch", seat_id: seatId, tat: { type: "hours", value: 6 } },
          {
            name: "Check goods", assign: { designations: ["Accountant"] }, tat: { type: "days", value: 1 }, requires_approval: true,
            fields: [{ label: "Good Status", type: "select", options: ["Available", "Not Available"], required: true }],
          },
          { name: "Re-promise", seat_id: seatId, tat: { type: "days", value: 1 }, condition: { field: "good_status", op: "eq", value: "Not Available" } },
          { name: "Final dispatch", seat_id: seatId, tat: { type: "before_field", value: 1, field: "delivery_date" } },
        ],
      },
    });
    expect(d.status, JSON.stringify(d.json)).toBe(201);
    fmsId = d.json.id;
    expect(d.json.definition.fms_id).toMatch(/^FMS-\d{4}$/);
    expect(d.json.definition.steps.map((x: any) => x.code)).toEqual(["STEP-1", "STEP-2", "STEP-3", "STEP-4"]);
    expect((await call("POST", "/api/fms/definitions", { token: admin, body: { name: "Dupe", code: "fms-t1", steps: [] } })).status).toBe(409);
  });

  it("runs a row through steps: assignment, approval reject/resubmit, condition skip, T-1 planning", async () => {
    // Asha (Accounts) is not on step 1 → cannot create; Ravi (MIS = seat CRMX) can
    expect((await call("POST", `/api/fms/definitions/${fmsId}/records`, { token: asha, body: { data: {} } })).status).toBe(403);
    expect((await call("POST", `/api/fms/definitions/${fmsId}/records`, { token: ravi, body: { data: { dealer_name: "X" } } })).status).toBe(400); // required
    const cr = await call("POST", `/api/fms/definitions/${fmsId}/records`, {
      token: ravi, body: { data: { date_time: "31/12/2025 15:18", dealer_name: "TULSI TRADERS", delivery_date: "10/01/2026" } },
    });
    expect(cr.status, JSON.stringify(cr.json)).toBe(201);
    expect(cr.json.uid).toBe("UID-1");
    const rid = cr.json.id;

    let rec = (await call("GET", `/api/fms/records/${rid}`, { token: admin })).json.record;
    expect(rec.steps.map((s: any) => s.status)).toEqual(["pending", "waiting", "waiting", "waiting"]);
    expect(formatIST(rec.steps[0].planned_at)).toBe("01/01/2026 12:18"); // 6 working hours from the row's Date & Time

    // notifications + tasks for both MIS members, none for Asha
    const meenaTasks = await call("GET", "/api/fms/my/tasks?bucket=all", { token: meena });
    expect(meenaTasks.json.items.map((t: any) => t.uid)).toContain("UID-1");
    expect((await call("GET", "/api/fms/my/tasks?bucket=all", { token: asha })).json.items).toHaveLength(0);
    expect((await call("GET", "/api/fms/notifications?unread=1", { token: meena })).json.unread).toBeGreaterThan(0);

    const s1 = rec.steps[0].id, s2 = rec.steps[1].id;
    expect((await call("POST", `/api/fms/steps/${s1}/complete`, { token: asha, body: {} })).status).toBe(403);
    expect((await call("POST", `/api/fms/steps/${s1}/draft`, { token: ravi, body: { remarks: "calling" } })).status).toBe(200);
    expect((await call("POST", `/api/fms/steps/${s1}/complete`, { token: ravi, body: { remarks: "confirmed" } })).status).toBe(200);

    rec = (await call("GET", `/api/fms/records/${rid}`, { token: admin })).json.record;
    expect(rec.steps[0]).toMatchObject({ status: "done", outcome: "Done", done_by_name: "Ravi F", remarks: "confirmed" });
    expect(rec.steps[1].status).toBe("pending");
    expect(rec.current_step).toBe(2);

    // step 2: required step input, then approval
    expect((await call("POST", `/api/fms/steps/${s2}/complete`, { token: asha, body: {} })).status).toBe(400);
    const sub = await call("POST", `/api/fms/steps/${s2}/complete`, { token: asha, body: { values: { good_status: "Available" } } });
    expect(sub.json.status).toBe("submitted");
    expect((await call("POST", `/api/fms/steps/${s2}/approve`, { token: asha, body: {} })).status).toBe(403); // not an approver
    expect((await call("GET", "/api/fms/approvals", { token: admin })).json.items.map((x: any) => x.id)).toContain(s2);
    expect((await call("POST", `/api/fms/steps/${s2}/reject`, { token: admin, body: { reason: "" } })).status).toBe(400);
    expect((await call("POST", `/api/fms/steps/${s2}/reject`, { token: admin, body: { reason: "Attach stock proof" } })).status).toBe(200);
    const rej = await call("GET", "/api/fms/my/tasks?bucket=rejected", { token: asha });
    expect(rej.json.items[0]).toMatchObject({ uid: "UID-1", rejection_reason: "Attach stock proof" });
    expect((await call("POST", `/api/fms/steps/${s2}/complete`, { token: asha, body: { values: { good_status: "Available" } } })).json.status).toBe("submitted");
    expect((await call("POST", `/api/fms/steps/${s2}/approve`, { token: admin, body: { remarks: "ok" } })).status).toBe(200);

    rec = (await call("GET", `/api/fms/records/${rid}`, { token: admin })).json;
    expect(rec.record.steps.map((s: any) => s.status)).toEqual(["done", "done", "skipped", "pending"]); // goods available → re-promise skipped
    expect(rec.record.steps[3].planned_at).toBe("2026-01-08T18:30:00.000Z"); // T-1 of 10/01/2026
    expect(rec.history.map((h: any) => h.action)).toEqual(expect.arrayContaining(["created", "assigned", "draft_saved", "completed", "submitted", "rejected", "resubmitted", "approved", "skipped"]));

    // admin: reassign the last step to Asha, she finishes it → row completed
    const s4 = rec.record.steps[3].id;
    expect((await call("POST", `/api/fms/steps/${s4}/reassign`, { token: admin, body: { employee_id: "FEMP1", reason: "leave cover" } })).json.name).toBe("Asha F");
    expect((await call("POST", `/api/fms/steps/${s4}/complete`, { token: ravi, body: {} })).status).toBe(403); // no longer his
    expect((await call("POST", `/api/fms/steps/${s4}/complete`, { token: asha, body: {} })).status).toBe(200);
    expect((await call("GET", `/api/fms/records/${rid}`, { token: admin })).json.record.status).toBe("completed");

    // reopen step 2 → row open again, later steps back to waiting
    expect((await call("POST", `/api/fms/steps/${s2}/reopen`, { token: admin, body: { reason: "recheck" } })).status).toBe(200);
    rec = (await call("GET", `/api/fms/records/${rid}`, { token: admin })).json.record;
    expect(rec.status).toBe("open");
    expect(rec.steps.map((s: any) => s.status)).toEqual(["done", "pending", "waiting", "waiting"]);

    // comments (internal hidden from doers) and doer summary
    await call("POST", `/api/fms/records/${rid}/comments`, { token: admin, body: { body: "internal note", internal: true } });
    await call("POST", `/api/fms/records/${rid}/comments`, { token: asha, body: { body: "checking again" } });
    const forAsha = await call("GET", `/api/fms/records/${rid}`, { token: asha });
    expect(forAsha.json.comments.map((x: any) => x.body)).toEqual(["checking again"]);
    const sum = await call("GET", "/api/fms/my/summary", { token: asha });
    expect(sum.json.counts.pending).toBe(1);
    expect((await call("GET", "/api/fms/accessible", { token: asha })).json.items.map((x: any) => x.code)).toContain("FMS-T1");
  });

  it("escalates overdue steps once and reminds before due", async () => {
    const r = await call("POST", `/api/fms/definitions/${fmsId}/records`, { token: admin, body: { data: { date_time: "01/01/2025 10:00", dealer_name: "OLD", delivery_date: "05/01/2025" } } });
    expect(r.status).toBe(201);
    const j1 = await call("POST", "/api/fms/jobs/reminders", { token: admin });
    expect(j1.json.escalated).toBeGreaterThanOrEqual(1);
    const j2 = await call("POST", "/api/fms/jobs/reminders", { token: admin });
    expect(j2.json.escalated).toBe(0);
    const n = await call("GET", "/api/fms/notifications", { token: admin });
    expect(n.json.items.some((x: any) => x.kind === "escalation")).toBe(true);
    await call("POST", "/api/fms/notifications/read", { token: admin, body: { all: true } });
    expect((await call("GET", "/api/fms/notifications", { token: admin })).json.unread).toBe(0);
  });

  it("lists, filters, exports, edits and soft-deletes rows; versions and duplicate", async () => {
    const list = await call("GET", `/api/fms/definitions/${fmsId}/records?search=TULSI`, { token: admin });
    expect(list.json.total).toBe(1);
    const all = await call("GET", `/api/fms/definitions/${fmsId}/records?f.dealer_name=old`, { token: admin });
    expect(all.json.items.map((x: any) => x.data.dealer_name)).toEqual(["OLD"]);
    const exp = await call("GET", `/api/fms/definitions/${fmsId}/records/export`, { token: admin });
    expect(exp.json.columns.map((c: any) => c.label)).toEqual(expect.arrayContaining(["UID", "Dealer Name", "STEP-1 Planned", "STEP-2 Good Status"]));
    expect(exp.json.rows.find((r: any) => r.uid === "UID-1").delivery_date).toBe("10/01/2026");

    const rid = all.json.items[0].id;
    expect((await call("PUT", `/api/fms/records/${rid}`, { token: admin, body: { data: { dealer_name: "OLD TRADERS" } } })).json.data.dealer_name).toBe("OLD TRADERS");
    expect((await call("PUT", `/api/fms/records/${rid}`, { token: admin, body: { data: { delivery_date: "someday" } } })).status).toBe(400);
    expect((await call("DELETE", `/api/fms/records/${rid}`, { token: admin })).status).toBe(200);
    expect((await call("GET", `/api/fms/definitions/${fmsId}/records`, { token: admin })).json.total).toBe(1);
    expect((await call("POST", `/api/fms/definitions/${fmsId}/records/bulk`, { token: admin, body: { ids: [rid], action: "restore" } })).json.changed).toBe(1);

    const def = (await call("GET", `/api/fms/definitions/${fmsId}`, { token: admin })).json.definition;
    def.description = "v2";
    expect((await call("PUT", `/api/fms/definitions/${fmsId}`, { token: admin, body: def })).json.definition.version).toBe(2);
    const vers = await call("GET", `/api/fms/definitions/${fmsId}/versions`, { token: admin });
    expect(vers.json.items[0].version).toBe(1);
    // rows keep their steps after an edit
    expect((await call("GET", `/api/fms/definitions/${fmsId}/records`, { token: admin })).json.items[0].steps).toHaveLength(4);

    const dup = await call("POST", `/api/fms/definitions/${fmsId}/duplicate`, { token: admin, body: { name: "Promise copy", is_template: true } });
    expect(dup.status).toBe(201);
    const tpl = await call("GET", "/api/fms/definitions?view=templates", { token: admin });
    expect(tpl.json.items.map((x: any) => x.name)).toContain("Promise copy");
    expect((await call("PATCH", `/api/fms/definitions/${dup.json.id}/state`, { token: admin, body: { archived: true } })).status).toBe(200);
    expect((await call("DELETE", `/api/fms/definitions/${dup.json.id}?purge=1`, { token: admin })).status).toBe(409);
    expect((await call("DELETE", `/api/fms/definitions/${dup.json.id}`, { token: admin })).status).toBe(200);
    expect((await call("DELETE", `/api/fms/definitions/${dup.json.id}?purge=1`, { token: admin })).status).toBe(200);

    const rep = await call("GET", `/api/fms/reports?fms=${fmsId}`, { token: admin });
    expect(rep.json.by_step).toHaveLength(4);
    expect(rep.json.totals.done).toBeGreaterThan(0);
  });
});

describe("FMS import (auto-create from a sheet)", () => {
  // the EPIL FMS sheet layout: STEP labels, WHAT/WHO/HOW/WHEN rows, Planned/Actual/Status per step
  const grid = [
    ["", "", "", 10, 19],
    ["", "TEST IMPORT FMS"],
    ["", "", "", "STEP-1", "", "", "", "STEP-2"],
    ["WHAT", "", "", "Call dealer", "", "", "", "Dispatch goods"],
    ["WHO", "", "", "CRMIMP", "", "", "", "PC-9"],
    ["HOW", "", "", "Phone", "", "", "", "IF GOODS ARE AVAILABLE"],
    ["WHEN", "", "", 0.25, "", "", "", "T-1"],
    ["Date & Time", "Dealer Name", "Delivery Date", "Planned", "Actual", "Status", "Time Delay", "GOOD STATUS?", "Planned", "Actual", "Status", "Time Delay", "UID"],
    ["2026-01-05 11:00:00", "A TRADERS", "2026-01-10", "2026-01-05 17:00:00", "2026-01-05 16:00:00", "Done", "", "Available", "2026-01-09 00:00:00", "", "", "", "UID-7"],
    ["2026-01-06 12:00:00", "B TRADERS", "2026-01-12", "2026-01-06 18:00:00", "", "", "", "", "", "", "", "", "UID-8"],
    ["2026-01-06 12:00:00", "B TRADERS", "2026-01-12", "", "", "", "", "", "", "", "", "", "UID-8"],
  ];

  it("analyzes the layout", () => {
    const a = analyzeGrid(grid as any);
    expect(a.kind).toBe("fms");
    expect(a.definition.name).toBe("TEST IMPORT FMS");
    expect(a.definition.steps.map((s: any) => [s.name, s.seat_code, s.tat])).toEqual([
      ["Call dealer", "CRMIMP", { type: "hours", value: 6 }],
      ["Dispatch goods", "PC-9", { type: "before_field", value: 1, field: "delivery_date" }],
    ]);
    expect(a.definition.steps[1].fields!.map((f) => f.label)).toEqual(["GOOD STATUS?"]);
    expect(a.definition.fields!.map((f) => [f.label, f.type])).toEqual([["Date & Time", "datetime"], ["Dealer Name", "text"], ["Delivery Date", "date"], ["UID", "text"]]);
    expect(a.rows).toHaveLength(3);
    expect(a.warnings.join(" ")).toMatch(/condition/);
  });

  it("commits: creates seats + FMS, imports rows with duplicate detection", async () => {
    const an = await call("POST", "/api/fms/import/analyze", { token: admin, body: { grid, name: "x.xlsx" } });
    expect(an.status).toBe(200);
    expect(an.json.seats.map((s: any) => s.code)).toEqual(["CRMIMP", "PC-9"]);
    const cm = await call("POST", "/api/fms/import/commit", { token: admin, body: { definition: an.json.definition } });
    expect(cm.status, JSON.stringify(cm.json)).toBe(201);
    expect(cm.json.createdSeats).toEqual(["CRMIMP", "PC-9"]);
    const id = cm.json.id;

    const dry = await call("POST", `/api/fms/definitions/${id}/records/import`, { token: admin, body: { rows: an.json.rows, dedupe: { fields: ["uid"], action: "skip" }, dryRun: true } });
    expect(dry.json).toMatchObject({ dryRun: true, total: 3, toCreate: 2 });
    expect(dry.json.duplicates[0]).toMatchObject({ row: 3, in_file: true });

    const imp = await call("POST", `/api/fms/definitions/${id}/records/import`, { token: admin, body: { rows: an.json.rows, dedupe: { fields: ["uid"], action: "skip" } } });
    expect(imp.json.created.map((x: any) => x.uid)).toEqual(["UID-7", "UID-8"]);
    const rows = (await call("GET", `/api/fms/definitions/${id}/records?sort=uid&dir=asc`, { token: admin })).json.items;
    // row 1: step 1 done (imported actual), step 2 active with its imported planned time
    expect(rows[0].steps.map((s: any) => s.status)).toEqual(["done", "pending"]);
    expect(rows[0].steps[0].delay_minutes).toBe(0);
    expect(rows[0].steps[1].values.good_status).toBe("Available");
    // row 2: step 1 active with imported planned
    expect(rows[1].steps.map((s: any) => s.status)).toEqual(["pending", "waiting"]);
    expect(rows[1].data.date_time).toBe("2026-01-06T06:30:00.000Z"); // wall-clock IST normalised

    const again = await call("POST", `/api/fms/definitions/${id}/records/import`, { token: admin, body: { rows: an.json.rows, dedupe: { fields: ["uid"], action: "skip" } } });
    expect(again.json.created).toHaveLength(0);
    expect(again.json.duplicates).toHaveLength(3);
    const dupes = await call("GET", `/api/fms/definitions/${id}/duplicates?fields=dealer_name`, { token: admin });
    expect(dupes.json.totalGroups).toBe(0);
  });

  it("creates rows for recurring FMS once per period", async () => {
    const d = await call("POST", "/api/fms/definitions", {
      token: admin,
      body: { name: "Daily stock check", frequency: "daily", schedule: { time: "00:00", days: [0, 1, 2, 3, 4, 5, 6] }, fields: [{ label: "Note" }], steps: [{ name: "Count", assign: { departments: ["Accounts"] }, tat: { type: "hours", value: 2 } }] },
    });
    expect(d.status).toBe(201);
    const r1 = await runFmsRecurrence(env);
    const r2 = await runFmsRecurrence(env);
    expect(r1.created.length).toBe(1);
    expect(r2.created.length).toBe(0);
    expect((await call("GET", "/api/fms/my/tasks?bucket=all", { token: asha })).json.items.some((t: any) => t.fms.name === "Daily stock check")).toBe(true);
  });
});

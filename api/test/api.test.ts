import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import { hashPassword } from "../src/lib/password";
import { runMonthlyGeneration } from "../src/lib/checklistGen";
import { getWeekRange } from "../src/lib/dates";

const BASE = "https://api.test";
let PW_HASH = "";

async function seed() {
  PW_HASH ||= await hashPassword("secret123");
  const users = [
    ["ADM001", "admin", "Ritesh", "9000000001", "Management", ""],
    ["EMP001", "employee", "Asha", "9000000002", "Accounts", "Accountant"],
    ["EMP002", "employee", "Ravi", "9000000003", "MIS", "MIS Executive"],
    ["EMP003", "employee", "Meena", "9000000004", "MIS", "MIS Executive"],
  ];
  await env.DB.batch(users.map(([id, role, name, mobile, dept, desig]) =>
    env.DB.prepare("INSERT OR IGNORE INTO users (employee_id, role, name, mobile, password_hash, department, designation) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(id, role, name, mobile, PW_HASH, dept, desig)));
}

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

beforeEach(seed);

describe("platform", () => {
  it("health reports db ok", async () => {
    const r = await call("GET", "/health");
    expect(r.status).toBe(200);
    expect(r.json.db).toBe(true);
  });

  it("matches module paths case-insensitively and ignores trailing slash (Express parity)", async () => {
    const t = await login("EMP001");
    expect((await call("GET", "/api/additionalFeature/all", { token: t })).status).toBe(200);
    expect((await call("GET", "/api/delegations/", { token: t })).status).toBe(200);
    expect((await call("GET", "/api/allDashboard/all-dashboard?month=1&week=1", { token: t })).status).toBe(200);
  });

  it("rejects missing / invalid tokens", async () => {
    expect((await call("GET", "/api/delegations")).status).toBe(401);
    expect((await call("GET", "/api/delegations", { token: "garbage" })).status).toBe(401);
  });
});

describe("auth", () => {
  it("logs in with a legacy bcrypt hash and upgrades it to PBKDF2", async () => {
    const legacy = bcrypt.hashSync("oldpass1", 4);
    await env.DB.prepare("INSERT INTO users (employee_id, role, name, mobile, password_hash) VALUES ('LEG001','employee','Legacy','9111111111',?)").bind(legacy).run();
    const r = await call("POST", "/api/auth/login", { body: { employeeID: "LEG001", password: "oldpass1" } });
    expect(r.status).toBe(200);
    expect(r.json.user.name).toBe("Legacy");
    await new Promise((res) => setTimeout(res, 50));
    const row = await env.DB.prepare("SELECT password_hash FROM users WHERE employee_id='LEG001'").first<{ password_hash: string }>();
    expect(row!.password_hash.startsWith("pbkdf2$")).toBe(true);
    expect((await call("POST", "/api/auth/login", { body: { employeeID: "LEG001", password: "oldpass1" } })).status).toBe(200);
  });

  it("lets an admin and an employee share the same login ID (separate legacy sheets)", async () => {
    await env.DB.prepare("INSERT INTO users (employee_id, role, name, mobile, password_hash) VALUES ('aman','admin','Aman Agarwal','9555555551',?), ('aman','employee','Aman Thakur','9555555552',?)").bind(PW_HASH, PW_HASH).run();
    const a = await call("POST", "/api/adminauth/admin/login", { body: { employeeID: "aman", password: "secret123" } });
    const e = await call("POST", "/api/auth/login", { body: { employeeID: "aman", password: "secret123" } });
    expect(a.json.user.name).toBe("Aman Agarwal");
    expect(e.json.user.name).toBe("Aman Thakur");
    expect((await call("GET", "/api/employee/profile", { token: e.json.token })).json.name).toBe("Aman Thakur");
  });

  it("returns legacy error codes", async () => {
    expect((await call("POST", "/api/auth/login", { body: { employeeID: "NOPE", password: "x" } })).status).toBe(404);
    expect((await call("POST", "/api/auth/login", { body: { employeeID: "EMP001", password: "wrong" } })).status).toBe(401);
    expect((await call("POST", "/api/adminauth/admin/login", { body: { employeeID: "EMP001", password: "secret123" } })).status).toBe(404);
  });

  it("registers an employee with documents stored in R2 behind signed URLs", async () => {
    const form = new FormData();
    form.set("name", "Kiran"); form.set("mobile", "9222222222"); form.set("password", "pass1234");
    form.set("department", "Sales"); form.set("designation", "Sales Exec"); form.set("joiningDate", "2025-01-15");
    form.set("bankName", "SBI");
    form.set("profilePicture", new File([new Uint8Array([137, 80, 78, 71])], "me.png", { type: "image/png" }));
    form.set("panCard", new File([new Uint8Array([37, 80, 68, 70])], "pan.pdf", { type: "application/pdf" }));
    const r = await call("POST", "/api/auth/register", { form });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const id = r.json.EmployeeID;

    const u = await env.DB.prepare("SELECT * FROM users WHERE employee_id = ?").bind(id).first<any>();
    expect(u.joining_date).toBe("15/01/2025");
    expect(JSON.parse(u.hr_details).bankName).toBe("SBI");
    expect(u.profile_picture.startsWith("r2:")).toBe(true);
    const docs = await env.DB.prepare("SELECT kind FROM user_documents WHERE user_id = ?").bind(u.id).all();
    expect(docs.results).toHaveLength(1);

    const l = await call("POST", "/api/auth/login", { body: { employeeID: id, password: "pass1234" } });
    const url = new URL(l.json.user.profilePicture);
    expect(url.pathname.startsWith("/files/employee_documents/")).toBe(true);
    const file = await SELF.fetch(`${BASE}${url.pathname}${url.search}`);
    expect(file.status).toBe(200);
    expect(file.headers.get("content-type")).toBe("image/png");
    await file.arrayBuffer();
    const tampered = await SELF.fetch(`${BASE}${url.pathname}?exp=${url.searchParams.get("exp")}&sig=deadbeef`);
    expect(tampered.status).toBe(403);
    await tampered.arrayBuffer();

    expect((await call("POST", "/api/auth/register", { form })).json.error).toBe("UserName already registered");
  });

  it("rejects disallowed upload types", async () => {
    const form = new FormData();
    form.set("name", "Bad"); form.set("mobile", "9333333333"); form.set("password", "pass1234"); form.set("department", "X");
    form.set("profilePicture", new File(["x"], "a.heic", { type: "image/heic" }));
    expect((await call("POST", "/api/auth/register", { form })).status).toBe(400);
  });

  it("explains exactly why admin registration was refused", async () => {
    const body = { name: "New Admin", mobile: "9666666666", password: "pass1234", department: "X" };
    const reg = (token?: string, extra = {}) => call("POST", "/api/adminauth/admin/register", { token, body: { ...body, ...extra } });
    expect((await reg()).json.error).toMatch(/Log in to the Admin portal first/);
    expect((await reg(await login("EMP001"))).json.error).toMatch(/logged in as an employee/);
    expect((await reg("eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYWRtaW4ifQ.forged")).json.error).toMatch(/expired/);
    expect((await reg(undefined, { registrationKey: "guess" })).json.error).toMatch(/Registration Key is incorrect/);
  });

  it("locks admin self-registration once an admin exists", async () => {
    const body = { name: "Intruder", mobile: "9444444444", password: "pass1234", department: "X" };
    expect((await call("POST", "/api/adminauth/admin/register", { body })).status).toBe(403);
    const admin = await login("ADM001", true);
    expect((await call("POST", "/api/adminauth/admin/register", { body, token: admin })).status).toBe(200);
  });
});

describe("RBAC", () => {
  it("blocks employees from admin-only endpoints", async () => {
    const t = await login("EMP001");
    for (const [m, p] of [
      ["DELETE", "/api/delegations/delete/x"], ["PATCH", "/api/delegations/approve/x"],
      ["GET", "/api/helpTickets/all"], ["GET", "/api/support-tickets/all"], ["GET", "/api/worklist/all"],
      ["GET", "/api/training/records"], ["POST", "/api/training/templates"], ["GET", "/api/em-sheet/em-sheet"],
      ["POST", "/api/whatsapp/send-delegation"], ["POST", "/api/checklist/create-template"],
    ] as const) {
      expect((await call(m, p, { token: t, body: m === "GET" ? undefined : {} })).status, `${m} ${p}`).toBe(403);
    }
  });

  it("prevents employees from reading another person's data", async () => {
    const t = await login("EMP001");
    expect((await call("GET", "/api/delegations/search/by-name?name=Ravi", { token: t })).status).toBe(403);
    expect((await call("GET", "/api/delegations/filter?month=1&week=1&selectedName=Ravi", { token: t })).status).toBe(403);
    const d = await call("GET", "/api/allDashboard/all-dashboard?month=1&week=all&selectedName=all", { token: t });
    expect(d.json.data.map((x: any) => x.name)).toEqual(["Asha"]);
  });
});

describe("delegations", () => {
  it("runs the full create → done → approve / reject cycle", async () => {
    const admin = await login("ADM001", true);
    const emp = await login("EMP001");
    const c = await call("POST", "/api/delegations", { token: admin, body: { TaskName: "File GST", Deadline: "31/12/2099", Name: "Asha", AssignBy: "Ritesh" } });
    expect(c.json.ok).toBe(true);
    const id = c.json.TaskID;

    const mine = await call("GET", "/api/delegations", { token: emp });
    expect(mine.json).toHaveLength(1);
    expect(mine.json[0]).toMatchObject({ TaskID: id, Name: "Asha", Status: "Pending", Followup: "Ritesh", Taskcompletedapproval: "Pending" });

    // employee may not create for someone else
    expect((await call("POST", "/api/delegations", { token: emp, body: { TaskName: "x", Deadline: "01/01/2099", Name: "Ravi" } })).status).toBe(403);

    expect((await call("PATCH", `/api/delegations/shift/${id}`, { token: emp, body: { newDeadline: "15/01/2100", revisionField: "Revision1" } })).status).toBe(200);
    let t = (await call("GET", "/api/delegations", { token: emp })).json[0];
    expect(t).toMatchObject({ Deadline: "15/01/2100", Revision1: "15/01/2100", Revisions: 1, Status: "Shifted" });

    expect((await call("PATCH", `/api/delegations/done/${id}`, { token: emp })).status).toBe(200);
    t = (await call("GET", "/api/delegations", { token: emp })).json[0];
    expect(t.Status).toBe("Completed");
    expect(t.FinalDate).toMatch(/^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}:\d{2}$/);

    await call("PATCH", `/api/delegations/approve/${id}`, { token: admin, body: { approvalStatus: "Pending" } });
    t = (await call("GET", "/api/delegations", { token: emp })).json[0];
    expect(t).toMatchObject({ Status: "Pending", FinalDate: "", Taskcompletedapproval: "Pending" });

    const byName = await call("GET", "/api/delegations/search/by-name?name=all&assignBy=Ritesh", { token: admin });
    expect(byName.json).toHaveLength(1);
    expect((await call("DELETE", `/api/delegations/delete/${id}`, { token: admin })).status).toBe(200);
  });
});

describe("checklist", () => {
  it("creates a template, generates next month once, and marks done", async () => {
    const admin = await login("ADM001", true);
    const emp = await login("EMP001");
    const r = await call("POST", "/api/checklist/create-template", { token: admin, body: { task: "Bank recon", freq: "W", dayOrDate: "Monday", employeeName: "Asha" } });
    expect(r.json.success).toBe(true);

    const jan = new Date(2030, 0, 10); // generates February 2030
    const g1 = await runMonthlyGeneration(env, jan);
    expect(g1.skipped).toBe(false);
    if ("createdTasks" in g1) expect(g1.createdTasks.map((t: { planned: string }) => t.planned)).toEqual(["04/02/2030 23:59:59", "11/02/2030 23:59:59", "18/02/2030 23:59:59", "25/02/2030 23:59:59"]);
    expect((await runMonthlyGeneration(env, jan)).skipped).toBe(true);

    const open = await call("GET", "/api/checklist", { token: emp });
    const feb = open.json.find((x: any) => x.Planned === "04/02/2030 23:59:59");
    expect(feb).toBeTruthy();
    expect((await call("PATCH", `/api/checklist/done/${feb.TaskID}`, { token: emp })).json.ok).toBe(true);
    const after = await call("GET", "/api/checklist", { token: emp });
    expect(after.json.find((x: any) => x.TaskID === feb.TaskID)).toBeUndefined();
  });
});

describe("tickets", () => {
  it("issues sequential help-ticket IDs and enforces workflow", async () => {
    const emp = await login("EMP001");
    const ravi = await login("EMP002");
    const a = await call("POST", "/api/helpTickets/create", { token: emp, body: { AssignedTo: "Ravi", Issue: "Printer" } });
    const b = await call("POST", "/api/helpTickets/create", { token: emp, body: { AssignedTo: "Ravi", Issue: "Scanner" } });
    expect(a.json.ticketID).toMatch(/^#\d{5}$/);
    expect(Number(b.json.ticketID.slice(1))).toBe(Number(a.json.ticketID.slice(1)) + 1);
    expect((await call("POST", "/api/helpTickets/create", { token: emp, body: { AssignedTo: "Asha", Issue: "x" } })).status).toBe(400);
    const assigned = await call("GET", "/api/helpTickets/assigned", { token: ravi });
    expect(assigned.json).toHaveLength(2);
    const u = await call("PATCH", `/api/helpTickets/status/${encodeURIComponent(a.json.ticketID)}`, { token: ravi, body: { Status: "Done" } });
    expect(u.status).toBe(200);
  });

  it("fans support tickets out to all MIS staff and moves the group together", async () => {
    const emp = await login("EMP001");
    const ravi = await login("EMP002");
    const meena = await login("EMP003");
    const form = new FormData();
    form.set("Issue", "VPN down");
    form.set("IssuePhoto", new File([new Uint8Array([255, 216, 255])], "s.jpg", { type: "image/jpeg" }));
    const c = await call("POST", "/api/support-tickets/create", { token: emp, form });
    const misCount = (await env.DB.prepare("SELECT COUNT(*) n FROM users WHERE role='employee' AND department='MIS' AND is_active=1").first<{ n: number }>())!.n;
    expect(c.json.ticketIDs).toHaveLength(misCount); // one copy per MIS member (other test files may add MIS users)

    const [t1] = c.json.ticketIDs;
    expect((await call("PATCH", `/api/support-tickets/status/${encodeURIComponent(t1)}`, { token: emp, body: { Status: "Approved" } })).status).toBe(400);
    expect((await call("PATCH", `/api/support-tickets/status/${encodeURIComponent(t1)}`, { token: ravi, body: { Status: "InProgress" } })).json.newStatus).toBe("InProgress");
    // Meena no longer sees it (owned by Ravi), Ravi does
    expect((await call("GET", "/api/support-tickets/assigned", { token: meena })).json).toHaveLength(0);
    const rv = await call("GET", "/api/support-tickets/assigned", { token: ravi });
    expect(rv.json[0].IssuePhoto).toContain("/files/support_tickets/");
    expect((await call("PATCH", `/api/support-tickets/status/${encodeURIComponent(t1)}`, { token: meena, body: { Status: "Done" } })).status).toBe(403); // legacy: "only complete tickets you started"
    expect((await call("PATCH", `/api/support-tickets/status/${encodeURIComponent(t1)}`, { token: ravi, body: { Status: "Done" } })).status).toBe(200);
    await call("PATCH", `/api/support-tickets/done-details/${encodeURIComponent(t1)}`, { token: ravi, body: { Problem: "ISP", Solution: "Restarted" } });
    const ap = await call("PATCH", `/api/support-tickets/status/${encodeURIComponent(t1)}`, { token: emp, body: { Status: "Approved" } });
    expect(ap.json).toMatchObject({ newStatus: "Done", taskApproval: "Approved", message: `Updated ${misCount} ticket(s)` });
  });
});

describe("worklist", () => {
  it("validates, de-duplicates bulk uploads and computes occupancy", async () => {
    const admin = await login("ADM001", true);
    const emp = await login("EMP001");
    expect((await call("POST", "/api/worklist", { token: emp, body: { WorklistName: "x", Frequency: "Weekly", WorkingTime: "30M" } })).status).toBe(400);
    expect((await call("POST", "/api/worklist", { token: emp, body: { WorklistName: "Daily MIS", Frequency: "Daily", WorkingTime: "300M" } })).json.ok).toBe(true);
    const bulk = await call("POST", "/api/worklist/bulk", { token: emp, body: { worklists: [
      { WorklistName: "Daily MIS", Frequency: "Daily", WorkingTime: "10M" },
      { WorklistName: "Payroll", Frequency: "Monthly", WorkingTime: "300M", ScheduleDates: "1,15" },
      { WorklistName: "", Frequency: "Daily", WorkingTime: "1M" },
    ] } });
    expect(bulk.json.summary).toEqual({ total: 3, created: 1, skipped: 1, errors: 1 });
    const occ = await call("GET", "/api/worklist/admin/occupancy?date=2030-03-15", { token: admin });
    expect(occ.json.occupancyList[0]).toMatchObject({ employeeName: "Asha", assignedMinutes: 600, status: "overload" });
  });
});

describe("training", () => {
  it("assigns COMMON + designation templates and scores learning server-side", async () => {
    const admin = await login("ADM001", true);
    const emp = await login("EMP001");
    const mk = await call("POST", "/api/training/templates", { token: admin, body: {
      designation: "Accountant", name: "Tally basics", indices: [{ name: "Intro", document: "https://d/1", video: "https://v/1" }],
      questions: [{ question: "2+2?", optionA: "4", optionB: "5", correctOption: "A" }, { question: "3+3?", optionA: "5", optionB: "6", correctOption: "B" }],
    } });
    const tid = mk.json.templateId;
    await call("POST", "/api/training/templates", { token: admin, body: { designation: "MIS Executive", name: "Other", indices: [{ name: "x" }] } });
    expect((await call("POST", "/api/training/start", { token: emp, body: { templateId: tid } })).status).toBe(403);
    await call("PUT", `/api/training/templates/approve/${tid}`, { token: admin, body: { approval: "Approved" } });

    const my = await call("GET", "/api/training/my", { token: emp });
    expect(my.json.records.map((r: any) => r.TemplateId)).toEqual([tid]);

    const qa = await call("GET", `/api/training/qa/${tid}`, { token: emp }); // no forTest flag
    expect(qa.json.questions.every((q: any) => q.CorrectOption === "")).toBe(true);

    await call("POST", "/api/training/start", { token: emp, body: { templateId: tid } });
    expect((await call("PUT", "/api/training/progress", { token: emp, body: { templateId: tid, docIndex: 1 } })).status).toBe(400);
    for (const kind of ["doc", "video"]) for (const mode of ["self", "self", "withDoer", "withDoer"]) {
      expect((await call("PUT", "/api/training/progress", { token: emp, body: { templateId: tid, viewTick: { kind, index: 1, mode } } })).status).toBe(200);
    }
    await call("PUT", "/api/training/progress", { token: emp, body: { templateId: tid, docIndex: 1 } });
    await call("PUT", "/api/training/progress", { token: emp, body: { templateId: tid, videoIndex: 1 } });
    const qs = (await call("GET", `/api/training/qa/${tid}`, { token: admin })).json.questions;
    const fin = await call("PUT", "/api/training/progress", { token: emp, body: { templateId: tid, qaAnswers: { [qs[0].QaId]: "A", [qs[1].QaId]: "A" } } });
    expect(fin.json.completed).toBe(true);
    expect(fin.json.record).toMatchObject({ DocumentScore: 100, VideoScore: 100, QaScore: 50, TotalScore: 250, Status: "Completed" });

    const sum = await call("GET", "/api/training/records/summary?employeeName=Asha", { token: admin });
    expect(sum.json.summary.total).toMatchObject({ assigned: 1, completed: 1 });
  });
});

describe("dashboard", () => {
  it("computes delegation stats per week exactly like the sheet version", async () => {
    const admin = await login("ADM001", true);
    const { weekStart } = getWeekRange(3, 2); // legacy semantics: current year
    const day = (offset: number) => {
      const d = new Date(weekStart); d.setDate(d.getDate() + offset);
      return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
    };
    await env.DB.batch([
      env.DB.prepare("INSERT INTO delegations (task_id, name, task_name, created_date, deadline, final_date, status) VALUES ('d1','Asha','A',?,?,?,'Completed')").bind(`${day(-3)} 10:00:00`, day(1), `${day(0)} 10:00:00`),
      env.DB.prepare("INSERT INTO delegations (task_id, name, task_name, created_date, deadline, final_date, status) VALUES ('d2','Asha','B',?,?,?,'Completed')").bind(`${day(-3)} 10:00:00`, day(-2), `${day(2)} 10:00:00`),
      env.DB.prepare("INSERT INTO delegations (task_id, name, task_name, created_date, deadline, status) VALUES ('d3','Asha','C',?,?,'Pending')").bind(`${day(-3)} 10:00:00`, day(-2)),
    ]);
    const d = await call("GET", `/api/allDashboard/all-dashboard?month=3&week=2&selectedName=Asha`, { token: admin });
    const del = d.json.data[0].delegation;
    expect(del).toEqual({ totalWork: 3, completedWork: 2, pendingWork: 1, onTimeWork: 1, pendingPercent: "33.33", delayPercent: "50.00" });
  });
});

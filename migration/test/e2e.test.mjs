// End-to-end rehearsal of the migration:
//   fixtures → transform.mjs → local D1 (wrangler) → running Worker → real API calls.
// Run: npm test   (from migration/)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { makeFixtures } from "./make-fixtures.mjs";

const here = import.meta.dirname;
const apiDir = path.resolve(here, "../../api");
let work, persist, server, verifyOut = "";
const PORT = 8799;
const base = `http://127.0.0.1:${PORT}`;

const wrangler = (args) => execFileSync("npx", ["wrangler", ...args], { cwd: apiDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

before(async () => {
  const busy = await fetch(`${base}/health`).then(() => true, () => false);
  if (busy) throw new Error(`Port ${PORT} already in use (stale wrangler dev?) — stop it first`);
  work = await mkdtemp(path.join(tmpdir(), "epil-mig-"));
  persist = path.join(work, "state");
  await makeFixtures(work);
  execFileSync("node", [path.resolve(here, "../transform.mjs")], { env: { ...process.env, MIGRATION_DIR: work }, stdio: "inherit" });
  wrangler(["d1", "migrations", "apply", "epil-db", "--local", `--persist-to=${persist}`]);
  wrangler(["d1", "execute", "epil-db", "--local", `--persist-to=${persist}`, "--file", path.join(work, "seed.sql")]);
  // verify must run before `wrangler dev` holds the local SQLite file
  verifyOut = execFileSync("node", [path.resolve(here, "../verify.mjs"), "--local", `--persist-to=${persist}`], { env: { ...process.env, MIGRATION_DIR: work }, encoding: "utf8" });
  server = spawn("npx", ["wrangler", "dev", "--port", String(PORT), "--ip", "127.0.0.1", `--persist-to=${persist}`,
    "--var", "JWT_SECRET:e2e-secret", "--var", "FILE_URL_SECRET:e2e-files"], { cwd: apiDir, stdio: "ignore", detached: true });
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${base}/health`)).ok) return; } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("wrangler dev did not start");
});

after(async () => {
  if (server?.pid) { try { process.kill(-server.pid, "SIGTERM"); } catch { /* already gone */ } }
  if (work) await rm(work, { recursive: true, force: true });
});

const api = async (method, p, token, body) => {
  const r = await fetch(`${base}${p}`, { method, headers: { ...(token && { Authorization: `Bearer ${token}` }), ...(body && { "Content-Type": "application/json" }) }, body: body && JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => null) };
};
const login = async (id, admin) => { const r = await api("POST", admin ? "/api/adminauth/admin/login" : "/api/auth/login", null, { employeeID: id, password: "legacy123" }); if (!r.json?.token) console.error("LOGIN FAILED", r.status, JSON.stringify(r.json)); return r.json?.token; };

test("report flags every messy legacy row", async () => {
  const report = JSON.parse(await readFile(path.join(work, "report.json"), "utf8"));
  const problems = report.issues.map((i) => i.problem).join("\n");
  assert.match(problems, /Duplicate EmployeeID e2BBBB/);
  assert.match(problems, /Duplicate TaskID d1/);
  assert.match(problems, /Duplicate slot/);
  assert.match(problems, /Duplicate TicketID #00002/);
  assert.match(problems, /Invalid frequency "Fortnightly"/);
  assert.match(problems, /unknown\/deleted template "TMP-9"/);
  assert.equal(report.counts.users, 4);
  assert.equal(report.unmigratedFiles, 3); // no file-map in this rehearsal
});

test("verify.mjs confirms D1 row counts match the report", () => {
  assert.match(verifyOut, /All row counts match/);
});

test("legacy bcrypt passwords still work for employees and admins", async () => {
  assert.ok(await login("e1AAAA"));
  assert.ok(await login("a1ZZZZ", true));
});

test("migrated data is served through the original API contract", async () => {
  const asha = await login("e1AAAA");
  const admin = await login("a1ZZZZ", true);

  const del = (await api("GET", "/api/delegations", asha)).json;
  assert.equal(del.length, 2);
  assert.deepEqual(del.find((d) => d.TaskID === "d2"), { TaskID: "d2", Name: "Asha", TaskName: "Bank recon", CreatedDate: "02/03/2026 10:00:00", Deadline: "03/03/2026", Revision1: "04/03/2026", Revision2: "", FinalDate: "", Revisions: 1, Priority: "Low", Status: "Shifted", Followup: "Ritesh", Taskcompletedapproval: "Pending" });

  // Consolidated done-date merged into Master.Actual → c1 no longer open
  const open = (await api("GET", "/api/checklist", asha)).json;
  assert.deepEqual(open.map((c) => c.TaskID), ["c2"]);

  // Support ticket group from identical legacy Issue text moves together
  const ravi = await login("e2BBBB");
  const done = await api("PATCH", `/api/support-tickets/status/${encodeURIComponent("#00001")}`, ravi, { Status: "Done" });
  assert.equal(done.json.message, "Updated 2 ticket(s)");

  // Sequential IDs continue after the highest legacy number (#00007)
  const t = await api("POST", "/api/helpTickets/create", asha, { AssignedTo: "Ravi", Issue: "New" });
  assert.equal(t.json.ticketID, "#00008");

  // Training: legacy numeric view counts (4) are honoured; COMMON template assigned
  const my = (await api("GET", "/api/training/my", asha)).json;
  assert.deepEqual(my.records.map((r) => r.TemplateId), ["TMP-1"]);
  assert.equal(my.records[0].Status, "In Progress");

  // Designation fallback filled Meena's blank designation from the row
  const emps = (await api("GET", "/api/employee/all", admin)).json;
  assert.equal(emps.length, 3);
  assert.ok(emps.find((e) => e.name === "Meena").Designation);

  const em = (await api("GET", "/api/em-sheet/em-sheet", admin)).json;
  assert.equal(em.data.weekInfo, "WEEK NO.-09 (02/03 TO 08/03)");
  assert.equal(em.data.employees[0].withoutDelegation.totalTask, 10);

  const feats = (await api("GET", "/api/additionalFeature/all", asha)).json;
  assert.equal(feats[0].FeatureName, "Tally");
});

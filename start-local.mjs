#!/usr/bin/env node
// One-command local run: API (8787) + Doer portal (3000) + Admin portal (3001).
// First run creates a demo database with sample data. Works on Windows, macOS, Linux.
//   node start-local.mjs            start (seed demo data if no database yet)
//   node start-local.mjs --reset    wipe the local database and re-seed
import { spawn, execSync } from "node:child_process";
import { existsSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = import.meta.dirname;
const api = path.join(root, "api");
const state = path.join(root, ".wrangler", "demo");
const wrangler = path.join(api, "node_modules", ".bin", process.platform === "win32" ? "wrangler.cmd" : "wrangler");
const run = (cmd, cwd) => execSync(cmd, { cwd, stdio: "inherit", shell: true });

if (!existsSync(wrangler)) {
  console.log("Installing API dependencies (first run only)...");
  run("npm ci", api);
}
for (const app of ["doer", "admin"]) {
  if (!existsSync(path.join(root, "frontend", app, "build", "index.html"))) {
    console.log(`Building ${app} portal (first run only)...`);
    run("npm ci --legacy-peer-deps", path.join(root, "frontend", app));
    execSync("npm run build", { cwd: path.join(root, "frontend", app), stdio: "inherit", shell: true,
      env: { ...process.env, REACT_APP_BASE_URL: "http://localhost:8787", CI: "false", GENERATE_SOURCEMAP: "false" } });
  }
}

if (process.argv.includes("--reset")) rmSync(state, { recursive: true, force: true });
if (!existsSync(path.join(state, "seed.sql"))) {
  console.log("Creating demo database with sample data...");
  mkdirSync(state, { recursive: true });
  const { makeFixtures } = await import("./migration/test/make-fixtures.mjs");
  await makeFixtures(state);
  execSync(`node "${path.join(root, "migration", "transform.mjs")}"`, { env: { ...process.env, MIGRATION_DIR: state }, stdio: "ignore", shell: true });
  run(`"${wrangler}" d1 migrations apply epil-db --local --persist-to="${path.join(state, "state")}"`, api);
  run(`"${wrangler}" d1 execute epil-db --local --persist-to="${path.join(state, "state")}" --file="${path.join(state, "seed.sql")}"`, api);
  writeFileSync(path.join(state, "README.txt"), "Local demo database. Delete this folder (or use --reset) to start fresh.\n");
}

const procs = [
  ["API  ", api, ["dev", "--port", "8787", `--persist-to=${path.join(state, "state")}`, "--var", "JWT_SECRET:local-dev-secret", "--var", "FILE_URL_SECRET:local-dev-files"]],
  ["DOER ", path.join(root, "frontend", "doer"), ["dev", "--port", "3000", "--inspector-port", "9232"]],
  ["ADMIN", path.join(root, "frontend", "admin"), ["dev", "--port", "3001", "--inspector-port", "9231"]],
].map(([label, cwd, args]) => {
  const p = spawn(`"${wrangler}"`, args, { cwd, shell: true });
  const out = (d) => String(d).split("\n").filter((l) => /ready on|✘|\[ERROR\]/i.test(l)).forEach((l) => console.log(`[${label}] ${l.trim()}`));
  p.stdout.on("data", out);
  p.stderr.on("data", out);
  return p;
});

console.log(`
  EPIL portal running locally:
    Doer portal   http://localhost:3000   (login e1AAAA / legacy123)
    Admin portal  http://localhost:3001   (login a1ZZZZ / legacy123)
    API           http://localhost:8787/health
  Press Ctrl+C to stop.
`);
process.on("SIGINT", () => { procs.forEach((p) => p.kill()); process.exit(0); });

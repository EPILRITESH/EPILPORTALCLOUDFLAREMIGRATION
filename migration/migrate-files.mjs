#!/usr/bin/env node
// STEP 2 — Copy every Cloudinary file referenced anywhere in the exported sheets
// into the private R2 bucket and write out/file-map.json  { "<cloudinary url>": "r2:<key>" }.
// Idempotent & resumable: URLs already in the map are skipped.
//
// Env: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET (default epil-files)
//      (create an R2 API token with "Object Read & Write" on the bucket)
// Usage: node --env-file=.env.migration migrate-files.mjs [--dry-run]
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { AwsClient } from "aws4fetch";
import { loadGrid, isCloudinary } from "./lib.mjs";
import { SOURCES } from "./sources.mjs";

const DIR = process.env.MIGRATION_DIR || "out";
const DRY = process.argv.includes("--dry-run");
const MAP_FILE = `${DIR}/file-map.json`;
const CONCURRENCY = 6;

const urls = new Set();
for (const s of SOURCES) {
  const { rows } = await loadGrid(DIR, s.key);
  for (const r of rows) for (const c of r) if (isCloudinary(c)) urls.add(String(c).trim());
}
const map = existsSync(MAP_FILE) ? JSON.parse(await readFile(MAP_FILE, "utf8")) : {};
const todo = [...urls].filter((u) => !map[u]);
console.log(`Found ${urls.size} Cloudinary files, ${todo.length} still to copy${DRY ? " (dry run)" : ""}.`);
if (DRY || !todo.length) process.exit(0);

const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY } = process.env;
const BUCKET = process.env.R2_BUCKET || "epil-files";
if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
  console.error("R2_ACCOUNT_ID, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY are required");
  process.exit(1);
}
const r2 = new AwsClient({ accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY, service: "s3", region: "auto" });
const endpoint = `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${BUCKET}`;

/** res.cloudinary.com/<cloud>/image/upload/v123/folder/name.jpg → legacy/cloudinary/folder/name.jpg */
function keyFor(url) {
  const u = new URL(url);
  const parts = u.pathname.split("/").filter(Boolean);
  const up = parts.indexOf("upload");
  let rest = up >= 0 ? parts.slice(up + 1) : parts.slice(1);
  if (rest[0] && /^v\d+$/.test(rest[0])) rest = rest.slice(1);
  return `legacy/cloudinary/${rest.map(decodeURIComponent).join("/")}`;
}

const failures = [];
let done = 0;
async function copy(url) {
  try {
    const src = await fetch(url);
    if (!src.ok) throw new Error(`download ${src.status}`);
    const body = new Uint8Array(await src.arrayBuffer());
    const key = keyFor(url);
    const put = await r2.fetch(`${endpoint}/${key.split("/").map(encodeURIComponent).join("/")}`, {
      method: "PUT",
      body,
      headers: { "Content-Type": src.headers.get("content-type") || "application/octet-stream", "x-amz-meta-source-url": url.slice(0, 1000) },
    });
    if (!put.ok) throw new Error(`upload ${put.status} ${await put.text()}`);
    map[url] = `r2:${key}`;
  } catch (e) {
    failures.push({ url, error: e.message });
  }
  if (++done % 25 === 0) {
    await writeFile(MAP_FILE, JSON.stringify(map, null, 1));
    console.log(`  ${done}/${todo.length}`);
  }
}

const queue = [...todo];
await Promise.all(Array.from({ length: CONCURRENCY }, async () => { while (queue.length) await copy(queue.shift()); }));
await writeFile(MAP_FILE, JSON.stringify(map, null, 1));
await writeFile(`${DIR}/file-failures.json`, JSON.stringify(failures, null, 2));
console.log(`Copied ${todo.length - failures.length}/${todo.length}. Failures: ${failures.length} (see ${DIR}/file-failures.json — re-run to retry).`);
if (failures.length) process.exit(2);

// Copy the shared FMS components into both portals (CRA can only import from its own src/).
// Edit files in frontend/shared/fms, then run:  node frontend/sync-shared.mjs
import { cpSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";

const root = path.dirname(new URL(import.meta.url).pathname);
for (const app of ["admin", "doer"]) {
  const dest = path.join(root, app, "src", "fms", "shared");
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  cpSync(path.join(root, "shared", "fms"), dest, { recursive: true });
  console.log(`shared/fms → ${app}/src/fms/shared`);
}

// Small helpers shared by the FMS routers.
import type { Context } from "hono";
import type { AppEnv } from "../../types";
import { isAdmin } from "../../middleware/auth";
import { fail } from "../util";
import { fmsVisible, loadBundle, type Actor, type Bundle } from "./engine";

export const actor = (c: Context<AppEnv>): Actor => c.get("user");

export const idParam = (c: Context<AppEnv>, name = "id") => {
  const n = Number(c.req.param(name));
  if (!Number.isInteger(n) || n <= 0) fail(400, "Invalid id");
  return n;
};

export const page = (c: Context<AppEnv>, maxLimit = 200) => {
  const limit = Math.min(maxLimit, Math.max(1, Number(c.req.query("limit")) || 25));
  const p = Math.max(1, Number(c.req.query("page")) || 1);
  return { limit, offset: (p - 1) * limit, page: p };
};

export async function bundleOr404(c: Context<AppEnv>, id: number): Promise<Bundle> {
  const b = await loadBundle(c.env, id);
  if (!b || (b.def.deleted && !isAdmin(c))) fail(404, "FMS not found");
  return b;
}

export function mustView(c: Context<AppEnv>, b: Bundle) {
  if (!fmsVisible(b, actor(c)).view) fail(403, "You do not have access to this FMS");
}

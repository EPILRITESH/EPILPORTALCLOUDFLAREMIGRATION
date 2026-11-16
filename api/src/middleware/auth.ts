import type { Context, MiddlewareHandler } from "hono";
import { sign, verify } from "hono/jwt";
import type { AppEnv, Env, Role, SessionUser } from "../types";

const TOKEN_TTL_SECONDS = 2 * 24 * 3600; // legacy: expiresIn "2d"

export async function issueToken(env: Env, u: SessionUser): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return sign({ ...u, iat: now, exp: now + TOKEN_TTL_SECONDS }, env.JWT_SECRET, "HS256");
}

const unauthorized = (c: Context, error: string) => c.json({ error }, 401);

/** Equivalent of legacy middleware/auth.js, plus role awareness. */
export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const header = c.req.header("Authorization") || "";
  const token = header.split(" ")[1];
  if (!token || token === "undefined" || token === "null") return unauthorized(c, "Unauthorized");
  try {
    const p = (await verify(token, c.env.JWT_SECRET, "HS256")) as Record<string, unknown>;
    const role: Role = p.role === "admin" ? "admin" : "employee";
    c.set("user", {
      employeeID: String(p.employeeID || ""),
      name: String(p.name || ""),
      department: String(p.department || ""),
      designation: String(p.designation || ""),
      role,
    });
  } catch {
    return unauthorized(c, "Invalid token");
  }
  await next();
};

/** Admin-only routes. Must run after requireAuth. */
export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.get("user")?.role !== "admin") return c.json({ error: "Admin access required" }, 403);
  await next();
};

export const isAdmin = (c: Context<AppEnv>) => c.get("user")?.role === "admin";

/**
 * Non-admins may only act on their own name. Returns the name to use:
 * admins get `requested` (or fall back to their own), employees always get themselves
 * unless they explicitly ask for someone else, which is rejected.
 */
export function scopedName(c: Context<AppEnv>, requested: unknown): string | null {
  const me = c.get("user").name;
  const r = typeof requested === "string" ? requested.trim() : "";
  if (isAdmin(c)) return r || me;
  if (!r || r.replace(/\s+/g, " ").toLowerCase() === me.replace(/\s+/g, " ").trim().toLowerCase()) return me;
  return null;
}

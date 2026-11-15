import type { Env } from "../types";

/** Best-effort audit trail; never blocks or fails the request. */
export async function audit(env: Env, actor: string, action: string, entity: string, entityId = "", detail: unknown = ""): Promise<void> {
  try {
    await env.DB.prepare("INSERT INTO audit_log (actor, action, entity, entity_id, detail) VALUES (?, ?, ?, ?, ?)")
      .bind(actor, action, entity, entityId, typeof detail === "string" ? detail : JSON.stringify(detail))
      .run();
  } catch (e) {
    console.error("audit failed", (e as Error).message);
  }
}

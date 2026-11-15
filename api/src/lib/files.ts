import type { Context } from "hono";
import type { AppEnv, Env } from "../types";
import { fail, nanoid } from "./util";

// Files live in a PRIVATE R2 bucket. The database stores "r2:<key>".
// Clients receive short-lived HMAC-signed URLs served by GET /files/<key>.
// Values that are already http(s) URLs (legacy Cloudinary not yet migrated)
// are passed through untouched.

const ALLOWED = /^(image\/(jpeg|jpg|png|gif|webp)|application\/pdf)$/;
const EXT: Record<string, string> = {
  "image/jpeg": "jpg", "image/jpg": "jpg", "image/png": "png",
  "image/gif": "gif", "image/webp": "webp", "application/pdf": "pdf",
};
const URL_TTL_SECONDS = 7 * 24 * 3600;
const enc = new TextEncoder();

async function hmacHex(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Validate and store an uploaded File. Returns "r2:<key>" or "" when no file. */
export async function storeUpload(env: Env, file: unknown, folder: string): Promise<string> {
  if (!(file instanceof File) || file.size === 0) return "";
  const max = parseInt(env.MAX_UPLOAD_BYTES || "5242880", 10);
  if (file.size > max) fail(400, "Image too large (max 5MB). Please compress below 2MB and retry.");
  if (!ALLOWED.test(file.type)) {
    fail(400, "Only JPG, PNG, GIF, WEBP or PDF allowed (max 5MB). NOTE: iPhone HEIC photos are NOT supported - please send as JPG/screenshot.");
  }
  const now = new Date();
  const key = `${folder}/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, "0")}/${nanoid(16)}.${EXT[file.type] || "bin"}`;
  await env.FILES.put(key, file.stream(), {
    httpMetadata: { contentType: file.type },
    customMetadata: { originalName: file.name.slice(0, 200) },
  });
  return `r2:${key}`;
}

/** Turn a stored file reference into a URL the browser can load. */
export async function publicFileUrl(c: Context<AppEnv>, ref: string): Promise<string> {
  if (!ref || !ref.startsWith("r2:")) return ref || "";
  const key = ref.slice(3);
  const exp = Math.floor(Date.now() / 1000) + URL_TTL_SECONDS;
  const sig = await hmacHex(c.env.FILE_URL_SECRET, `${key}|${exp}`);
  const base = c.env.PUBLIC_API_URL || new URL(c.req.url).origin;
  return `${base}/files/${key.split("/").map(encodeURIComponent).join("/")}?exp=${exp}&sig=${sig}`;
}

/** GET /files/<key>?exp=&sig= */
export async function serveFile(c: Context<AppEnv>): Promise<Response> {
  const key = decodeURIComponent(c.req.path.replace(/^\/files\//, ""));
  const exp = parseInt(c.req.query("exp") || "0", 10);
  const sig = c.req.query("sig") || "";
  if (!key || !exp || exp < Date.now() / 1000) return c.json({ error: "Link expired" }, 403);
  const expected = await hmacHex(c.env.FILE_URL_SECRET, `${key}|${exp}`);
  if (sig.length !== expected.length || sig !== expected) return c.json({ error: "Invalid signature" }, 403);
  const obj = await c.env.FILES.get(key);
  if (!obj) return c.json({ error: "Not found" }, 404);
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("etag", obj.httpEtag);
  headers.set("Cache-Control", "private, max-age=86400");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(obj.body, { headers });
}

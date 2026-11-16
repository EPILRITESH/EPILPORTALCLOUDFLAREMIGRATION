import type { Context } from "hono";
import type { AppEnv, Env } from "../types";
import { fail, nanoid } from "./util";

// Two storage back-ends, chosen by env.FILE_STORAGE:
//  - "cloudinary" (default): signed upload to Cloudinary; the database stores the public
//    https URL, exactly like the legacy system. Requires CLOUDINARY_* secrets.
//  - "r2": private R2 bucket; the database stores "r2:<key>" and clients receive short-lived
//    HMAC-signed URLs served by GET /files/<key>.
// Stored http(s) URLs are always passed through untouched.

const ALLOWED = /^(image\/(jpeg|jpg|png|gif|webp)|application\/pdf)$/;
const EXT: Record<string, string> = {
  "image/jpeg": "jpg", "image/jpg": "jpg", "image/png": "png",
  "image/gif": "gif", "image/webp": "webp", "application/pdf": "pdf",
};
// FMS attachments may also be office documents / CSV
const DOCS = /^(application\/(vnd\.openxmlformats-officedocument\.(spreadsheetml\.sheet|wordprocessingml\.document|presentationml\.presentation)|vnd\.ms-excel|msword)|text\/(csv|plain))$/;
const DOC_EXT: Record<string, string> = {
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx", "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx", "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx", "text/csv": "csv", "text/plain": "txt",
};
const URL_TTL_SECONDS = 7 * 24 * 3600;
const enc = new TextEncoder();

async function hmacHex(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha1Hex(data: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-1", enc.encode(data));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Signed upload to Cloudinary (https://cloudinary.com/documentation/authentication_signatures). */
async function uploadToCloudinary(env: Env, file: File, folder: string): Promise<string> {
  const cloud = env.CLOUDINARY_CLOUD_NAME, key = env.CLOUDINARY_API_KEY, secret = env.CLOUDINARY_API_SECRET;
  if (!cloud || !key || !secret) fail(503, "Image service not configured on server (Cloudinary keys missing). Ticket without image create karo ya admin se contact karo.");
  const params: Record<string, string> = {
    folder: env.CLOUDINARY_FOLDER || "employee_documents",
    public_id: `${folder}_${Date.now()}_${nanoid(6)}`,
    timestamp: String(Math.floor(Date.now() / 1000)),
  };
  const toSign = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join("&");
  const form = new FormData();
  form.append("file", file);
  for (const [k, v] of Object.entries(params)) form.append(k, v);
  form.append("api_key", key);
  form.append("signature", await sha1Hex(toSign + secret));
  let res: Response;
  try {
    res = await fetch(`https://api.cloudinary.com/v1_1/${cloud}/auto/upload`, { method: "POST", body: form, signal: AbortSignal.timeout(25_000) });
  } catch (e) {
    fail(502, `Image upload failed: ${(e as Error).message}`, { hint: "2MB se chhoti JPG/PNG try karo, ya bina image ke ticket banao." });
  }
  const data = (await res.json().catch(() => ({}))) as { secure_url?: string; url?: string; error?: { message?: string } };
  if (!res.ok || !(data.secure_url || data.url)) {
    fail(502, `Image upload failed: ${data.error?.message || `Cloudinary HTTP ${res.status}`}`, { hint: "2MB se chhoti JPG/PNG try karo, ya bina image ke ticket banao." });
  }
  return (data.secure_url || data.url)!;
}

/** Validate and store an uploaded File. Returns the stored reference ("" when no file). */
export async function storeUpload(env: Env, file: unknown, folder: string, opts: { allowDocs?: boolean } = {}): Promise<string> {
  if (!(file instanceof File) || file.size === 0) return "";
  const max = parseInt(env.MAX_UPLOAD_BYTES || "5242880", 10);
  if (file.size > max) fail(400, opts.allowDocs ? "File too large (max 5MB)." : "Image too large (max 5MB). Please compress below 2MB and retry.");
  if (opts.allowDocs && !ALLOWED.test(file.type) && !DOCS.test(file.type)) fail(400, "Allowed files: images, PDF, Excel, Word, PowerPoint, CSV or text (max 5MB).");
  if (!opts.allowDocs && !ALLOWED.test(file.type)) {
    fail(400, "Only JPG, PNG, GIF, WEBP or PDF allowed (max 5MB). NOTE: iPhone HEIC photos are NOT supported - please send as JPG/screenshot.");
  }
  if ((env.FILE_STORAGE || "cloudinary") !== "r2") return uploadToCloudinary(env, file, folder);
  if (!env.FILES) fail(503, "File storage is not configured (FILE_STORAGE=r2 but no FILES bucket bound).");
  const now = new Date();
  const key = `${folder}/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, "0")}/${nanoid(16)}.${EXT[file.type] || DOC_EXT[file.type] || "bin"}`;
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
  if (!c.env.FILES) return c.json({ error: "Not found" }, 404);
  const obj = await c.env.FILES.get(key);
  if (!obj) return c.json({ error: "Not found" }, 404);
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("etag", obj.httpEtag);
  headers.set("Cache-Control", "private, max-age=86400");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(obj.body, { headers });
}

// Minimal Google Sheets client for Workers: service-account OAuth (RS256 JWT via
// WebCrypto) + the handful of Sheets v4 endpoints the backup sync needs.
import type { Env } from "../types";

const SHEETS = "https://sheets.googleapis.com/v4/spreadsheets";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const enc = new TextEncoder();

const b64url = (data: ArrayBuffer | Uint8Array | string) => {
  const bytes = typeof data === "string" ? enc.encode(data) : new Uint8Array(data);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

let cached: { token: string; exp: number; email: string } | null = null;

export function googleConfigured(env: Env): boolean {
  return !!(env.GOOGLE_SERVICE_ACCOUNT_EMAIL && env.GOOGLE_PRIVATE_KEY);
}

async function accessToken(env: Env): Promise<string> {
  const email = env.GOOGLE_SERVICE_ACCOUNT_EMAIL!;
  const now = Math.floor(Date.now() / 1000);
  if (cached && cached.email === email && cached.exp - 60 > now) return cached.token;
  const pem = env.GOOGLE_PRIVATE_KEY!.replace(/\\n/g, "\n").replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({
    iss: email, scope: "https://www.googleapis.com/auth/spreadsheets", aud: TOKEN_URL, iat: now, exp: now + 3600,
  }));
  const sig = b64url(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, enc.encode(`${header}.${claims}`)));
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${header}.${claims}.${sig}` }),
  });
  const data = (await res.json()) as { access_token?: string; expires_in?: number; error_description?: string };
  if (!res.ok || !data.access_token) throw new Error(`Google auth failed: ${data.error_description || res.status}`);
  cached = { token: data.access_token, exp: now + (data.expires_in || 3600), email };
  return data.access_token;
}

async function call<T>(env: Env, method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${await accessToken(env)}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Sheets ${method} ${url.replace(SHEETS, "")} → ${res.status}: ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

const q = (a1: string) => encodeURIComponent(a1);
export const a1Tab = (tab: string) => `'${tab.replace(/'/g, "''")}'`;

/** Formatted values of several ranges (strings exactly as displayed). */
export async function batchGet(env: Env, id: string, ranges: string[]): Promise<string[][][]> {
  const url = `${SHEETS}/${id}/values:batchGet?valueRenderOption=FORMATTED_VALUE&majorDimension=ROWS&${ranges.map((r) => `ranges=${q(r)}`).join("&")}`;
  const r = await call<{ valueRanges?: { values?: string[][] }[] }>(env, "GET", url);
  return (r.valueRanges || []).map((v) => v.values || []);
}

export async function batchUpdate(env: Env, id: string, data: { range: string; values: unknown[][] }[]): Promise<void> {
  if (!data.length) return;
  await call(env, "POST", `${SHEETS}/${id}/values:batchUpdate`, { valueInputOption: "USER_ENTERED", data });
}

export async function batchClear(env: Env, id: string, ranges: string[]): Promise<void> {
  if (!ranges.length) return;
  await call(env, "POST", `${SHEETS}/${id}/values:batchClear`, { ranges });
}

export async function sheetProps(env: Env, id: string): Promise<Map<string, { sheetId: number; rowCount: number; columnCount: number }>> {
  const r = await call<{ sheets: { properties: { title: string; sheetId: number; gridProperties: { rowCount: number; columnCount: number } } }[] }>(
    env, "GET", `${SHEETS}/${id}?fields=sheets.properties(title,sheetId,gridProperties)`);
  return new Map(r.sheets.map((s) => [s.properties.title, { sheetId: s.properties.sheetId, ...s.properties.gridProperties }]));
}

export async function appendRows(env: Env, id: string, sheetId: number, rows: number): Promise<void> {
  await call(env, "POST", `${SHEETS}/${id}:batchUpdate`, { requests: [{ appendDimension: { sheetId, dimension: "ROWS", length: rows } }] });
}

/** Test hook: forget the cached token. */
export function _resetGoogleTokenCache() { cached = null; }

import bcrypt from "bcryptjs";

// New hashes: PBKDF2-SHA256 via WebCrypto (native, fast on Workers).
// Legacy hashes from Google Sheets are bcrypt ($2a/$2b) and are verified with
// bcryptjs, then transparently upgraded to PBKDF2 on the next successful login.

const ITERATIONS = 100_000; // Workers' WebCrypto maximum for PBKDF2
const enc = new TextEncoder();

const toB64 = (buf: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  return crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const bits = await derive(password, salt, ITERATIONS);
  return `pbkdf2$${ITERATIONS}$${toB64(salt)}$${toB64(bits)}`;
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export function isLegacyHash(hash: string): boolean {
  return /^\$2[aby]\$/.test(hash);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  if (!hash) return false;
  if (isLegacyHash(hash)) return bcrypt.compare(password, hash);
  const [scheme, iter, saltB64, hashB64] = hash.split("$");
  if (scheme !== "pbkdf2" || !iter || !saltB64 || !hashB64) return false;
  const bits = await derive(password, fromB64(saltB64), parseInt(iter, 10));
  return timingSafeEqual(new Uint8Array(bits), fromB64(hashB64));
}

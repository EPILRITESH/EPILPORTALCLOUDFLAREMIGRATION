import { HTTPException } from "hono/http-exception";

const ALPHABET = "useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict"; // nanoid url alphabet

/** nanoid-compatible random ID (same alphabet and default semantics). */
export function nanoid(size = 21): string {
  const bytes = crypto.getRandomValues(new Uint8Array(size));
  let id = "";
  for (let i = 0; i < size; i++) id += ALPHABET[bytes[i] & 63];
  return id;
}

/** Throw a JSON error response: `{ error }` with the given status. */
export function fail(status: 400 | 401 | 403 | 404 | 409 | 413 | 415 | 500 | 502 | 503, error: string, extra: Record<string, unknown> = {}): never {
  throw new HTTPException(status, {
    res: new Response(JSON.stringify({ error, ...extra }), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  });
}

export const str = (v: unknown): string => (v === undefined || v === null ? "" : String(v));
/**
 * Person names are matched ignoring case and extra whitespace: the legacy sheets contain
 * "Mohammad Sami " (trailing space), "Muskan  Khan" (double space), "chandani Rai" (case).
 */
export const normName = (v: unknown): string => str(v).replace(/\s+/g, " ").trim().toLowerCase();
export const sameName = (a: unknown, b: unknown): boolean => normName(a) === normName(b);
/** SQL twin of normName() for a column — bind normName(value) against it. Keep in sync with migration 0004. */
export const NAME_SQL = (col: string): string => `lower(trim(replace(replace(replace(${col}, char(9), ' '), '  ', ' '), '  ', ' ')))`;
export const lc = normName;

export function parseNum(v: unknown): number {
  const n = parseInt(str(v) || "0", 10);
  return isNaN(n) ? 0 : n;
}

/** Read a JSON body without throwing on an empty/invalid body. */
export async function jsonBody<T = Record<string, any>>(req: { json: () => Promise<unknown> }): Promise<T> {
  try {
    const b = await req.json();
    return (b && typeof b === "object" ? b : {}) as T;
  } catch {
    return {} as T;
  }
}

export function percent(part: number, total: number): string {
  return total ? ((part / total) * 100).toFixed(2) : "0.00";
}

// Small helpers shared by every route: crypto, errors, cursors, JSON columns.

const encoder = new TextEncoder();

export const now = () => Date.now();
export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(input));
  return toHex(new Uint8Array(digest));
}

export async function hmacSha256Hex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return toHex(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(body))));
}

export function toHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

/** Constant-time string comparison (both sides are hashed first so lengths never leak). */
export async function safeEqual(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([sha256Hex(a), sha256Hex(b)]);
  return crypto.subtle.timingSafeEqual(encoder.encode(ha), encoder.encode(hb));
}

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** Unbiased random string over an alphabet (rejection sampling). */
export function randomString(length: number, alphabet = BASE62): string {
  const limit = 256 - (256 % alphabet.length);
  let out = "";
  while (out.length < length) {
    for (const b of crypto.getRandomValues(new Uint8Array(length * 2))) {
      if (b < limit) out += alphabet[b % alphabet.length];
      if (out.length === length) break;
    }
  }
  return out;
}

/** 32 random bytes, base64url. Used for magic links, sessions, device codes and invites. */
export function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export class HttpError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 422 | 428 | 429 | 500,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const badRequest = (message: string, code = "bad_request") => new HttpError(400, code, message);
export const notFound = (what = "resource") => new HttpError(404, "not_found", `${what} not found`);
export const forbidden = (message = "insufficient role") => new HttpError(403, "forbidden", message);

export function errorBody(code: string, message: string) {
  return { error: { code, message } };
}

// Cursors are opaque to clients: base64url JSON of the last row's sort key.
export function encodeCursor(values: (string | number)[]): string {
  return btoa(JSON.stringify(values)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeCursor(cursor: string | undefined | null): (string | number)[] | null {
  if (!cursor) return null;
  try {
    const v = JSON.parse(atob(cursor.replace(/-/g, "+").replace(/_/g, "/")));
    if (Array.isArray(v) && v.every((x) => typeof x === "string" || typeof x === "number")) return v;
  } catch {
    // fall through
  }
  throw badRequest("invalid cursor");
}

export function parseLimit(raw: string | undefined, def = 50, max = 200): number {
  if (raw === undefined || raw === "") return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw badRequest("limit must be a positive integer");
  return Math.min(n, max);
}

/** Turns `limit + 1` fetched rows into a page. */
export function page<T>(rows: T[], limit: number, key: (row: T) => (string | number)[]) {
  const items = rows.slice(0, limit);
  const next_cursor = rows.length > limit ? encodeCursor(key(items[items.length - 1])) : null;
  return { items, next_cursor };
}

export function parseJson<T>(s: string | null | undefined, fallback: T): T {
  if (s == null) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

/** Accepts epoch ms or an ISO string from a query parameter. */
export function parseTime(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined || raw === "") return undefined;
  const n = /^\d+$/.test(raw) ? Number(raw) : Date.parse(raw);
  if (!Number.isFinite(n)) throw badRequest(`${name} must be epoch ms or an ISO 8601 time`);
  return n;
}

export function parseEnv(raw: string | undefined): "test" | "live" {
  if (raw === undefined || raw === "" || raw === "test") return "test";
  if (raw === "live") return "live";
  throw badRequest("env must be test or live");
}

/** Escapes LIKE wildcards; use with `ESCAPE '\\'`. */
export const likePrefix = (q: string) => q.replace(/[\\%_]/g, (m) => `\\${m}`) + "%";

export async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const v = await req.json();
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw badRequest("body must be a JSON object");
}

export function str(body: Record<string, unknown>, key: string, opts: { required?: boolean; max?: number } = {}): string | undefined {
  const v = body[key];
  if (v === undefined || v === null || v === "") {
    if (opts.required) throw badRequest(`${key} is required`);
    return undefined;
  }
  if (typeof v !== "string") throw badRequest(`${key} must be a string`);
  const t = v.trim();
  if (opts.max && t.length > opts.max) throw badRequest(`${key} must be at most ${opts.max} chars`);
  if (opts.required && !t) throw badRequest(`${key} is required`);
  return t;
}

export const isEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length <= 254;

export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "project"
  );
}

/** The public origin for links in emails and device login. APP_URL wins; otherwise the request's origin. */
export function appOrigin(env: Env, req?: Request): string {
  if (env.APP_URL) return env.APP_URL.replace(/\/+$/, "");
  if (req) return new URL(req.url).origin;
  return "http://localhost:8787";
}

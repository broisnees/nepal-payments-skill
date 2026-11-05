import { CSRF_HEADER, type Page } from "@paynp/shared";

export class ApiFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

type Method = "GET" | "POST" | "PATCH" | "DELETE";
const unauthorized = new Set<() => void>();

/** Called when any request answers 401, so the app can send the browser to sign-in. */
export function onUnauthorized(fn: () => void): () => void {
  unauthorized.add(fn);
  return () => unauthorized.delete(fn);
}

/** Same-origin JSON fetch. State-changing requests carry the CSRF header; cookies ride along by default. */
export async function api<T>(path: string, opts: { method?: Method; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const method = opts.method ?? "GET";
  const headers: Record<string, string> = { accept: "application/json" };
  if (method !== "GET") headers[CSRF_HEADER] = "1";
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(path, {
    method,
    headers,
    credentials: "same-origin",
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    signal: opts.signal,
  });
  if (res.status === 401 && !path.startsWith("/auth/")) for (const fn of unauthorized) fn();
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const json = text ? safeJson(text) : undefined;
  if (!res.ok) {
    const err = (json as { error?: { code?: string; message?: string } } | undefined)?.error;
    throw new ApiFailure(res.status, err?.code ?? `http_${res.status}`, err?.message ?? res.statusText ?? "Request failed");
  }
  return json as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** List endpoints answer `{items, next_cursor}`; a few may answer a bare array. Accept both. */
export function items<T>(x: Page<T> | T[] | undefined | null): T[] {
  if (!x) return [];
  return Array.isArray(x) ? x : x.items;
}

export function qs(params: Record<string, string | number | null | undefined | false>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "" && v !== false) u.set(k, String(v));
  const s = u.toString();
  return s ? `?${s}` : "";
}

export function errorMessage(e: unknown): string {
  if (e instanceof ApiFailure) return e.message;
  if (e instanceof Error) return e.message;
  return "Something went wrong";
}

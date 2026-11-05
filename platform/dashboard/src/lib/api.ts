import { CSRF_HEADER, type Page } from "@paynp/shared";

export class ApiFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** The whole error body, for errors that carry data (422 with detected headers). */
    readonly body?: unknown,
  ) {
    super(message);
  }
}

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
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
    throw new ApiFailure(res.status, err?.code ?? `http_${res.status}`, err?.message ?? res.statusText ?? "Request failed", json);
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

/** Multipart POST (statement uploads). Same CSRF and error rules as `api`; a failure keeps the parsed body. */
export async function upload<T>(path: string, form: FormData): Promise<T> {
  const res = await fetch(path, { method: "POST", headers: { accept: "application/json", [CSRF_HEADER]: "1" }, credentials: "same-origin", body: form });
  if (res.status === 401) for (const fn of unauthorized) fn();
  const text = await res.text();
  const json = text ? safeJson(text) : undefined;
  if (!res.ok) {
    const err = (json as { error?: { code?: string; message?: string } } | undefined)?.error;
    throw new ApiFailure(res.status, err?.code ?? `http_${res.status}`, err?.message ?? res.statusText ?? "Upload failed", json);
  }
  return json as T;
}

/** Fetches a file the API serves (CSV exports) and hands it to the browser as a download. */
export async function download(path: string, fallbackName: string): Promise<void> {
  const res = await fetch(path, { credentials: "same-origin", headers: { accept: "text/csv, application/json" } });
  if (res.status === 401) for (const fn of unauthorized) fn();
  if (!res.ok) {
    const json = safeJson(await res.text()) as { error?: { code?: string; message?: string } } | undefined;
    throw new ApiFailure(res.status, json?.error?.code ?? `http_${res.status}`, json?.error?.message ?? res.statusText ?? "Download failed");
  }
  const name = /filename="?([^";]+)"?/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? fallbackName;
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function errorMessage(e: unknown): string {
  if (e instanceof ApiFailure) return e.message;
  if (e instanceof Error) return e.message;
  return "Something went wrong";
}

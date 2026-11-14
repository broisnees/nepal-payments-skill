/**
 * HTTP with timeouts. Retries only for idempotent reads (status checks).
 */
import { toBase64, utf8 } from "./encoding.ts";
import { PaymentError } from "./errors.ts";
import type { ProviderId } from "./types.ts";

export interface HttpOptions {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: unknown; // objects are JSON-encoded; strings sent as-is
  timeoutMs?: number;
  retries?: number; // extra attempts on network error / 5xx / 429
}

export interface HttpResponse<T = unknown> {
  status: number;
  data: T;
  text: string;
}

function encodeBody(body: unknown): string | undefined {
  if (body === undefined) return undefined;
  return typeof body === "string" ? body : JSON.stringify(body);
}

/** Accept JSON by default; add a JSON Content-Type only when there is a body and none was given. */
function buildHeaders(headers: Record<string, string>, hasBody: boolean): Record<string, string> {
  const finalHeaders: Record<string, string> = { Accept: "application/json", ...headers };
  const hasContentType = Object.keys(finalHeaders).some((h) => h.toLowerCase() === "content-type");
  if (hasBody && !hasContentType) finalHeaders["Content-Type"] = "application/json";
  return finalHeaders;
}

/** 300 ms, 600 ms, 1.2 s, ... before retry number `attempt` (1-based). */
const backoff = (attempt: number) =>
  new Promise((resolve) => setTimeout(resolve, 300 * 2 ** (attempt - 1)));

const isRetryableStatus = (status: number) => status >= 500 || status === 429;

/** JSON when the body parses, null for an empty body, the raw text otherwise. */
function parseBody(text: string): unknown {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return text; // non-JSON body: keep text
  }
}

export async function http<T = unknown>(
  provider: ProviderId,
  url: string,
  opts: HttpOptions = {},
): Promise<{ status: number; data: T; text: string }> {
  const { method = "GET", headers = {}, body, timeoutMs = 15_000, retries = 0 } = opts;
  const payload = encodeBody(body);
  const finalHeaders = buildHeaders(headers, payload !== undefined);

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt) await backoff(attempt);
    try {
      const res = await fetch(url, {
        method,
        headers: finalHeaders,
        body: payload,
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await res.text();
      if (isRetryableStatus(res.status) && attempt < retries) {
        lastError = new PaymentError(
          `HTTP ${res.status}`,
          provider,
          "upstream_error",
          res.status,
          text,
        );
        continue;
      }
      // The caller states what it expects; adapters keep T = unknown and parse with guards.
      return { status: res.status, data: parseBody(text) as T, text };
    } catch (err) {
      lastError = err;
      if (attempt >= retries) break;
    }
  }
  const reason = lastError instanceof Error ? lastError.message : String(lastError);
  throw new PaymentError(
    `request to ${new URL(url).host} failed: ${reason}`,
    provider,
    "network_error",
    undefined,
    lastError,
  );
}

/** Basic auth header value. */
export const basicAuth = (user: string, pass: string): string =>
  `Basic ${toBase64(utf8(`${user}:${pass}`))}`;

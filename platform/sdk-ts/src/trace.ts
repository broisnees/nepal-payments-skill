// Times the HTTP calls a gateway module makes, without AsyncLocalStorage, so it runs on
// Workers and edge runtimes too.
//
// While at least one wrapped call is running, globalThis.fetch is swapped for a thin wrapper.
// A fetch to a host that belongs to the gateway of exactly one running call is recorded for
// that call. If a fetch goes out while two calls for the same gateway are running, nobody can
// tell whose request it is, so both calls are marked ambiguous and fall back to timing the
// whole call (see wrap.ts). When the last call ends, the original fetch is put back.

export interface RecordedRequest {
  ts: number; // epoch ms at request start
  durationMs: number;
  method: string;
  endpoint: string; // path only
  /** Hostname, used only to tell sandbox from production (gw_env). Never sent. */
  host?: string;
  httpStatus?: number;
  error?: unknown;
}

export interface CallScope {
  hosts: readonly string[];
  requests: RecordedRequest[];
  ambiguous: boolean;
}

/** Hostname suffixes each gateway's modules call (sandbox and production). */
export const GATEWAY_HOSTS: Record<string, readonly string[]> = {
  esewa: ["esewa.com.np"],
  khalti: ["khalti.com"],
  fonepay: ["fonepay.com"],
  connectips: ["connectips.com"],
  cybersource: ["cybersource.com"],
  nps: ["nepalpayment.com"],
  imepay: ["imepay.com.np"],
};

const active = new Set<CallScope>();
let original: typeof fetch | undefined;
let patched: typeof fetch | undefined;

const hostMatches = (host: string, suffixes: readonly string[]) =>
  suffixes.some((s) => host === s || host.endsWith(`.${s}`));

export const now = (): number => (typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now());

/** The fetch the app had before any patching. The SDK's own ingest calls go through this. */
export function baseFetch(): typeof fetch {
  return original ?? globalThis.fetch;
}

function requestParts(input: RequestInfo | URL, init?: RequestInit): { url: URL | null; method: string } {
  let raw: string;
  let method = init?.method;
  if (typeof input === "string") raw = input;
  else if (input instanceof URL) raw = input.href;
  else {
    raw = (input as Request).url;
    method ??= (input as Request).method;
  }
  let url: URL | null = null;
  try {
    url = new URL(raw);
  } catch {
    /* relative URL: not a gateway call */
  }
  return { url, method: (method ?? "GET").toUpperCase() };
}

/**
 * Wraps a fetch so every call is recorded into `onRecord`. Used for the global patch and for
 * paynp.fetch(), which an app can pass to its own gateway code explicitly.
 */
export function recordingFetch(inner: () => typeof fetch, pick: (url: URL | null) => ((r: RecordedRequest) => void) | null): typeof fetch {
  return async function paynpFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const { url, method } = requestParts(input, init);
    const record = pick(url);
    if (!record) return inner()(input, init);
    const ts = Date.now();
    const t0 = now();
    const endpoint = url ? url.pathname : "";
    const host = url ? url.hostname : undefined;
    try {
      const res = await inner()(input, init);
      record({ ts, durationMs: now() - t0, method, endpoint, host, httpStatus: res.status });
      return res;
    } catch (error) {
      record({ ts, durationMs: now() - t0, method, endpoint, host, error });
      throw error;
    }
  } as typeof fetch;
}

function install(): void {
  if (patched && globalThis.fetch === patched) return;
  original = globalThis.fetch;
  patched = recordingFetch(
    () => original!,
    (url) => {
      if (!url) return null;
      const owners = [...active].filter((s) => hostMatches(url.hostname, s.hosts));
      if (owners.length === 0) return null;
      if (owners.length > 1) {
        for (const s of owners) s.ambiguous = true;
        return null;
      }
      const scope = owners[0];
      return (r) => scope.requests.push(r);
    },
  );
  try {
    globalThis.fetch = patched;
  } catch {
    // Some runtimes freeze globals. Then every call falls back to whole-call timing.
    patched = undefined;
    original = undefined;
  }
}

function uninstall(): void {
  if (patched && globalThis.fetch === patched && original) globalThis.fetch = original;
  // If something else replaced fetch after us, leave it alone: our wrapper (if still in its
  // chain) just passes through once no call is active.
  patched = undefined;
  original = undefined;
}

/** Starts recording fetches for one wrapped call. Returns null when the host list is empty. */
export function enter(hosts: readonly string[]): CallScope | null {
  if (hosts.length === 0 || typeof globalThis.fetch !== "function") return null;
  const scope: CallScope = { hosts, requests: [], ambiguous: false };
  if (active.size === 0) install();
  if (!patched) return null;
  active.add(scope);
  return scope;
}

export function leave(scope: CallScope | null): void {
  if (!scope) return;
  active.delete(scope);
  if (active.size === 0) uninstall();
}

/** For tests. */
export const activeScopes = (): number => active.size;

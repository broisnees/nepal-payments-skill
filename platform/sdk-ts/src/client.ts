import { DEFAULT_ENDPOINT, MAX_BATCH_BYTES, MAX_BATCH_EVENTS, newId, validateEvent, type PaymentEvent } from "./shared.ts";
import { baseFetch } from "./trace.ts";
import { VERSION } from "./version.ts";

// 15 events keeps one ingest request under D1's 50-queries-per-invocation limit on the Workers free plan.
const DEFAULT_BATCH = 15;

export interface PaynpOptions {
  /**
   * Ingest key, `pnp_test_...` or `pnp_live_...`. Empty or missing: in production every call is a no-op and nothing
   * touches the network; outside production events go to a running `paynp dev` server if there is one (see `dev`).
   */
  key?: string | null;
  /** Ingest URL. Default: PAYNP_ENDPOINT from the environment, else DEFAULT_ENDPOINT from the shared brand constants. */
  endpoint?: string;
  /**
   * The local dev server, used only when there is no key. Default: on outside production, at `endpoint`, else
   * PAYNP_DEV_URL, else PAYNP_ENDPOINT, else http://localhost:4040. A string sets the URL; false turns it off.
   */
  dev?: boolean | string;
  /** How long an event may wait in the queue before a send. Default 2000. */
  flushIntervalMs?: number;
  /** Events per request, and the queue length that triggers an immediate send. Default 50, max 100. */
  maxBatch?: number;
  /** Events kept in memory while the ingest API is unreachable. Oldest are dropped first. Default 1000. */
  maxQueue?: number;
  /** Called for every send that failed for good and every event that failed validation. Replaces the console warning. */
  onError?: (err: Error) => void;
  /** Transport override (tests, custom agents). Default: the runtime's fetch. */
  fetch?: typeof fetch;
  /** First retry delay; later retries double it. Default 500. */
  retryBaseMs?: number;
}

export type EventInput = Omit<PaymentEvent, "id" | "ts" | "sdk"> & { ts?: string | number };

const RETRIES = 3;
/** Where `paynp dev` listens by default. */
export const DEV_URL = "http://localhost:4040";
/** How long one answer (or silence) from the dev server's /v1/health is trusted. */
export const DEV_PROBE_TTL_MS = 30_000;
const DEV_PROBE_TIMEOUT_MS = 500;
const WARN_EVERY_MS = 60_000;
const SDK_INFO = { name: "@paynp/sdk", version: VERSION, lang: "ts" } as const;

function envVar(name: string): string | undefined {
  try {
    const v = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[name];
    return v || undefined;
  } catch {
    return undefined;
  }
}

/**
 * The dev server to send to when there is no key, or null for a strict no-op. Off in production (NODE_ENV or
 * PAYNP_ENV is "production"), with PAYNP_DEV=0, and on runtimes with no process.env or on Cloudflare Workers
 * unless a URL is given, because a deployed edge function has no localhost to talk to.
 */
export function devTarget(opts: Pick<PaynpOptions, "dev" | "endpoint">): string | null {
  if (opts.dev === false) return null;
  if (envVar("NODE_ENV") === "production" || envVar("PAYNP_ENV") === "production") return null;
  const off = envVar("PAYNP_DEV");
  if (off === "0" || off === "false") return null;
  const explicit = typeof opts.dev === "string" ? opts.dev : (opts.endpoint ?? envVar("PAYNP_DEV_URL"));
  if (!explicit) {
    const nodeLike = (() => {
      try {
        return typeof (globalThis as { process?: { env?: unknown } }).process?.env === "object";
      } catch {
        return false;
      }
    })();
    const workers = (globalThis as { navigator?: { userAgent?: string } }).navigator?.userAgent === "Cloudflare-Workers";
    if (!nodeLike || workers) return null;
  }
  return (explicit ?? envVar("PAYNP_ENDPOINT") ?? DEV_URL).replace(/\/+$/, "");
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The queue and the sender. One per createPaynp() call. */
export class Transport {
  readonly enabled: boolean;
  readonly url: string;
  /** Base URL of the dev server when sending there (no key), else null. */
  readonly dev: string | null;
  private readonly key: string;
  private readonly interval: number;
  private readonly batch: number;
  private readonly cap: number;
  private readonly onError?: (err: Error) => void;
  private readonly fetchImpl?: typeof fetch;
  private readonly retryBase: number;
  private queue: PaymentEvent[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private sending: Promise<void> | undefined;
  private lastWarn = -Infinity;
  private keepalive = true;
  private readonly lastTs = new Map<string, number>();
  private probe: { at: number; up: boolean } | null = null;
  private probing: Promise<boolean> | null = null;
  /** Counters, for tests and debugging. */
  readonly stats = { sent: 0, dropped: 0, invalid: 0, requests: 0 };

  constructor(opts: PaynpOptions) {
    this.key = (opts.key ?? "").trim();
    // With a key: the configured endpoint, as always. Without one: the local dev server, or nothing at all.
    this.dev = this.key ? null : devTarget(opts);
    this.enabled = this.key.length > 0 || this.dev !== null;
    const base = this.dev ?? (opts.endpoint ?? envVar("PAYNP_ENDPOINT") ?? DEFAULT_ENDPOINT).replace(/\/+$/, "");
    this.url = `${base}/v1/events`;
    this.interval = Math.max(0, opts.flushIntervalMs ?? 2000);
    this.batch = Math.min(MAX_BATCH_EVENTS, Math.max(1, Math.floor(opts.maxBatch ?? DEFAULT_BATCH)));
    this.cap = Math.max(1, Math.floor(opts.maxQueue ?? 1000));
    this.onError = opts.onError;
    this.fetchImpl = opts.fetch;
    this.retryBase = Math.max(0, opts.retryBaseMs ?? 500);
  }

  get queued(): number {
    return this.queue.length;
  }

  /** Validates (and redacts) an event, then queues it. Never throws. */
  push(input: EventInput): void {
    if (!this.enabled) return;
    const ts = new Date(this.stamp(input.attempt_id, input.ts === undefined ? Date.now() : new Date(input.ts).getTime()));
    const result = validateEvent({ ...input, id: newId("evt", ts.getTime()), ts: ts.toISOString(), sdk: SDK_INFO });
    if (!result.ok) {
      this.stats.invalid++;
      this.fail(new Error(`paynp: dropped an invalid ${input.type} event: ${result.error}`));
      return;
    }
    this.queue.push(result.event);
    if (this.queue.length > this.cap) {
      const over = this.queue.length - this.cap;
      this.queue.splice(0, over);
      this.stats.dropped += over;
      this.fail(new Error(`paynp: queue full (${this.cap}), dropped ${over} oldest event(s)`));
    }
    if (this.queue.length >= this.batch) void this.flush();
    else this.schedule();
  }

  // Events of one attempt get strictly increasing timestamps (at least 1 ms apart), so a timeline
  // sorted by ts shows them in the order they were recorded even when they share a millisecond.
  private stamp(attemptId: string, ts: number): number {
    if (typeof attemptId !== "string" || Number.isNaN(ts)) return ts;
    const prev = this.lastTs.get(attemptId);
    const out = prev !== undefined && ts <= prev ? prev + 1 : ts;
    this.lastTs.delete(attemptId);
    this.lastTs.set(attemptId, out);
    if (this.lastTs.size > 2000) this.lastTs.delete(this.lastTs.keys().next().value!);
    return out;
  }

  private schedule(): void {
    if (this.timer !== undefined || this.sending) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, this.interval);
    // Never keep a Node process alive just to send telemetry.
    (this.timer as { unref?: () => void }).unref?.();
  }

  /** Sends everything queued, including events added while sending. Resolves once the queue is empty. Never rejects. */
  flush(): Promise<void> {
    if (!this.enabled) return Promise.resolve();
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.sending ??= this.drain().finally(() => {
      this.sending = undefined;
      if (this.queue.length) this.schedule();
    });
    return this.sending;
  }

  private async drain(): Promise<void> {
    if (this.dev !== null && !(await this.devUp())) {
      // No dev server running: drop quietly. Nobody is watching, and the app must not log about it.
      this.stats.dropped += this.queue.length;
      this.queue.length = 0;
      return;
    }
    while (this.queue.length) {
      const batch = this.take();
      await this.send(batch);
    }
  }

  // Up to maxBatch events whose JSON fits the 256 KB request limit.
  private take(): PaymentEvent[] {
    const out: PaymentEvent[] = [];
    let bytes = 16;
    while (out.length < this.batch && this.queue.length) {
      const size = JSON.stringify(this.queue[0]).length + 1;
      if (out.length && bytes + size > MAX_BATCH_BYTES) break;
      bytes += size;
      out.push(this.queue.shift()!);
    }
    return out;
  }

  /**
   * Whether `paynp dev` answers at this.dev: one GET to /v1/health that must say {"mode": "local"} (so a hosted
   * endpoint never counts), cached for 30 s, at most 500 ms, never throws.
   */
  private devUp(): Promise<boolean> {
    if (this.probe && Date.now() - this.probe.at < DEV_PROBE_TTL_MS) return Promise.resolve(this.probe.up);
    this.probing ??= (async () => {
      let up = false;
      try {
        const res = await (this.fetchImpl ?? baseFetch())(`${this.dev}/v1/health`, { method: "GET", signal: AbortSignal.timeout(DEV_PROBE_TIMEOUT_MS) });
        up = res.ok && ((await res.json()) as { mode?: unknown } | null)?.mode === "local";
      } catch {
        up = false;
      }
      this.probe = { at: Date.now(), up };
      this.probing = null;
      return up;
    })();
    return this.probing;
  }

  private async send(events: PaymentEvent[]): Promise<void> {
    const body = JSON.stringify({ events });
    let lastError = "";
    for (let attempt = 0; attempt <= RETRIES; attempt++) {
      if (attempt) await sleep(this.backoff(attempt, lastError));
      let res: Response;
      try {
        res = await this.post(body);
      } catch (err) {
        if (this.dev !== null) {
          // The dev server went away since the probe. Check again on the next flush; no retries, no warning.
          this.probe = { at: Date.now(), up: false };
          this.stats.dropped += events.length;
          return;
        }
        lastError = err instanceof Error ? err.message : String(err);
        continue;
      }
      this.stats.requests++;
      if (res.status === 202 || res.status === 200 || res.status === 400) {
        // 400: the valid events in the batch were still accepted (SPEC section 3).
        if (res.status === 400) {
          const text = await res.text().catch(() => "");
          this.fail(new Error(`paynp: ingest rejected some events: ${text.slice(0, 300)}`));
        } else await res.body?.cancel().catch(() => {});
        this.stats.sent += events.length;
        return;
      }
      const retryAfter = res.headers.get("retry-after");
      await res.body?.cancel().catch(() => {});
      if (res.status === 401 || res.status === 403 || res.status === 413) {
        this.drop(events, `ingest answered HTTP ${res.status}${res.status === 401 ? " (check PAYNP_KEY)" : ""}`);
        return;
      }
      lastError = `HTTP ${res.status}${retryAfter ? `, retry-after ${retryAfter}` : ""}`;
    }
    this.drop(events, `ingest unreachable after ${RETRIES + 1} tries: ${lastError}`);
  }

  private async post(body: string): Promise<Response> {
    const doFetch = this.fetchImpl ?? baseFetch();
    const init: RequestInit = {
      method: "POST",
      headers: this.key ? { "Content-Type": "application/json", Authorization: `Bearer ${this.key}` } : { "Content-Type": "application/json" },
      body,
    };
    if (this.keepalive) {
      try {
        // Spread through a typed variable: some RequestInit typings (Workers) don't list keepalive.
        const withKeepalive: RequestInit & { keepalive: boolean } = { ...init, keepalive: true };
        return await doFetch(this.url, withKeepalive);
      } catch (err) {
        // Runtimes without keepalive support throw on the option itself. Remember and go on without it.
        if (!/keepalive/i.test(String(err))) throw err;
        this.keepalive = false;
      }
    }
    return doFetch(this.url, init);
  }

  // 500 ms, 1 s, 2 s with jitter; a Retry-After in seconds wins when it is longer (capped at 30 s).
  private backoff(attempt: number, lastError: string): number {
    const base = this.retryBase * 2 ** (attempt - 1);
    const m = /retry-after (\d+)/.exec(lastError);
    const hinted = m ? Math.min(30_000, Number(m[1]) * 1000) : 0;
    return Math.max(base + Math.floor(Math.random() * base * 0.2), hinted);
  }

  private drop(events: PaymentEvent[], why: string): void {
    this.stats.dropped += events.length;
    this.fail(new Error(`paynp: dropped ${events.length} event(s): ${why}`));
  }

  private fail(err: Error): void {
    if (this.onError) {
      try {
        this.onError(err);
      } catch {
        /* a throwing onError must not break the payment path */
      }
      return;
    }
    const t = Date.now();
    if (t - this.lastWarn < WARN_EVERY_MS) return;
    this.lastWarn = t;
    console.warn(`${err.message} (further paynp warnings muted for 60 s)`);
  }
}

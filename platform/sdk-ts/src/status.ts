// Live gateway status from status.discerns.app, for a checkout to decide what to offer. Needs no key. Fails open:
// when the status API cannot be reached, every gateway counts as available.
import { baseFetch } from "./trace.ts";

export const STATUS_URL = "https://status.discerns.app";

export type GatewayState = "operational" | "degraded" | "down" | "no_data";
export type CheckoutAction = "show" | "warn" | "disable";

export interface GatewayStatusSummary {
  gateway: string;
  name: string;
  state: GatewayState;
  action: CheckoutAction;
  /** Text for the buyer when the gateway is slow or down. */
  message: string | null;
  error_rate: number | null;
  p95_ms: number | null;
  uptime_90d_pct: number | null;
  url: string;
}

export interface CheckoutPlan {
  /** The gateways asked for, healthy first, down last. */
  order: string[];
  /** The ones to offer (everything not down). */
  available: string[];
  gateways: GatewayStatusSummary[];
}

export interface StatusClientOptions {
  /** Default https://status.discerns.app. */
  url?: string;
  /** How long one answer is reused. Default 30000. */
  ttlMs?: number;
  /** Per request. Default 2000. */
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export interface StatusClient {
  /** Every gateway, or [] when the API is unreachable. */
  all(): Promise<GatewayStatusSummary[]>;
  /** One gateway, or null when unknown or unreachable. */
  get(gateway: string): Promise<GatewayStatusSummary | null>;
  /** False only when the gateway is known to be down right now. */
  isAvailable(gateway: string): Promise<boolean>;
  /** My checkout's gateways in my order, reordered healthy first; unknown ids keep their place at the end. */
  checkout(gateways: string[]): Promise<CheckoutPlan>;
}

const RANK: Record<GatewayState, number> = { operational: 0, no_data: 1, degraded: 2, down: 3 };

export function createStatusClient(opts: StatusClientOptions = {}): StatusClient {
  const url = (opts.url ?? STATUS_URL).replace(/\/+$/, "");
  const ttl = opts.ttlMs ?? 30_000;
  const timeout = opts.timeoutMs ?? 2000;
  let cache: { at: number; list: GatewayStatusSummary[] } | null = null;
  let pending: Promise<GatewayStatusSummary[]> | null = null;

  const load = (): Promise<GatewayStatusSummary[]> => {
    if (cache && Date.now() - cache.at < ttl) return Promise.resolve(cache.list);
    pending ??= (async () => {
      try {
        const res = await (opts.fetch ?? baseFetch())(`${url}/v1/status`, { signal: AbortSignal.timeout(timeout) });
        if (!res.ok) return cache?.list ?? [];
        const body = (await res.json()) as { gateways?: GatewayStatusSummary[] };
        const list = Array.isArray(body.gateways) ? body.gateways : [];
        cache = { at: Date.now(), list };
        return list;
      } catch {
        return cache?.list ?? [];
      } finally {
        pending = null;
      }
    })();
    return pending;
  };

  const get = async (gateway: string) => (await load()).find((g) => g.gateway === gateway.toLowerCase()) ?? null;

  return {
    all: load,
    get,
    isAvailable: async (gateway) => (await get(gateway))?.state !== "down",
    async checkout(gateways) {
      const list = await load();
      const by = new Map(list.map((g) => [g.gateway, g]));
      const ids = [...new Set(gateways.map((g) => g.toLowerCase()))];
      const known = ids.filter((g) => by.has(g));
      const sorted = known.map((g, i) => ({ g: by.get(g)!, i })).sort((a, b) => RANK[a.g.state] - RANK[b.g.state] || a.i - b.i).map((x) => x.g);
      const order = [...sorted.map((g) => g.gateway), ...ids.filter((g) => !by.has(g))];
      return { order, available: order.filter((g) => by.get(g)?.state !== "down"), gateways: sorted };
    },
  };
}

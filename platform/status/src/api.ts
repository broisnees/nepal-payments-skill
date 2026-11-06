// The public status API (v1): what a checkout needs to decide, per gateway, whether to offer it, warn, or switch it off.
import type { GatewayState, GatewayStatus, StatusIncident, StatusReport } from "@paynp/shared";

export const STATE_WINDOW_MIN = 15;

/** What a checkout should do with a gateway's button right now. Unknown (no_data) never blocks a payment. */
export type CheckoutAction = "show" | "warn" | "disable";

export const ACTION: Record<GatewayState, CheckoutAction> = { operational: "show", degraded: "warn", down: "disable", no_data: "show" };

/** Short text a checkout can show next to the button, in the buyer's terms. */
export function buyerMessage(g: Pick<GatewayStatus, "name" | "state">): string | null {
  if (g.state === "down") return `${g.name} is not working right now. Please choose another payment method.`;
  if (g.state === "degraded") return `${g.name} is slow right now. Your payment may take longer than usual.`;
  return null;
}

export interface GatewaySummary {
  gateway: string;
  name: string;
  state: GatewayState;
  action: CheckoutAction;
  message: string | null;
  /** Over the last 15 minutes; null without enough traffic. */
  error_rate: number | null;
  p95_ms: number | null;
  uptime_90d_pct: number | null;
  ongoing_incident: (StatusIncident & { gateway: string }) | null;
  url: string;
}

export function summarize(g: GatewayStatus, origin: string): GatewaySummary {
  const ongoing = g.incidents.find((i) => i.ongoing) ?? null;
  return {
    gateway: g.gateway,
    name: g.name,
    state: g.state,
    action: ACTION[g.state],
    message: buyerMessage(g),
    error_rate: g.error_rate,
    p95_ms: g.p95_ms,
    uptime_90d_pct: g.uptime_90d_pct,
    ongoing_incident: ongoing ? { ...ongoing, gateway: g.gateway } : null,
    url: `${origin}/${g.gateway}`,
  };
}

/** Worst state wins: down, then degraded, then operational; no_data only when nothing has data. */
export function overall(r: StatusReport): GatewayState {
  const states = r.gateways.map((g) => g.state);
  if (states.includes("down")) return "down";
  if (states.includes("degraded")) return "degraded";
  if (states.includes("operational")) return "operational";
  return "no_data";
}

export function statusList(r: StatusReport, origin: string) {
  const gateways = r.gateways.map((g) => summarize(g, origin));
  const count = (s: GatewayState) => gateways.filter((g) => g.state === s).length;
  return {
    generated_at: r.generated_at,
    window_minutes: STATE_WINDOW_MIN,
    min_projects: r.min_projects,
    overall: { state: overall(r), operational: count("operational"), degraded: count("degraded"), down: count("down"), no_data: count("no_data") },
    gateways,
  };
}

export function incidentList(r: StatusReport, opts: { gateway?: string; ongoing?: boolean; limit: number }) {
  const all = r.gateways
    .filter((g) => !opts.gateway || g.gateway === opts.gateway)
    .flatMap((g) => g.incidents.map((i) => ({ gateway: g.gateway, name: g.name, ...i })))
    .filter((i) => opts.ongoing === undefined || i.ongoing === opts.ongoing)
    .sort((a, b) => b.started_at - a.started_at);
  return { generated_at: r.generated_at, incidents: all.slice(0, opts.limit) };
}

const RANK: Record<GatewayState, number> = { operational: 0, no_data: 1, degraded: 2, down: 3 };

/**
 * The gateways a checkout offers, in its own order, with healthy ones first: working gateways keep their order,
 * unknown ones follow, slow ones after that, and down ones last with action "disable".
 */
export function checkoutPlan(r: StatusReport, wanted: string[], origin: string) {
  const byId = new Map(r.gateways.map((g) => [g.gateway, g]));
  const known = wanted.filter((w) => byId.has(w));
  const unknown = wanted.filter((w) => !byId.has(w));
  const items = known
    .map((w, i) => ({ g: byId.get(w)!, i }))
    .sort((a, b) => RANK[a.g.state] - RANK[b.g.state] || a.i - b.i)
    .map(({ g }) => summarize(g, origin));
  return {
    generated_at: r.generated_at,
    order: items.map((i) => i.gateway),
    available: items.filter((i) => i.action !== "disable").map((i) => i.gateway),
    gateways: items,
    ...(unknown.length ? { unknown } : {}),
  };
}

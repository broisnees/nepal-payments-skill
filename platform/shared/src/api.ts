// Response shapes of the REST API (platform/SPEC.md section 6). The dashboard and the CLI import these.
import type { PaymentEvent, PaymentStatus } from "./events.ts";

export type Env = "test" | "live";
export type Role = "owner" | "admin" | "viewer";

export interface ApiError {
  error: { code: string; message: string };
}
export interface Page<T> {
  items: T[];
  next_cursor: string | null;
}

export interface Me {
  user: { id: string; email: string; name: string | null };
  orgs: { id: string; name: string; role: Role }[];
  /** "local" from `paynp dev`: no sign-in, one project, no alerts, keys or members. The hosted API leaves it out. */
  mode?: "local";
}
export interface Project {
  id: string;
  org_id: string;
  name: string;
  slug: string;
  created_at: number;
}
export interface ApiKey {
  id: string;
  env: Env;
  prefix: string; // e.g. "pnp_test_AbCd"; the full key is only in the create response
  name: string | null;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}
export interface CreatedKey extends ApiKey {
  key: string;
}

export interface Payment {
  attempt_id: string;
  env: Env;
  order_id: string | null;
  gateway: string;
  amount_paisa: number | null;
  status: PaymentStatus;
  started_at: number;
  updated_at: number;
  finished_at: number | null;
  provider_ref: string | null;
  last_reason: string | null;
  last_message: string | null;
  event_count: number;
  error_count: number;
  fulfil_count: number;
  /** v2 (SPEC-v2 section 1): masked phone or email, never the raw value. */
  customer_mask?: string | null;
  refunded_paisa?: number;
  gw_env?: "sandbox" | "production" | null;
  fulfilled_at?: number | null;
}

export interface StoredEvent extends PaymentEvent {
  received_at: number;
}

export interface Explanation {
  title: string;
  cause: string;
  fix: string;
  docs_url?: string;
}

export interface PaymentDetail {
  payment: Payment;
  events: StoredEvent[];
  explain: Explanation | null;
}

export interface SeriesPoint {
  t: number; // bucket start, epoch ms
  started: number;
  paid: number;
  failed: number;
  revenue_paisa: number;
  success_rate: number | null; // paid / (paid + failed), null when both are 0
  gw_latency_avg: number | null;
  gw_error_rate: number | null;
}
export interface Analytics {
  series: SeriesPoint[];
  totals: { started: number; paid: number; failed: number; revenue_paisa: number; success_rate: number | null };
  by_gateway: { gateway: string; started: number; paid: number; failed: number; revenue_paisa: number; success_rate: number | null }[];
  failure_reasons: { reason: string; count: number }[];
  time_to_pay_ms: { p50: number | null; p95: number | null };
  funnel: { started: number; redirected: number; callback: number; paid: number };
}

export interface GatewayHealth {
  gateway: string;
  requests: number;
  error_rate: number | null;
  latency_avg: number | null;
  latency_max: number | null;
  state: "ok" | "degraded" | "down" | "idle";
}

export type ChannelType = "email" | "slack" | "discord" | "webhook";
export interface AlertChannel {
  id: string;
  type: ChannelType;
  name: string;
  config: Record<string, unknown>; // webhook secrets are masked in responses
  created_at: number;
}
export type RuleType =
  | "payment_failed"
  | "failure_rate"
  | "stuck_pending"
  | "amount_mismatch"
  | "signature_failure"
  | "gateway_errors"
  | "gateway_slow"
  | "double_fulfilment"
  | "no_traffic"
  | "double_payment"
  | "paid_not_fulfilled";
export interface AlertRule {
  id: string;
  env: Env;
  type: RuleType;
  params: Record<string, unknown>;
  channel_ids: string[];
  cooldown_min: number;
  enabled: boolean;
  created_at: number;
}
export interface Incident {
  id: string;
  rule_id: string;
  state: "firing" | "resolved";
  opened_at: number;
  resolved_at: number | null;
  last_notified_at: number;
  summary: string;
  context: Record<string, unknown> | null;
}
export interface Session {
  id: string;
  user_agent: string | null;
  ip: string | null;
  created_at: number;
  last_seen_at: number;
  current: boolean;
}

/** Messages on the live WebSocket (SPEC section 7). */
export type LiveMessage =
  | { kind: "backlog"; events: StoredEvent[] }
  | { kind: "event"; event: StoredEvent; payment: Payment }
  | { kind: "ping" };

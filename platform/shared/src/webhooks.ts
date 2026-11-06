// Outbound payment webhooks (Standard Webhooks, https://www.standardwebhooks.com). Nepali gateways have no
// webhooks of their own, so paynp sends one when a payment it watches changes status.
import type { Env, Payment } from "./api.ts";

export const WEBHOOK_EVENT_TYPES = [
  "payment.created", // first event of an attempt, status still open
  "payment.processing", // gateway says pending
  "payment.succeeded",
  "payment.failed",
  "payment.canceled",
  "payment.expired",
  "payment.refunded", // every refund, partial or full; data.refunded_paisa is the running total
] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];
/** Sent only by "Send test event"; endpoints always receive it. */
export const WEBHOOK_TEST_TYPE = "webhook.test";

/** Delay before each retry. With the first try that makes 8 attempts over 27 h 35 min. */
export const WEBHOOK_RETRY_DELAYS_MS = [5_000, 300_000, 1_800_000, 7_200_000, 18_000_000, 36_000_000, 36_000_000] as const;
/** An endpoint that has failed every delivery for this long is disabled. */
export const WEBHOOK_DISABLE_AFTER_MS = 5 * 24 * 3_600_000;

export type WebhookDeliveryStatus = "pending" | "delivered" | "failed";

export interface WebhookEndpoint {
  id: string;
  env: Env;
  url: string;
  description: string | null;
  /** ["*"] means every type, including ones added later. */
  events: string[];
  enabled: boolean;
  /** Why paynp turned it off, e.g. after days of failures. */
  disabled_reason: string | null;
  /** Start of the current run of failed deliveries; null while it works. */
  failing_since: number | null;
  /** Masked except in the create, rotate and reveal responses. */
  secret: string;
  created_at: number;
}

export interface WebhookDelivery {
  id: string;
  endpoint_id: string;
  /** The webhook-id header: the same on every retry, so receivers can drop duplicates. */
  event_id: string;
  type: string;
  attempt_id: string | null;
  status: WebhookDeliveryStatus;
  attempts: number;
  next_at: number | null;
  created_at: number;
  last_at: number | null;
  last_status: number | null;
  last_error: string | null;
  last_ms: number | null;
  /** First 500 characters of the receiver's response body. */
  last_response: string | null;
  payload: WebhookPayload;
}

/** The JSON body of every delivery. */
export interface WebhookPayload {
  type: string;
  /** When the change happened (ISO 8601). */
  timestamp: string;
  data: Payment | Record<string, unknown>;
}

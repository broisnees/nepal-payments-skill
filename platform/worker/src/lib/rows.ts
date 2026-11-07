// Database rows to API shapes (@paynp/shared api.ts).
import type { Env as PayEnv, Payment, PaymentStatus, StoredEvent } from "@paynp/shared";
import type { EventRow, PaymentRow } from "../types.ts";
import { parseJson } from "./util.ts";

export function toPayment(r: PaymentRow): Payment {
  return {
    attempt_id: r.attempt_id,
    env: r.env as PayEnv,
    order_id: r.order_id,
    gateway: r.gateway,
    amount_paisa: r.amount_paisa,
    currency: r.currency ?? "NPR",
    status: r.status as PaymentStatus,
    started_at: r.started_at,
    updated_at: r.updated_at,
    finished_at: r.finished_at,
    provider_ref: r.provider_ref,
    last_reason: r.last_reason,
    last_message: r.last_message,
    event_count: r.event_count,
    error_count: r.error_count,
    fulfil_count: r.fulfil_count,
    customer_mask: r.customer_mask ?? null,
    refunded_paisa: r.refunded_paisa ?? 0,
    gw_env: (r.gw_env as Payment["gw_env"]) ?? null,
    fulfilled_at: r.fulfilled_at ?? null,
  };
}

export function toEvent(r: EventRow): StoredEvent {
  const e: StoredEvent = {
    id: r.id,
    type: r.type as StoredEvent["type"],
    ts: new Date(r.ts).toISOString(),
    attempt_id: r.attempt_id,
    gateway: r.gateway,
    received_at: r.received_at,
  };
  if (r.order_id != null) e.order_id = r.order_id;
  if (r.amount_paisa != null) e.amount_paisa = r.amount_paisa;
  if (r.currency && r.currency !== "NPR") e.currency = r.currency;
  if (r.status != null) e.status = r.status as PaymentStatus;
  if (r.duration_ms != null) e.duration_ms = r.duration_ms;
  const data = parseJson<StoredEvent["data"] | null>(r.data, null);
  if (data) e.data = data;
  const sdk = parseJson<StoredEvent["sdk"] | null>(r.sdk, null);
  if (sdk) e.sdk = sdk;
  return e;
}

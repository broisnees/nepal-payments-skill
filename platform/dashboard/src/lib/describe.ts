// One line of human text per event, shared by the timeline and the live tail.
import type { StoredEvent } from "@paynp/shared";
import { formatMoney } from "./format.ts";
import { reasonLabel } from "./labels.ts";

export type Tone = "ok" | "bad" | "warn" | undefined;

export function tone(e: StoredEvent): Tone {
  if (e.type === "error") return "bad";
  if (e.type === "signature.checked") return e.data?.valid === false ? "bad" : undefined;
  if (e.type === "gateway.request") return (e.data?.http_status ?? 200) >= 400 ? "bad" : undefined;
  if (e.type === "payment.fulfilled") return "ok";
  if (e.type === "payment.refunded") return "warn";
  if (e.type === "status.changed" || e.type === "reconcile.checked") {
    const to = e.status ?? e.data?.to;
    if (to === "paid") return "ok";
    if (to === "failed" || to === "expired" || to === "canceled") return "bad";
    if (to === "pending" || to === "unknown") return "warn";
  }
  return undefined;
}

export function describe(e: StoredEvent): string {
  const d = e.data ?? {};
  switch (e.type) {
    case "payment.started":
      return [e.amount_paisa !== undefined ? formatMoney(e.amount_paisa, e.currency) : null, e.order_id ? `order ${e.order_id}` : null].filter(Boolean).join(", ");
    case "payment.redirected":
      return [d.method, d.endpoint].filter(Boolean).join(" ");
    case "callback.received":
      return [d.method, d.source === "return" ? "return URL" : d.source, d.provider_status && `status ${d.provider_status}`, d.provider_code && `code ${d.provider_code}`].filter(Boolean).join(", ");
    case "signature.checked":
      return d.valid === false ? `Invalid${d.reason ? `: ${reasonLabel(d.reason)}` : ""}` : "Valid";
    case "gateway.request":
      return [d.op, [d.method, d.endpoint].filter(Boolean).join(" "), d.http_status && `HTTP ${d.http_status}`, d.provider_status, d.attempt && d.attempt > 1 ? `retry ${d.attempt - 1}` : null].filter(Boolean).join(", ");
    case "status.changed":
      return `${d.from ?? "?"} to ${d.to ?? e.status ?? "?"}${d.reason ? `, ${reasonLabel(d.reason)}` : ""}`;
    case "payment.fulfilled":
      return "Order marked fulfilled";
    case "reconcile.checked":
      return [d.provider_status && `gateway says ${d.provider_status}`, e.status && `now ${e.status}`].filter(Boolean).join(", ");
    case "payment.refunded":
      return [e.amount_paisa !== undefined ? formatMoney(e.amount_paisa, e.currency) : null, d.refund_ref && `ref ${d.refund_ref}`, d.refund_reason].filter(Boolean).join(", ");
    case "payment.annotated":
      return [e.order_id && `order ${e.order_id}`, e.customer?.name].filter(Boolean).join(", ") || "Order or customer details";
    case "error":
      return d.message ?? (d.reason ? reasonLabel(d.reason) : "Error");
  }
  return "";
}


// Human names for machine values the API returns.
import type { RuleType } from "@paynp/shared";

const REASONS: Record<string, string> = {
  canceled_by_buyer: "Canceled by buyer",
  session_expired: "Session expired",
  not_found: "Not found at gateway",
  amount_mismatch: "Amount mismatch",
  bad_signature: "Bad signature",
  invalid_signature: "Bad signature",
  invalid_payload_signature: "Invalid payload signature",
  invalid_key: "Invalid gateway key",
  duplicate_prn: "Duplicate PRN",
  id_mismatch: "Id mismatch",
  timeout: "Gateway timeout",
  failed: "Failed",
  expired: "Expired",
  canceled: "Canceled",
};

export function reasonLabel(r: string): string {
  return REASONS[r] ?? r.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}

export const EVENT_LABELS: Record<string, string> = {
  "payment.started": "Payment started",
  "payment.redirected": "Sent to gateway",
  "callback.received": "Callback received",
  "signature.checked": "Signature checked",
  "gateway.request": "Gateway request",
  "status.changed": "Status changed",
  "payment.fulfilled": "Order fulfilled",
  "reconcile.checked": "Reconcile check",
  error: "Error",
};

export const RULES: Record<RuleType, { title: string; blurb: string; when: string }> = {
  payment_failed: { title: "Payment failed", blurb: "Every payment that ends failed, optionally above an amount or on some gateways.", when: "On ingest" },
  failure_rate: { title: "Failure rate", blurb: "Share of payments that fail over a window crosses a threshold.", when: "Every minute" },
  stuck_pending: { title: "Stuck pending", blurb: "Payments still open (initiated, pending, unknown) after N minutes.", when: "Every minute" },
  amount_mismatch: { title: "Amount mismatch", blurb: "The gateway confirmed a different amount than the order total.", when: "On ingest" },
  signature_failure: { title: "Signature failures", blurb: "Callbacks whose gateway signature did not verify.", when: "On ingest and every minute" },
  gateway_errors: { title: "Gateway errors", blurb: "Error rate of calls to a gateway crosses a threshold.", when: "Every minute" },
  gateway_slow: { title: "Gateway slow", blurb: "Average gateway response time crosses a limit.", when: "Every minute" },
  double_fulfilment: { title: "Double fulfilment", blurb: "An order was fulfilled twice for the same payment.", when: "On ingest" },
  no_traffic: { title: "No traffic", blurb: "No payment started in the window. Live environment only.", when: "Every minute" },
};

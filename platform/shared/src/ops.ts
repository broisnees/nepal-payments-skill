// API types for the v2 operations features (refunds, actions, lookup, status links, doctor). See SPEC-v2.md sections 3 and 4.
import type { Env } from "./api.ts";
import type { PaymentStatus } from "./events.ts";

/** Compact payment shape used by refunds and lookup. Customer data is only ever the masked form. */
export interface PaymentSummary {
  attempt_id: string;
  order_id: string | null;
  gateway: string;
  amount_paisa: number | null;
  status: PaymentStatus;
  started_at: number;
  finished_at: number | null;
  provider_ref: string | null;
  customer_mask: string | null;
  refunded_paisa: number;
  fulfilled: boolean;
}

// ---- Refund queue (4.1) ----

export type RefundKind = "duplicate" | "manual" | "customer_request";
export type RefundStatus = "open" | "requested" | "refunded" | "dismissed" | "failed";

export interface ChecklistStep {
  id: string;
  text: string;
  /** "action": done by the Send refund button (signed action to the merchant's server). */
  kind: "action" | "manual";
  done_at: number | null;
  by: string | null;
}

export interface RefundCase {
  id: string;
  env: Env;
  kind: RefundKind;
  status: RefundStatus;
  attempt_id: string;
  related_attempt_id: string | null;
  gateway: string;
  amount_paisa: number;
  /** same_order | same_customer_amount for duplicates; free text for manual cases. */
  reason: string | null;
  checklist: ChecklistStep[];
  refund_ref: string | null;
  action_id: string | null;
  created_at: number;
  updated_at: number;
  resolved_at: number | null;
  resolved_by: string | null;
  note: string | null;
  payment: PaymentSummary | null;
  related: PaymentSummary | null;
  /** The gateway has a refund API and the project+env has an action endpoint: POST /refunds/:id/send works. */
  can_send: boolean;
  has_refund_api: boolean;
}

// ---- Signed actions (3) ----

export type ActionKind = "refund" | "recheck" | "ping";

/** The JSON body paynp POSTs to the merchant's action endpoint. */
export interface ActionPayload {
  id: string;
  kind: ActionKind;
  attempt_id: string;
  gateway: string;
  order_id: string | null;
  amount_paisa: number | null;
  provider_ref: string | null;
  refund?: { amount_paisa: number; reason: string | null };
}

/** What the merchant's endpoint answers (HTTP 200 either way). */
export interface ActionReply {
  ok: boolean;
  refund_ref?: string;
  status?: PaymentStatus;
  error?: string;
}

export interface ActionEndpoint {
  env: Env;
  url: string;
  /** Masked except in the response that created or rotated it. */
  secret: string;
  created_at: number;
  last_ok_at: number | null;
  last_error: string | null;
}

export interface ActionRecord {
  id: string;
  env: Env;
  kind: ActionKind;
  attempt_id: string;
  status: "pending" | "ok" | "failed";
  payload: ActionPayload;
  response: (ActionReply & { http_status?: number }) | null;
  created_at: number;
  finished_at: number | null;
  requested_by: string | null;
}

// ---- Lookup and status links (4.2) ----

export type Verdict = "paid" | "paid_duplicate" | "pending" | "failed" | "canceled" | "expired" | "refunded" | "unknown";
export type LookupQueryKind = "phone" | "email" | "ref" | "none";

export interface LookupMatch {
  payment: PaymentSummary;
  verdict: Verdict;
  /** One line for a support agent, e.g. "Paid at 12:59 on 5 Nov 2026, eSewa ref 0LD5CEH". */
  text: string;
  fulfilled: boolean;
  matched_by: ("phone" | "email" | "ref" | "attempt" | "order" | "amount")[];
  /** For paid_duplicate: the earlier payment this one duplicates. */
  duplicate_of: string | null;
}

export interface LookupResult {
  query: { q: string | null; kind: LookupQueryKind; amount_paisa: number | null; from: number | null; to: number | null };
  items: LookupMatch[];
}

export interface StatusLink {
  url: string;
  expires_at: number;
}

/** Ops view of one payment, for the payment detail page. */
export interface PaymentOps {
  customer: { mask: string | null; name: string | null } | null;
  refunded_paisa: number;
  gw_env: "sandbox" | "production" | null;
  fulfilled_at: number | null;
  refund_cases: RefundCase[];
  /** This payment duplicates an earlier one (it is the one to refund). */
  duplicate_of: string | null;
  /** Later payments that duplicate this one. */
  duplicates: string[];
}

// ---- Go-live doctor (4.4) ----

export type DoctorSeverity = "critical" | "warning";
export const DOCTOR_CODES = [
  "sandbox_gateway_in_live",
  "http_return_url",
  "amount_looks_like_rupees",
  "signature_failures",
  "no_status_check_after_return",
  "fulfil_without_paid",
  "double_fulfilment",
  "no_reconcile",
] as const;
export type DoctorCode = (typeof DOCTOR_CODES)[number];

const REFS = "https://github.com/broisnees/nepal-payments-skill/blob/main/skills/nepal-payments/references";

export interface DoctorCheckInfo {
  code: DoctorCode;
  severity: DoctorSeverity;
  /** Only evaluated on live traffic. */
  live_only: boolean;
  title: string;
  why: string;
  fix: string;
  docs_url: string;
  /** Shown when the check passes. */
  passed: string;
}

/** The server-side go-live checks. The CLI and the dashboard can render these without a request. */
export const DOCTOR_CHECKS: Record<DoctorCode, DoctorCheckInfo> = {
  sandbox_gateway_in_live: {
    code: "sandbox_gateway_in_live",
    severity: "critical",
    live_only: true,
    title: "Live payments are going to a sandbox gateway",
    why: "Sandbox hosts (rc-epay.esewa.com.np, dev.khalti.com, dev-clientapi.fonepay.com, uat connectIPS) never move real money. Buyers see a test page or payments silently never settle.",
    fix: "Set the gateway's production base URL and live credentials in the production environment (for example ESEWA_ENV=production), then redeploy.",
    docs_url: `${REFS}/env.md`,
    passed: "Live events only reach production gateway hosts.",
  },
  http_return_url: {
    code: "http_return_url",
    severity: "critical",
    live_only: true,
    title: "Return URL is plain http",
    why: "Gateways redirect the buyer back over the return URL. On http the browser warns, some gateways refuse it, and the callback can be tampered with in transit.",
    fix: "Use an https BASE_URL for success and failure URLs in production.",
    docs_url: `${REFS}/web.md`,
    passed: "Live payments return over https.",
  },
  amount_looks_like_rupees: {
    code: "amount_looks_like_rupees",
    severity: "warning",
    live_only: true,
    title: "Amounts look like rupees sent as paisa",
    why: "Khalti takes paisa (minimum 1000 = Rs 10). Sending 150 for Rs 150 charges Rs 1.50 or fails the minimum check.",
    fix: "Convert rupees to paisa once (Math.round(rupees * 100)) where you build the payment, and send amount_paisa as an integer.",
    docs_url: `${REFS}/khalti.md`,
    passed: "Live amounts look like paisa.",
  },
  signature_failures: {
    code: "signature_failures",
    severity: "critical",
    live_only: false,
    title: "Repeated signature failures",
    why: "Three or more failed signature checks in 10 minutes usually means a wrong secret key, a reformatted amount in the signed string, or someone probing the return route.",
    fix: "Check the secret for this environment and sign the exact strings you post. If keys are right, look at who is calling the return route.",
    docs_url: `${REFS}/esewa.md`,
    passed: "No bursts of failed signature checks.",
  },
  no_status_check_after_return: {
    code: "no_status_check_after_return",
    severity: "critical",
    live_only: false,
    title: "Return route trusts the redirect",
    why: "A callback was not followed within 60 s by a status or lookup call to the gateway. Redirect parameters can be forged or replayed; only the status API is proof of payment.",
    fix: "In the return route, call the gateway's status or lookup API (confirmPayment) before marking the order paid.",
    docs_url: `${REFS}/architecture.md`,
    passed: "Every return is confirmed with a status call.",
  },
  fulfil_without_paid: {
    code: "fulfil_without_paid",
    severity: "critical",
    live_only: false,
    title: "Orders fulfilled before the payment was paid",
    why: "payment.fulfilled arrived while the payment was not paid. Goods may ship for money that never arrived.",
    fix: "Fulfil only after the attempt is paid, inside the same idempotent update that marks the order paid.",
    docs_url: `${REFS}/architecture.md`,
    passed: "Fulfilment only happens on paid payments.",
  },
  double_fulfilment: {
    code: "double_fulfilment",
    severity: "critical",
    live_only: false,
    title: "Orders fulfilled more than once",
    why: "The same payment was fulfilled twice, usually because the return route and a webhook or reconcile job both fulfil.",
    fix: "Make fulfilment idempotent: UPDATE orders SET status = 'paid' WHERE id = ? AND status <> 'paid' and fulfil only when that touched a row.",
    docs_url: `${REFS}/architecture.md`,
    passed: "Every payment is fulfilled at most once.",
  },
  no_reconcile: {
    code: "no_reconcile",
    severity: "warning",
    live_only: true,
    title: "No reconcile job",
    why: "Live payments have been open for over an hour and nothing asked the gateway about them in the last 24 h. Buyers who paid but never returned stay unpaid.",
    fix: "Run a reconcile job every few minutes that calls the status API for open attempts older than 5 minutes.",
    docs_url: `${REFS}/architecture.md`,
    passed: "A reconcile job checks open payments.",
  },
};

export interface DoctorFinding {
  code: DoctorCode;
  severity: DoctorSeverity;
  gateway: string | null;
  title: string;
  why: string;
  fix: string;
  docs_url: string;
  count: number;
  first_seen: number;
  last_seen: number;
  example_attempt: string | null;
  resolved_at: number | null;
}

export interface DoctorCheck {
  code: DoctorCode;
  severity: DoctorSeverity;
  title: string;
  status: "passed" | "not_checked";
  /** Short line: the passed text, or why the check does not run in this env. */
  line: string;
}

export interface DoctorReport {
  env: Env;
  critical: number;
  warnings: number;
  /** Open findings (not resolved), most severe first. */
  findings: DoctorFinding[];
  passed: DoctorCheck[];
}

// One line of plain text per payment for support (SPEC-v2 4.2), computed server side.
import { explain, type PaymentStatus, type PaymentSummary, type Verdict } from "@paynp/shared";
import { MINUTE } from "../lib/util.ts";
import type { PaymentRow } from "../types.ts";
import { gatewayName } from "./checklist.ts";

const NPT = (5 * 60 + 45) * MINUTE;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "12:59 on 5 Nov 2026", Nepal time. */
export function nptTime(ms: number): string {
  const d = new Date(ms + NPT);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm} on ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

export const rs = (paisa: number) => `Rs ${(paisa / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function toSummary(p: PaymentRow): PaymentSummary {
  return {
    attempt_id: p.attempt_id,
    order_id: p.order_id,
    gateway: p.gateway,
    amount_paisa: p.amount_paisa,
    status: p.status as PaymentStatus,
    started_at: p.started_at,
    finished_at: p.finished_at,
    provider_ref: p.provider_ref,
    customer_mask: p.customer_mask,
    refunded_paisa: p.refunded_paisa ?? 0,
    fulfilled: p.fulfil_count > 0,
  };
}

/** The failure in words: the explainer's title when it knows the reason, else the reason itself. */
function cause(p: PaymentRow): string | null {
  return explain({ gateway: p.gateway, reason: p.last_reason })?.title ?? p.last_message ?? p.last_reason ?? null;
}

export function verdictFor(p: PaymentRow, duplicateOf: string | null): { verdict: Verdict; text: string } {
  const gw = gatewayName(p.gateway);
  const ref = p.provider_ref ? `, ${gw} ref ${p.provider_ref}` : ` on ${gw}`;
  const at = (ms: number | null) => nptTime(ms ?? p.updated_at);
  switch (p.status) {
    case "paid": {
      const refunded = p.refunded_paisa > 0 ? ` ${rs(p.refunded_paisa)} refunded so far.` : "";
      if (duplicateOf) return { verdict: "paid_duplicate", text: `Paid twice: paid at ${at(p.finished_at)}${ref}, a duplicate of ${duplicateOf}. Refund this one.${refunded}` };
      const fulfil = p.fulfil_count > 0 ? "" : " Not fulfilled yet.";
      return { verdict: "paid", text: `Paid at ${at(p.finished_at)}${ref}.${fulfil}${refunded}` };
    }
    case "refunded":
      return { verdict: "refunded", text: `Refunded${p.refunded_paisa ? ` ${rs(p.refunded_paisa)}` : ""}${ref}. Last update at ${at(p.updated_at)}.` };
    case "failed": {
      const c = cause(p);
      return { verdict: "failed", text: `Failed at ${at(p.finished_at)} on ${gw}${c ? `: ${c}` : ""}. No money was taken for this attempt.` };
    }
    case "canceled": {
      const c = cause(p);
      return { verdict: "canceled", text: `Canceled at ${at(p.finished_at)} on ${gw}${c ? `: ${c}` : ", the buyer left the payment page"}.` };
    }
    case "expired":
      return { verdict: "expired", text: `Expired: started at ${at(p.started_at)} on ${gw} and never paid.` };
    case "pending":
      return { verdict: "pending", text: `Started at ${at(p.started_at)} on ${gw}; ${gw} still reports it pending. Check again in a few minutes.` };
    case "unknown":
      return { verdict: "pending", text: `Started at ${at(p.started_at)} on ${gw}; the outcome is unknown. Re-check it with ${gw} before telling the buyer.` };
    default:
      return { verdict: "pending", text: `Started at ${at(p.started_at)} on ${gw} but not finished: the buyer never came back.` };
  }
}

/** Status in words for the public status page. */
export function publicStatus(status: string): { word: string; paid: boolean } {
  switch (status) {
    case "paid":
      return { word: "Paid", paid: true };
    case "refunded":
      return { word: "Refunded", paid: false };
    case "failed":
      return { word: "Payment failed", paid: false };
    case "canceled":
      return { word: "Payment canceled", paid: false };
    case "expired":
      return { word: "Payment expired", paid: false };
    case "pending":
    case "unknown":
      return { word: "Waiting for the gateway to confirm", paid: false };
    default:
      return { word: "Not completed", paid: false };
  }
}

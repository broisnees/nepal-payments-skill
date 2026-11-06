// Copy-ready replies for a customer who asks "did my payment go through?". Plain, polite, and only what discerns
// knows: it never promises a refund date or that money did not leave the account.
import type { PaymentSummary, Verdict } from "@paynp/shared";
import { formatClock, formatDate, formatMoney, gatewayName } from "./format.ts";

export function replyText(p: PaymentSummary, verdict: Verdict, link?: string | null): string {
  const gw = gatewayName(p.gateway);
  const amount = p.amount_paisa !== null ? formatMoney(p.amount_paisa) : "your payment";
  const order = p.order_id ? `order ${p.order_id}` : "your order";
  const at = (t: number) => `${formatDate(t)} at ${formatClock(t)}`;
  const ref = p.provider_ref ? ` (${gw} reference ${p.provider_ref})` : "";
  const tail = link ? `\n\nYou can check the status any time here: ${link}` : "";
  switch (verdict) {
    case "paid":
      return `Namaste! We received ${amount} for ${order} via ${gw} on ${at(p.finished_at ?? p.started_at)}${ref}. ${p.fulfilled ? "Your order has been processed." : "We are processing your order now."}${tail}`;
    case "paid_duplicate":
      return `Namaste! You were charged twice for ${order}. We will refund the second payment of ${amount}${ref} to your ${gw} account and let you know when it is done. Sorry for the trouble.${tail}`;
    case "refunded":
      return `Namaste! We refunded ${p.refunded_paisa ? formatMoney(p.refunded_paisa) : amount} for ${order} to your ${gw} account${ref}. Please check your ${gw} statement, and send us a screenshot if you cannot find it.${tail}`;
    case "pending":
    case "unknown":
      return `Namaste! ${gw} has not confirmed the payment for ${order} yet. If money left your account, please send us the ${gw} transaction code or a screenshot and we will check it right away.${tail}`;
    default:
      return `Namaste! The payment for ${order} on ${gw} did not go through, so the order is not paid yet. You can try again from your order page. If money left your account, please send us the ${gw} transaction code and we will check it right away.${tail}`;
  }
}

// Refund checklists per gateway (SPEC-v2 4.1), from skills/nepal-payments/references/*.md:
//   Khalti: merchant refund API (khalti.md section 6) and the merchant dashboard.
//   CyberSource: REST refund API (cybersource.md).
//   eSewa ePay v2: no refund API; merchant portal or support, then FULL_REFUND / PARTIAL_REFUND in the status API (esewa.md).
//   Fonepay: no public refund API; merchant panel or bank (fonepay.md). connectIPS: no refunds in the API (connectips.md).
//   NPS, IME Pay: no refund API documented; merchant support.
import type { ChecklistStep } from "@paynp/shared";
import { parseJson } from "../lib/util.ts";

export const GATEWAY_NAMES: Record<string, string> = {
  esewa: "eSewa",
  khalti: "Khalti",
  fonepay: "Fonepay",
  connectips: "connectIPS",
  cybersource: "CyberSource",
  nps: "NPS",
  imepay: "IME Pay",
  nepalpay: "NEPALPAY QR",
  hamropay: "Hamro Pay",
  getpay: "GetPay (cards)",
};
export const gatewayName = (g: string) => GATEWAY_NAMES[g] ?? g;

/** Gateways whose refund can be done by an API call on the merchant's server (the Send refund button). */
export const REFUND_API_GATEWAYS = new Set(["khalti", "cybersource"]);

type Step = Omit<ChecklistStep, "done_at" | "by">;

export function checklistSteps(gateway: string, hasEndpoint: boolean, ref: string | null): Step[] {
  const r = ref ? ` (reference ${ref})` : "";
  const record: Step = { id: "record", kind: "manual", text: "Record the refund reference here" };
  if (REFUND_API_GATEWAYS.has(gateway)) {
    if (hasEndpoint) {
      return [
        { id: "send", kind: "action", text: "Send refund via your server" },
        {
          id: "confirm",
          kind: "manual",
          text: gateway === "khalti" ? "Confirm with a Khalti lookup: status Refunded or Partially Refunded" : `Confirm the refund in the ${gatewayName(gateway)} dashboard`,
        },
      ];
    }
    return gateway === "khalti"
      ? [
          { id: "dashboard", kind: "manual", text: "Open the Khalti merchant dashboard" },
          { id: "find", kind: "manual", text: `Find the transaction${r}` },
          { id: "refund", kind: "manual", text: "Refund it (full, or partial with the amount)" },
          record,
        ]
      : [
          { id: "dashboard", kind: "manual", text: "Open the CyberSource Business Center" },
          { id: "refund", kind: "manual", text: `Find the transaction${r} and refund it` },
          record,
        ];
  }
  if (gateway === "esewa") {
    return [
      { id: "portal", kind: "manual", text: `Refund in the eSewa merchant portal against the transaction${r}, or email eSewa merchant support with the transaction id` },
      { id: "confirm", kind: "manual", text: "Confirm with the eSewa status API: status FULL_REFUND or PARTIAL_REFUND" },
      record,
    ];
  }
  if (gateway === "fonepay") {
    return [{ id: "support", kind: "manual", text: `Refund from the Fonepay merchant panel, or ask your bank, with the reference${r}` }, record];
  }
  return [{ id: "support", kind: "manual", text: `Ask ${gatewayName(gateway)} merchant support to refund the payment${r}` }, record];
}

export interface StoredStep {
  step: string;
  done_at: number | null;
  by: string | null;
}

/** The gateway's steps with the done state stored on the case (JSON [{step, done_at, by}]). */
export function checklist(gateway: string, hasEndpoint: boolean, ref: string | null, stored: string | null): ChecklistStep[] {
  const done = new Map(parseJson<StoredStep[]>(stored, []).map((s) => [s.step, s]));
  return checklistSteps(gateway, hasEndpoint, ref).map((s) => ({ ...s, done_at: done.get(s.id)?.done_at ?? null, by: done.get(s.id)?.by ?? null }));
}

export function markStep(stored: string | null, step: string, by: string, at: number): string {
  const list = parseJson<StoredStep[]>(stored, []).filter((s) => s.step !== step);
  list.push({ step, done_at: at, by });
  return JSON.stringify(list);
}

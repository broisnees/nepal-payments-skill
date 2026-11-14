/** Typed shapes of Fonepay responses, and the guards that produce them from untyped JSON. */
import { isRecord } from "../../core/records.ts";

/** txnVerification and QR status answers share these fields. */
export interface PaymentStatusResponse {
  paymentStatus: string;
  prn?: unknown;
  requestedAmount?: unknown;
  totalTransactionAmount?: unknown;
  fonepayTraceId?: unknown;
  [k: string]: unknown;
}

export function isPaymentStatusResponse(value: unknown): value is PaymentStatusResponse {
  return isRecord(value) && typeof value.paymentStatus === "string";
}

export interface QrCreateResponse {
  qrMessage: unknown;
  thirdpartyQrWebSocketUrl?: unknown;
  [k: string]: unknown;
}

export function isQrCreateResponse(value: unknown): value is QrCreateResponse {
  return isRecord(value) && Boolean(value.qrMessage);
}

/** `message` of an error body, if any. */
export function messageOf(value: unknown): unknown {
  return isRecord(value) ? value.message : undefined;
}

/** Text of `<tag>...</tag>` in the legacy XML verification answer. */
export function xmlTag(xml: string, tag: string): string | undefined {
  return xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`))?.[1];
}

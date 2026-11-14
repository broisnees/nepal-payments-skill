/** Typed shapes of NEPALPAY responses, and the guards that produce them from untyped JSON. */
import { isRecord } from "../../core/records.ts";

/** One payment (or refund) against a QR, from merchanttxnreport. */
export interface NepalPayTxn {
  nQrTxnId?: string;
  instructionId?: string;
  amount?: number;
  debitStatus?: string;
  creditStatus?: string;
  merchantBillNo?: string;
  payerName?: string;
  tranType?: string;
  [k: string]: unknown;
}

export interface OAuthToken {
  accessToken: string;
  expiresIn: unknown;
}

export function oauthTokenFrom(body: unknown): OAuthToken | undefined {
  if (!isRecord(body) || !body.access_token) return undefined;
  return { accessToken: String(body.access_token), expiresIn: body.expires_in };
}

export interface GeneratedQr {
  qrString: string;
  qrImage?: string;
  validationTraceId: string;
}

/** `data` of a generateQR answer with responseCode "000", a qrString and a validationTraceId. */
export function generatedQrFrom(body: unknown, okCode: string): GeneratedQr | undefined {
  if (!isRecord(body) || body.responseCode !== okCode) return undefined;
  const data = body.data;
  if (!isRecord(data) || !data.qrString || !data.validationTraceId) return undefined;
  return {
    qrString: String(data.qrString).trim(),
    ...(data.qrImage ? { qrImage: String(data.qrImage) } : {}),
    validationTraceId: String(data.validationTraceId),
  };
}

/** generateQR's error code: top-level responseCode, else the first of `responses`, else HTTP. */
export function generateQrErrorCode(body: unknown, httpStatus: number): string {
  const top = isRecord(body) ? body.responseCode : undefined;
  if (top !== undefined && top !== null) return String(top);
  const responses = isRecord(body) ? body.responses : undefined;
  const first: unknown = Array.isArray(responses) ? responses[0] : undefined;
  const nested = isRecord(first) ? first.responseCode : undefined;
  if (nested !== undefined && nested !== null) return String(nested);
  return `http_${httpStatus}`;
}

/** merchanttxnreport's responseCode as a string ("" when missing). */
export function reportCode(body: unknown): string {
  const code = isRecord(body) ? body.responseCode : undefined;
  return String(code ?? "");
}

/** The transaction rows of a merchanttxnreport answer ([] when absent). */
export function reportRows(body: unknown): NepalPayTxn[] {
  const rows = isRecord(body) ? body.responseBody : undefined;
  return Array.isArray(rows) ? rows.filter(isRecord) : [];
}

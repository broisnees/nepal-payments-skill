/**
 * CyberSource Secure Acceptance Hosted Checkout — the card gateway most Nepali banks provision
 * (e.g. NIC Asia issues profile_id / access_key / secret_key).
 *
 * Status: CyberSource is sunsetting Secure Acceptance in favour of Unified Checkout (migration target
 * 2026-09-30; follow the date your bank/CyberSource sent you). It still works; for NEW builds ask your bank
 * for Unified Checkout + REST (JWT) credentials and use the official `cybersource-rest-client` SDK
 * (see references/cybersource.md).
 *
 * Signature: base64(HMAC-SHA256(secret_key as RAW UTF-8, "f1=v1,f2=v2,...")) over `signed_field_names` order.
 * (REST API secrets are base64-DECODED instead — don't mix them up.)
 */
import {
  hmac,
  PaymentError,
  assertPaisa,
  rupeesToPaisa,
  safeEqual,
  toBase64,
  type InitiateInput,
  type InitiateResult,
  type PaymentAdapter,
  type PaymentStatus,
  type VerifyInput,
  type VerifyResult,
} from "./core.ts";

export interface CyberSourceConfig {
  env: "sandbox" | "production";
  profileId: string;
  accessKey: string;
  secretKey: string;
  /** "sale" (auth+capture, typical) or "authorization" (capture later via Business Center / API). */
  transactionType?: "sale" | "authorization";
  currency?: "NPR" | "USD" | string;
  locale?: string; // "en-us"
  /** Set when you host the receipt page yourself and want to override the profile's URL per request. */
  useReturnUrlOverride?: boolean;
  timeoutMs?: number;
}

const HOST = {
  sandbox: "https://testsecureacceptance.cybersource.com",
  production: "https://secureacceptance.cybersource.com",
} as const;

export interface BillTo {
  forename: string;
  surname: string;
  email: string;
  addressLine1: string;
  city: string;
  /** ISO 3166 alpha-2, e.g. "NP". */
  country: string;
  phone?: string;
  postalCode?: string; // required only for US/CA
  state?: string; // required only for US/CA
}

export async function cybersourceSign(secretKey: string, fields: Record<string, string>): Promise<string> {
  const names = fields.signed_field_names.split(",");
  const message = names.map((n) => `${n}=${fields[n] ?? ""}`).join(",");
  return toBase64(await hmac("SHA-256", secretKey, message));
}

/** UTC "yyyy-MM-dd'T'HH:mm:ss'Z'" — keep the server clock NTP-synced. */
export const signedDateTime = (d = new Date()) => d.toISOString().replace(/\.\d{3}Z$/, "Z");

/**
 * decision ACCEPT -> paid (for "sale"); REVIEW -> pending (Decision Manager / AVS/CVN review; settle manually);
 * DECLINE / ERROR -> failed; CANCEL -> canceled.
 */
function mapDecision(decision: string, reasonCode: string, txnType: string): PaymentStatus {
  switch (decision?.toUpperCase()) {
    case "ACCEPT":
      return txnType.startsWith("authorization") ? "pending" : "paid"; // auth-only isn't captured money yet
    case "REVIEW":
      return "pending";
    case "DECLINE":
    case "ERROR":
      return ["150", "151", "152"].includes(reasonCode) ? "unknown" : "failed"; // system errors: re-check, don't retry blindly
    case "CANCEL":
      return "canceled";
    default:
      return "unknown";
  }
}

export function cybersource(cfg: CyberSourceConfig) {
  const host = HOST[cfg.env];
  const transactionType = cfg.transactionType ?? "sale";
  const currency = cfg.currency ?? "NPR";

  /** Verify a Secure Acceptance response POST (receipt page or Merchant POST URL). */
  async function responseValid(params: Record<string, string>): Promise<boolean> {
    if (!params.signed_field_names || !params.signature) return false;
    return safeEqual(await cybersourceSign(cfg.secretKey, params), params.signature);
  }

  /** Only trust fields listed in the response's signed_field_names. */
  function signedOnly(params: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const n of (params.signed_field_names ?? "").split(",")) if (n in params) out[n] = params[n];
    return out;
  }

  const adapter = {
    id: "cybersource" as const,

    /**
     * Form POST to /pay. `orderId` -> transaction_uuid AND reference_number (both <= 50 chars).
     * billTo is required for sale/authorization (country "NP" for Nepal; state/postal code only for US/CA).
     */
    async initiate(input: InitiateInput & { billTo: BillTo; merchantDefinedData?: Record<number, string> }): Promise<InitiateResult> {
      assertPaisa(input.amountPaisa, "cybersource");
      if (input.orderId.length > 50) throw new PaymentError("CyberSource ids must be <= 50 chars", "cybersource", "invalid_order_id");
      const b = input.billTo;
      const fields: Record<string, string> = {
        access_key: cfg.accessKey,
        profile_id: cfg.profileId,
        transaction_uuid: input.orderId,
        signed_date_time: signedDateTime(),
        locale: cfg.locale ?? "en-us",
        transaction_type: transactionType,
        reference_number: input.orderId,
        amount: (input.amountPaisa / 100).toFixed(2), // "1500.00"
        currency,
        bill_to_forename: b.forename,
        bill_to_surname: b.surname,
        bill_to_email: b.email,
        bill_to_address_line1: b.addressLine1,
        bill_to_address_city: b.city,
        bill_to_address_country: b.country,
        ...(b.phone && { bill_to_phone: b.phone }),
        ...(b.postalCode && { bill_to_address_postal_code: b.postalCode }),
        ...(b.state && { bill_to_address_state: b.state }),
        ...(cfg.useReturnUrlOverride && { override_custom_receipt_page: input.returnUrl }),
        ...(cfg.useReturnUrlOverride && input.failureUrl && { override_custom_cancel_page: input.failureUrl }),
      };
      for (const [i, v] of Object.entries(input.merchantDefinedData ?? {})) fields[`merchant_defined_data${i}`] = v; // no PII allowed
      fields.unsigned_field_names = "";
      fields.signed_field_names = [...Object.keys(fields).filter((k) => k !== "unsigned_field_names"), "unsigned_field_names", "signed_field_names"].join(",");
      fields.signature = await cybersourceSign(cfg.secretKey, fields);
      return { kind: "form", action: `${host}/pay`, method: "POST", fields };
    },

    /**
     * Secure Acceptance has no simple status API: the signed response POST IS the proof. Pass the POST body as
     * `callback` (from the receipt page or — better — the Merchant POST URL). For reconciliation without a
     * callback, use the REST Transaction Search via the official SDK (references/cybersource.md).
     */
    async verify({ orderId, amountPaisa, callback }: VerifyInput): Promise<VerifyResult> {
      if (!callback) {
        throw new PaymentError(
          "CyberSource SA: verification needs the signed response POST; use REST transaction search for reconciliation",
          "cybersource",
          "verify_unavailable",
        );
      }
      if (!(await responseValid(callback))) {
        throw new PaymentError("CyberSource: invalid response signature — treat as malicious", "cybersource", "invalid_signature", 400);
      }
      const p = signedOnly(callback);
      if ((p.req_reference_number ?? p.req_transaction_uuid) !== orderId) {
        throw new PaymentError("CyberSource: response is for a different order", "cybersource", "callback_mismatch", 400, p);
      }
      if (p.req_currency && p.req_currency !== currency) {
        throw new PaymentError("CyberSource: currency mismatch", "cybersource", "currency_mismatch", 400, p);
      }
      const paid = p.auth_amount || p.req_amount;
      const status = mapDecision(p.decision, p.reason_code, p.req_transaction_type ?? transactionType);
      return {
        provider: "cybersource",
        // reason 110 = partial approval: auth_amount < requested. The amount guard in your handler will catch it.
        status,
        orderId,
        amountPaisa: paid ? rupeesToPaisa(paid) : null,
        transactionId: p.transaction_id ?? null,
        raw: p,
      };
    },

    orderIdFromCallback(params: Record<string, string>): string | null {
      return params.req_reference_number || params.req_transaction_uuid || null;
    },

    responseValid,
  } satisfies PaymentAdapter & Record<string, unknown>;

  return adapter;
}


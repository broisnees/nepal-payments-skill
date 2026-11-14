/**
 * CyberSource Secure Acceptance Hosted Checkout — the card gateway most Nepali banks provision
 * (e.g. NIC Asia issues profile_id / access_key / secret_key).
 *
 * Status: CyberSource is sunsetting Secure Acceptance in favour of Unified Checkout (migration
 * target 2026-09-30; follow the date your bank/CyberSource sent you). It still works; for NEW
 * builds ask your bank for Unified Checkout + REST (JWT) credentials and use the official
 * `cybersource-rest-client` SDK (see references/cybersource.md).
 */
import { safeEqual } from "../../core/crypto.ts";
import { PaymentError } from "../../core/errors.ts";
import { assertPaisa, rupeesToPaisa } from "../../core/money.ts";
import type {
  InitiateInput,
  InitiateResult,
  PaymentAdapter,
  VerifyInput,
  VerifyResult,
} from "../../core/types.ts";
import type { BillTo, CyberSourceConfig } from "./config.ts";
import { HOST, mapDecision } from "./endpoints.ts";
import { cybersourceSign, requestSignedFieldNames, signedDateTime, signedOnly } from "./signing.ts";

export interface CyberSourceInitiateExtras {
  billTo: BillTo;
  merchantDefinedData?: Record<number, string>;
}

function billToFields(b: BillTo): Record<string, string> {
  return {
    bill_to_forename: b.forename,
    bill_to_surname: b.surname,
    bill_to_email: b.email,
    bill_to_address_line1: b.addressLine1,
    bill_to_address_city: b.city,
    bill_to_address_country: b.country,
    ...(b.phone && { bill_to_phone: b.phone }),
    ...(b.postalCode && { bill_to_address_postal_code: b.postalCode }),
    ...(b.state && { bill_to_address_state: b.state }),
  };
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

  /** Per-request receipt/cancel page overrides, only when the config opts in. */
  function receiptOverrides(input: InitiateInput): Record<string, string> {
    if (!cfg.useReturnUrlOverride) return {};
    return {
      override_custom_receipt_page: input.returnUrl,
      ...(input.failureUrl && { override_custom_cancel_page: input.failureUrl }),
    };
  }

  /** Signed, then checked against this order and currency. Throws on any mismatch. */
  async function trustedResponse(
    callback: Record<string, string>,
    orderId: string,
  ): Promise<Record<string, string>> {
    if (!(await responseValid(callback))) {
      throw new PaymentError(
        "CyberSource: invalid response signature — treat as malicious",
        "cybersource",
        "invalid_signature",
        400,
      );
    }
    const p = signedOnly(callback);
    if ((p.req_reference_number || p.req_transaction_uuid) !== orderId) {
      throw new PaymentError(
        "CyberSource: response is for a different order",
        "cybersource",
        "callback_mismatch",
        400,
        p,
      );
    }
    if (p.req_currency && p.req_currency !== currency) {
      throw new PaymentError(
        "CyberSource: currency mismatch",
        "cybersource",
        "currency_mismatch",
        400,
        p,
      );
    }
    return p;
  }

  const adapter = {
    id: "cybersource" as const,

    /**
     * Form POST to /pay. `orderId` -> transaction_uuid AND reference_number (both <= 50 chars).
     * billTo is required for sale/authorization (country "NP" for Nepal; state/postal code only
     * for US/CA).
     */
    async initiate(input: InitiateInput & CyberSourceInitiateExtras): Promise<InitiateResult> {
      assertPaisa(input.amountPaisa, "cybersource");
      if (input.orderId.length > 50) {
        throw new PaymentError(
          "CyberSource ids must be <= 50 chars",
          "cybersource",
          "invalid_order_id",
        );
      }
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
        ...billToFields(input.billTo),
        ...receiptOverrides(input),
      };
      for (const [i, value] of Object.entries(input.merchantDefinedData ?? {})) {
        fields[`merchant_defined_data${i}`] = value; // no PII allowed
      }
      fields.unsigned_field_names = "";
      fields.signed_field_names = requestSignedFieldNames(fields);
      fields.signature = await cybersourceSign(cfg.secretKey, fields);
      return { kind: "form", action: `${host}/pay`, method: "POST", fields };
    },

    /**
     * Secure Acceptance has no simple status API: the signed response POST IS the proof. Pass
     * the POST body as `callback` (from the receipt page or — better — the Merchant POST URL).
     * For reconciliation without a callback, use the REST Transaction Search via the official
     * SDK (references/cybersource.md).
     */
    async verify({ orderId, callback }: VerifyInput): Promise<VerifyResult> {
      if (!callback) {
        throw new PaymentError(
          "CyberSource SA: verification needs the signed response POST; " +
            "use REST transaction search for reconciliation",
          "cybersource",
          "verify_unavailable",
        );
      }
      const p = await trustedResponse(callback, orderId);
      const paid = p.auth_amount || p.req_amount;
      return {
        provider: "cybersource",
        // reason 110 = partial approval: auth_amount < requested. The amount guard in your
        // handler will catch it.
        status: mapDecision(p.decision, p.reason_code, p.req_transaction_type ?? transactionType),
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

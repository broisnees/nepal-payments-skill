/**
 * The shared vocabulary every adapter speaks: provider ids, normalized statuses, and the shapes of
 * initiate() / verify() inputs and results.
 */

export type ProviderId =
  | "esewa"
  | "khalti"
  | "fonepay"
  | "connectips"
  | "cybersource"
  | "nps"
  | "imepay"
  | "nepalpay"
  | "hamropay"
  | "getpay";

/** Which provider host to talk to. Every provider config has an `env` of this type. */
export type Environment = "sandbox" | "production";

/** Normalized payment state. Map every provider status onto exactly one of these. */
export type PaymentStatus =
  | "paid" // money captured; safe to fulfil
  | "pending" // provider has not settled yet; re-check later, do NOT fulfil
  | "failed" // declined / error; safe to let the user retry with a NEW order id
  | "canceled" // user backed out
  | "expired" // session timed out before payment
  | "refunded"
  | "partially_refunded"
  | "not_found" // provider has no record (never started, or wrong env/credentials)
  | "unknown"; // anything unmapped; treat like pending and alert

export interface VerifyResult {
  provider: ProviderId;
  status: PaymentStatus;
  /** Your order / transaction id as known to the provider. */
  orderId: string;
  /**
   * Amount the PROVIDER says was paid, in paisa (1 NPR = 100 paisa).
   * null if the provider doesn't say.
   */
  amountPaisa: number | null;
  /**
   * Provider's final transaction id (eSewa ref_id, Khalti transaction_id, ...).
   * Store it; support and refunds need it.
   */
  transactionId: string | null;
  /** Untouched provider response, for audit logs. */
  raw: unknown;
}

export type InitiateResult =
  /**
   * Redirect the browser (or open a WebView / Custom Tab) to `url`.
   * `providerRef` (e.g. Khalti pidx, NPS ProcessId) MUST be persisted on the attempt;
   * verify() needs it.
   */
  | { kind: "redirect"; url: string; providerRef?: string; expiresAt?: string; raw?: unknown }
  /** Render an auto-submitting HTML form that POSTs `fields` to `action`. */
  | {
      kind: "form";
      action: string;
      method: "POST";
      fields: Record<string, string>;
      /** Default application/x-www-form-urlencoded. NPS requires multipart/form-data. */
      enctype?: "multipart/form-data";
      providerRef?: string;
    }
  /**
   * Show a QR the payer scans from their own app (NEPALPAY QR). Render `qrString` with any QR
   * library, or `<img src="data:image/png;base64,${qrImage}">` when the provider sent an image.
   * Persist `providerRef`.
   */
  | { kind: "qr"; qrString: string; qrImage?: string; providerRef: string; raw?: unknown }
  /**
   * Load `scriptUrl` in the browser and start the provider's own checkout with `options`
   * (GetPay). The adapter ships the page helpers (getpay.checkoutPage / paymentPage / returnPage).
   */
  | { kind: "sdk"; scriptUrl: string; options: Record<string, unknown>; providerRef?: string };

export interface Customer {
  name?: string;
  email?: string;
  phone?: string;
}

export interface InitiateInput {
  /** Unique per payment ATTEMPT (not per order). Provider-safe charset: [A-Za-z0-9-]. */
  orderId: string;
  /** Integer paisa, computed server-side from your order. */
  amountPaisa: number;
  /** Shown to the payer where the provider supports it. */
  description: string;
  /** Where the provider sends the payer back (your server route). */
  returnUrl: string;
  /** Some providers have a separate failure URL; defaults to returnUrl. */
  failureUrl?: string;
  customer?: Customer;
}

export interface VerifyInput {
  orderId: string;
  /** The amount YOU stored for this attempt. */
  amountPaisa: number;
  /**
   * The providerRef returned by initiate() (Khalti pidx, NPS ProcessId, IME Pay TokenId...),
   * from YOUR db.
   */
  providerRef?: string | null;
  /** Raw query/body params the provider sent to your return URL, if any. */
  callback?: Record<string, string>;
}

export interface PaymentAdapter {
  readonly id: ProviderId;
  initiate(input: InitiateInput): Promise<InitiateResult>;
  /** Server-to-server confirmation. Never trust callback params alone. */
  verify(input: VerifyInput): Promise<VerifyResult>;
  /** Extract YOUR order id from return-URL params so you can load the attempt. */
  orderIdFromCallback(params: Record<string, string>): string | null;
}

/** Form-kind initiate result (what renderAutoSubmitForm takes). */
export type FormResult = Extract<InitiateResult, { kind: "form" }>;

/** SDK-kind initiate result (GetPay). */
export type SdkResult = Extract<InitiateResult, { kind: "sdk" }>;

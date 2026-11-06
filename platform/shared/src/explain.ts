// Error explainer (platform/SPEC.md section 9). Each entry comes from skills/nepal-payments/references/<gateway>.md.
// explain() takes what a payment's events carried (provider_code, reason, provider_status) and returns the first match.
import type { Explanation } from "./api.ts";

const DOCS = "https://github.com/broisnees/nepal-payments-skill/blob/main/skills/nepal-payments/references";
const doc = (file: string, anchor = "") => `${DOCS}/${file}.md${anchor}`;

type Entry = Explanation & {
  gateway: string | "*";
  /** Matched case-insensitively against provider_code, reason and provider_status, in that order. */
  match: string[];
};

const ENTRIES: Entry[] = [
  // eSewa (esewa.md)
  {
    gateway: "esewa",
    match: ["ES104"],
    title: "eSewa rejected the payload signature",
    cause: "The signature covers the exact posted string. Posting 110.0 while signing 110 (or signing fields in a different order than signed_field_names) gives ES104 Invalid payload signature.",
    fix: "Format the amount once and reuse that exact string in both the form field and the signed message. Sign total_amount,transaction_uuid,product_code in that order with the secret as raw bytes.",
    docs_url: doc("esewa"),
  },
  {
    gateway: "esewa",
    match: ["ES704"],
    title: "eSewa total amount does not add up",
    cause: "total_amount must equal amount + tax_amount + product_service_charge + product_delivery_charge, otherwise eSewa answers ES704 Invalid total transaction amount.",
    fix: "Compute total_amount from the parts and send 0 for any charge you do not use.",
    docs_url: doc("esewa"),
  },
  {
    gateway: "esewa",
    match: ["ES200"],
    title: "eSewa form is missing a required field",
    cause: "eSewa answers ES200 when a field is absent, most often tax_amount (\"tax_amount field is required.\").",
    fix: "Send every form field, using 0 for tax and charges you do not have.",
    docs_url: doc("esewa"),
  },
  {
    gateway: "esewa",
    match: ["409"],
    title: "eSewa refused the form post",
    cause: "The ePay v2 form must be a browser POST as application/x-www-form-urlencoded. A JSON body returns HTTP 409.",
    fix: "Render an auto-submitting HTML form to the eSewa form URL instead of calling it from the server with JSON.",
    docs_url: doc("esewa"),
  },
  {
    gateway: "esewa",
    match: ["NOT_FOUND", "not_found"],
    title: "eSewa status API does not know this transaction",
    cause: "NOT_FOUND means the session expired, the buyer never paid, or the status call used a different total_amount than the one charged.",
    fix: "Call the status API with the total you charged (amount + tax + charges). If it still says NOT_FOUND after 15 minutes, treat the attempt as expired and let the buyer retry with a new transaction_uuid.",
    docs_url: doc("esewa"),
  },
  {
    gateway: "esewa",
    match: ["IP-400"],
    title: "eSewa Intent rejected the signature",
    cause: "The Intent access key is used as a raw string. Base64-decoding it before signing gives IP-400 Invalid Signature.",
    fix: "Sign with the access key bytes exactly as issued.",
    docs_url: doc("esewa"),
  },
  {
    gateway: "esewa",
    match: ["esewa_0"],
    title: "eSewa service unavailable",
    cause: "eSewa returned {\"code\":0,\"error_message\":\"Service is currently unavailable\"}.",
    fix: "Leave the attempt pending and retry the status check later. The reconcile job settles it.",
    docs_url: doc("esewa"),
  },

  // Khalti (khalti.md)
  {
    gateway: "khalti",
    match: ["401"],
    title: "Khalti rejected the secret key",
    cause: "The Authorization header must be `Key <secret_key>`. A Bearer prefix or a bare key gives 401 \"Authentication credentials were not provided.\", and a wrong key gives 401 \"Invalid token.\"",
    fix: "Send `Authorization: Key <live or test secret>` and check that the key matches the environment (dev.khalti.com for test keys).",
    docs_url: doc("khalti"),
  },
  {
    gateway: "khalti",
    match: ["Expired", "expired"],
    title: "Khalti payment session expired",
    cause: "Lookup answers HTTP 400 with status Expired when the buyer did not finish in time. This is a normal outcome, not a transport error.",
    fix: "Mark the attempt failed and start a new attempt with a fresh purchase_order_id.",
    docs_url: doc("khalti"),
  },
  {
    gateway: "khalti",
    match: ["User canceled", "canceled"],
    title: "Buyer canceled on Khalti",
    cause: "Lookup answers HTTP 400 with status User canceled when the buyer backs out.",
    fix: "Mark the attempt canceled and let the buyer start again.",
    docs_url: doc("khalti"),
  },
  {
    gateway: "khalti",
    match: ["400"],
    title: "Khalti lookup returned 400",
    cause: "Khalti returns HTTP 400 with a normal body for Expired and User canceled, and for validation errors such as an amount under Rs. 10 (1000 paisa).",
    fix: "Parse the body before treating a 400 as an error: read status for lookups and error_key for initiate.",
    docs_url: doc("khalti"),
  },
  {
    gateway: "khalti",
    match: ["404", "Not found."],
    title: "Khalti does not know this pidx",
    cause: "Lookup answered {\"detail\":\"Not found.\"}: a wrong pidx, or a test pidx looked up with a live key (or the other way round).",
    fix: "Store pidx at initiate and look it up with the same environment's key. Never use the pidx from the callback query.",
    docs_url: doc("khalti"),
  },

  // Fonepay (fonepay.md)
  {
    gateway: "fonepay",
    match: ["409"],
    title: "Fonepay rejected the request",
    cause: "Fonepay answers 409 for a bad DV (Data Validation Failed) and for a reused PRN (Duplicate PRN).",
    fix: "Rebuild the DV HMAC-SHA512 over the fields in the documented order, and use a fresh PRN (3 to 25 chars) for every attempt.",
    docs_url: doc("fonepay"),
  },
  {
    gateway: "fonepay",
    match: ["406"],
    title: "Fonepay QR request failed validation",
    cause: "Dynamic QR calls return 406 Data Validation Failed when the dataValidation HMAC or a field does not match.",
    fix: "Check the dataValidation field order and the merchant secret, and send the amount as the same string you signed.",
    docs_url: doc("fonepay"),
  },

  // connectIPS (connectips.md)
  {
    gateway: "connectips",
    match: ["403"],
    title: "connectIPS returned 403",
    cause: "Either the success and failure URLs are not registered with NCHL (shows as 403 session expired after OTP), or the TXNID was reused (403 multiple gateway payments at once).",
    fix: "Register the redirect URLs with NCHL for this environment and generate a new TXNID (max 20 chars) per attempt.",
    docs_url: doc("connectips"),
  },

  // NEPALPAY QR (nepalpay.md)
  {
    gateway: "nepalpay",
    match: ["E003"],
    title: "NEPALPAY QR: invalid token",
    cause: "generateQR rejected the RSA token: the signed string differs from the request (amount not as \"10.50\", wrong field order, a space after the commas) or the key is not the NPI .pfx key.",
    fix: "Sign acquirerId,merchantId,merchantCategoryCode,524,transactionAmount,billNumber,npiUsername with bare commas, using the exact amount string you send.",
    docs_url: doc("nepalpay", "#4-token-signature"),
  },
  {
    gateway: "nepalpay",
    match: ["E010"],
    title: "NEPALPAY QR: merchant not found",
    cause: "E010 RECORD NOT FOUND: the acquirerId and merchantId pair is not enrolled in this environment (UAT and live ids differ).",
    fix: "Check NEPALPAY_ACQUIRER_ID, NEPALPAY_MERCHANT_ID and NEPALPAY_ENV against the enrollment email from your bank.",
    docs_url: doc("nepalpay"),
  },
  {
    gateway: "nepalpay",
    match: ["E401", "unauthorized"],
    title: "NEPALPAY QR: unauthorized",
    cause: "E401: the NPI username or password is wrong, or OAuth client credentials are missing when the account expects Bearer tokens.",
    fix: "Check NEPALPAY_USERNAME and NEPALPAY_PASSWORD; if NCHL issued client credentials, set NEPALPAY_CLIENT_ID and NEPALPAY_CLIENT_SECRET.",
    docs_url: doc("nepalpay", "#2-auth"),
  },

  // NPS (nps.md)
  {
    gateway: "nps",
    match: ["3"],
    title: "NPS transaction not initialized",
    cause: "CheckTransactionStatus returned code 1 with error_code 3 \"Transaction not initialized yet\": the buyer never reached the gateway, or the MerchantTxnId is wrong.",
    fix: "Treat it as not found. Expire the attempt if it stays this way past the session window.",
    docs_url: doc("nps"),
  },
  {
    gateway: "nps",
    match: ["Duplicate Record"],
    title: "NPS MerchantTxnId reused",
    cause: "GetProcessId returned code 1 \"Duplicate Record\" because the MerchantTxnId was already used.",
    fix: "Use a fresh MerchantTxnId per attempt.",
    docs_url: doc("nps"),
  },

  // IME Pay (imepay.md)
  {
    gateway: "imepay",
    match: ["1", "2", "3"],
    title: "IME Pay returned a non-zero ResponseCode",
    cause: "Only ResponseCode 0 means paid. Other codes are inconsistently documented (1 is read as failed by one library and pending by another, 3 as cancelled).",
    fix: "Keep the attempt pending, run Recheck, and let the reconcile job expire it, so a payment that later succeeds is never marked failed.",
    docs_url: doc("imepay"),
  },

  // CyberSource (cybersource.md)
  { gateway: "cybersource", match: ["101", "102"], title: "CyberSource: missing or invalid fields", cause: "Reason 101/102: required_fields or invalid_fields lists what the request lacked.", fix: "Read required_fields and invalid_fields in the response and fix the signed fields.", docs_url: doc("cybersource") },
  { gateway: "cybersource", match: ["104"], title: "CyberSource: duplicate transaction_uuid", cause: "Reason 104: the transaction_uuid was reused within 15 minutes.", fix: "Generate a fresh transaction_uuid per attempt.", docs_url: doc("cybersource") },
  { gateway: "cybersource", match: ["110"], title: "CyberSource: partial approval", cause: "Reason 110: auth_amount is lower than requested.", fix: "Do not fulfil. The amount guard should flag it; reverse or ask for another payment.", docs_url: doc("cybersource") },
  { gateway: "cybersource", match: ["150", "151", "152"], title: "CyberSource system error or timeout", cause: "Reason 150-152: CyberSource failed or timed out, so the outcome is unknown.", fix: "Check the transaction status before retrying; do not mark it failed yet.", docs_url: doc("cybersource") },
  { gateway: "cybersource", match: ["200", "230"], title: "CyberSource: AVS or CVN check failed", cause: "Reason 200/230: approved but the AVS or CVN check failed, so the decision is REVIEW.", fix: "Review the payment in Business Center before fulfilling.", docs_url: doc("cybersource") },
  { gateway: "cybersource", match: ["202", "203", "204", "205"], title: "CyberSource: card declined", cause: "Reason 202-205: expired card, general decline, insufficient funds, or lost/stolen card.", fix: "Ask the buyer to use another card.", docs_url: doc("cybersource") },
  { gateway: "cybersource", match: ["207", "208", "210", "211"], title: "CyberSource: issuer or card problem", cause: "Reason 207/208/210/211: issuer unavailable, card not allowed for card-not-present, limit reached, or invalid CVN.", fix: "Ask the buyer to retry later or use another card.", docs_url: doc("cybersource") },
  { gateway: "cybersource", match: ["231", "232", "233", "236", "240"], title: "CyberSource: processor declined", cause: "Reason 231-240: invalid account, card type not accepted, processor decline or failure, or card type mismatch.", fix: "Check the card types enabled on the profile; otherwise ask for another card.", docs_url: doc("cybersource") },
  { gateway: "cybersource", match: ["475", "476", "478"], title: "CyberSource: 3-D Secure required or failed", cause: "Reason 475/476/478: the card needs 3DS, 3DS failed, or SCA is required.", fix: "Enable 3DS for the merchant id (through Customer Support) and tick it per card type in the profile.", docs_url: doc("cybersource") },
  { gateway: "cybersource", match: ["481", "520"], title: "CyberSource: rejected by risk rules", cause: "Reason 481/520: profile risk settings or Decision Manager rejected the payment.", fix: "Review the Decision Manager rules in Business Center.", docs_url: doc("cybersource") },

  // Generic reasons (architecture.md)
  {
    gateway: "*",
    match: ["amount_mismatch"],
    title: "Amount does not match the order",
    cause: "The gateway reported a different amount than the one stored on the attempt. Fulfilling it would sell at the wrong price.",
    fix: "Do not fulfil. Flag the attempt for review, and compare the gateway's total (with charges) against your stored integer paisa amount.",
    docs_url: doc("architecture"),
  },
  {
    gateway: "*",
    match: ["bad_signature", "invalid_signature"],
    title: "Callback signature did not verify",
    cause: "The return or callback data was signed with a different key, altered, or forged. Redirect parameters can be replayed or faked.",
    fix: "Check that the secret matches the environment, compare signatures in constant time, and fulfil only after the server-to-server status check.",
    docs_url: doc("architecture"),
  },
  {
    gateway: "*",
    match: ["id_mismatch"],
    title: "Callback belongs to a different attempt",
    cause: "The transaction id in the callback does not match the attempt it was routed to.",
    fix: "Load the attempt from your own id in the URL path and reject callbacks whose provider id differs.",
    docs_url: doc("architecture"),
  },
  {
    gateway: "*",
    match: ["timeout"],
    title: "Gateway call timed out",
    cause: "The gateway did not answer in time. The payment may still have gone through.",
    fix: "Leave the attempt as it is, show \"We're confirming your payment\", and let the reconcile job settle it. Never mark it failed on a timeout.",
    docs_url: doc("architecture"),
  },
];

export interface ExplainInput {
  gateway: string;
  provider_code?: string | null;
  reason?: string | null;
  provider_status?: string | null;
}

/** Finds the explanation for what a payment's events reported, or null when nothing matches. */
export function explain(input: ExplainInput): Explanation | null {
  const candidates = [input.provider_code, input.reason, input.provider_status].filter((v): v is string => typeof v === "string" && v !== "");
  for (const value of candidates) {
    const v = value.toLowerCase();
    const hit =
      ENTRIES.find((e) => e.gateway === input.gateway && e.match.some((m) => m.toLowerCase() === v)) ??
      ENTRIES.find((e) => e.gateway === "*" && e.match.some((m) => m.toLowerCase() === v));
    if (hit) return { title: hit.title, cause: hit.cause, fix: hit.fix, docs_url: hit.docs_url };
  }
  return null;
}

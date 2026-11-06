import type { LangSnippets } from "./types";

// Shared tail of every verify snippet: decide, write with a guarded UPDATE, fulfil on paid.
const transition = `
long ageMs = Duration.between(attempt.createdAt(), Instant.now()).toMillis();
TransitionDecision d = StateMachine.decideTransition(
        AttemptStatus.fromWire(attempt.status()), result, attempt.amountPaisa(), ageMs);
if (d.reviewRequired() || d.latePaid()) {
    // alert a human with d.reason()
}
if (d.next() != null) {
    // UPDATE payment_attempts SET status = d.next().wire(), provider_txn_id = result.transactionId()
    //  WHERE id = attempt.id() AND status = attempt.status()
    if (d.next() == AttemptStatus.PAID) {
        // fulfil the order here, only if that UPDATE changed a row
    }
}`;

const snippets: LangSnippets = {
  lang: "java",
  label: "Java",
  setup: `import np.payments.*;
import java.time.Duration;
import java.time.Instant;

// Build once at startup (a Spring @Bean or a static field). Providers whose required
// env vars are missing stay disabled; a bad CONNECTIPS_PRIVATE_KEY_PEM fails here.
Payments payments = Payments.create(Payments.configFromEnv());`,
  providers: {
    esewa: {
      initiate: `// eSewa appends ?data=... to the return URL, so the attempt id goes in the path.
// The same URL serves as failure_url, so failed payments can be matched too.
String returnUrl = baseUrl + "/payments/esewa/return/" + attempt.id();
InitiateResult init = payments.esewa().initiate(
        InitiateInput.of(attempt.id(), attempt.amountPaisa(), "Order #42", returnUrl));

// eSewa has no providerRef: the form carries the signed fields.
InitiateResult.Form form = (InitiateResult.Form) init;
// Serve Html.renderAutoSubmitForm(form) as text/html; it POSTs the payer to eSewa.`,
      verify: `// On success params holds "data" (signed base64 JSON); failure redirects carry nothing.
// verify() checks that signature, then asks the status API with the stored total.
VerifyResult result = payments.esewa().verify(
        VerifyInput.of(attempt.id(), attempt.amountPaisa()).withCallback(params));
${transition}`,
      notes: [
        "Tax, service and delivery charges go in `new Esewa.Extras(taxPaisa, servicePaisa, deliveryPaisa)` as the second `initiate` argument. They are included in `amountPaisa`, which stays the total.",
        "The status API answers NOT_FOUND for a wrong total, so always verify with the stored amount.",
      ],
    },
    khalti: {
      initiate: `String returnUrl = baseUrl + "/payments/khalti/return/" + attempt.id();
InitiateResult init = payments.khalti().initiate(
        InitiateInput.of(attempt.id(), attempt.amountPaisa(), "Order #42", returnUrl));

// providerRef is the pidx. Lookup needs it and Khalti has no lookup by order id.
db.saveProviderRef(attempt.id(), init.providerRef());

InitiateResult.Redirect redirect = (InitiateResult.Redirect) init;
// Send the payer to redirect.url() with a 302.`,
      verify: `// Lookup uses the pidx from MY database; a different pidx in params is rejected.
VerifyResult result = payments.khalti().verify(
        VerifyInput.of(attempt.id(), attempt.amountPaisa())
                .withProviderRef(attempt.providerRef())
                .withCallback(params));
${transition}`,
      notes: [
        "Optional payer details: `.withCustomer(new Customer(name, email, phone))` on the `InitiateInput`.",
        "`new Khalti.Extras(amountBreakdown, productDetails, merchantExtras)` as the second `initiate` argument; the breakdown must sum to `amountPaisa` and merchant keys must start with `merchant_`.",
      ],
    },
    fonepay: {
      initiate: `// RU must stay under 150 chars with no query string; the attempt id rides in the path.
String returnUrl = baseUrl + "/payments/fonepay/return/" + attempt.id();
InitiateResult init = payments.fonepay().initiate(
        InitiateInput.of(attempt.id(), attempt.amountPaisa(), "Order #42", returnUrl));

// Fonepay has no providerRef: PRN is the attempt id.
InitiateResult.Redirect redirect = (InitiateResult.Redirect) init;
// Send the payer to redirect.url() with a 302.`,
      verify: `// params carry PRN, PS, UID, BC and the DV signature; a missing or bad DV is rejected.
VerifyResult result = payments.fonepay().verify(
        VerifyInput.of(attempt.id(), attempt.amountPaisa()).withCallback(params));
${transition}`,
      notes: [
        "Set `FONEPAY_USERNAME` and `FONEPAY_PASSWORD`: verify then uses txnVerification, which also works without a callback for reconciliation. Without them it falls back to the legacy check, which needs UID and BC from a signed redirect.",
        "The second `initiate` argument sets R2 (max 50 chars, default \"N/A\").",
      ],
    },
    connectips: {
      initiate: `// TXNID is the attempt id (max 20 chars; Payments.newOrderId() fits).
// connectIPS ignores returnUrl: success/failure URLs are registered with NCHL.
String returnUrl = baseUrl + "/payments/connectips/return/" + attempt.id();
InitiateResult init = payments.connectips().initiate(
        InitiateInput.of(attempt.id(), attempt.amountPaisa(), "Order #42", returnUrl));

// connectIPS has no providerRef: TXNID is the attempt id.
InitiateResult.Form form = (InitiateResult.Form) init;
// Serve Html.renderAutoSubmitForm(form) as text/html; it POSTs the payer to the login page.`,
      verify: `// The redirect carries only ?TXNID=..., so validatetxn runs on stored values alone.
VerifyResult result = payments.connectips().verify(
        VerifyInput.of(attempt.id(), attempt.amountPaisa()));
${transition}`,
      notes: [
        "Register the success and failure URLs with NCHL before testing; unregistered URLs show up as 403 after OTP.",
        "To load the creditor .pfx as issued, build the config with `ConnectIps.Config.withPkcs12(...)` instead of the PEM env var.",
        "`payments.connectips().getTxnDetail(id, amountPaisa)` returns the NCHL txnId, bank and charges.",
      ],
    },
    cybersource: {
      initiate: `// Bill-to details are required for sale and authorization.
CyberSource.BillTo billTo = CyberSource.BillTo.of(
        "Ram", "Shrestha", "ram@example.com", "Thamel", "Kathmandu", "NP");
String returnUrl = baseUrl + "/payments/cybersource/return/" + attempt.id();
InitiateResult init = payments.cybersource().initiate(
        InitiateInput.of(attempt.id(), attempt.amountPaisa(), "Order #42", returnUrl), billTo);

// CyberSource has no providerRef: transaction_uuid and reference_number are the attempt id.
InitiateResult.Form form = (InitiateResult.Form) init;
// Serve Html.renderAutoSubmitForm(form) as text/html; it POSTs the payer to /pay.`,
      verify: `// Secure Acceptance has no status API: the signed POST body is the proof.
// verify() checks the signature, the reference number and the currency.
VerifyResult result = payments.cybersource().verify(
        VerifyInput.of(attempt.id(), attempt.amountPaisa()).withCallback(params));
${transition}`,
      notes: [
        "The receipt page and Merchant POST URL are cross-site POSTs: exempt them from Spring Security CSRF.",
        "The receipt URL comes from the profile; `.withReturnUrlOverride(true)` on the config sends `returnUrl` per request instead.",
        "Without a callback, `verify` throws `verify_unavailable`; reconcile through REST Transaction Search.",
      ],
    },
    nps: {
      initiate: `String returnUrl = baseUrl + "/payments/nps/return/" + attempt.id();
InitiateResult init = payments.nps().initiate(
        InitiateInput.of(attempt.id(), attempt.amountPaisa(), "Order #42", returnUrl));

// providerRef is the NPS ProcessId.
db.saveProviderRef(attempt.id(), init.providerRef());

InitiateResult.Form form = (InitiateResult.Form) init;
// Serve Html.renderAutoSubmitForm(form) as text/html; it sets enctype="multipart/form-data".`,
      verify: `// CheckTransactionStatus looks the payment up by MerchantTxnId (the attempt id).
VerifyResult result = payments.nps().verify(
        VerifyInput.of(attempt.id(), attempt.amountPaisa()));
${transition}`,
      notes: [
        "Pass an InstrumentCode as the second `initiate` argument to skip the NPS bank picker; `payments.nps().getInstruments()` lists them.",
        "The Notification URL is set with NPS at onboarding. Answer it with `payments.nps().notificationResponse(alreadyProcessed)` only after a final status; while pending, return a non-2xx so NPS retries.",
      ],
    },
    imepay: {
      initiate: `String returnUrl = baseUrl + "/payments/imepay/return/" + attempt.id();
InitiateResult init = payments.imepay().initiate(
        InitiateInput.of(attempt.id(), attempt.amountPaisa(), "Order #42", returnUrl));

// providerRef is the IME Pay TokenId; Recheck needs it.
db.saveProviderRef(attempt.id(), init.providerRef());

InitiateResult.Redirect redirect = (InitiateResult.Redirect) init;
// Send the payer to redirect.url() with a 302.`,
      verify: `// IME Pay POSTs an UNSIGNED result, so Recheck with the stored TokenId is the only proof.
VerifyResult result = payments.imepay().verify(
        VerifyInput.of(attempt.id(), attempt.amountPaisa()).withProviderRef(attempt.providerRef()));
${transition}`,
      notes: [
        "The return is a cross-site POST: exempt the route from CSRF.",
        "Outbound port 7979 must be reachable from the server.",
        "IME Pay merged into Khalti in July 2025; use this for existing IME Pay merchant accounts.",
      ],
    },
    nepalpay: {
      initiate: `// returnUrl is unused: no redirect, the payer pays from their own banking app.
InitiateResult init = payments.nepalpay().initiate(
        InitiateInput.of(attempt.id(), attempt.amountPaisa(), "Order #42", ""));

// providerRef is the validationTraceId; verify() looks the payment up by it.
db.saveProviderRef(attempt.id(), init.providerRef());

InitiateResult.Qr qr = (InitiateResult.Qr) init;
// Show <img src="data:image/png;base64,{qr.qrImage()}">, or render qr.qrString(),
// then poll GET /payments/{id}/status from the page every 3-5 s.`,
      verify: `// GET /payments/{id}/status, polled by the QR page. Also what the reconciliation job runs.
VerifyResult result = payments.nepalpay().verify(
        VerifyInput.of(attempt.id(), attempt.amountPaisa()).withProviderRef(attempt.providerRef()));
${transition}`,
      notes: [
        "The amount goes out as rupees with two decimals; `billNumber` (the order id) is at most 25 chars.",
        "`verifyConfirmation` and `confirmationResponse` handle NCHL's confirm-payment callback; `webSocketRequest` builds the STOMP request for live status.",
      ],
    },
  },
};

export default snippets;

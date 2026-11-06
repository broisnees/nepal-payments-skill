import type { LangSnippets } from "./types";

// Shared tail of every verify snippet: decide, write with a guarded UPDATE, fulfil on paid.
const transition = `
val age = java.time.Duration.between(attempt.createdAt, Instant.now()).toKotlinDuration()
val d = decideTransition(AttemptStatus.fromWire(attempt.status)!!, result, attempt.amountPaisa, age)
if (d.reviewRequired || d.latePaid) {
    // alert a human with d.reason
}
d.next?.let { next ->
    // UPDATE payment_attempts SET status = next.wire, provider_txn_id = result.transactionId
    //  WHERE id = attempt.id AND status = attempt.status
    if (next == PaymentStatus.PAID) {
        // fulfil the order here, only if that UPDATE changed a row
    }
}`;

const snippets: LangSnippets = {
  lang: "kotlin",
  label: "Kotlin",
  setup: `import np.payments.*
import java.time.Instant
import kotlin.time.toKotlinDuration

// Build once at startup. Providers whose required env vars are missing stay
// disabled; a bad CONNECTIPS_PRIVATE_KEY_PEM fails here, at boot.
val payments = Payments.create(paymentsConfigFromEnv())`,
  providers: {
    esewa: {
      initiate: `// eSewa appends ?data=... to the return URL, so the attempt id goes in the path.
// The same URL serves as failure_url, so failed payments can be matched too.
val init = payments.esewa.initiate(
    InitiateInput(
        orderId = attempt.id,
        amountPaisa = attempt.amountPaisa,
        description = "Order #42",
        returnUrl = "$baseUrl/payments/esewa/return/\${attempt.id}",
    ),
)
// eSewa has no providerRef: the form carries the signed fields.
// Respond with renderAutoSubmitForm(init as InitiateResult.Form) as text/html.`,
      verify: `// On success params holds "data" (signed base64 JSON); failure redirects carry nothing.
// verify() checks that signature, then asks the status API with the stored total.
val result = payments.esewa.verify(
    VerifyInput(orderId = attempt.id, amountPaisa = attempt.amountPaisa, callback = params),
)
${transition}`,
      notes: [
        "Tax, service and delivery charges go in `EsewaInitiateExtras(taxPaisa, serviceChargePaisa, deliveryChargePaisa)` as the second `initiate` argument. They are included in `amountPaisa`, which stays the total.",
        "Adapter calls are `suspend` functions: call them from a Ktor handler or another coroutine.",
      ],
    },
    khalti: {
      initiate: `val init = payments.khalti.initiate(
    InitiateInput(
        orderId = attempt.id,
        amountPaisa = attempt.amountPaisa,
        description = "Order #42",
        returnUrl = "$baseUrl/payments/khalti/return/\${attempt.id}",
    ),
)
// providerRef is the pidx. Lookup needs it and Khalti has no lookup by order id.
init.providerRef?.let { db.saveProviderRef(attempt.id, it) }
// Redirect the payer to (init as InitiateResult.Redirect).url.`,
      verify: `// Lookup uses the pidx from MY database; a different pidx in params is rejected.
val result = payments.khalti.verify(
    VerifyInput(
        orderId = attempt.id,
        amountPaisa = attempt.amountPaisa,
        providerRef = attempt.providerRef,
        callback = params,
    ),
)
${transition}`,
      notes: [
        "Optional payer details: `customer = Customer(name, email, phone)` on the `InitiateInput`.",
        "`KhaltiInitiateExtras(amountBreakdown, productDetails, merchantExtras)` as the second `initiate` argument; the breakdown must sum to `amountPaisa` and merchant keys must start with `merchant_`.",
      ],
    },
    fonepay: {
      initiate: `// RU must stay under 150 chars with no query string; the attempt id rides in the path.
val init = payments.fonepay.initiate(
    InitiateInput(
        orderId = attempt.id,
        amountPaisa = attempt.amountPaisa,
        description = "Order #42",
        returnUrl = "$baseUrl/payments/fonepay/return/\${attempt.id}",
    ),
)
// Fonepay has no providerRef: PRN is the attempt id.
// Redirect the payer to (init as InitiateResult.Redirect).url.`,
      verify: `// params carry PRN, PS, UID, BC and the DV signature; a missing or bad DV is rejected.
val result = payments.fonepay.verify(
    VerifyInput(orderId = attempt.id, amountPaisa = attempt.amountPaisa, callback = params),
)
${transition}`,
      notes: [
        "Set `FONEPAY_USERNAME` and `FONEPAY_PASSWORD`: verify then uses txnVerification, which also works without a callback for reconciliation. Without them it falls back to the legacy check, which needs UID and BC from a signed redirect.",
        "`FonepayInitiateExtras(remarks2 = ...)` sets R2 (max 50 chars, default \"N/A\").",
      ],
    },
    connectips: {
      initiate: `// TXNID is the attempt id (max 20 chars; newOrderId() fits).
// connectIPS ignores returnUrl: success/failure URLs are registered with NCHL.
val init = payments.connectips.initiate(
    InitiateInput(
        orderId = attempt.id,
        amountPaisa = attempt.amountPaisa,
        description = "Order #42",
        returnUrl = "$baseUrl/payments/connectips/return/\${attempt.id}",
    ),
)
// connectIPS has no providerRef: TXNID is the attempt id.
// Respond with renderAutoSubmitForm(init as InitiateResult.Form) as text/html.`,
      verify: `// The redirect carries only ?TXNID=..., so validatetxn runs on stored values alone.
val result = payments.connectips.verify(
    VerifyInput(orderId = attempt.id, amountPaisa = attempt.amountPaisa),
)
${transition}`,
      notes: [
        "Register the success and failure URLs with NCHL before testing; unregistered URLs show up as 403 after OTP.",
        "The PEM must be PKCS#8 (`-----BEGIN PRIVATE KEY-----`); `\\n` escapes in the env var are accepted.",
        "`payments.connectips.getTxnDetail(id, amountPaisa)` returns the NCHL txnId, bank and charges.",
      ],
    },
    cybersource: {
      initiate: `val init = payments.cybersource.initiate(
    InitiateInput(
        orderId = attempt.id,
        amountPaisa = attempt.amountPaisa,
        description = "Order #42",
        returnUrl = "$baseUrl/payments/cybersource/return/\${attempt.id}",
    ),
    // Bill-to details are required for sale and authorization.
    CyberSourceInitiateExtras(
        billTo = BillTo(
            forename = "Ram", surname = "Shrestha", email = "ram@example.com",
            addressLine1 = "Thamel", city = "Kathmandu", country = "NP",
        ),
    ),
)
// CyberSource has no providerRef: transaction_uuid and reference_number are the attempt id.
// Respond with renderAutoSubmitForm(init as InitiateResult.Form) as text/html.`,
      verify: `// Secure Acceptance has no status API: the signed POST body is the proof.
// verify() checks the signature, the reference number and the currency.
val result = payments.cybersource.verify(
    VerifyInput(orderId = attempt.id, amountPaisa = attempt.amountPaisa, callback = params),
)
${transition}`,
      notes: [
        "The receipt page and Merchant POST URL are cross-site POSTs: keep Ktor's CSRF plugin off those routes.",
        "The receipt URL comes from the profile; `useReturnUrlOverride = true` on `CyberSourceConfig` sends `returnUrl` per request instead.",
        "Without a callback, `verify` throws `verify_unavailable`; reconcile through REST Transaction Search.",
      ],
    },
    nps: {
      initiate: `val init = payments.nps.initiate(
    InitiateInput(
        orderId = attempt.id,
        amountPaisa = attempt.amountPaisa,
        description = "Order #42",
        returnUrl = "$baseUrl/payments/nps/return/\${attempt.id}",
    ),
)
// providerRef is the NPS ProcessId.
init.providerRef?.let { db.saveProviderRef(attempt.id, it) }
// Respond with renderAutoSubmitForm(init as InitiateResult.Form) as text/html;
// it sets enctype="multipart/form-data".`,
      verify: `// CheckTransactionStatus looks the payment up by MerchantTxnId (the attempt id).
val result = payments.nps.verify(
    VerifyInput(orderId = attempt.id, amountPaisa = attempt.amountPaisa),
)
${transition}`,
      notes: [
        "`NpsInitiateExtras(instrumentCode = ...)` skips the NPS bank picker; `payments.nps.getInstruments()` lists the codes.",
        "Notification URL handler: `payments.nps.notificationAck(wasFinal, currentStatus)` returns the body to send, or `null` while the status isn't final (respond 503 so NPS retries).",
      ],
    },
    imepay: {
      initiate: `val init = payments.imepay.initiate(
    InitiateInput(
        orderId = attempt.id,
        amountPaisa = attempt.amountPaisa,
        description = "Order #42",
        returnUrl = "$baseUrl/payments/imepay/return/\${attempt.id}",
    ),
)
// providerRef is the IME Pay TokenId; Recheck needs it.
init.providerRef?.let { db.saveProviderRef(attempt.id, it) }
// Redirect the payer to (init as InitiateResult.Redirect).url.`,
      verify: `// IME Pay POSTs an UNSIGNED result, so Recheck with the stored TokenId is the only proof.
val result = payments.imepay.verify(
    VerifyInput(orderId = attempt.id, amountPaisa = attempt.amountPaisa, providerRef = attempt.providerRef),
)
${transition}`,
      notes: [
        "The return is a cross-site POST: keep Ktor's CSRF plugin off that route.",
        "Outbound port 7979 must be reachable from the server.",
        "IME Pay merged into Khalti in July 2025; use this for existing IME Pay merchant accounts.",
      ],
    },
    nepalpay: {
      initiate: `val init = payments.nepalpay.initiate(
    InitiateInput(
        orderId = attempt.id, // billNumber: 1-25 chars [A-Za-z0-9-]
        amountPaisa = attempt.amountPaisa, // sent as rupees with two decimals
        description = "Order #42",
        returnUrl = "", // unused: no redirect, the payer pays from their own banking app
    ),
) as InitiateResult.Qr
// providerRef is the validationTraceId; verify() looks the payment up by it.
db.saveProviderRef(attempt.id, init.providerRef)
// Show <img src="data:image/png;base64,{init.qrImage}">, or render init.qrString,
// then poll GET /payments/{id}/status from the page every 3-5 s.`,
      verify: `// GET /payments/{id}/status, polled by the QR page. Also what the reconciliation job runs.
val result = payments.nepalpay.verify(
    VerifyInput(orderId = attempt.id, amountPaisa = attempt.amountPaisa, providerRef = attempt.providerRef),
)
${transition}`,
      notes: [
        "A debited row whose credit isn't confirmed maps to `UNKNOWN`: money left the payer, so a person reviews it.",
        "`verifyConfirmation` and `confirmationResponse` handle NCHL's confirm-payment callback; `webSocketRequest` builds the STOMP request for live status.",
      ],
    },
  },
};

export default snippets;

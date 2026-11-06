import type { LangSnippets } from "./types";

const snippets: LangSnippets = {
  lang: "php",
  label: "PHP",
  setup: String.raw`use NepalPayments\{AttemptStatus, InitiateInput, Payments, StateMachine, VerifyInput};
use NepalPayments\CyberSource\BillTo;

// Autoload scripts/php/src as the NepalPayments\ namespace (PSR-4). PHP 8.1+, no Composer dependencies.
// Reads ESEWA_*, KHALTI_*, FONEPAY_*, ... (env.md). A provider is enabled when its required vars are set.
$payments = Payments::create(Payments::configFromEnv());`,
  providers: {
    esewa: {
      initiate: String.raw`$init = $payments->esewa()->initiate(
    new InitiateInput(
        orderId: $attempt->id,
        amountPaisa: $attempt->amountPaisa, // the TOTAL charged
        description: 'Order #42',
        // no query string: eSewa appends ?data=..., so the attempt id goes in the path
        returnUrl: "{$baseUrl}/payments/esewa/return/{$attempt->id}",
    ),
);
// FormResult: echo $init->render(); auto-submits the signed form to eSewa`,
      verify: String.raw`// throws on network/5xx/bad signature: leave the attempt open, reconciliation settles it
$result = $payments->esewa()->verify(new VerifyInput(
    orderId: $attempt->id,
    amountPaisa: $attempt->amountPaisa,
    callback: $params, // ?data=... on success; failure redirects carry nothing
));
$ageMs = (time() - $attempt->createdAt->getTimestamp()) * 1000;
$d = StateMachine::decideFor(AttemptStatus::from($attempt->status), $result, $attempt->amountPaisa, $ageMs);
if ($d->next !== null) {
    // UPDATE payment_attempts SET status = $d->next->value WHERE id = ? AND status = $attempt->status
    if ($d->next === AttemptStatus::Paid) {
        // fulfil the order here, only if that UPDATE touched one row
    }
}`,
      notes: [
        "Tax, service and delivery charges are optional `initiate()` args (`taxPaisa:`, `serviceChargePaisa:`, `deliveryChargePaisa:`), included in `amountPaisa`.",
        "eSewa answers NOT_FOUND for a wrong total, so the stored total doubles as the amount check.",
      ],
    },
    khalti: {
      initiate: String.raw`$init = $payments->khalti()->initiate(
    new InitiateInput(
        orderId: $attempt->id,
        amountPaisa: $attempt->amountPaisa, // minimum 1000 (Rs 10)
        description: 'Order #42',
        returnUrl: "{$baseUrl}/payments/khalti/return/{$attempt->id}",
    ),
);
// pidx: verify() needs it and Khalti has no lookup by order id
$db->saveProviderRef($attempt->id, $init->providerRef);
// RedirectResult: header("Location: {$init->url}", true, 303);`,
      verify: String.raw`// throws on network/5xx: leave the attempt open, reconciliation settles it
$result = $payments->khalti()->verify(new VerifyInput(
    orderId: $attempt->id,
    amountPaisa: $attempt->amountPaisa,
    providerRef: $attempt->providerRef, // the stored pidx, never the one in $params
    callback: $params,                  // a different callback pidx throws pidx_mismatch
));
$ageMs = (time() - $attempt->createdAt->getTimestamp()) * 1000;
$d = StateMachine::decideFor(AttemptStatus::from($attempt->status), $result, $attempt->amountPaisa, $ageMs);
if ($d->next !== null) {
    // UPDATE payment_attempts SET status = $d->next->value WHERE id = ? AND status = $attempt->status
    if ($d->next === AttemptStatus::Paid) {
        // fulfil the order here, only if that UPDATE touched one row
    }
}`,
      notes: [
        "Optional `initiate()` args: `amountBreakdown:` (must sum to the amount), `productDetails:`, and `merchantExtras:` (keys start with `merchant_`).",
        "Pass `customer: new Customer($name, $email, $phone)` to `InitiateInput` to prefill `customer_info`.",
      ],
    },
    fonepay: {
      initiate: String.raw`$init = $payments->fonepay()->initiate(
    new InitiateInput(
        orderId: $attempt->id, // PRN, 3 to 25 chars
        amountPaisa: $attempt->amountPaisa,
        description: 'Order #42', // R1
        // RU: at most 150 chars, no query string
        returnUrl: "{$baseUrl}/payments/fonepay/return/{$attempt->id}",
    ),
    remarks2: 'web', // R2, optional (default "N/A")
);
// RedirectResult: header("Location: {$init->url}", true, 303);`,
      verify: String.raw`// throws on network/5xx or a missing/invalid DV: leave the attempt open
$result = $payments->fonepay()->verify(new VerifyInput(
    orderId: $attempt->id,
    amountPaisa: $attempt->amountPaisa,
    callback: $params, // PRN, PS, RC, UID, BC, ..., DV: checked before anything is trusted
));
$ageMs = (time() - $attempt->createdAt->getTimestamp()) * 1000;
$d = StateMachine::decideFor(AttemptStatus::from($attempt->status), $result, $attempt->amountPaisa, $ageMs);
if ($d->next !== null) {
    // UPDATE payment_attempts SET status = $d->next->value WHERE id = ? AND status = $attempt->status
    if ($d->next === AttemptStatus::Paid) {
        // fulfil the order here, only if that UPDATE touched one row
    }
}`,
      notes: [
        "Set `FONEPAY_USERNAME` and `FONEPAY_PASSWORD` to verify through txnVerification, which also works without a callback (reconciliation). Without them `verify()` needs the DV-signed UID and BC from the redirect.",
        "Dynamic QR: `qrCreate()`, then `qrStatus($orderId, $amountPaisa)` before fulfilling.",
      ],
    },
    connectips: {
      initiate: String.raw`$init = $payments->connectIps()->initiate(
    new InitiateInput(
        orderId: $attempt->id, // TXNID: 1 to 20 chars [A-Za-z0-9-]
        amountPaisa: $attempt->amountPaisa,
        description: 'Order #42', // REMARKS and PARTICULARS default to this
        // unused: success/failure URLs are registered with NCHL and come back with ?TXNID=...
        returnUrl: "{$baseUrl}/payments/connectips/return/{$attempt->id}",
    ),
    referenceId: $attempt->id, // optional, <= 20 chars
);
// FormResult: echo $init->render(); auto-submits the RSA-signed form to the connectIPS login page`,
      verify: String.raw`// validatetxn with Basic auth; throws on network/5xx: leave the attempt open
$result = $payments->connectIps()->verify(new VerifyInput(
    orderId: $attempt->id,
    amountPaisa: $attempt->amountPaisa,
));
$ageMs = (time() - $attempt->createdAt->getTimestamp()) * 1000;
$d = StateMachine::decideFor(AttemptStatus::from($attempt->status), $result, $attempt->amountPaisa, $ageMs);
if ($d->next !== null) {
    // UPDATE payment_attempts SET status = $d->next->value WHERE id = ? AND status = $attempt->status
    if ($d->next === AttemptStatus::Paid) {
        // fulfil the order here, only if that UPDATE touched one row
    }
}`,
      notes: [
        "`ConnectIpsConfig::fromPfx()` reads the creditor `.pfx` NCHL sent. Old RC2-encrypted files fail on OpenSSL 3 with `pfx_legacy_encryption`.",
        "`getTxnDetail($orderId, $amountPaisa)` returns the NCHL txnId, bank, charges and creditStatus.",
      ],
    },
    cybersource: {
      initiate: String.raw`$init = $payments->cyberSource()->initiate(
    new InitiateInput(
        orderId: $attempt->id, // transaction_uuid and reference_number, <= 50 chars
        amountPaisa: $attempt->amountPaisa,
        description: 'Order #42',
        returnUrl: "{$baseUrl}/payments/cybersource/return/{$attempt->id}",
    ),
    billTo: new BillTo( // required for sale/authorization
        forename: 'Ram', surname: 'Shrestha', email: 'ram@example.com',
        addressLine1: 'Durbar Marg', city: 'Kathmandu', country: 'NP',
    ),
);
// FormResult: echo $init->render(); auto-submits the signed form to /pay`,
      verify: String.raw`// $params is the signed response POST: it IS the proof (no status API)
// throws invalid_signature / callback_mismatch: answer 400 and leave the attempt open
$result = $payments->cyberSource()->verify(new VerifyInput(
    orderId: $attempt->id,
    amountPaisa: $attempt->amountPaisa,
    callback: $params,
));
$ageMs = (time() - $attempt->createdAt->getTimestamp()) * 1000;
$d = StateMachine::decideFor(AttemptStatus::from($attempt->status), $result, $attempt->amountPaisa, $ageMs);
if ($d->next !== null) {
    // UPDATE payment_attempts SET status = $d->next->value WHERE id = ? AND status = $attempt->status
    if ($d->next === AttemptStatus::Paid) {
        // fulfil the order here, only if that UPDATE touched one row
    }
}`,
      notes: [
        "The receipt page comes from the Secure Acceptance profile. `returnUrl` is sent only with `useReturnUrlOverride: true` on `CyberSourceConfig`, which `configFromEnv()` leaves off.",
        "The return is a POST: exempt it from CSRF. Without a callback (reconciliation) `verify()` throws `verify_unavailable`; use REST Transaction Search.",
        "Optional `merchantDefinedData:` maps n to `merchant_defined_data<n>` (no PII).",
      ],
    },
    nps: {
      initiate: String.raw`$init = $payments->nps()->initiate(
    new InitiateInput(
        orderId: $attempt->id, // MerchantTxnId
        amountPaisa: $attempt->amountPaisa,
        description: 'Order #42', // TransactionRemarks
        returnUrl: "{$baseUrl}/payments/nps/return/{$attempt->id}", // ResponseUrl
    ),
    instrumentCode: null, // optional: skips the NPS bank/wallet picker
);
// ProcessId from GetProcessId
$db->saveProviderRef($attempt->id, $init->providerRef);
// FormResult: echo $init->render(); multipart auto-POST to /Payment/Index`,
      verify: String.raw`// CheckTransactionStatus by MerchantTxnId; throws on network/5xx: leave the attempt open
$result = $payments->nps()->verify(new VerifyInput(
    orderId: $attempt->id,
    amountPaisa: $attempt->amountPaisa,
));
$ageMs = (time() - $attempt->createdAt->getTimestamp()) * 1000;
$d = StateMachine::decideFor(AttemptStatus::from($attempt->status), $result, $attempt->amountPaisa, $ageMs);
if ($d->next !== null) {
    // UPDATE payment_attempts SET status = $d->next->value WHERE id = ? AND status = $attempt->status
    if ($d->next === AttemptStatus::Paid) {
        // fulfil the order here, only if that UPDATE touched one row
    }
}`,
      notes: [
        "The Notification URL is set with NPS at onboarding. Run the same verify there and reply with `notificationResponse($alreadyProcessed)` (plain text `received` / `already received`).",
        "`getInstruments()` lists banks and wallets for your own picker; pass the chosen code as `instrumentCode:`.",
      ],
    },
    imepay: {
      initiate: String.raw`$init = $payments->imePay()->initiate(
    new InitiateInput(
        orderId: $attempt->id, // RefId
        amountPaisa: $attempt->amountPaisa,
        description: 'Order #42',
        returnUrl: "{$baseUrl}/payments/imepay/return/{$attempt->id}", // RespUrl and CancelUrl
    ),
);
// TokenId: Recheck needs it
$db->saveProviderRef($attempt->id, $init->providerRef);
// RedirectResult: header("Location: {$init->url}", true, 303);`,
      verify: String.raw`// callbacks are unsigned: Recheck with the stored TokenId is the only proof
$result = $payments->imePay()->verify(new VerifyInput(
    orderId: $attempt->id,
    amountPaisa: $attempt->amountPaisa,
    providerRef: $attempt->providerRef,
));
$ageMs = (time() - $attempt->createdAt->getTimestamp()) * 1000;
$d = StateMachine::decideFor(AttemptStatus::from($attempt->status), $result, $attempt->amountPaisa, $ageMs);
if ($d->next !== null) {
    // UPDATE payment_attempts SET status = $d->next->value WHERE id = ? AND status = $attempt->status
    if ($d->next === AttemptStatus::Paid) {
        // fulfil the order here, only if that UPDATE touched one row
    }
}`,
      notes: [
        "IME Pay merged into Khalti in July 2025; prefer Khalti for new builds.",
        "IME POSTs to the return URL (exempt it from CSRF), and outbound port 7979 must be reachable.",
        "Non-zero Recheck codes map to pending, never failed; reconciliation escalates them at its cutoff.",
      ],
    },
    nepalpay: {
      initiate: String.raw`$init = $payments->nepalPay()->initiate(
    new InitiateInput(
        orderId: $attempt->id, // billNumber: 1 to 25 chars [A-Za-z0-9-]
        amountPaisa: $attempt->amountPaisa, // sent as rupees with two decimals ("100.00")
        description: 'Order #42', // purposeOfTransaction, 25 chars max
        returnUrl: '', // unused: no redirect, the payer pays from their own banking app
    ),
);
// validationTraceId: verify() looks the payment up by it
$db->saveProviderRef($attempt->id, $init->providerRef);
// QrResult: show <img src="data:image/png;base64,{$init->qrImage}">, or render $init->qrString,
// then poll GET /payments/{id}/status from the page every 3-5 s.`,
      verify: String.raw`// GET /payments/{id}/status, polled by the QR page. Also what the reconciliation job runs.
$result = $payments->nepalPay()->verify(new VerifyInput(
    orderId: $attempt->id,
    amountPaisa: $attempt->amountPaisa,
    providerRef: $attempt->providerRef, // the stored validationTraceId; required
));
$ageMs = (time() - $attempt->createdAt->getTimestamp()) * 1000;
$d = StateMachine::decideFor(AttemptStatus::from($attempt->status), $result, $attempt->amountPaisa, $ageMs);
if ($d->next !== null) {
    // UPDATE payment_attempts SET status = $d->next->value WHERE id = ? AND status = $attempt->status
    if ($d->next === AttemptStatus::Paid) {
        // fulfil the order here, only if that UPDATE touched one row
    }
}`,
      notes: [
        "A debited row whose credit isn't confirmed maps to `unknown`: money left the payer, so a person reviews it.",
        "`verifyConfirmation()` and `confirmationResponse()` handle NCHL's confirm-payment callback; `webSocketRequest()` builds the STOMP request for live status.",
      ],
    },
  },
};

export default snippets;

import type { LangSnippets } from "./types";

const snippets: LangSnippets = {
  lang: "ts",
  label: "TypeScript",
  setup: `import { createPayments, decideTransition, paymentsConfigFromEnv, renderAutoSubmitForm } from "./payments/index.ts";

// Enables every provider whose env vars are set (references/env.md). Build it once per process.
export const payments = createPayments(paymentsConfigFromEnv());

// Workers / edge: pass the env bindings instead of process.env.
// const payments = createPayments(paymentsConfigFromEnv(env));`,
  providers: {
    esewa: {
      initiate: `// No providerRef: the status API looks the payment up by transaction_uuid + total.
const init = await payments.get("esewa").initiate({
  orderId: attempt.id, // transaction_uuid: letters, digits and "-" only
  amountPaisa: attempt.amountPaisa, // the TOTAL charged; verify() gets the same number
  description: "Order #42",
  returnUrl: \`\${baseUrl}/payments/esewa/return/\${attempt.id}\`, // no query string: eSewa appends ?data=
});
// init.kind === "form": serve renderAutoSubmitForm(init) as text/html from /payments/:id/start`,
      verify: `const result = await payments.get("esewa").verify({
  orderId: attempt.id,
  amountPaisa: attempt.amountPaisa, // stored total; a wrong total comes back as not_found
  callback: params, // ?data= on success: signature and transaction_uuid are checked, then the status API
});
const d = decideTransition(attempt.status, result, attempt.amountPaisa, Date.now() - attempt.createdAt.getTime());
// Write d.next with UPDATE ... WHERE id = attempt.id AND status = attempt.status.
// d.reviewRequired or d.latePaid: alert a human.
if (d.next === "paid") {
  // fulfil the order here, only when that UPDATE changed a row
}`,
      notes: [
        "Optional `taxPaisa`, `serviceChargePaisa` and `deliveryChargePaisa` are a breakdown INCLUDED in `amountPaisa`, not added to it.",
        "Failure redirects carry no `data`, so the attempt id in the return path is how the handler finds the attempt.",
        "This is the ePay v2 web flow. The mobile Intent flow uses `intentBook()` and `intentVerify()`.",
      ],
    },
    khalti: {
      initiate: `const init = await payments.get("khalti").initiate({
  orderId: attempt.id, // purchase_order_id
  amountPaisa: attempt.amountPaisa, // minimum 1000 (Rs 10)
  description: "Order #42", // purchase_order_name
  returnUrl: \`\${baseUrl}/payments/khalti/return/\${attempt.id}\`,
});
// pidx: lookup needs it and Khalti has no lookup by order id
if (init.providerRef) await db.saveProviderRef(attempt.id, init.providerRef);
// init.kind === "redirect": 302 the browser to init.url (the link expires at init.expiresAt)`,
      verify: `const result = await payments.get("khalti").verify({
  orderId: attempt.id,
  amountPaisa: attempt.amountPaisa,
  providerRef: attempt.providerRef, // the pidx saved at initiate, never the one in params
  callback: params, // a params.pidx that differs from the stored one is rejected
});
const d = decideTransition(attempt.status, result, attempt.amountPaisa, Date.now() - attempt.createdAt.getTime());
// Write d.next with UPDATE ... WHERE id = attempt.id AND status = attempt.status.
// d.reviewRequired or d.latePaid: alert a human.
if (d.next === "paid") {
  // fulfil the order here, only when that UPDATE changed a row
}`,
      notes: [
        "Optional extras: `customer` ({ name, email, phone }), `amountBreakdown` (must sum to `amountPaisa`), `productDetails`, and `merchantExtras` with `merchant_`-prefixed keys.",
        "Expired and canceled payments come back from lookup as HTTP 400 with a normal body; `verify()` maps them instead of throwing.",
      ],
    },
    fonepay: {
      initiate: `// No providerRef: verification looks the payment up by PRN + amount.
const init = await payments.get("fonepay").initiate({
  orderId: attempt.id, // PRN: 3-25 chars
  amountPaisa: attempt.amountPaisa,
  description: "Order #42", // R1, up to 160 chars
  returnUrl: \`\${baseUrl}/payments/fonepay/return/\${attempt.id}\`, // RU: 150 chars max, no query string
});
// init.kind === "redirect": 302 the browser to init.url`,
      verify: `const result = await payments.get("fonepay").verify({
  orderId: attempt.id,
  amountPaisa: attempt.amountPaisa,
  callback: params, // PRN, PS, RC, UID, BC, ... DV: trusted only when the DV checks out
});
const d = decideTransition(attempt.status, result, attempt.amountPaisa, Date.now() - attempt.createdAt.getTime());
// Write d.next with UPDATE ... WHERE id = attempt.id AND status = attempt.status.
// d.reviewRequired or d.latePaid: alert a human.
if (d.next === "paid") {
  // fulfil the order here, only when that UPDATE changed a row
}`,
      notes: [
        "Set `FONEPAY_USERNAME` and `FONEPAY_PASSWORD`: `verify()` then uses txnVerification, which also works without a callback (reconciliation). Without them it needs the DV-signed UID and BC from the redirect.",
        "Optional `remarks2` fills R2 (50 chars, defaults to \"N/A\").",
      ],
    },
    connectips: {
      initiate: `// No providerRef: validatetxn looks the payment up by TXNID + amount.
const init = await payments.get("connectips").initiate({
  orderId: attempt.id, // TXNID: 1-20 chars [A-Za-z0-9-], unique per app
  amountPaisa: attempt.amountPaisa, // TXNAMT is sent in paisa
  description: "Order #42", // REMARKS and PARTICULARS unless you pass remarks / particulars
  returnUrl: \`\${baseUrl}/payments/connectips/return/\${attempt.id}\`, // unused: NCHL holds the registered URLs
});
// init.kind === "form": serve renderAutoSubmitForm(init) as text/html from /payments/:id/start`,
      verify: `// connectIPS returns with ?TXNID=<attempt.id>; load the attempt by it, then:
const result = await payments.get("connectips").verify({
  orderId: attempt.id,
  amountPaisa: attempt.amountPaisa, // signed into the validatetxn token
});
const d = decideTransition(attempt.status, result, attempt.amountPaisa, Date.now() - attempt.createdAt.getTime());
// Write d.next with UPDATE ... WHERE id = attempt.id AND status = attempt.status.
// d.reviewRequired or d.latePaid: alert a human.
if (d.next === "paid") {
  // fulfil the order here, only when that UPDATE changed a row
}`,
      notes: [
        "`CONNECTIPS_PRIVATE_KEY_PEM` must be PKCS#8 (`BEGIN PRIVATE KEY`). Convert the creditor .pfx once with `openssl pkcs12 ... | openssl pkcs8 -topk8 -nocrypt`.",
        "Success and failure URLs are registered with NCHL, so they can't carry the attempt id; the handler reads `TXNID`.",
        "`getTxnDetail(orderId, amountPaisa)` adds the NCHL txnId, bank, charges and creditStatus.",
      ],
    },
    cybersource: {
      initiate: `const init = await payments.get("cybersource").initiate({
  orderId: attempt.id, // transaction_uuid and reference_number, 50 chars max
  amountPaisa: attempt.amountPaisa,
  description: "Order #42",
  returnUrl: \`\${baseUrl}/payments/cybersource/return/\${attempt.id}\`, // sent only with useReturnUrlOverride
  billTo: {
    // required: collect it at checkout (state and postalCode only for US/CA)
    forename: "Sita", surname: "Sharma", email: "sita@example.com",
    addressLine1: "Durbar Marg", city: "Kathmandu", country: "NP",
  },
});
// init.kind === "form": serve renderAutoSubmitForm(init) as text/html from /payments/:id/start`,
      verify: `const result = await payments.get("cybersource").verify({
  orderId: attempt.id,
  amountPaisa: attempt.amountPaisa,
  callback: params, // the signed response POST is the only proof: no params, no verify
});
const d = decideTransition(attempt.status, result, attempt.amountPaisa, Date.now() - attempt.createdAt.getTime());
// Write d.next with UPDATE ... WHERE id = attempt.id AND status = attempt.status.
// d.reviewRequired or d.latePaid: alert a human.
if (d.next === "paid") {
  // fulfil the order here, only when that UPDATE changed a row
}`,
      notes: [
        "The return is a cross-site form POST: parse urlencoded bodies on this route and exempt it from CSRF checks.",
        "The receipt URL comes from the Secure Acceptance profile; `returnUrl` is only sent when the config sets `useReturnUrlOverride: true`. Optional `merchantDefinedData` must not hold PII.",
        "Secure Acceptance has no status API, so reconciliation needs the REST Transaction Search (references/cybersource.md).",
      ],
    },
    nps: {
      initiate: `const init = await payments.get("nps").initiate({
  orderId: attempt.id, // MerchantTxnId
  amountPaisa: attempt.amountPaisa,
  description: "Order #42", // TransactionRemarks, 100 chars max
  returnUrl: \`\${baseUrl}/payments/nps/return/\${attempt.id}\`, // ResponseUrl
});
// ProcessId from GetProcessId
if (init.providerRef) await db.saveProviderRef(attempt.id, init.providerRef);
// init.kind === "form" (multipart): serve renderAutoSubmitForm(init) from /payments/:id/start`,
      verify: `const result = await payments.get("nps").verify({
  orderId: attempt.id, // CheckTransactionStatus looks up MerchantTxnId
  amountPaisa: attempt.amountPaisa,
});
const d = decideTransition(attempt.status, result, attempt.amountPaisa, Date.now() - attempt.createdAt.getTime());
// Write d.next with UPDATE ... WHERE id = attempt.id AND status = attempt.status.
// d.reviewRequired or d.latePaid: alert a human.
if (d.next === "paid") {
  // fulfil the order here, only when that UPDATE changed a row
}`,
      notes: [
        "Optional `instrumentCode` (from `getInstruments()`) skips the NPS bank picker.",
        "NPS also GETs your Notification URL (set at onboarding). Run the same verify there and answer with `notificationResponse(alreadyProcessed)`.",
      ],
    },
    imepay: {
      initiate: `const init = await payments.get("imepay").initiate({
  orderId: attempt.id, // RefId
  amountPaisa: attempt.amountPaisa,
  description: "Order #42",
  returnUrl: \`\${baseUrl}/payments/imepay/return/\${attempt.id}\`, // RespUrl (and CancelUrl unless failureUrl is set)
});
// TokenId: Recheck needs it
if (init.providerRef) await db.saveProviderRef(attempt.id, init.providerRef);
// init.kind === "redirect": 302 the browser to init.url`,
      verify: `const result = await payments.get("imepay").verify({
  orderId: attempt.id,
  amountPaisa: attempt.amountPaisa,
  providerRef: attempt.providerRef, // the stored TokenId; the POSTed callback is unsigned
});
const d = decideTransition(attempt.status, result, attempt.amountPaisa, Date.now() - attempt.createdAt.getTime());
// Write d.next with UPDATE ... WHERE id = attempt.id AND status = attempt.status.
// d.reviewRequired or d.latePaid: alert a human.
if (d.next === "paid") {
  // fulfil the order here, only when that UPDATE changed a row
}`,
      notes: [
        "IME Pay POSTs the result to RespUrl / CancelUrl: parse urlencoded bodies and exempt the route from CSRF checks.",
        "Recheck maps every non-zero ResponseCode to pending, never failed; reconciliation escalates at its cutoff.",
        "The API runs on port 7979; outbound traffic to it must be allowed.",
      ],
    },
    nepalpay: {
      initiate: `const init = await payments.get("nepalpay").initiate({
  orderId: attempt.id, // billNumber: 1-25 chars [A-Za-z0-9-]
  amountPaisa: attempt.amountPaisa, // sent as rupees with two decimals ("100.00")
  description: "Order #42", // purposeOfTransaction, 25 chars max
  returnUrl: "", // unused: no redirect, the payer pays from their own banking app
});
if (init.kind !== "qr") throw new Error("expected a QR");
// validationTraceId: verify() looks the payment up by it
await db.saveProviderRef(attempt.id, init.providerRef);
// Show <img src="data:image/png;base64,\${init.qrImage}">, or render init.qrString with any QR library,
// then poll GET /payments/:id/status from the page every 3-5 s.`,
      verify: `// GET /payments/:id/status, polled by the QR page. Also what the reconciliation job runs.
const result = await payments.get("nepalpay").verify({
  orderId: attempt.id,
  amountPaisa: attempt.amountPaisa,
  providerRef: attempt.providerRef, // the stored validationTraceId; required
});
const d = decideTransition(attempt.status, result, attempt.amountPaisa, Date.now() - attempt.createdAt.getTime());
// Write d.next with UPDATE ... WHERE id = attempt.id AND status = attempt.status.
// d.reviewRequired or d.latePaid: alert a human.
if (d.next === "paid") {
  // fulfil the order here, only when that UPDATE changed a row
}
// Answer the page with the stored status: { status: d.next ?? attempt.status }`,
      notes: [
        "`initiate()` returns `{ kind: \"qr\", qrString, qrImage?, providerRef }`. A route that handled only `redirect` and `form` needs a third branch.",
        "`verify()` maps a debited row whose credit isn't confirmed to `unknown`: money left the payer, so a person reviews it.",
        "`verifyConfirmation()` and `confirmationResponse()` handle NCHL's confirm-payment callback; `webSocketRequest()` builds the STOMP request for live status.",
      ],
    },
  },
};

export default snippets;

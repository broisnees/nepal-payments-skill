# GetPay (NCHL card gateway for Nepali banks)

GetPay is the card checkout NCHL hosts for banks: Visa and Mastercard (UnionPay announced), domestic and international cards, with 3-D Secure (CyberSource underneath). NMB Bank (Dec 2025) and Global IME Bank (May 2025) launched their gateways on it, and NCHL reports 14 banks on its hosted gateway. It's the card route for merchants whose bank doesn't offer CyberSource Secure Acceptance directly.

Official docs: https://getpay.global/web-integration/ and https://getpay.global/web-checkout-integration-test/ (operator GetPay; React/Next, Flutter and WooCommerce pages on the same site). The docs cover the browser side well and the server side thinly, so the server details below come from the docs plus three independent integrations (`neputertech/getpay-gateway`, a production Laravel shop, a Laravel booking API) and live probes of both hosts in 2026-11.
Adapters: `scripts/ts/src/getpay.ts`, plus the matching file in each port (`getpay.py`, `GetPay.java`, `GetPay.kt`, `src/GetPay/`, `getpay.go`).

## Contents
1. Environments and credentials
2. Flow: four pages
3. SDK options
4. Return token and oprSecret
5. Status APIs
6. Security: what the status API does not check
7. Gotchas

## 1. Environments and credentials

| | UAT | Live |
|---|---|---|
| Base URL | `https://uat-bank-getpay.nchl.com.np/ecom-web-checkout/v1/secure-merchant/transactions` | `https://ecom-getpay.nchl.com.np/ecom-web-checkout/v1/secure-merchant/transactions` |
| Bundle (SDK) | `https://minio-getpay.nchl.com.np/getpay-cdn/webcheckout/v5/bundle.js` | from your bank |

The bank provides: **papInfo** (base64 of `{"institutionId","mid","tid"}`), **oprKey** (operator-hosted key), **insKey** (blank for operator-hosted), the bundle URL and the base URL. The bank also registers your website domain with NCHL. CyberSource's card form refuses non-whitelisted origins (a `401` from `testflex.cybersource.com`), so `localhost` doesn't work.

Env vars: `GETPAY_ENV`, `GETPAY_PAP_INFO`, `GETPAY_OPR_KEY`, `GETPAY_INS_KEY`, `GETPAY_WEBSITE_DOMAIN`, `GETPAY_BUSINESS_NAME`, `GETPAY_IMAGE_URL`, `GETPAY_CURRENCY` (NPR), `GETPAY_BUNDLE_URL`, `GETPAY_BASE_URL`.

## 2. Flow: four pages

GetPay is a browser SDK, not a redirect or a form. The docs require four separate pages:

1. **Checkout page:** load the bundle, then `new GetPay(options).initialize()`. Its `onSuccess` (validation passed) navigates to page 2.
2. **Payment page:** `<div id="checkout"></div>` plus the bundle. GetPay renders the card form and runs 3-D Secure.
3. **Fail page** and 4. **Success page:** GetPay redirects here with a `token`. Both must break out of GetPay's iframe (`if (window.top !== window.self) window.top.location = window.self.location.href`). For cards without 3-D Secure, the token arrives in the **URL hash**, which never reaches the server.

`initiate()` returns `{ kind: "sdk", scriptUrl, options }`. The adapters render all four pages: `checkoutPage(result, paymentPageUrl)`, `paymentPage()`, and `returnPage(verifyUrl)` for both 3 and 4. `returnPage` breaks out of the iframe, reads the token from the query or the hash, and forwards it to your server as `?token=`. Point both `returnUrl` and `failureUrl` at a route serving `returnPage`, and verify on the route it forwards to. `scripts/ts/examples/server.ts` wires it up.

## 3. SDK options

| Option | Notes |
|---|---|
| `papInfo`, `oprKey`, `insKey` | from the bank; `insKey` is `""` when operator-hosted |
| `clientRequestId` | your attempt id. Send a value or omit it, never `""`. The adapters always send `orderId`. |
| `price` | **a number in rupees** (`1200.5`), not a string, not paisa |
| `currency` | `"NPR"` (USD works on accounts the bank enables for it) |
| `websiteDomain` | your origin; must match the callback URLs' host (the adapters check this: `invalid_callback_url`) |
| `businessName`, `imageUrl` | shown on the checkout page |
| `callbackUrl.successUrl`, `callbackUrl.failUrl` | pages 4 and 3 |
| `baseUrl` | the environment's base URL (above) |
| `userInfo`, `prefill`, `disableFields`, `allowBillingAddressFields`, `themeColor`, `orderInformationUI` | optional UI; `orderInformationUI` is inline HTML (the adapters escape your description) |
| `onSuccess`, `onError` | functions, so `checkoutPage` adds them in the browser |

`oprKey` and `papInfo` reach the browser by GetPay's design. Neither is a secret.

## 4. Return token and oprSecret

```
token     = base64( JSON {"id": "<GetPay transaction id>", "oprSecret": "<...>"} )
oprSecret = base64( SHA-256( oprKey + id ) )        # raw digest, then base64
```
Two independent integrations compute `oprSecret` this way, and NCHL's docs describe it as "a hash of the oprKey and transaction ID". One integration decodes the token as `id:oprSecret` text instead of JSON, so the adapters accept both. A mismatch throws `bad_signature`.

Test vector: `oprKey = "4fa4c6b9-3f91-43e5-9b4f-319f68187ba5"`, `id = "0cc5b1a39f3c4cad864bc1c6a524534f"` →
`oprSecret = FsNmsEdMIM6tH60Wmq7oxfd0kjoK2pxloT35YvHwjOM=` (`printf '%s%s' "$OPR_KEY" "$ID" | openssl dgst -sha256 -binary | base64`)

## 5. Status APIs

No auth headers. JSON body, HTTP 200 with `status: 0` on success, HTTP 400 with `status: -1` on failure.

```http
POST {base}/merchant-status
{"id":"0cc5b1a39f3c4cad864bc1c6a524534f","papInfo":"<papInfo>"}
→ {"status":0,"message":"SUCCESS","data":{"status":"SUCCESS","amount":1200.0,"currency":"NPR",
   "stan":"379832","crrn":"624503379832","clientId":"<your clientRequestId>","remarks":"Success"}}
→ 400 {"status":-1,"message":"Failed to fetch merchant information: Transaction not found for ID: ..."}

POST {base}/transaction-statement
{"transactionId":"..."}  or  {"clientRequestId":"..."}
→ {"status":0,"message":"SUCCESS","data":{"transactionId","clientRequestId","payer","payerEmail",
   "saleTransactionAmount":1200.0,"currency","transactionDatetimeNpt","paymentScheme":"MASTERCARD",
   "txnType":"SALE","maskedCustomerPan":"511111XXXXXX1118","stan","crrn","status":"SUCCESS","remarks"}}
```

| `data.status` | Normalized |
|---|---|
| `SUCCESS`, `APPROVED` | `paid` (with a valid token and matching `clientId`) |
| `FAILED`, `FAILURE`, `DECLINED` | `failed` |
| `PENDING` | `pending` |
| `CANCELLED` | `canceled` |
| `status: -1` "not found" | `not_found` |

`amount` is rupees. `crrn` is the card network reference, so store it with `transactionId` for disputes.

## 6. Security: what the status API does not check

On UAT, `merchant-status` returned a transaction to a request carrying a made-up `papInfo` for another institution. It answers for any transaction id, whoever asks. So the adapters only report `paid` when all three hold:
1. the token's `oprSecret` equals `base64(SHA-256(oprKey + id))` for **your** `oprKey`
2. `data.clientId` equals **your** `orderId`
3. the amount matches what you stored (`decideTransition` checks it)

`verify()` without a token (reconciliation) falls back to `transaction-statement` by `clientRequestId`. Another GetPay merchant could create a transaction with the same `clientRequestId`, so that lookup can't prove the payment is yours. A `SUCCESS` there comes back as `unknown` (alert, check the bank portal), never `paid`. `FAILED` and not-found map normally.

## 7. Gotchas

- **Use four separate pages.** The docs warn that combining them causes caching problems.
- The token can sit in the `#hash` (cards without 3-D Secure). Only a browser page can read it, so `returnPage` forwards it.
- `price` is a number in rupees. A string or paisa breaks the checkout.
- `clientRequestId` must be present or absent, never empty. Keep it ≤ 50 chars `[A-Za-z0-9-]` (`newOrderId()` fits).
- Your domain must be registered with NCHL through the bank, or the card iframe answers `401`.
- No refund API is published. Refunds go through the bank's portal.

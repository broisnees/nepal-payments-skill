# CyberSource (card payments via Nepali banks)

Sources: developer.cybersource.com (Secure Acceptance guide, REST getting-started, Unified Checkout guide, 2026 release notes), KB KA-11531, official SDK sources and samples. Verified 2026-11.
Adapters: `scripts/ts/src/cybersource.ts`, plus the matching file in each port (`cybersource.py`, `CyberSource.java`, `CyberSource.kt`, `src/CyberSource/`, `cybersource.go`) (Secure Acceptance).

## Contents
1. Which integration (read first)
2. Secure Acceptance Hosted Checkout
3. Response verification + Merchant POST URL
4. Reason codes
5. REST API + Unified Checkout (new builds)
6. Test cards
7. Gotchas

## 1. Which integration (read first)

- **Secure Acceptance (SA)** is what Nepali banks have historically issued (NIC Asia confirmed: profile ID + access key + secret key, NPR with optional USD). CyberSource is **sunsetting SA**: the migration target was **2026-09-30** and *"Secure Acceptance will no longer be supported or maintained after its applicable end-of-life date"*. Dates are communicated per merchant. It still works today. Use the adapter if your bank gave you SA credentials, and plan a migration.
- **New builds**: ask your bank for **Unified Checkout + REST** credentials and use the official `cybersource-rest-client` SDK with **JWT** auth (§5). REST **HTTP Signature** auth must move to JWT by **March 2027**.
- **Card acceptance without a direct CyberSource contract**: NPS (`nps.md`) routes to bank card checkouts (e.g. HBL Card Checkout).
- Other banks (Nabil, Global IME, Himalayan, SCB Nepal) may use different processors. HBL uses 2C2P PACO (`others.md`). Confirm with your bank which product you're getting.

## 2. Secure Acceptance Hosted Checkout

| Purpose | Test | Production |
|---|---|---|
| Hosted pay page | `https://testsecureacceptance.cybersource.com/pay` | `https://secureacceptance.cybersource.com/pay` |
| Token create/update | `…/token/create`, `…/token/update` | same paths |
| Iframe | `…/embedded/pay` | same |
| Silent Order POST | `…/silent/pay` | same |
| Business Center | https://businesscentertest.cybersource.com | https://businesscenter.cybersource.com |

**Credentials**: Business Center → Payment Configuration → Secure Acceptance Settings → profile → Security → Create Key (signature v1, **HMAC-SHA256**) → `access_key` (32 chars) + `secret_key`. `profile_id` is on the profile. Keys **expire after 2 years**; copy them immediately (the panel closes after 30 s). Test and live keys differ.

Env vars: `CYBERSOURCE_ENV`, `CYBERSOURCE_PROFILE_ID`, `CYBERSOURCE_ACCESS_KEY`, `CYBERSOURCE_SECRET_KEY`, `CYBERSOURCE_CURRENCY` (default `NPR`).

**Request** (browser auto-POSTs a form to `/pay`). Required signed fields: `access_key, profile_id, transaction_uuid, signed_field_names, unsigned_field_names, signed_date_time, locale, transaction_type, reference_number, amount, currency`.

| Field | Rule |
|---|---|
| `transaction_type` | `sale` (auth + capture, typical) or `authorization` (capture later); `…,create_payment_token` variants for tokenization |
| `transaction_uuid` | unique per attempt, ≤ 50. Reuse within 15 min → reason 104 |
| `reference_number` | your order/attempt id, ≤ 50 |
| `amount` | `"1500.00"` |
| `currency` | `NPR` (enable per card type in the profile; availability depends on the acquirer) |
| `signed_date_time` | UTC `yyyy-MM-dd'T'HH:mm:ss'Z'`; server clock must be NTP-synced |
| `locale` | `en-us` |
| `bill_to_forename, bill_to_surname, bill_to_email, bill_to_address_line1, bill_to_address_city, bill_to_address_country` | required for sale/auth; country `NP`; state + postal code only for US/CA |
| `override_custom_receipt_page` / `override_custom_cancel_page` | optional per-request URLs (HTTPS, must be signed) |
| `merchant_defined_data1..100` | optional; no PII |

**Signature**: `base64(HMAC-SHA256(secret_key as raw UTF-8 bytes, "name=value,name=value,…"))` in `signed_field_names` order. `signed_field_names` lists itself and `unsigned_field_names` (sent empty). Don't URL-encode values before signing.

Worked vector (secret `test_secret_key_do_not_use`):
```
access_key=a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6,profile_id=PROFILE-0001,transaction_uuid=7f9c2b1e-5d1a-4c3b-9e8f-1a2b3c4d5e6f,signed_field_names=access_key,profile_id,transaction_uuid,signed_field_names,unsigned_field_names,signed_date_time,locale,transaction_type,reference_number,amount,currency,unsigned_field_names=,signed_date_time=2026-11-04T10:15:30Z,locale=en-us,transaction_type=sale,reference_number=ORDER-1001,amount=1500.00,currency=NPR
→ QRwjaW8ysHR/UGyQ0LqSIHiGTvnNebKSwwsFRmn4Weg=
```
```php
base64_encode(hash_hmac('sha256', $dataToSign, $secretKey, true));   // official PHP sample
```

## 3. Response verification + Merchant POST URL

SA POSTs the result (form-encoded) to the **customer receipt page** (through the browser) and to the **Merchant POST URL** (server-to-server; set under Profile → Notifications, HTTPS/TLS 1.2+). Configure both. The Merchant POST URL doesn't depend on the customer's browser, so it's your most reliable signal.

Verification (`adapter.verify({ orderId, amountPaisa, callback: postBody })`):
1. Recompute the signature from the **response's** `signed_field_names` with the same secret and compare in constant time. Mismatch → *"treat the POST as malicious and disregard it"*.
2. Use **only** fields listed in `signed_field_names` (the adapter drops the rest).
3. Check `req_reference_number` = your attempt id and `req_currency`, then compare `auth_amount` (or `req_amount`) with the stored amount.
4. Map `decision`: `ACCEPT` → `paid` (for `sale`; `authorization` → `pending` until captured), `REVIEW` → `pending` (manual review in Business Center), `DECLINE`/`ERROR` → `failed` (reasons 150–152 → `unknown`: system error, check before retrying), `CANCEL` → `canceled`.

Key response fields: `decision, reason_code, message, transaction_id (≤26), auth_code, auth_amount, auth_time, req_* (echo), invalid_fields, required_fields, payment_token, request_token, payer_authentication_*, signed_field_names, signed_date_time, signature`.

- The receipt route receives a cross-site POST: **exempt it from CSRF middleware**, but always verify the signature.
- Reply to the Merchant POST within 10 s (delays slow future notifications) and make it idempotent (the conditional update in `architecture.md` §4).
- SA has no simple status API. For reconciliation of attempts with no POST, use REST Transaction Search via the SDK (§5) or the Business Center.

## 4. Reason codes

| Code | Meaning |
|---|---|
| 100 | Success |
| 110 | Partial approval (`auth_amount` < requested; the amount guard catches it) |
| 101 / 102 | Missing / invalid fields (`required_fields` / `invalid_fields`) |
| 104 | Duplicate `transaction_uuid` within 15 min |
| 150 / 151 / 152 | System failure / timeouts: check status before retrying |
| 200 / 230 | Approved but failed AVS / CVN (REVIEW) |
| 202 / 203 / 204 / 205 | Expired card / general decline / insufficient funds / lost-stolen |
| 207 / 208 / 210 / 211 | Issuer unavailable / card not allowed for CNP / limit reached / invalid CVN |
| 231 / 232 / 233 / 236 / 240 | Invalid account / card type not accepted / processor decline / processor failure / card type mismatch |
| 475 / 476 / 478 | 3DS needed / 3DS failed / SCA required |
| 481 / 520 | Profile risk settings / Decision Manager |

3DS (Visa Secure, Mastercard Identity Check, UnionPay 2.0, etc.) must be enabled on the merchant ID by Customer Support, then ticked per card type in the profile. SA rejects cards without CVN or expiry, which affects some older UnionPay cards.

## 5. REST API + Unified Checkout (new builds)

Hosts: test `https://apitest.cybersource.com`, live `https://api.cybersource.com`.
- Pay `POST /pts/v2/payments` (`processingInformation.capture: true` = sale) → 201 with `id`, `status` (`AUTHORIZED`, `PARTIAL_AUTHORIZED`, `AUTHORIZED_PENDING_REVIEW`, `PENDING_AUTHENTICATION`, `DECLINED`, `INVALID_REQUEST`…)
- Capture `POST /pts/v2/payments/{id}/captures`, refund `POST /pts/v2/payments/{id}/refunds`, details `GET /tss/v2/transactions/{id}`

**Use the official SDK for REST auth** rather than hand-rolling it: JWT claims carry an MLE requirement from March 2027, and the docs and SDK disagree on a claim name.

| Lang | Install | Latest (2026-11) |
|---|---|---|
| Node | `npm i cybersource-rest-client` | 0.0.84 |
| Python | `pip install cybersource-rest-client-python` | 0.0.80 |
| PHP | `composer require cybersource/rest-client-php` | 0.0.77 |
| Java | `com.cybersource:cybersource-rest-client-java` | 0.0.95 |
| .NET | `CyberSource.Rest.Client` | 1.0.3 |
| Ruby | `cybersource_rest_client` | 0.0.88 |

```js
// Node: JWT with shared secret (same key id + secret as HTTP Signature)
const cybersource = require("cybersource-rest-client");
const config = {
  authenticationType: "jwt",
  jwtKeyType: "SHARED_SECRET",
  runEnvironment: process.env.CYBERSOURCE_ENV === "production" ? "api.cybersource.com" : "apitest.cybersource.com",
  merchantID: process.env.CYBERSOURCE_MERCHANT_ID,
  merchantKeyId: process.env.CYBERSOURCE_KEY_ID,
  merchantsecretKey: process.env.CYBERSOURCE_SHARED_SECRET,
};
const client = new cybersource.ApiClient();
const tss = new cybersource.TransactionDetailsApi(config, client);
tss.getTransaction(transactionId, (err, data) => { /* data.applicationInformation.status ... */ });
```

**Unified Checkout** (recommended SA replacement; hosted card and wallet UI, PCI SAQ A):
1. Server: `POST /uc/v1/sessions` with `targetOrigins: ["https://shop.example"]`, `country`, `locale`, `data.orderInformation.amountDetails { totalAmount, currency }` → capture-context JWT.
2. Client: load the script from the JWT's `clientLibrary` + `clientLibraryIntegrity` (never hard-code them; they change), then:
   ```js
   const client = await VAS.UnifiedCheckout(sessionJwt);
   const checkout = await client.createCheckout();
   const result = await checkout.mount("#payment-buttons"); // payment-result JWT (autoProcessing) or transient token
   ```
3. Server: with a transient token, `POST /pts/v2/payments` with `tokenInformation.transientTokenJwt`. Confirm with `GET /tss/v2/transactions/{id}` before fulfilling. Webhooks are JSON.
4. Mobile: KA-11531 says UC works in a **WebView**. Flex mobile SDKs (`flex-api-ios-sdk`, `com.cybersource:flex-api-android-client`) are stale (2022). Create capture contexts on your server only.

HTTP Signature (deprecated; supported until March 2027), for reference: headers `host, date (RFC1123), request-target, digest ("SHA-256=" + base64(sha256(body))), v-c-merchant-id`, signing string lines `name: value` joined by `\n`, signature `base64(HMAC-SHA256(base64-DECODED secret, string))`, header `signature: keyid="…", algorithm="HmacSHA256", headers="host date request-target digest v-c-merchant-id", signature="…"`.

## 6. Test cards (test environment; any future expiry and name)

| Card | Number |
|---|---|
| Visa | `4111111111111111` |
| Mastercard | `5555555555554444`, `2222420000001113` |
| Amex | `378282246310005` |
| JCB | `3566111111111113` |
| 3DS 2.x Visa frictionless success / challenge success | `4000000000002701` / `4000000000002503` |
| 3DS 2.x Mastercard challenge success | `5200000000002151` |

## 7. Gotchas

- **SA secret = raw string bytes; REST secret = base64-decoded.** Mixing them gives signature errors.
- **Sign on the server.** The form page must contain only the signed values, never the secret.
- **`signed_date_time` must be UTC with `Z`.** Clock drift → rejection.
- **Fresh `transaction_uuid` per attempt** (reason 104).
- **REST digest must hash the exact bytes sent.** Don't re-serialize JSON after hashing.
- **Partial approvals (110)**: compare `auth_amount` with your amount; don't fulfil short payments.

Banks that run their card gateway on NCHL instead (NMB, Global IME and others) use GetPay: see `getpay.md`.

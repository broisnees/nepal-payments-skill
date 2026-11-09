# Hamro Pay Checkout

Hamro Patro's wallet (NRB-licensed PSP "Lenden Sewa", wallet name Hamro Pay). Redirect checkout like eSewa: create a session server-side, POST a signed form to the gateway, the payer approves in Hamro Pay, then confirm with a status call. Hamro Pay accepts **Rs 10 to Rs 50,000** per transaction, and only from KYC-verified users.

Official docs: https://hamropay.com.np/checkout/developer/reference/ (API), https://hamropay.com.np/checkout/developer/quickstart (UAT setup), and the official Node sample at https://github.com/hamropatro/sample-store. Checked 2026-11 against all three plus live host probes.
Adapters: `scripts/ts/src/hamropay.ts`, plus the matching file in each port (`hamropay.py`, `HamroPay.java`, `HamroPay.kt`, `src/HamroPay/`, `hamropay.go`).

## Contents
1. Environments and credentials
2. Signatures
3. Create Session
4. Gateway form
5. Redirects and Get Transaction
6. Webhook
7. Codes
8. Gotchas

## 1. Environments and credentials

| | UAT | Live |
|---|---|---|
| API (`API_BASE_URL`) | `https://uat-payclient.hamropatro.com` | `https://payclient.hamropatro.com` |
| Gateway form (`GATEWAY_URL/api/checkout`) | `https://uat-checkout-pay.hamropatro.com/api/checkout` | issued by Hamro Pay at go-live |
| Merchant portal | https://pay-sandbox.hamropatro.com (signup OTP `000000`) | issued at go-live |

The live API host answers `401 {"code":16,"message":"Unauthorized Request"}` without credentials, the same as UAT. The live gateway host isn't published (`checkout-pay.hamropatro.com` doesn't resolve), so the adapters require `gatewayUrl` in production.

Credentials (UAT portal → Client Credentials): `merchantId`, `Client-Id`, `Client-API-Key`, client secret. Saving a webhook URL (Configuration → Webhook) shows a separate **webhook signing secret**.
UAT payer: Hamro Pay number `9841414141`, T-PIN `0000`.

Env vars: `HAMROPAY_ENV`, `HAMROPAY_MERCHANT_ID`, `HAMROPAY_CLIENT_ID`, `HAMROPAY_CLIENT_API_KEY`, `HAMROPAY_CLIENT_SECRET`, `HAMROPAY_WEBHOOK_SECRET`, `HAMROPAY_API_BASE_URL`, `HAMROPAY_GATEWAY_URL` (required for live).

## 2. Signatures

Every API call carries three headers: `Client-Id`, `Client-API-Key` and `Signature`.

```
Signature = base64( HMAC-SHA512( key = clientSecret, message = values joined by "," ) )
```

| Use | Values, in order | Key |
|---|---|---|
| Create Session (header) | `merchantTxnId,transactionAmount,merchantId,clientId,clientApiKey` | client secret |
| Gateway form `token` | `merchantId,merchantTxnId,sessionId,transactionAmount,clientId,clientApiKey` | client secret |
| Get Transaction (header) | `merchantTxnId,merchantId,clientId,clientApiKey` | client secret |
| Webhook (incoming header) | `merchantTxnId,merchantId,status,amount` | webhook secret |

Test vector (`clientSecret = "abcdefg"`):
```
message   = "T1,1000,M,C,K"
signature = 7MhTBtP9MzyiNUg7P/ljNqxHxrUPQSAHhNpAD9bPlacsF2lMj8GAka1pVKD7MSMnNdBLqCwz9SoY4l+2RHdpxA==
# printf 'T1,1000,M,C,K' | openssl dgst -sha512 -hmac abcdefg -binary | openssl base64 -A
```
The join has no escaping, so a comma inside a value lets two different tuples share a signature. The adapters refuse signed values that contain commas.

## 3. Create Session

```http
POST {API}/v1/checkout/sessionId
Client-Id, Client-API-Key, Signature, Content-Type: application/json, Connection: close

{"merchantTxnId":"P1KX3M9Q2ZAB7C4D8E","merchantId":"PN_...","transactionAmount":"8992",
 "successRedirectionUrl":"https://shop.example/payments/hamropay/return",
 "failedRedirectionUrl":"https://shop.example/payments/hamropay/return",
 "productList":[{"name":"T-shirt","description":"T-shirt","price":89.92,"quantity":1}],
 "metadata":{"orderId":"..."}}
→ 200 {"sessionId":"ca8f7b70-b9c9-11ee-8611-0a73743c8233","merchantId":"PN_..."}
```

- `merchantTxnId` ≤ 25 chars, unique per attempt (`newOrderId()` fits).
- `transactionAmount` is **paisa**, sent as the same string you signed. `productList[].price` is **rupees** and only for display.
- Optional: `phone_number` (the payer's Hamro Pay number, to prefill), `metadata` (echoed in the webhook), `clientCommissionConfig` (`commissionMerchantId` plus either `commissionAmount` or `commissionPercentage`) for marketplace splits.
- The session lives about **10 minutes**. A timeout here may still have created a session, so retry with a new `merchantTxnId`, never the same one.

`initiate()` stores `sessionId` as `providerRef`.

## 4. Gateway form

The browser POSTs `application/x-www-form-urlencoded` to `{GATEWAY_URL}/api/checkout` with `merchant_id`, `session_id`, `token`, `merchant_transaction_id`, `remarks` (≤ 250), and optionally `phone_number`. Build the token on the server: the Create Session response has no token, and building it needs the client secret. `initiate()` returns this as a `kind: "form"` result, so `renderAutoSubmitForm` works unchanged.

## 5. Redirects and Get Transaction

Hamro Pay sends the payer to `successRedirectionUrl?MerchantTxnId=<id>` or `failedRedirectionUrl?MerchantTxnId=<id>`. The redirect only says which attempt to load. Confirm it:

```http
POST {API}/v1/checkout/transaction        (signed headers)
{"merchantId":"PN_...","merchantTxnId":"P1KX3M9Q2ZAB7C4D8E"}
→ {"merchantTransactionId":"P1...","trackingId":"","status":"COMPLETED","amount":89.92,"remarks":"","message":"..."}
```

| `status` | Normalized |
|---|---|
| `COMPLETED` | `paid` (amount in **rupees**, converted to paisa) |
| `PENDING`, `PROCESSING` | `pending` |
| `FAILED` | `failed` |
| `NOT_INITIATED` ("TRANSACTION NOT INITIATED YET") | `not_found` |
| anything else | `unknown` |

The reference names the echo `merchantTransactionId`, but the live API answers `merchantTxnId` (found by Hamro Pay's own sample). The adapters accept either and throw `id_mismatch` when it names a different attempt. `amount` is `0` until the payment finishes, so it only counts on `COMPLETED`.

## 6. Webhook

Configure the URL in the merchant portal. Hamro Pay POSTs JSON with a `Signature` header:
```json
{"merchantTxnId":"P1...","merchantId":"PN_...","amount":89.92,"status":"COMPLETED","metadata":{"orderId":"..."}}
```
Signature string: `merchantTxnId,merchantId,status,amount`, keyed with the **webhook secret** (not the client secret). Hamro Pay signs its own rendering of the double, which can be `1200`, `1200.0` or `1200.00`. `verifyWebhook(body, signatureHeader)` tries each rendering of the parsed number, never the raw bytes, so a body with a duplicate `amount` key can't authenticate one value and settle on another. Treat the webhook as a trigger: call `verify()` before fulfilling.

## 7. Codes

Errors come back as gRPC-style `{"code": n, "message": "...", "details": []}`: `0` OK, `1` CANCELED, `2` UNKNOWN, `3` INVALID_ARGUMENT, `4` TIME_OUT, `5` NOT_FOUND / SUSPENDED, `6` ALREADY_EXISTS (reused `merchantTxnId`), `7` PERMISSION_DENIED, `8` LIMIT_EXCEEDED, `9` FAILED_PRECONDITION, `10` ABORTED, `11` OUT_OF_RANGE (amount outside Rs 10 to 50,000), `12` UNIMPLEMENTED, `13` INTERNAL, `14` UNAVAILABLE, `15` DATA_LOSS, `16` UNAUTHENTICATED. The adapters throw `PaymentError` with code `unauthorized` for 16 and `code_<n>` for the rest.

## 8. Gotchas

- **Send `Connection: close`.** The API drops each TCP connection without marking it closed. Hamro Pay's sample measured keep-alive failing on every second request in UAT. The adapters set the header. Go sets `req.Close`. The JDK client (Java, Kotlin) refuses a `Connection` header unless the JVM runs with `-Djdk.httpclient.allowRestrictedHeaders=connection`, so without that flag their default transport sends a `Connection: close` request on a one-shot client whose socket never joins the keep-alive pool.
- **Error responses arrive truncated.** The API is a gRPC gateway behind Envoy: on errors it announces HTTP trailers, then aborts the stream before the final chunk (curl exit 18 over HTTP/1.1, a stream reset over HTTP/2). The JSON body is complete by then. Node `fetch` tolerates it. The other ports' transports keep bytes that arrived before the read failed and accept them only when they parse as complete JSON, so a 401 still surfaces as `unauthorized` rather than `network_error`.
- Amount units flip by direction: paisa out (Create Session), rupees back (Get Transaction, webhook, `productList.price`).
- Sign exactly what you send. Send `transactionAmount` as a string so the signed text and the JSON can't disagree.
- Rs 10 minimum and Rs 50,000 maximum are enforced before any call (`invalid_amount`).
- Payers need a KYC-verified Hamro Pay account.

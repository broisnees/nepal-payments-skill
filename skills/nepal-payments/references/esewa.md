# eSewa (ePay v2 + Intent)

Official docs: https://developer.esewa.com.np · Verified 2026-11 against the docs' raw pages, the official WordPress plugin, and live sandbox calls.
Adapters: `scripts/ts/src/esewa.ts`, `scripts/python/nepal_payments/esewa.py`.

## Contents
1. Which flow
2. Environments and credentials
3. ePay v2 (web / WebView)
4. Signature + test vectors
5. Status check API
6. Intent payment (mobile app-to-app)
7. Deprecated: v1 API and legacy mobile SDKs
8. Gotchas

## 1. Which flow

| Need | Use |
|---|---|
| Website, or mobile via WebView | **ePay v2**: signed form POST, then redirect back, then status API |
| Native mobile app with app-to-app switching to the eSewa app | **Intent**: the server books, the app opens the deeplink, then callback and status API. eSewa marks this "Recommended" and has deprecated its Android/iOS/Flutter SDKs in its favour. |

## 2. Environments and credentials

| | Sandbox | Production |
|---|---|---|
| ePay form (POST, form-urlencoded) | `https://rc-epay.esewa.com.np/api/epay/main/v2/form` | `https://epay.esewa.com.np/api/epay/main/v2/form` |
| ePay status (GET) | `https://rc.esewa.com.np/api/epay/transaction/status/` | `https://esewa.com.np/api/epay/transaction/status/` (current docs; `https://epay.esewa.com.np/api/epay/transaction/status/` also answers) |
| Intent book / status / cancel (POST JSON) | `https://rc-checkout.esewa.com.np/api/client/intent/payment/{book,status,cancel}` | Issued by eSewa at go-live (set `intent.baseUrl`) |
| Merchant portal | | https://merchant.esewa.com.np |

`uat.esewa.com.np`, used in most tutorials, **no longer resolves**. Use `rc.esewa.com.np` / `rc-epay.esewa.com.np`.

| Credential | Sandbox value |
|---|---|
| ePay `product_code` | `EPAYTEST` |
| ePay secret key | `8gBm/:&EnhH.1/q` |
| Intent `product_code` | `INTENT` |
| Intent access key | `LB0REg8HUSw3MTYrI1s6JTE8Kyc6JyAqJiA3MQ==` (use as a **raw string**; base64-decoding it gives `IP-400 Invalid Signature`) |
| Test eSewa IDs | `9806800001` … `9806800005` (the docs also list `9711111111/2/3`) |
| Password / MPIN / OTP token | `Nepal@123` / `1122` (app only) / `123456` |

Production: the merchant gets their own product code and secret key (ePay) and an access key (Intent) from eSewa after onboarding. Env vars: `ESEWA_ENV`, `ESEWA_PRODUCT_CODE`, `ESEWA_SECRET_KEY`, and optionally `ESEWA_INTENT_PRODUCT_CODE`, `ESEWA_INTENT_ACCESS_KEY`, `ESEWA_INTENT_BASE_URL`.

The sandbox login page has a reCAPTCHA, so end-to-end payment tests are manual. The form POST and the status API can be tested automatically.

## 3. ePay v2

### Flow
1. Server builds and signs the fields, then the browser **auto-submits** them as `application/x-www-form-urlencoded` POST to the form URL. A JSON body returns HTTP 409. eSewa responds `302 → /epay?bookingId=…`.
2. Payer logs in (ID + password + OTP) and confirms.
3. **Success** → `GET success_url?data=<base64 JSON>`. **Failure / cancel** → `failure_url` (its params are undocumented, so put your attempt id in the URL **path**: `/payments/esewa/return/<orderId>`).
4. Server decodes `data`, verifies its signature, checks `transaction_uuid` + `product_code`, then calls the **status API** (authoritative).

### Request fields (all required; send `0` for unused charges)

With the adapters, pass `amountPaisa` = the **total** you charge (store that number; verify with it). Optional `taxPaisa` / `serviceChargePaisa` / `deliveryChargePaisa` are a breakdown *included* in the total; the adapter derives eSewa's `amount` = total − breakdown.

| Field | Notes |
|---|---|
| `amount` | Rupees, e.g. `100` or `100.50`. |
| `tax_amount` | `0` if none. Omitting it → `ES200 "tax_amount field is required."` |
| `product_service_charge` | `0` if none. |
| `product_delivery_charge` | `0` if none. |
| `total_amount` | Must equal amount + tax + service + delivery, else `ES704 Invalid total transaction amount.` |
| `transaction_uuid` | Unique per request; letters, digits and `-` only. Reuse → `Duplicate transaction UUID.` |
| `product_code` | `EPAYTEST` in sandbox. |
| `success_url`, `failure_url` | Your server routes. No query string (eSewa appends `?data=`). |
| `signed_field_names` | `total_amount,transaction_uuid,product_code` |
| `signature` | See §4. |

### Success payload (`data` decoded)
```json
{"transaction_code":"0LD5CEH","status":"COMPLETE","total_amount":"1,000.0","transaction_uuid":"240613-134231",
 "product_code":"NP-ES-ABHISHEK-EPAY",
 "signed_field_names":"transaction_code,status,total_amount,transaction_uuid,product_code,signed_field_names",
 "signature":"Mpwy0TFlHqpJjFUDGic+22mdoenITT+Ccz1LC61qMAc="}
```
`total_amount` may come back with a thousands separator. Sources disagree on whether the comma is part of the signed string, so the adapters try both. The status API is the final word either way.

## 4. Signature + test vectors

`signature = base64( HMAC-SHA256( key = secret (UTF-8), message = "f1=v1,f2=v2,..." ) )`, with fields in `signed_field_names` order, no spaces, and standard base64 (not hex).

**The example signatures in eSewa's docs are wrong** (they don't reproduce with the documented key). Test against these instead (checked with Python, OpenSSL and the live sandbox):

| Key | Message | Signature |
|---|---|---|
| `8gBm/:&EnhH.1/q` | `total_amount=100,transaction_uuid=11-201-13,product_code=EPAYTEST` | `5DZywcrTKD0gia/rsSMcrRHmJl+4Tbol6S+lWgdJ94E=` |
| `8gBm/:&EnhH.1/q` | `total_amount=110,transaction_uuid=ab14a8f2b02c3,product_code=EPAYTEST` | `0Gh9pc1fiZDZH7OKOBdn42QMx8drH7tOeMPdRQhI83g=` |
| `LB0REg8HUSw3MTYrI1s6JTE8Kyc6JyAqJiA3MQ==` | `product_code=INTENT,amount=100,transaction_uuid=txn-20251220-001` | `oVRo2ZkjNpbt5vKs7RSNx1OCcewDaVssoguWsG31HMA=` |

Shell check: `printf '%s' 'total_amount=100,transaction_uuid=11-201-13,product_code=EPAYTEST' | openssl dgst -sha256 -hmac '8gBm/:&EnhH.1/q' -binary | base64`

The signature covers the **exact posted string**: posting `110.0` while signing `110` → `ES104 Invalid payload signature.` Format the amount once and reuse the string.

**Response signature:** rebuild the message from the decoded `data` using *its own* `signed_field_names` (which includes `signed_field_names=transaction_code,status,...` itself) and compare in constant time.

Other languages (same message, same key):
```php
base64_encode(hash_hmac('sha256', $message, $secret, true));
```
```python
base64.b64encode(hmac.new(secret.encode(), message.encode(), hashlib.sha256).digest()).decode()
```
```go
m := hmac.New(sha256.New, []byte(secret)); m.Write([]byte(message)); base64.StdEncoding.EncodeToString(m.Sum(nil))
```
```java
Mac mac = Mac.getInstance("HmacSHA256"); mac.init(new SecretKeySpec(secret.getBytes(UTF_8), "HmacSHA256"));
Base64.getEncoder().encodeToString(mac.doFinal(message.getBytes(UTF_8)));
```
```dart
base64.encode(Hmac(sha256, utf8.encode(secret)).convert(utf8.encode(message)).bytes); // package:crypto
```

## 5. Status check API

`GET {status}?product_code=EPAYTEST&total_amount=100&transaction_uuid=…` →
```json
{"product_code":"EPAYTEST","transaction_uuid":"…","total_amount":100.0,"status":"COMPLETE","ref_id":"0001TS9"}
```

| status | Normalized | Meaning |
|---|---|---|
| `COMPLETE` | `paid` | Paid. |
| `PENDING` | `pending` | Initiated, not completed (`ref_id` null). |
| `AMBIGUOUS` | `pending` | "Payment is at halt state"; keep re-checking. |
| `FULL_REFUND` / `PARTIAL_REFUND` | `refunded` / `partially_refunded` | |
| `NOT_FOUND` | `not_found` | Session expired, never paid, **or wrong `total_amount`**. |
| `CANCELED` | `canceled` | Cancelled or reversed by eSewa. |
| `{"code":0,"error_message":"Service is currently unavailable"}` | throw, retry later | The adapters read `error_message` or `errorMessage` and raise code `esewa_<code>` (`esewa_0` here), or `http_<status>` when the body has no code. |

- A wrong `total_amount` returns `NOT_FOUND` rather than an error, so pass the **total you charged** (amount + tax + charges). This doubles as the amount check. `100` and `100.0` both match.
- No refund API and no webhook in ePay v2. Refunds happen through eSewa and show up as statuses.
- The payment fails if not completed within 15 min of login. eSewa says to call status if you get no response within 5 min. The reconciliation job covers this.

## 6. Intent payment (mobile app-to-app)

1. **Book** (server): `POST {intent}/book`
   ```json
   {"product_code":"INTENT","amount":100,"transaction_uuid":"txn-20251220-001",
    "signed_field_names":"product_code,amount,transaction_uuid","signature":"…",
    "callback_url":"https://api.example.com/payments/esewa/intent-callback",
    "redirect_url":"https://api.example.com/payments/done",
    "properties":{"customer_id":"CUST12345","remarks":"Internet bill payment"}}
   ```
   → `{"code":"IP-201","data":{"booking_id":"VkQ=","deeplink":"https://rc-links.esewa.com.np/pay/VkQ=","correlation_id":"01KDJ…"},"message":"Success"}`. Errors look like `{"code":"IP-400","error_message":"Invalid Signature"}` in the docs; the live sandbox has also sent `{"code":0,"errorMessage":"Service is currently unavailable"}`, so the adapters read both keys. `properties` keys must be snake_case and are shown to the user. Decimal amounts (e.g. `100.5`, signed as `amount=100.5`) were accepted in sandbox.
2. **App** opens `deeplink` (a smart link: it opens the eSewa app if installed, else a web fallback). Persist `booking_id|correlation_id` as the attempt's `provider_ref`.
3. eSewa **POSTs `callback_url`** (JSON: `product_code, amount, reference_code, correlation_id, status, signature, signed_field_names`, signed with the access key) and sends the user to `redirect_url`. Pass the **raw request body** to `intentCallbackValid` (Python `intent_callback_valid`): JSON parsing turns `100.0` into `100`, and I haven't yet captured a real callback to confirm which form eSewa signs. With the raw body the adapters accept either `amount=100.0` (as sent) or `amount=100` (JavaScript `String(v)`); a parsed object can only be checked in the `String(v)` form. The callback is a hint either way: call Intent status before fulfilling.
4. **Status** (server, authoritative): `POST {intent}/status` with `{booking_id, product_code, correlation_id, signed_field_names:"booking_id,product_code,correlation_id", signature}` → `data.status` ∈ `BOOKED` (pending) · `SUCCESS` (paid) · `PENDING` · `FAILED` · `CANCELED` · `REVERTED` (refunded). `data.transaction_id` is **your** uuid (the adapter checks it). `data.reference_code` is eSewa's reference. The response has no amount, because the amount was signed at booking. Live sandbox returns code `IP-200` (docs say `IP-201`) and reports a user-cancelled booking as `FAILED`.
5. **Cancel** an abandoned booking: `POST {intent}/cancel` with `{booking_id, product_code, signed_field_names:"booking_id,product_code", signature}` → `IP-210`. If it was already processed → `IP-410`.

App-side detection (optional, the smart link already falls back):
- Android 11+: `<queries><package android:name="com.f1soft.esewa"/></queries>`
- iOS: `LSApplicationQueriesSchemes` contains `esewa`, then `canOpenURL("esewa://")`. The bundle id is `com.f1soft.fonebank.eSewa`.

Demo apps: https://gitlab.com/esewa-pub/esewa-intent-payment-app

### Flutter (Intent)
```dart
final r = await api.post('/payments', {'orderId': orderId, 'provider': 'esewa', 'flow': 'intent'});
await launchUrl(Uri.parse(r['deeplink']), mode: LaunchMode.externalApplication);
// When the app resumes (WidgetsBindingObserver.didChangeAppLifecycleState == resumed)
// or the redirect_url app link arrives, ask the server:
final status = await confirmPayment(r['attemptId']); // see mobile.md §7
```
React Native: `Linking.openURL(deeplink)`, then on `AppState` → `active`, call your verify endpoint. Native: `Intent(ACTION_VIEW, Uri.parse(deeplink))` / `UIApplication.shared.open(url)`.

## 7. Deprecated: v1 API and legacy mobile SDKs

Migrate any code that has:
- **v1 ePay**: `/epay/main` with `tAmt, amt, txAmt, psc, pdc, scd, pid, su, fu`; success redirect `?oid&amt&refId`; verification `/epay/transrec` returning XML `<response_code>Success</response_code>`; status `api/epay/txn_status/v2`. Production v1 returns "Service unavailable."
- **Legacy SDKs**: Android `eSewaSdk.aar` (`ESewaConfiguration`, `ESewaPayment`, `ESewaPaymentActivity`), iOS `EsewaSDK` xcframework / pod `EsewaSDK` 0.0.3, Flutter `esewa_flutter_sdk` (Drive zip; the pub.dev package of that name is unofficial and discontinued), and verification via `/mobile/transaction?txnRefId=` with `merchantId`/`merchantSecret` headers. The docs now show "migrate to the Intent Payment flow" on these pages.
- Community packages (`esewa_flutter`, `esewa_wallet`, `react-native-esewa`, `rn-esewa`) are unofficial or stale. Prefer Intent or ePay v2 in a WebView.

## 8. Gotchas

- **Sign on the server.** Many tutorials (including ones that compute `createSignature` in a React component) ship the secret key to the browser. Anyone could then sign arbitrary payloads.
- **Format amounts once** (`paisaToRupees`) and reuse the same string in the field and the signature.
- **Don't fulfil from `data` alone.** Verify signature + uuid + product code, then the status API with your stored total.
- **`+` becomes a space** if `data` isn't URL-encoded and your framework decodes the query string. The adapters restore it before base64-decoding.
- **HTML-escaped secrets**: config UIs and templating can turn `&` in `8gBm/:&EnhH.1/q` into `&amp;`. The adapter un-escapes it.
- **No query strings in `success_url`/`failure_url`.** Use path segments for your attempt id.
- **`uat.esewa.com.np` is dead.** Sandbox is `rc.esewa.com.np` (status) and `rc-epay.esewa.com.np` (form).
- **Max 3 `properties[...]`** optional fields on ePay.

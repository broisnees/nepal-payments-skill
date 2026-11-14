# Khalti (KPG-2 / Web Checkout)

Official docs: https://docs.khalti.com/khalti-epayment/ · Verified 2026-11 against the docs, SDK sources and live sandbox calls.
Adapters: `scripts/ts/src/providers/khalti/`, plus the matching code in each port (`nepal_payments/providers/khalti/`, `Khalti.java`, `Khalti.kt`, `src/Khalti/`, `khalti.go`).

## Contents
1. Environments and credentials
2. Flow
3. Initiate
4. Return URL callback
5. Lookup (verification)
6. Refund
7. Errors
8. Mobile SDKs (Android, iOS, Flutter, React Native)
9. Deprecated APIs (don't follow old tutorials)
10. Gotchas

## 1. Environments and credentials

| | Sandbox | Production |
|---|---|---|
| API base | `https://dev.khalti.com/api/v2/` | `https://khalti.com/api/v2/` |
| Initiate | `POST /epayment/initiate/` | same |
| Lookup | `POST /epayment/lookup/` | same |
| Refund | `POST https://dev.khalti.com/api/merchant-transaction/{transaction_id}/refund/` (not under `/v2/`) | `https://khalti.com/api/merchant-transaction/{transaction_id}/refund/` |
| Payment page | `https://test-pay.khalti.com/?pidx=…` | `https://pay.khalti.com/?pidx=…` |
| Merchant dashboard | https://test-admin.khalti.com/#/join/merchant (login OTP `987654`) | https://admin.khalti.com/ |

`a.khalti.com` (used in pre-2025 tutorials) still answers but the docs moved to `dev.khalti.com`. Use `dev.khalti.com`.

- **Server** uses the *live secret key* from the dashboard. Sandbox keys are also labelled "live"; `test_…` keys are from the dead v1 API.
- **Mobile SDKs** use the *live public key* (only for opening checkout; verification still happens on your server).
- Header: `Authorization: Key <secret_key>`. `Bearer` or a bare key → `401 "Authentication credentials were not provided."`
- Env vars: `KHALTI_SECRET_KEY`, `KHALTI_ENV=sandbox|production`, `KHALTI_PUBLIC_KEY` (mobile only).

**Sandbox test wallets:** Khalti ID `9800000000` … `9800000005`, MPIN `1111`, OTP `987654`. E-banking and cards are not available in sandbox.

## 2. Flow

1. Server creates the attempt with a unique `purchase_order_id` and calls **initiate** (amount in **paisa**). Response has `pidx` and `payment_url`. **Store `pidx` on the attempt immediately**: lookup only accepts `pidx`, there is no lookup by order id.
2. Web: redirect to `payment_url`. Mobile: pass `pidx` + `payment_url` + public key to the SDK, or open `payment_url` in a WebView.
3. Khalti redirects the payer to `return_url` (GET) with query params.
4. Server calls **lookup** with the **stored** `pidx`. Fulfil only when `status == "Completed"` **and** `total_amount` equals your stored amount.

## 3. Initiate

`POST {base}/epayment/initiate/` with JSON:

| Field | Req | Notes |
|---|---|---|
| `return_url` | ✓ | Must accept GET. |
| `website_url` | ✓ | Your site URL. |
| `amount` | ✓ | **Integer paisa.** Minimum `1000` (Rs 10). Send a number, not a string. |
| `purchase_order_id` | ✓ | Your unique attempt id. |
| `purchase_order_name` | ✓ | Product / order name. |
| `customer_info` | – | `{ "name", "email", "phone" }` |
| `amount_breakdown` | – | `[{ "label", "amount" }]`, must sum to `amount` (else "Amount Breakdown mismatch."). |
| `product_details` | – | `[{ "identity", "name", "total_price", "quantity", "unit_price" }]` |
| `merchant_*` | – | Any key prefixed `merchant_` is echoed back in the success payload. |

Response `200`:
```json
{ "pidx": "bZQLD9wRVWo4CdESSfuSsB", "payment_url": "https://test-pay.khalti.com/?pidx=bZQLD9wRVWo4CdESSfuSsB",
  "expires_at": "2023-05-25T16:26:16.471649+05:45", "expires_in": 1800 }
```
Links expire (60 min by default in production; the sandbox sample shows 1800 s).

## 4. Return URL callback

GET `return_url?pidx=…&status=…&transaction_id=…&tidx=…&amount=…&total_amount=…&mobile=…&purchase_order_id=…&purchase_order_name=…`

- `status`: `Completed` | `Pending` | `User canceled` (URL-encoded space).
- `tidx` = `transaction_id`; `total_amount` = `amount` (paisa); `mobile` is masked (`98XXXXX904`).
- On cancel, `transaction_id`, `tidx`, `mobile` are empty.
- Any `merchant_*` extras come back too.

**These params are informational.** Load the attempt by `purchase_order_id`, then call lookup with the `pidx` from *your* database (reject if the callback's `pidx` differs).

## 5. Lookup (verification)

`POST {base}/epayment/lookup/` body `{ "pidx": "…" }` →
```json
{ "pidx": "…", "total_amount": 1000, "status": "Completed", "transaction_id": "GFq9PFS7b2iYvL8Lir9oXe", "fee": 0, "refunded": false }
```

| `status` | HTTP | Normalized | Action |
|---|---|---|---|
| `Completed` | 200 | `paid` | Fulfil (after amount check). |
| `Pending` | 200 | `pending` | Don't fulfil; re-check later; contact Khalti if stuck. |
| `Initiated` | 200 | `pending` | Payer hasn't paid yet. |
| `Refunded` | 200 | `refunded` | Don't fulfil. |
| `Partially Refunded` | 200 | `partially_refunded` | Compare case-insensitively (docs also write "Partially refunded"). |
| `Expired` | **400** | `expired` | Failed; new attempt needed. |
| `User canceled` | **400** | `canceled` | Failed; new attempt needed. |
| body `{"detail":"Not found."}` | 404 | `not_found` | Wrong pidx or wrong environment/key. |

Expired and canceled come back as **HTTP 400 with a normal body**, so parse the body before treating non-2xx as an error. The adapters do this.

## 6. Refund

`POST https://{dev.}khalti.com/api/merchant-transaction/{transaction_id}/refund/` with `Authorization: Key …`. `transaction_id` comes from lookup.

| Case | Body |
|---|---|
| Wallet, full | `{}` |
| Wallet, partial | `{ "amount": <paisa> }` |
| Bank, full | `{ "mobile": "98XXXXXXXX" }` |
| Bank, partial | `{ "mobile": "…", "amount": <paisa> }` |

Success: `{ "detail": "Transaction refund successful." }`. The docs say partial `amount` is paisa but their example shows `50.00`, so test a partial refund in sandbox before relying on it. Refunds can also be done from the dashboard. Khalti has **no webhooks** and no API to cancel a `pidx`.

## 7. Errors

| Case | Shape |
|---|---|
| Validation | `{ "amount": ["Amount should be greater than Rs. 10, that is 1000 paisa."], "error_key": "validation_error" }` |
| Wrong key | `401 { "detail": "Invalid token.", "status_code": 401 }` |
| Missing / wrong prefix | `401 { "detail": "Authentication credentials were not provided.", "status_code": 401 }` |
| Unknown pidx | `{ "detail": "Not found.", "error_key": "validation_error" }` |
| Pre-KYC merchant | `"Amount must be less than 200."`: new merchants are capped at NPR 200/txn until KYC and the contract are done. |
| Sandbox fee | `"Fee not found."`: use an amount between Rs 10 and Rs 200 in sandbox. |

## 8. Mobile SDKs

Every SDK flow is: **your backend initiates** (secret key) → the app receives `pidx` + `payment_url` → the SDK opens checkout → on `onPaymentResult` the app **calls your backend**, which runs lookup and returns the real status. The SDKs' own status check uses the public key and is only for UX.

### Flutter: `khalti_checkout_flutter` (Android + iOS only)
```yaml
dependencies:
  khalti_checkout_flutter: ^1.0.1   # Dart ^3.4, Flutter >= 3.22
```
```dart
import 'package:khalti_checkout_flutter/khalti_checkout_flutter.dart';

Future<void> payWithKhalti(BuildContext context, String orderId) async {
  // 1. Backend initiates and returns {pidx, payment_url}
  final init = await api.post('/payments', {'orderId': orderId, 'provider': 'khalti'});

  final khalti = await Khalti.init(
    enableDebugging: kDebugMode,
    payConfig: KhaltiPayConfig(
      publicKey: const String.fromEnvironment('KHALTI_PUBLIC_KEY'),
      pidx: init['providerRef'],
      paymentUrl: init['url'],
      environment: kReleaseMode ? Environment.prod : Environment.test,
    ),
    onPaymentResult: (paymentResult, khalti) async {
      khalti.close(context);
      // 2. Server-side lookup decides; never fulfil from paymentResult alone.
      final verified = await api.post('/payments/$orderId/verify', {});
      showResult(verified['status']); // 'paid' | 'pending' | ...
    },
    onMessage: (khalti, {description, statusCode, event, needsPaymentConfirmation}) async {
      if (needsPaymentConfirmation == true) {
        await api.post('/payments/$orderId/verify', {}); // network blip mid-payment: ask server
      }
      khalti.close(context);
    },
    onReturn: () {}, // return_url loaded
  );
  khalti.open(context);
}
```
`KhaltiEvent`: `kpgDisposed, returnUrlLoadFailure, networkFailure, paymentLookupfailure, unknown`. `2.0.0-beta.1` (Oct 2026, prerelease) is breaking: `pidx` is removed from the config (read from `paymentUrl`), `open()` returns a Future and tries the Khalti app first, there are new events `cancelled`, `paymentExpired`, `kpgLoadFailure`, and Android minSdk is 24. Pin `^1.0.1` until 2.0 is stable.

### Android: `com.khalti:checkout-android`
```gradle
implementation "com.khalti:checkout-android:0.08.00"
// android { compileOptions { sourceCompatibility JavaVersion.VERSION_1_8; targetCompatibility JavaVersion.VERSION_1_8 } }
```
```kotlin
val config = KhaltiPayConfig(
    publicKey = BuildConfig.KHALTI_PUBLIC_KEY,
    pidx = init.providerRef,
    paymentUrl = init.url,                // required in 0.08.00 (docs samples omit it and won't compile)
    environment = if (BuildConfig.DEBUG) Environment.TEST else Environment.PROD, // enum is TEST/PROD
)
val khalti = Khalti.init(
    this, config,
    onPaymentResult = { result, k -> k.close(); viewModel.verifyOnServer(orderId) },
    onMessage = { payload, k ->
        if (payload.needsPaymentConfirmation) viewModel.verifyOnServer(orderId)
        k.close()
    },
    onReturn = { _ -> },
)
khalti.open()
```

### iOS: `KhaltiCheckout` (iOS 12+)
SPM (preferred, latest 1.1.1): `.package(url: "https://github.com/khalti/checkout-sdk-ios.git", from: "1.1.1")`, product `KhaltiCheckout`. CocoaPods `pod 'KhaltiCheckout'` only has 1.0.0.
```swift
import KhaltiCheckout

let config = KhaltiPayConfig(publicKey: khaltiPublicKey, pIdx: initResp.providerRef,   // note capital I
                             paymentUrl: initResp.url, environment: isDebug ? .TEST : .PROD)
let khalti = Khalti(config: config,
    onPaymentResult: { result, khalti in khalti?.close(); verifyOnServer(orderId) },
    onMessage: { payload, khalti in
        if payload.needsPaymentConfirmation == true { verifyOnServer(orderId) }
        khalti?.close()
    },
    onReturn: { _ in })
khalti.open(viewController: self)
```

### React Native / Expo / Ionic / Capacitor
No official SDK (the `khalti-sdk-react-native` repo is empty; third-party npm packages are unofficial). Use the generic pattern in `mobile.md`: backend initiates → open `payment_url` in `react-native-webview` or an in-app browser → intercept navigation to your `return_url` → call your backend's verify endpoint.

### Web
No KPG-2 JS SDK exists or is needed: initiate on the server, then `window.location = payment_url` (or a server 302). Khalti sends no CORS headers, so calling its API from the browser fails anyway.

## 9. Deprecated APIs (don't follow old tutorials)

All of these are dead or archived. If you see them in existing code, migrate to KPG-2:
- Web widget `khalti-checkout-web` (npm) with `new KhaltiCheckout({ publicKey, productIdentity, eventHandler })`, followed by `POST /api/v2/payment/verify/ { token, amount }`
- Wallet API `/api/v2/payment/initiate/` and `/confirm/`, `/api/v2/payment/status/`
- SDKs `com.khalti:khalti-android`, `pod 'Khalti'`, pub `khalti` / `khalti_flutter` (KPG-v1, archived "outdated and no longer supported")
- Sandbox host `a.khalti.com` (works, but superseded by `dev.khalti.com`)

## 10. Gotchas

- **Trailing slash is mandatory.** `/epayment/initiate` → 301 → most HTTP clients re-send as GET without the body → confusing validation errors.
- **Amount is integer paisa.** Rs 100 = `10000`.
- **Lookup returns 400 for Expired / User canceled.** Parse the body.
- **Persist `pidx` at initiate.** There is no lookup by `purchase_order_id`. Verify with the stored pidx, never the callback's.
- **Server only.** No CORS headers; the secret key must not ship in apps.
- **NPR 200 cap before KYC.** Production initiates above Rs 200 fail until Khalti finishes merchant KYC.
- **Sandbox may stick at `Pending`.** Khalti's maintainers advise generating a new `pidx`.
- **`return_url` must match** between initiate and SDK usage.
- No idempotency key exists, so don't retry `initiate` blindly on timeout. Create a new attempt instead.

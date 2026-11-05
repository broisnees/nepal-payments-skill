# IME Pay

**Status**: IME Pay merged with Khalti in July 2025 ("Khalti by IME"); its dev docs now live at `github.com/khalti/imepay-dev-docs`. For new builds use **Khalti** (it reaches the former IME Pay user base). Use this for existing IME Pay merchant accounts, after confirming with the Khalti-by-IME merchant team that web checkout is still open to you.

Source: IME Pay's **official** WooCommerce and WHMCS plugins (no public web-API spec exists). Items from community code only are marked UNVERIFIED.
Adapters: `scripts/ts/src/imepay.ts`, `scripts/python/nepal_payments/imepay.py`.

## Environments and credentials

| | Base |
|---|---|
| Test | `https://stg.imepay.com.np:7979` |
| Live | `https://payment.imepay.com.np:7979` |

Port **7979** must be reachable outbound from your server; IME support may need to whitelist your server IP.
Credentials: `MerchantCode`, API username, API password, `Module` name.
Env vars: `IMEPAY_ENV`, `IMEPAY_MERCHANT_CODE`, `IMEPAY_USERNAME`, `IMEPAY_PASSWORD`, `IMEPAY_MODULE`.

Headers on API calls: `Authorization: Basic base64(user:pass)`, `Module: base64(ModuleName)`, `Content-Type: application/json`. IME Pay uses **no HMAC** anywhere, and its **callbacks are unsigned**.

## Flow

1. `POST /api/Web/GetToken` `{"MerchantCode","Amount":"100.00","RefId"}` → `{TokenId, ResponseCode}` (0 = OK). Persist `TokenId` as `provider_ref`.
2. Redirect to `GET /WebCheckout/Checkout?data=base64(TokenId|MerchantCode|RefId|TranAmount|Method|RespUrl|CancelUrl)` with `Method=POST` (WooCommerce plugin). The WHMCS plugin instead form-POSTs the fields `TokenId, MerchantCode, RefId, TranAmount, RespUrl, CancelUrl` to `/WebCheckout/Checkout`.
3. IME POSTs form fields `ResponseCode, RefId, TransactionId, TranAmount, Msisdn` to `RespUrl` (or `CancelUrl`). `TokenId` is not posted; the official plugin carries it in its own RespUrl query string, which works because query strings are allowed here.
4. `POST /api/Web/Recheck` `{MerchantCode, RefId, TokenId}` → `ResponseCode` **0 = paid**.

Codes other than 0 are inconsistently documented (community code reads 1 as "failed" in one library and "pending" in another, 3 as "cancelled"). The adapters therefore treat non-zero as `pending` and let the reconciliation job expire the attempt, so a payment that later succeeds is never marked failed. `POST /api/Web/Confirm` `{MerchantCode, RefId, TokenId, TransactionId, Msisdn}` appears only in community code (UNVERIFIED).

**Don't copy the official WooCommerce plugin's `validate_ipn()`**: it fetches Recheck and then ignores the result. Always recheck and compare `RefId` and amount yourself.

## Mobile SDKs

- Android `com.swifttechnology.imepaysdk:payment-service:4.0.1`, iOS `github.com/imepay/IMEPay`, Flutter `imepay_merchant_sdk`. **Security caveat:** the SDK takes the API user/password inside the app, and the merchant must host "Recording" and "Delivery" APIs specified by IME. Prefer the web checkout in a WebView (`mobile.md` §4) so credentials stay on your server.

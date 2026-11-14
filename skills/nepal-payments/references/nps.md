# Nepal Payment Solution (NPS / NPX) OnePG

One integration routes to ~29 banks' mobile banking, e-banking, card checkouts (including HBL Card Checkout) and wallets (Khalti, MORU, MyPay, Hamro Pay). It's the cheapest way to cover "all banks" plus cards without per-bank contracts.

Source: "DEVELOPER GUIDELINES – API DOCUMENT – GATEWAY 2025" (given to merchants at onboarding; not public), cross-checked against ~10 community implementations and live host probes (2026-11). NPS has rebranded to "NPX" (nepalpayment.com).
Adapters: `scripts/ts/src/providers/nps/`, `scripts/python/nepal_payments/providers/nps/`.

## Environments and credentials

| | API base | Gateway (browser POST) |
|---|---|---|
| Sandbox | `https://apisandbox.nepalpayment.com` | `https://gatewaysandbox.nepalpayment.com/Payment/Index` |
| Live | `https://apigateway.nepalpayment.com` | `https://gateway.nepalpayment.com/Payment/Index` |

Some repos use `api.nepalpayment.com` for live; it does not resolve. `apigateway.nepalpayment.com` answers (401 unauthenticated, same as sandbox). Confirm live URLs in your onboarding PDF.

Credentials: `MerchantId`, `MerchantName`, API username, API password, `SecretKey`.
Env vars: `NPS_ENV`, `NPS_MERCHANT_ID`, `NPS_MERCHANT_NAME`, `NPS_API_USERNAME`, `NPS_API_PASSWORD`, `NPS_SECRET_KEY`.

## Auth + signature

- Every API call: `Authorization: Basic base64(apiUsername:apiPassword)`, `Content-Type: application/json`.
- `Signature` = **HMAC-SHA512**(SecretKey, the **values** of all payload keys **sorted alphabetically** (excluding `Signature`) **concatenated with no separator**), as **lowercase hex**.
  - `{"MerchantId":"9","MerchantName":"TestMerchant"}` → sign `"9TestMerchant"`
  - GetProcessId keys sort as `Amount, MerchantId, MerchantName, MerchantTxnId` → `"100" + "9" + "TestMerchant" + "T1"`
- The browser redirect needs no auth and no signature.

```php
ksort($payload); $sig = hash_hmac('sha512', implode('', array_values($payload)), $secretKey);
```
```python
hmac.new(secret.encode(), "".join(str(p[k]) for k in sorted(p)).encode(), hashlib.sha512).hexdigest()
```

Every response has the shape `{"code":"0"|"1","message":"…","errors":[{"error_code","error_message"}],"data":…}`.

## Flow

1. *(optional)* `POST /GetPaymentInstrumentDetails` `{MerchantId, MerchantName, Signature}` → `[{InstitutionName, InstrumentName, InstrumentCode, BankType, LogoUrl}]`. `BankType` is `MBanking`, `EBanking`, `CheckoutGateway` (wallets) or `checkoutcard`. Use it to render your own bank/wallet picker.
2. *(optional)* `POST /GetServiceCharge` `{Amount, InstrumentCode, MerchantId, MerchantName}` → `{Amount, CommissionType, ChargeValue, TotalChargeAmount}`.
3. `POST /GetProcessId` `{MerchantId, MerchantName, Amount, MerchantTxnId, Signature}` → `data.ProcessId`. A reused `MerchantTxnId` → code 1 "Duplicate Record". **Persist ProcessId** as the attempt's `provider_ref`.
4. Browser auto-POSTs **multipart/form-data** to the gateway with `MerchantId, MerchantName, Amount, MerchantTxnId, ProcessId`, plus optional `TransactionRemarks`, `InstrumentCode` (skips NPS's picker) and `ResponseUrl`. `Amount`, `MerchantTxnId` and `ProcessId` must match step 3 exactly. `renderAutoSubmitForm()` honours `enctype`.
5. **Notification URL** (configured with NPS at onboarding): NPS calls `GET {url}?MerchantTxnId=…&GatewayTxnId=…`. It is **unsigned** and unauthenticated. Call CheckTransactionStatus, run the guarded update, and reply in **plain text** `received` (you just recorded a final status) or `already received` (it was already final). **While the payment is still pending, don't acknowledge**: return a non-2xx so NPS keeps notifying (reconciliation covers it too). `adapter.notificationResponse(wasAlreadyFinal)` returns the right string.
6. **ResponseUrl**: the browser lands here with the same two params. Verify and show the result; it is not proof.

```ts
// Notification URL handler (Hono)
const FINAL = ["paid", "failed", "canceled", "expired", "refunded", "partially_refunded"];
app.get("/payments/nps/notify", async (c) => {
  const attempt = await getAttempt(c.req.query("MerchantTxnId") ?? "");
  if (!attempt) return c.text("unknown", 404);
  const wasFinal = FINAL.includes(attempt.status);
  const after = await verifyAndTransition(attempt); // architecture.md §4; returns the stored attempt
  if (!FINAL.includes(after.status)) return c.text("pending", 503); // not acknowledged: NPS retries
  return c.text(payments.get("nps").notificationResponse(wasFinal));
});
```

## Status check

`POST /CheckTransactionStatus` `{MerchantId, MerchantName, MerchantTxnId, Signature}` → `data` with `GatewayReferenceNo, Amount, ServiceCharge, TransactionRemarks, ProcessId, TransactionDate ("yyyy-MM-dd HH:mm:ss"), MerchantTxnId, CbsMessage, Status, Institution, Instrument, PaymentCurrency, ExchangeRate`.

| `data.Status` | Normalized |
|---|---|
| `Success` | `paid` |
| `Fail` | `failed` |
| `Pending` | `pending` |
| code 1 + error_code `3` "Transaction not initialized yet" | `not_found` |

A failed payment still returns `code:"0"`, so always read `data.Status`. `Amount` excludes `ServiceCharge`; compare it with your stored amount.

## Gotchas

- Amounts are **rupee strings**. Sign exactly what you send: `"100"` ≠ `"100.00"`. The adapters use one formatted string for both GetProcessId and the form.
- The gateway form must be **multipart/form-data**.
- Make the notification handler idempotent and fast. It's unauthenticated, so never trust its params: always call CheckTransactionStatus.
- No official SDK. Community references: `PrabeshThapa/laravel-gateway` (`NepalPaymentDriver.php`), `Devloops-Software-Pvt-Ltd/drf-npx-package` (Django).

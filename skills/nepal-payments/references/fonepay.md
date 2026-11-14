# Fonepay (web payment + Dynamic QR)

Sources: official "Technical Specification Document (Fonepay Web Integration) v2.0" (Sept 2020), the Dynamic QR spec v1.1 (2024, community transcription matched by two independent codebases), official Java samples, and live dev-gateway tests (2026-11).
Adapters: `scripts/ts/src/providers/fonepay/`, plus the matching code in each port (`nepal_payments/providers/fonepay/`, `Fonepay.java`, `Fonepay.kt`, `src/Fonepay/`, `fonepay.go`).

## Contents
1. Environments and credentials
2. Web payment flow
3. Signatures (DV) + test vectors
4. Verification
5. Dynamic QR + WebSocket
6. Gotchas

## 1. Environments and credentials

| Purpose | Dev | Live |
|---|---|---|
| Web payment redirect | `https://dev-clientapi.fonepay.com/api/merchantRequest` | `https://clientapi.fonepay.com/api/merchantRequest` |
| txnVerification (POST) | `https://dev-merchantapi.fonepay.com/api/merchant/merchantDetailsForThirdParty/txnVerification`* | `https://merchantapi.fonepay.com/api/merchant/merchantDetailsForThirdParty/txnVerification` |
| Legacy verification (GET, XML) | `https://dev-clientapi.fonepay.com/api/merchantRequest/verificationMerchant` | `https://clientapi.fonepay.com/api/merchantRequest/verificationMerchant` |
| Dynamic QR | `https://dev-merchantapi.fonepay.com/api/merchant/merchantDetailsForThirdParty/…`* | `https://merchantapi.fonepay.com/api/merchant/merchantDetailsForThirdParty/…` |
| WebSocket | `wss://dev-ws.fonepay.com/convergent-webSocket-web/merchantEndPoint`* | `wss://ws.fonepay.com/convergent-webSocket-web/merchantEndPoint` |
| Merchant panel | https://dev-merchant-login.fonepay.com | https://login.fonepay.com |

\* Dev merchant-API hosts are not in public DNS; Fonepay issues or whitelists them during onboarding. Override them with the adapter's `txnVerificationUrl` / `qrBaseUrl` options.

**Credentials** (from your acquiring bank / Fonepay onboarding):
- `PID`: merchant code, 3–20 chars.
- **Secret key**: the HMAC key, shown on the merchant profile page. Test and live keys differ.
- **Merchant-panel username + password**: needed for txnVerification (recommended) and Dynamic QR.

Public dev sample from the official docs: `PID=NBQM`, secret `a7e3512f5032480a83137793cb2021dc`. The dev gateway accepted it in 2026-11 tests, so you can test redirects without onboarding.

Env vars: `FONEPAY_ENV`, `FONEPAY_MERCHANT_CODE`, `FONEPAY_SECRET_KEY`, `FONEPAY_USERNAME`, `FONEPAY_PASSWORD`.

## 2. Web payment flow

1. Server builds params + DV, then redirects the browser (GET, URL-encoded query) to `merchantRequest`.
2. Fonepay answers `303` to its payment page. The payer pays with a bank app or scans the QR.
3. Fonepay redirects to `RU` with `PRN, PID, PS, RC, UID, BC, INI, P_AMT, R_AMT, DV`.
4. Server verifies the response DV, then calls **txnVerification** (or the legacy verification).

| Param | Rule |
|---|---|
| `PID` | merchant code |
| `MD` | `P` |
| `PRN` | your attempt id, **3–25 chars**, unique (`Duplicate PRN` → HTTP 409) |
| `AMT` | **rupees** (`10`, `10.50`) |
| `CRN` | `NPR` |
| `DT` | `MM/DD/YYYY` in **Asia/Kathmandu** |
| `R1` | description, ≤ 160 chars |
| `R2` | remarks, ≤ 50 chars, `N/A` if none |
| `RU` | return URL, ≤ 150 chars |
| `DV` | HMAC (below) |

**Callback params are trusted only with a valid DV.** A missing DV counts as invalid: otherwise anyone could send `?PRN=<id>&PS=false` and force a failure. The adapters throw `invalid_signature` (strict mode) and never derive a status from unsigned flags.

Return params: `PS` = `true`/`false`. `RC` = `successful` / `failed` / `cancel`. `UID` = Fonepay trace id (store it). `BC` = paying bank SWIFT or `N/A`. `INI` = initiator. `P_AMT` = amount paid (can differ due to charges or discounts). `R_AMT` = **amount requested by the merchant** (not a refund amount, despite some community docs).

## 3. Signatures (DV) + test vectors

`HMAC-SHA512(key = secret UTF-8, message = values joined by ",")` → **hex**. The official Java sample emits uppercase and PHP `hash_hmac` emits lowercase. The dev gateway accepted both in live tests, so compare case-insensitively.

| Use | Field order |
|---|---|
| Request DV | `PID,MD,PRN,AMT,CRN,DT,R1,R2,RU` (raw values, **not** URL-encoded) |
| Response DV | `PRN,PID,PS,RC,UID,BC,INI,P_AMT,R_AMT` (raw strings as received, e.g. `20.0`) |
| txnVerification `auth` header | `username,password,POST,application/json,/merchant/merchantDetailsForThirdParty/txnVerification,<exact JSON body>` |
| QR create `dataValidation` | `amount,prn,merchantCode,remarks1,remarks2` (lowercase hex in samples) |
| QR status `dataValidation` | `prn,merchantCode` |
| Legacy verification DV | `PID,AMT,PRN,BID,UID` |

Verified vectors (secret `a7e3512f5032480a83137793cb2021dc`):
- Response DV of `d1580724437729,NBQM,true,successful,36463,NICENPKA,9841845631,20.0,30` → `667860224021DF1891F7DE873A37B1DEDA720CCDC43F63BC88F86ED20F579E0DE66526D37C71B1D14A8D466E4B740D17D4FF274CD2819FD6ED2AA3D9A89D7C52`
- `auth` for `gnw71090@zwoho.com,Fonepay@12345,POST,application/json,/merchant/merchantDetailsForThirdParty/txnVerification,{"prn": "d1549791827186","merchantCode": "NBQM","amount": "30"}` → `0d3ebe65246182596de0d417e8e39d37ebe2f5da028c52ae0a33a05062a3bded8a737c3ff82b6f1a6d9442d11cfcb0432d86998af81f481948c0af7b346f4fa2`
- QR `14,5d76d323-d1f6,NBQM,test1,test2` → `5ae718032328ae5615fa4694dfbf3ecd13432bd49031e7285a3f8bc122ecbb8e833e83c7a11f895d30f3e8fd1906317aece113675166ae0d804ecf32a8bbdbaf`

The spec's **request** DV example (`099d85…`) doesn't reproduce with any field variant. Use the live gateway instead: a bad DV returns `409 {"message":"Data Validation Failed"}`, and a good one returns `303` to the payment page.

```php
strtoupper(hash_hmac('sha512', implode(',', [$pid,'P',$prn,$amt,'NPR',$dt,$r1,$r2,$ru]), $secret));
```
```python
hmac.new(secret.encode(), ",".join(values).encode(), hashlib.sha512).hexdigest().upper()
```
```go
m := hmac.New(sha512.New, []byte(secret)); m.Write([]byte(strings.Join(values, ","))); strings.ToUpper(hex.EncodeToString(m.Sum(nil)))
```

## 4. Verification

### txnVerification (recommended; works without a callback, so reconciliation can use it)
```
POST …/txnVerification
Authorization: Basic base64(username:password)
auth: <hmac hex>
Content-Type: application/json

{"prn": "d1549791827186","merchantCode": "NBQM","amount": "30"}
```
Response: `{fonepayTraceId, merchantCode, paymentStatus, prn, requestedAmount, totalTransactionAmount, transactionDate, initiator}`. `paymentStatus` is `success` → paid, `pending` → pending, `failed` → failed. Errors: `401 {"errorCode":401,"message":"cannot access this resource"}`, or a validation array.

**The `auth` HMAC covers the exact body bytes.** Build the JSON string once and send that same string. Don't let your HTTP client re-serialize it (Python's `json.dumps` adds spaces after commas, a known community bug). The adapters reproduce the spec's format (`": "` after keys, no space after commas) and match the spec vector byte for byte.

### Legacy GET verification (2019, still answers)
`GET …/verificationMerchant?PRN&PID&BID(=BC)&AMT&UID&DV` returns XML. Success is `<response_code>successful</response_code>` and `<success>true</success>`. A non-200 or unparseable reply throws (the attempt stays open); it never reads as "not paid". It needs `UID` and `BC` from the redirect, so it can't reconcile abandoned sessions. The adapters use it only when no username/password is configured.

## 5. Dynamic QR + WebSocket

For POS, kiosks, desktop checkouts and "scan to pay" screens. Needs username/password.

1. `qrCreate({orderId, amountPaisa, remarks1, remarks2})` → POST `thirdPartyDynamicQrDownload` with `{amount, remarks1, remarks2, prn, merchantCode, dataValidation, username, password}` → `{qrMessage, status:"CREATED", statusCode:201, thirdpartyQrWebSocketUrl}`. Render `qrMessage` (an EMV/NepalQR string) with any QR library. Errors return `406 "Data Validation Failed"`.
2. Connect to `thirdpartyQrWebSocketUrl`. Messages carry `transactionStatus` as a JSON **string**: first `{"QRVerified":true}` (scanned), then `{"paymentSuccess":true, traceId, amount}`. The URL has been seen with a `localhost` host; the adapter rewrites it to `ws.fonepay.com`.
3. **Always** confirm with `qrStatus(orderId)` → POST `thirdPartyDynamicQrGetStatus` (`paymentStatus`: `success` / `failed` / `pending`) before fulfilling. Never trust the socket alone.

```ts
const { qrMessage, webSocketUrl } = await fp.qrCreate({ orderId, amountPaisa, remarks1: "Table 4" });
const ws = new WebSocket(webSocketUrl!);
ws.onmessage = async (ev) => {
  const msg = JSON.parse(ev.data);
  const st = typeof msg.transactionStatus === "string" ? JSON.parse(msg.transactionStatus) : msg.transactionStatus;
  if (st?.paymentSuccess) {
    const v = await fp.qrStatus(orderId);            // authoritative
    if (v.status === "paid") await markPaid(orderId); // same conditional update as architecture.md §4
    ws.close();
  }
};
// Also poll qrStatus every ~5 s as a fallback in case the socket drops.
```
Amount units: the official examples use rupees (`"14"`). One community SDK sends paisa; the adapters follow the official examples.

## 6. Gotchas

- **AMT in DV must be byte-identical to AMT sent.** `10` ≠ `10.00` ≠ `10.0`. The adapters format once with `paisaToRupees`.
- **`DT` uses Nepal time.** Near midnight UTC, Nepal is already on the next day. `fonepayDate()` handles that.
- **PRN length**: max 25 on the web flow (UUIDs don't fit; use `newOrderId()`), max 50 on txnVerification.
- **Response DV uses raw received strings.** Don't parse or reformat `P_AMT` before hashing.
- **Never compute DV on a client.** Some unofficial Flutter packages do; that ships your secret.
- **Hosts**: `dev.fonepay.com/api/merchantRequest` and `fonepay.com/api/merchantRequest` (seen in some starters) return 404. Use the `clientapi` hosts above.
- **Refunds**: no public refund API. Use the merchant panel or your bank. `thirdPartyPostTaxRefund` is a tax refund, not a payment refund.
- "Checkout by Fonepay" (launched July 2026) and a newer "third-party v2" API (RSA-signed, Intent QR) exist without public specs. Ask Fonepay if you're starting fresh.

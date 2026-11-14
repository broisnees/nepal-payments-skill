# NEPALPAY QR (NCHL) merchant dynamic QR

NCHL's national QR scheme (NepalQR / EMVCo merchant-presented). A dynamic QR carries the amount and a bill number, and any NEPALPAY QR enabled mobile banking app or wallet can pay it: NCHL lists 20+ banks, and the scheme interoperates with the other domestic QR networks. It's the bank-run equivalent of Fonepay Dynamic QR, and it suits POS, kiosks, billing software and "scan to pay" on desktop checkout.

Official docs (public): https://doc.connectips.com/docs/NepalPAY-QR/Merchant-QR-generation/introduction, plus the [transaction report](https://doc.connectips.com/docs/NepalPAY-QR/Transaction-Report/transaction_report), [payment confirmation](https://doc.connectips.com/docs/NepalPAY-QR/QR-Merchant-Bulk-Enrollment/payment_confirmation_api) and [WebSocket](https://doc.connectips.com/docs/NepalPAY-QR/NEPALPAY-QR-Websocket/api_specification) pages. Checked 2026-11 against those docs, one working C# client (`anish-maharzan/ConnectIPS.Integration`) and live host probes.
Adapters: `scripts/ts/src/providers/nepalpay/`, plus the matching file in each port (`providers/nepalpay/` in Python, `NepalPay.java`, `NepalPay.kt`, `src/NepalPay/`, `nepalpay.go`).

## Contents
1. Environments and onboarding
2. Auth
3. Generate a dynamic QR
4. Token signature
5. Verify: transaction report
6. Payment confirmation and WebSocket
7. Gotchas

## 1. Environments and onboarding

| | UAT | Live |
|---|---|---|
| Base (NPI) | `https://devopennpi.connectips.com` | `https://opennpi.connectips.com` |
| Generate QR | `POST /qr/generateQR` | same |
| Report | `POST /nQR/v1/merchanttxnreport` | same |
| OAuth (optional) | `POST /oauth/token` | same |

Both hosts answer today with `E401 UNAUTHORIZED` when the credentials are missing or wrong.

**Onboarding**: the merchant enrols through its bank (or emails businesssupport@nchl.com.np for dynamic QR integration), using NCHL's [enrollment form](https://nchl.com.np/nepalpay-qr-merchant-enrollment-form/). NCHL issues:
- `acquirerId` (8 digits, the acquiring bank, e.g. `00002501`) and `merchantId` (creditor code, e.g. `2501ELFDRY2`)
- Merchant category code (MCC), enrolled merchant name, city, postal code
- An **NPI user** (username + password), which is also the `userId` inside the token
- A signing certificate **`.pfx`** (`NPI.pfx` in UAT); convert it to PKCS#8 PEM exactly like connectIPS (`connectips.md` §2)
- For OAuth only: client id + secret

Env vars: `NEPALPAY_ENV`, `NEPALPAY_ACQUIRER_ID`, `NEPALPAY_MERCHANT_ID`, `NEPALPAY_MERCHANT_NAME`, `NEPALPAY_MCC`, `NEPALPAY_MERCHANT_CITY`, `NEPALPAY_MERCHANT_POSTAL_CODE`, `NEPALPAY_STORE_LABEL`, `NEPALPAY_TERMINAL_LABEL`, `NEPALPAY_USERNAME`, `NEPALPAY_PASSWORD`, `NEPALPAY_PRIVATE_KEY_PEM`, `NEPALPAY_CLIENT_ID` / `NEPALPAY_CLIENT_SECRET` to switch to OAuth, `NEPALPAY_NCHL_PUBLIC_KEY_PEM` (from `NPI.cer`: `openssl x509 -in NPI.cer -pubkey -noout`), and `NEPALPAY_WS_URL` / `NEPALPAY_WS_USERNAME` / `NEPALPAY_WS_API_TOKEN` for the WebSocket.

## 2. Auth

NCHL documents two schemes, and the live hosts parse both:

- **Basic** (the merchant QR page): `Authorization: Basic base64(npiUsername:npiPassword)` on every call. The adapters default to this.
- **OAuth 2 password grant** (the NPI API page, and what the C# client uses): `POST /oauth/token` form-encoded with `Authorization: Basic base64(clientId:clientSecret)` and `grant_type=password&username=...&password=...`. That returns `{access_token, refresh_token, expires_in: 299}`. Send `Authorization: Bearer <access_token>` after that. The adapters cache the access token until 30 s before `expires_in`, then request a new one. The refresh token lasts 12 hours (`grant_type=refresh_token`), so call it directly if NCHL rate-limits password grants.

Set `auth: "oauth"` plus `clientId`/`clientSecret` (or `NEPALPAY_CLIENT_ID`) when your onboarding email gives you client credentials.

## 3. Generate a dynamic QR

```http
POST /qr/generateQR
Content-Type: application/json

{"pointOfInitialization":12,"acquirerId":"00001701","merchantId":"17012UVSTIR","merchantName":"BBSM",
 "merchantCategoryCode":5021,"merchantCountry":"NP","merchantCity":"Kathmandu","merchantPostalCode":"4600",
 "merchantLanguage":"en","transactionCurrency":524,"transactionAmount":"10.50","valueOfConvenienceFeeFixed":"0.00",
 "billNumber":"P1KX3M9Q2ZAB7C4D8E","storeLabel":"Store1","terminalLabel":"Terminal1",
 "purposeOfTransaction":"Everest T-shirt","qrImage":true,"token":"<sig>"}
```

- `pointOfInitialization`: `12` dynamic, `11` static. The adapters always send 12.
- `transactionCurrency` is the ISO numeric code (`524` = NPR). `transactionAmount` is a rupee string with **two decimals**.
- `billNumber` (≤ 25) is your attempt id. It comes back as `merchantBillNo` in reports and notifications.
- `merchantName`, `storeLabel`, `terminalLabel`, `purposeOfTransaction` and `addnField1-10` are capped at 25 chars.
- `qrImage: true` also returns a base64 PNG, so a page can show `<img src="data:image/png;base64,...">` without a QR library.

Response:
```json
{"timestamp":"2022-05-23 04:25:26","responseCode":"000","responseStatus":"SUCCESS",
 "responseMessage":"QR String generated successfully.",
 "data":{"validationTraceId":"2205260000001900KIY","qrString":"000201010212...6304607F","qrImage":"iVBORw0..."}}
```

**`validationTraceId` is the providerRef.** Persist it on the attempt, because verify() queries by it. It is also embedded in the QR (tag 62, sub-tag 51). Errors come back as `E003 INVALID TOKEN`, `E010 RECORD NOT FOUND:- Merchant not found!`, `E999 ERROR`, or a `400 PARAMETER VALIDATION ERROR` with `fieldErrors`. The adapters throw `PaymentError` with the NCHL code.

`initiate()` returns `{ kind: "qr", qrString, qrImage?, providerRef }`. This is the only provider with that result kind, so a route that handled only `redirect` and `form` needs a third branch (see `scripts/ts/examples/server.ts`).

## 4. Token signature

```
tokenString = acquirerId,merchantId,merchantCategoryCode,transactionCurrency,transactionAmount,billNumber,userId
            = "00001701,17012UVSTIR,5021,524,10.50,P1,npiuser"
token       = base64( RSA-SHA256 PKCS#1 v1.5 ( tokenString ) )   with the .pfx private key
```

- `userId` is the **NPI username**.
- The docs print the separator as `", "` (comma, space). That's a word-processor artifact: every other NPI token string, and the working C# client, use a bare comma.
- Static QR drops `transactionAmount`: `acquirerId,merchantId,merchantCategoryCode,transactionCurrency,billNumber,userId`.
- Sign the exact `transactionAmount` string you send (`"10.50"`, never `10.5`).

## 5. Verify: transaction report

```http
POST /nQR/v1/merchanttxnreport
{"validationTraceId":"2205260000001900KIY","merchantId":"17012UVSTIR","acquirerId":"00001701"}
```
Date-wise: `{"fromDate":"2024-07-24","toDate":"2024-07-24","merchantId":...,"acquirerId":...}` (for reconciliation sweeps).

Response: `{"responseCode":"200","responseStatus":"SUCCESS","responseBody":[{sessionSrlNo, recDate, instructionId, nQrTxnId, acquirerId, issuerId, network, issuerNetwork, amount, interchangeFee, transactionFee, debitStatus, creditStatus, payerName, tranType, payerMobileNumber, merchantName, merchantTxnRef, terminal, merchantBillNo, ...}]}`

**One QR can have several rows.** A customer whose first scan failed can pay the same dynamic QR again, so the report lists the failed and the successful attempt. The adapters map it like this:

| Rows (`tranType` PMT only) | Normalized |
|---|---|
| any row with `debitStatus` `000` and `creditStatus` ∈ {`000`, `999`, `DEFER`} | `paid` (amount and `nQrTxnId` from that row) |
| last row debited (`000`) but credit not OK | `unknown` (money left the payer; review) |
| rows exist, none debited | `failed` |
| no rows, empty body, or `E010` | `not_found` |

`amount` is a rupee number (`500.0`), so convert it to paisa and compare with your stored amount (`decideTransition` does). `RFND` rows are refunds, which the acquirer starts. They don't make an attempt paid.

## 6. Payment confirmation and WebSocket

**Payment confirmation** (merchants or service providers that registered a callback with NCHL): NEPALPAY POSTs to `{your base}/nepalpay/confirm-payment` with Basic auth and a body like `{txnDate, txnAmount, chargeAmt, merchantId, merchantName, rpstxnId, validationTraceId, paymentRef, merchantBillNo, status, statusDesc, channel, payerMobile, sessionNo, signature, ...}`. Reply with a signed JSON:
```
tokenString = txnDate,status,message,merchantBillNo,paymentRef   -> RSA-SHA256, base64, in "signature"
```
`confirmationResponse(notification)` builds that reply. NCHL signs the request over `merchantBillNo,merchantId,merchantName,paymentRef,channel,payerMobileNumber,sessionNo` (`nepalPayConfirmationString`; the sample names the field `payerMobile`, so the adapters fall back to it). `verifyConfirmation(body)` checks that signature against `nchlPublicKeyPem`. The docs don't say which NCHL key signs notifications, so treat `false` as a reason to log and alert, not as proof of forgery. Either way, load the attempt by `merchantBillNo` (`orderIdFromCallback`) and **call verify()** before fulfilling.

**WebSocket** (live status on a QR screen): STOMP, subscribe `/user/nqrws/check-txn-status`, then send `{merchant_id: <terminalLabel>, request_id: <validationTraceId>, username, api_token}` to `/nqrws/check-txn-status`. `api_token` is encrypted with NCHL's public key using `RSA/ECB/PKCS1Padding`. Status goes `ENTR` → `PARSED` → `COMPLETED`/`FAILED`, with `debit_status`/`credit_status`. NCHL issues the socket URL, the WS username and the API token separately: the NPI REST hosts answer 404 on `/nqrws`. `webSocketRequest(validationTraceId)` returns `{url, subscribe, send, body}` with the token already encrypted. TS hand-rolls PKCS#1 v1.5 padding with BigInt because WebCrypto only offers OAEP, and the other ports use their standard library. Use any STOMP client (`@stomp/stompjs`, `stomp.py`, Spring `WebSocketStompClient`) to connect. On `COMPLETED`, call verify(). Polling verify() every 3-5 s while the QR is on screen works without any of this.

## 7. Gotchas

- **No redirect, no return URL.** The payer is in their own banking app. Poll verify() from the QR page (or listen on the WebSocket), and run the reconciliation sweep for anyone who closes the page.
- **Persist `validationTraceId`.** Without it you can only find the payment through a date-wise report.
- **Amounts in rupees with two decimals**, unlike connectIPS (paisa).
- `billNumber` ≤ 25 chars; `newOrderId()` fits.
- `merchantName` must match the enrolled name, or generateQR fails merchant validation.
- Settlement to the merchant is deferred (`creditStatus: "DEFER"`). For the payment itself, DEFER is final: NCHL lists `000`, `999` and `DEFER` as success.
- Refunds go through your acquiring bank (the NPI refund API is acquirer-level).
- Never sign in the browser or POS app. The `.pfx` stays on the server, and the POS asks your server for the QR.

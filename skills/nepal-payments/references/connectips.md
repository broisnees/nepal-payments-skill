# connectIPS (NCHL) e-payment gateway

Official docs: https://doc.connectips.com/docs/connectIPS-Gateway/merchant-interface (heavy WAF; read slowly). Verified 2026-11 against the docs, three community SDKs, and live endpoint probes.
Adapters: `scripts/ts/src/providers/connectips/`, plus the matching code in each port (`nepal_payments/providers/connectips/`, `ConnectIps.java`, `ConnectIps.kt`, `src/ConnectIps/`, `connectips.go`).

## Contents
1. Environments and onboarding
2. Key preparation (.pfx)
3. Flow and form fields
4. TOKEN signature
5. Validation APIs
6. Gotchas

## 1. Environments and onboarding

| | UAT | Live |
|---|---|---|
| Base | `https://uat.connectips.com` | `https://login.connectips.com` |
| Gateway (form POST) | `/connectipswebgw/loginpage` | same |
| Validate | `/connectipswebws/api/creditor/validatetxn` | same |
| Detail | `/connectipswebws/api/creditor/gettxndetail` | same |

`https://connectips.com/...` returns 404 and `uat.connectips.com:7443` times out, yet both appear in community libraries. Use the hosts above.

**Onboarding**: the merchant enrols through its bank (KYC, creditor account), the bank lists it with NCHL, and NCHL emails:
- `MERCHANTID` (integer), `APPID` (e.g. `MER-550-APP-1`), `APPNAME`
- App **password** (Basic auth for the validation APIs)
- Creditor certificate **`.pfx`** + its password (`CREDITOR.pfx` in UAT)

One merchant can have several apps (one bank account each). Test accounts come from connectIPS technical support by email.

**Success/failure URLs are registered with NCHL** (localhost allowed in UAT); they aren't sent per request. Unregistered URLs show up as `403 session expired` after OTP.

Env vars: `CONNECTIPS_ENV`, `CONNECTIPS_MERCHANT_ID`, `CONNECTIPS_APP_ID`, `CONNECTIPS_APP_NAME`, `CONNECTIPS_APP_PASSWORD`, `CONNECTIPS_PRIVATE_KEY_PEM` (PEM with `\n` escapes is fine).

## 2. Key preparation (.pfx)

TypeScript (WebCrypto) needs a PKCS#8 PEM. Convert once and store the result in your secret manager:
```bash
openssl pkcs12 -in CREDITOR.pfx -nocerts -nodes -passin pass:"$PFX_PASSWORD" \
  | openssl pkcs8 -topk8 -nocrypt -out creditor.key.pem
# OpenSSL 3+ with old RC2/3DES-encrypted .pfx files: add -legacy to the first command
```
Python can load the `.pfx` directly: `load_pfx_private_key_pem(pfx_bytes, password)` in `core.py` (needs `cryptography`).

Never commit the `.pfx`, its password or the PEM. Keep them on the server only.

## 3. Flow and form fields

1. Server builds the fields and signs `TOKEN`. The browser **auto-POSTs** (form-urlencoded) to `loginpage`.
2. Payer logs into connectIPS, picks a bank account and enters the OTP.
3. connectIPS redirects to your registered success/failure URL with **only `?TXNID=<your id>`**.
4. Server calls **validatetxn** (optionally gettxndetail) and fulfils on `SUCCESS` + amount match.

| Field | Len | Notes |
|---|---|---|
| `MERCHANTID` | 20 | integer |
| `APPID` | 15 | |
| `APPNAME` | 30 | |
| `TXNID` | **20** | your attempt id, unique per app. Duplicate → 403 "multiple gateway payments at once" |
| `TXNDATE` | 10 | **`DD-MM-YYYY`** (Nepal date) |
| `TXNCRNCY` | 3 | `NPR` |
| `TXNAMT` | 20 | **paisa** (integer) |
| `REFERENCEID` | 20 | your reference |
| `REMARKS` | 50 | |
| `PARTICULARS` | 100 | |
| `TOKEN` | 512 | signature |

Over-long values return "invalid input". The adapters clip them, and strip `,` and `=`, which would corrupt the token string.

## 4. TOKEN signature

Token string (no spaces; the literal `TOKEN=TOKEN` at the end):
```
MERCHANTID=550,APPID=MER-550-APP-1,APPNAME=Test,TXNID=txn123,TXNDATE=15-03-2022,TXNCRNCY=NPR,TXNAMT=500,REFERENCEID=REF-001,REMARKS=RMKS-001,PARTICULARS=PART-001,TOKEN=TOKEN
```
`TOKEN = base64( RSA-PKCS1v1.5-SHA256( creditor private key, token string ) )`. The docs describe it as "SHA-256 digest then sign"; that's what SHA256withRSA does internally, so **don't pre-hash**. (One docs template shows `", "` separators, but the worked example and every SDK use bare commas.)

```bash
# Shell check
printf '%s' "$TOKEN_STRING" | openssl dgst -sha256 -sign creditor.key.pem | base64
```
```php
openssl_sign($tokenString, $sig, $privateKey, OPENSSL_ALGO_SHA256); base64_encode($sig);
// $privateKey from openssl_pkcs12_read(file_get_contents('CREDITOR.pfx'), $certs, $pfxPassword) → $certs['pkey']
```
```java
Signature s = Signature.getInstance("SHA256withRSA"); s.initSign(privateKeyFromPkcs12); s.update(tokenString.getBytes(UTF_8));
Base64.getEncoder().encodeToString(s.sign());
```
```go
h := sha256.Sum256([]byte(tokenString))
sig, _ := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, h[:]) // key via software.sslmate.com/src/go-pkcs12
base64.StdEncoding.EncodeToString(sig)
```

## 5. Validation APIs

```
POST /connectipswebws/api/creditor/validatetxn
Authorization: Basic base64(APPID:appPassword)
Content-Type: application/json

{"merchantId":550,"appId":"MER-550-APP-1","referenceId":"txn123","txnAmt":500,"token":"<sig>"}
```
- **`referenceId` is your `TXNID`**, not `REFERENCEID`.
- `token` signs `MERCHANTID=550,APPID=MER-550-APP-1,REFERENCEID=txn123,TXNAMT=500`.
- `txnAmt` in paisa must equal the original amount.

Response: `{merchantId, appId, referenceId, txnAmt:"500", token:null, status, statusDesc}`

| status / statusDesc | Normalized |
|---|---|
| `SUCCESS` / TRANSACTION SUCCESSFUL | `paid` |
| `FAILED` / TRANSACTION UNSUCCESSFUL | `failed` |
| `ERROR` / TRANSACTION NOT FOUND | `not_found` |
| `ERROR` / TRANSACTION INCOMPLETE (no OTP yet) | `pending` |

**gettxndetail** (same request) adds `debitBankCode, txnId (NCHL), batchId, txnDate (epoch ms), txnCrncy, chargeAmt (paisa), chargeLiability (MN merchant / CG customer), refId, remarks, particulars, creditStatus`. Settlement OK when `creditStatus` ∈ {`000`, `999`, `DEFER`}. `txnAmt` is a string in validatetxn and a number (`1000.00`) in gettxndetail.

`401` means wrong APPID/password. There are no refunds and no webhooks in the gateway API: the redirect plus validatetxn (and your reconciliation job) are all you get.

## 6. Gotchas

- **TXNID ≤ 20 chars.** UUIDs don't fit; use `newOrderId()`.
- **Amounts in paisa everywhere** (form and APIs).
- **Mobile WebViews must accept cookies.** connectIPS returns "session expired" after the captcha when cookies are blocked (Android: `CookieManager.setAcceptThirdPartyCookies(webView, true)`).
- **Register redirect URLs with NCHL** before testing. Otherwise you get 403 after OTP.
- Load the key once at startup, not per request. If a multi-entry `.pfx` exists, pick the private-key entry.
- **NEPALPAY QR** is NCHL's QR scheme, separate from this gateway. It has its own merchant API (dynamic QR generation + transaction report, signed with a `.pfx` the same way) and is supported here: see `nepalpay.md`.

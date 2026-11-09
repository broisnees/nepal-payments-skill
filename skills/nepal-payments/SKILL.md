---
name: nepal-payments
description: Integrate Nepali payment gateways (eSewa, Khalti, Fonepay, connectIPS, NPS OnePG, CyberSource via Nepali banks, NEPALPAY QR, Hamro Pay, GetPay, IME Pay) into any backend, web app or mobile app, with tested adapters for TypeScript, Python, Java, Kotlin, PHP and Go covering server-side signing and verification, exactly-once fulfilment, reconciliation, webhooks and go-live. Use whenever the user mentions any of these providers, NPR or Nepal payments, a payment gateway in Nepal, eSewa ePay v2 or Intent, Khalti pidx, Fonepay DV or dynamic QR, connectIPS .pfx, NCHL QR, Hamro Pay, GetPay, CyberSource Secure Acceptance with a Nepali bank, HBL 2C2P, or is debugging a Nepali payment signature, callback or status check, even if they don't say "skill".
license: MIT
compatibility: Bundled adapters need one of Node.js 22.18+ (or Bun, Deno, Cloudflare Workers), Python 3.10+ (plus the cryptography package for connectIPS), JDK 17+ (Java or Kotlin), PHP 8.1+ with ext-curl and ext-openssl, or Go 1.22+. Live sandbox checks need internet access.
metadata:
  author: Nischal Dahal
  version: "1.0.0"
  repository: https://github.com/broisnees/nepal-payments-skill
---

# Nepal payments

Production integrations for Nepali payment providers. Everything here was checked against official docs, official plugins/SDK sources, and live sandbox calls in 2026-11. Reference adapters ship in `scripts/` with tests.

## Workflow

Copy this checklist into your notes and tick it off:

```
- [ ] 1. Providers picked (tree below)
- [ ] 2. Stack detected
- [ ] 3. Adapters copied; their bundled tests pass in the project
- [ ] 4. payment_attempts table + POST /payments, /start, return route (architecture.md, web.md / mobile.md)
- [ ] 5. Reconciliation job scheduled
- [ ] 6. Sandbox payment per provider verified end to end (testing.md)
- [ ] 7. Env vars documented; go-live list done (env.md, testing.md §5)
```

1. **Pick providers.** If the user didn't say:
   - Online checkout, web or app: **eSewa + Khalti** (largest wallets). Add **Hamro Pay** for Hamro Patro's wallet users.
   - Bank customers without a wallet: **NPS** or **Fonepay** (many banks through one integration), then **connectIPS** for direct bank debit.
   - Cards: **GetPay** or **CyberSource**, whichever the merchant's bank offers. The bundled CyberSource adapter is Secure Acceptance; a new CyberSource contract means Unified Checkout through Visa's official SDK (`cybersource.md` §1).
   - In-person, POS, kiosk or desktop "scan to pay": **Fonepay Dynamic QR** or **NEPALPAY QR**, whichever network the merchant's bank acquires on.
   - IME Pay only for an existing IME Pay merchant account (it merged into Khalti in 2025).
2. **Detect the stack** (`package.json`, `pyproject.toml`/`requirements.txt`, `composer.json`, `pubspec.yaml`, `go.mod`, …) and where server routes and DB models live.
3. **Install the adapters**:
   - TypeScript/JavaScript: copy `scripts/ts/src/` into the project's server code (e.g. `src/server/payments/`), keeping only the providers needed plus `core.ts` and `index.ts`. The files import each other with `.ts` extensions (runs natively on Node ≥ 22.18, Bun, Deno). If the project's tsconfig lacks `allowImportingTsExtensions`, rewrite `./x.ts` imports to match its module resolution (`./x.js` for NodeNext, extensionless for bundlers).
   - Python: copy `scripts/python/nepal_payments/` as a package (stdlib only; add `cryptography` for connectIPS).
   - Java (Spring Boot, Quarkus, Micronaut): copy `scripts/java/src/main/java/np/payments/` (JDK 17+, no dependencies; blocking API, fine on virtual threads).
   - Kotlin (Ktor, Spring Boot): copy `scripts/kotlin/src/main/kotlin/np/payments/` (kotlin-stdlib only; `suspend` API). Server-side only: never put it in an Android app.
   - PHP (Laravel, Symfony, plain PHP): copy `scripts/php/src/` (namespace `NepalPayments`, PHP 8.1+, ext-curl + ext-openssl, no Composer dependencies) and register it in the project's PSR-4 autoload.
   - Go: copy `scripts/go/payments/` into the module (e.g. `internal/payments/`) and fix the import path (stdlib only, Go 1.22+; `context.Context` on every network call; convert a connectIPS `.pfx` to PEM with openssl).
   - Other languages (C#, Ruby, Rust, Dart server): port from the TS adapter of each provider. Write the provider's **test vectors** as tests first (in each `references/<provider>.md`) and port until they pass.
   - Copy the adapters and run their tests; don't read the adapter source end to end to understand it. The interface below and the provider reference are the documentation.
4. **Add persistence + routes**: the `payment_attempts` table and the return handler from `references/architecture.md`, wired to the framework via `references/web.md`. For mobile, follow `references/mobile.md`.
5. **Add reconciliation** (`architecture.md` §6). Without it, customers who close the tab after paying never get their order.
6. **Test**: run the bundled tests, then the integration checks in `references/testing.md`. Use the sandbox credentials listed there.
7. **Env + go-live**: `references/env.md`, `references/testing.md` §5.

## Non-negotiable rules

1. **Secrets stay on the server.** Never sign in a browser or app; never ship secret keys, `.pfx` files or API passwords in web bundles or APKs/IPAs. Clients send only `orderId` + `provider`.
2. **The redirect is not proof.** Fulfil only after a server-to-server status check (eSewa status API, Khalti lookup, Fonepay txnVerification, connectIPS validatetxn, NPS CheckTransactionStatus, IME Recheck, NEPALPAY merchanttxnreport, Hamro Pay Get Transaction, GetPay merchant-status with a verified oprSecret) or, for CyberSource Secure Acceptance, a verified response signature.
3. **Verify with stored values.** Use the amount, attempt id and `providerRef` (Khalti `pidx`, NPS ProcessId, IME TokenId, NEPALPAY validationTraceId) from **your DB**, never from callback params. Compare the provider's amount with yours.
4. **One fresh id per attempt**, ≤ 20 chars `[A-Za-z0-9]` (`newOrderId()` / `new_order_id()`). connectIPS caps TXNID at 20 and Fonepay caps PRN at 25, so UUIDs break both.
5. **Exactly-once fulfilment**: a conditional `UPDATE … WHERE status IN ('initiated','pending','unknown')`, and idempotent fulfilment.
6. **Use `decideTransition()` (`decide_transition()`) for state changes.** It encodes the rules: `not_found` inside the session window (~60 min) writes nothing (anyone can hit a return URL early); a provider "paid" after you closed the attempt is a **late payment to recover**, not ignore; a "paid" whose amount differs or is missing goes to manual review, never fulfilment.
7. **Money is integer paisa internally**; format once at the adapter edge and sign exactly the string you send.
8. **Keep sandbox and live separate**: their own env vars, base URLs and keys. A sandbox key against a live URL usually answers 401 or `NOT_FOUND`, which looks like a lost payment.

## Provider quick reference

| Provider | Use for | Auth / signature | Amount sent as | Verify (authoritative) | Reference |
|---|---|---|---|---|---|
| eSewa ePay v2 | wallet; web + WebView | HMAC-SHA256 base64 of `total_amount,transaction_uuid,product_code` | rupees `"110.50"` | `GET …/api/epay/transaction/status/` | `references/esewa.md` |
| eSewa Intent | native app-to-app | HMAC-SHA256 base64, access key | rupees (number) | `POST …/intent/payment/status` | `references/esewa.md` §6 |
| Khalti KPG-2 | wallet; web + SDKs | `Authorization: Key <secret>` | **paisa** int, min 1000 | `POST /api/v2/epayment/lookup/` (400 for expired/canceled) | `references/khalti.md` |
| Fonepay | banks via QR; web redirect, Dynamic QR | HMAC-SHA512 hex (DV) | rupees | `txnVerification` (Basic + `auth` HMAC) | `references/fonepay.md` |
| connectIPS | direct bank debit | RSA-SHA256 (creditor `.pfx`) | **paisa** | `validatetxn` (Basic) | `references/connectips.md` |
| CyberSource SA | cards via Nepali banks | HMAC-SHA256 base64 (signed fields) | `"1500.00"` | signed response POST (+ Merchant POST URL) | `references/cybersource.md` |
| NPS OnePG | ~29 banks + wallets + cards in one | Basic + HMAC-SHA512 hex of sorted values | rupees | `CheckTransactionStatus` | `references/nps.md` |
| IME Pay | legacy wallet (merged into Khalti 2025) | Basic + `Module` header | rupees `"100.00"` | `Recheck` | `references/imepay.md` |
| Hamro Pay | wallet; web + WebView | `Client-Id`/`Client-API-Key` + HMAC-SHA512 base64 `Signature` | **paisa** string out, rupees back | `POST /v1/checkout/transaction` | `references/hamropay.md` |
| GetPay | cards via NCHL for banks (NMB, Global IME, ...) | browser SDK; return token `oprSecret` = base64 SHA-256(oprKey+id) | rupees (number) | `merchant-status` + `clientId` check | `references/getpay.md` |
| NEPALPAY QR | NCHL dynamic QR, any NEPALPAY bank app | Basic (or OAuth) + RSA-SHA256 token (`.pfx`) | rupees `"10.50"` | `merchanttxnreport` by validationTraceId | `references/nepalpay.md` |
| HBL (2C2P PACO), Moru, Prabhu Pay, CellPay | niche / direct acquiring | JOSE / various | — | — | `references/others.md` |

## Adapter interface

TypeScript is shown. The other ports keep the same shape: Python `create_payments(config_from_env())`, `new_order_id()`, `decide_transition()`; Go `payments.New(payments.ConfigFromEnv())`, `NewOrderID()`, `DecideTransition()`; Java `Payments.create(Payments.configFromEnv())`; Kotlin `Payments.create(paymentsConfigFromEnv())`; PHP `Payments::create(Payments::configFromEnv())`, `Payments::newOrderId()`.

```ts
import { createPayments, paymentsConfigFromEnv, newOrderId, renderAutoSubmitForm } from "./payments/index.ts";
const payments = createPayments(paymentsConfigFromEnv());

const attemptId = newOrderId();
const init = await payments.get("esewa").initiate({
  orderId: attemptId, amountPaisa: order.totalPaisa, description: order.title,
  returnUrl: `${APP_URL}/payments/esewa/return/${attemptId}`,
});
// init.kind === "redirect" → 302 to init.url        (Khalti, Fonepay, IME Pay)
// init.kind === "form"     → renderAutoSubmitForm(init) (eSewa, connectIPS, CyberSource, NPS, Hamro Pay)
// init.kind === "qr"       → show init.qrImage / init.qrString, poll verify() (NEPALPAY QR)
// init.kind === "sdk"      → getpay.checkoutPage(init, paymentPageUrl); success/fail URLs serve getpay.returnPage(verifyUrl) (GetPay)
// persist init.providerRef when present (Khalti pidx, NPS ProcessId, IME TokenId, NEPALPAY validationTraceId, Hamro Pay sessionId)

const result = await payments.adapter(provider).verify({
  orderId: attempt.id, amountPaisa: attempt.amountPaisa, providerRef: attempt.providerRef, callback: params,
});
// result.status: paid | pending | failed | canceled | expired | refunded | partially_refunded | not_found | unknown
// result.amountPaisa (provider's figure), result.transactionId (store for support/refunds)
```
State machine: `decideTransition(prevStatus, result, storedAmountPaisa, attemptAgeMs)` → `{ next, reviewRequired, latePaid, reason }`; apply `next` with an UPDATE guarded by `prevStatus` (`architecture.md` §4).
Provider extras: `esewa.intentBook/intentVerify/intentCancel`, `khalti.refund`, `fonepay.qrCreate/qrStatus`, `connectips.getTxnDetail`, `nepalpay.report/confirmationResponse/verifyConfirmation/webSocketRequest`, `hamropay.verifyWebhook`, `getpay.status/statement/checkoutPage/paymentPage/returnPage`, `nps.getInstruments/getServiceCharge/notificationResponse`. Errors throw `PaymentError` with `provider`, `code`, `httpStatus`, `details`.

## Traps that break most integrations

- eSewa: the example signatures in eSewa's own docs are **wrong** (use the vectors in `esewa.md`); `uat.esewa.com.np` is dead (use `rc.esewa.com.np`); eSewa's legacy mobile SDKs are deprecated in favour of Intent; signing `110` but posting `110.0` → ES104.
- Khalti: the endpoint without its trailing slash → 301 → POST body lost; amounts are paisa; lookup returns **HTTP 400** with a valid body for Expired/User canceled; new merchants are capped at NPR 200 until KYC; `a.khalti.com` was superseded by `dev.khalti.com`.
- Fonepay: `DT` is `MM/DD/YYYY` in **Nepal time**; txnVerification's `auth` HMAC covers the exact JSON bytes.
- connectIPS: `TXNDATE` is `DD-MM-YYYY`; amounts are paisa; `referenceId` in validatetxn is your **TXNID**; redirect URLs must be registered with NCHL.
- CyberSource: SA secret = raw bytes, REST secret = base64-decoded; Secure Acceptance is past its announced 2026-09-30 migration target (end-of-life dates are set per merchant), so new builds use Unified Checkout + JWT through the official SDK.
- NPS: the gateway form must be `multipart/form-data`; a failed payment comes back with `code:"0"`, so read `data.Status`.
- NEPALPAY QR: there's no redirect, so persist `validationTraceId` and poll the report; one QR can show a failed row and then a paid row; `transactionAmount` needs two decimals (`"10.50"`).
- Hamro Pay: send `Connection: close` (the API kills keep-alive sockets); amounts go out in paisa and come back in rupees; the live gateway host comes from Hamro Pay.
- GetPay: `merchant-status` answers for any transaction id, so check the token's `oprSecret` and that `clientId` is your order; the token can arrive in the URL `#hash`, so the return URL must be a browser page.

## Files (read only what the task needs)

- [references/architecture.md](references/architecture.md): data model, state machine, return handler, webhooks and notifications for every provider (§5), reconciliation, security checklist. **Read before writing any handler or schema.**
- Read the provider file for each provider you integrate, before writing its code: [esewa](references/esewa.md), [khalti](references/khalti.md), [fonepay](references/fonepay.md), [connectips](references/connectips.md), [cybersource](references/cybersource.md), [nps](references/nps.md), [imepay](references/imepay.md), [nepalpay](references/nepalpay.md), [hamropay](references/hamropay.md), [getpay](references/getpay.md), [others](references/others.md) (HBL, Moru, Prabhu Pay, CellPay, Namaste Pay). Each has endpoints, credentials, fields, signatures + test vectors, status mapping, SDKs and gotchas.
- [references/web.md](references/web.md): read when wiring routes in Express, Hono/Workers, Next.js, FastAPI, Django, Laravel, Spring Boot or Ktor (includes CSRF exemptions).
- [references/mobile.md](references/mobile.md): read for Flutter, React Native/Expo, Android or iOS (native SDKs, the universal WebView pattern, deep links).
- [references/env.md](references/env.md): read when adding env vars or `.env.example`.
- [references/testing.md](references/testing.md): read when testing or going live (sandbox credentials, test plan, and the go-live checklist in §5, which covers every provider).
- `scripts/ts/`: adapters (`src/`), offline tests (`npm test`), live sandbox check (`node test/sandbox.ts`), runnable demo with every provider wired (`node examples/server.ts`).
- `scripts/python/`: adapters (`nepal_payments/`) + tests (`python -m unittest discover -s tests`).
- `scripts/java/`, `scripts/kotlin/`: `./gradlew test`, live check `./gradlew sandbox`.
- `scripts/php/` (PHP 8.1–8.5): `composer install && vendor/bin/phpunit`, live check `php tests/sandbox.php`.
- `scripts/go/`: `go test -race ./...`, live check `go run ./cmd/sandbox`.

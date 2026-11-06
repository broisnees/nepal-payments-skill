# Testing and go-live

## Contents
1. Sandbox credentials (all providers)
2. Running the bundled tests
3. What to test in your integration
4. Local development (return URLs)
5. Go-live checklist per provider

## 1. Sandbox credentials

| Provider | Merchant credentials | Payer test login |
|---|---|---|
| eSewa ePay | `EPAYTEST` / `8gBm/:&EnhH.1/q` | `9806800001`–`9806800005`, password `Nepal@123`, token/OTP `123456`, MPIN `1122` (app) |
| eSewa Intent | `INTENT` / access key `LB0REg8HUSw3MTYrI1s6JTE8Kyc6JyAqJiA3MQ==` | same; demo apps at gitlab.com/esewa-pub/esewa-intent-payment-app |
| Khalti | secret key from https://test-admin.khalti.com (signup OTP `987654`) | Khalti ID `9800000000`–`9800000005`, MPIN `1111`, OTP `987654` (wallet only; no e-banking or cards in sandbox) |
| Fonepay | dev sample `NBQM` / `a7e3512f5032480a83137793cb2021dc` (redirect only; txnVerification needs your own panel login) | scan with a Fonepay-enabled test bank app (from your bank) |
| connectIPS | request from connectIPS technical support (via your bank) | provided with the test account |
| CyberSource | Business Center test account (from your bank) | Visa `4111111111111111`, MC `5555555555554444`, any future expiry; 3DS cards in `cybersource.md` §6 |
| NPS | from NPS onboarding | provided by NPS |
| IME Pay | from IME / Khalti-by-IME merchant team | provided by IME |
| NEPALPAY QR | UAT NPI user, `NPI.pfx` and merchant ids from your bank or businesssupport@nchl.com.np | scan with a NEPALPAY QR enabled UAT bank app (from your bank) |

The eSewa sandbox login has a reCAPTCHA, so completing a payment is manual (browser), but the form POST, status API and Intent book/status/cancel can be automated.

## 2. Running the bundled tests

```bash
# TypeScript (Node >= 22.18 runs .ts directly)
cd scripts/ts && npm install && npm test        # 58 offline tests: vectors, mocked HTTP, state machine
npm run typecheck                               # strict tsc
node test/sandbox.ts                            # live: eSewa (form, status, Intent) + Fonepay dev redirect
KHALTI_SECRET_KEY=... node test/sandbox.ts      # + Khalti initiate/lookup

# Python (stdlib; connectIPS tests need `pip install cryptography`)
cd scripts/python && python -m unittest discover -s tests -v   # 42 tests

# Java / Kotlin (JDK 17+; the Gradle wrapper downloads Gradle on first run)
cd scripts/java && ./gradlew test               # offline tests
./gradlew sandbox                               # live eSewa + Fonepay checks
cd scripts/kotlin && ./gradlew test && ./gradlew sandbox

# PHP (8.1+; no local PHP? run each command in Docker:
#   docker run --rm -v "$PWD":/app -w /app composer:2 <command>)
cd scripts/php && composer install && vendor/bin/phpunit
php tests/sandbox.php                           # live eSewa + Fonepay checks

# Go (1.22+, stdlib only)
cd scripts/go && go test -race ./...
go run ./cmd/sandbox                            # live eSewa + Fonepay checks

# End-to-end demo (eSewa + Fonepay sandboxes, no setup)
cd scripts/ts && node examples/server.ts        # http://localhost:3000
```
Every language suite runs the same signature vectors and mocked-provider cases as the TypeScript one, so a behaviour change has to land in all of them.

## 3. What to test in your integration

Automate these with mocked provider responses (see `scripts/ts/test/adapters.test.ts` for the mocking pattern):
- [ ] **Signature vectors** for each provider you use (from the provider reference) pass in your language.
- [ ] Return URL with a **forged success payload** (valid shape, attacker-chosen status) does not fulfil: the status API decides.
- [ ] Return URL hit **before** the payer reaches the provider (`not_found`) leaves the attempt open, and a later real payment is still picked up.
- [ ] A provider **"paid" arriving after the attempt was closed** (`expired`/`failed`) is recovered and alerted, not dropped.
- [ ] A callback with its **signature removed** (Fonepay without `DV`, eSewa without `signature`) can't force a failure or a success.
- [ ] A **"paid" with no amount** from the provider goes to manual review, not fulfilment.
- [ ] Paying an **already-paid order** again raises a duplicate-payment alert (refund it).
- [ ] **Amount mismatch** (provider says Rs 10 for a Rs 1,000 order) → alert, no fulfilment.
- [ ] **Callback for another attempt** (swapped `transaction_uuid` / `pidx` / `PRN`) is rejected.
- [ ] **Concurrent** return + webhook + reconciliation for the same attempt → exactly one fulfilment.
- [ ] Provider **timeout / 5xx** during verify → attempt stays open, user sees "confirming", reconciliation settles it.
- [ ] **Refresh** of the return URL after success → no double fulfilment.
- [ ] Khalti lookup **HTTP 400 with `Expired`** maps to expired, not an exception.
- [ ] **Retry** after failure creates a **new** attempt id.

Manual sandbox runs per provider: one success, one cancel at the provider page, one abandoned session (close the tab, then confirm reconciliation expires it).

## 4. Local development (return URLs)

Providers redirect the payer's browser, so `http://localhost` return URLs work for browser-only flows (eSewa, Khalti, Fonepay redirect). Server-to-server notifications (NPS notification URL, CyberSource Merchant POST, eSewa Intent `callback_url`) and phones on a different device need a public HTTPS URL:
```bash
cloudflared tunnel --url http://localhost:3000     # or: ngrok http 3000
PUBLIC_URL=https://<tunnel-host> node examples/server.ts
```
connectIPS and CyberSource profiles have **registered** URLs. Register the tunnel URL in the UAT/test profile.

## 5. Go-live checklist per provider

Common items: the architecture checklist (`architecture.md` §10), live keys in the secret store, `*_ENV=production`, one real low-value payment per provider verified end to end and then refunded, reconciliation job and alerts running.

| Provider | Extra go-live steps |
|---|---|
| eSewa | Live product code + secret key from eSewa merchant onboarding. Intent: production host + access key from eSewa (`ESEWA_INTENT_BASE_URL`). |
| Khalti | Complete KYC + contract, otherwise live payments are capped at **NPR 200**. Live keys from admin.khalti.com. |
| Fonepay | Live PID + secret + panel login via the acquiring bank. Confirm the live txnVerification host with Fonepay. |
| connectIPS | NCHL activation via your bank; live `.pfx`; **register live success/failure URLs** with NCHL. |
| CyberSource | Live SA profile keys (2-year expiry: put renewal in the calendar); Merchant POST URL configured; 3DS enabled; NPR enabled per card type. Agree an SA → Unified Checkout migration date with the bank. |
| NPS | Live API host and credentials from the onboarding PDF; Notification URL registered. |
| IME Pay | Server IP whitelisted for port 7979; confirm web checkout is still offered post-merger. |
| NEPALPAY QR | Live NPI user, `.pfx` and merchant enrollment from the bank; `merchantName` exactly as enrolled; confirm-payment URL registered with NCHL if you use it. |

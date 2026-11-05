# Production architecture (all providers)

The provider-specific files cover the wire format. This file covers what makes an integration survive real traffic: duplicate callbacks, users closing the tab mid-payment, flaky provider APIs, and people tampering with redirect URLs.

## Contents
1. Non-negotiable rules
2. Data model
3. The flow
4. Return-URL / callback handler
5. Webhooks and server notifications
6. Reconciliation job
7. Refunds
8. Security checklist
9. Observability
10. Go-live checklist

---

## 1. Non-negotiable rules

1. **Secrets never leave the server.** Signing (eSewa, Fonepay, connectIPS, CyberSource, NPS) and API keys (Khalti, IME Pay) live in backend env vars or a secret manager, never in a web bundle, mobile app, or git repo. Mobile and web clients ask *your* backend to start a payment.
2. **The redirect is not proof of payment.** Query params on `success_url` / `return_url`, and "success" callbacks from mobile SDKs, can be forged, replayed, or arrive for a payment that later reverses. Fulfil only after a **server-to-server status check** (eSewa status API, Khalti lookup, Fonepay verification, connectIPS validatetxn, NPS CheckTransactionStatus, IME Pay Confirm/Recheck) or, for CyberSource, a **verified HMAC signature** on the response.
3. **Check amount and order id, not only status.** Compare the provider-reported amount to what *you* stored for that order. A valid "COMPLETE" for a Rs 10 order must not unlock a Rs 10,000 one.
4. **One order id per payment attempt.** Providers reject or misreport reused ids (`transaction_uuid`, `purchase_order_id`, `PRN`, `TXNID`, `MerchantTxnId`, `reference_number`). Use a fresh id each time the user clicks Pay, linked to your order.
5. **Fulfil exactly once.** Return-URL hits, webhooks, and the reconciliation job can all arrive for the same attempt, sometimes at the same moment. Use a conditional state transition (below) so only one wins.
6. **Money is integer paisa in your system.** Convert to the provider's format (rupee string, paisa integer, decimal string) at the adapter edge only. Floats will eventually produce `109.99999999` and a signature mismatch.
7. **Keep sandbox and live completely separate**: separate env vars, base URLs and keys. A sandbox key against a live URL usually returns 401 or `NOT_FOUND`, which looks like a lost payment.

## 2. Data model

Minimal Postgres schema; adapt types for MySQL/SQLite. One `orders` row per thing being bought, many `payment_attempts` per order.

```sql
CREATE TYPE payment_status AS ENUM (
  'initiated', 'pending', 'paid', 'failed', 'canceled', 'expired',
  'refunded', 'partially_refunded', 'not_found', 'unknown'
);

CREATE TABLE payment_attempts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id         uuid NOT NULL REFERENCES orders(id),
  provider         text NOT NULL,                 -- 'esewa' | 'khalti' | ...
  provider_order_id text NOT NULL,                -- the id YOU sent (transaction_uuid / purchase_order_id / PRN / TXNID)
  provider_ref     text,                          -- session id from initiate() that verify() needs (Khalti pidx, NPS ProcessId, IME TokenId)
  provider_txn_id  text,                          -- final transaction id from verify() (eSewa ref_id, Khalti transaction_id, ...)
  amount_paisa     bigint NOT NULL CHECK (amount_paisa > 0),
  currency         char(3) NOT NULL DEFAULT 'NPR',
  status           payment_status NOT NULL DEFAULT 'initiated',
  review_required  boolean NOT NULL DEFAULT false, -- amount mismatch / no amount / unsettled at cutoff: human decides
  raw_initiate     jsonb,
  raw_verify       jsonb,
  verified_at      timestamptz,
  expires_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_order_id)
);

CREATE INDEX payment_attempts_reconcile_idx
  ON payment_attempts (status, created_at)
  WHERE status IN ('initiated', 'pending', 'unknown') AND NOT review_required;
```

State machine (anything else is a bug):

```
initiated ──► pending ──► paid ──► refunded | partially_refunded      (refunds: from your refund flow, §7)
    │            │          ▲
    │            │          └── late payment: provider says paid after we closed the attempt → recover + alert
    └────────────┴──► failed | canceled | expired
                      (not_found → nothing is written until the session window ends → expired)
```

- `not_found` is **never stored** while the attempt is younger than the provider's session window (~60 min): treat it as "not paid yet" and keep the row open. After the window, store `expired`.
- A provider **"paid" always wins over an earlier `failed`/`canceled`/`expired`** (late payment, reconcile race, user replaying an old payment page): move to `paid`, fulfil, and alert so someone looks at why it closed early.
- `paid` is terminal for automation. Never move it back to `pending` or `failed` because a later check returned something odd; alert a human instead.
- A "paid" with an amount that differs from yours, **or with no amount at all**, goes to `unknown` with `review_required = true`. Never fulfil it automatically.

`decideTransition()` in `scripts/ts/src/core.ts` (`decide_transition()` in Python) implements exactly these rules and is unit-tested. Use it rather than re-deriving them.

## 3. The flow

```
Client (web/mobile)           Your backend                         Provider
      │  POST /payments {orderId, provider}
      │──────────────────────────►│ load order, compute amount server-side
      │                           │ insert payment_attempt (initiated)
      │                           │ adapter.initiate()  ───────────────►│ (Khalti/NPS/IME: API call)
      │◄──────────────────────────│ {redirect url} or {form fields}     │
      │  user pays on provider page / SDK ─────────────────────────────►│
      │◄──────────────── redirect to return URL (GET/POST) ─────────────│
      │──────────────────────────►│ adapter.verify()  ─────────────────►│ status API
      │                           │◄────────────────────────────────────│
      │                           │ conditional UPDATE → fulfil once
      │◄──────────────────────────│ show receipt / deep link back to app
                                  │◄── webhook / server POST (optional) │
                                  │ adapter.verify() again (idempotent)
                     cron ───────►│ reconcile stale attempts
```

The amount always comes from **your database**, never from the client request.

## 4. Return-URL / callback handler

Every provider handler has the same shape. TypeScript with any SQL client:

```ts
import { decideTransition } from "./payments/index.ts"; // pure, unit-tested state machine (core.ts)

const SESSION_WINDOW_MS = 60 * 60_000; // longest provider session (Khalti pidx ~60 min, eSewa ~50 min)

// /payments/:provider/return[/:attemptId]  (eSewa/Khalti/Fonepay/connectIPS/NPS: GET; CyberSource/IME Pay: POST)
export async function handleReturn(provider: ProviderId, params: Record<string, string>, pathAttemptId?: string) {
  // 1. Find YOUR attempt: from the callback, else from the URL path (eSewa failure redirects carry no data).
  const providerOrderId = adapters[provider].orderIdFromCallback(params) ?? pathAttemptId;
  const attempt = providerOrderId && await db.oneOrNone(
    "SELECT * FROM payment_attempts WHERE provider = $1 AND provider_order_id = $2",
    [provider, providerOrderId],
  );
  if (!attempt) return { http: 404 };
  if (attempt.review_required) return { http: 302, location: `/orders/${attempt.order_id}` };

  // 2. Ask the provider, server-to-server, with the values WE stored.
  const result = await adapters[provider].verify({
    orderId: attempt.provider_order_id,
    amountPaisa: Number(attempt.amount_paisa),
    providerRef: attempt.provider_ref, // from YOUR db, never from the callback
    callback: params,
  });

  // 3. Decide. decideTransition() encodes every rule:
  //    - only open attempts move; a provider "paid" after we closed it (failed/canceled/expired) is a LATE PAYMENT
  //      and is recovered instead of silently dropped
  //    - "paid" must carry an amount equal to ours, else -> unknown + review_required (never auto-fulfil)
  //    - not_found inside the session window -> write nothing (anyone can hit a return URL early); after it -> expired
  const d = decideTransition(attempt.status, result, Number(attempt.amount_paisa),
                             Date.now() - attempt.created_at.getTime(), SESSION_WINDOW_MS);
  if (!d.next) return { http: 302, location: `/orders/${attempt.order_id}` };
  if (d.reviewRequired || d.latePaid) await alert(d.reason, { attempt, result });

  // 4. Conditional transition guarded by the status we read: only one concurrent caller wins.
  const updated = await db.oneOrNone(
    `UPDATE payment_attempts
        SET status = $1, review_required = review_required OR $2,
            provider_txn_id = COALESCE($3, provider_txn_id), raw_verify = $4, verified_at = now(), updated_at = now()
      WHERE id = $5 AND status = $6
      RETURNING *`,
    [d.next, d.reviewRequired, result.transactionId, JSON.stringify(result.raw), attempt.id, attempt.status],
  );
  // updated === null → someone else changed it first; their write stands (re-run the handler if you need the latest).

  // 5. Fulfil only if THIS call made the transition to paid.
  if (updated?.status === "paid") await fulfilOrder(attempt.order_id, attempt.id); // idempotent; alerts on double payment

  return { http: 302, location: `/orders/${attempt.order_id}` };
}
```

Notes:
- Guarding the UPDATE with `status = <the status you read>` (optimistic concurrency) makes every rule above race-safe, including late-paid recovery: if the reconciler commits `expired` while a return handler holds a "paid" result, the handler's UPDATE misses and the next run (refresh, webhook, reconciler) sees `expired` + "paid" and recovers it.
- Make `fulfilOrder` idempotent too: `UPDATE orders SET status='paid', paid_by_attempt=$2 WHERE id=$1 AND status <> 'paid'`. Send emails and grant access only if that update touched a row. If the order was already paid by a **different** attempt, the customer paid twice: alert and refund that attempt.
- Refuse `POST /payments` for orders that are already paid, and refuse `/start` for attempts that are closed or past the session window. Never replay an old signed form; create a new attempt.
- When `verify` throws (network, 5xx), leave the attempt as it is and show "We're confirming your payment". The reconciliation job will settle it. Never mark it failed on a timeout.
- Respond quickly. Users refresh return pages, so the handler must be safe to run many times.
- For mobile, end the handler by redirecting to an app deep link (`myapp://payment/result?order=...`) or a page the WebView watches for. See `mobile.md`.

## 5. Webhooks and server notifications

| Provider | Server-to-server notification |
|---|---|
| eSewa | ePay v2: no webhook; status API from the return URL + reconciliation. Intent: signed JSON POST to `callback_url` (verify signature, then Intent status API). |
| Khalti | No webhook in KPG-2 checkout. Lookup from return URL + reconciliation. |
| Fonepay | Web PG: none; verify after redirect. Dynamic QR: websocket push / status poll. |
| connectIPS | No webhook; validatetxn after redirect + reconciliation. |
| CyberSource | Merchant POST URL (configured in the Secure Acceptance profile) gets a signed POST for every decision. Most reliable signal. |
| NPS | Notification URL receives an unsigned GET with `MerchantTxnId` + `GatewayTxnId`. Verify, then reply `received` (or `already received`) **only once a final status is recorded**; while it's still pending, return a non-2xx so NPS keeps notifying. |
| IME Pay | No webhook; Confirm/Recheck. |

Treat every webhook as a hint, never as the truth: verify the signature if there is one, then call `verify()` and run the same conditional update as the return handler.

## 6. Reconciliation job

Users close tabs, mobile apps get killed, return URLs time out. Without this job, some customers pay and never get their order. Run every 1–5 minutes:

```sql
SELECT * FROM payment_attempts
 WHERE status IN ('initiated', 'pending', 'unknown')
   AND NOT review_required
   AND created_at < now() - interval '2 minutes'
 ORDER BY created_at
 LIMIT 100
 FOR UPDATE SKIP LOCKED;
```
Hold the row locks only while you pick rows (or use a short `claimed_until` lease column). Call providers **outside** the transaction, then apply results with the guarded UPDATE from §4.

For each row, call `verify()` with bounded concurrency (5–10) and run the same transition as section 4. Rules:
- `not_found` within the provider's session window (for example Khalti's pidx expiry, about 60 min) means the user never paid yet, so leave it. After the window, mark it `expired`.
- `pending` / eSewa `AMBIGUOUS` / NPS `Pending` / IME Pay non-zero codes: keep checking with backoff. At the cutoff (e.g. 3 days) set `review_required = true` and alert. Don't just stop polling silently; these can still settle.
- Alert on any `unknown` status, because the provider added a value you don't map.
- Daily: download the provider's settlement report from the merchant dashboard and compare its totals against `paid` rows.

## 7. Refunds

Refund APIs vary (Khalti has a merchant refund API; CyberSource refunds through the REST API; eSewa, Fonepay and connectIPS refunds usually go through the merchant portal or a support request). Model refunds as their own rows (`refunds` table with amount, status, provider ref) and update the attempt to `refunded` / `partially_refunded` only after the provider confirms.

## 8. Security checklist

- [ ] Secrets in env / secret manager; never committed; separate sandbox and live keys; rotation documented.
- [ ] Amount computed server-side from the order; the client only sends `orderId` + `provider`.
- [ ] Server-side status check (or signature verification for CyberSource) before fulfilment.
- [ ] Amount + order id + status compared against stored values.
- [ ] Unique provider order id per attempt, enforced by `UNIQUE(provider, provider_order_id)`.
- [ ] Conditional `UPDATE ... WHERE status IN (...)` for state transitions; idempotent fulfilment.
- [ ] Constant-time signature comparison (`safeEqual`).
- [ ] Return / callback URLs are HTTPS, fixed on the server, and not built from client input (open-redirect risk).
- [ ] Callback endpoints rate-limited; log and drop invalid signatures.
- [ ] No secrets or full card data in logs. Log ids and statuses; mask phone numbers and emails.
- [ ] Card payments use hosted pages (CyberSource Secure Acceptance / Unified Checkout) so card data never touches your servers (PCI SAQ A scope).
- [ ] `fetch` timeouts on every provider call (the adapters default to 15 s).

## 9. Observability

Log a structured line at each step: `payment.initiate`, `payment.return`, `payment.verify`, `payment.transition`, `payment.reconcile`, carrying `attempt_id`, `provider`, `provider_order_id`, `status`, `latency_ms`. Alert on:
- verify error rate > 5% over 10 min (provider outage or key problem)
- any amount mismatch or invalid signature
- attempts stuck in `pending`/`unknown` for more than 1 h
- `paid` attempts whose order is not fulfilled after 5 min

## 10. Go-live checklist

- [ ] Live credentials from the provider (eSewa/Khalti merchant onboarding, the bank for Fonepay/CyberSource, NCHL via the bank for connectIPS).
- [ ] Live base URLs set through config, not code edits.
- [ ] Return URLs registered or allowlisted with the provider where required (Fonepay RU, CyberSource profile URLs, connectIPS success/failure URLs, IME Pay).
- [ ] One real low-value live payment per provider, verified end to end, then refunded.
- [ ] Reconciliation job running and alerting.
- [ ] Customer support runbook: how to look up an attempt by provider ref, and how to issue a refund.

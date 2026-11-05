# paynp spec v2: merchant operations

v1 (`SPEC.md`) watches payments. v2 helps a merchant run them: duplicate payments and refunds, "I already paid"
support, paid-but-not-fulfilled detection, settlement reconciliation, a go-live doctor, a public gateway status page
and accounting exports. Everything below is additive: no v1 shape changes, no renames.

**Principles**
- paynp never holds gateway secret keys. Anything that must act on a gateway (refund, re-check) is a signed request
  from paynp to the merchant's own server (section 3), which acts with its own keys and reports the result.
- Customer phone numbers and emails are stored only as a per-project salted hash plus a masked display form.
- Facts about gateways come from `skills/nepal-payments/references/*.md`. Where a format is unknown (merchant
  statement CSVs, Tally/Hamrokhata import layouts), build a configurable mapping and label presets "unverified".

## 1. Event schema additions (shared/src/events.ts)

New event types (append to `EVENT_TYPES`):
- `payment.annotated`: attaches order/customer data to an attempt, no status change.
- `payment.refunded`: a refund happened (full or partial). `amount_paisa` = refunded amount. Sets status `refunded`
  when the cumulative refunded amount reaches the payment amount.

New top-level optional field on every event:
```ts
customer?: { phone?: string; email?: string; name?: string } // raw from the SDK; the server hashes phone/email, keeps name (<= 80 chars)
```
New `EventData` keys (allowlisted, typed):
- `gw_env?: "sandbox" | "production"` (SDK sets it from the gateway host it saw: rc-epay/rc.esewa, dev.khalti,
  dev-clientapi/dev fonepay hosts, uat connectIPS, testsecureacceptance, apisandbox NPS, IME test port = sandbox)
- `return_https?: boolean` (SDK sets it on payment.started from the startPayment returnUrl)
- `refund_ref?: string`, `refund_reason?: string` (payment.refunded)
- `action_id?: string` (events emitted while handling a paynp action, section 3)

Phone normalisation (server): strip spaces/dashes, drop leading `+977`/`977`/`0`; keep digits; must be 10 digits
starting 9 for Nepali mobiles, else stored as-is digits. Hash = hex SHA-256(`project_salt + ":" + normalised`).
Mask: `98XXXXX123` style (first 2, last 3). Email: lowercase, hash the same way, mask `n***@gmail.com`.

## 2. Data model additions (worker/migrations/0002_ops.sql, owned by the ops-backend builder)

```sql
ALTER TABLE projects ADD COLUMN salt TEXT;                 -- random per project, created lazily
ALTER TABLE payments ADD COLUMN customer_hash TEXT;        -- phone hash (or email hash if no phone)
ALTER TABLE payments ADD COLUMN customer_mask TEXT;
ALTER TABLE payments ADD COLUMN customer_name TEXT;
ALTER TABLE payments ADD COLUMN refunded_paisa INTEGER NOT NULL DEFAULT 0;
ALTER TABLE payments ADD COLUMN gw_env TEXT;               -- last seen
ALTER TABLE payments ADD COLUMN fulfilled_at INTEGER;
CREATE INDEX payments_by_customer ON payments (project_id, env, customer_hash, started_at DESC);
CREATE INDEX payments_by_amount ON payments (project_id, env, amount_paisa, started_at DESC);

-- Every reference that identifies a payment: attempt id, order id, provider_ref values seen (pidx, transaction_id,
-- ref_id, PRN, TokenId, GatewayReferenceNo, ...), refund refs.
CREATE TABLE payment_refs (project_id TEXT NOT NULL, env TEXT NOT NULL, ref TEXT NOT NULL, attempt_id TEXT NOT NULL,
  kind TEXT NOT NULL, PRIMARY KEY (project_id, env, ref, attempt_id));

-- Duplicate-payment and refund work items.
CREATE TABLE refund_cases (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, env TEXT NOT NULL,
  kind TEXT NOT NULL,             -- duplicate | manual | customer_request
  status TEXT NOT NULL,           -- open | requested | refunded | dismissed | failed
  attempt_id TEXT NOT NULL,       -- the payment to refund
  related_attempt_id TEXT,        -- the payment it duplicates (kept)
  gateway TEXT NOT NULL, amount_paisa INTEGER NOT NULL,
  reason TEXT, checklist TEXT,    -- JSON: [{step, done_at, by}]
  refund_ref TEXT, action_id TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, resolved_at INTEGER, resolved_by TEXT, note TEXT
);
CREATE INDEX refund_cases_by_status ON refund_cases (project_id, env, status, created_at DESC);

-- Signed actions paynp sends to the merchant's server.
CREATE TABLE action_endpoints (project_id TEXT NOT NULL, env TEXT NOT NULL, url TEXT NOT NULL, secret TEXT NOT NULL,
  created_at INTEGER NOT NULL, last_ok_at INTEGER, last_error TEXT, PRIMARY KEY (project_id, env));
CREATE TABLE actions (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, env TEXT NOT NULL, kind TEXT NOT NULL,
  attempt_id TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL, -- pending | ok | failed
  response TEXT, created_at INTEGER NOT NULL, finished_at INTEGER, requested_by TEXT);

-- Customer-facing status links.
CREATE TABLE status_links (token_hash TEXT PRIMARY KEY, project_id TEXT NOT NULL, env TEXT NOT NULL,
  attempt_id TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, created_by TEXT);

-- Go-live doctor findings (server side, from live traffic).
CREATE TABLE doctor_findings (project_id TEXT NOT NULL, env TEXT NOT NULL, code TEXT NOT NULL, severity TEXT NOT NULL,
  gateway TEXT, first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL, count INTEGER NOT NULL, example_attempt TEXT,
  resolved_at INTEGER, PRIMARY KEY (project_id, env, code, gateway));
```
Migration `0003_finance.sql` (owned by the finance builder):
```sql
CREATE TABLE statements (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, env TEXT NOT NULL, gateway TEXT NOT NULL,
  filename TEXT NOT NULL, period_from INTEGER, period_to INTEGER, row_count INTEGER NOT NULL, mapping TEXT NOT NULL,
  uploaded_at INTEGER NOT NULL, uploaded_by TEXT);
CREATE TABLE statement_rows (statement_id TEXT NOT NULL, row INTEGER NOT NULL, txn_at INTEGER, ref TEXT, amount_paisa INTEGER,
  fee_paisa INTEGER, net_paisa INTEGER, status TEXT, settled_at INTEGER, raw TEXT NOT NULL,
  match_attempt_id TEXT, match_kind TEXT,          -- ref | amount_time | none
  PRIMARY KEY (statement_id, row));
CREATE TABLE statement_mappings (project_id TEXT NOT NULL, gateway TEXT NOT NULL, mapping TEXT NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, gateway));
CREATE TABLE gateway_fees (project_id TEXT NOT NULL, gateway TEXT NOT NULL, pct_bp INTEGER NOT NULL, fixed_paisa INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project_id, gateway));               -- merchant-entered MDR for estimates when no statement exists
CREATE TABLE status_minutes (gateway TEXT NOT NULL, minute INTEGER NOT NULL, projects INTEGER NOT NULL, requests INTEGER NOT NULL,
  errors INTEGER NOT NULL, ms_total INTEGER NOT NULL, ms_p95 INTEGER, PRIMARY KEY (gateway, minute)); -- live env only, cross-project
```

## 3. Signed actions (refunds and re-checks on the merchant's server)

The merchant registers an action endpoint per project+env (`PUT /api/projects/:p/action-endpoint {env, url}` returns
the secret once; `POST .../action-endpoint/test`). paynp POSTs JSON to it:
```
POST <url>
X-Paynp-Signature: sha256=<hex HMAC-SHA256(secret, timestamp + "." + body)>
X-Paynp-Timestamp: <unix seconds>
{ "id": "act_...", "kind": "refund" | "recheck", "attempt_id", "gateway", "order_id", "amount_paisa",
  "provider_ref", "refund": { "amount_paisa", "reason" } }
```
The merchant answers `200 {"ok": true, "refund_ref"?: "...", "status"?: "<PaymentStatus>"}` or
`200 {"ok": false, "error": "..."}`. Timeout 20 s. paynp records the action, updates the refund case
(`requested` -> `refunded`/`failed`) and emits nothing itself; the merchant's SDK emits `payment.refunded`.
Replay protection: the SDK rejects timestamps older than 5 minutes and remembers action ids it handled (in-memory LRU).

SDK (`@paynp/sdk`): `paynp.actionHandler({ refund?, recheck? })` returns a `(request: Request) => Promise<Response>`
(Fetch API: Hono, Next.js route handlers, Workers) plus `paynp.nodeActionHandler(...)` for Express/Fastify
`(req, res)`. It verifies the signature with `PAYNP_ACTION_SECRET`, dispatches, wraps the merchant callback, emits
`payment.refunded` on success, and returns the JSON above. Docs include a working Khalti refund callback built from
references/khalti.md section on refunds (POST `https://{dev.}khalti.com/api/merchant-transaction/{transaction_id}/refund/`,
`Authorization: Key ...`, optional `amount` for partial, success `{"detail": "Transaction refund successful."}`) and
say which gateways have no refund API (eSewa ePay v2, Fonepay, connectIPS, NPS, IME Pay: manual checklist instead).
`paynp.annotate({attemptId, gateway, orderId?, customer?})` and `paynp.refunded({attemptId, gateway, amountPaisa, refundRef?, reason?})`
are new SDK methods; `wrapGateway`/`wrapAdapter` accept an optional `customer` getter in WrapOptions:
`customer?: (input) => {phone?, email?, name?} | undefined` applied on startPayment.

## 4. Features and their API (all under /api/projects/:p, JSON, env query param, cursor pagination as v1)

### 4.1 Double payments and the refund queue (ops builder)
Detection on ingest, when a payment transitions to `paid`: another `paid` payment in the same project+env with
(a) the same `order_id` (any time), or (b) the same `customer_hash` and same `amount_paisa` with `started_at` within
30 minutes. The later-paid one becomes `refund_cases(kind=duplicate, status=open)` with `related_attempt_id` = the
earlier. New alert rule type `double_payment` (`{}` params, on ingest, batched like payment_failed). The checklist per
gateway: Khalti (api: "Send refund via your server" button when an action endpoint exists, else manual steps:
merchant dashboard, transaction, refund), eSewa (merchant portal Refund against the transaction or merchant support
with the transaction id; confirm via status API showing FULL_REFUND/PARTIAL_REFUND), Fonepay/connectIPS/NPS/IME
(merchant support with the reference; record the refund reference). Steps are short, factual, from the references.
- `GET /refunds?status=&kind=` list (joined with payment summary of both attempts)
- `POST /refunds {attempt_id, amount_paisa?, reason}` manual case
- `PATCH /refunds/:id {status?, checklist_step_done?, refund_ref?, note?}`
- `POST /refunds/:id/send` (admin) fires a `refund` action; 409 if no action endpoint
- Refund cases auto-resolve to `refunded` when a `payment.refunded` event or a status `refunded` arrives for the attempt.

### 4.2 "I already paid" lookup + status links (ops builder)
- `GET /lookup?q=&amount=&from=&to=` where q may be a phone (normalised and hashed), email, any ref in payment_refs,
  attempt id or order id; amount in rupees or paisa (`amount=1500` means Rs 1,500; `amount_paisa=` exact). Returns up
  to 50 payments with a verdict per payment: `paid` ("Paid at 12:59, eSewa ref 0LD5CEH"), `paid_duplicate`,
  `pending` ("Started but not finished, buyer never came back"), `failed`/`canceled` with the explain title,
  `refunded`, plus `fulfilled: boolean`. One line of human text per verdict, computed server side.
- `POST /payments/:attempt/status-link {expires_days: 7}` returns `{url}`: `https://<app>/s/<token>` (token 32 bytes,
  stored hashed). Public page `GET /s/:token` is server-rendered HTML (no SPA), no PII beyond masked phone: merchant
  project name, amount, gateway, status in words, time, reference, "contact the merchant" if not paid. 404 when
  expired.

### 4.3 Paid but not fulfilled (ops builder)
Rule type `paid_not_fulfilled` `{after_min: 15}`: cron finds payments `paid`, `fulfil_count = 0`, `finished_at` older
than N minutes and younger than 24 h, in projects that sent at least one `payment.fulfilled` in the last 30 days
(otherwise the project doesn't report fulfilment and the rule stays quiet; the dashboard explains this). One incident
per payment, batched per minute like payment_failed. Auto-resolves when `payment.fulfilled` arrives.

### 4.4 Go-live doctor (ops builder for server checks; sdk/cli builder for `paynp doctor`)
Server-side findings, computed on ingest for env=live (and test where noted), upserted into doctor_findings:
- `sandbox_gateway_in_live` (critical): live event with `gw_env = sandbox`.
- `http_return_url` (critical, live): payment.started with `return_https = false`.
- `amount_looks_like_rupees` (warning, live): khalti payments with amount_paisa < 1000 (Khalti minimum Rs 10), or
  any gateway where >= 3 of the last 10 live payments are < 100 paisa while the project's 30-day median is > 10000.
- `signature_failures` (critical): >= 3 signature.checked valid=false in 10 minutes.
- `no_status_check_after_return` (critical): callback.received not followed within 60 s by a gateway.request
  (op status/lookup) or reconcile for the same attempt (cron evaluates).
- `fulfil_without_paid` (critical): payment.fulfilled for a payment whose status is not paid.
- `double_fulfilment` (critical): fulfil_count >= 2 (exists as alert; also a finding).
- `no_reconcile` (warning, live): open payments older than 1 h with no reconcile.checked ever for the project in 24 h.
- `GET /doctor?env=` returns findings with title, why it matters, how to fix (reference link), severity, counts,
  example attempt, plus "passed" checks with a short line. `POST /doctor/:code/resolve`.
CLI `paynp doctor` (local, no network needed for static part): reads `.env`/`.env.*`, `wrangler.jsonc`, framework
config; flags sandbox gateway creds with a live paynp key or `*_ENV=production` mismatches, `BASE_URL`/return URLs on
http in production config, secrets referenced in client bundles (`NEXT_PUBLIC_*SECRET*`, `VITE_*SECRET*`), missing
PAYNP_ACTION_SECRET when an action route exists, gateway modules not wrapped; then, if logged in and linked, prints the
server findings from `GET /doctor`. Exit code 1 on any critical. `--json`.

### 4.5 Settlement reconciliation (finance builder)
- `POST /statements` multipart (file <= 5 MB CSV or XLSX? CSV only in v2; say so) + `gateway` + optional `mapping`.
  Header auto-detection: presets for eSewa, Khalti, Fonepay merchant exports marked `unverified: true` (built from
  common column names: date/transaction date, reference/transaction code/pidx/PRN, amount, charge/fee/commission,
  net/settled, status, settlement date). If no preset fits, 422 with the detected headers so the UI asks the user to
  map columns; saved per project+gateway.
- Amount parsing: "1,000.00", "Rs. 1,000", lakh grouping "1,00,000.50", negative refunds, paisa vs rupees flag in mapping.
- Matching: (1) exact ref against payment_refs; (2) amount + time within +-10 minutes (unique candidate only). Rows
  with refund/negative amounts match refunds.
- `GET /statements`, `GET /statements/:id` summary: matched count/amount, statement rows not in paynp, paynp paid
  payments in the period not in any statement ("missing settlement"), amount mismatches, fees total, net total,
  effective fee %, per day. `GET /statements/:id/rows?filter=unmatched|missing|mismatch`. `DELETE /statements/:id`.
- `PUT /fees {gateway, pct_bp, fixed_paisa}` merchant MDR for estimates.

### 4.6 Public gateway status page (finance builder)
- Ingest (live env only) increments `status_minutes` for each gateway.request: requests, errors (http >= 500, timeouts,
  network errors), latency. Cron keeps 90 days.
- `GET /status` (public, server-rendered HTML, fast, cacheable 60 s, SEO title "Is eSewa down? Live status of Nepali
  payment gateways"), `GET /status/:gateway` per gateway page ("Is Khalti down?"), `GET /status.json`.
  Shows per gateway: current state (operational / degraded / down / no data), last 24 h error rate and p95 latency
  sparkline, 90-day daily uptime bars, peak-hour latency (by Nepal hour of day, last 7 days), incident list (auto:
  windows where error rate > 20% or p95 > 5 s for >= 5 minutes).
- Privacy: a gateway minute is only shown when it aggregates >= 3 distinct projects; otherwise "not enough traffic".
  Never shows volumes, only rates and latency.
- Linked from the marketing site footer later (not part of this build).

### 4.7 Accounting exports (finance builder)
- `GET /exports/transactions.csv?env=&from=&to=` all payments: date (NPT), attempt, order, gateway, provider ref,
  status, amount, refunded, fee (statement fee if matched, else estimate from gateway_fees, else blank), net.
- `GET /exports/tally.csv?month=YYYY-MM` rows `Date, Voucher Type, Ledger, Debit, Credit, Narration` (receipts per
  payment to "<Gateway> Receipts", refunds as credit notes to "Sales Returns", fees to "Payment Gateway Charges").
  Labelled "Tally-style CSV; map ledgers on import" (unverified layout).
- `GET /exports/hamrokhata.csv?month=` generic sales/receipts CSV, labelled unverified with the column list.
- `GET /exports/credit-notes.csv?month=` one row per refund: credit note no. (CN-YYYYMM-####), original attempt/order,
  date, amount, reason, refund ref (for VAT).
- `GET /exports/year-summary?fy=2082-83` JSON + `.csv`: Nepal fiscal year (Shrawan 1 to Asar end; compute boundaries
  with a correct BS calendar table for 2080-2084, test it), per gateway gross, refunds, fees (actual from statements +
  estimated), net, payment count; per month too.

## 5. Dashboard (dashboard builder)
New nav items: **Refunds** (badge with open count), **Support** (lookup), **Reconcile**, **Go-live** (doctor),
**Exports**. Payment detail gains: customer (masked), refunds, "Send status link", "Mark for refund", duplicate banner
linking the other attempt. Alerts editor gains `double_payment` and `paid_not_fulfilled`. Settings gains Action
endpoint (url, reveal secret once, test). Design: same system as v1, plain language, empty states that say exactly
what to wire (e.g. "Add `customer: (i) => ({ phone })` to wrapGateway to search by phone"). Mock mode covers every
new page with realistic data. Local mode (paynp dev) hides Refunds sending, Reconcile, Exports (they need the cloud).

## 6. Done means
Tests for every rule above in the owning package; real wrangler-dev run for the worker features; screenshots for every
new dashboard page at 1440 and 390, light and dark; no em/en dashes or ellipsis characters anywhere.

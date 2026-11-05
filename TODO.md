# TODO

What's left, roughly in priority order. Items come from the Java, Kotlin, PHP and Go ports (which re-read the TypeScript source line by line) and from live sandbox runs on 2026-11-05.

## Correctness

Fixed in all six ports on 2026-11-05, with a "regressions" test block in each. One part stays open:

- [ ] **eSewa Intent callback signature format.** Every port now accepts the raw callback body and checks numbers both as sent (`amount=100.0`) and in JavaScript `String(v)` form (`amount=100`). Which one eSewa signs is still unconfirmed. Capture a real Intent callback in the sandbox, then drop the form it doesn't use.

## Docs

- [ ] Full Go wiring section in `references/web.md` (net/http, chi, Gin) with a runnable snippet.
- [ ] Runnable demo servers for Java, Kotlin, PHP and Go like `scripts/ts/examples/server.ts`.
- [ ] `references/env.md`: optional `CONNECTIPS_PFX_PATH` / `CONNECTIPS_PFX_PASSWORD` for the Java, Kotlin and PHP ports, which can read `.pfx` directly.

## Verification still owed

- [ ] Re-run the eSewa Intent sandbox checks once eSewa's Intent service is back (all ports got `Service is currently unavailable` on 2026-11-05), and capture a callback for the item above.
- [ ] Run the Khalti sandbox checks with a test key (`KHALTI_SECRET_KEY`).
- [ ] Live runs for connectIPS, CyberSource, NPS and IME Pay with merchant credentials (signing is verified offline only).
- [ ] CI: GitHub Actions is blocked by an account billing lock. Once cleared, run `gh workflow run ci.yml` and fix anything the Linux runners catch (JDK 21 and PHP 8.5 on CI were only stood in for locally by JDK 26 and the composer image).

## Distribution

- [ ] Publish the PHP package to Packagist and tag a Go module version so they can be installed without copying.
- [ ] Go: optional `.pfx` support (stdlib can't read PKCS#12; would need a third-party module).

## paynp: payment observability for Nepali gateways

A hosted dashboard where a business sees every payment from every app and every Nepali gateway, live: history, timelines, failures, latency, alerts. Same idea as trigger.dev runs or Inngest functions, built for payments. Working name **paynp** (domain candidate `paynp.dev`); the name lives in one constant per package so it can change later. Spec: [`platform/SPEC.md`](platform/SPEC.md).

### Phase 1: core (MVP)

- [x] Event schema v1 and redaction rules (no secrets, card data or raw callback bodies ever leave the merchant's server).
- [x] TypeScript SDK `@paynp/sdk`: wraps any adapter (`initiate`, `verify`, `decideTransition`), batches events, never blocks or fails a payment.
- [x] Ingest API on Cloudflare Workers: `POST /v1/events` with project keys (`pnp_test_...`, `pnp_live_...`), idempotent by event id, rate limited per key.
- [x] Storage on D1: organizations, projects, keys, members, payments (one row per attempt, rolled up from events), events.
- [x] Live stream: one Durable Object per project fans events out over WebSocket to the dashboard and the CLI.
- [x] Accounts: email magic-link sign-in, sessions (HTTP-only cookie, revocable, list of active sessions), organizations with members and roles (owner, admin, viewer).
- [x] Dashboard: payments list (filter by gateway, status, environment, date, amount, order id), payment detail with a span timeline, live tail.
- [x] CLI `npx paynp`: `login`, `init` (detects the stack, writes the key to `.env`, prints the 3-line wiring), `tail` (live events in the terminal), `test` (sends a sample payment trace).

### Phase 2: alerts and analytics

- [x] Alert rules per project: failed payment, failure rate above N% in M minutes, payment stuck pending over N minutes, amount mismatch, signature failures, gateway status API errors or slow p95, fulfilled-twice guard.
- [x] Channels: email (Resend, or Cloudflare Email Sending on Workers Paid), Slack and Discord webhooks, generic signed webhook. Per-rule cooldown so one outage sends one alert, plus a resolved notice.
- [x] Daily email digest: volume, success rate, revenue, top failure reasons.
- [ ] Weekly digest.
- [x] Analytics: success rate, volume and revenue over time per gateway, time to pay (p50/p95 from start to paid), drop-off funnel (started, reached gateway, came back, paid), failure reasons ranked, status API latency per gateway.
- [x] Error explainer: maps gateway codes (eSewa `ES104`, Fonepay `409`, Khalti `400` lookups, ...) to the cause and fix from `skills/nepal-payments/references/`.

Deployed 2026-11-05 at https://paynp.discerns.app (Workers free plan, ingest capped at 15 events per request).

- [ ] Verify `paynp.discerns.app` in Resend so sign-in and alert emails send (Resend answers 403 until then).
- [ ] Rotate the Resend API key (it was shared in a chat) with `wrangler secret put RESEND_API_KEY`.
- [ ] Publish `@paynp/sdk` and the `paynp` CLI to npm.

### Phase 2.5: merchant operations (not started)

Contract: [`platform/SPEC-v2.md`](platform/SPEC-v2.md). The shared event additions it needs are already in
`platform/shared/src/events.ts` (`payment.annotated`, `payment.refunded`, `customer`, `gw_env`, `return_https`,
`refund_ref`, `refund_reason`, `action_id`); `shared/src/ops.ts` and `finance.ts` are empty placeholders for the API types.

From research into what Nepali merchants struggle with: duplicate payments, "I already paid", stuck orders,
fragmented refunds, reconciliation across three dashboards, sandbox-to-production breakage, outages at peak hours.

- [ ] Double-payment detection and a refund queue (refunds sent through the merchant's own server via signed actions; checklists for gateways without a refund API).
- [ ] "I already paid" lookup by phone, email, amount, time or any reference, plus customer status links.
- [ ] Paid-but-not-fulfilled alert.
- [ ] Settlement reconciliation from uploaded eSewa, Khalti and Fonepay statements (presets need real statement samples to verify).
- [ ] Go-live doctor: `paynp doctor` plus checks on live traffic.
- [ ] Public gateway status page from aggregate traffic.
- [ ] Accounting exports: Tally-style and Hamrokhata CSVs, VAT credit notes, fiscal-year summary.

Build plan: four builders in parallel, each owning its files so they don't collide.

| Builder | Scope (SPEC-v2 sections) | Owns |
|---|---|---|
| Ops backend | 1 (server side), 2 (migration 0002), 3, 4.1, 4.2, 4.3, 4.4 server findings | `worker/migrations/0002_ops.sql`, `worker/src/api/ops.ts`, ingest changes, `shared/src/ops.ts` |
| Finance backend | 4.5, 4.6, 4.7 | `worker/migrations/0003_finance.sql`, `worker/src/api/finance.ts`, `worker/src/status/*`, `shared/src/finance.ts` |
| Dashboard | 5 | `platform/dashboard` |
| SDK + CLI | 1 (SDK side), 3 (action handler), 4.4 `paynp doctor`, init wiring for actions | `platform/sdk-ts`, `platform/cli` |

Rules for every builder: read SPEC.md and SPEC-v2.md first; additive changes only; keep a 15-event ingest batch
under D1's 50 queries per invocation (free plan); one register line each in `worker/src/index.ts`; tests for every
rule, a real `wrangler dev` run for worker features, screenshots at 1440 and 390 light/dark for dashboard pages; no
deploys; no em/en dashes or ellipsis characters. After all four finish: run every suite and the typecheck, redeploy
the worker (which serves the dashboard), and check `/status` and `/s/<token>` on the live site.

### Phase 3: more languages and easier setup

- [x] `npx paynp dev`: Inngest-style local dev server and dashboard at localhost:4040, no account or key; the SDK finds it automatically outside production.
- [x] `paynp init` edits the code (Trigger.dev-style): wraps the gateway import, hooks settle(), shows a diff first.
- [ ] Framework helpers: `withPaynp()` for Next.js, Express and Hono middleware for return routes.

- [ ] SDKs for Python, PHP, Go, Java and Kotlin with the same event schema, wired into each adapter.
- [ ] OpenTelemetry endpoint (OTLP/HTTP) with `payment.*` semantic conventions, so teams already on OTel send spans without an SDK.
- [ ] `paynp init` code edits for Laravel, Django and FastAPI.
- [ ] The nepal-payments skill turns paynp on when `PAYNP_KEY` is set.

### Phase 4: platform

- [ ] Public status page for every Nepali gateway, built from aggregate status API health across all projects.
- [ ] Re-check button: the dashboard asks the merchant's server to run `confirmPayment` again through a signed callback.
- [ ] Data retention per plan, CSV export, audit log.
- [ ] Billing and plans.
- [ ] Move raw events to ClickHouse when D1 volume needs it.

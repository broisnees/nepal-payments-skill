# paynp platform spec (v1)

paynp shows a business every payment from every app and every Nepali gateway in one place: a live feed, a timeline per payment, failures with their cause, analytics, and alerts by email, Slack, Discord or webhook. The merchant's server sends events through a small SDK (or the CLI sets it up); nothing about the payment itself goes through paynp, so paynp being down never breaks a checkout.

**paynp** is a working name. It lives in one constant per package (`NAME` in `shared/src/brand.ts` and the CLI's `package.json` `bin`) so it can change.

## 1. Layout

```
platform/
  package.json            npm workspaces: shared, worker, dashboard, sdk-ts, cli
  shared/                 @paynp/shared: event schema, API types, zod validators, brand constants
  worker/                 Cloudflare Worker: ingest + REST API + auth + live (Durable Object) + cron alerts + dashboard assets
  dashboard/              React + Vite SPA, built into worker/public and served by the Worker
  sdk-ts/                 @paynp/sdk: event client and adapter wrappers
  cli/                    paynp CLI (npx paynp)
```

TypeScript everywhere, `strict`. Node 22+ for local tooling. One Worker serves `app.<domain>` (dashboard + `/api/*` + `/auth/*`) and `/v1/*` (public ingest), so the dashboard and API share an origin and cookies need no CORS.

## 2. Concepts

| Concept | Meaning |
|---|---|
| Organization | A business. Has members and projects. |
| Member | A user in an organization with a role: `owner`, `admin` (everything but billing and deleting the org), `viewer` (read only). |
| Project | One app or site. Has two environments, `test` and `live`, each with its own ingest keys. |
| Ingest key | Secret, server-side only. `pnp_test_<32 base62>` or `pnp_live_<32 base62>`. The prefix sets the environment. Stored as SHA-256; shown once. |
| Personal access token (PAT) | For the CLI. `pnp_pat_<32 base62>`. Created by device login. Stored as SHA-256. |
| Payment | One payment attempt (the blog's `attemptId`, the adapters' attempt id). Rolled up from its events. |
| Event | One thing that happened to a payment. Append-only. |

## 3. Event schema v1

The SDK sends batches: `POST /v1/events` with `Authorization: Bearer pnp_test_...` and body `{ "events": Event[] }` (max 100 events, max 256 KB).

```ts
type EventType =
  | "payment.started"      // attempt created and startPayment called
  | "payment.redirected"   // buyer sent to the gateway (redirect or auto-post form)
  | "callback.received"    // return route hit (GET or POST)
  | "signature.checked"    // gateway signature verified or rejected
  | "gateway.request"      // any HTTP call to the gateway (initiate, status, lookup, token)
  | "status.changed"       // attempt moved between states (from settle / decideTransition)
  | "payment.fulfilled"    // order fulfilled (must be once)
  | "reconcile.checked"    // reconcile job asked the gateway about this attempt
  | "error";               // anything thrown in the payment path

interface Event {
  id: string;              // client-generated ULID prefixed "evt_"; ingest is idempotent on (project, env, id)
  type: EventType;
  ts: string;              // ISO 8601 with milliseconds, client clock
  attempt_id: string;      // required; groups events into a payment
  order_id?: string;
  gateway: "esewa" | "khalti" | "fonepay" | "connectips" | "cybersource" | "nps" | "imepay" | string;
  amount_paisa?: number;   // integer
  status?: PaymentStatus;  // the attempt's status after this event, when known
  duration_ms?: number;    // gateway.request, signature.checked
  data?: EventData;        // small, redacted, allowlisted keys only (below)
  sdk?: { name: string; version: string; lang: string };
}

type PaymentStatus = "initiated" | "pending" | "paid" | "failed" | "canceled" | "expired" | "refunded" | "unknown";

interface EventData {
  from?: PaymentStatus; to?: PaymentStatus;            // status.changed
  op?: "initiate" | "status" | "lookup" | "token" | "refund" | string; // gateway.request
  method?: string; endpoint?: string;                  // path only, no query string
  http_status?: number;
  provider_status?: string;                            // e.g. COMPLETE, Completed, PENDING
  provider_code?: string;                              // e.g. ES104, 409, IP-400
  provider_ref?: string;                               // gateway's transaction reference
  valid?: boolean;                                     // signature.checked
  reason?: string;                                     // short machine reason: amount_mismatch, bad_signature, id_mismatch, timeout, ...
  message?: string;                                    // human text, truncated to 500 chars
  source?: "return" | "reconcile" | "notify" | "manual";
  attempt?: number;                                    // retry number for gateway.request
}
```

**Redaction (SDK and server both enforce):** only the keys above are accepted in `data`; unknown keys are dropped server-side. Strings are cut at 500 chars. The SDK never sends secrets, signatures, raw callback bodies, card numbers, tokens, `pidx`-style session ids are allowed only as `provider_ref`. The server rejects events whose strings match card-number or `-----BEGIN` patterns (drops the field, keeps the event).

**Responses:** `202 {"accepted": n, "duplicates": m}`; `400` with per-event errors for invalid events (valid ones in the batch are still accepted); `401` bad key; `413` too large; `429` rate limited (default 50 req/s per key) with `Retry-After`.

## 4. Data model (D1)

```sql
CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT, created_at INTEGER NOT NULL);
CREATE TABLE orgs (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE members (org_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (org_id, user_id));
CREATE TABLE invites (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, email TEXT NOT NULL, role TEXT NOT NULL, token_hash TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE projects (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, name TEXT NOT NULL, slug TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE (org_id, slug));
CREATE TABLE api_keys (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, env TEXT NOT NULL, prefix TEXT NOT NULL, key_hash TEXT UNIQUE NOT NULL, name TEXT, created_at INTEGER NOT NULL, last_used_at INTEGER, revoked_at INTEGER);
CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL, user_agent TEXT, ip TEXT, created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER);
CREATE TABLE login_tokens (token_hash TEXT PRIMARY KEY, email TEXT NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER);
CREATE TABLE device_codes (device_code_hash TEXT PRIMARY KEY, user_code TEXT UNIQUE NOT NULL, user_id TEXT, expires_at INTEGER NOT NULL, approved_at INTEGER);
CREATE TABLE pats (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL, name TEXT, created_at INTEGER NOT NULL, last_used_at INTEGER, revoked_at INTEGER);

-- One row per payment attempt, kept current on every ingest (upsert).
CREATE TABLE payments (
  project_id TEXT NOT NULL, env TEXT NOT NULL, attempt_id TEXT NOT NULL,
  order_id TEXT, gateway TEXT NOT NULL, amount_paisa INTEGER, status TEXT NOT NULL,
  started_at INTEGER NOT NULL,          -- first event ts (ms)
  updated_at INTEGER NOT NULL,          -- last event ts (ms)
  finished_at INTEGER,                  -- ts of the event that made it final (paid/failed/canceled/expired/refunded)
  provider_ref TEXT, last_reason TEXT, last_message TEXT,
  event_count INTEGER NOT NULL, error_count INTEGER NOT NULL DEFAULT 0, fulfil_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project_id, env, attempt_id)
);
CREATE INDEX payments_by_time ON payments (project_id, env, started_at DESC);
CREATE INDEX payments_by_status ON payments (project_id, env, status, started_at DESC);
CREATE INDEX payments_by_order ON payments (project_id, env, order_id);

CREATE TABLE events (
  project_id TEXT NOT NULL, env TEXT NOT NULL, id TEXT NOT NULL, attempt_id TEXT NOT NULL,
  type TEXT NOT NULL, ts INTEGER NOT NULL, received_at INTEGER NOT NULL, gateway TEXT NOT NULL,
  status TEXT, duration_ms INTEGER, data TEXT,  -- JSON
  PRIMARY KEY (project_id, env, id)
);
CREATE INDEX events_by_attempt ON events (project_id, env, attempt_id, ts);
CREATE INDEX events_by_time ON events (project_id, env, ts DESC);

-- Per-minute rollups for analytics and alert evaluation (written on ingest).
CREATE TABLE minute_stats (
  project_id TEXT NOT NULL, env TEXT NOT NULL, gateway TEXT NOT NULL, minute INTEGER NOT NULL,  -- epoch minute
  started INTEGER NOT NULL DEFAULT 0, paid INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0,
  paid_amount_paisa INTEGER NOT NULL DEFAULT 0, gw_requests INTEGER NOT NULL DEFAULT 0, gw_errors INTEGER NOT NULL DEFAULT 0,
  gw_ms_total INTEGER NOT NULL DEFAULT 0, gw_ms_max INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project_id, env, gateway, minute)
);

CREATE TABLE alert_channels (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, type TEXT NOT NULL, name TEXT NOT NULL, config TEXT NOT NULL, created_at INTEGER NOT NULL);
  -- config JSON: email {to: string[]}, slack {webhook_url}, discord {webhook_url}, webhook {url, secret}
CREATE TABLE alert_rules (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, env TEXT NOT NULL, type TEXT NOT NULL, params TEXT NOT NULL,
  channel_ids TEXT NOT NULL, cooldown_min INTEGER NOT NULL DEFAULT 30, enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL);
CREATE TABLE alert_incidents (id TEXT PRIMARY KEY, rule_id TEXT NOT NULL, project_id TEXT NOT NULL, state TEXT NOT NULL,  -- firing | resolved
  opened_at INTEGER NOT NULL, resolved_at INTEGER, last_notified_at INTEGER NOT NULL, summary TEXT NOT NULL, context TEXT);
CREATE TABLE notifications (id TEXT PRIMARY KEY, incident_id TEXT, channel_id TEXT NOT NULL, sent_at INTEGER NOT NULL, ok INTEGER NOT NULL, error TEXT);
CREATE TABLE audit_log (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, user_id TEXT, action TEXT NOT NULL, target TEXT, at INTEGER NOT NULL, meta TEXT);
```

**Rollup rules (on ingest, per event):** upsert `payments`; `status` takes the event's `status` (or `data.to`) only if the event's `ts` is not older than `updated_at`, except that a final status is never overwritten by a non-final one; `fulfil_count += 1` on `payment.fulfilled`; `error_count += 1` on `error` and on `signature.checked` with `valid=false`; `last_reason/last_message` from the latest event carrying them. Update `minute_stats` for the event's minute.

Retention v1: events 30 days, payments 400 days, minute_stats 400 days (cron deletes daily).

## 5. Auth

- **Dashboard sign-in, magic link:** `POST /auth/login {email}` always answers 204 (no account enumeration), emails a link `/auth/verify?token=...` (32 random bytes, SHA-256 stored, 15 min, one use). `GET /auth/verify` creates the user on first sign-in, creates a session and redirects to `/`. First sign-in also creates a personal org and a default project.
- **Sessions:** cookie `paynp_session` (HttpOnly, Secure, SameSite=Lax, Path=/), 30 days, sliding (`last_seen_at` refreshed at most every 10 min). `GET /api/sessions` lists the user's sessions (device, IP, last seen, current flag); `DELETE /api/sessions/:id` revokes; `POST /auth/logout`.
- **CSRF:** state-changing `/api/*` requests require header `X-Paynp-CSRF: 1` (custom header + SameSite=Lax is enough for a same-origin SPA) and a matching `Origin` when present.
- **CLI, device login:** `POST /auth/device` → `{device_code, user_code: "ABCD-EFGH", verification_url, interval: 3, expires_in: 600}`. The user opens `/device?code=ABCD-EFGH` in the browser while signed in and approves. The CLI polls `POST /auth/device/token {device_code}` → `428 {"error":"authorization_pending"}` until approved, then `200 {token: "pnp_pat_..."}`. The CLI stores it in `~/.config/paynp/credentials.json` (mode 600).
- **API auth:** `/api/*` accepts the session cookie or `Authorization: Bearer pnp_pat_...`. Every project-scoped route checks membership and role.
- **Email delivery:** Cloudflare Email Sending binding when configured; otherwise, in `wrangler dev`, the email body (including the magic link) is logged to the console so local sign-in works with no provider.

## 6. REST API (`/api`, JSON)

All list endpoints use cursor pagination: `?limit=50&cursor=<opaque>` → `{items, next_cursor}`.

| Method + path | Role | Purpose |
|---|---|---|
| `GET /api/me` | any | user, orgs with role |
| `POST /api/orgs` / `PATCH /api/orgs/:org` | any / admin | create, rename |
| `GET /api/orgs/:org/members`, `POST .../invites`, `DELETE .../members/:user`, `PATCH .../members/:user` | admin | members and invites (invite email with accept link) |
| `GET /api/orgs/:org/projects`, `POST /api/orgs/:org/projects` | viewer / admin | list, create |
| `GET/PATCH/DELETE /api/projects/:p` | viewer / admin / owner | read, rename, delete |
| `GET /api/projects/:p/keys`, `POST .../keys {env, name}`, `DELETE .../keys/:id` | admin | keys (POST returns the full key once) |
| `GET /api/projects/:p/payments?env=&status=&gateway=&q=&from=&to=&min=&max=` | viewer | list; `q` matches attempt_id, order_id or provider_ref prefix |
| `GET /api/projects/:p/payments/:attempt?env=` | viewer | payment + its events in time order + an `explain` block (cause and fix, see 9) |
| `GET /api/projects/:p/events?env=&type=&gateway=&since=` | viewer | recent raw events |
| `GET /api/projects/:p/analytics?env=&from=&to=&bucket=hour|day&gateway=` | viewer | time series from minute_stats: started, paid, failed, success_rate, revenue_paisa, gw_latency_avg, gw_error_rate; plus totals, failure reasons ranked, time-to-pay p50/p95 (from payments) and the funnel (started, redirected, callback, paid) |
| `GET /api/projects/:p/health?env=` | viewer | per-gateway status for the last 15 min: requests, error rate, avg/max latency, state `ok|degraded|down` |
| `GET/POST/PATCH/DELETE /api/projects/:p/channels` | admin | alert channels; `POST .../channels/:id/test` sends a test message |
| `GET/POST/PATCH/DELETE /api/projects/:p/rules` | admin | alert rules |
| `GET /api/projects/:p/incidents?state=` | viewer | alert history |
| `GET /api/projects/:p/live?env=` | viewer | WebSocket upgrade to the project's live stream |
| `GET /api/sessions`, `DELETE /api/sessions/:id` | self | sessions |
| `GET /api/pats`, `DELETE /api/pats/:id` | self | CLI tokens |

Errors: `{error: {code, message}}` with proper status codes.

## 7. Live stream

One Durable Object `ProjectLive` per `project:env`. Ingest, after writing to D1, posts the accepted events (and updated payment rows) to the DO, which broadcasts `{"kind":"event","event":...,"payment":...}` to connected WebSockets (dashboard live tail and `paynp tail`). Use the WebSocket Hibernation API. The DO keeps the last 200 events in memory so a new connection gets a backlog first (`{"kind":"backlog","events":[...]}`). Heartbeat ping every 30 s.

## 8. Alerts

Rule types and params:

| type | params | Evaluated |
|---|---|---|
| `payment_failed` | `{gateways?: string[], min_amount_paisa?: number}` | on ingest (status.changed to failed) |
| `failure_rate` | `{threshold_pct: 20, window_min: 15, min_payments: 5, gateway?}` | cron, every minute |
| `stuck_pending` | `{older_than_min: 30}` | cron: payments open (initiated/pending/unknown) longer than N minutes |
| `amount_mismatch` | `{}` | on ingest (data.reason = amount_mismatch) |
| `signature_failure` | `{threshold: 1, window_min: 10}` | on ingest + cron |
| `gateway_errors` | `{gateway?, error_rate_pct: 20, window_min: 10, min_requests: 5}` | cron |
| `gateway_slow` | `{gateway?, avg_ms: 5000, window_min: 10}` | cron |
| `double_fulfilment` | `{}` | on ingest (fulfil_count becomes 2) |
| `no_traffic` | `{window_min: 60}` | cron (live env only): no payment.started in the window |

Incident lifecycle: a rule that triggers with no open incident opens one (`firing`) and notifies its channels. While firing, it notifies again only after `cooldown_min` and only if the summary changed. When the cron finds the condition clear for 2 consecutive evaluations, the incident resolves and channels get a resolved message. Per-event rules (`payment_failed`, `amount_mismatch`, `double_fulfilment`) open one incident per payment but are batched: at most one email per channel per minute, listing the payments.

Channels: email (Cloudflare Email Sending; HTML + text; link to the payment or incident), Slack and Discord incoming webhooks, generic webhook (JSON body, `X-Paynp-Signature: sha256=<hex HMAC of body with channel secret>`, `X-Paynp-Timestamp`). Every send writes a `notifications` row; failures retry once.

Digest: daily email at 09:00 Asia/Kathmandu to org owners and admins (opt-out per user): yesterday's volume, success rate, revenue, top 3 failure reasons, open incidents.

## 9. Error explainer

`shared/src/explain.ts` maps `(gateway, provider_code | reason | provider_status)` to `{title, cause, fix, docs_url}`, built from `skills/nepal-payments/references/*.md` (eSewa ES104/ES704/ES200/409/NOT_FOUND, Khalti 400 lookups and 401s, Fonepay 409/406, connectIPS 403, NPS error_code 3, IME non-zero ResponseCode, CyberSource reason codes, plus generic amount_mismatch, bad_signature, id_mismatch, timeout). The payment detail API includes the match for the payment's last reason; the dashboard shows it as a card.

## 10. Dashboard

React 19 + Vite + React Router. No UI kit; a small set of components on the same tokens as the marketing site (Inter, JetBrains Mono, square corners, hairline borders, light and dark). Charts: uPlot. Target first load under 150 KB gzipped.

Pages: sign-in (email field, "check your email"), device approval, org/project switcher in the top bar with a test/live toggle; **Overview** (KPIs: payments, success rate, revenue, time to pay p50; charts; gateway health strip; open incidents); **Payments** (filterable table, live updates, status pills, search by order/attempt/ref); **Payment detail** (header with amount, gateway, status, durations; vertical timeline of events with relative times and durations like a trace; explain card; raw event JSON per row); **Live** (tail of events with pause and filters); **Analytics** (time range, bucket, per-gateway breakdown, funnel, failure reasons, latency); **Alerts** (rules, channels with test button, incidents); **Settings** (project name, keys with create/reveal-once/revoke and setup snippet, members and invites, sessions, CLI tokens). Empty states show the setup command and a "send a test payment" button that calls the same synthetic trace as `paynp test`.

## 11. SDK (`@paynp/sdk`)

```ts
import { createPaynp } from "@paynp/sdk";
const paynp = createPaynp({ key: process.env.PAYNP_KEY }); // no key: every call is a no-op

// Blog-style gateway modules (startPayment/confirmPayment):
const gateway = paynp.wrapGateway("esewa", esewaModule);
// Skill adapters (initiate/verify):
const esewa = paynp.wrapAdapter(esewaAdapter);
// Record what only the app knows:
paynp.statusChanged({ attemptId, gateway, from, to, orderId, amountPaisa });
paynp.fulfilled({ attemptId, gateway, orderId });
paynp.callbackReceived({ attemptId, gateway, method: "GET" });
await paynp.flush(); // serverless: pass to ctx.waitUntil / after()
```

The wrappers emit `payment.started`, `payment.redirected`, `gateway.request` (timed), `signature.checked`, `error` (with `reason` from PaymentError messages: amount_mismatch, bad_signature, id_mismatch) and `status` from outcomes, and rethrow exactly what the wrapped function threw. Events queue in memory and flush every 2 s or at 50 events with `fetch(..., {keepalive: true})`; failures retry with backoff up to 3 times, then drop with one console warning per minute. The queue is capped at 1000 events. Zero dependencies; runs on Node 20+, Bun, Deno, Workers, Next.js edge. `PAYNP_ENDPOINT` overrides the ingest URL (default `DEFAULT_ENDPOINT` in `shared/src/brand.ts`, today `https://discerns.app`; local `http://localhost:8787`).

## 12. CLI (`npx paynp`)

| Command | Does |
|---|---|
| `paynp login` | Device login, stores the PAT. `--endpoint` for local dev. |
| `paynp logout` | Revokes and deletes the PAT. |
| `paynp init` | Detects the stack (package.json deps, composer.json, requirements/pyproject, go.mod, build.gradle(.kts)); picks or creates the project; creates a test key; writes `PAYNP_KEY` (and `PAYNP_ENDPOINT` if not default) to `.env` (creating it, never overwriting an existing value, adding `.env` to `.gitignore` if missing); installs `@paynp/sdk` for JS stacks; for Express, Hono, Fastify, Next.js and plain Node wires the SDK into the app's code (writes `paynp.ts` next to the gateway module or the skill adapters, points their imports at it, hooks the blog's `settle()`, adds `after()` / `waitUntil` flushes on serverless), shown as a unified diff and applied after one Y/n question; other stacks get the printed wiring. Never edits files with uncommitted changes (unless `--force`), `node_modules` or anything outside the project; a second run changes nothing. `--yes` for non-interactive, `--dry-run` to only print. |
| `paynp tail` | Live events for the linked project in the terminal (colored by status, one line per event, `--json`). |
| `paynp test` | Sends a synthetic eSewa payment trace (started, redirected, callback, signature ok, status COMPLETE, paid, fulfilled) with the test key, then prints the dashboard link. |
| `paynp keys` | List/create/revoke keys. |
| `paynp open` | Opens the dashboard for the linked project. |
| `paynp dev` | Local dev server on `http://localhost:4040`: ingest, the dashboard's read API, the live stream and the dashboard, no account and no key. With no key outside production the SDK finds it through `GET /v1/health` (`{"mode": "local"}`). |

The link to a project is stored in `.paynp/project.json` (`{org, project}`); `paynp init` creates it.

## 13. Local development

```bash
cd platform && npm install
npm run dev          # wrangler dev (Worker + local D1 + DO) and vite (dashboard) with /api proxied
npm run db:migrate   # applies worker/migrations to local D1
npm test             # vitest across packages; worker tests run in @cloudflare/vitest-pool-workers
```

Deploying needs the Cloudflare account, a D1 database and the email binding; it's a separate, manual step.

## 14. Done means

- `npm test` green: schema validation, redaction, rollup rules (out-of-order events, final status never regresses), idempotent ingest, auth flows (magic link, sessions, revoke, device login), role checks, alert evaluation (open, cooldown, resolve, batching), webhook signatures, SDK wrappers (events emitted, errors rethrown untouched, no key = no-op, flush, queue cap).
- End to end locally: `paynp login` → `paynp init` in a sample Express app with the blog's eSewa module → real sandbox payment start → events appear live in the dashboard and in `paynp tail` → timeline correct → a failing rule fires an email (console in dev) and a Slack-format webhook to a local receiver.

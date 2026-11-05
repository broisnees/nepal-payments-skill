# @paynp/sdk

Sends what happens to each payment in my app (eSewa, Khalti, Fonepay, connectIPS, CyberSource, NPS, IME Pay) to paynp, so I see every attempt as a timeline, every failure with its cause, and get alerted when something breaks.

Nothing about the payment itself goes through paynp. The SDK only reports. If paynp is down, slow, or the key is wrong, checkout behaves exactly as before.

- Zero runtime dependencies. ESM with types.
- Node 20+, Bun, Deno, Cloudflare Workers, Next.js edge: it only uses `fetch`, `crypto.getRandomValues` and timers.
- No key in production, no work: with `NODE_ENV=production` and no key, `createPaynp()` returns no-ops, never patches anything and never touches the network.
- No key while I build: events go to `npx paynp dev` on my machine if it is running, and nowhere if it is not (see [Local dev server](#local-dev-server)).

```bash
npm install @paynp/sdk
```

`npx paynp init` does the setup for me: it creates a test key, writes `PAYNP_KEY` to `.env`, installs this package and wires it into the code (Express, Hono, Next.js and Fastify), showing the diff before it changes anything. For other stacks it prints the wiring. In development `npx paynp dev` shows everything locally with no key at all.

## Wiring

### Gateway modules from the blog (`startPayment` / `confirmPayment`)

```ts
// paynp.ts
import { createPaynp } from "@paynp/sdk";
import * as esewa from "./esewa";

export const paynp = createPaynp({ key: process.env.PAYNP_KEY });
export const gateway = paynp.wrapGateway("esewa", esewa);
```

Then `server.ts` imports `gateway` from `./paynp` instead of `./esewa`. The wrapped module has the same functions with the same types, and every other export passes through. `wrapGateway` reads nothing from the module until a function is called, so the import cycle `paynp.ts -> esewa.ts -> payments.ts -> paynp.ts` is fine.

What only my app knows goes in `settle()`, where `transition()` moved the attempt:

```ts
if (transition(attempt.id, [...OPEN], s)) {
  paynp.statusChanged({ attemptId: attempt.id, gateway: "esewa", to: s, orderId: attempt.orderId });
  if (s === "paid") {
    fulfil(attempt.orderId);
    paynp.fulfilled({ attemptId: attempt.id, gateway: "esewa", orderId: attempt.orderId });
  }
}
```

### Skill adapters (`initiate` / `verify`)

```ts
import { esewa } from "nepal-payments";
const adapter = paynp.wrapAdapter(esewa({ env: "sandbox", productCode: "EPAYTEST", secretKey }));
```

The adapter's `orderId` is the attempt id. `id`, `orderIdFromCallback` and every other method pass through, with `this` intact.

### Serverless

Events are sent in the background every 2 seconds. On platforms that freeze the function after the response, I hand the send to the platform:

```ts
// Cloudflare Workers, Hono on Workers
ctx.waitUntil(paynp.flush());          // c.executionCtx.waitUntil(paynp.flush())
// Next.js route handlers
import { after } from "next/server";
after(() => paynp.flush());
```

`flush()` resolves once the queue is empty and never rejects.

## What the wrappers send

| Call | Events |
|---|---|
| `startPayment` / `initiate` | `payment.started` (status `initiated`, amount, `return_https`, `customer` from the getter), the gateway requests it made, then `payment.redirected` with the form or redirect path, `provider_ref` and `gw_env`, or `error` |
| `confirmPayment` / `verify` with callback params | `callback.received`, `signature.checked` (eSewa `data`, Fonepay `DV`, CyberSource `signature`), the gateway requests, then the outcome status on the last of these; or `error` |
| `confirmPayment` / `verify` with empty params (the reconcile job) | the gateway requests, then `reconcile.checked` carrying the outcome status |

Outcome statuses map onto the event schema: `paid`, `pending`, `failed`, `canceled`, `refunded` as is, `partially_refunded` becomes `refunded`, and `not_found` sends no status (the gateway has no record yet, which says nothing about the attempt). For adapters, a `paid` whose amount differs from the stored one is sent as status `unknown` with reason `amount_mismatch`, the same rule as `decideTransition()`.

### Sandbox or production (`gw_env`)

Every `gateway.request` and `payment.redirected` carries `gw_env: "sandbox" | "production"`, worked out from the host the module called or redirected to. The host itself is never sent. Sandbox hosts, from the gateway references:

| Gateway | Sandbox hosts |
|---|---|
| eSewa | `rc-epay.esewa.com.np`, `rc.esewa.com.np`, `rc-checkout.esewa.com.np`, `rc-links.esewa.com.np`, `uat.esewa.com.np` |
| Khalti | `dev.khalti.com`, `test-pay.khalti.com`, `test-admin.khalti.com` |
| Fonepay | `dev-clientapi.fonepay.com`, `dev-merchantapi.fonepay.com`, `dev-merchant-login.fonepay.com` |
| connectIPS | `uat.connectips.com` |
| CyberSource | `testsecureacceptance.cybersource.com`, `apitest.cybersource.com`, `businesscentertest.cybersource.com` |
| NPS | `apisandbox.nepalpayment.com`, `gatewaysandbox.nepalpayment.com` |
| IME Pay | `stg.imepay.com.np` (port 7979) |

Any other host under the gateway's domain counts as production. A host outside every gateway domain (a mock on localhost, a custom `hosts` entry) gets no `gw_env`. paynp flags a live key whose events say `sandbox`, the classic "went live with test credentials" bug. `gwEnvOf(url)` and `SANDBOX_HOSTS` are exported.

`payment.started` also carries `return_https` when the start input has an absolute `returnUrl` (the blog modules and the skill adapters both take one). An `http://` return URL on live traffic is flagged too: some gateways refuse it, and the callback travels in clear text.

### Who paid (`customer`)

```ts
export const gateway = paynp.wrapGateway("esewa", esewa, {
  customer: (input) => ({ phone: input.phone, email: input.email, name: input.name }),
});
```

The getter gets the `startPayment` / `initiate` input and runs once per start; its result goes on `payment.started`. paynp keeps phone and email only as a salted hash plus a masked form (`98XXXXX123`), so support can find "I already paid" payments by phone without storing the number. A getter that throws or returns nothing sends no customer, and the start goes on as normal. When the details live elsewhere (the order, a session), I attach them later with `paynp.annotate()`.

Within one attempt, timestamps strictly increase (at least 1 ms apart) so a timeline sorted by time shows events in the order they were recorded.

Empty params mean "reconcile job" to the wrappers. If the return route can be hit with no query or body at all, I call `paynp.callbackReceived()` there myself.

### Errors

The wrappers rethrow exactly what the module threw: the same object, identity included, also for non-`Error` values. The `error` event gets a short reason:

| Thrown | `reason` |
|---|---|
| `... amount mismatch ...`, `... has no TranAmount` | `amount_mismatch` |
| `... bad signature ...`, `... not signed`, `... bad DV ...`, adapter code `invalid_signature` | `bad_signature` |
| `... for a different payment`, adapter codes `callback_mismatch`, `pidx_mismatch` | `id_mismatch` |
| `... currency mismatch` | `currency_mismatch` |
| `... not base64 JSON` | `malformed_callback` |
| `TimeoutError`, `AbortError` | `timeout` |
| `... status check failed: HTTP 503 ...` | `gateway_error` |
| `fetch failed`, `ECONNREFUSED` and friends | `network_error` |
| anything else | `exception` (or the adapter's own `code`) |

`reasonOf(err)` is exported if I want the same mapping elsewhere.

## What the timing measures

I want to be exact about this, because a number on a dashboard is only useful if I know what it covers.

**Per HTTP request (the normal case).** While a wrapped call runs, the SDK swaps `globalThis.fetch` for a thin recorder and puts the original back when the last wrapped call ends. Each `fetch` to the gateway's hosts (`esewa.com.np`, `khalti.com`, `fonepay.com`, `connectips.com`, `cybersource.com`, `nepalpayment.com`, `imepay.com.np`, including sandboxes) becomes one `gateway.request` with:

- `duration_ms`: from calling `fetch` until the response headers arrived. Reading the body is not included.
- `method`, `endpoint` (path only, the query string never leaves the process), `http_status`, `op` (`initiate` in start, `status` in confirm, `lookup`/`token`/`refund` when the path says so), and `attempt` (2, 3, ... for retries to the same path).
- For a request that threw: `reason` (`timeout`, `network_error`) and the message.

Fetches to other hosts are never recorded. A module that makes no HTTP call (eSewa's `startPayment` only signs a form) sends no `gateway.request`.

**Whole call (the fallback).** There is no AsyncLocalStorage in this SDK, so it cannot tell two concurrent calls apart. If a gateway request goes out while two wrapped calls for the same gateway are running, neither call can be attributed, and each confirm call instead sends one `gateway.request` with `op: "status"`, no `endpoint`, and `duration_ms` covering the whole `confirmPayment` / `verify` call (signature check, the HTTP call, reading and checking the response). The same fallback applies with `traceFetch: false`, with a gateway id I made up and gave no `hosts`, and on a runtime where `globalThis.fetch` cannot be replaced. A start call has no fallback event. A confirm call that failed on its callback (`bad_signature`, `malformed_callback`) sends no fallback event either, because those checks run before any HTTP call.

So a busy server sees a mix: precise per-request numbers for calls that did not overlap, whole-call numbers for those that did. The two are easy to tell apart on an event: whole-call events have no `endpoint`.

One gap I accept: if code that I did not wrap calls a gateway host while exactly one wrapped call for that gateway is running, that request is recorded on the wrapped call.

**Code I write myself.** `paynp.fetch({ attemptId, gateway, op })` returns a `fetch` that records every call it makes for that attempt, with no global patching and no concurrency limits:

```ts
const res = await paynp.fetch({ attemptId, gateway: "khalti", op: "lookup" })(url, init);
```

## Recording things by hand

```ts
paynp.statusChanged({ attemptId, gateway, from, to, orderId, amountPaisa, reason, message, source });
paynp.fulfilled({ attemptId, gateway, orderId, amountPaisa });
paynp.callbackReceived({ attemptId, gateway, method: "GET" });
paynp.reconcileChecked({ attemptId, gateway, status, providerStatus, providerRef });
paynp.error({ attemptId, gateway, error, reason, op });
```

Statuses can be the blog's or the adapters' (`not_found`, `partially_refunded` are mapped as above).

```ts
// order and buyer details, no status change (payment.annotated)
paynp.annotate({ attemptId, gateway, orderId, customer: { phone, email, name } });
// a refund made by hand in the gateway's portal (payment.refunded); amountPaisa is what was refunded
paynp.refunded({ attemptId, gateway, amountPaisa: 5000, refundRef: "RF-123", reason: "duplicate payment" });
```

The server marks the payment `refunded` once the refunds add up to its amount.

## Refunds and re-checks from the dashboard (action endpoint)

paynp never holds my gateway keys. When I press "Send refund via your server" or "Re-check" in the dashboard, paynp sends a signed request to an endpoint on my own server, and my server talks to the gateway with its own keys.

1. Add the route (below) and deploy it.
2. In the dashboard: Settings, Action endpoint, enter the URL (one per environment: test and live). The secret is shown once.
3. Set it on the server as `PAYNP_ACTION_SECRET`, then press "Test".

The handler:

- accepts only `POST` with `X-Paynp-Signature: sha256=<hex HMAC-SHA256(secret, timestamp + "." + body)>` and `X-Paynp-Timestamp: <unix seconds>`; anything else gets `401`;
- rejects timestamps more than 5 minutes old (or ahead) and action ids it has already handled (`409`; an in-memory list of the last 10,000 ids per process);
- calls my `refund` or `recheck` callback with the action, then answers `200 {"ok": true, "refund_ref"?, "status"?}`, or `200 {"ok": false, "error"}` when the callback threw or returned `{ ok: false, error }`;
- after a successful refund, sends `payment.refunded` (refunded amount, `refund_ref`, `refund_reason`, `action_id`); after a re-check, `reconcile.checked` with the status and `action_id`. It sends these before answering, waiting at most 3 seconds;
- works without `PAYNP_KEY`: the refund still runs, nothing is reported.
- answers the dashboard's "Test" button (a `ping` action) with `{"ok": true}` once the signature checks out, without calling anything.

The action my callback gets:

```ts
interface PaynpAction {
  id: string;                    // act_...
  kind: "refund" | "recheck";
  attemptId: string;
  gateway: string;
  orderId?: string;
  amountPaisa?: number;          // the payment's amount
  providerRef?: string;          // the last gateway reference paynp saw
  refund?: { amountPaisa?: number; reason?: string }; // no amountPaisa = full refund
}
```

### Khalti refund callback

From the Khalti reference: `POST https://dev.khalti.com/api/merchant-transaction/{transaction_id}/refund/` in sandbox, `https://khalti.com/api/merchant-transaction/{transaction_id}/refund/` in production (not under `/api/v2/`), with `Authorization: Key <secret key>`. An empty body refunds everything; `{ "amount": <paisa> }` refunds part of it. Success is `{"detail": "Transaction refund successful."}`, with no refund id.

```ts
// paynp-actions.ts
import type { ActionHandlerOptions } from "@paynp/sdk";
import { gateway } from "./paynp";

const KHALTI = process.env.KHALTI_ENV === "production" ? "https://khalti.com" : "https://dev.khalti.com";
const auth = { Authorization: `Key ${process.env.KHALTI_SECRET_KEY}`, "Content-Type": "application/json" };

// The refund API takes Khalti's transaction_id. paynp sends the last reference it saw: the transaction_id once a
// confirm ran, the pidx before that. Lookup turns a pidx into the transaction_id; a transaction_id gets a 404.
async function khaltiTransactionId(ref: string): Promise<string> {
  const res = await fetch(`${KHALTI}/api/v2/epayment/lookup/`, { method: "POST", headers: auth, body: JSON.stringify({ pidx: ref }) });
  const body = (await res.json().catch(() => ({}))) as { transaction_id?: string };
  return body.transaction_id || ref;
}

export const actions: ActionHandlerOptions = {
  async refund(a) {
    if (a.gateway !== "khalti") return { ok: false, error: `${a.gateway} has no refund API; use the checklist in the dashboard` };
    if (!a.providerRef) return { ok: false, error: "no Khalti reference on this payment" };
    const id = await khaltiTransactionId(a.providerRef);
    const amount = a.refund?.amountPaisa;
    const partial = amount !== undefined && amount !== a.amountPaisa;
    const res = await fetch(`${KHALTI}/api/merchant-transaction/${encodeURIComponent(id)}/refund/`, {
      method: "POST",
      headers: auth,
      // Wallet payments. For bank payments Khalti also wants the payer's "mobile".
      body: JSON.stringify(partial ? { amount } : {}),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Khalti refund failed: HTTP ${res.status} ${JSON.stringify(body)}`);
    return { refundRef: id }; // Khalti gives no refund id; the transaction id identifies it in their portal
  },
  async recheck(a) {
    // The wrapped gateway with empty params is the reconcile path: it asks the status API.
    const r = await gateway.confirmPayment({ attemptId: a.attemptId, amountPaisa: a.amountPaisa ?? 0, providerRef: a.providerRef ?? null, params: {} });
    return { status: r.status };
  },
};
```

The Khalti docs show a partial `amount` as paisa in the text and `50.00` in their example, so I test a partial refund in sandbox before relying on it.

### Gateways without a refund API

For these, the dashboard shows a manual checklist on the refund case instead of the "Send refund" button, and I record the refund reference there (or call `paynp.refunded()`):

| Gateway | Refund API | What to do instead |
|---|---|---|
| Khalti | Yes, `merchant-transaction/{id}/refund/` | Use the callback above, or refund from the merchant dashboard |
| eSewa (ePay v2) | No | Refund in the eSewa merchant portal or through eSewa merchant support with the transaction code; the status API then shows `FULL_REFUND` / `PARTIAL_REFUND` |
| Fonepay | No public API | Merchant panel or the acquiring bank, with the PRN and Fonepay trace id (`UID`) |
| connectIPS | No | connectIPS / the bank, with the `TXNID` |
| NPS | No | NPS merchant support, with the `MerchantTxnId` and `GatewayReferenceNo` |
| IME Pay | No | IME Pay merchant support, with the `RefId` and `TransactionId` |
| CyberSource | Yes, REST `POST /pts/v2/payments/{id}/refunds` (needs REST API keys, not the Secure Acceptance profile) | Wire it like Khalti, or refund in the Business Center |

### Mounting the route

```ts
// Hono (Node, Bun, Workers)
app.post("/paynp/actions", (c) => paynp.actionHandler({ ...actions, secret: c.env?.PAYNP_ACTION_SECRET })(c.req.raw));

// Next.js: app/paynp/actions/route.ts
const handle = paynp.actionHandler(actions);
export async function POST(req: Request) {
  return handle(req);
}

// Cloudflare Workers: secrets are on env, not process.env
export default { fetch: (req, env) => paynp.actionHandler({ ...actions, secret: env.PAYNP_ACTION_SECRET })(req) };

// Express: before express.json(), or with express.raw(), so the handler sees the exact bytes paynp signed
app.post("/paynp/actions", express.raw({ type: "application/json" }), paynp.nodeActionHandler(actions));

// Fastify
app.post("/paynp/actions", paynp.nodeActionHandler(actions));
```

The signature covers the raw body. When a JSON body parser already ran (`express.json()`, Fastify's default parser), the handler serializes the parsed object again. That matches because paynp sends compact `JSON.stringify` output, but a raw body (`express.raw()`, `req.rawBody`) is the safer choice. Every handler made from one `createPaynp()` shares the replay list. On serverless with several instances the list is per instance, so the 5-minute timestamp window is what stops an old request from being replayed elsewhere.

## Local dev server

```bash
npx paynp dev    # dashboard and ingest on http://localhost:4040, no account, no key
```

With no key and `NODE_ENV` anything but `production` (unset counts), the SDK looks for that server:

- It sends one `GET /v1/health` to the dev URL before the first send and trusts the answer for 30 seconds. Only an answer of `{"mode": "local"}` counts, so the hosted API is never mistaken for it. The probe gives up after 500 ms.
- Server up: events go there with no `Authorization` header.
- Server down: queued events are dropped without a log line, and the next probe waits 30 seconds. Recording an event never waits on the probe; only an explicit `flush()` can, for at most 500 ms.
- The dev URL is `dev` (option), else `endpoint`, else `PAYNP_DEV_URL`, else `PAYNP_ENDPOINT`, else `http://localhost:4040`.
- Off with `dev: false`, `PAYNP_DEV=0`, `NODE_ENV=production` or `PAYNP_ENV=production`. Also off on Cloudflare Workers and on runtimes without `process.env` unless I pass a URL, since a deployed edge function has no localhost.

`paynp.enabled` is `true` in this mode, because the wrappers have to run to have anything to send.

With a key nothing changes: events go to the endpoint with the key, and the dev server is never probed. Pointing a keyed app at the dev server also works, since it takes any key: `PAYNP_ENDPOINT=http://localhost:4040`.

## Options

```ts
createPaynp({
  key,                  // pnp_test_... or pnp_live_...; empty = paynp dev outside production, else no-op
  endpoint,             // default PAYNP_ENDPOINT, else https://paynp.discerns.app (local worker: http://localhost:8787)
  dev,                  // no key only: dev server URL, or false to never look for one
  flushIntervalMs: 2000,
  maxBatch: 50,         // events per request (max 100); a full batch is sent at once
  maxQueue: 1000,       // oldest events are dropped beyond this
  retryBaseMs: 500,     // retries wait 500 ms, 1 s, 2 s (plus jitter, or Retry-After if longer)
  onError: (err) => {}, // every dropped batch or invalid event; replaces the console warning
  fetch,                // transport override
});

paynp.wrapGateway("esewa", mod, { hosts: ["pay.example.com"], traceFetch: true });
```

## Delivery

- Batches of up to 50 events (never over 100 events or 256 KB), sent with `keepalive: true`. On a runtime that rejects `keepalive`, the SDK drops the option and carries on.
- 5xx, 429 and network errors are retried 3 times with backoff. 401, 403 and 413 are not retried. A 400 means the valid events in the batch were accepted, so nothing is resent.
- After the last retry the batch is dropped with one `console.warn`, at most once a minute (or `onError` for every failure).
- Every event is validated and redacted before it is queued, with the same code the ingest API uses: only the documented `data` keys, strings cut at 500 characters, query strings stripped from endpoints, and anything that looks like a card number or a `-----BEGIN` key removed. Signatures, callback bodies and secrets are never read into an event.

## Development

```bash
npm run build       # tsup: dist/index.js + dist/index.d.ts, the shared event schema bundled in
npm test            # vitest, including the real blog eSewa module against eSewa's sandbox
PAYNP_SKIP_SANDBOX=1 npm test   # offline
```

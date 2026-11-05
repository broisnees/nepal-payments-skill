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
| `startPayment` / `initiate` | `payment.started` (status `initiated`, amount), the gateway requests it made, then `payment.redirected` with the form or redirect path and `provider_ref`, or `error` |
| `confirmPayment` / `verify` with callback params | `callback.received`, `signature.checked` (eSewa `data`, Fonepay `DV`, CyberSource `signature`), the gateway requests, then the outcome status on the last of these; or `error` |
| `confirmPayment` / `verify` with empty params (the reconcile job) | the gateway requests, then `reconcile.checked` carrying the outcome status |

Outcome statuses map onto the event schema: `paid`, `pending`, `failed`, `canceled`, `refunded` as is, `partially_refunded` becomes `refunded`, and `not_found` sends no status (the gateway has no record yet, which says nothing about the attempt). For adapters, a `paid` whose amount differs from the stored one is sent as status `unknown` with reason `amount_mismatch`, the same rule as `decideTransition()`.

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

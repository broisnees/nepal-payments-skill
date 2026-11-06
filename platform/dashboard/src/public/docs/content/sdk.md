# SDK reference

`@paynp/sdk` sends what happens to each payment in my app to paynp. It only reports: if paynp is down, slow, or the key is wrong, checkout behaves exactly as before.

- Zero runtime dependencies. ESM with types.
- Node 20+, Bun, Deno, Cloudflare Workers, Next.js edge: it only uses `fetch`, `crypto.getRandomValues` and timers.
- No key in production, no work: with `NODE_ENV=production` and no key, `createPaynp()` returns no-ops, never patches anything and never touches the network.
- No key while building: events go to `npx paynp dev` if it is running, and nowhere if it is not.

```bash
npm install @paynp/sdk
```

## Wiring

### Gateway modules (`startPayment` / `confirmPayment`)

```ts
// paynp.ts
import { createPaynp } from "@paynp/sdk";
import * as esewa from "./esewa";

export const paynp = createPaynp({ key: process.env.PAYNP_KEY });
export const gateway = paynp.wrapGateway("esewa", esewa);
```

The server imports `gateway` from `./paynp` instead of `./esewa`. The wrapped module has the same functions with the same types, and every other export passes through. What only the app knows goes where the attempt changes state:

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

Events are sent in the background every 2 seconds. On platforms that freeze the function after the response, hand the send to the platform:

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
| `confirmPayment` / `verify` with callback params | `callback.received`, `signature.checked`, the gateway requests, then the outcome status on the last of these; or `error` |
| `confirmPayment` / `verify` with empty params (the reconcile job) | the gateway requests, then `reconcile.checked` carrying the outcome status |

Outcome statuses map onto the event schema: `paid`, `pending`, `failed`, `canceled`, `refunded` as is, `partially_refunded` becomes `refunded`, and `not_found` sends no status. For adapters, a `paid` whose amount differs from the stored one is sent as status `unknown` with reason `amount_mismatch`, the same rule as `decideTransition()`.

Every `gateway.request` and `payment.redirected` carries `gw_env: "sandbox" | "production"`, worked out from the host the module called. The host itself is never sent. paynp flags a live key whose events say `sandbox`.

### Errors

The wrappers rethrow exactly what the module threw: the same object, identity included. The `error` event gets a short reason:

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

## What the timing measures

While a wrapped call runs, the SDK swaps `globalThis.fetch` for a thin recorder and puts the original back when the last wrapped call ends. Each `fetch` to the gateway's hosts becomes one `gateway.request` with `duration_ms` (from calling `fetch` until the response headers arrived), `method`, `endpoint` (path only), `http_status`, `op` and `attempt` for retries. Fetches to other hosts are never recorded.

When two wrapped calls for the same gateway overlap, the SDK cannot tell their requests apart, so each confirm call sends one whole-call `gateway.request` with `op: "status"` and no `endpoint` instead. For code I write myself, `paynp.fetch()` records every call with no global patching:

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
// order and buyer details, no status change (payment.annotated)
paynp.annotate({ attemptId, gateway, orderId, customer: { phone, email, name } });
// a refund made by hand in the gateway's portal (payment.refunded)
paynp.refunded({ attemptId, gateway, amountPaisa: 5000, refundRef: "RF-123", reason: "duplicate payment" });
```

### Who paid (`customer`)

```ts
export const gateway = paynp.wrapGateway("esewa", esewa, {
  customer: (input) => ({ phone: input.phone, email: input.email, name: input.name }),
});
```

The getter runs once per start and its result goes on `payment.started`. paynp keeps phone and email only as a salted hash plus a masked form (`98XXXXX123`), so support can find "I already paid" payments by phone without storing the number.

## Action endpoint (refunds and re-checks)

paynp never holds gateway keys. "Send refund via your server" and "Re-check" in the dashboard send a signed request to a route on my server, which acts with its own keys. See [Reconcile, refunds and exports](/docs/operations) for the setup.

```ts
// Hono
app.post("/paynp/actions", (c) => paynp.actionHandler({ ...actions, secret: c.env?.PAYNP_ACTION_SECRET })(c.req.raw));
// Express: raw body, so the handler sees the exact bytes paynp signed
app.post("/paynp/actions", express.raw({ type: "application/json" }), paynp.nodeActionHandler(actions));
```

The handler accepts only `POST` with a valid `X-Paynp-Signature: sha256=<hex HMAC-SHA256(secret, timestamp + "." + body)>`, rejects timestamps more than 5 minutes off and action ids it has already handled, and answers `200 {"ok": true, "refund_ref"?, "status"?}` or `200 {"ok": false, "error"}`.

## Options

```ts
createPaynp({
  key,                  // pnp_test_... or pnp_live_...; empty = paynp dev outside production, else no-op
  endpoint,             // default PAYNP_ENDPOINT, else https://paynp.discerns.app
  dev,                  // no key only: dev server URL, or false to never look for one
  flushIntervalMs: 2000,
  maxBatch: 15,         // events per request (max 100); a full batch is sent at once
  maxQueue: 1000,       // oldest events are dropped beyond this
  retryBaseMs: 500,     // retries wait 500 ms, 1 s, 2 s (plus jitter, or Retry-After if longer)
  onError: (err) => {}, // every dropped batch or invalid event; replaces the console warning
  fetch,                // transport override
});
```

## Delivery

- Batches of up to 15 events by default (never over 100 events or 256 KB), sent with `keepalive: true`.
- 5xx, 429 and network errors are retried 3 times with backoff. 401, 403 and 413 are not retried.
- After the last retry the batch is dropped with one `console.warn`, at most once a minute (or `onError` for every failure).
- Every event is validated and redacted before it is queued, with the same code the ingest API uses. See [Events and redaction](/docs/events).

> The default of 15 events per request matches the hosted service, which runs on the Workers free plan and refuses larger batches with `413`. A self-hosted worker on a paid plan can take up to 100; see [Self-hosting and limits](/docs/limits).

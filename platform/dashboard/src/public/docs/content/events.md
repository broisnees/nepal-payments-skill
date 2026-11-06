# Events and redaction

The SDK sends batches of events to `POST /v1/events` with `Authorization: Bearer pnp_test_...` and a body of `{ "events": [...] }`. Each event is one thing that happened to one payment attempt. Events are append-only, and ingest is idempotent on the event id.

## Event types

| Type | Meaning |
|---|---|
| `payment.started` | Attempt created and the payment started |
| `payment.redirected` | Buyer sent to the gateway (redirect or auto-post form) |
| `callback.received` | Return route hit (GET or POST) |
| `signature.checked` | Gateway signature verified or rejected |
| `gateway.request` | Any HTTP call to the gateway (initiate, status, lookup, token, refund) |
| `status.changed` | Attempt moved between states |
| `payment.fulfilled` | Order fulfilled |
| `reconcile.checked` | A reconcile job asked the gateway about this attempt |
| `error` | Anything thrown in the payment path |
| `payment.annotated` | Order or customer details attached, no status change |
| `payment.refunded` | A refund happened; `amount_paisa` is the refunded amount |

## Shape

```ts
interface Event {
  id: string;              // client-generated, at most 64 chars; ingest is idempotent on (project, env, id)
  type: EventType;
  ts: string;              // ISO 8601, client clock
  attempt_id: string;      // groups events into a payment
  order_id?: string;
  gateway: string;         // lowercase id: esewa, khalti, fonepay, connectips, ...
  amount_paisa?: number;   // non-negative integer
  status?: PaymentStatus;  // initiated | pending | paid | failed | canceled | expired | refunded | unknown
  duration_ms?: number;
  data?: EventData;        // allowlisted keys only
  customer?: { phone?: string; email?: string; name?: string };
  sdk?: { name: string; version: string; lang: string };
}
```

`data` accepts these keys and nothing else: `from`, `to`, `op`, `method`, `endpoint`, `http_status`, `provider_status`, `provider_code`, `provider_ref`, `valid`, `reason`, `message`, `source`, `attempt`, `gw_env`, `return_https`, `refund_ref`, `refund_reason`, `action_id`.

## Responses

| Status | Meaning |
|---|---|
| `202` | `{"accepted": n, "duplicates": m}` |
| `400` | Per-event errors for invalid events; the valid ones in the batch are still accepted |
| `401` | Unknown or revoked key |
| `413` | Over 256 KB, or more events than the per-request limit |
| `429` | Over 50 requests per second for this key, with `Retry-After` |

## Redaction

The same code runs in the SDK before an event is queued and on the server before it is stored:

- Only the `data` keys listed above are kept, with the right types. Unknown keys are dropped, never an error.
- Strings are cut at 500 characters.
- Any string that looks like a card number (13 to 19 digits, spaces or dashes allowed) or a `-----BEGIN` key block is removed. The field is dropped; the event is kept.
- `endpoint` is a path only: the query string never leaves the process.
- The SDK never reads secrets, signatures or raw callback bodies into an event. Session ids like Khalti's `pidx` travel only as `provider_ref`.

Customer details get extra care on the server. Phone numbers and emails are normalised and stored only as a per-project salted SHA-256 hash plus a masked display form (`98XXXXX123`, `n***@gmail.com`). A name is kept, cut at 80 characters.

## How a payment is rolled up

Each event updates one row per attempt. The status takes the event's `status` (or `data.to`) only if the event is not older than the last one applied, and a final status (`paid`, `failed`, `canceled`, `expired`, `refunded`) is never overwritten by an open one. `error` events and failed signature checks count as errors; `payment.fulfilled` counts fulfilments, so a second one is a double fulfilment.

## Retention

Events are kept 30 days. Payments and the per-minute stats behind analytics are kept 400 days. A daily job deletes older rows.

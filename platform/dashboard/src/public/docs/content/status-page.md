# Status page

[status.discerns.app](https://status.discerns.app) answers "is eSewa down?" for every gateway. Every minute it calls each gateway's production API with no credentials and no transaction, and records whether the gateway answered and how fast. A check passes on any answer below 500 within 10 seconds. IME Pay is not checked: its API only answers servers IME has whitelisted.

## Status API

The same data as JSON, with no key, open CORS, ETags and a 30-second cache. The full reference, with an OpenAPI document, is at [status.discerns.app/developers](https://status.discerns.app/developers).

| Endpoint | Returns |
|---|---|
| `GET /v1/status` | Every gateway with `state`, `action` (`show`, `warn`, `disable`) and a buyer-facing `message` |
| `GET /v1/status/:gateway` | One gateway in full |
| `GET /v1/checkout?gateways=esewa,khalti` | Those gateways ordered healthy first, plus `available` |
| `GET /v1/incidents` | Incidents, newest first |

On the server, the SDK has a client that caches for 30 seconds and fails open:

```ts
import { createStatusClient } from "@paynp/sdk";

const status = createStatusClient();
if (!(await status.isAvailable("esewa"))) {
  // refuse early with a clear message instead of a gateway timeout
}
```

Missing data never blocks a payment: `no_data` means `show`, and an unreachable API means every gateway is available.

## What it shows

For each gateway:

- the current state: operational, degraded, down, or no data
- the share of failed checks and p95 response time over the last 24 hours
- daily uptime bars for 90 days
- latency by hour of the day in Nepal time over the last 7 days
- incidents: 5 or more minutes with over 20% failed checks or p95 over 5 seconds

A check fails when the gateway answered 500 or above, did not answer within 10 seconds, or the connection failed.

## Data

The status site uses only its own checks. Nothing from merchants' projects, events or payments is used or shown. Check results are kept for 90 days.

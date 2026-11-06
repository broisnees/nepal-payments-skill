# Analytics and digests

## Overview

The Overview tab is the first page of every project: payments, success rate, revenue and time to pay (p50) for the period, the main charts, a health strip with each gateway's state over the last 15 minutes (ok, degraded or down from its request error rate and latency), and the open incidents.

## Analytics

The Analytics tab covers the last 24 hours, 7 days or 30 days, by hour or by day, for all gateways or one:

| Series | From |
|---|---|
| Started, paid, failed | Per-minute counts written on ingest |
| Success rate | paid / (paid + failed); empty when both are 0 |
| Revenue | Sum of paid amounts |
| Gateway latency | Average `gateway.request` duration |
| Gateway error rate | Share of gateway requests that failed |

Plus the totals, failure reasons ranked, time to pay at p50 and p95, a per-gateway breakdown, and the checkout funnel: started, redirected, callback, paid. A drop between redirected and callback is buyers who left on the gateway's page.

All times are Nepal time (Asia/Kathmandu).

## Live

The Live tab tails events as they arrive, with pause and filters. New connections first get the last 200 events, so the page is never empty after a reload. The terminal gets the same stream:

```bash
npx paynp tail            # test environment
npx paynp tail --live     # production
npx paynp tail --json     # one JSON event per line
```

## Daily digest

Every day at 09:00 Nepal time, owners and admins of each organization get one email covering yesterday, per project and environment that had any activity:

- payments started, success rate and revenue
- the top 3 failure reasons
- open incidents

Each person turns it off for themselves in Settings, Account.

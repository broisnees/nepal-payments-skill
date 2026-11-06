# Introduction

discerns shows every payment from every app and every Nepali gateway in one place: a list of attempts, a timeline for each one, the cause of each failure, analytics, and alerts by email, Slack, Discord or webhook.

My server sends events through a small SDK, `@paynp/sdk`. Nothing about the payment itself goes through discerns. The SDK only reports, so if discerns is down, slow, or the key is wrong, checkout behaves exactly as before.

## What it covers

It knows the ten gateways the Nepal Payments skill has adapters for: eSewa, Khalti, Fonepay, connectIPS, CyberSource, NPS OnePG, IME Pay, NEPALPAY QR, Hamro Pay and GetPay. Any other lowercase gateway id (up to 32 characters) is accepted too; it gets no logo and only the generic explainer entries.

| Area | What I get |
|---|---|
| Payments | Every attempt with status, amount, gateway and references; search by attempt id, order id or gateway reference |
| Timeline | Each payment as a trace: started, redirected, callback, signature check, every gateway request with its duration, status changes, fulfilment |
| Error explainer | The likely cause and the fix for gateway codes like eSewa `ES104`, Khalti 401s, Fonepay 409 and generic reasons like `amount_mismatch` |
| Live | A tail of events as they arrive, in the dashboard and in the terminal (`paynp tail`) |
| Analytics | Volume, success rate, revenue, gateway latency and error rate, the checkout funnel, failure reasons, time to pay p50 and p95 |
| Alerts | Eleven rule types, from a single failed payment to a gateway getting slow; incidents open, notify and resolve |
| Operations | Duplicate payment detection, a refund queue, "I already paid" lookup, settlement reconciliation, accounting exports |
| Go-live checklist | Checks on live traffic plus `paynp doctor` for config and code |
| Status page | A public page with each gateway's error rate and latency, built from live traffic across projects |

## How it fits together

1. The SDK wraps the gateway modules or the skill adapters and records what happens. Events are queued in memory and sent in batches in the background.
2. The ingest API (`POST /v1/events`) validates and redacts each event, stores it, updates the payment it belongs to, and pushes it to anyone watching live.
3. The dashboard reads the payments and events. Alert rules run on ingest and every minute, and send to the channels I set up.

## Next

- [Quickstart](/docs/quickstart): from sign-up to the first payment on the dashboard.
- [SDK reference](/docs/sdk): every option and what each wrapper sends.
- [Events and redaction](/docs/events): exactly what leaves my server.

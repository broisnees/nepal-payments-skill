# Alerts and channels

Alerts are per project and per environment. A rule watches for a condition and sends to one or more channels.

## Channels

| Channel | Sends |
|---|---|
| Email | HTML and plain text with a link to the payment or incident |
| Slack | An incoming webhook message |
| Discord | An incoming webhook message |
| Webhook | A JSON body to any URL, signed with `X-Paynp-Signature: sha256=<hex HMAC of the body with the channel secret>` and `X-Paynp-Timestamp` |

Every channel has a Test button that sends a sample message. Every send is logged; a failed send is retried once.

## Rule types

| Rule | Fires when | Defaults | Evaluated |
|---|---|---|---|
| `payment_failed` | A payment fails, optionally only above an amount or for some gateways | all failures | On ingest |
| `failure_rate` | The failure rate goes over a threshold | 20% over 15 min, at least 5 payments | Every minute |
| `stuck_pending` | A payment stays open (initiated, pending, unknown) too long | 30 min | Every minute |
| `amount_mismatch` | The gateway's amount differs from the stored one | | On ingest |
| `signature_failure` | Signature checks fail | 1 in 10 min | On ingest and every minute |
| `gateway_errors` | A gateway's request error rate goes over a threshold | 20% over 10 min, at least 5 requests | Every minute |
| `gateway_slow` | A gateway's average response time goes over a threshold | 5000 ms over 10 min | Every minute |
| `double_fulfilment` | One payment is fulfilled twice | | On ingest |
| `no_traffic` | No payment started in a window (live only) | 60 min | Every minute |
| `double_payment` | The same order, or the same customer and amount within 30 minutes, is paid twice | | On ingest |
| `paid_not_fulfilled` | A payment is paid but not fulfilled after a delay | 15 min | Every minute |

`paid_not_fulfilled` stays quiet for projects that never send `payment.fulfilled`, since it cannot tell "not fulfilled" from "not reported".

## Incidents

- A rule that triggers with no open incident opens one (firing) and notifies its channels.
- While firing, it notifies again only after the cooldown (30 minutes by default) and only if the summary changed.
- When the condition is clear for 2 evaluations in a row, the incident resolves and the channels get a resolved message.
- Per-payment rules (`payment_failed`, `amount_mismatch`, `double_fulfilment`, `double_payment`, `paid_not_fulfilled`) open one incident per payment, batched to at most one message per channel per minute.

The Alerts tab holds rules, channels and the incident history, and carries a count while anything is firing.

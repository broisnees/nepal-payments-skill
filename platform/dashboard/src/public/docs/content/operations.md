# Reconcile, refunds and exports

paynp never holds gateway secret keys. Anything that has to act on a gateway (a refund, a re-check) is a signed request from paynp to my own server, which acts with its own keys and reports back.

## Action endpoint

1. Mount the SDK's handler on my server (see the [SDK reference](/docs/sdk#action-endpoint-refunds-and-re-checks)) and deploy it.
2. Settings, Action endpoint: enter the URL, one per environment. The secret is shown once.
3. Set it on the server as `PAYNP_ACTION_SECRET`, then press Test.

paynp sends:

```bash
POST <url>
X-Paynp-Signature: sha256=<hex HMAC-SHA256(secret, timestamp + "." + body)>
X-Paynp-Timestamp: <unix seconds>
{ "id": "act_...", "kind": "refund" | "recheck", "attempt_id", "gateway", "order_id", "amount_paisa", "provider_ref", "refund": { "amount_paisa", "reason" } }
```

It waits up to 20 seconds for `{"ok": true, "refund_ref"?, "status"?}` or `{"ok": false, "error"}`.

## Double payments and the refund queue

When a payment becomes paid, paynp looks for another paid payment in the same project and environment with the same order id (any time), or the same customer and amount started within 30 minutes. The later one becomes an open refund case linked to the earlier one, and the `double_payment` alert rule can announce it.

The Refunds tab lists cases (duplicate, manual, customer request) with a per-gateway checklist:

| Gateway | Refund |
|---|---|
| Khalti | "Send refund via your server" when an action endpoint is set, else the merchant dashboard |
| eSewa | Merchant portal or merchant support with the transaction code; the status API then shows `FULL_REFUND` / `PARTIAL_REFUND` |
| Fonepay, connectIPS, NPS, IME Pay | Merchant support with the reference; record the refund reference on the case |

A case resolves on its own when a `payment.refunded` event or a `refunded` status arrives for the payment.

## "I already paid"

The Support tab finds payments by phone, email, any gateway reference, attempt id or order id, optionally with an amount and a date range. Each result gets a one-line verdict: paid (with time and reference), paid twice, started but never finished, failed with the explainer's title, or refunded, plus whether it was fulfilled.

From a payment, Send status link creates a public page at `/s/<token>` for the buyer: the merchant's project name, amount, gateway, status in words, time and reference. Links last 7 days by default (1 to 90) and show no personal data beyond a masked phone.

## Settlement reconciliation

The Reconcile tab takes a gateway's settlement statement as CSV, up to 5 MB.

- Headers are detected for eSewa, Khalti and Fonepay exports. These presets are marked unverified because they are built from common column names, not published formats. When no preset fits, the page asks me to map the columns, and remembers the mapping per gateway.
- Amounts like `1,000.00`, `Rs. 1,000`, lakh grouping `1,00,000.50` and negative refunds are understood; the mapping says whether the file is in rupees or paisa.
- Rows match by exact gateway reference first, then by amount within 10 minutes when exactly one payment fits.

The result shows matched rows and amounts, statement rows paynp never saw, paid payments missing from any statement, amount mismatches, fees, net and the effective fee percentage. Without a statement, fees can be estimated from a percentage and a fixed fee per gateway.

## Exports

| Export | Contents |
|---|---|
| Transactions CSV | Every payment in a date range: date (Nepal time), attempt, order, gateway, reference, status, amount, refunded, fee, net |
| Tally-style CSV | Date, voucher type, ledger, debit, credit, narration per month; ledgers get mapped on import (unverified layout) |
| Hamrokhata CSV | A generic sales and receipts CSV (unverified layout) |
| Credit notes CSV | One row per refund with a credit note number (`CN-YYYYMM-####`), for VAT |
| Year summary | Nepal fiscal year (Shrawan 1 to the end of Asar), per gateway and per month: gross, refunds, fees, net, count |

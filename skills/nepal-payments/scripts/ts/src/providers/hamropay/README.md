# Hamro Pay Checkout

Flow: `initiate()` calls Create Session (signed headers), then signs the gateway token and returns
a form for `{gateway}/api/checkout` -> Hamro Pay redirects with `?MerchantTxnId=` -> `verify()`
calls Get Transaction. Webhooks: `verifyWebhook()` (still verify() before fulfilling).

| File           | What it holds                                                                      |
| -------------- | ---------------------------------------------------------------------------------- |
| `config.ts`    | `HamroPayConfig`, `HAMROPAY_MIN_PAISA` / `MAX`, env reader                         |
| `endpoints.ts` | hosts, paths, status map                                                           |
| `signing.ts`   | `hamroPaySign` (base64 HMAC-SHA512 over comma-joined values), webhook amount forms |
| `responses.ts` | `bodyOrError` (401 / code 16 / `code_<n>`), echoed id                              |
| `adapter.ts`   | `hamropay(cfg)`                                                                    |

Quirks:

- `transactionAmount` is PAISA as a string; every amount Hamro Pay returns is RUPEES.
- Signed values must not contain commas (the join has no escaping), so they are refused.
- `Connection: close` on every call: the API drops TCP connections without closing them.
- The live gateway host is issued by Hamro Pay (`gatewayUrl` is required in production).
- Get Transaction echoes `merchantTxnId` although the reference says `merchantTransactionId`.
- Webhook amounts are signed as Hamro Pay renders a double ("1200", "1200.0", "1200.00"): all are tried.

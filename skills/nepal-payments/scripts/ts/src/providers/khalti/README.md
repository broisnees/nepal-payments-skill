# Khalti (KPG-2 Web Checkout)

Flow: `initiate()` (server, secret key) -> redirect to `payment_url` -> Khalti GETs your return URL
-> `verify()` runs lookup with the pidx YOU stored -> fulfil only on "Completed". `refund()` refunds
a completed transaction.

| File           | What it holds                                                       |
| -------------- | ------------------------------------------------------------------- |
| `config.ts`    | `KhaltiConfig`, env reader                                          |
| `endpoints.ts` | hosts, paths, lookup status map                                     |
| `responses.ts` | initiate / lookup shapes, `khaltiError` (`error_key`, field errors) |
| `adapter.ts`   | `khalti(cfg)`                                                       |

No `signing.ts`: Khalti authenticates with `Authorization: Key <secret>` only.

Quirks:

- Trailing slash is REQUIRED on every endpoint: without it Khalti 301s and the POST body is lost.
- Minimum Rs 10 (1000 paisa); amounts are integer paisa.
- Expired / User canceled come back as HTTP 400 WITH a normal body: parsed, not thrown.
- Lookup has no order id, so the callback's pidx is never trusted (replay guard): pass the stored one.
- Partial refund units are ambiguous in Khalti's docs (paisa vs "50.00"); confirm in sandbox.

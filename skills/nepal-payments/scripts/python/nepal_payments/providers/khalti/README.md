# Khalti

KPG-2 Web Checkout (ePayment). Docs: https://docs.khalti.com/khalti-epayment/

**Flow:** `initiate()` (server, secret key) -> redirect to `payment_url` -> Khalti GETs `return_url`
-> `verify()` does a lookup with the pidx YOU stored -> fulfil only on "Completed".

| File | What it holds |
| --- | --- |
| `config.py` | `KHALTI_*` env vars |
| `endpoints.py` | Hosts, API paths, status map |
| `responses.py` | Response shapes, error message/key extraction |
| `adapter.py` | The `Khalti` class (initiate, verify, refund) |

There is no `signing.py`: Khalti authenticates with `Authorization: Key <secret>` only.

Quirks:
- Trailing slash REQUIRED on API paths (no slash -> 301 -> POST body lost). Initiate is not retried.
- Minimum amount Rs 10 (1000 paisa). Amounts are paisa.
- Verify with the STORED pidx: lookup doesn't return purchase_order_id, so a callback-supplied pidx
  could be replayed from another payment.
- Expired / User canceled lookups arrive as HTTP 400 with a normal body.
- Refund: docs say partial `amount` is paisa but show "50.00"; confirm in sandbox first.

# IME Pay

Web checkout, following the official WooCommerce/WHMCS plugin flow. Merged into Khalti in July 2025:
prefer Khalti for new builds.

**Flow:** `initiate()` calls GetToken and returns the checkout URL (`data` = base64 of
`TokenId|MerchantCode|RefId|Amount|POST|successUrl|failureUrl`) -> payer pays -> IME Pay returns to your URL
-> `verify()` calls Recheck with the stored TokenId (`provider_ref`).

| File | What it holds |
| --- | --- |
| `config.py` | `IMEPAY_*` env vars |
| `endpoints.py` | Hosts and API paths |
| `responses.py` | Response shapes |
| `adapter.py` | The `ImePay` class |

There is no `signing.py`: requests use Basic auth plus a base64 `Module` header.

Quirks:
- Callbacks are unsigned; Recheck is the only proof.
- Recheck `ResponseCode` 0 = paid; other codes are inconsistently documented, so they stay `pending`.
- Amounts are rupees with two decimals ("100.00").

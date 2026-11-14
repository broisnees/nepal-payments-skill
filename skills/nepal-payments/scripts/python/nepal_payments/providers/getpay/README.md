# GetPay

NCHL card gateway for Nepali banks (Visa/Mastercard with 3-D Secure). Docs:
https://getpay.global/web-integration/

Credentials come from the acquiring bank: `pap_info` (base64 `{institutionId, mid, tid}`), `opr_key`,
`ins_key` (blank when operator-hosted), the bundle URL and the base URL.

**Flow (browser SDK, four pages):** checkout page (`checkout_page()`) loads `bundle.js` and runs
`new GetPay(options).initialize()` -> `onSuccess` navigates to the payment page (`payment_page()`,
`<div id="checkout">`, card form + 3DS) -> GetPay redirects to `successUrl` / `failUrl` with
`token=base64(JSON {id, oprSecret})` in the query or the `#hash` (`return_page()` forwards it) ->
server `verify()`: `oprSecret == base64(SHA-256(oprKey + id))`, then `POST {base}/merchant-status {id, papInfo}`.

| File | What it holds |
| --- | --- |
| `config.py` | `GETPAY_*` env vars, default currency / theme |
| `endpoints.py` | Base / bundle URLs, status map, URL origin helper |
| `signing.py` | `get_pay_opr_secret`, `get_pay_decode_token` |
| `responses.py` | Response shapes, "not found" detection |
| `pages.py` | HTML for the checkout, payment and return pages |
| `adapter.py` | The `GetPay` class |

Quirks:
- merchant-status answers for ANY transaction id regardless of papInfo (checked 2026-11 on UAT), so a
  paid status only counts when the token's oprSecret matches YOUR `opr_key` and `data.clientId` is
  YOUR order_id.
- Without a token, `verify()` uses transaction-statement by clientRequestId, which cannot prove the
  transaction is yours: a success there comes back `unknown` for manual review.
- The token may be base64 JSON `{id, oprSecret}`; one integration reports `id:oprSecret`.
- The token can arrive in the `#hash`, which only the browser sees: callback URLs must serve
  `return_page()` and be on `website_domain`.
- `opr_key` reaches the browser by GetPay's design, so it is not a secret. `price` must be a number.
- "Not found" is `{"status": -1, "message": "...not found..."}` (HTTP 400).

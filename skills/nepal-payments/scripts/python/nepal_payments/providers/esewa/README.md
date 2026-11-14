# eSewa

ePay v2 (web / WebView form) and Intent (mobile app-to-app). Docs: https://developer.esewa.com.np

**ePay v2 flow:** `initiate()` returns a signed form -> browser posts it to eSewa -> eSewa redirects to
`success_url?data=<base64 JSON>` -> `verify()` checks that payload's signature, then calls the status API
(authoritative) -> fulfil only on `COMPLETE`.

**Intent flow:** `intent_book()` -> open `deeplink` -> eSewa calls `callback_url` (`intent_callback_valid()`)
-> `intent_verify()` with the stored `provider_ref` ("booking_id|correlation_id").

| File | What it holds |
| --- | --- |
| `config.py` | Public sandbox credentials, `ESEWA_*` env vars |
| `endpoints.py` | Form / status / Intent URLs, status maps |
| `signing.py` | `esewa_sign`, signed-field orders, exact-number extraction |
| `responses.py` | Response shapes, error message/code extraction |
| `adapter.py` | The `Esewa` class |

Quirks:
- Signature = base64(HMAC-SHA256(key, "f1=v1,f2=v2")) in `signed_field_names` order. The example
  signatures in eSewa's docs are wrong; the tests hold verified vectors.
- The Intent access key is used as a raw string, NOT base64-decoded.
- Numbers are signed as eSewa wrote them ("1000.0"), so callbacks are checked against the raw JSON text.
- Status API needs the TOTAL amount; a wrong total answers `NOT_FOUND`.
- Error bodies: docs say `error_message`, the live Intent sandbox sends `errorMessage`.
- `transaction_uuid` allows only letters, digits and `-`; keep return URLs free of query strings.

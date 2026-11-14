# NPS (Nepal Payment Solution / NPX OnePG)

**Flow:** `initiate()` calls GetProcessId and returns a multipart form (persist `provider_ref` =
ProcessId) -> browser posts it to the NPS gateway -> NPS redirects to `ResponseUrl` and also calls
your Notification URL (configured with NPS) -> `verify()` calls CheckTransactionStatus (authoritative)
-> answer the notification with `notification_response()`.

| File | What it holds |
| --- | --- |
| `config.py` | `NPS_*` env vars |
| `endpoints.py` | API / gateway URLs, status map |
| `signing.py` | `nps_sign` |
| `responses.py` | Response shapes, `{code, errors}` error handling |
| `adapter.py` | The `Nps` class |

Quirks:
- Basic auth (API username/password) + `Signature` = HMAC-SHA512, lowercase hex, over the values of
  the alphabetically sorted payload keys (excluding `Signature`), concatenated with no separator.
- Errors come back as HTTP 200 with `code != "0"`; error_code `"3"` on CheckTransactionStatus means
  "not initialized yet" and maps to `not_found`.
- `code "0"` with `data: null` is reported as `unknown`.
- The gateway form must be posted as `multipart/form-data`.

# eSewa

**ePay v2 (web / WebView):** `initiate()` returns a signed form -> eSewa -> `success_url?data=<base64 JSON>`
-> `verify()` checks that signature, then calls the status API (authoritative).
**Intent (app-to-app):** `intentBook()` -> app opens `deeplink` -> eSewa POSTs your callback
(`intentCallbackValid()`) -> `intentVerify()`. `intentCancel()` drops an abandoned booking.

| File           | What it holds                                                      |
| -------------- | ------------------------------------------------------------------ |
| `config.ts`    | `EsewaConfig`, `ESEWA_SANDBOX`, env reader                         |
| `endpoints.ts` | form / status / Intent URLs, ePay + Intent status maps             |
| `signing.ts`   | `esewaSign` (base64 HMAC-SHA256 over `k=v,...`), raw-value helpers |
| `responses.ts` | success payload, status and Intent answers, `esewaError`           |
| `adapter.ts`   | `esewa(cfg)`                                                       |

Quirks:

- The example signatures in eSewa's docs are wrong; trust the vectors in `test/providers/esewa.test.ts`.
- `amountPaisa` is always the TOTAL. Format amounts once: "110" vs "110.0" -> ES104.
- Numbers are signed as eSewa wrote them ("1000.0"), so signatures are checked against the raw JSON text.
- `total_amount` may arrive as "1,000.0"; both comma and no-comma forms are tried.
- Errors: docs say `error_message`, the live Intent sandbox sends `errorMessage`.
- The production Intent host is issued at go-live (`intent.baseUrl`). The sandbox access key is a raw string, not base64.

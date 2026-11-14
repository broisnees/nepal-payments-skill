# NPS (Nepal Payment Solution OnePG)

Flow: `initiate()` calls GetProcessId and returns a multipart form for /Payment/Index -> payer pays
-> NPS GETs your Notification URL (answer with `notificationResponse()`) and the browser returns to
ResponseUrl -> `verify()` calls CheckTransactionStatus (authoritative). Optional:
`getInstruments()`, `getServiceCharge()`.

| File           | What it holds                                                    |
| -------------- | ---------------------------------------------------------------- |
| `config.ts`    | `NpsConfig`, env reader                                          |
| `endpoints.ts` | hosts, operation names, status map                               |
| `signing.ts`   | `npsSign` (sorted keys, no separator, HMAC-SHA512 hex)           |
| `responses.ts` | the `{code, message, errors, data}` envelope, `npsEnvelopeError` |
| `adapter.ts`   | `nps(cfg)`                                                       |

Quirks:

- The gateway form must be multipart/form-data.
- code "0" with Status "Fail" is a failed payment, not an API error; error_code "3" = never initialized (not_found).
- code "0" with null data is reported as unknown rather than crashing.
- The Notification URL is configured at onboarding, not per request.

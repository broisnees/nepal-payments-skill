# Fonepay (web redirect + Dynamic QR)

**Web:** `initiate()` builds a DV-signed redirect -> payer pays -> Fonepay redirects with
PRN/PS/RC/UID/BC/.../DV -> `verify()` uses txnVerification (username/password configured) or the
legacy GET verification (needs UID + BC from a DV-verified callback).
**Dynamic QR:** `qrCreate()` -> show `qrMessage`, listen on `webSocketUrl` -> `qrStatus()`.

| File           | What it holds                                                       |
| -------------- | ------------------------------------------------------------------- |
| `config.ts`    | `FonepayConfig`, env reader                                         |
| `endpoints.ts` | URLs, websocket hosts, `TXN_STATUS`                                 |
| `signing.ts`   | `fonepayHmac` (HMAC-SHA512 hex), `fonepayDate`, every signed string |
| `responses.ts` | txnVerification / QR shapes, XML tag reader                         |
| `adapter.ts`   | `fonepay(cfg)`                                                      |

Quirks:

- The txnVerification body is signed byte-for-byte: it is built once as a string and sent as-is.
- Callback params are trusted ONLY with a valid DV; a missing DV counts as invalid, or anyone could force "failed".
- Legacy verification: a 5xx / WAF page must never read as "not paid"; it throws so the attempt stays open.
- Fonepay has returned a `localhost` websocket host; it is rewritten to the real one.
- Dev merchant-API hosts are not in public DNS; Fonepay issues them at onboarding.

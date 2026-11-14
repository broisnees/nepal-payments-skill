# NEPALPAY QR (NCHL dynamic QR)

Flow: `initiate()` signs a token (RSA-SHA256) and calls generateQR -> show `qrString` / `qrImage`
-> payer scans with any NEPALPAY QR / banking app -> `verify()` reads merchanttxnreport by
validationTraceId (= providerRef). Live updates: `webSocketRequest()`. NCHL's confirm-payment
notification: `verifyConfirmation()` + `confirmationResponse()`.

| File           | What it holds                                               |
| -------------- | ----------------------------------------------------------- |
| `config.ts`    | `NepalPayConfig`, env reader                                |
| `endpoints.ts` | hosts, paths, STOMP destinations, response/settlement codes |
| `signing.ts`   | token / confirmation / reply strings, 2-decimal amount      |
| `responses.ts` | `NepalPayTxn`, OAuth / generateQR / report parsers          |
| `adapter.ts`   | `nepalpay(cfg)`                                             |

Quirks:

- Paid = debitStatus "000" and creditStatus "000" | "999" | "DEFER"; debited-but-not-credited is "unknown".
- One QR can carry several attempts (a failed scan can be retried); any paid row wins.
- The notification docs name `payerMobileNumber`, the sample sends `payerMobile`: both are handled.
- NCHL doesn't say which key signs notifications: a false from `verifyConfirmation()` means alert, not forgery.
- The WebSocket api_token is RSA PKCS#1 v1.5 encrypted (hand-written in core/crypto.ts; WebCrypto only has OAEP).

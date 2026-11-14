# NEPALPAY QR (NCHL)

Merchant dynamic QR: the payer scans it with any NEPALPAY QR / mobile banking app. Requires
`cryptography`. Docs: https://doc.connectips.com/docs/NepalPAY-QR/Merchant-QR-generation/introduction

**Flow:** `initiate()` signs the token (RSA-SHA256) and calls `/qr/generateQR` -> show `qr_string` /
`qr_image` and persist `provider_ref` (validationTraceId) -> poll `verify()` (`/nQR/v1/merchanttxnreport`).
Optional: watch live with `web_socket_request()` (STOMP), check NCHL's confirm-payment notification
with `verify_confirmation()` and answer it with `confirmation_response()`.

| File | What it holds |
| --- | --- |
| `config.py` | `NEPALPAY_*` env vars (basic or OAuth, notification key, WebSocket) |
| `endpoints.py` | Hosts, paths, STOMP destinations, NPR = 524, status codes |
| `signing.py` | Token, confirmation and reply strings |
| `responses.py` | Answer shapes, report-row picking and status mapping |
| `adapter.py` | The `NepalPay` class |

Quirks:
- Token string (comma-joined, no spaces): acquirerId,merchantId,merchantCategoryCode,
  transactionCurrency,transactionAmount,billNumber,userId (userId = NPI username).
- `transactionAmount` always has 2 decimals; billNumber = order_id, 1–25 chars `[A-Za-z0-9-]`.
- Paid = debitStatus "000" and creditStatus "000" | "999" | "DEFER". Debited without a confirmed credit
  is `unknown` (review). A failed scan can be retried on the same QR, so the report may hold several rows.
- Report code E010 = record not found. Refund rows (`tranType` other than PMT) are ignored.
- Notification: docs name `payerMobileNumber`, the sample sends `payerMobile`. NCHL doesn't say which key
  signs it, so a failed check is a reason to alert, not proof of forgery. Always `verify()`.
- OAuth tokens are cached until 30 s before `expires_in`.

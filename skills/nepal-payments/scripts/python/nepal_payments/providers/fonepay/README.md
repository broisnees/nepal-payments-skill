# Fonepay

Web payment redirect + Dynamic QR. Every signature is HMAC-SHA512 hex over comma-joined values.

**Web flow:** `initiate()` returns a signed redirect URL -> payer pays -> Fonepay redirects to `RU` with
`PRN, PID, PS, RC, UID, BC, INI, P_AMT, R_AMT, DV` -> `verify()`: the callback is trusted only with a valid
DV, then txnVerification (needs `username`/`password`) or, without them, the legacy verificationMerchant API.

**Dynamic QR:** `qr_create()` -> show `qr_message` as a QR (optionally watch `websocket_url`) -> `qr_status()`.

| File | What it holds |
| --- | --- |
| `config.py` | `FONEPAY_*` env vars |
| `endpoints.py` | URLs, txnVerification resource, status map, WebSocket host fix |
| `signing.py` | `fonepay_hmac`, `fonepay_date`, DV field orders, txnVerification `auth` |
| `responses.py` | Response shapes, legacy XML tag reader |
| `adapter.py` | The `Fonepay` class |

Quirks:
- request DV = `PID,MD,PRN,AMT,CRN,DT,R1,R2,RU`; response DV = `PRN,PID,PS,RC,UID,BC,INI,P_AMT,R_AMT`.
- txnVerification `auth` = HMAC over `username,password,POST,application/json,<resource>,<exact JSON body>`:
  the body is built once as a string and sent byte-for-byte.
- DV hex is uppercase; QR `dataValidation` and the `auth` header are lowercase.
- `DT` is MM/DD/YYYY in Asia/Kathmandu. PRN 3-25 chars, RU <= 150 chars.
- A missing DV is treated like a bad one. A non-200 legacy verification must never read as "not paid".
- The QR WebSocket URL sometimes comes back on `localhost`; it is rewritten to Fonepay's host.

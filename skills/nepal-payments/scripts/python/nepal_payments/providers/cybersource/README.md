# CyberSource (Secure Acceptance)

Card payments through a bank-issued Secure Acceptance Hosted Checkout profile
(`profile_id` / `access_key` / `secret_key`). Being sunset in favour of Unified Checkout (see
`references/cybersource.md`); still works.

**Flow:** `initiate()` returns a signed form -> browser posts it to `{host}/pay` -> CyberSource POSTs
the signed result to the receipt page / Merchant POST URL -> `verify(callback=<that POST>)` checks the
signature (the POST is the proof; there is no status call here).

| File | What it holds |
| --- | --- |
| `config.py` | `CYBERSOURCE_*` env vars |
| `endpoints.py` | Hosts per env, uncertain reason codes |
| `signing.py` | `cybersource_sign`, `signed_date_time` |
| `responses.py` | `BillTo`, response fields, decision -> status mapping |
| `adapter.py` | The `CyberSource` class |

Quirks:
- Signature = base64(HMAC-SHA256(secret_key as RAW UTF-8, "f1=v1,...")) in `signed_field_names` order;
  the key is not hex/base64-decoded.
- Only signed response fields are trusted. An empty `req_reference_number` falls back to
  `req_transaction_uuid`.
- ACCEPT on an `authorization*` transaction type is `pending` (not captured yet); DECLINE/ERROR with
  reason 150/151/152 is `unknown`.
- Without the response POST, reconcile with the REST transaction search (not implemented here).

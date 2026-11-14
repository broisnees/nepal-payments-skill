# connectIPS

NCHL's e-payment gateway (bank account debit). Requires `cryptography`: every request is RSA-signed
with the creditor private key.

**Flow:** `initiate()` returns a signed form -> browser posts it to `/connectipswebgw/loginpage` ->
NCHL redirects to the success/failure URL registered with NCHL (not sent per request) ->
`verify()` calls `validatetxn` (authoritative). `get_txn_detail()` adds `creditStatus`.

| File | What it holds |
| --- | --- |
| `config.py` | `CONNECTIPS_*` env vars |
| `endpoints.py` | Hosts per env, form and API paths |
| `signing.py` | Token strings (`connectips_token_string`), `connectips_date`, field clipping |
| `responses.py` | Validation answer shape, status and amount mapping |
| `adapter.py` | The `ConnectIps` class |

Quirks:
- TOKEN = base64(RSA-SHA256(creditor key, "MERCHANTID=...,...,TOKEN=TOKEN")). Load the key from the
  .pfx once with `load_pfx_private_key_pem()` (PKCS#1 or PKCS#8 PEM both work).
- Amounts (`TXNAMT`, `txnAmt`) are PAISA, not rupees.
- Commas and `=` in remarks/particulars would corrupt the token string, so they become spaces.
- TXNID: 1–20 chars `[A-Za-z0-9-]`; `referenceId` in the validation APIs is that TXNID.
- TXNDATE is DD-MM-YYYY in Asia/Kathmandu. A 401 means a wrong APPID / app password.
- `creditStatus` in {"000", "999", "DEFER"} = credited / OK.

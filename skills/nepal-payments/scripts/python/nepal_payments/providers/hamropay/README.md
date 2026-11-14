# Hamro Pay

Hamro Pay Checkout (Hamro Patro's wallet). Docs: https://hamropay.com.np/checkout/developer/reference/

Credentials: UAT merchant portal https://pay-sandbox.hamropatro.com (signup OTP `000000`) -> Client
Credentials: merchantId, Client-Id, Client-API-Key, client secret; Configuration -> Webhook gives the
webhook signing secret.

**Flow:** server `POST /v1/checkout/sessionId` (signed headers) -> server builds the gateway token ->
browser form POST to `{gateway}/api/checkout` -> Hamro Pay redirects to the success/failure URL with
`?MerchantTxnId=` -> server `POST /v1/checkout/transaction` (`verify()`, authoritative). Webhooks:
`verify_webhook()`, then still `verify()`.

| File | What it holds |
| --- | --- |
| `config.py` | `HAMROPAY_*` env vars, Rs 10..50,000 limits |
| `endpoints.py` | API base / sandbox gateway URLs, paths, status map |
| `signing.py` | `hamro_pay_sign`, webhook amount renderings |
| `responses.py` | Response shapes, error message/code extraction |
| `adapter.py` | The `HamroPay` class |

Every signature is base64(HMAC-SHA512(client_secret, values joined by ",")):

| What | Signed values | Where |
| --- | --- | --- |
| create session | merchantTxnId,transactionAmount,merchantId,clientId,clientApiKey | header `Signature` |
| gateway token | merchantId,merchantTxnId,sessionId,transactionAmount,clientId,clientApiKey | form field `token` |
| get txn | merchantTxnId,merchantId,clientId,clientApiKey | header `Signature` |
| webhook | merchantTxnId,merchantId,status,amount (webhook secret) | header `Signature` |

Quirks:
- `transactionAmount` is PAISA as a string (Rs 10..50,000); every amount Hamro Pay returns is RUPEES.
- The join has no escaping, so values containing a comma are refused.
- The webhook amount is signed as Hamro Pay renders a double ("1200", "1200.0" or "1200.00"): every
  rendering is tried.
- The reference names the echoed id `merchantTransactionId`; the live API answers `merchantTxnId`.
- The API drops each TCP connection without marking it closed: send `Connection: close`.
- Envoy aborts the chunked stream after error answers; core `http()` keeps a truncated body when it
  is complete JSON.
- A timeout on Create Session may still have created it: retry with a NEW order_id. Sessions live
  about 10 minutes. Production needs `gateway_url` (Hamro Pay issues the live host).

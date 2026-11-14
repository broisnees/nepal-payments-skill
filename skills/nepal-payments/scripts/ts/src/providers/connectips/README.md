# connectIPS (NCHL)

Flow: `initiate()` signs TOKEN (RSA-SHA256, creditor private key) and returns a form for the
login page -> connectIPS redirects to the success/failure URL registered with NCHL (`?TXNID=`)
-> `verify()` calls validatetxn (Basic auth + signed token). `getTxnDetail()` adds bank, charges
and creditStatus.

| File           | What it holds                                      |
| -------------- | -------------------------------------------------- |
| `config.ts`    | `ConnectIpsConfig`, env reader                     |
| `endpoints.ts` | hosts, validation URLs, validatetxn status mapping |
| `signing.ts`   | `connectIpsTokenString`, `connectIpsDate`, `clip`  |
| `responses.ts` | `ConnectIpsTxnDetail`, amount parser               |
| `adapter.ts`   | `connectips(cfg)`                                  |

Quirks:

- Key prep: convert the .pfx to a PKCS#8 PEM once (see `adapter.ts` header; add `-legacy` on OpenSSL 3).
- TXNAMT is PAISA. TXNID <= 20 chars. Commas/equals in REMARKS etc. would corrupt the token string.
- validatetxn's `referenceId` is the TXNID you sent, not REFERENCEID.
- Redirect URLs are registered with NCHL, not sent per request (`returnUrl` is unused).
- `statusDesc` "INCOMPLETE" = payer hasn't finished OTP yet (pending).

# CyberSource Secure Acceptance (Hosted Checkout)

Flow: `initiate()` returns a signed form for `/pay` -> payer enters card -> CyberSource POSTs the
signed result to your receipt page / Merchant POST URL -> `verify()` checks the signature, order id
and currency, then maps `decision`. There is no simple status API: the signed POST IS the proof.

| File           | What it holds                                     |
| -------------- | ------------------------------------------------- |
| `config.ts`    | `CyberSourceConfig`, `BillTo`, env reader         |
| `endpoints.ts` | hosts, `mapDecision`                              |
| `signing.ts`   | `cybersourceSign`, `signedDateTime`, `signedOnly` |
| `adapter.ts`   | `cybersource(cfg)`                                |

No `responses.ts`: the only response is the signed form POST (string params).

Quirks:

- Secure Acceptance is being sunset in favour of Unified Checkout; new builds should ask the bank for REST credentials.
- The secret key is RAW UTF-8 here (REST secrets are base64-decoded — don't mix them up).
- Only fields listed in the response's `signed_field_names` are trusted.
- ACCEPT on an authorization is "pending" (not captured); reason codes 150-152 are "unknown" (re-check).
- Reason 110 = partial approval; the amount guard catches it.

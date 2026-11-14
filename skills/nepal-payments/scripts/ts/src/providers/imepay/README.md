# IME Pay (web checkout)

Flow: `initiate()` calls GetToken and returns a redirect to WebCheckout with a base64 payload ->
IME POSTs the result to RespUrl / CancelUrl -> `verify()` calls Recheck with the stored TokenId.

| File           | What it holds                                                 |
| -------------- | ------------------------------------------------------------- |
| `config.ts`    | `ImePayConfig`, env reader                                    |
| `endpoints.ts` | hosts (port 7979), paths                                      |
| `signing.ts`   | checkout payload encoding, 2-decimal amounts (no HMAC exists) |
| `responses.ts` | GetToken / Recheck shapes, GetToken error                     |
| `adapter.ts`   | `imepay(cfg)`                                                 |

Quirks:

- IME Pay merged into Khalti (July 2025); prefer Khalti for new builds.
- Callbacks are UNSIGNED, so Recheck is the only proof of payment.
- ResponseCode 0 = paid; other codes disagree across sources, so they stay "pending" for human review.
- Port 7979 must be reachable outbound (IME may need to whitelist your IP).

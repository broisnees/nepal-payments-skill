# GetPay (NCHL cards, 3-D Secure)

Flow (browser SDK, four pages): `initiate()` returns SDK options -> `checkoutPage()` loads the
bundle and starts checkout -> `paymentPage()` hosts the card form -> GetPay redirects to your
success/fail URL, which serves `returnPage()` -> your server calls `verify()` with
`callback.token`: oprSecret check, then merchant-status, then clientId must be your orderId.

| File           | What it holds                                                        |
| -------------- | -------------------------------------------------------------------- |
| `config.ts`    | `GetPayConfig`, env reader                                           |
| `endpoints.ts` | hosts, bundle URL, status map                                        |
| `signing.ts`   | `getPayOprSecret`, `getPayDecodeToken`                               |
| `responses.ts` | status-API answer parsers, `getPayError`                             |
| `pages.ts`     | the HTML pages (extra file: GetPay is the only browser-SDK provider) |
| `adapter.ts`   | `getpay(cfg)`                                                        |

Quirks:

- merchant-status answers for ANY transaction id regardless of papInfo, so paid counts only with YOUR oprKey + orderId.
- The token can arrive in the `#hash`, which only the browser sees: that's why `returnPage()` exists.
- Without a token (reconciliation) a success is reported "unknown", never "paid".
- The oprKey reaches the browser by design; it is not a secret. Callback URLs must be on `websiteDomain`.

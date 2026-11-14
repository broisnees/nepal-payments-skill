# Contributing to the TypeScript adapters

Zero runtime dependencies, Node 22.18+ (runs `.ts` directly), files import each other with `.ts`
extensions. Before sending a change:

```sh
npm ci
npm test              # node --test "test/**/*.test.ts"
npm run typecheck     # tsc --noEmit
npm run format:check  # prettier (printWidth 100); `npm run format` fixes
```

## Layout

```
src/
  index.ts              public API: re-exports + createPayments, paymentsConfigFromEnv, newOrderId
  core/                 shared by every provider; core/index.ts is the public part
    types.ts            ProviderId, PaymentStatus, InitiateInput/Result, VerifyInput/Result, PaymentAdapter
    errors.ts           PaymentError + responseError() (the one way to turn a bad response into an error)
    money.ts            integer paisa <-> rupee strings
    encoding.ts         base64 / hex / utf8
    crypto.ts           HMAC, SHA-256, RSA sign/verify/PKCS#1 encrypt, safeEqual
    http.ts             fetch with timeouts and retries for reads
    records.ts          isRecord, lookup, ... for reading untyped JSON without `any`
    state-machine.ts    decideTransition
    html.ts             escapeHtml, renderAutoSubmitForm
    env.ts              environmentFrom, pemFromEnv
  providers/<id>/
    config.ts           <Provider>Config, sandbox constants, <id>ConfigFromEnv()
    endpoints.ts        URLs per env, provider status -> PaymentStatus maps
    signing.ts          pure signing / string-building functions (the test vectors target these)
    responses.ts        typed response shapes + guards that turn `unknown` JSON into them
    adapter.ts          the factory, e.g. esewa(cfg), reading top to bottom
    index.ts            the provider's barrel
    README.md           flow, which file does what, quirks
test/
  helpers.ts            mockFetch / calls / header / restoreFetch, rsaKeys, isPaymentError
  core/*.test.ts        one file per core module
  providers/<id>.test.ts
  index.test.ts         createPayments, newOrderId
```

A provider skips a file it has no content for (Khalti has no `signing.ts`, CyberSource has no
`responses.ts`) and may add one when it truly needs it (GetPay's `pages.ts`).

## Rules of the road

- **Factories, not classes.** `foo(cfg)` returns an object literal that
  `satisfies PaymentAdapter & Record<string, unknown>`; provider extras (refund, qrCreate, ...) are
  more methods on it.
- **No `any`.** HTTP answers are `unknown`; parse them in `responses.ts` with `isRecord` and friends.
- **Errors:** `responseError(provider, res, "Foo status failed", { detail, code })` for a bad response;
  `new PaymentError(...)` for everything else. Keep codes stable: tests and callers match on them.
- **Money:** integer paisa everywhere; format with `paisaToRupees`, parse with `rupeesToPaisa`. Format an
  amount ONCE and use the same string where it is both signed and sent.
- **Status:** map every provider status explicitly in `endpoints.ts`, read with `lookup()` (own
  properties only), fall back to `"unknown"`. Never map an ambiguous answer to `"failed"`.
- **verify() is authoritative:** a server-to-server status call, never callback params alone. If the
  provider's status API can't prove the transaction is yours, return `"unknown"`, not `"paid"`.
- **Comments say why.** Keep every provider quirk comment ("trailing slash REQUIRED", "docs' example
  signatures are wrong"); they are the most valuable lines in the repo.
- Lines <= 100 chars, small named functions, early returns, no nested ternaries.

## Adding a gateway: checklist

Use an existing provider of the same shape as the template (form POST: eSewa / connectIPS;
redirect: Khalti / Fonepay; QR: NEPALPAY; browser SDK: GetPay).

1. **Id.** Add `"foo"` to `ProviderId` in `src/core/types.ts`.
2. **Test vectors first.** Create `test/providers/foo.test.ts` with the signature examples from the
   provider's spec (or vectors you verified against their sandbox; docs are sometimes wrong, as with
   eSewa). Write them against the signing functions before writing the adapter.
3. **`src/providers/foo/`**
   - `config.ts`: `FooConfig` (every field commented: where it comes from, sandbox value, limits),
     `FOO_SANDBOX` if public sandbox credentials exist, and `fooConfigFromEnv(env)` returning
     `undefined` unless the required `FOO_*` vars are set (use `environmentFrom`, `pemFromEnv`).
   - `endpoints.ts`: `{ sandbox, production }` URLs and the status map.
   - `signing.ts`: exported pure functions named `fooSign`, `fooTokenString`, ...
   - `responses.ts`: response interfaces + guards; a `fooError(res)` if the provider has its own
     error body shape (built on `responseError`).
   - `adapter.ts`: `export function foo(cfg: FooConfig)` with `id`, `initiate`, `verify`,
     `orderIdFromCallback`, plus extras.
   - `index.ts`: re-export the factory, config type, sandbox constants and signing helpers.
   - `README.md`: the flow, the file table, the quirks.
4. **Register** in `src/index.ts` (the compiler points at anything missed):
   - `export { foo, fooSign, type FooConfig } from "./providers/foo/index.ts";`
   - `foo?: FooConfig;` in `PaymentsConfig`
   - `foo` in `FACTORIES` and `foo: fooConfigFromEnv` in `ENV_READERS` (key order = `enabled` order)
5. **Tests** with `mockFetch`: initiate request shape (URL, headers, body), every status mapping,
   amount parsing, error codes, and the "callback for another order" / forged-callback cases.
6. **Env vars:** list the new `FOO_*` variables for `references/env.md` (docs are updated separately).
7. Run `npm test`, `npm run typecheck`, `npm run format`.

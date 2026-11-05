# TODO

What's left, roughly in priority order. Items come from the Java, Kotlin, PHP and Go ports (which re-read the TypeScript source line by line) and from live sandbox runs on 2026-11-05.

## Correctness (fix in TypeScript + Python, then mirror in the other ports)

- [ ] **eSewa Intent callback signature format.** TS signs callback values with `String(v)` (JSON `100.0` → `"100"`, `null` → `""`); Python uses `str(v)` (`"100.0"`, `"None"`). One of them rejects genuine callbacks. Capture a real Intent callback in the sandbox and align every port to it.
- [ ] **eSewa Intent error body.** The live sandbox returns `{"code":0,"errorMessage":"..."}`; all ports read `error_message`. Read both, and fix `references/esewa.md`.
- [ ] **Malformed eSewa `data` → 500.** Bad base64/JSON in a forged callback throws a raw `SyntaxError` in TS. Throw `PaymentError("malformed_callback", 400)` like the JVM/PHP/Go ports.
- [ ] **NPS `code:"0"` with `data:null`** crashes TS with a `TypeError`. Return `unknown` / `malformed_response`.
- [ ] **Provider lookup by name** uses `id in built`, so `/payments/constructor/return` reaches `Object.prototype` (TypeError in `examples/server.ts`). Use `Object.hasOwn` / a `Map`; same for the `STATUS[x]` lookup tables.
- [ ] **`basicAuth` uses `btoa`**, which throws on non-Latin-1 credentials. Encode UTF-8.
- [ ] **`paisaToRupees(-1..-99)`** loses the sign in TS (`-5` → `"0.05"`). Unreachable from adapters, but fix it.
- [ ] **connectIPS `txnAmt: null`** becomes `0` in TS (`Number(null)`); return `null` like Python.
- [ ] **`newOrderId` modulo bias** (`b % 36`) in TS; use rejection sampling like PHP.
- [ ] **TS/Python divergences** to settle in one direction: eSewa `orderIdFromCallback` key order, `??` vs `or` empty-string fallbacks (connectIPS `referenceId`, CyberSource `req_reference_number`), error-code naming (`esewa_<code>` vs `http_<status>`), `rupeesToPaisa` accepting `"1e3"`/`"+5"` in Python.
- [ ] Stale comment in `esewa.ts` pointing at `test/vectors.test.ts`.

## Docs

- [ ] Full Go wiring section in `references/web.md` (net/http, chi, Gin) with a runnable snippet.
- [ ] Runnable demo servers for Java, Kotlin, PHP and Go like `scripts/ts/examples/server.ts`.
- [ ] `references/env.md`: optional `CONNECTIPS_PFX_PATH` / `CONNECTIPS_PFX_PASSWORD` for the Java, Kotlin and PHP ports, which can read `.pfx` directly.

## Verification still owed

- [ ] Re-run the eSewa Intent sandbox checks once eSewa's Intent service is back (all ports got `Service is currently unavailable` on 2026-11-05).
- [ ] Run the Khalti sandbox checks with a test key (`KHALTI_SECRET_KEY`).
- [ ] Live runs for connectIPS, CyberSource, NPS and IME Pay with merchant credentials (signing is verified offline only).
- [ ] CI: GitHub Actions is blocked by an account billing lock. Once cleared, run `gh workflow run ci.yml` and fix anything the Linux runners catch (JDK 21 and PHP 8.5 on CI were only stood in for locally by JDK 26 and the composer image).

## Distribution

- [ ] Publish the PHP package to Packagist and tag a Go module version so they can be installed without copying.
- [ ] Go: optional `.pfx` support (stdlib can't read PKCS#12; would need a third-party module).

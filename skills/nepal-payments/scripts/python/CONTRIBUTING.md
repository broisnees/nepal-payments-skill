# Contributing to the Python adapters

Standard library only, Python 3.10+. `cryptography` is needed only by RSA providers (connectIPS,
NEPALPAY QR) and is imported lazily inside `core/crypto.py`. Do not add runtime dependencies.

```bash
cd scripts/python
python3 -m unittest discover -s tests -v   # all tests, offline (HTTP is mocked)
ruff check . && ruff format --check .      # config in pyproject.toml (line length 100)
```

## Layout

```
nepal_payments/
  __init__.py            public API: classes, create_payments, config_from_env, new_order_id, ...
  core/                  shared by every provider; no provider-specific code here
    types.py             VerifyResult, RedirectResult, FormResult, QrResult, SdkResult, PaymentStatus
    errors.py            PaymentError + http_error() for failed HTTP answers
    money.py             paisa <-> rupees (integer paisa everywhere, convert only at the edge)
    encoding.py          base64 helpers, js_string() (JavaScript String(v) rendering)
    crypto.py            HMAC, constant-time compare, RSA sign/verify/encrypt, .pfx loading
    http.py              http() with timeouts and retries, HttpResponse, basic_auth()
    state_machine.py     decide_transition(): what to write after verify()
    html.py              render_auto_submit_form()
  providers/
    __init__.py          PROVIDER_CLASSES and ENV_READERS registries
    <id>/
      __init__.py        exports the class and public helpers
      config.py          sandbox credentials / limits + from_env() (the <ID>_* variables)
      endpoints.py       URLs per environment + provider status -> PaymentStatus maps
      signing.py         pure signing functions (no I/O), the code most worth testing
      responses.py       TypedDicts for provider answers + small parsers (error codes, messages)
      adapter.py         the class; every http() call lives here
      README.md          flow, which file does what, provider quirks
tests/
  helpers.py             resp(), b64json(), new_rsa_key()
  core/test_*.py         one file per core module
  providers/test_<id>.py one file per provider
```

## Conventions

- Amounts are integer paisa in every public signature. Call `assert_paisa()` first in `initiate()`.
- `verify()` must ask the provider (status API) or check a signed payload. A redirect alone is
  never proof of payment. Map every provider status onto exactly one `PaymentStatus`; anything
  unmapped is `"unknown"`.
- Raise `PaymentError(message, provider, code, http_status, details)`. `code` is stable and
  machine-readable: tests and callers branch on it, so never change an existing one.
- Use `http_error(provider, res, "<Provider> <call> failed", detail=..., code=...)` for HTTP answers
  that are not a usable success. Provider-specific extraction of the message/code goes in
  `responses.py`.
- Retry only idempotent reads (`retries=2` on status calls), never payment creation.
- Keep every comment that explains a provider quirk ("why"), and repeat the important ones in the
  provider README.
- Lines <= 100 characters, small named functions, early returns, type hints, docstrings on public
  methods. Prefer a TypedDict or `Mapping` over `Any`.

## Adding a gateway: checklist

1. **Read the provider docs** and write down: the flow, the signature algorithm and exact message
   format, status values, error body shape, sandbox credentials, amount format (paisa or rupees,
   decimals), and order id limits.
2. **Create `nepal_payments/providers/<id>/`** by copying the closest existing provider
   (`esewa` for signed forms, `khalti` for redirect APIs, `nepalpay` for QR, `getpay` for browser SDKs).
3. **`endpoints.py`**: `URLS` (or `BASE`) for `"sandbox"` and `"production"`, and a
   `dict[str, PaymentStatus]` status map.
4. **`signing.py`**: pure functions with a public name (`<id>_sign`). Add the provider's published
   test vector to the tests before writing the adapter; if the docs' examples are wrong, say so in
   a comment and use a vector you verified in sandbox.
5. **`responses.py`**: a `TypedDict(total=False)` per answer you read, plus error helpers.
6. **`adapter.py`**: a class with `id = "<id>"` and at least
   - `__init__(self, env, <credentials>, ..., timeout=...)`
   - `initiate(self, order_id, amount_paisa, description, return_url, ..., **_) -> InitiateResult`
   - `verify(self, order_id, amount_paisa, provider_ref=None, callback=None) -> VerifyResult`
   - `order_id_from_callback(params) -> Optional[str]` (staticmethod)
   Import `http` by name into `adapter.py` so tests can patch
   `nepal_payments.providers.<id>.adapter.http`.
7. **`config.py`**: `from_env(env) -> Optional[dict]` returning the constructor kwargs when the
   required `<ID>_*` variables are set (use `env_mode()` for `<ID>_ENV`), else `None`.
8. **`__init__.py`** of the provider: export the class and public helpers, with `__all__`.
9. **Register it**: add the class and `config.from_env` to `PROVIDER_CLASSES` / `ENV_READERS` in
   `providers/__init__.py`, the id to `ProviderId` in `core/types.py`, and the class (plus any
   helper users need) to `nepal_payments/__init__.py` and its `__all__`.
10. **Tests** in `tests/providers/test_<id>.py`: signature vectors, `initiate()` fields, every
    status mapping, error codes, callback mismatch / bad signature, and amount validation.
11. **`README.md`** in the provider folder: 10-20 lines with the flow, a file table and quirks.
12. Run the test suite and ruff. Then update the docs outside this folder
    (`references/<id>.md`, `references/env.md`, the TypeScript port) so every port stays in step.

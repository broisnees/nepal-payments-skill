"""Shared primitives for every provider adapter.

Standard library only (Python >= 3.10). RSA-signing providers (connectIPS, NEPALPAY QR)
additionally need `cryptography` (pip install cryptography).

Everything is re-exported here, so `from nepal_payments.core import X` works for any helper.
Note: `nepal_payments.core.http` is the `http()` function; the module is `core/http.py`.
"""

from .crypto import (
    hmac_digest,
    load_pfx_private_key_pem,
    rsa_pkcs1_encrypt_b64,
    rsa_sha256_sign_b64,
    rsa_sha256_verify_b64,
    safe_equal,
)
from .encoding import b64decode_lenient, b64encode, base64_json, js_string
from .errors import PaymentError, http_error
from .html import render_auto_submit_form
from .http import HttpResponse, basic_auth, http
from .money import assert_paisa, paisa_to_rupees, paisa_to_rupees_2dp, rupees_to_paisa
from .state_machine import OPEN_STATUSES, TransitionDecision, decide_transition
from .types import (
    Environment,
    FormResult,
    InitiateResult,
    PaymentStatus,
    ProviderId,
    QrResult,
    RawResponse,
    RedirectResult,
    SdkResult,
    VerifyResult,
    env_mode,
)

__all__ = [
    "OPEN_STATUSES",
    "Environment",
    "FormResult",
    "HttpResponse",
    "InitiateResult",
    "PaymentError",
    "PaymentStatus",
    "ProviderId",
    "QrResult",
    "RawResponse",
    "RedirectResult",
    "SdkResult",
    "TransitionDecision",
    "VerifyResult",
    "assert_paisa",
    "b64decode_lenient",
    "b64encode",
    "base64_json",
    "basic_auth",
    "decide_transition",
    "env_mode",
    "hmac_digest",
    "http",
    "http_error",
    "js_string",
    "load_pfx_private_key_pem",
    "paisa_to_rupees",
    "paisa_to_rupees_2dp",
    "render_auto_submit_form",
    "rsa_pkcs1_encrypt_b64",
    "rsa_sha256_sign_b64",
    "rsa_sha256_verify_b64",
    "rupees_to_paisa",
    "safe_equal",
]

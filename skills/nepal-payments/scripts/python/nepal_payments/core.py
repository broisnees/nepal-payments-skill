"""Shared primitives for every provider adapter.

Standard library only (Python >= 3.10). RSA-signing providers (connectIPS, NEPALPAY QR)
additionally need `cryptography` (pip install cryptography).
"""

from __future__ import annotations

import base64
import hashlib
import hmac as _hmac
import html
import json
import re
import time
import urllib.error
import urllib.request
from http.client import HTTPException, IncompleteRead
from dataclasses import dataclass, field
from decimal import ROUND_HALF_UP, Decimal
from typing import Any, Literal, Mapping, Optional, Union

ProviderId = Literal["esewa", "khalti", "fonepay", "connectips", "cybersource", "nps", "imepay", "nepalpay",
                     "hamropay", "getpay"]

# Normalized payment state. Map every provider status onto exactly one of these.
PaymentStatus = Literal[
    "paid",                # money captured; safe to fulfil
    "pending",             # not settled yet; re-check later, do NOT fulfil
    "failed",              # declined / error; let the user retry with a NEW order id
    "canceled",            # user backed out
    "expired",             # session timed out before payment
    "refunded",
    "partially_refunded",
    "not_found",           # provider has no record (never started, or wrong env/credentials)
    "unknown",             # unmapped; treat like pending and alert
]


@dataclass
class VerifyResult:
    provider: str
    status: PaymentStatus
    order_id: str
    amount_paisa: Optional[int]   # what the PROVIDER says was paid
    transaction_id: Optional[str] # provider final txn id (eSewa ref_id, Khalti transaction_id...)
    raw: Any = None


@dataclass
class RedirectResult:
    url: str
    provider_ref: Optional[str] = None
    expires_at: Optional[str] = None
    raw: Any = None
    kind: str = "redirect"


@dataclass
class FormResult:
    action: str
    fields: dict
    method: str = "POST"
    enctype: Optional[str] = None       # NPS requires "multipart/form-data"
    provider_ref: Optional[str] = None  # persist when set (e.g. NPS ProcessId)
    kind: str = "form"


@dataclass
class QrResult:
    """Show a QR the payer scans from their own app (NEPALPAY QR). Render `qr_string` with any QR library, or
    `<img src="data:image/png;base64,{qr_image}">` when the provider sent an image. Persist `provider_ref`."""
    qr_string: str
    provider_ref: str
    qr_image: Optional[str] = None
    raw: Any = None
    kind: str = "qr"


@dataclass
class SdkResult:
    """Load `script_url` in the browser and start the provider's own checkout with `options` (GetPay). The adapter
    ships the page helpers (GetPay.checkout_page / payment_page / return_page)."""
    script_url: str
    options: dict
    provider_ref: Optional[str] = None
    kind: str = "sdk"


InitiateResult = Union[RedirectResult, FormResult, QrResult, SdkResult]


OPEN_STATUSES = ("initiated", "pending", "unknown")
_CLOSED_UNPAID = ("failed", "canceled", "expired", "not_found")


@dataclass
class TransitionDecision:
    next: Optional[str]      # status to write, or None to write nothing
    review_required: bool    # stop automation, alert a human
    late_paid: bool          # provider says paid after we had closed the attempt
    reason: str


def decide_transition(prev: str, status: str, amount_paisa: Optional[int], stored_amount_paisa: int,
                      attempt_age_s: float, session_window_s: float = 3600) -> TransitionDecision:
    """Pure state-machine decision for a verify() result (references/architecture.md §2, §4).
    Apply `next` with a conditional UPDATE guarded by `prev`; fulfil only if next == "paid"."""
    late_paid = status == "paid" and prev in _CLOSED_UNPAID
    if prev not in OPEN_STATUSES and not late_paid:
        return TransitionDecision(None, False, False, f"attempt already {prev}")
    if status == "paid" and amount_paisa != stored_amount_paisa:
        why = ("provider returned no amount for a paid status" if amount_paisa is None
               else f"amount mismatch: stored {stored_amount_paisa}, provider {amount_paisa}")
        return TransitionDecision("unknown", True, late_paid, why)
    nxt = status
    if nxt == "not_found":
        if attempt_age_s < session_window_s:
            return TransitionDecision(None, False, False, "not_found inside session window")
        nxt = "expired"
    if nxt == prev:
        return TransitionDecision(None, False, False, "unchanged")
    return TransitionDecision(nxt, False, late_paid, f"late payment (was {prev})" if late_paid else f"{prev} -> {nxt}")


class PaymentError(Exception):
    def __init__(self, message: str, provider: str, code: str,
                 http_status: Optional[int] = None, details: Any = None):
        super().__init__(message)
        self.provider = provider
        self.code = code
        self.http_status = http_status
        self.details = details


# ---------------------------------------------------------------------------
# Money: integer paisa everywhere; convert only at the edge.
# ---------------------------------------------------------------------------

def assert_paisa(paisa: int, provider: str) -> None:
    if not isinstance(paisa, int) or isinstance(paisa, bool) or paisa <= 0:
        raise PaymentError(f"amount must be a positive integer in paisa, got {paisa!r}", provider, "invalid_amount")


def paisa_to_rupees(paisa: int) -> str:
    """12345 -> '123.45', 10000 -> '100'."""
    rupees, rem = divmod(abs(paisa), 100)
    sign = "-" if paisa < 0 else ""
    return f"{sign}{rupees}" if rem == 0 else f"{sign}{rupees}.{rem:02d}"


_RUPEES = re.compile(r"-?\d+(\.\d+)?")


def rupees_to_paisa(rupees: Union[str, int, float, Decimal]) -> int:
    """'123.45' | 123.45 | '100' -> paisa. Rounds half away from zero on the 3rd decimal."""
    s = str(rupees).strip().replace(",", "")
    if not _RUPEES.fullmatch(s):  # Decimal alone would take "1e3", "+5", "NaN"
        raise ValueError(f"not a rupee amount: {rupees!r}")
    d = Decimal(s)
    return int((d * 100).quantize(Decimal("1"), rounding=ROUND_HALF_UP))


# ---------------------------------------------------------------------------
# Encoding + crypto
# ---------------------------------------------------------------------------

def b64encode(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def b64decode_lenient(s: str) -> bytes:
    """Tolerates url-safe alphabet, missing padding, and '+' turned into ' ' by query parsers."""
    s = s.replace(" ", "+").strip().replace("-", "+").replace("_", "/")  # spaces first, or edge "+" is lost
    s += "=" * (-len(s) % 4)
    return base64.b64decode(s)


def base64_json(s: str) -> Any:
    return json.loads(b64decode_lenient(s).decode("utf-8"))


def hmac_digest(algo: Literal["sha256", "sha512"], key: Union[str, bytes], message: Union[str, bytes]) -> bytes:
    k = key.encode() if isinstance(key, str) else key
    m = message.encode() if isinstance(message, str) else message
    return _hmac.new(k, m, getattr(hashlib, algo)).digest()


def safe_equal(a: str, b: str) -> bool:
    return _hmac.compare_digest(a.encode(), b.encode())


def rsa_sha256_sign_b64(private_key_pem: bytes, message: str, password: Optional[bytes] = None) -> str:
    """RSA PKCS#1 v1.5 + SHA-256, base64. Accepts PEM (PKCS#1 or PKCS#8)."""
    try:
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import padding
    except ImportError as e:  # pragma: no cover
        raise RuntimeError("pip install cryptography  (needed for RSA-signed providers)") from e
    key = serialization.load_pem_private_key(private_key_pem, password=password)
    sig = key.sign(message.encode(), padding.PKCS1v15(), hashes.SHA256())
    return b64encode(sig)


def _load_spki(public_key_pem: Union[str, bytes]):
    """SPKI "-----BEGIN PUBLIC KEY-----". From a certificate (.cer/.crt):
    openssl x509 -in NPI.cer [-inform der] -pubkey -noout > npi.pub.pem"""
    try:
        from cryptography.hazmat.primitives import serialization
    except ImportError as e:  # pragma: no cover
        raise RuntimeError("pip install cryptography  (needed for RSA-signed providers)") from e
    pem = public_key_pem.encode() if isinstance(public_key_pem, str) else public_key_pem
    if b"BEGIN PUBLIC KEY" not in pem:
        raise ValueError("expected a PUBLIC KEY PEM; extract it from the certificate with: "
                         "openssl x509 -in NPI.cer -pubkey -noout")
    return serialization.load_pem_public_key(pem)


def rsa_sha256_verify_b64(public_key_pem: Union[str, bytes], message: str, signature_b64: str) -> bool:
    """Verify an RSA PKCS#1 v1.5 + SHA-256 signature (base64). False on any malformed input."""
    try:
        from cryptography.hazmat.primitives import hashes
        from cryptography.hazmat.primitives.asymmetric import padding
        key = _load_spki(public_key_pem)
        key.verify(base64.b64decode(signature_b64, validate=True), message.encode(), padding.PKCS1v15(),  # type: ignore[union-attr,call-arg]
                   hashes.SHA256())
        return True
    except Exception:
        return False


def rsa_pkcs1_encrypt_b64(public_key_pem: Union[str, bytes], plaintext: str) -> str:
    """RSA PKCS#1 v1.5 encryption ("RSA/ECB/PKCS1Padding"), base64 output."""
    from cryptography.hazmat.primitives.asymmetric import padding
    key = _load_spki(public_key_pem)
    m = plaintext.encode()
    k = (key.key_size + 7) // 8  # type: ignore[union-attr]
    if len(m) > k - 11:
        raise ValueError(f"plaintext too long for a {k * 8}-bit RSA key (max {k - 11} bytes)")
    return b64encode(key.encrypt(m, padding.PKCS1v15()))  # type: ignore[union-attr,call-arg]


def load_pfx_private_key_pem(pfx_bytes: bytes, password: str) -> bytes:
    """Extract the private key from a .pfx/.p12 (e.g. connectIPS CREDITOR.pfx) as PKCS#8 PEM."""
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.serialization import pkcs12
    key, _cert, _chain = pkcs12.load_key_and_certificates(pfx_bytes, password.encode())
    if key is None:
        raise ValueError("no private key in pfx")
    return key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                             serialization.NoEncryption())


def basic_auth(user: str, password: str) -> str:
    return "Basic " + b64encode(f"{user}:{password}".encode())


# ---------------------------------------------------------------------------
# HTTP with timeouts. Retries only for idempotent reads (status checks).
# ---------------------------------------------------------------------------

@dataclass
class HttpResponse:
    status: int
    data: Any
    text: str
    headers: Mapping[str, str] = field(default_factory=dict)


def _read_text(res: Any) -> str:
    """Read the body as text. A body cut off mid-stream is kept only when what arrived is complete JSON:
    Hamro Pay (grpc-gateway behind Envoy) aborts the chunked stream after its error answers."""
    try:
        raw = res.read()
    except IncompleteRead as e:
        raw = e.partial
        try:
            json.loads(raw.decode("utf-8", "replace"))
        except ValueError:
            raise e from None
    return raw.decode("utf-8", "replace")


def http(provider: str, url: str, method: str = "GET", headers: Optional[Mapping[str, str]] = None,
         body: Any = None, timeout: float = 15.0, retries: int = 0) -> HttpResponse:
    hdrs = {"Accept": "application/json", "User-Agent": "nepal-payments/1.0", **(headers or {})}
    data: Optional[bytes] = None
    if body is not None:
        if isinstance(body, (bytes, str)):
            data = body.encode() if isinstance(body, str) else body
        else:
            data = json.dumps(body).encode()
        if not any(h.lower() == "content-type" for h in hdrs):
            hdrs["Content-Type"] = "application/json"

    last_err: Optional[BaseException] = None
    for attempt in range(retries + 1):
        if attempt:
            time.sleep(0.3 * 2 ** (attempt - 1))
        req = urllib.request.Request(url, data=data, method=method, headers=hdrs)
        try:
            try:
                with urllib.request.urlopen(req, timeout=timeout) as res:
                    status, text, rh = res.status, _read_text(res), dict(res.headers)
            except urllib.error.HTTPError as e:  # 4xx/5xx still carry a body we want
                status, text, rh = e.code, _read_text(e), dict(e.headers or {})
        except (urllib.error.URLError, TimeoutError, OSError, HTTPException) as e:
            last_err = e
            continue
        if (status >= 500 or status == 429) and attempt < retries:
            last_err = PaymentError(f"HTTP {status}", provider, "upstream_error", status, text)
            continue
        try:
            parsed: Any = json.loads(text) if text else None
        except ValueError:
            parsed = text
        return HttpResponse(status, parsed, text, rh)
    raise PaymentError(f"request to {url} failed: {last_err}", provider, "network_error", details=last_err)


def render_auto_submit_form(r: FormResult) -> str:
    inputs = "".join(
        f'<input type="hidden" name="{html.escape(k, quote=True)}" value="{html.escape(str(v), quote=True)}">'
        for k, v in r.fields.items()
    )
    return (
        '<!doctype html><html><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width,initial-scale=1"><title>Redirecting to payment…</title>'
        f'</head><body><form id="f" method="POST" action="{html.escape(r.action, quote=True)}"'
        + (f' enctype="{html.escape(r.enctype, quote=True)}"' if r.enctype else "")
        + f'>{inputs}'
        '<noscript><button type="submit">Continue to payment</button></noscript></form>'
        '<script>document.getElementById("f").submit()</script></body></html>'
    )

"""Result types shared by every provider adapter.

`initiate()` returns one of the four `InitiateResult` shapes;
`verify()` always returns a `VerifyResult`.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal, Optional, Union

ProviderId = Literal[
    "esewa",
    "khalti",
    "fonepay",
    "connectips",
    "cybersource",
    "nps",
    "imepay",
    "nepalpay",
    "hamropay",
    "getpay",
]

Environment = Literal["sandbox", "production"]

# Normalized payment state. Map every provider status onto exactly one of these.
PaymentStatus = Literal[
    "paid",  # money captured; safe to fulfil
    "pending",  # not settled yet; re-check later, do NOT fulfil
    "failed",  # declined / error; let the user retry with a NEW order id
    "canceled",  # user backed out
    "expired",  # session timed out before payment
    "refunded",
    "partially_refunded",
    "not_found",  # provider has no record (never started, or wrong env/credentials)
    "unknown",  # unmapped; treat like pending and alert
]

# The provider's own response, kept untouched for logging and debugging. Its shape differs per
# provider (see each provider's responses.py), so it is deliberately untyped here.
RawResponse = Any


@dataclass
class VerifyResult:
    provider: str
    status: PaymentStatus
    order_id: str
    amount_paisa: Optional[int]  # what the PROVIDER says was paid
    transaction_id: Optional[str]  # provider final txn id (eSewa ref_id, Khalti transaction_id...)
    raw: RawResponse = None


@dataclass
class RedirectResult:
    url: str
    provider_ref: Optional[str] = None
    expires_at: Optional[str] = None
    raw: RawResponse = None
    kind: str = "redirect"


@dataclass
class FormResult:
    action: str
    fields: dict
    method: str = "POST"
    enctype: Optional[str] = None  # NPS requires "multipart/form-data"
    provider_ref: Optional[str] = None  # persist when set (e.g. NPS ProcessId)
    kind: str = "form"


@dataclass
class QrResult:
    """Show a QR the payer scans from their own app (NEPALPAY QR).

    Render `qr_string` with any QR library, or `<img src="data:image/png;base64,{qr_image}">`
    when the provider sent an image. Persist `provider_ref`.
    """

    qr_string: str
    provider_ref: str
    qr_image: Optional[str] = None
    raw: RawResponse = None
    kind: str = "qr"


@dataclass
class SdkResult:
    """Load `script_url` in the browser and start the provider's checkout with `options` (GetPay).

    The adapter ships the page helpers (GetPay.checkout_page / payment_page / return_page).
    """

    script_url: str
    options: dict
    provider_ref: Optional[str] = None
    kind: str = "sdk"


InitiateResult = Union[RedirectResult, FormResult, QrResult, SdkResult]


def env_mode(value: Optional[str]) -> Environment:
    """Normalize an *_ENV variable: "production" or "live" -> production, else sandbox."""
    if value in ("production", "live"):
        return "production"
    return "sandbox"

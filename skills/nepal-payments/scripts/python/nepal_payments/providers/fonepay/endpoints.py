"""Fonepay URLs per environment and the status -> PaymentStatus map."""

from __future__ import annotations

import re

from ...core.types import PaymentStatus

_DEV_MERCHANT_API = "https://dev-merchantapi.fonepay.com/api/merchant/merchantDetailsForThirdParty"
_MERCHANT_API = "https://merchantapi.fonepay.com/api/merchant/merchantDetailsForThirdParty"

URLS: dict[str, dict[str, str]] = {
    "sandbox": {
        "payment": "https://dev-clientapi.fonepay.com/api/merchantRequest",
        "legacy_verify": (
            "https://dev-clientapi.fonepay.com/api/merchantRequest/verificationMerchant"
        ),
        "txn_verification": f"{_DEV_MERCHANT_API}/txnVerification",
        "qr_base": _DEV_MERCHANT_API,
    },
    "production": {
        "payment": "https://clientapi.fonepay.com/api/merchantRequest",
        "legacy_verify": "https://clientapi.fonepay.com/api/merchantRequest/verificationMerchant",
        "txn_verification": f"{_MERCHANT_API}/txnVerification",
        "qr_base": _MERCHANT_API,
    },
}

# Resource path signed into the txnVerification `auth` header.
TXN_RESOURCE = "/merchant/merchantDetailsForThirdParty/txnVerification"

# Keys are paymentStatus lower-cased (txnVerification and Dynamic QR status).
TXN_STATUS: dict[str, PaymentStatus] = {"success": "paid", "pending": "pending", "failed": "failed"}


def public_websocket_url(url: str, env: str) -> str:
    """Fonepay sometimes answers a QR WebSocket URL on "localhost": point it at the real host."""
    if "localhost" not in url:
        return url
    host = "wss://ws.fonepay.com" if env == "production" else "wss://dev-ws.fonepay.com"
    return re.sub(r"^wss?://[^/]+", host, url)

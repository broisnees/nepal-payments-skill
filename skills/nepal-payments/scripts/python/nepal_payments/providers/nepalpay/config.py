"""NEPALPAY QR credentials: the NEPALPAY_* variables read by config_from_env().

Onboarding via your bank (or businesssupport@nchl.com.np) -> acquirerId, merchantId, MCC,
NPI username/password, and the signing .pfx (NPI.pfx in UAT).
"""

from __future__ import annotations

from typing import Any, Mapping, Optional

from ...core.types import env_mode

_REQUIRED = (
    "NEPALPAY_ACQUIRER_ID",
    "NEPALPAY_MERCHANT_ID",
    "NEPALPAY_USERNAME",
    "NEPALPAY_PRIVATE_KEY_PEM",
)


def _pem(value: str) -> bytes:
    """PEM from an env var that may hold literal "\\n" sequences (one-line env files)."""
    return value.replace("\\n", "\n").encode()


def from_env(env: Mapping[str, str]) -> Optional[dict[str, Any]]:
    """NepalPay(**kwargs) from NEPALPAY_* variables, or None when not configured.

    NEPALPAY_CLIENT_ID switches to OAuth; NEPALPAY_NCHL_PUBLIC_KEY_PEM and NEPALPAY_WS_URL enable
    notification checks and the WebSocket channel.
    """
    if not all(env.get(name) for name in _REQUIRED):
        return None
    kwargs: dict[str, Any] = {
        "env": env_mode(env.get("NEPALPAY_ENV")),
        "acquirer_id": env["NEPALPAY_ACQUIRER_ID"],
        "merchant_id": env["NEPALPAY_MERCHANT_ID"],
        "merchant_name": env.get("NEPALPAY_MERCHANT_NAME", ""),
        "merchant_category_code": env.get("NEPALPAY_MCC", ""),
        "merchant_city": env.get("NEPALPAY_MERCHANT_CITY", "Kathmandu"),
        "merchant_postal_code": env.get("NEPALPAY_MERCHANT_POSTAL_CODE", "44600"),
        "store_label": env.get("NEPALPAY_STORE_LABEL", "Store1"),
        "terminal_label": env.get("NEPALPAY_TERMINAL_LABEL"),
        "username": env["NEPALPAY_USERNAME"],
        "password": env.get("NEPALPAY_PASSWORD", ""),
        "private_key_pem": _pem(env["NEPALPAY_PRIVATE_KEY_PEM"]),
    }
    if env.get("NEPALPAY_CLIENT_ID"):
        kwargs.update(
            auth="oauth",
            client_id=env["NEPALPAY_CLIENT_ID"],
            client_secret=env.get("NEPALPAY_CLIENT_SECRET", ""),
        )
    if env.get("NEPALPAY_NCHL_PUBLIC_KEY_PEM"):
        kwargs["nchl_public_key_pem"] = _pem(env["NEPALPAY_NCHL_PUBLIC_KEY_PEM"])
    if env.get("NEPALPAY_WS_URL"):
        kwargs.update(
            ws_url=env["NEPALPAY_WS_URL"],
            ws_username=env.get("NEPALPAY_WS_USERNAME"),
            ws_api_token=env.get("NEPALPAY_WS_API_TOKEN"),
        )
    return kwargs

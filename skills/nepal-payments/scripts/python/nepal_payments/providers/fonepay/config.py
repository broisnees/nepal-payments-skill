"""Fonepay credentials: the FONEPAY_* variables read by config_from_env()."""

from __future__ import annotations

from typing import Any, Mapping, Optional

from ...core.types import env_mode


def from_env(env: Mapping[str, str]) -> Optional[dict[str, Any]]:
    """Fonepay(**kwargs) from FONEPAY_* variables, or None when the provider is not configured.

    FONEPAY_USERNAME / FONEPAY_PASSWORD enable txnVerification and Dynamic QR.
    """
    if not (env.get("FONEPAY_MERCHANT_CODE") and env.get("FONEPAY_SECRET_KEY")):
        return None
    return {
        "env": env_mode(env.get("FONEPAY_ENV")),
        "merchant_code": env["FONEPAY_MERCHANT_CODE"],
        "secret_key": env["FONEPAY_SECRET_KEY"],
        "username": env.get("FONEPAY_USERNAME"),
        "password": env.get("FONEPAY_PASSWORD"),
    }

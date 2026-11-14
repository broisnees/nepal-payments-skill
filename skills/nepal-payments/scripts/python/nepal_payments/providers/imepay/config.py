"""IME Pay credentials: the IMEPAY_* variables read by config_from_env()."""

from __future__ import annotations

from typing import Any, Mapping, Optional

from ...core.types import env_mode


def from_env(env: Mapping[str, str]) -> Optional[dict[str, Any]]:
    """ImePay(**kwargs) from IMEPAY_* variables, or None when the provider is not configured."""
    if not (env.get("IMEPAY_MERCHANT_CODE") and env.get("IMEPAY_USERNAME")):
        return None
    return {
        "env": env_mode(env.get("IMEPAY_ENV")),
        "merchant_code": env["IMEPAY_MERCHANT_CODE"],
        "username": env["IMEPAY_USERNAME"],
        "password": env.get("IMEPAY_PASSWORD", ""),
        "module": env.get("IMEPAY_MODULE", ""),
    }

"""NPS credentials: the NPS_* variables read by config_from_env()."""

from __future__ import annotations

from typing import Any, Mapping, Optional

from ...core.types import env_mode


def from_env(env: Mapping[str, str]) -> Optional[dict[str, Any]]:
    """Nps(**kwargs) from NPS_* variables, or None when the provider is not configured."""
    if not (env.get("NPS_MERCHANT_ID") and env.get("NPS_SECRET_KEY")):
        return None
    return {
        "env": env_mode(env.get("NPS_ENV")),
        "merchant_id": env["NPS_MERCHANT_ID"],
        "merchant_name": env.get("NPS_MERCHANT_NAME", ""),
        "api_username": env.get("NPS_API_USERNAME", ""),
        "api_password": env.get("NPS_API_PASSWORD", ""),
        "secret_key": env["NPS_SECRET_KEY"],
    }

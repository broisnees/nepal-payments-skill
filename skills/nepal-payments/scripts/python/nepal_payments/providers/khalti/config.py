"""Khalti credentials: the KHALTI_* variables read by config_from_env()."""

from __future__ import annotations

from typing import Any, Mapping, Optional

from ...core.types import env_mode


def from_env(env: Mapping[str, str]) -> Optional[dict[str, Any]]:
    """Khalti(**kwargs) from KHALTI_* variables, or None when the provider is not configured."""
    if not (env.get("KHALTI_SECRET_KEY") and env.get("KHALTI_WEBSITE_URL")):
        return None
    return {
        "env": env_mode(env.get("KHALTI_ENV")),
        "secret_key": env["KHALTI_SECRET_KEY"],
        "website_url": env["KHALTI_WEBSITE_URL"],
    }

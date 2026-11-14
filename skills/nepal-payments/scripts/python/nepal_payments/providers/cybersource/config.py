"""CyberSource credentials: the CYBERSOURCE_* variables read by config_from_env().

profile_id / access_key / secret_key are issued by the acquiring bank (Secure Acceptance profile).
"""

from __future__ import annotations

from typing import Any, Mapping, Optional

from ...core.types import env_mode


def from_env(env: Mapping[str, str]) -> Optional[dict[str, Any]]:
    """CyberSource(**kwargs) from CYBERSOURCE_* variables, or None when not configured."""
    required = ("CYBERSOURCE_PROFILE_ID", "CYBERSOURCE_ACCESS_KEY", "CYBERSOURCE_SECRET_KEY")
    if not all(env.get(name) for name in required):
        return None
    return {
        "env": env_mode(env.get("CYBERSOURCE_ENV")),
        "profile_id": env["CYBERSOURCE_PROFILE_ID"],
        "access_key": env["CYBERSOURCE_ACCESS_KEY"],
        "secret_key": env["CYBERSOURCE_SECRET_KEY"],
        "currency": env.get("CYBERSOURCE_CURRENCY", "NPR"),
    }

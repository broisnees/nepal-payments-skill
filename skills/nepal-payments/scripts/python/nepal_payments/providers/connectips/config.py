"""connectIPS credentials: the CONNECTIPS_* variables read by config_from_env().

NCHL issues MERCHANTID, APPID, APPNAME, the app password and the creditor .pfx. Load the key once:
    pem = load_pfx_private_key_pem(
        open("CREDITOR.pfx", "rb").read(), os.environ["CONNECTIPS_PFX_PASSWORD"]
    )
"""

from __future__ import annotations

from typing import Any, Mapping, Optional

from ...core.types import env_mode


def from_env(env: Mapping[str, str]) -> Optional[dict[str, Any]]:
    """ConnectIps(**kwargs) from CONNECTIPS_* variables, or None when not configured.

    CONNECTIPS_PRIVATE_KEY_PEM may hold literal "\\n" sequences (one-line env files).
    """
    required = ("CONNECTIPS_MERCHANT_ID", "CONNECTIPS_APP_ID", "CONNECTIPS_PRIVATE_KEY_PEM")
    if not all(env.get(name) for name in required):
        return None
    return {
        "env": env_mode(env.get("CONNECTIPS_ENV")),
        "merchant_id": env["CONNECTIPS_MERCHANT_ID"],
        "app_id": env["CONNECTIPS_APP_ID"],
        "app_name": env.get("CONNECTIPS_APP_NAME", ""),
        "app_password": env.get("CONNECTIPS_APP_PASSWORD", ""),
        "private_key_pem": env["CONNECTIPS_PRIVATE_KEY_PEM"].replace("\\n", "\n").encode(),
    }

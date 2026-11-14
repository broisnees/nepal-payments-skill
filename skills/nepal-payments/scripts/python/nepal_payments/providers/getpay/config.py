"""GetPay credentials: the GETPAY_* variables read by config_from_env().

Credentials come from the acquiring bank: pap_info (base64 {institutionId, mid, tid}), opr_key,
ins_key (blank when operator-hosted), the bundle URL and the base URL.
"""

from __future__ import annotations

from typing import Any, Mapping, Optional

from ...core.types import env_mode

DEFAULT_CURRENCY = "NPR"
DEFAULT_THEME_COLOR = "#5662FF"


def from_env(env: Mapping[str, str]) -> Optional[dict[str, Any]]:
    """GetPay(**kwargs) from GETPAY_* variables, or None when the provider is not configured."""
    required = ("GETPAY_PAP_INFO", "GETPAY_OPR_KEY", "GETPAY_WEBSITE_DOMAIN")
    if not all(env.get(name) for name in required):
        return None
    return {
        "env": env_mode(env.get("GETPAY_ENV")),
        "pap_info": env["GETPAY_PAP_INFO"],
        "opr_key": env["GETPAY_OPR_KEY"],
        "ins_key": env.get("GETPAY_INS_KEY"),
        "website_domain": env["GETPAY_WEBSITE_DOMAIN"],
        "business_name": env.get("GETPAY_BUSINESS_NAME", ""),
        "image_url": env.get("GETPAY_IMAGE_URL", ""),
        "currency": env.get("GETPAY_CURRENCY"),
        "bundle_url": env.get("GETPAY_BUNDLE_URL"),
        "base_url": env.get("GETPAY_BASE_URL"),
    }

"""eSewa credentials: public sandbox values and the ESEWA_* variables read by config_from_env()."""

from __future__ import annotations

from typing import Any, Mapping, Optional

from ...core.types import env_mode

# Public test credentials published by eSewa. Never use them in production.
SANDBOX = {
    "product_code": "EPAYTEST",
    "secret_key": "8gBm/:&EnhH.1/q",
    "intent_product_code": "INTENT",
    # Used as a raw string, NOT base64-decoded.
    "intent_access_key": "LB0REg8HUSw3MTYrI1s6JTE8Kyc6JyAqJiA3MQ==",
}


def from_env(env: Mapping[str, str]) -> Optional[dict[str, Any]]:
    """Esewa(**kwargs) from ESEWA_* variables, or None when the provider is not configured."""
    if not (env.get("ESEWA_PRODUCT_CODE") and env.get("ESEWA_SECRET_KEY")):
        return None
    return {
        "env": env_mode(env.get("ESEWA_ENV")),
        "product_code": env["ESEWA_PRODUCT_CODE"],
        "secret_key": env["ESEWA_SECRET_KEY"],
        "intent_product_code": env.get("ESEWA_INTENT_PRODUCT_CODE"),
        "intent_access_key": env.get("ESEWA_INTENT_ACCESS_KEY"),
        "intent_base_url": env.get("ESEWA_INTENT_BASE_URL"),
    }

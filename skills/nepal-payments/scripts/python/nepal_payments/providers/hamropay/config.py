"""Hamro Pay credentials and limits: the HAMROPAY_* variables read by config_from_env().

UAT merchant portal https://pay-sandbox.hamropatro.com (signup OTP 000000) -> Client Credentials:
merchantId, Client-Id, Client-API-Key, client secret; Configuration -> Webhook gives the webhook
signing secret.
"""

from __future__ import annotations

from typing import Any, Mapping, Optional

from ...core.types import env_mode

# Hamro Pay accepts Rs 10 to Rs 50,000 per transaction.
HAMROPAY_MIN_PAISA = 1000
HAMROPAY_MAX_PAISA = 5_000_000


def from_env(env: Mapping[str, str]) -> Optional[dict[str, Any]]:
    """HamroPay(**kwargs) from HAMROPAY_* variables, or None when the provider is not configured."""
    required = (
        "HAMROPAY_MERCHANT_ID",
        "HAMROPAY_CLIENT_ID",
        "HAMROPAY_CLIENT_API_KEY",
        "HAMROPAY_CLIENT_SECRET",
    )
    if not all(env.get(name) for name in required):
        return None
    return {
        "env": env_mode(env.get("HAMROPAY_ENV")),
        "merchant_id": env["HAMROPAY_MERCHANT_ID"],
        "client_id": env["HAMROPAY_CLIENT_ID"],
        "client_api_key": env["HAMROPAY_CLIENT_API_KEY"],
        "client_secret": env["HAMROPAY_CLIENT_SECRET"],
        "webhook_secret": env.get("HAMROPAY_WEBHOOK_SECRET"),
        "api_base_url": env.get("HAMROPAY_API_BASE_URL"),
        "gateway_url": env.get("HAMROPAY_GATEWAY_URL"),
    }

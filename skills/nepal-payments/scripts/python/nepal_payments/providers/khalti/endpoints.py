"""Khalti hosts per environment and the lookup-status -> PaymentStatus map."""

from __future__ import annotations

from ...core.types import PaymentStatus

HOST = {"sandbox": "https://dev.khalti.com", "production": "https://khalti.com"}

# Keys are the lookup `status` lower-cased.
STATUS: dict[str, PaymentStatus] = {
    "completed": "paid",
    "pending": "pending",
    "initiated": "pending",
    "refunded": "refunded",
    "partially refunded": "partially_refunded",
    "expired": "expired",
    "user canceled": "canceled",
    "failed": "failed",
}


def api_base(host: str) -> str:
    """ePayment API root under a host."""
    return f"{host}/api/v2"


# Trailing slashes are REQUIRED (no slash -> 301 -> POST body lost).
INITIATE_PATH = "/epayment/initiate/"
LOOKUP_PATH = "/epayment/lookup/"

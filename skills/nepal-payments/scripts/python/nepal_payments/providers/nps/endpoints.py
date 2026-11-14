"""NPS URLs per environment and the provider-status -> PaymentStatus map."""

from __future__ import annotations

from typing import TypedDict

from ...core.types import PaymentStatus


class NpsUrls(TypedDict):
    api: str  # JSON API base; append /GetProcessId, /CheckTransactionStatus, ...
    gateway: str  # multipart form POST target for the payer's browser


URLS: dict[str, NpsUrls] = {
    "sandbox": {
        "api": "https://apisandbox.nepalpayment.com",
        "gateway": "https://gatewaysandbox.nepalpayment.com/Payment/Index",
    },
    "production": {
        "api": "https://apigateway.nepalpayment.com",
        "gateway": "https://gateway.nepalpayment.com/Payment/Index",
    },
}

# CheckTransactionStatus data.Status, lowercased.
STATUS: dict[str, PaymentStatus] = {
    "success": "paid",
    "fail": "failed",
    "failed": "failed",
    "pending": "pending",
}

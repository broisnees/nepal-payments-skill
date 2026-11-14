"""eSewa URLs per environment and the provider-status -> PaymentStatus maps."""

from __future__ import annotations

from typing import Optional, TypedDict

from ...core.types import PaymentStatus


class EsewaUrls(TypedDict):
    form: str  # ePay v2 form POST target
    status: str  # ePay v2 status API (GET)
    intent: Optional[str]  # Intent API base; append /book, /status, /cancel


URLS: dict[str, EsewaUrls] = {
    "sandbox": {
        "form": "https://rc-epay.esewa.com.np/api/epay/main/v2/form",
        "status": "https://rc.esewa.com.np/api/epay/transaction/status/",
        "intent": "https://rc-checkout.esewa.com.np/api/client/intent/payment",
    },
    "production": {
        "form": "https://epay.esewa.com.np/api/epay/main/v2/form",
        "status": "https://esewa.com.np/api/epay/transaction/status/",
        "intent": None,  # issued by eSewa at go-live
    },
}

EPAY_STATUS: dict[str, PaymentStatus] = {
    "COMPLETE": "paid",
    "PENDING": "pending",
    "AMBIGUOUS": "pending",
    "FULL_REFUND": "refunded",
    "PARTIAL_REFUND": "partially_refunded",
    "NOT_FOUND": "not_found",
    "CANCELED": "canceled",
}

INTENT_STATUS: dict[str, PaymentStatus] = {
    "SUCCESS": "paid",
    "BOOKED": "pending",
    "PENDING": "pending",
    "FAILED": "failed",
    "CANCELED": "canceled",
    "REVERTED": "refunded",
}

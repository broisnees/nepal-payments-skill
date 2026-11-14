"""Hamro Pay URLs per environment and the transaction-status -> PaymentStatus map."""

from __future__ import annotations

from ...core.types import PaymentStatus

# API base (server-to-server calls).
API = {
    "sandbox": "https://uat-payclient.hamropatro.com",
    "production": "https://payclient.hamropatro.com",
}

# Browser form target. Production has no default: Hamro Pay issues the live gateway host.
SANDBOX_GATEWAY = "https://uat-checkout-pay.hamropatro.com/api/checkout"

CREATE_SESSION_PATH = "/v1/checkout/sessionId"
GET_TRANSACTION_PATH = "/v1/checkout/transaction"

TXN_STATUS: dict[str, PaymentStatus] = {
    "COMPLETED": "paid",
    "FAILED": "failed",
    "PENDING": "pending",
    "PROCESSING": "pending",
    "NOT_INITIATED": "not_found",
    "CANCELED": "canceled",
    "CANCELLED": "canceled",
}

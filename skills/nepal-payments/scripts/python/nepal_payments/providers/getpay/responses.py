"""Shapes of GetPay answers."""

from __future__ import annotations

import re
from typing import Any, Optional, TypedDict, Union


class ReturnToken(TypedDict):
    """Decoded `token` from the success/fail redirect."""

    id: str  # GetPay transaction id
    oprSecret: str  # base64(SHA-256(oprKey + id))


class Envelope(TypedDict, total=False):
    """Every server answer: status 0 = OK, -1 = error (message says why)."""

    status: int
    message: str
    data: dict[str, Any]


class MerchantStatus(TypedDict, total=False):
    """merchant-status data."""

    status: str  # key of TXN_STATUS
    amount: Union[int, float]  # rupees
    currency: str
    stan: str
    crrn: str
    clientId: str  # your clientRequestId (order_id)
    remarks: str


class Statement(TypedDict, total=False):
    """transaction-statement data: payer, masked PAN, scheme, stan, crrn."""

    transactionId: str
    clientRequestId: str
    saleTransactionAmount: Union[int, float]  # rupees
    status: str
    paymentScheme: str


def is_not_found(body: Optional[dict[str, Any]]) -> bool:
    """status -1 with a "... not found ..." message: GetPay has no such transaction."""
    if body is None or body.get("status") != -1:
        return False
    return re.search(r"not found", str(body.get("message")), re.I) is not None


def error_message(body: Optional[dict[str, Any]], text: str) -> str:
    if body is not None and body.get("message") is not None:
        return str(body["message"])
    return text[:200]

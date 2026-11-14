"""Shapes of connectIPS answers."""

from __future__ import annotations

from typing import Any, Optional, TypedDict, Union

from ...core.types import PaymentStatus


class ValidationResponse(TypedDict, total=False):
    """validatetxn / gettxndetail answer.

    gettxndetail also carries creditStatus: "000" | "999" | "DEFER" = credited / OK.
    """

    merchantId: Union[int, str]
    appId: str
    referenceId: str
    txnAmt: Union[str, int, float]  # paisa
    token: str
    status: str  # "SUCCESS" | "FAILED" | "ERROR"
    statusDesc: str
    creditStatus: str


def map_status(response: ValidationResponse) -> PaymentStatus:
    """SUCCESS / FAILED are final; otherwise read statusDesc ("TRANSACTION NOT FOUND", ...)."""
    description = str(response.get("statusDesc", "")).upper()
    if response["status"] == "SUCCESS":
        return "paid"
    if response["status"] == "FAILED":
        return "failed"
    if "NOT FOUND" in description:
        return "not_found"
    if "INCOMPLETE" in description:
        return "pending"
    return "unknown"


def paid_amount_paisa(response: ValidationResponse) -> Optional[int]:
    """txnAmt (already paisa) as int; None when absent or not a number."""
    value: Any = response.get("txnAmt")
    if value is None:
        return None
    try:
        return round(float(value))
    except (TypeError, ValueError):
        return None

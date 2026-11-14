"""The signed response POST (receipt page / Merchant POST URL) and its decision mapping."""

from __future__ import annotations

from typing import TypedDict

from ...core.types import PaymentStatus
from .endpoints import UNCERTAIN_REASON_CODES


class BillTo(TypedDict, total=False):
    """`bill_to` argument of CyberSource.initiate()."""

    forename: str
    surname: str
    email: str
    address_line1: str
    city: str
    country: str  # ISO-2, "NP"
    phone: str
    postal_code: str
    state: str


class ResponseFields(TypedDict, total=False):
    """Signed fields of the response POST that verify() reads."""

    decision: str  # ACCEPT | REVIEW | DECLINE | ERROR | CANCEL
    reason_code: str
    req_reference_number: str
    req_transaction_uuid: str
    req_transaction_type: str
    req_currency: str
    req_amount: str
    auth_amount: str
    transaction_id: str
    signed_field_names: str
    signature: str


def map_decision(decision: str, reason_code: str, txn_type: str) -> PaymentStatus:
    """decision + reason_code -> PaymentStatus. An accepted authorization is not yet captured."""
    normalized = (decision or "").upper()
    if normalized == "ACCEPT":
        return "pending" if txn_type.startswith("authorization") else "paid"
    if normalized == "REVIEW":
        return "pending"
    if normalized in ("DECLINE", "ERROR"):
        return "unknown" if reason_code in UNCERTAIN_REASON_CODES else "failed"
    if normalized == "CANCEL":
        return "canceled"
    return "unknown"

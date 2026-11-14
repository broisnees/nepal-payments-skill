"""Shapes of NPS answers, and how to read an error out of them."""

from __future__ import annotations

from typing import Any, Optional, TypedDict

from ...core.errors import PaymentError


class NpsError(TypedDict, total=False):
    error_code: str  # "3" on CheckTransactionStatus = transaction not initialized yet
    error_message: str


class NpsEnvelope(TypedDict, total=False):
    """Every NPS API answer. code "0" = success; data depends on the call."""

    code: str
    message: str
    errors: Optional[list[NpsError]]
    data: Any


class ProcessIdData(TypedDict):
    ProcessId: str


class TransactionStatusData(TypedDict, total=False):
    MerchantTxnId: str
    Status: str  # key of STATUS (case-insensitive)
    Amount: str  # rupees
    GatewayReferenceNo: str


def api_failure(path: str, answer: NpsEnvelope) -> PaymentError:
    """PaymentError for an answer with code != "0": errors joined, code nps_<first error_code>."""
    errors = answer.get("errors") or []
    message = "; ".join(e.get("error_message", "") for e in errors) or answer.get("message", "")
    code = f"nps_{errors[0].get('error_code')}" if errors else "nps_error"
    return PaymentError(f"NPS {path}: {message}", "nps", code, 200, answer)


def is_not_initialized(answer: NpsEnvelope) -> bool:
    """error_code "3": NPS has no record of this MerchantTxnId."""
    return any(e.get("error_code") == "3" for e in answer.get("errors") or [])

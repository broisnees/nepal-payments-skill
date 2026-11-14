"""Shapes of NPI answers and the rules that turn a transaction report into a status."""

from __future__ import annotations

from typing import Any, List, Optional, Sequence, TypedDict, Union

from ...core.types import PaymentStatus
from .endpoints import CREDIT_OK, DEBIT_OK


class OAuthTokenResponse(TypedDict, total=False):
    access_token: str
    token_type: str
    expires_in: Union[int, str]  # seconds


class GeneratedQr(TypedDict, total=False):
    validationTraceId: str  # persist as provider_ref
    qrString: str
    qrImage: str  # base64 PNG when qrImage=true was requested


class GenerateQrResponse(TypedDict, total=False):
    timestamp: str
    responseCode: str  # "000" = OK
    responseStatus: str
    responseMessage: str
    data: GeneratedQr
    responses: List[dict]  # validation errors: [{responseCode, responseMessage}]


class ReportRow(TypedDict, total=False):
    """One payment attempt against a QR (merchanttxnreport)."""

    nQrTxnId: str
    amount: Union[float, str]  # rupees
    tranType: str  # "PMT" (payment) or e.g. "RFND"; missing means PMT
    merchantBillNo: str
    debitStatus: str
    creditStatus: Optional[str]


class WebSocketBody(TypedDict):
    merchant_id: str
    request_id: str
    username: Optional[str]
    api_token: str  # RSA-encrypted with NCHL's public key


class WebSocketRequest(TypedDict):
    """What NepalPay.web_socket_request() returns."""

    url: Optional[str]
    subscribe: str
    send: str
    body: WebSocketBody


class ConfirmationResponse(TypedDict):
    """Signed reply to NCHL's confirm-payment notification."""

    txnDate: str
    status: str
    message: str
    merchantBillNo: str
    paymentRef: str
    signature: str


def generate_qr_error_code(body: dict[str, Any], http_status: int) -> str:
    """responseCode of the answer, else of its first `responses` entry, else http_<status>."""
    responses = body.get("responses")
    first: dict[str, Any] = {}
    if isinstance(responses, list) and responses and isinstance(responses[0], dict):
        first = responses[0]
    for code in (body.get("responseCode"), first.get("responseCode")):
        if code is not None:
            return str(code)
    return f"http_{http_status}"


def payments_only(rows: Sequence[ReportRow]) -> list[ReportRow]:
    """Drop non-payment rows (refunds etc.); a row without tranType is a payment."""
    return [row for row in rows if (row.get("tranType") or "PMT") == "PMT"]


def is_paid(row: ReportRow) -> bool:
    return row.get("debitStatus") == DEBIT_OK and str(row.get("creditStatus")) in CREDIT_OK


def pick_payment(payments: Sequence[ReportRow]) -> Optional[ReportRow]:
    """The paid row if any (a failed scan can be retried on the same QR), else the latest one."""
    paid = next((row for row in payments if is_paid(row)), None)
    if paid:
        return paid
    return payments[-1] if payments else None


def payment_status(row: Optional[ReportRow]) -> PaymentStatus:
    if row is None:
        return "not_found"
    if is_paid(row):
        return "paid"
    if row.get("debitStatus") == DEBIT_OK:
        return "unknown"  # debited but credit not confirmed: review
    return "failed"

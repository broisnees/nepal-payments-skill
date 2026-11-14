"""Shapes of Hamro Pay answers, and how to read an error out of them."""

from __future__ import annotations

from typing import Any, Optional, TypedDict, Union

# grpc-gateway status code Hamro Pay answers for bad credentials.
UNAUTHENTICATED_CODE = 16


class ErrorBody(TypedDict, total=False):
    """grpc-gateway error: {"code": 16, "message": "Unauthorized Request", "details": []}."""

    code: int
    message: str
    details: list[Any]


class CreateSessionResponse(TypedDict, total=False):
    sessionId: str
    merchantId: str


class TransactionResponse(TypedDict, total=False):
    """Get Transaction. amount is RUPEES, and 0 until the payment finishes."""

    # The reference names it merchantTransactionId; the live API answers merchantTxnId.
    merchantTransactionId: str
    merchantTxnId: str
    status: str  # key of TXN_STATUS
    amount: Union[int, float]
    trackingId: str
    message: str


class WebhookBody(TypedDict, total=False):
    merchantTxnId: str
    merchantId: str
    status: str
    amount: Union[int, float]
    metadata: dict[str, Any]


def is_unauthorized(status: int, body: Optional[dict[str, Any]]) -> bool:
    return status == 401 or (body is not None and body.get("code") == UNAUTHENTICATED_CODE)


def error_message(body: Optional[dict[str, Any]], text: str) -> str:
    if body is not None and isinstance(body.get("message"), str):
        return body["message"]
    return text[:200]


def error_code(body: Optional[dict[str, Any]], status: int) -> str:
    """`code_<grpc code>` when the body carries one, else `http_<status>`."""
    if body is not None and body.get("code") is not None:
        return f"code_{body['code']}"
    return f"http_{status}"


def echoed_order_id(answer: TransactionResponse) -> Optional[object]:
    """The merchantTxnId the answer is for, under either of its two names."""
    echoed = answer.get("merchantTransactionId")
    if echoed is None:
        echoed = answer.get("merchantTxnId")
    return echoed

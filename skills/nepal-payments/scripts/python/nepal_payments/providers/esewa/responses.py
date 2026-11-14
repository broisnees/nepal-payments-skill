"""Shapes of eSewa answers, and how to read an error out of them."""

from __future__ import annotations

from typing import Any, Optional, TypedDict, Union

from ...core.encoding import js_string


class EpayStatusResponse(TypedDict, total=False):
    """GET status API. total_amount is a number (1000.0) or a string."""

    product_code: str
    transaction_uuid: str
    total_amount: Union[float, str]
    status: str  # key of EPAY_STATUS
    ref_id: Optional[str]


class SuccessPayload(TypedDict, total=False):
    """base64 JSON in the `data` query param of the success redirect. Not proof of payment."""

    transaction_code: str
    status: str
    total_amount: Union[str, float]
    transaction_uuid: str
    product_code: str
    signed_field_names: str
    signature: str


class IntentBookData(TypedDict):
    booking_id: str
    deeplink: str
    correlation_id: str


class IntentStatusData(TypedDict, total=False):
    status: str  # key of INTENT_STATUS
    transaction_id: str  # your order_id
    reference_code: str


class IntentBooking(TypedDict):
    """What Esewa.intent_book() returns. Persist provider_ref."""

    booking_id: str
    deeplink: str
    correlation_id: str
    provider_ref: str  # "booking_id|correlation_id"
    raw: Any


def intent_data(body: Any) -> Optional[dict[str, Any]]:
    """The `data` object of an Intent answer ({code, data: {...}}), or None."""
    if not isinstance(body, dict):
        return None
    return (body or {}).get("data")


def error_message(body: Any, text: str) -> str:
    """Docs say `error_message`; the live Intent sandbox sends `errorMessage`."""
    if isinstance(body, dict):
        message = body.get("error_message") or body.get("errorMessage")
        if message is not None:
            return str(message)
    return text[:200]


def error_code(body: Any, status: int) -> str:
    """`esewa_<code>` when the body carries a code, else `http_<status>`."""
    if isinstance(body, dict) and body.get("code") is not None:
        return f"esewa_{js_string(body['code'])}"
    return f"http_{status}"

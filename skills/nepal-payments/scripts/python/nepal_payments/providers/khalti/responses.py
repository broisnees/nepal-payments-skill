"""Shapes of Khalti answers, and how to read an error out of them."""

from __future__ import annotations

from typing import Any, Optional, TypedDict


class InitiateResponse(TypedDict, total=False):
    pidx: str
    payment_url: str
    expires_at: str
    expires_in: int


class LookupResponse(TypedDict, total=False):
    """Expired / User canceled arrive as HTTP 400 with this same body."""

    pidx: str
    total_amount: int  # paisa
    status: str  # key of STATUS once lower-cased
    transaction_id: Optional[str]
    fee: int
    refunded: bool


def error_key(body: Any, status: int) -> str:
    """Error code: "unauthorized" on 401, else Khalti's `error_key`, else `http_<status>`."""
    if status == 401:
        return "unauthorized"
    return (isinstance(body, dict) and body.get("error_key")) or f"http_{status}"


def error_message(body: Any) -> str:
    """`detail` when present, else every field error joined ("amount: too low; ...")."""
    if not isinstance(body, dict):
        return f"Khalti error: {str(body)[:200]}"
    if body.get("detail"):
        return f"Khalti: {body['detail']}"
    parts = [
        f"{key}: {_join(value)}"
        for key, value in body.items()
        if key not in ("error_key", "status_code")
    ]
    return "Khalti: " + ("; ".join(parts) or "unknown error")


def _join(value: Any) -> Any:
    return " ".join(value) if isinstance(value, list) else value

"""Shapes of Fonepay answers."""

from __future__ import annotations

import re
from typing import Any, Optional, TypedDict, Union


class TxnVerificationResponse(TypedDict, total=False):
    paymentStatus: str  # key of TXN_STATUS once lower-cased
    requestedAmount: str  # rupees
    fonepayTraceId: Union[int, str]


class QrCreateResponse(TypedDict, total=False):
    qrMessage: str
    thirdpartyQrWebSocketUrl: str


class QrStatusResponse(TypedDict, total=False):
    paymentStatus: str
    fonepayTraceId: Union[int, str]


class QrCreated(TypedDict):
    """What Fonepay.qr_create() returns."""

    qr_message: str  # render as a QR
    websocket_url: Optional[str]  # live status channel
    raw: Any


def xml_tag(text: str, tag: str) -> Optional[str]:
    """Text of the first <tag>...</tag> in the legacy verification XML, or None."""
    match = re.search(rf"<{tag}>([^<]*)</{tag}>", text)
    return match.group(1) if match else None


def trace_id(body: Any) -> Optional[str]:
    """fonepayTraceId as a string (Fonepay sends a number), or None."""
    trace = body.get("fonepayTraceId")
    return str(trace) if trace is not None else None

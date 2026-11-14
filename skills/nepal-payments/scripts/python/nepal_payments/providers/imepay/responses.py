"""Shapes of IME Pay answers."""

from __future__ import annotations

from typing import TypedDict, Union


class GetTokenResponse(TypedDict, total=False):
    TokenId: str
    ResponseCode: Union[int, str]  # 0 = OK
    ResponseDescription: str


class RecheckResponse(TypedDict, total=False):
    ResponseCode: Union[int, str]  # 0 = paid; other codes are inconsistently documented
    RefId: str  # your order_id
    TranAmount: Union[str, float]  # rupees
    TransactionId: Union[int, str]

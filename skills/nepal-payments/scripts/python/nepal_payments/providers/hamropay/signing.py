"""Hamro Pay signatures: base64(HMAC-SHA512(client_secret, values joined by ",")).

create session  merchantTxnId,transactionAmount,merchantId,clientId,clientApiKey
                -> header "Signature"
gateway token   merchantId,merchantTxnId,sessionId,transactionAmount,clientId,clientApiKey
                -> form field "token"
get txn         merchantTxnId,merchantId,clientId,clientApiKey
                -> header "Signature"
webhook         merchantTxnId,merchantId,status,amount, with the webhook secret
                -> header "Signature"
"""

from __future__ import annotations

from typing import Iterable, Union

from ...core.crypto import hmac_digest
from ...core.encoding import b64encode, js_string


def hamro_pay_sign(secret: str, values: Iterable[Union[str, int]]) -> str:
    """base64(HMAC-SHA512) over comma-joined values.

    The join has no escaping, so a comma inside a value would let two different tuples share a
    signature: refuse it instead.
    """
    parts = [str(v) for v in values]
    if any("," in part for part in parts):
        raise ValueError("hamropay: signed values must not contain commas")
    return b64encode(hmac_digest("sha512", secret, ",".join(parts)))


def webhook_amount_renderings(amount: Union[int, float]) -> list[str]:
    """Every text Hamro Pay may have signed for `amount`, without duplicates.

    Hamro Pay signs its own rendering of the amount (a double), which may be "1200", "1200.0" or
    "1200.00", so every form of the PARSED number is tried.
    """
    as_js = js_string(amount)
    candidates = [as_js, f"{amount:.2f}", f"{as_js}.0", f"{amount:.1f}"]
    return list(dict.fromkeys(candidates))

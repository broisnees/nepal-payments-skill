"""GetPay return token: base64(JSON {id, oprSecret}).

oprSecret = base64(SHA-256(oprKey + id)).
"""

from __future__ import annotations

import hashlib
import json
from typing import Optional

from ...core.encoding import b64decode_lenient, b64encode
from .responses import ReturnToken


def get_pay_opr_secret(opr_key: str, transaction_id: str) -> str:
    """base64(SHA-256(opr_key + transaction_id)): the oprSecret GetPay puts in the return token."""
    return b64encode(hashlib.sha256((opr_key + transaction_id).encode()).digest())


def get_pay_decode_token(token: str) -> Optional[ReturnToken]:
    """Decode the return token.

    GetPay sends base64 JSON {id, oprSecret}; one integration reports "id:oprSecret".
    """
    try:
        text = b64decode_lenient(token).decode("utf-8", "replace")
    except ValueError:
        return None
    try:
        parsed = json.loads(text)
    except ValueError:
        return _decode_colon_form(text)
    if not isinstance(parsed, dict):
        return None
    token_id = parsed.get("id")
    secret = parsed.get("oprSecret")
    if isinstance(token_id, str) and isinstance(secret, str) and token_id and secret:
        return {"id": token_id, "oprSecret": secret}
    return None


def _decode_colon_form(text: str) -> Optional[ReturnToken]:
    """The "id:oprSecret" form; both parts must be non-empty."""
    i = text.find(":")
    if 0 < i < len(text) - 1:
        return {"id": text[:i], "oprSecret": text[i + 1 :]}
    return None

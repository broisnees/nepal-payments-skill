"""eSewa signatures: base64(HMAC-SHA256(key, "f1=v1,f2=v2")) in signed_field_names order.

The example signatures in eSewa's docs are wrong; see tests for verified vectors.
"""

from __future__ import annotations

import re
from typing import Any, Mapping, Sequence

from ...core.crypto import hmac_digest
from ...core.encoding import b64encode, js_string

# ePay v2 form fields eSewa expects to be signed, in this order.
EPAY_SIGNED_FIELDS = ["total_amount", "transaction_uuid", "product_code"]
INTENT_BOOK_SIGNED_FIELDS = ["product_code", "amount", "transaction_uuid"]
INTENT_STATUS_SIGNED_FIELDS = ["booking_id", "product_code", "correlation_id"]
INTENT_CANCEL_SIGNED_FIELDS = ["booking_id", "product_code"]


def esewa_sign(key: str, fields: Mapping[str, Any], order: Sequence[str]) -> str:
    """Sign `fields` in `order`; a missing field signs as an empty value."""
    message = ",".join(f"{name}={fields.get(name, '')}" for name in order)
    return b64encode(hmac_digest("sha256", key, message))


def signed_field_order(signed_field_names: str) -> list[str]:
    """Split signed_field_names: "a, b,c" -> ["a", "b", "c"]."""
    return [name.strip() for name in signed_field_names.split(",")]


def raw_value(text: str, payload: Mapping[str, Any], field: str) -> str:
    """Exact text of a field as eSewa sent it, so numbers keep their formatting.

    "1000.0" stays "1000.0" (json.loads would turn it into 1000.0 and String(v) into "1000").
    """
    value = payload.get(field)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return js_string(value)
    match = re.search(rf'"{re.escape(field)}"\s*:\s*(-?[0-9][0-9.eE+-]*)', text)
    if match:
        return match.group(1)
    return js_string(value)

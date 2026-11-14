"""NPS signature: HMAC-SHA512 (lowercase hex) over the values of alphabetically sorted payload keys
(excluding Signature), concatenated with no separator."""

from __future__ import annotations

from typing import Mapping

from ...core.crypto import hmac_digest


def nps_sign(secret_key: str, payload: Mapping[str, str]) -> str:
    """Signature for an NPS API payload."""
    message = "".join(str(payload[key]) for key in sorted(payload) if key != "Signature")
    return hmac_digest("sha512", secret_key, message).hex()

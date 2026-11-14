"""Signature: base64(HMAC-SHA256(secret_key RAW UTF-8, "f1=v1,...")) in signed_field_names order."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Mapping, Optional

from ...core.crypto import hmac_digest
from ...core.encoding import b64encode


def cybersource_sign(secret_key: str, fields: Mapping[str, str]) -> str:
    """Sign the fields named in fields["signed_field_names"]; a missing field signs as empty."""
    names = fields["signed_field_names"].split(",")
    message = ",".join(f"{name}={fields.get(name, '')}" for name in names)
    return b64encode(hmac_digest("sha256", secret_key, message))


def signed_date_time(now: Optional[datetime] = None) -> str:
    """UTC timestamp in the form CyberSource expects: 2026-11-04T10:15:30Z."""
    return (
        (now or datetime.now(timezone.utc)).astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    )

"""Fonepay signatures: HMAC-SHA512 hex over comma-joined values.

request DV  = PID,MD,PRN,AMT,CRN,DT,R1,R2,RU
response DV = PRN,PID,PS,RC,UID,BC,INI,P_AMT,R_AMT
txnVerification auth = username,password,POST,application/json,<resource>,<exact JSON body>
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Optional, Sequence

from ...core.crypto import hmac_digest
from .endpoints import TXN_RESOURCE

NPT = timezone(timedelta(hours=5, minutes=45))  # Asia/Kathmandu

REQUEST_DV_FIELDS = ["PID", "MD", "PRN", "AMT", "CRN", "DT", "R1", "R2", "RU"]
RESPONSE_DV_FIELDS = ["PRN", "PID", "PS", "RC", "UID", "BC", "INI", "P_AMT", "R_AMT"]


def fonepay_hmac(secret: str, values: Sequence[object]) -> str:
    """UPPERCASE hex HMAC-SHA512 over the comma-joined values."""
    return hmac_digest("sha512", secret, ",".join(str(v) for v in values)).hex().upper()


def fonepay_date(now: Optional[datetime] = None) -> str:
    """MM/DD/YYYY in Asia/Kathmandu."""
    return (now or datetime.now(timezone.utc)).astimezone(NPT).strftime("%m/%d/%Y")


def txn_verification_auth(secret: str, username: str, password: str, body: str) -> str:
    """lowercase hex HMAC-SHA512 for the txnVerification `auth` header, over the exact body."""
    message = ",".join([username, password, "POST", "application/json", TXN_RESOURCE, body])
    return hmac_digest("sha512", secret, message).hex()

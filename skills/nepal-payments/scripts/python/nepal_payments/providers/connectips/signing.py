"""connectIPS TOKEN = base64(RSA-SHA256(creditor private key, token string))."""

from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
from typing import Mapping, Optional

# Asia/Kathmandu (UTC+05:45, no DST).
NPT = timezone(timedelta(hours=5, minutes=45))


def connectips_date(now: Optional[datetime] = None) -> str:
    """DD-MM-YYYY in Asia/Kathmandu."""
    return (now or datetime.now(timezone.utc)).astimezone(NPT).strftime("%d-%m-%Y")


def connectips_token_string(f: Mapping[str, str]) -> str:
    """The exact string signed into the form's TOKEN field."""
    return (
        f"MERCHANTID={f['MERCHANTID']},APPID={f['APPID']},APPNAME={f['APPNAME']},"
        f"TXNID={f['TXNID']},TXNDATE={f['TXNDATE']},TXNCRNCY={f['TXNCRNCY']},"
        f"TXNAMT={f['TXNAMT']},REFERENCEID={f['REFERENCEID']},REMARKS={f['REMARKS']},"
        f"PARTICULARS={f['PARTICULARS']},TOKEN=TOKEN"
    )


def validation_token_string(merchant_id: str, app_id: str, txn_id: str, amount_paisa: int) -> str:
    """The string signed for validatetxn / gettxndetail."""
    return f"MERCHANTID={merchant_id},APPID={app_id},REFERENCEID={txn_id},TXNAMT={amount_paisa}"


def clip(text: str, limit: int) -> str:
    """Replace "," and "=" (they would corrupt the token string), then cut to `limit` chars."""
    return re.sub(r"[,=]", " ", text)[:limit]

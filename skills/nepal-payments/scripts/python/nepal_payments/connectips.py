"""connectIPS (NCHL) e-payment gateway. TOKEN = base64(RSA-SHA256(creditor private key, token string)).

Requires `cryptography` (pip install cryptography). Load the key from the .pfx once:
    pem = load_pfx_private_key_pem(open("CREDITOR.pfx","rb").read(), os.environ["CONNECTIPS_PFX_PASSWORD"])
"""

from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
from typing import Any, Mapping, Optional

from .core import (FormResult, PaymentError, VerifyResult, assert_paisa, basic_auth, http, rsa_sha256_sign_b64)

BASE = {"sandbox": "https://uat.connectips.com", "production": "https://login.connectips.com"}
NPT = timezone(timedelta(hours=5, minutes=45))


def connectips_date(now: Optional[datetime] = None) -> str:
    """DD-MM-YYYY in Asia/Kathmandu."""
    return (now or datetime.now(timezone.utc)).astimezone(NPT).strftime("%d-%m-%Y")


def connectips_token_string(f: Mapping[str, str]) -> str:
    return (f"MERCHANTID={f['MERCHANTID']},APPID={f['APPID']},APPNAME={f['APPNAME']},TXNID={f['TXNID']},"
            f"TXNDATE={f['TXNDATE']},TXNCRNCY={f['TXNCRNCY']},TXNAMT={f['TXNAMT']},REFERENCEID={f['REFERENCEID']},"
            f"REMARKS={f['REMARKS']},PARTICULARS={f['PARTICULARS']},TOKEN=TOKEN")


def _clip(s: str, n: int) -> str:
    return re.sub(r"[,=]", " ", s)[:n]  # commas/equals would corrupt the token string


class ConnectIps:
    id = "connectips"

    def __init__(self, env: str, merchant_id: Any, app_id: str, app_name: str, app_password: str,
                 private_key_pem: bytes, base_url: Optional[str] = None, timeout: float = 20.0):
        self.merchant_id = str(merchant_id)
        self.app_id = app_id
        self.app_name = app_name[:30]
        self.private_key_pem = private_key_pem if isinstance(private_key_pem, bytes) else private_key_pem.encode()
        self.base = base_url or BASE[env]
        self.timeout = timeout
        self._auth = {"Authorization": basic_auth(app_id, app_password)}

    def initiate(self, order_id: str, amount_paisa: int, description: str, return_url: str = "",
                 reference_id: Optional[str] = None, remarks: Optional[str] = None,
                 particulars: Optional[str] = None, **_: Any) -> FormResult:
        """Success/failure URLs are registered with NCHL (not sent per request)."""
        assert_paisa(amount_paisa, "connectips")
        if not re.fullmatch(r"[A-Za-z0-9-]{1,20}", order_id):
            raise PaymentError("connectIPS TXNID must be 1–20 chars [A-Za-z0-9-]", "connectips", "invalid_order_id")
        f = {
            "MERCHANTID": self.merchant_id, "APPID": self.app_id, "APPNAME": self.app_name, "TXNID": order_id,
            "TXNDATE": connectips_date(), "TXNCRNCY": "NPR", "TXNAMT": str(amount_paisa),  # paisa
            "REFERENCEID": _clip(reference_id or order_id, 20),
            "REMARKS": _clip(remarks or description, 50) or "Payment",
            "PARTICULARS": _clip(particulars or description, 100) or "Payment",
        }
        f["TOKEN"] = rsa_sha256_sign_b64(self.private_key_pem, connectips_token_string(f))
        return FormResult(action=f"{self.base}/connectipswebgw/loginpage", fields=f)

    def _validation_call(self, path: str, txn_id: str, amount_paisa: int) -> dict:
        token_string = f"MERCHANTID={self.merchant_id},APPID={self.app_id},REFERENCEID={txn_id},TXNAMT={amount_paisa}"
        body = {"merchantId": int(self.merchant_id), "appId": self.app_id, "referenceId": txn_id,  # = TXNID
                "txnAmt": amount_paisa, "token": rsa_sha256_sign_b64(self.private_key_pem, token_string)}
        res = http("connectips", f"{self.base}/connectipswebws/api/creditor/{path}", "POST", self._auth, body,
                   self.timeout, retries=2)
        if res.status == 401:
            raise PaymentError("connectIPS: 401 — wrong APPID/app password", "connectips", "unauthorized", 401)
        if res.status != 200 or not isinstance(res.data, dict) or "status" not in res.data:
            raise PaymentError(f"connectIPS {path} failed: {res.text[:200]}", "connectips", f"http_{res.status}", res.status, res.data)
        return res.data

    def verify(self, order_id: str, amount_paisa: int, provider_ref: Optional[str] = None,
               callback: Optional[Mapping[str, str]] = None) -> VerifyResult:
        r = self._validation_call("validatetxn", order_id, amount_paisa)
        desc = str(r.get("statusDesc", "")).upper()
        if r["status"] == "SUCCESS":
            status = "paid"
        elif r["status"] == "FAILED":
            status = "failed"
        elif "NOT FOUND" in desc:
            status = "not_found"
        elif "INCOMPLETE" in desc:
            status = "pending"
        else:
            status = "unknown"
        try:
            amt: Optional[int] = round(float(r["txnAmt"])) if r.get("txnAmt") is not None else None
        except (TypeError, ValueError):
            amt = None
        return VerifyResult("connectips", status, order_id, amt, None, r)  # type: ignore[arg-type]

    def get_txn_detail(self, order_id: str, amount_paisa: int) -> dict:
        """creditStatus in {"000","999","DEFER"} = credited / OK."""
        return self._validation_call("gettxndetail", order_id, amount_paisa)

    @staticmethod
    def order_id_from_callback(params: Mapping[str, str]) -> Optional[str]:
        return params.get("TXNID") or params.get("txnId") or None

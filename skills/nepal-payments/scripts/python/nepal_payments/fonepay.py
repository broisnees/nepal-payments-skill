"""Fonepay — web payment redirect + Dynamic QR. HMAC-SHA512 hex over comma-joined values.

request DV  = PID,MD,PRN,AMT,CRN,DT,R1,R2,RU            response DV = PRN,PID,PS,RC,UID,BC,INI,P_AMT,R_AMT
txnVerification auth = username,password,POST,application/json,<resource>,<exact JSON body>
"""

from __future__ import annotations

import json
import re
import urllib.parse
from datetime import datetime, timedelta, timezone
from typing import Any, Mapping, Optional

from .core import (PaymentError, RedirectResult, VerifyResult, assert_paisa, basic_auth, hmac_digest, http,
                   paisa_to_rupees, rupees_to_paisa, safe_equal)

URLS = {
    "sandbox": {
        "payment": "https://dev-clientapi.fonepay.com/api/merchantRequest",
        "legacy_verify": "https://dev-clientapi.fonepay.com/api/merchantRequest/verificationMerchant",
        "txn_verification": "https://dev-merchantapi.fonepay.com/api/merchant/merchantDetailsForThirdParty/txnVerification",
        "qr_base": "https://dev-merchantapi.fonepay.com/api/merchant/merchantDetailsForThirdParty",
    },
    "production": {
        "payment": "https://clientapi.fonepay.com/api/merchantRequest",
        "legacy_verify": "https://clientapi.fonepay.com/api/merchantRequest/verificationMerchant",
        "txn_verification": "https://merchantapi.fonepay.com/api/merchant/merchantDetailsForThirdParty/txnVerification",
        "qr_base": "https://merchantapi.fonepay.com/api/merchant/merchantDetailsForThirdParty",
    },
}
TXN_STATUS = {"success": "paid", "pending": "pending", "failed": "failed"}
TXN_RESOURCE = "/merchant/merchantDetailsForThirdParty/txnVerification"
RESPONSE_DV_FIELDS = ["PRN", "PID", "PS", "RC", "UID", "BC", "INI", "P_AMT", "R_AMT"]
NPT = timezone(timedelta(hours=5, minutes=45))


def fonepay_hmac(secret: str, values: list) -> str:
    return hmac_digest("sha512", secret, ",".join(str(v) for v in values)).hex().upper()


def fonepay_date(now: Optional[datetime] = None) -> str:
    """MM/DD/YYYY in Asia/Kathmandu."""
    return (now or datetime.now(timezone.utc)).astimezone(NPT).strftime("%m/%d/%Y")


class Fonepay:
    id = "fonepay"

    def __init__(self, env: str, merchant_code: str, secret_key: str, username: Optional[str] = None,
                 password: Optional[str] = None, urls: Optional[Mapping[str, str]] = None,
                 strict_signature: bool = True, timeout: float = 15.0):
        self.env = env
        self.merchant_code = merchant_code
        self.secret = secret_key
        self.username = username
        self.password = password
        self.urls = {**URLS[env], **(urls or {})}
        self.strict = strict_signature
        self.timeout = timeout

    def _sign(self, values: list) -> str:
        return fonepay_hmac(self.secret, values)

    def initiate(self, order_id: str, amount_paisa: int, description: str, return_url: str,
                 remarks2: str = "N/A", **_: Any) -> RedirectResult:
        assert_paisa(amount_paisa, "fonepay")
        if not 3 <= len(order_id) <= 25:
            raise PaymentError("Fonepay PRN must be 3–25 chars", "fonepay", "invalid_order_id")
        if len(return_url) > 150:
            raise PaymentError("Fonepay RU must be <= 150 chars", "fonepay", "invalid_return_url")
        p = {"PID": self.merchant_code, "MD": "P", "PRN": order_id, "AMT": paisa_to_rupees(amount_paisa), "CRN": "NPR",
             "DT": fonepay_date(), "R1": description[:160] or "Payment", "R2": (remarks2 or "N/A")[:50], "RU": return_url}
        p["DV"] = self._sign([p[k] for k in ("PID", "MD", "PRN", "AMT", "CRN", "DT", "R1", "R2", "RU")])
        return RedirectResult(url=f"{self.urls['payment']}?{urllib.parse.urlencode(p)}")

    def callback_valid(self, params: Mapping[str, str]) -> bool:
        dv = params.get("DV")
        if not dv:
            return False
        return safe_equal(self._sign([params.get(f, "") for f in RESPONSE_DV_FIELDS]), dv.upper())

    def _txn_verification(self, prn: str, amount_paisa: int) -> dict:
        # Signed byte-for-byte: build once, send that exact string (format from the spec example).
        body = (f'{{"prn": {json.dumps(prn)},"merchantCode": {json.dumps(self.merchant_code)},'
                f'"amount": {json.dumps(paisa_to_rupees(amount_paisa))}}}')
        auth = hmac_digest("sha512", self.secret, ",".join(
            [self.username or "", self.password or "", "POST", "application/json", TXN_RESOURCE, body])).hex()
        res = http("fonepay", self.urls["txn_verification"], "POST",
                   {"Authorization": basic_auth(self.username or "", self.password or ""), "auth": auth,
                    "Content-Type": "application/json"}, body, self.timeout, retries=2)
        if res.status != 200 or not isinstance(res.data, dict) or not isinstance(res.data.get("paymentStatus"), str):
            raise PaymentError(f"Fonepay txnVerification failed: {res.text[:200]}", "fonepay", f"http_{res.status}", res.status, res.data)
        return res.data

    def _legacy_verify(self, prn: str, amount_paisa: int, uid: str, bank_code: str) -> tuple:
        amt = paisa_to_rupees(amount_paisa)
        dv = self._sign([self.merchant_code, amt, prn, bank_code, uid])
        qs = urllib.parse.urlencode({"PRN": prn, "PID": self.merchant_code, "BID": bank_code, "AMT": amt, "UID": uid, "DV": dv})
        res = http("fonepay", f"{self.urls['legacy_verify']}?{qs}", headers={"Accept": "application/xml"},
                   timeout=self.timeout, retries=2)
        if res.status != 200:  # a 5xx / WAF page must never read as "not paid"
            raise PaymentError(f"Fonepay verification HTTP {res.status}", "fonepay", "upstream_error", res.status, res.text[:500])
        tag = lambda t: (re.search(rf"<{t}>([^<]*)</{t}>", res.text) or [None, None])[1]  # noqa: E731
        code = tag("response_code")
        if code is None:
            raise PaymentError("Fonepay verification: unparseable response", "fonepay", "malformed_response", res.status, res.text[:500])
        return code == "successful" and tag("success") == "true", res.text

    def verify(self, order_id: str, amount_paisa: int, provider_ref: Optional[str] = None,
               callback: Optional[Mapping[str, str]] = None) -> VerifyResult:
        # Callback params are trusted ONLY with a valid DV; a missing DV is treated like a bad one.
        trusted: Optional[Mapping[str, str]] = None
        if callback and any(k == "DV" or k in RESPONSE_DV_FIELDS for k in callback):
            if self.callback_valid(callback):
                if callback.get("PRN") != order_id or callback.get("PID") != self.merchant_code:
                    raise PaymentError("Fonepay: callback does not match this attempt", "fonepay", "callback_mismatch", 400, dict(callback))
                trusted = callback
            elif self.strict:
                raise PaymentError("Fonepay: missing or invalid response DV", "fonepay", "invalid_signature", 400, dict(callback))
        if self.username and self.password:
            r = self._txn_verification(order_id, amount_paisa)
            trace = r.get("fonepayTraceId")
            return VerifyResult("fonepay", TXN_STATUS.get(r["paymentStatus"].lower(), "unknown"), order_id,  # type: ignore[arg-type]
                                rupees_to_paisa(r["requestedAmount"]) if r.get("requestedAmount") else None,
                                str(trace) if trace is not None else (trusted or {}).get("UID"), r)
        if trusted and trusted.get("UID") and trusted.get("BC"):
            if trusted.get("PS") != "true" or trusted.get("RC") != "successful":  # authentic (DV-verified) negative
                status = "canceled" if trusted.get("RC") == "cancel" else "failed"
                return VerifyResult("fonepay", status, order_id, None, trusted.get("UID"), dict(trusted))  # type: ignore[arg-type]
            ok, text = self._legacy_verify(order_id, amount_paisa, trusted["UID"], trusted["BC"])
            return VerifyResult("fonepay", "paid" if ok else "failed", order_id,
                                rupees_to_paisa(trusted["R_AMT"]) if trusted.get("R_AMT") else None,
                                trusted["UID"], {"callback": dict(trusted), "verification": text})
        raise PaymentError("Fonepay: cannot verify without a DV-signed callback (UID/BC) unless username/password are configured",
                           "fonepay", "verify_unavailable")

    @staticmethod
    def order_id_from_callback(params: Mapping[str, str]) -> Optional[str]:
        return params.get("PRN") or None

    # ------------------------------------------------------------- Dynamic QR
    def qr_create(self, order_id: str, amount_paisa: int, remarks1: str, remarks2: str = "N/A") -> dict:
        self._require_login()
        assert_paisa(amount_paisa, "fonepay")
        amount = paisa_to_rupees(amount_paisa)
        body = {"amount": amount, "remarks1": remarks1, "remarks2": remarks2, "prn": order_id,
                "merchantCode": self.merchant_code,
                "dataValidation": self._sign([amount, order_id, self.merchant_code, remarks1, remarks2]).lower(),
                "username": self.username, "password": self.password}
        res = http("fonepay", f"{self.urls['qr_base']}/thirdPartyDynamicQrDownload", "POST", body=body, timeout=self.timeout)
        d = res.data if isinstance(res.data, dict) else {}
        if not d.get("qrMessage"):
            raise PaymentError(f"Fonepay QR create failed: {res.text[:200]}", "fonepay", f"http_{res.status}", res.status, res.data)
        ws = d.get("thirdpartyQrWebSocketUrl")
        if ws and "localhost" in ws:
            ws = re.sub(r"^wss?://[^/]+", "wss://ws.fonepay.com" if self.env == "production" else "wss://dev-ws.fonepay.com", ws)
        return {"qr_message": d["qrMessage"], "websocket_url": ws, "raw": d}

    def qr_status(self, order_id: str, amount_paisa: Optional[int] = None) -> VerifyResult:
        """Pass the stored amount: the status response has none, but the QR was created server-side with it."""
        self._require_login()
        body = {"prn": order_id, "merchantCode": self.merchant_code,
                "dataValidation": self._sign([order_id, self.merchant_code]).lower(),
                "username": self.username, "password": self.password}
        res = http("fonepay", f"{self.urls['qr_base']}/thirdPartyDynamicQrGetStatus", "POST", body=body,
                   timeout=self.timeout, retries=2)
        d = res.data if isinstance(res.data, dict) else {}
        if not isinstance(d.get("paymentStatus"), str):
            raise PaymentError(f"Fonepay QR status failed: {res.text[:200]}", "fonepay", f"http_{res.status}", res.status, res.data)
        trace = d.get("fonepayTraceId")
        return VerifyResult("fonepay", TXN_STATUS.get(d["paymentStatus"].lower(), "unknown"), order_id, amount_paisa,  # type: ignore[arg-type]
                            str(trace) if trace is not None else None, d)

    def _require_login(self):
        if not (self.username and self.password):
            raise RuntimeError("fonepay: username/password required for Dynamic QR")

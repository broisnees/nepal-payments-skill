"""Fonepay — web payment redirect + Dynamic QR."""

from __future__ import annotations

import json
import urllib.parse
from typing import Any, Mapping, Optional, cast

from ...core.crypto import safe_equal
from ...core.errors import PaymentError, http_error
from ...core.http import basic_auth, http
from ...core.money import assert_paisa, paisa_to_rupees, rupees_to_paisa
from ...core.types import PaymentStatus, RedirectResult, VerifyResult
from .endpoints import TXN_STATUS, URLS, public_websocket_url
from .responses import (
    QrCreated,
    QrCreateResponse,
    QrStatusResponse,
    TxnVerificationResponse,
    trace_id,
    xml_tag,
)
from .signing import (
    REQUEST_DV_FIELDS,
    RESPONSE_DV_FIELDS,
    fonepay_date,
    fonepay_hmac,
    txn_verification_auth,
)

PROVIDER = "fonepay"


class Fonepay:
    id = PROVIDER

    def __init__(
        self,
        env: str,
        merchant_code: str,
        secret_key: str,
        username: Optional[str] = None,
        password: Optional[str] = None,
        urls: Optional[Mapping[str, str]] = None,
        strict_signature: bool = True,
        timeout: float = 15.0,
    ):
        """username/password (merchant API user) enable txnVerification and Dynamic QR."""
        self.env = env
        self.merchant_code = merchant_code
        self.secret = secret_key
        self.username = username
        self.password = password
        self.urls = {**URLS[env], **(urls or {})}
        self.strict = strict_signature
        self.timeout = timeout

    def _sign(self, values: list[str]) -> str:
        return fonepay_hmac(self.secret, values)

    # ------------------------------------------------------------------ web payment

    def initiate(
        self,
        order_id: str,
        amount_paisa: int,
        description: str,
        return_url: str,
        remarks2: str = "N/A",
        **_: Any,
    ) -> RedirectResult:
        """Signed redirect URL to Fonepay's payment page. PRN = order_id (3-25 chars)."""
        assert_paisa(amount_paisa, PROVIDER)
        if not 3 <= len(order_id) <= 25:
            raise PaymentError("Fonepay PRN must be 3–25 chars", PROVIDER, "invalid_order_id")
        if len(return_url) > 150:
            raise PaymentError("Fonepay RU must be <= 150 chars", PROVIDER, "invalid_return_url")
        params = {
            "PID": self.merchant_code,
            "MD": "P",
            "PRN": order_id,
            "AMT": paisa_to_rupees(amount_paisa),
            "CRN": "NPR",
            "DT": fonepay_date(),
            "R1": description[:160] or "Payment",
            "R2": (remarks2 or "N/A")[:50],
            "RU": return_url,
        }
        params["DV"] = self._sign([params[name] for name in REQUEST_DV_FIELDS])
        return RedirectResult(url=f"{self.urls['payment']}?{urllib.parse.urlencode(params)}")

    def callback_valid(self, params: Mapping[str, str]) -> bool:
        """True when the return params carry a valid response DV (case-insensitive hex)."""
        dv = params.get("DV")
        if not dv:
            return False
        expected = self._sign([params.get(name, "") for name in RESPONSE_DV_FIELDS])
        return safe_equal(expected, dv.upper())

    def verify(
        self,
        order_id: str,
        amount_paisa: int,
        provider_ref: Optional[str] = None,
        callback: Optional[Mapping[str, str]] = None,
    ) -> VerifyResult:
        """Authoritative status of one attempt.

        Uses txnVerification when username/password are set; else the legacy verification API,
        which needs a DV-signed callback (UID/BC).
        """
        trusted = self._trusted_callback(callback, order_id)
        if self.username and self.password:
            return self._verify_by_txn_verification(order_id, amount_paisa, trusted)
        if trusted and trusted.get("UID") and trusted.get("BC"):
            return self._verify_by_callback(order_id, amount_paisa, trusted)
        raise PaymentError(
            "Fonepay: cannot verify without a DV-signed callback (UID/BC) "
            "unless username/password are configured",
            PROVIDER,
            "verify_unavailable",
        )

    def _trusted_callback(
        self, callback: Optional[Mapping[str, str]], order_id: str
    ) -> Optional[Mapping[str, str]]:
        """The callback if its DV is valid and it is for this attempt; None if absent/untrusted."""
        # Callback params are trusted ONLY with a valid DV; a missing DV is treated like a bad one.
        if not callback:
            return None
        if not any(key == "DV" or key in RESPONSE_DV_FIELDS for key in callback):
            return None
        if not self.callback_valid(callback):
            if self.strict:
                raise PaymentError(
                    "Fonepay: missing or invalid response DV",
                    PROVIDER,
                    "invalid_signature",
                    400,
                    dict(callback),
                )
            return None
        if callback.get("PRN") != order_id or callback.get("PID") != self.merchant_code:
            raise PaymentError(
                "Fonepay: callback does not match this attempt",
                PROVIDER,
                "callback_mismatch",
                400,
                dict(callback),
            )
        return callback

    def _verify_by_txn_verification(
        self, order_id: str, amount_paisa: int, trusted: Optional[Mapping[str, str]]
    ) -> VerifyResult:
        result = self._txn_verification(order_id, amount_paisa)
        requested = result.get("requestedAmount")
        transaction_id = trace_id(result)
        if transaction_id is None:
            transaction_id = (trusted or {}).get("UID")
        return VerifyResult(
            PROVIDER,
            TXN_STATUS.get(result["paymentStatus"].lower(), "unknown"),
            order_id,
            rupees_to_paisa(requested) if requested else None,
            transaction_id,
            result,
        )

    def _verify_by_callback(
        self, order_id: str, amount_paisa: int, trusted: Mapping[str, str]
    ) -> VerifyResult:
        uid = trusted["UID"]
        if trusted.get("PS") != "true" or trusted.get("RC") != "successful":
            # Authentic (DV-verified) negative.
            status: PaymentStatus = "canceled" if trusted.get("RC") == "cancel" else "failed"
            return VerifyResult(PROVIDER, status, order_id, None, trusted.get("UID"), dict(trusted))
        ok, text = self._legacy_verify(order_id, amount_paisa, uid, trusted["BC"])
        received = trusted.get("R_AMT")
        return VerifyResult(
            PROVIDER,
            "paid" if ok else "failed",
            order_id,
            rupees_to_paisa(trusted["R_AMT"]) if received else None,
            uid,
            {"callback": dict(trusted), "verification": text},
        )

    def _txn_verification(self, prn: str, amount_paisa: int) -> TxnVerificationResponse:
        username = self.username or ""
        password = self.password or ""
        # Signed byte-for-byte: build once, send that exact string (format from the spec example).
        body = (
            f'{{"prn": {json.dumps(prn)},"merchantCode": {json.dumps(self.merchant_code)},'
            f'"amount": {json.dumps(paisa_to_rupees(amount_paisa))}}}'
        )
        headers = {
            "Authorization": basic_auth(username, password),
            "auth": txn_verification_auth(self.secret, username, password, body),
            "Content-Type": "application/json",
        }
        res = http(
            PROVIDER,
            self.urls["txn_verification"],
            "POST",
            headers,
            body,
            self.timeout,
            retries=2,
        )
        data = res.json_object()
        if res.status != 200 or data is None or not isinstance(data.get("paymentStatus"), str):
            raise http_error(PROVIDER, res, "Fonepay txnVerification failed")
        return cast(TxnVerificationResponse, data)

    def _legacy_verify(
        self, prn: str, amount_paisa: int, uid: str, bank_code: str
    ) -> tuple[bool, str]:
        """(paid, raw XML) from the legacy verificationMerchant API."""
        amount = paisa_to_rupees(amount_paisa)
        dv = self._sign([self.merchant_code, amount, prn, bank_code, uid])
        query = urllib.parse.urlencode(
            {
                "PRN": prn,
                "PID": self.merchant_code,
                "BID": bank_code,
                "AMT": amount,
                "UID": uid,
                "DV": dv,
            }
        )
        res = http(
            PROVIDER,
            f"{self.urls['legacy_verify']}?{query}",
            headers={"Accept": "application/xml"},
            timeout=self.timeout,
            retries=2,
        )
        if res.status != 200:  # a 5xx / WAF page must never read as "not paid"
            raise PaymentError(
                f"Fonepay verification HTTP {res.status}",
                PROVIDER,
                "upstream_error",
                res.status,
                res.text[:500],
            )
        code = xml_tag(res.text, "response_code")
        if code is None:
            raise PaymentError(
                "Fonepay verification: unparseable response",
                PROVIDER,
                "malformed_response",
                res.status,
                res.text[:500],
            )
        return code == "successful" and xml_tag(res.text, "success") == "true", res.text

    @staticmethod
    def order_id_from_callback(params: Mapping[str, str]) -> Optional[str]:
        """Your order_id from the return params (PRN)."""
        return params.get("PRN") or None

    # ------------------------------------------------------------------ Dynamic QR

    def qr_create(
        self, order_id: str, amount_paisa: int, remarks1: str, remarks2: str = "N/A"
    ) -> QrCreated:
        """Create a Dynamic QR. Returns qr_message (render as QR), websocket_url and raw."""
        self._require_login()
        assert_paisa(amount_paisa, PROVIDER)
        amount = paisa_to_rupees(amount_paisa)
        validation = self._sign([amount, order_id, self.merchant_code, remarks1, remarks2])
        body = {
            "amount": amount,
            "remarks1": remarks1,
            "remarks2": remarks2,
            "prn": order_id,
            "merchantCode": self.merchant_code,
            "dataValidation": validation.lower(),
            "username": self.username,
            "password": self.password,
        }
        url = f"{self.urls['qr_base']}/thirdPartyDynamicQrDownload"
        res = http(PROVIDER, url, "POST", body=body, timeout=self.timeout)
        data = cast(QrCreateResponse, res.json_object() or {})
        if not data.get("qrMessage"):
            raise http_error(PROVIDER, res, "Fonepay QR create failed")
        ws = data.get("thirdpartyQrWebSocketUrl")
        return {
            "qr_message": data["qrMessage"],
            "websocket_url": public_websocket_url(ws, self.env) if ws else ws,
            "raw": data,
        }

    def qr_status(self, order_id: str, amount_paisa: Optional[int] = None) -> VerifyResult:
        """Status of a Dynamic QR payment.

        Pass the stored amount: the status response has none, but the QR was created server-side
        with it.
        """
        self._require_login()
        body = {
            "prn": order_id,
            "merchantCode": self.merchant_code,
            "dataValidation": self._sign([order_id, self.merchant_code]).lower(),
            "username": self.username,
            "password": self.password,
        }
        url = f"{self.urls['qr_base']}/thirdPartyDynamicQrGetStatus"
        res = http(PROVIDER, url, "POST", body=body, timeout=self.timeout, retries=2)
        data = cast(QrStatusResponse, res.json_object() or {})
        if not isinstance(data.get("paymentStatus"), str):
            raise http_error(PROVIDER, res, "Fonepay QR status failed")
        return VerifyResult(
            PROVIDER,
            TXN_STATUS.get(data["paymentStatus"].lower(), "unknown"),
            order_id,
            amount_paisa,
            trace_id(data),
            data,
        )

    def _require_login(self) -> None:
        if not (self.username and self.password):
            raise RuntimeError("fonepay: username/password required for Dynamic QR")

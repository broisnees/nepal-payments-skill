"""connectIPS (NCHL) e-payment gateway.

Requires `cryptography` (pip install cryptography): the TOKEN is RSA-signed.
"""

from __future__ import annotations

import re
from typing import Any, Mapping, Optional, cast

from ...core.crypto import rsa_sha256_sign_b64
from ...core.errors import PaymentError, http_error
from ...core.http import basic_auth, http
from ...core.money import assert_paisa
from ...core.types import FormResult, VerifyResult
from .endpoints import BASE, CREDITOR_API_PATH, LOGIN_PAGE_PATH
from .responses import ValidationResponse, map_status, paid_amount_paisa
from .signing import clip, connectips_date, connectips_token_string, validation_token_string

PROVIDER = "connectips"

# TXNID charset and length.
_ORDER_ID = re.compile(r"[A-Za-z0-9-]{1,20}")


class ConnectIps:
    id = PROVIDER

    def __init__(
        self,
        env: str,
        merchant_id: Any,
        app_id: str,
        app_name: str,
        app_password: str,
        private_key_pem: bytes,
        base_url: Optional[str] = None,
        timeout: float = 20.0,
    ):
        self.merchant_id = str(merchant_id)
        self.app_id = app_id
        self.app_name = app_name[:30]
        if isinstance(private_key_pem, bytes):
            self.private_key_pem = private_key_pem
        else:
            self.private_key_pem = private_key_pem.encode()
        self.base = base_url or BASE[env]
        self.timeout = timeout
        self._auth = {"Authorization": basic_auth(app_id, app_password)}

    def initiate(
        self,
        order_id: str,
        amount_paisa: int,
        description: str,
        return_url: str = "",
        reference_id: Optional[str] = None,
        remarks: Optional[str] = None,
        particulars: Optional[str] = None,
        **_: Any,
    ) -> FormResult:
        """Signed login-page form.

        Success/failure URLs are registered with NCHL (not sent per request).
        """
        assert_paisa(amount_paisa, PROVIDER)
        if not _ORDER_ID.fullmatch(order_id):
            raise PaymentError(
                "connectIPS TXNID must be 1–20 chars [A-Za-z0-9-]", PROVIDER, "invalid_order_id"
            )
        fields = {
            "MERCHANTID": self.merchant_id,
            "APPID": self.app_id,
            "APPNAME": self.app_name,
            "TXNID": order_id,
            "TXNDATE": connectips_date(),
            "TXNCRNCY": "NPR",
            "TXNAMT": str(amount_paisa),  # paisa
            "REFERENCEID": clip(reference_id or order_id, 20),
            "REMARKS": clip(remarks or description, 50) or "Payment",
            "PARTICULARS": clip(particulars or description, 100) or "Payment",
        }
        fields["TOKEN"] = rsa_sha256_sign_b64(self.private_key_pem, connectips_token_string(fields))
        return FormResult(action=f"{self.base}{LOGIN_PAGE_PATH}", fields=fields)

    def verify(
        self,
        order_id: str,
        amount_paisa: int,
        provider_ref: Optional[str] = None,
        callback: Optional[Mapping[str, str]] = None,
    ) -> VerifyResult:
        """validatetxn (authoritative). The callback carries nothing trustworthy."""
        response = self._validation_call("validatetxn", order_id, amount_paisa)
        return VerifyResult(
            PROVIDER, map_status(response), order_id, paid_amount_paisa(response), None, response
        )

    def get_txn_detail(self, order_id: str, amount_paisa: int) -> ValidationResponse:
        """creditStatus in {"000","999","DEFER"} = credited / OK."""
        return self._validation_call("gettxndetail", order_id, amount_paisa)

    @staticmethod
    def order_id_from_callback(params: Mapping[str, str]) -> Optional[str]:
        """Your order_id (TXNID) from the success/failure redirect."""
        return params.get("TXNID") or params.get("txnId") or None

    def _validation_call(self, path: str, txn_id: str, amount_paisa: int) -> ValidationResponse:
        token_string = validation_token_string(self.merchant_id, self.app_id, txn_id, amount_paisa)
        body = {
            "merchantId": int(self.merchant_id),
            "appId": self.app_id,
            "referenceId": txn_id,  # = TXNID
            "txnAmt": amount_paisa,
            "token": rsa_sha256_sign_b64(self.private_key_pem, token_string),
        }
        url = f"{self.base}{CREDITOR_API_PATH}{path}"
        res = http(PROVIDER, url, "POST", self._auth, body, self.timeout, retries=2)
        if res.status == 401:
            raise PaymentError(
                "connectIPS: 401 — wrong APPID/app password", PROVIDER, "unauthorized", 401
            )
        data = res.json_object()
        if res.status != 200 or data is None or "status" not in data:
            raise http_error(PROVIDER, res, f"connectIPS {path} failed")
        return cast(ValidationResponse, data)

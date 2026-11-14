"""Hamro Pay Checkout (Hamro Patro's wallet). https://hamropay.com.np/checkout/developer/reference/

transactionAmount is PAISA as a string (Rs 10..50,000); every amount Hamro Pay returns is RUPEES.
"""

from __future__ import annotations

import math
import re
from typing import Any, Mapping, Optional, Union, cast

from ...core.crypto import safe_equal
from ...core.errors import PaymentError, http_error
from ...core.http import http
from ...core.money import assert_paisa, paisa_to_rupees, rupees_to_paisa
from ...core.types import FormResult, VerifyResult
from .config import HAMROPAY_MAX_PAISA, HAMROPAY_MIN_PAISA
from .endpoints import API, CREATE_SESSION_PATH, GET_TRANSACTION_PATH, SANDBOX_GATEWAY, TXN_STATUS
from .responses import (
    CreateSessionResponse,
    TransactionResponse,
    echoed_order_id,
    error_code,
    error_message,
    is_unauthorized,
)
from .signing import hamro_pay_sign, webhook_amount_renderings

PROVIDER = "hamropay"

# merchantTxnId charset and length.
_ORDER_ID = re.compile(r"[A-Za-z0-9-]{1,25}")


class HamroPay:
    id = PROVIDER

    def __init__(
        self,
        env: str,
        merchant_id: str,
        client_id: str,
        client_api_key: str,
        client_secret: str,
        webhook_secret: Optional[str] = None,
        api_base_url: Optional[str] = None,
        gateway_url: Optional[str] = None,
        timeout: float = 15.0,
    ):
        """Configure the adapter.

        webhook_secret: shown when you save the webhook URL in the merchant portal; needed for
        verify_webhook().
        api_base_url: default UAT https://uat-payclient.hamropatro.com,
        live https://payclient.hamropatro.com.
        gateway_url: full gateway form URL ({gateway}/api/checkout). Required in production:
        Hamro Pay issues the live host.
        """
        self.merchant_id = merchant_id
        self.client_id = client_id
        self.client_api_key = client_api_key
        self.client_secret = client_secret
        self.webhook_secret = webhook_secret
        self.api = (api_base_url or API[env]).rstrip("/")
        self.gateway = gateway_url or (SANDBOX_GATEWAY if env == "sandbox" else None)
        self.timeout = timeout

    def _post(
        self, path: str, body: dict[str, Any], signed: list[str], retries: int = 0
    ) -> dict[str, Any]:
        """POST with the signed headers; returns the JSON object or raises PaymentError."""
        headers = {
            "Signature": hamro_pay_sign(self.client_secret, signed),
            "Client-Id": self.client_id,
            "Client-API-Key": self.client_api_key,
            # The API drops each TCP connection without marking it closed; a pooled keep-alive
            # socket then fails on the next call. urllib already sends "Connection: close";
            # kept explicit for other transports.
            "Connection": "close",
        }
        res = http(
            PROVIDER, f"{self.api}{path}", "POST", headers, body, self.timeout, retries=retries
        )
        data = res.json_object()
        if is_unauthorized(res.status, data):
            raise PaymentError(
                "Hamro Pay: unauthorized (check Client-Id, Client-API-Key and the client secret)",
                PROVIDER,
                "unauthorized",
                res.status,
                res.data,
            )
        if res.status != 200 or data is None:
            raise http_error(
                PROVIDER,
                res,
                f"Hamro Pay {path} failed",
                detail=error_message(data, res.text),
                code=error_code(data, res.status),
            )
        return data

    def initiate(
        self,
        order_id: str,
        amount_paisa: int,
        description: str,
        return_url: str,
        failure_url: Optional[str] = None,
        customer: Optional[Mapping[str, str]] = None,
        remarks: Optional[str] = None,
        metadata: Optional[Mapping[str, str]] = None,
        **_: Any,
    ) -> FormResult:
        """Create Session, then the signed form for the gateway.

        merchantTxnId = order_id (<= 25 chars). Persist provider_ref (the sessionId). A session
        lives about 10 minutes. A timeout here may still have created the session on Hamro Pay's
        side: retry with a NEW order_id.
        """
        self._validate_initiate(order_id, amount_paisa)
        if not self.gateway:
            raise ValueError(
                "hamropay: gateway_url is required in production "
                "(Hamro Pay issues the live gateway host)"
            )
        transaction_amount = str(amount_paisa)  # signed and sent as the same string
        body = self._session_body(
            order_id,
            transaction_amount,
            paisa_to_rupees(amount_paisa),
            description,
            return_url,
            failure_url,
            customer,
            metadata,
        )
        session_id = self._create_session(order_id, transaction_amount, body)
        token = hamro_pay_sign(
            self.client_secret,
            [
                self.merchant_id,
                order_id,
                session_id,
                transaction_amount,
                self.client_id,
                self.client_api_key,
            ],
        )
        return FormResult(
            action=self.gateway,
            fields={
                "merchant_id": self.merchant_id,
                "session_id": session_id,
                "token": token,
                "merchant_transaction_id": order_id,
                "remarks": (remarks if remarks is not None else description or "")[:250],
            },
            provider_ref=session_id,
        )

    @staticmethod
    def _validate_initiate(order_id: str, amount_paisa: int) -> None:
        assert_paisa(amount_paisa, PROVIDER)
        if amount_paisa < HAMROPAY_MIN_PAISA or amount_paisa > HAMROPAY_MAX_PAISA:
            raise PaymentError(
                "Hamro Pay accepts Rs 10 to Rs 50,000 per transaction", PROVIDER, "invalid_amount"
            )
        if not _ORDER_ID.fullmatch(order_id):
            raise PaymentError(
                "Hamro Pay merchantTxnId must be 1–25 chars [A-Za-z0-9-]",
                PROVIDER,
                "invalid_order_id",
            )

    def _session_body(
        self,
        order_id: str,
        transaction_amount: str,
        rupees: str,
        description: str,
        return_url: str,
        failure_url: Optional[str],
        customer: Optional[Mapping[str, str]],
        metadata: Optional[Mapping[str, str]],
    ) -> dict[str, Any]:
        name = description or "Payment"
        price: Union[int, float] = float(rupees) if "." in rupees else int(rupees)
        body: dict[str, Any] = {
            "merchantTxnId": order_id,
            "merchantId": self.merchant_id,
            "transactionAmount": transaction_amount,
            "successRedirectionUrl": return_url,
            "failedRedirectionUrl": failure_url or return_url,
            "productList": [{"name": name, "description": name, "price": price, "quantity": 1}],
        }
        if customer and customer.get("phone"):
            body["phone_number"] = customer["phone"]
        if metadata:
            body["metadata"] = dict(metadata)
        return body

    def _create_session(self, order_id: str, transaction_amount: str, body: dict[str, Any]) -> str:
        signed = [
            order_id,
            transaction_amount,
            self.merchant_id,
            self.client_id,
            self.client_api_key,
        ]
        session = cast(CreateSessionResponse, self._post(CREATE_SESSION_PATH, body, signed))
        session_id = session.get("sessionId")
        if not isinstance(session_id, str) or not session_id:
            raise PaymentError(
                "Hamro Pay: Create Session returned no sessionId",
                PROVIDER,
                "no_session",
                200,
                session,
            )
        if session.get("merchantId") is not None and session["merchantId"] != self.merchant_id:
            raise PaymentError(
                "Hamro Pay: Create Session answered for a different merchantId",
                PROVIDER,
                "merchant_mismatch",
                200,
                session,
            )
        return session_id

    def verify(
        self,
        order_id: str,
        amount_paisa: int,
        provider_ref: Optional[str] = None,
        callback: Optional[Mapping[str, str]] = None,
    ) -> VerifyResult:
        """Get Transaction: authoritative. amount is rupees, and 0 until the payment finishes."""
        body = {"merchantId": self.merchant_id, "merchantTxnId": order_id}
        signed = [order_id, self.merchant_id, self.client_id, self.client_api_key]
        answer = cast(
            TransactionResponse, self._post(GET_TRANSACTION_PATH, body, signed, retries=2)
        )

        echoed = echoed_order_id(answer)
        if echoed is not None and echoed != "" and str(echoed) != order_id:
            raise PaymentError(
                "Hamro Pay: transaction answer is for a different merchantTxnId",
                PROVIDER,
                "id_mismatch",
                200,
                answer,
            )

        raw_status = answer.get("status")
        status_key = ("" if raw_status is None else str(raw_status)).upper()
        status = TXN_STATUS.get(status_key, "unknown")
        amount = answer.get("amount")
        paid_paisa = rupees_to_paisa(amount) if status == "paid" and amount is not None else None
        tracking = answer.get("trackingId")
        return VerifyResult(
            PROVIDER,
            status,
            order_id,
            paid_paisa,
            tracking if isinstance(tracking, str) and tracking else None,
            answer,
        )

    @staticmethod
    def order_id_from_callback(params: Mapping[str, str]) -> Optional[str]:
        """Success and failure redirects carry ?MerchantTxnId=<your order_id>."""
        return params.get("MerchantTxnId") or params.get("merchantTxnId") or None

    def verify_webhook(self, body: Mapping[str, Any], signature: Optional[str]) -> bool:
        """Check a webhook's "Signature" header. Fulfil only after verify().

        Hamro Pay signs its own rendering of the amount (a double), which may be "1200", "1200.0"
        or "1200.00", so every form of the PARSED number is tried.
        """
        if not self.webhook_secret:
            raise ValueError("hamropay: webhook_secret required to verify webhooks")
        if not isinstance(signature, str) or not signature:
            return False
        amount = body.get("amount")
        if isinstance(amount, bool) or not isinstance(amount, (int, float)):
            return False
        if not math.isfinite(amount):
            return False
        prefix = [body.get("merchantTxnId"), body.get("merchantId"), body.get("status")]
        if any(not isinstance(v, str) or not v or "," in v for v in prefix):
            return False

        # Every rendering is checked (no early exit).
        ok = False
        for rendering in webhook_amount_renderings(amount):
            expected = hamro_pay_sign(self.webhook_secret, [*prefix, rendering])
            if safe_equal(expected, signature):
                ok = True
        return ok

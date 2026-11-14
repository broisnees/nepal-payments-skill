"""NEPALPAY QR (NCHL) merchant dynamic QR.

https://doc.connectips.com/docs/NepalPAY-QR/Merchant-QR-generation/introduction
Requires `cryptography` (pip install cryptography).

Flow: server signs token (RSA-SHA256) -> POST /qr/generateQR -> show qr_string / qr_image ->
      customer scans with any NEPALPAY QR / mobile banking app ->
      poll /nQR/v1/merchanttxnreport by validationTraceId (= provider_ref).
"""

from __future__ import annotations

import re
import time
import urllib.parse
from typing import Any, Mapping, Optional, Union, cast

from ...core.crypto import rsa_pkcs1_encrypt_b64, rsa_sha256_sign_b64, rsa_sha256_verify_b64
from ...core.errors import PaymentError, http_error
from ...core.http import basic_auth, http
from ...core.money import assert_paisa, paisa_to_rupees_2dp, rupees_to_paisa
from ...core.types import QrResult, VerifyResult
from .endpoints import (
    BASE,
    GENERATE_QR_OK,
    GENERATE_QR_PATH,
    NPR,
    OAUTH_TOKEN_PATH,
    REPORT_NOT_FOUND,
    REPORT_OK,
    TXN_REPORT_PATH,
    WS_SEND,
    WS_SUBSCRIBE,
)
from .responses import (
    ConfirmationResponse,
    GeneratedQr,
    ReportRow,
    WebSocketRequest,
    generate_qr_error_code,
    payment_status,
    payments_only,
    pick_payment,
)
from .signing import (
    confirmation_response_string,
    nepal_pay_confirmation_string,
    nepal_pay_token_string,
)

PROVIDER = "nepalpay"

# billNumber charset and length.
_ORDER_ID = re.compile(r"[A-Za-z0-9-]{1,25}")


class NepalPay:
    id = PROVIDER

    def __init__(
        self,
        env: str,
        acquirer_id: str,
        merchant_id: str,
        merchant_name: str,
        merchant_category_code: Union[str, int],
        merchant_city: str,
        merchant_postal_code: str,
        store_label: str,
        username: str,
        password: str,
        private_key_pem: bytes,
        terminal_label: Optional[str] = None,
        auth: str = "basic",
        client_id: Optional[str] = None,
        client_secret: Optional[str] = None,
        qr_image: bool = True,
        nchl_public_key_pem: Optional[Union[str, bytes]] = None,
        ws_url: Optional[str] = None,
        ws_username: Optional[str] = None,
        ws_api_token: Optional[str] = None,
        base_url: Optional[str] = None,
        timeout: float = 20.0,
    ):
        """Configure the adapter.

        acquirer_id: 8 digits (your acquiring bank). merchant_name: <= 25 chars, must match the
        enrolled name. username: NPI user, also the `userId` inside the signed token.
        private_key_pem: from the NPI .pfx.
        auth: "basic" (merchant QR doc) or "oauth" (NPI password grant, needs
        client_id/client_secret).
        nchl_public_key_pem: NCHL's public key (SPKI PEM, from NPI.cer); verifies confirm-payment
        notifications and encrypts the WebSocket api_token.
        ws_url / ws_username / ws_api_token: the WebSocket channel issued by NCHL
        (STOMP endpoint ending in /nqrws), with its own username and API token.
        """
        self.acquirer_id = acquirer_id
        self.merchant_id = merchant_id
        self.merchant_name = merchant_name
        self.merchant_category_code = merchant_category_code
        self.merchant_city = merchant_city
        self.merchant_postal_code = merchant_postal_code
        self.store_label = store_label
        self.terminal_label = terminal_label
        self.username = username
        self.password = password
        if isinstance(private_key_pem, bytes):
            self.private_key_pem = private_key_pem
        else:
            self.private_key_pem = private_key_pem.encode()
        self.auth = auth
        self.client_id = client_id
        self.client_secret = client_secret
        self.qr_image = qr_image
        self.nchl_public_key_pem = nchl_public_key_pem
        self.ws_url = ws_url
        self.ws_username = ws_username
        self.ws_api_token = ws_api_token
        self.base = base_url or BASE[env]
        self.timeout = timeout
        self._cached: Optional[tuple[str, float]] = None  # (token, until epoch seconds)

    # ------------------------------------------------------------------ QR

    def initiate(
        self, order_id: str, amount_paisa: int, description: str, return_url: str = "", **_: Any
    ) -> QrResult:
        """Dynamic QR. billNumber = order_id (<= 25 chars).

        Persist `provider_ref` (validationTraceId): verify() needs it.
        return_url is unused: there is no redirect, the payer scans the QR from their own app.
        """
        assert_paisa(amount_paisa, PROVIDER)
        if not _ORDER_ID.fullmatch(order_id):
            raise PaymentError(
                "NEPALPAY billNumber must be 1–25 chars [A-Za-z0-9-]", PROVIDER, "invalid_order_id"
            )
        transaction_amount = paisa_to_rupees_2dp(amount_paisa)  # always 2 decimals
        body = self._generate_qr_body(order_id, transaction_amount, description)
        res = http(
            PROVIDER,
            f"{self.base}{GENERATE_QR_PATH}",
            "POST",
            {"Authorization": self._auth_header()},
            body,
            self.timeout,
        )
        answer = res.json_object() or {}
        data = answer.get("data") if isinstance(answer.get("data"), dict) else {}
        qr_ok = data.get("qrString") and data.get("validationTraceId")
        if answer.get("responseCode") != GENERATE_QR_OK or not qr_ok:
            raise PaymentError(
                f"NEPALPAY generateQR failed: {res.text[:300]}",
                PROVIDER,
                generate_qr_error_code(answer, res.status),
                res.status,
                res.data,
            )
        qr = cast(GeneratedQr, data)
        return QrResult(
            qr_string=str(qr["qrString"]).strip(),
            provider_ref=str(qr["validationTraceId"]),
            qr_image=str(qr["qrImage"]) if qr.get("qrImage") else None,
            raw=res.data,
        )

    def _generate_qr_body(
        self, order_id: str, transaction_amount: str, description: str
    ) -> dict[str, Any]:
        token = rsa_sha256_sign_b64(
            self.private_key_pem,
            nepal_pay_token_string(
                self.acquirer_id,
                self.merchant_id,
                self.merchant_category_code,
                NPR,
                transaction_amount,
                order_id,
                self.username,
            ),
        )
        return {
            "pointOfInitialization": 12,
            "acquirerId": self.acquirer_id,
            "merchantId": self.merchant_id,
            "merchantName": self.merchant_name[:25],
            "merchantCategoryCode": int(self.merchant_category_code),
            "merchantCountry": "NP",
            "merchantCity": self.merchant_city,
            "merchantPostalCode": self.merchant_postal_code,
            "merchantLanguage": "en",
            "transactionCurrency": NPR,
            "transactionAmount": transaction_amount,
            "valueOfConvenienceFeeFixed": "0.00",
            "billNumber": order_id,
            "storeLabel": self.store_label,
            "terminalLabel": self.terminal_label or "0",
            "purposeOfTransaction": (description or "Payment")[:25],
            "qrImage": self.qr_image,
            "token": token,
        }

    def report(self, validation_trace_id: str) -> list[ReportRow]:
        """Every payment made against one QR (a failed scan can be retried on the same QR)."""
        body = {
            "validationTraceId": validation_trace_id,
            "merchantId": self.merchant_id,
            "acquirerId": self.acquirer_id,
        }
        res = http(
            PROVIDER,
            f"{self.base}{TXN_REPORT_PATH}",
            "POST",
            {"Authorization": self._auth_header()},
            body,
            self.timeout,
            retries=2,
        )
        if res.status == 401:
            raise PaymentError(
                "NEPALPAY: 401 — wrong NPI username/password",
                PROVIDER,
                "unauthorized",
                401,
                res.data,
            )
        answer = res.json_object() or {}
        code = str(answer.get("responseCode") or "")
        if code == REPORT_NOT_FOUND:
            return []
        if code not in REPORT_OK:
            raise http_error(PROVIDER, res, "NEPALPAY report failed", code=code or None)
        rows = answer.get("responseBody")
        return rows if isinstance(rows, list) else []

    def verify(
        self,
        order_id: str,
        amount_paisa: int,
        provider_ref: Optional[str] = None,
        callback: Optional[Mapping[str, str]] = None,
    ) -> VerifyResult:
        """merchanttxnreport by validationTraceId: authoritative."""
        if not provider_ref:
            raise PaymentError(
                "NEPALPAY verify needs providerRef (validationTraceId)",
                PROVIDER,
                "missing_provider_ref",
            )
        rows = self.report(provider_ref)
        pick = pick_payment(payments_only(rows))
        amount = None
        transaction_id = None
        if pick is not None:
            if pick.get("amount") is not None:
                amount = rupees_to_paisa(pick["amount"])
            transaction_id = pick.get("nQrTxnId")
        return VerifyResult(PROVIDER, payment_status(pick), order_id, amount, transaction_id, rows)

    @staticmethod
    def order_id_from_callback(params: Mapping[str, str]) -> Optional[str]:
        """Your order_id from a confirm-payment notification.

        merchantBillNo = the billNumber you sent.
        """
        return params.get("merchantBillNo") or params.get("billNumber") or None

    # ------------------------------------------------------------------ notifications

    def verify_confirmation(self, n: Mapping[str, Any]) -> bool:
        """Check a confirm-payment notification's signature with nchl_public_key_pem.

        NCHL doesn't say which key signs it, so False here is a reason to log and alert,
        not proof of forgery. Fulfil only after verify() either way.
        """
        if not self.nchl_public_key_pem:
            raise ValueError("nepalpay: nchl_public_key_pem required to verify notifications")
        signature = n.get("signature")
        if not isinstance(signature, str):
            return False
        return rsa_sha256_verify_b64(
            self.nchl_public_key_pem, nepal_pay_confirmation_string(n), signature
        )

    def web_socket_request(self, validation_trace_id: str) -> WebSocketRequest:
        """Everything a STOMP client needs to watch one QR live.

        Connect to `url`, subscribe to `subscribe`, then send `body` as JSON to `send`.
        Statuses arrive as ENTR, PARSED, then COMPLETED or FAILED. On COMPLETED, call verify().
        """
        configured = (
            self.ws_url and self.ws_username and self.ws_api_token and self.nchl_public_key_pem
        )
        if not configured:
            raise ValueError(
                "nepalpay: ws_url, ws_username, ws_api_token and nchl_public_key_pem required "
                "for the WebSocket channel"
            )
        api_token = rsa_pkcs1_encrypt_b64(
            cast(Union[str, bytes], self.nchl_public_key_pem), cast(str, self.ws_api_token)
        )
        return {
            "url": self.ws_url,
            "subscribe": WS_SUBSCRIBE,
            "send": WS_SEND,
            "body": {
                "merchant_id": self.terminal_label or "0",
                "request_id": validation_trace_id,
                "username": self.ws_username,
                "api_token": api_token,
            },
        }

    def confirmation_response(
        self, txn_date: str, merchant_bill_no: str, payment_ref: str, ok: bool = True
    ) -> ConfirmationResponse:
        """Signed reply to NCHL's POST {your base}/nepalpay/confirm-payment notification.

        The notification is a hint: call verify() before fulfilling.
        """
        status = "SUCCESS" if ok else "FAILED"
        message = "TRANSACTION SUCCESSFUL" if ok else "TRANSACTION FAILED"
        token_string = confirmation_response_string(
            txn_date, status, message, merchant_bill_no, payment_ref
        )
        return {
            "txnDate": txn_date,
            "status": status,
            "message": message,
            "merchantBillNo": merchant_bill_no,
            "paymentRef": payment_ref,
            "signature": rsa_sha256_sign_b64(self.private_key_pem, token_string),
        }

    # ------------------------------------------------------------------ auth

    def _auth_header(self) -> str:
        """Basic credentials, or a cached OAuth bearer token (password grant)."""
        if self.auth == "basic":
            return basic_auth(self.username, self.password)
        if not self.client_id or not self.client_secret:
            raise ValueError('nepalpay: client_id/client_secret required for auth "oauth"')
        cached = self._cached_token()
        if cached:
            return f"Bearer {cached}"
        return f"Bearer {self._fetch_token(self.client_id, self.client_secret)}"

    def _cached_token(self) -> Optional[str]:
        if self._cached and self._cached[1] > time.time():
            return self._cached[0]
        return None

    def _fetch_token(self, client_id: str, client_secret: str) -> str:
        body = urllib.parse.urlencode(
            {"grant_type": "password", "username": self.username, "password": self.password}
        )
        headers = {
            "Authorization": basic_auth(client_id, client_secret),
            "Content-Type": "application/x-www-form-urlencoded",
        }
        res = http(PROVIDER, f"{self.base}{OAUTH_TOKEN_PATH}", "POST", headers, body, self.timeout)
        answer = res.json_object() or {}
        if res.status != 200 or not answer.get("access_token"):
            raise http_error(PROVIDER, res, "NEPALPAY oauth failed", code="unauthorized")
        token = answer["access_token"]
        # Refresh 30 s early, but keep a token at least 5 s; 60 s when expires_in is missing.
        self._cached = (token, time.time() + max(_ttl_seconds(answer) - 30, 5))
        return token


def _ttl_seconds(answer: Mapping[str, Any]) -> float:
    try:
        return float(answer.get("expires_in") or 0) or 60
    except (TypeError, ValueError):
        return 60

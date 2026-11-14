"""eSewa — ePay v2 (web/WebView) + Intent (mobile app-to-app). https://developer.esewa.com.np"""

from __future__ import annotations

import binascii
import json
import re
import urllib.parse
from typing import Any, Mapping, Optional, Union, cast

from ...core.crypto import safe_equal
from ...core.encoding import b64decode_lenient, base64_json, js_string
from ...core.errors import PaymentError, http_error
from ...core.http import HttpResponse, http
from ...core.money import assert_paisa, paisa_to_rupees, rupees_to_paisa
from ...core.types import FormResult, VerifyResult
from .endpoints import EPAY_STATUS, INTENT_STATUS, URLS
from .responses import (
    EpayStatusResponse,
    IntentBookData,
    IntentBooking,
    IntentStatusData,
    error_code,
    error_message,
    intent_data,
)
from .signing import (
    EPAY_SIGNED_FIELDS,
    INTENT_BOOK_SIGNED_FIELDS,
    INTENT_CANCEL_SIGNED_FIELDS,
    INTENT_STATUS_SIGNED_FIELDS,
    esewa_sign,
    raw_value,
    signed_field_order,
)

PROVIDER = "esewa"

# eSewa's transaction_uuid charset.
_ORDER_ID = re.compile(r"[A-Za-z0-9-]+")


class Esewa:
    id = PROVIDER

    def __init__(
        self,
        env: str,
        product_code: str,
        secret_key: str,
        intent_product_code: Optional[str] = None,
        intent_access_key: Optional[str] = None,
        intent_base_url: Optional[str] = None,
        form_url: Optional[str] = None,
        status_url: Optional[str] = None,
        strict_signature: bool = True,
        timeout: float = 15.0,
    ):
        urls = URLS[env]
        self.env = env
        self.product_code = product_code
        # Keys copied from eSewa's HTML docs often keep the "&amp;" entity.
        self.secret = secret_key.replace("&amp;", "&")
        self.form_url = form_url or urls["form"]
        self.status_url = status_url or urls["status"]
        self.intent_product_code = intent_product_code
        self.intent_access_key = intent_access_key
        self.intent_base_url = intent_base_url or urls["intent"]
        self.strict = strict_signature
        self.timeout = timeout

    # ------------------------------------------------------------------ ePay v2

    def initiate(
        self,
        order_id: str,
        amount_paisa: int,
        description: str,
        return_url: str,
        failure_url: Optional[str] = None,
        tax_paisa: int = 0,
        service_charge_paisa: int = 0,
        delivery_charge_paisa: int = 0,
        **_: Any,
    ) -> FormResult:
        """Form to auto-submit.

        amount_paisa is the TOTAL charged (store it; pass it to verify); tax/charges are an
        optional breakdown included in it. Keep return/failure URLs free of query strings;
        the id goes in the path.
        """
        assert_paisa(amount_paisa, PROVIDER)
        if not _ORDER_ID.fullmatch(order_id):
            raise PaymentError(
                "eSewa transaction_uuid allows only letters, digits and '-'",
                PROVIDER,
                "invalid_order_id",
            )
        extras = (tax_paisa, service_charge_paisa, delivery_charge_paisa)
        base_paisa = amount_paisa - sum(extras)
        extras_invalid = any(not isinstance(n, int) or n < 0 for n in extras)
        if extras_invalid or base_paisa <= 0:
            raise PaymentError(
                "eSewa: tax/charges must be non-negative paisa and less than the total",
                PROVIDER,
                "invalid_amount",
            )
        fields = {
            "amount": paisa_to_rupees(base_paisa),
            "tax_amount": paisa_to_rupees(tax_paisa),
            "product_service_charge": paisa_to_rupees(service_charge_paisa),
            "product_delivery_charge": paisa_to_rupees(delivery_charge_paisa),
            "total_amount": paisa_to_rupees(amount_paisa),
            "transaction_uuid": order_id,
            "product_code": self.product_code,
            "success_url": return_url,
            "failure_url": failure_url or return_url,
            "signed_field_names": ",".join(EPAY_SIGNED_FIELDS),
        }
        fields["signature"] = esewa_sign(self.secret, fields, EPAY_SIGNED_FIELDS)
        return FormResult(action=self.form_url, fields=fields)

    def parse_success(self, data: str) -> tuple[dict[str, Any], bool]:
        """Decode + verify the base64 `data` param. Returns (payload, signature_valid).

        Not proof of payment: always confirm with verify().
        """
        try:
            text = b64decode_lenient(data).decode("utf-8")
            payload = json.loads(text)
        except (binascii.Error, ValueError) as e:
            # UnicodeDecodeError and JSONDecodeError are ValueErrors.
            raise PaymentError(
                "eSewa: success data is not base64 JSON",
                PROVIDER,
                "malformed_callback",
                400,
                data,
            ) from e
        if not isinstance(payload, dict) or not isinstance(payload.get("signed_field_names"), str):
            raise PaymentError(
                "eSewa: malformed success payload", PROVIDER, "malformed_callback", 400, payload
            )
        return payload, self._success_signature_valid(text, payload)

    def _success_signature_valid(self, text: str, payload: Mapping[str, Any]) -> bool:
        order = signed_field_order(payload["signed_field_names"])
        fields = {name: raw_value(text, payload, name) for name in order}
        signature = str(payload.get("signature", ""))
        if safe_equal(esewa_sign(self.secret, fields, order), signature):
            return True
        # A total sent with thousands separators ("1,000.0"): also try it without them.
        total = fields.get("total_amount", "")
        if "," not in total:
            return False
        without_commas = {**fields, "total_amount": total.replace(",", "")}
        return safe_equal(esewa_sign(self.secret, without_commas, order), signature)

    def verify(
        self,
        order_id: str,
        amount_paisa: int,
        provider_ref: Optional[str] = None,
        callback: Optional[Mapping[str, str]] = None,
    ) -> VerifyResult:
        """Status API (authoritative).

        amount_paisa = TOTAL charged; a wrong total returns NOT_FOUND.

        A success `callback` ({"data": ...}) is checked first: wrong order or bad signature raises.
        """
        signature_valid = None
        if callback and callback.get("data"):
            signature_valid = self._check_success_callback(callback["data"], order_id)

        status = self._fetch_status(order_id, amount_paisa)
        total = status.get("total_amount")
        return VerifyResult(
            PROVIDER,
            EPAY_STATUS.get(status["status"], "unknown"),
            order_id,
            rupees_to_paisa(total) if total is not None else None,
            status.get("ref_id"),
            {"status": status, "signature_valid": signature_valid},
        )

    def _check_success_callback(self, data: str, order_id: str) -> bool:
        payload, signature_valid = self.parse_success(data)
        same_attempt = (
            payload.get("transaction_uuid") == order_id
            and payload.get("product_code") == self.product_code
        )
        if not same_attempt:
            raise PaymentError(
                "eSewa: callback does not match this attempt",
                PROVIDER,
                "callback_mismatch",
                400,
                payload,
            )
        if not signature_valid and self.strict:
            raise PaymentError(
                "eSewa: invalid response signature", PROVIDER, "invalid_signature", 400, payload
            )
        return signature_valid

    def _fetch_status(self, order_id: str, amount_paisa: int) -> EpayStatusResponse:
        query = urllib.parse.urlencode(
            {
                "product_code": self.product_code,
                "total_amount": paisa_to_rupees(amount_paisa),
                "transaction_uuid": order_id,
            }
        )
        res = http(PROVIDER, f"{self.status_url}?{query}", timeout=self.timeout, retries=2)
        body = res.data
        if res.status != 200 or not isinstance(body, dict) or "status" not in body:
            raise self._error(res, "eSewa status check failed")
        return cast(EpayStatusResponse, body)

    @staticmethod
    def order_id_from_callback(params: Mapping[str, str]) -> Optional[str]:
        """Your order_id from the success redirect (`data`) or from your own query params."""
        if params.get("data"):
            try:
                return str(base64_json(params["data"]).get("transaction_uuid") or "") or None
            except Exception:
                return None
        return (
            params.get("orderId")
            or params.get("order_id")
            or params.get("transaction_uuid")
            or None
        )

    # ------------------------------------------------------------------ Intent (mobile)

    def _intent(self) -> tuple[str, str, str]:
        """(product_code, access_key, base_url) for Intent calls; raises when not configured."""
        if not (self.intent_product_code and self.intent_access_key):
            raise RuntimeError(
                "eSewa: configure intent_product_code / intent_access_key for Intent payments"
            )
        if not self.intent_base_url:
            raise RuntimeError(
                "eSewa: production Intent base URL is issued by eSewa at go-live; "
                "pass intent_base_url"
            )
        return self.intent_product_code, self.intent_access_key, self.intent_base_url

    def intent_book(
        self,
        order_id: str,
        amount_paisa: int,
        callback_url: str,
        redirect_url: str,
        properties: Optional[Mapping[str, str]] = None,
    ) -> IntentBooking:
        """Book an Intent payment.

        Returns booking_id, deeplink, correlation_id and provider_ref
        ("booking_id|correlation_id": persist it).
        """
        code, key, base = self._intent()
        assert_paisa(amount_paisa, PROVIDER)
        amount_text = paisa_to_rupees(amount_paisa)
        # Sent as a JSON number (100 or 100.5) but signed as its text.
        amount: Union[int, float] = float(amount_text) if "." in amount_text else int(amount_text)
        signed = {"product_code": code, "amount": str(amount), "transaction_uuid": order_id}
        body = {
            **signed,
            "amount": amount,
            "signed_field_names": ",".join(INTENT_BOOK_SIGNED_FIELDS),
            "signature": esewa_sign(key, signed, INTENT_BOOK_SIGNED_FIELDS),
            "callback_url": callback_url,
            "redirect_url": redirect_url,
            "properties": dict(properties or {"remarks": order_id}),
        }
        res = http(PROVIDER, f"{base}/book", "POST", body=body, timeout=self.timeout)
        data = intent_data(res.data)
        if not data or not data.get("booking_id"):
            raise self._error(res, "eSewa intent book failed")
        booking = cast(IntentBookData, data)
        return {
            "booking_id": booking["booking_id"],
            "deeplink": booking["deeplink"],
            "correlation_id": booking["correlation_id"],
            "provider_ref": f"{booking['booking_id']}|{booking['correlation_id']}",
            "raw": res.data,
        }

    def intent_verify(
        self, order_id: str, provider_ref: str, amount_paisa: Optional[int] = None
    ) -> VerifyResult:
        """Status of a booked Intent payment.

        Pass the stored amount: the status response has none, but the amount was signed at booking.
        """
        code, key, base = self._intent()
        booking_id, correlation_id = provider_ref.split("|", 1)
        fields = {"booking_id": booking_id, "product_code": code, "correlation_id": correlation_id}
        body = self._signed_intent_body(key, fields, INTENT_STATUS_SIGNED_FIELDS)
        res = http(PROVIDER, f"{base}/status", "POST", body=body, timeout=self.timeout, retries=2)
        data = intent_data(res.data)
        if not data or not data.get("status"):
            raise self._error(res, "eSewa intent status failed")
        status = cast(IntentStatusData, data)
        if status.get("transaction_id") and status["transaction_id"] != order_id:
            raise PaymentError(
                "eSewa intent: status is for a different transaction",
                PROVIDER,
                "callback_mismatch",
                400,
                data,
            )
        return VerifyResult(
            PROVIDER,
            INTENT_STATUS.get(status["status"], "unknown"),
            order_id,
            amount_paisa,
            status.get("reference_code"),
            res.data,
        )

    def intent_cancel(self, provider_ref: str) -> Any:
        """Cancel a booked Intent payment. Returns eSewa's parsed answer."""
        code, key, base = self._intent()
        fields = {"booking_id": provider_ref.split("|", 1)[0], "product_code": code}
        body = self._signed_intent_body(key, fields, INTENT_CANCEL_SIGNED_FIELDS)
        return http(PROVIDER, f"{base}/cancel", "POST", body=body, timeout=self.timeout).data

    def intent_callback_valid(self, body: Union[Mapping[str, Any], str, bytes]) -> bool:
        """Verify eSewa's Intent callback signature. Still call intent_verify() before fulfilling.

        Prefer the RAW request body (str/bytes): numbers are then also checked exactly as eSewa
        sent them ("100.0"), not only in the JavaScript String(v) form ("100"). A parsed dict can
        only be checked in the String(v) form.
        """
        _, key, _ = self._intent()
        text: Optional[str] = None
        if isinstance(body, (str, bytes)):
            try:
                text = body.decode("utf-8") if isinstance(body, bytes) else body
                payload = json.loads(text)
            except ValueError:
                return False
        else:
            payload = body
        if not isinstance(payload, Mapping):
            return False

        names = payload.get("signed_field_names")
        signature = payload.get("signature")
        if not isinstance(names, str) or not isinstance(signature, str):
            return False
        order = signed_field_order(names)

        as_string = {name: js_string(payload.get(name)) for name in order}
        if safe_equal(esewa_sign(key, as_string, order), signature):
            return True
        if text is None:
            return False
        exact = {name: raw_value(text, payload, name) for name in order}
        return exact != as_string and safe_equal(esewa_sign(key, exact, order), signature)

    # ------------------------------------------------------------------ helpers

    @staticmethod
    def _signed_intent_body(key: str, fields: dict[str, str], order: list[str]) -> dict[str, str]:
        return {
            **fields,
            "signed_field_names": ",".join(order),
            "signature": esewa_sign(key, fields, order),
        }

    @staticmethod
    def _error(res: HttpResponse, summary: str) -> PaymentError:
        return http_error(
            PROVIDER,
            res,
            summary,
            detail=error_message(res.data, res.text),
            code=error_code(res.data, res.status),
        )

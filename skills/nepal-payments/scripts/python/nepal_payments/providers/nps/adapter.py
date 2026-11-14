"""Nepal Payment Solution (NPS / NPX) OnePG: Basic auth + HMAC-SHA512 signed JSON API."""

from __future__ import annotations

from typing import Any, Mapping, Optional, cast

from ...core.errors import PaymentError, http_error
from ...core.http import basic_auth, http
from ...core.money import assert_paisa, paisa_to_rupees, rupees_to_paisa
from ...core.types import FormResult, VerifyResult
from .endpoints import STATUS, URLS
from .responses import (
    NpsEnvelope,
    TransactionStatusData,
    api_failure,
    is_not_initialized,
)
from .signing import nps_sign

PROVIDER = "nps"


class Nps:
    id = PROVIDER

    def __init__(
        self,
        env: str,
        merchant_id: str,
        merchant_name: str,
        api_username: str,
        api_password: str,
        secret_key: str,
        api_base_url: Optional[str] = None,
        gateway_url: Optional[str] = None,
        timeout: float = 20.0,
    ):
        self.api = api_base_url or URLS[env]["api"]
        self.gateway = gateway_url or URLS[env]["gateway"]
        self.merchant = {"MerchantId": merchant_id, "MerchantName": merchant_name}
        self.secret = secret_key
        self.timeout = timeout
        self._auth = {"Authorization": basic_auth(api_username, api_password)}

    def _call(self, path: str, payload: Mapping[str, str], retries: int = 0) -> NpsEnvelope:
        """POST a signed payload. Raises on HTTP errors; the caller checks code == "0"."""
        body = {**payload, "Signature": nps_sign(self.secret, payload)}
        res = http(PROVIDER, f"{self.api}/{path}", "POST", self._auth, body, self.timeout, retries)
        if res.status == 401:
            raise PaymentError(
                "NPS: 401 — wrong API username/password", PROVIDER, "unauthorized", 401
            )
        if res.status != 200 or not isinstance(res.data, dict) or "code" not in res.data:
            raise http_error(PROVIDER, res, f"NPS {path} failed")
        return cast(NpsEnvelope, res.data)

    def get_instruments(self) -> list[Any]:
        """Payment instruments enabled for this merchant (banks, wallets, cards)."""
        path = "GetPaymentInstrumentDetails"
        answer = self._call(path, self.merchant, 2)
        if answer["code"] != "0":
            raise api_failure(path, answer)
        return answer["data"]

    def get_service_charge(self, amount_paisa: int, instrument_code: str) -> dict[str, Any]:
        """Service charge NPS adds for `instrument_code` on this amount."""
        path = "GetServiceCharge"
        payload = {
            **self.merchant,
            "Amount": paisa_to_rupees(amount_paisa),
            "InstrumentCode": instrument_code,
        }
        answer = self._call(path, payload, 2)
        if answer["code"] != "0":
            raise api_failure(path, answer)
        return answer["data"]

    def initiate(
        self,
        order_id: str,
        amount_paisa: int,
        description: str,
        return_url: str,
        instrument_code: Optional[str] = None,
        **_: Any,
    ) -> FormResult:
        """GetProcessId + multipart form. Persist provider_ref (= ProcessId).

        The Notification URL is set with NPS, not per request.
        """
        assert_paisa(amount_paisa, PROVIDER)
        amount = paisa_to_rupees(amount_paisa)
        process_id = self._get_process_id(order_id, amount)
        fields = {
            **self.merchant,
            "Amount": amount,
            "MerchantTxnId": order_id,
            "ProcessId": process_id,
            "TransactionRemarks": description[:100],
            "ResponseUrl": return_url,
        }
        if instrument_code:
            fields["InstrumentCode"] = instrument_code
        return FormResult(
            action=self.gateway,
            fields=fields,
            enctype="multipart/form-data",
            provider_ref=process_id,
        )

    def _get_process_id(self, order_id: str, amount: str) -> str:
        path = "GetProcessId"
        answer = self._call(path, {**self.merchant, "Amount": amount, "MerchantTxnId": order_id})
        if answer["code"] != "0" or not (answer.get("data") or {}).get("ProcessId"):
            raise api_failure(path, answer)
        return answer["data"]["ProcessId"]

    def verify(
        self,
        order_id: str,
        amount_paisa: int,
        provider_ref: Optional[str] = None,
        callback: Optional[Mapping[str, str]] = None,
    ) -> VerifyResult:
        """CheckTransactionStatus by MerchantTxnId (authoritative)."""
        path = "CheckTransactionStatus"
        answer = self._call(path, {**self.merchant, "MerchantTxnId": order_id}, 2)
        if answer["code"] != "0":
            if is_not_initialized(answer):
                return VerifyResult(PROVIDER, "not_found", order_id, None, None, answer)
            raise api_failure(path, answer)

        # code "0" + null data: report unknown.
        raw_data = answer.get("data")
        data = cast(TransactionStatusData, raw_data if isinstance(raw_data, dict) else {})
        if data.get("MerchantTxnId") and data["MerchantTxnId"] != order_id:
            raise PaymentError(
                "NPS: status is for a different transaction",
                PROVIDER,
                "callback_mismatch",
                400,
                data,
            )
        amount = data.get("Amount")
        return VerifyResult(
            PROVIDER,
            STATUS.get(str(data.get("Status", "")).lower(), "unknown"),
            order_id,
            rupees_to_paisa(amount) if amount else None,
            data.get("GatewayReferenceNo"),
            answer,
        )

    @staticmethod
    def order_id_from_callback(params: Mapping[str, str]) -> Optional[str]:
        """Your order_id from the ResponseUrl redirect or the notification (MerchantTxnId)."""
        return params.get("MerchantTxnId") or None

    @staticmethod
    def notification_response(already_processed: bool) -> str:
        """Plain-text body for your Notification URL handler, after verifying + recording."""
        return "already received" if already_processed else "received"

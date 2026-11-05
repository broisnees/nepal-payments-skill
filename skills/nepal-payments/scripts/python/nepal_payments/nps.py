"""Nepal Payment Solution (NPS / NPX) OnePG. Basic auth + HMAC-SHA512 (lowercase hex) over the values of
alphabetically sorted payload keys (excluding Signature), concatenated with no separator."""

from __future__ import annotations

from typing import Any, Mapping, Optional

from .core import (FormResult, PaymentError, VerifyResult, assert_paisa, basic_auth, hmac_digest, http,
                   paisa_to_rupees, rupees_to_paisa)

URLS = {
    "sandbox": {"api": "https://apisandbox.nepalpayment.com", "gateway": "https://gatewaysandbox.nepalpayment.com/Payment/Index"},
    "production": {"api": "https://apigateway.nepalpayment.com", "gateway": "https://gateway.nepalpayment.com/Payment/Index"},
}
STATUS = {"success": "paid", "fail": "failed", "failed": "failed", "pending": "pending"}


def nps_sign(secret_key: str, payload: Mapping[str, str]) -> str:
    message = "".join(str(payload[k]) for k in sorted(payload) if k != "Signature")
    return hmac_digest("sha512", secret_key, message).hex()


class Nps:
    id = "nps"

    def __init__(self, env: str, merchant_id: str, merchant_name: str, api_username: str, api_password: str,
                 secret_key: str, api_base_url: Optional[str] = None, gateway_url: Optional[str] = None,
                 timeout: float = 20.0):
        self.api = api_base_url or URLS[env]["api"]
        self.gateway = gateway_url or URLS[env]["gateway"]
        self.merchant = {"MerchantId": merchant_id, "MerchantName": merchant_name}
        self.secret = secret_key
        self.timeout = timeout
        self._auth = {"Authorization": basic_auth(api_username, api_password)}

    def _call(self, path: str, payload: Mapping[str, str], retries: int = 0) -> dict:
        body = {**payload, "Signature": nps_sign(self.secret, payload)}
        res = http("nps", f"{self.api}/{path}", "POST", self._auth, body, self.timeout, retries)
        if res.status == 401:
            raise PaymentError("NPS: 401 — wrong API username/password", "nps", "unauthorized", 401)
        if res.status != 200 or not isinstance(res.data, dict) or "code" not in res.data:
            raise PaymentError(f"NPS {path} failed: {res.text[:200]}", "nps", f"http_{res.status}", res.status, res.data)
        return res.data

    @staticmethod
    def _fail(path: str, r: dict) -> PaymentError:
        errs = r.get("errors") or []
        msg = "; ".join(e.get("error_message", "") for e in errs) or r.get("message", "")
        code = f"nps_{errs[0].get('error_code')}" if errs else "nps_error"
        return PaymentError(f"NPS {path}: {msg}", "nps", code, 200, r)

    def get_instruments(self) -> list:
        r = self._call("GetPaymentInstrumentDetails", self.merchant, 2)
        if r["code"] != "0":
            raise self._fail("GetPaymentInstrumentDetails", r)
        return r["data"]

    def get_service_charge(self, amount_paisa: int, instrument_code: str) -> dict:
        r = self._call("GetServiceCharge", {**self.merchant, "Amount": paisa_to_rupees(amount_paisa),
                                            "InstrumentCode": instrument_code}, 2)
        if r["code"] != "0":
            raise self._fail("GetServiceCharge", r)
        return r["data"]

    def initiate(self, order_id: str, amount_paisa: int, description: str, return_url: str,
                 instrument_code: Optional[str] = None, **_: Any) -> FormResult:
        """GetProcessId + multipart form. Persist provider_ref (= ProcessId). Notification URL is set with NPS."""
        assert_paisa(amount_paisa, "nps")
        amount = paisa_to_rupees(amount_paisa)
        r = self._call("GetProcessId", {**self.merchant, "Amount": amount, "MerchantTxnId": order_id})
        if r["code"] != "0" or not (r.get("data") or {}).get("ProcessId"):
            raise self._fail("GetProcessId", r)
        fields = {**self.merchant, "Amount": amount, "MerchantTxnId": order_id, "ProcessId": r["data"]["ProcessId"],
                  "TransactionRemarks": description[:100], "ResponseUrl": return_url}
        if instrument_code:
            fields["InstrumentCode"] = instrument_code
        return FormResult(action=self.gateway, fields=fields, enctype="multipart/form-data",
                          provider_ref=r["data"]["ProcessId"])

    def verify(self, order_id: str, amount_paisa: int, provider_ref: Optional[str] = None,
               callback: Optional[Mapping[str, str]] = None) -> VerifyResult:
        r = self._call("CheckTransactionStatus", {**self.merchant, "MerchantTxnId": order_id}, 2)
        if r["code"] != "0":
            if any(e.get("error_code") == "3" for e in r.get("errors") or []):
                return VerifyResult("nps", "not_found", order_id, None, None, r)
            raise self._fail("CheckTransactionStatus", r)
        d = r.get("data") if isinstance(r.get("data"), dict) else {}  # code "0" + null data: report unknown
        if d.get("MerchantTxnId") and d["MerchantTxnId"] != order_id:
            raise PaymentError("NPS: status is for a different transaction", "nps", "callback_mismatch", 400, d)
        return VerifyResult("nps", STATUS.get(str(d.get("Status", "")).lower(), "unknown"), order_id,  # type: ignore[arg-type]
                            rupees_to_paisa(d["Amount"]) if d.get("Amount") else None, d.get("GatewayReferenceNo"), r)

    @staticmethod
    def order_id_from_callback(params: Mapping[str, str]) -> Optional[str]:
        return params.get("MerchantTxnId") or None

    @staticmethod
    def notification_response(already_processed: bool) -> str:
        """Plain-text body for your Notification URL handler, after verifying + recording."""
        return "already received" if already_processed else "received"

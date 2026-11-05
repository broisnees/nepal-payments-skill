"""eSewa — ePay v2 (web/WebView) + Intent (mobile app-to-app). https://developer.esewa.com.np

Signature: base64(HMAC-SHA256(key, "f1=v1,f2=v2")) in signed_field_names order.
The example signatures in eSewa's docs are wrong; see tests for verified vectors.
"""

from __future__ import annotations

import json
import re
import urllib.parse
from typing import Any, Mapping, Optional

from .core import (FormResult, PaymentError, VerifyResult, assert_paisa, b64decode_lenient, b64encode, base64_json,
                   hmac_digest, http, paisa_to_rupees, rupees_to_paisa, safe_equal)

SANDBOX = {
    "product_code": "EPAYTEST",
    "secret_key": "8gBm/:&EnhH.1/q",
    "intent_product_code": "INTENT",
    "intent_access_key": "LB0REg8HUSw3MTYrI1s6JTE8Kyc6JyAqJiA3MQ==",  # raw string, NOT base64-decoded
}

URLS = {
    "sandbox": {
        "form": "https://rc-epay.esewa.com.np/api/epay/main/v2/form",
        "status": "https://rc.esewa.com.np/api/epay/transaction/status/",
        "intent": "https://rc-checkout.esewa.com.np/api/client/intent/payment",
    },
    "production": {
        "form": "https://epay.esewa.com.np/api/epay/main/v2/form",
        "status": "https://esewa.com.np/api/epay/transaction/status/",
        "intent": None,  # issued by eSewa at go-live
    },
}

EPAY_STATUS = {"COMPLETE": "paid", "PENDING": "pending", "AMBIGUOUS": "pending", "FULL_REFUND": "refunded",
               "PARTIAL_REFUND": "partially_refunded", "NOT_FOUND": "not_found", "CANCELED": "canceled"}
INTENT_STATUS = {"SUCCESS": "paid", "BOOKED": "pending", "PENDING": "pending", "FAILED": "failed",
                 "CANCELED": "canceled", "REVERTED": "refunded"}


def _raw_value(text: str, payload: Mapping[str, Any], field: str) -> str:
    """Exact text of a field as eSewa sent it, so numbers keep their formatting ("1000.0" stays "1000.0")."""
    v = payload.get(field, "")
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return str(v)
    m = re.search(rf'"{re.escape(field)}"\s*:\s*(-?[0-9][0-9.eE+-]*)', text)
    return m.group(1) if m else str(v)


def esewa_sign(key: str, fields: Mapping[str, Any], order: list) -> str:
    message = ",".join(f"{f}={fields.get(f, '')}" for f in order)
    return b64encode(hmac_digest("sha256", key, message))


class Esewa:
    id = "esewa"

    def __init__(self, env: str, product_code: str, secret_key: str,
                 intent_product_code: Optional[str] = None, intent_access_key: Optional[str] = None,
                 intent_base_url: Optional[str] = None, form_url: Optional[str] = None,
                 status_url: Optional[str] = None, strict_signature: bool = True, timeout: float = 15.0):
        urls = URLS[env]
        self.env = env
        self.product_code = product_code
        self.secret = secret_key.replace("&amp;", "&")
        self.form_url = form_url or urls["form"]
        self.status_url = status_url or urls["status"]
        self.intent_product_code = intent_product_code
        self.intent_access_key = intent_access_key
        self.intent_base_url = intent_base_url or urls["intent"]
        self.strict = strict_signature
        self.timeout = timeout

    # ------------------------------------------------------------- ePay v2
    def initiate(self, order_id: str, amount_paisa: int, description: str, return_url: str,
                 failure_url: Optional[str] = None, tax_paisa: int = 0, service_charge_paisa: int = 0,
                 delivery_charge_paisa: int = 0, **_: Any) -> FormResult:
        """Form to auto-submit. amount_paisa is the TOTAL charged (store it; pass it to verify); tax/charges are
        an optional breakdown included in it. Keep return/failure URLs free of query strings; id goes in the path."""
        assert_paisa(amount_paisa, "esewa")
        if not re.fullmatch(r"[A-Za-z0-9-]+", order_id):
            raise PaymentError("eSewa transaction_uuid allows only letters, digits and '-'", "esewa", "invalid_order_id")
        extras = (tax_paisa, service_charge_paisa, delivery_charge_paisa)
        base = amount_paisa - sum(extras)
        if any(not isinstance(n, int) or n < 0 for n in extras) or base <= 0:
            raise PaymentError("eSewa: tax/charges must be non-negative paisa and less than the total", "esewa", "invalid_amount")
        total = amount_paisa
        fields = {
            "amount": paisa_to_rupees(base),
            "tax_amount": paisa_to_rupees(tax_paisa),
            "product_service_charge": paisa_to_rupees(service_charge_paisa),
            "product_delivery_charge": paisa_to_rupees(delivery_charge_paisa),
            "total_amount": paisa_to_rupees(total),
            "transaction_uuid": order_id,
            "product_code": self.product_code,
            "success_url": return_url,
            "failure_url": failure_url or return_url,
            "signed_field_names": "total_amount,transaction_uuid,product_code",
        }
        fields["signature"] = esewa_sign(self.secret, fields, ["total_amount", "transaction_uuid", "product_code"])
        return FormResult(action=self.form_url, fields=fields)

    def parse_success(self, data: str) -> tuple:
        """Decode + verify the base64 `data` param. Returns (payload, signature_valid). Not proof of payment."""
        text = b64decode_lenient(data).decode("utf-8")
        payload = json.loads(text)
        if not isinstance(payload, dict) or not isinstance(payload.get("signed_field_names"), str):
            raise PaymentError("eSewa: malformed success payload", "esewa", "malformed_callback", 400, payload)
        order = [s.strip() for s in payload["signed_field_names"].split(",")]
        fields = {f: _raw_value(text, payload, f) for f in order}
        sig = str(payload.get("signature", ""))
        ok = safe_equal(esewa_sign(self.secret, fields, order), sig)
        if not ok and "," in fields.get("total_amount", ""):
            ok = safe_equal(esewa_sign(self.secret, {**fields, "total_amount": fields["total_amount"].replace(",", "")}, order), sig)
        return payload, ok

    def verify(self, order_id: str, amount_paisa: int, provider_ref: Optional[str] = None,
               callback: Optional[Mapping[str, str]] = None) -> VerifyResult:
        """Status API (authoritative). amount_paisa = TOTAL charged; a wrong total returns NOT_FOUND."""
        signature_valid = None
        if callback and callback.get("data"):
            payload, signature_valid = self.parse_success(callback["data"])
            if payload.get("transaction_uuid") != order_id or payload.get("product_code") != self.product_code:
                raise PaymentError("eSewa: callback does not match this attempt", "esewa", "callback_mismatch", 400, payload)
            if not signature_valid and self.strict:
                raise PaymentError("eSewa: invalid response signature", "esewa", "invalid_signature", 400, payload)
        qs = urllib.parse.urlencode({"product_code": self.product_code, "total_amount": paisa_to_rupees(amount_paisa),
                                     "transaction_uuid": order_id})
        res = http("esewa", f"{self.status_url}?{qs}", timeout=self.timeout, retries=2)
        d = res.data
        if res.status != 200 or not isinstance(d, dict) or "status" not in d:
            msg = d.get("error_message") if isinstance(d, dict) else res.text[:200]
            raise PaymentError(f"eSewa status check failed: {msg}", "esewa", f"http_{res.status}", res.status, d)
        return VerifyResult("esewa", EPAY_STATUS.get(d["status"], "unknown"), order_id,  # type: ignore[arg-type]
                            rupees_to_paisa(d["total_amount"]) if d.get("total_amount") is not None else None,
                            d.get("ref_id"), {"status": d, "signature_valid": signature_valid})

    @staticmethod
    def order_id_from_callback(params: Mapping[str, str]) -> Optional[str]:
        if params.get("data"):
            try:
                return str(base64_json(params["data"]).get("transaction_uuid") or "") or None
            except Exception:
                return None
        return params.get("order_id") or params.get("orderId") or params.get("transaction_uuid") or None

    # ------------------------------------------------------------- Intent (mobile)
    def _intent(self):
        if not (self.intent_product_code and self.intent_access_key):
            raise RuntimeError("eSewa: configure intent_product_code / intent_access_key for Intent payments")
        if not self.intent_base_url:
            raise RuntimeError("eSewa: production Intent base URL is issued by eSewa at go-live; pass intent_base_url")
        return self.intent_product_code, self.intent_access_key, self.intent_base_url

    def intent_book(self, order_id: str, amount_paisa: int, callback_url: str, redirect_url: str,
                    properties: Optional[Mapping[str, str]] = None) -> dict:
        """Returns booking_id, deeplink, correlation_id and provider_ref ("booking_id|correlation_id": persist it)."""
        code, key, base = self._intent()
        assert_paisa(amount_paisa, "esewa")
        amount_str = paisa_to_rupees(amount_paisa)
        amount: Any = int(amount_str) if "." not in amount_str else float(amount_str)
        signed = {"product_code": code, "amount": str(amount), "transaction_uuid": order_id}
        body = {**signed, "amount": amount, "signed_field_names": "product_code,amount,transaction_uuid",
                "signature": esewa_sign(key, signed, ["product_code", "amount", "transaction_uuid"]),
                "callback_url": callback_url, "redirect_url": redirect_url,
                "properties": dict(properties or {"remarks": order_id})}
        res = http("esewa", f"{base}/book", "POST", body=body, timeout=self.timeout)
        d = (res.data or {}).get("data") if isinstance(res.data, dict) else None
        if not d or not d.get("booking_id"):
            raise PaymentError(f"eSewa intent book failed: {res.text[:200]}", "esewa", "intent_book_failed", res.status, res.data)
        return {"booking_id": d["booking_id"], "deeplink": d["deeplink"], "correlation_id": d["correlation_id"],
                "provider_ref": f"{d['booking_id']}|{d['correlation_id']}", "raw": res.data}

    def intent_verify(self, order_id: str, provider_ref: str, amount_paisa: Optional[int] = None) -> VerifyResult:
        """Pass the stored amount: the status response has none, but the amount was signed at booking."""
        code, key, base = self._intent()
        booking_id, correlation_id = provider_ref.split("|", 1)
        fields = {"booking_id": booking_id, "product_code": code, "correlation_id": correlation_id}
        order = ["booking_id", "product_code", "correlation_id"]
        body = {**fields, "signed_field_names": ",".join(order), "signature": esewa_sign(key, fields, order)}
        res = http("esewa", f"{base}/status", "POST", body=body, timeout=self.timeout, retries=2)
        d = (res.data or {}).get("data") if isinstance(res.data, dict) else None
        if not d or not d.get("status"):
            raise PaymentError(f"eSewa intent status failed: {res.text[:200]}", "esewa", "intent_status_failed", res.status, res.data)
        if d.get("transaction_id") and d["transaction_id"] != order_id:
            raise PaymentError("eSewa intent: status is for a different transaction", "esewa", "callback_mismatch", 400, d)
        return VerifyResult("esewa", INTENT_STATUS.get(d["status"], "unknown"), order_id, amount_paisa,  # type: ignore[arg-type]
                            d.get("reference_code"), res.data)

    def intent_cancel(self, provider_ref: str) -> Any:
        code, key, base = self._intent()
        fields = {"booking_id": provider_ref.split("|", 1)[0], "product_code": code}
        order = ["booking_id", "product_code"]
        body = {**fields, "signed_field_names": ",".join(order), "signature": esewa_sign(key, fields, order)}
        return http("esewa", f"{base}/cancel", "POST", body=body, timeout=self.timeout).data

    def intent_callback_valid(self, body: Mapping[str, Any]) -> bool:
        _, key, _ = self._intent()
        names, sig = body.get("signed_field_names"), body.get("signature")
        if not isinstance(names, str) or not isinstance(sig, str):
            return False
        order = [s.strip() for s in names.split(",")]
        return safe_equal(esewa_sign(key, {f: str(body.get(f, "")) for f in order}, order), sig)

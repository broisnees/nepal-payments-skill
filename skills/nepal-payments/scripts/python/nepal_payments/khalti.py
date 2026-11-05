"""Khalti KPG-2 (Web Checkout / ePayment) — https://docs.khalti.com/khalti-epayment/

Flow: initiate (server, secret key) -> redirect to payment_url -> Khalti GETs return_url
      -> lookup (server) with the pidx YOU stored -> fulfil only on "Completed".
"""

from __future__ import annotations

import re
import urllib.parse
from typing import Any, Mapping, Optional

from .core import PaymentError, RedirectResult, VerifyResult, assert_paisa, http

HOST = {"sandbox": "https://dev.khalti.com", "production": "https://khalti.com"}

STATUS = {
    "completed": "paid",
    "pending": "pending",
    "initiated": "pending",
    "refunded": "refunded",
    "partially refunded": "partially_refunded",
    "expired": "expired",
    "user canceled": "canceled",
    "failed": "failed",
}


class Khalti:
    id = "khalti"

    def __init__(self, secret_key: str, env: str, website_url: str, timeout: float = 15.0):
        if not secret_key:
            raise ValueError("khalti: secret_key is required")
        if env not in HOST:
            raise ValueError("env must be 'sandbox' or 'production'")
        self.host = HOST[env]
        self.base = f"{self.host}/api/v2"
        self.website_url = website_url
        self.timeout = timeout
        self._auth = {"Authorization": "Key " + re.sub(r"^key\s+", "", secret_key, flags=re.I)}

    def initiate(self, order_id: str, amount_paisa: int, description: str, return_url: str,
                 customer: Optional[Mapping[str, str]] = None,
                 amount_breakdown: Optional[list] = None,
                 product_details: Optional[list] = None,
                 merchant_extras: Optional[Mapping[str, str]] = None, **_: Any) -> RedirectResult:
        assert_paisa(amount_paisa, "khalti")
        if amount_paisa < 1000:
            raise PaymentError("Khalti minimum is Rs 10 (1000 paisa)", "khalti", "amount_too_low")
        body: dict = {
            "return_url": return_url,
            "website_url": self.website_url,
            "amount": amount_paisa,
            "purchase_order_id": order_id,
            "purchase_order_name": description[:255],
        }
        if customer:
            body["customer_info"] = dict(customer)
        if amount_breakdown:
            body["amount_breakdown"] = amount_breakdown
        if product_details:
            body["product_details"] = product_details
        for k, v in (merchant_extras or {}).items():
            if not k.startswith("merchant_"):
                raise ValueError("merchant extras must start with 'merchant_'")
            body[k] = v
        # Trailing slash REQUIRED (no slash -> 301 -> POST body lost). No retries: not idempotent.
        res = http("khalti", f"{self.base}/epayment/initiate/", "POST", self._auth, body, self.timeout)
        if res.status != 200 or not isinstance(res.data, dict) or "pidx" not in res.data:
            raise PaymentError(_message(res.data), "khalti", _error_key(res.data, res.status), res.status, res.data)
        return RedirectResult(url=res.data["payment_url"], provider_ref=res.data["pidx"],
                              expires_at=res.data.get("expires_at"), raw=res.data)

    def verify(self, order_id: str, amount_paisa: int, provider_ref: Optional[str] = None,
               callback: Optional[Mapping[str, str]] = None) -> VerifyResult:
        # Use the pidx stored at initiate time; lookup doesn't return purchase_order_id,
        # so a callback-supplied pidx could be replayed from another payment.
        pidx = provider_ref
        if not pidx:
            raise PaymentError("khalti: stored pidx required for verify", "khalti", "missing_pidx")
        if callback and callback.get("pidx") and callback["pidx"] != pidx:
            raise PaymentError("khalti: callback pidx does not match stored pidx", "khalti", "pidx_mismatch", 400, dict(callback))
        res = http("khalti", f"{self.base}/epayment/lookup/", "POST", self._auth, {"pidx": pidx},
                   self.timeout, retries=2)
        d = res.data
        # Expired / User canceled arrive as HTTP 400 with a normal body.
        if isinstance(d, dict) and isinstance(d.get("status"), str):
            return VerifyResult(
                provider="khalti",
                status=STATUS.get(d["status"].lower(), "unknown"),  # type: ignore[arg-type]
                order_id=order_id,
                amount_paisa=d.get("total_amount") if isinstance(d.get("total_amount"), int) else None,
                transaction_id=d.get("transaction_id"),
                raw=d,
            )
        if res.status == 404 or (isinstance(d, dict) and d.get("detail") == "Not found."):
            return VerifyResult("khalti", "not_found", order_id, None, None, d)
        raise PaymentError(_message(d), "khalti", _error_key(d, res.status), res.status, d)

    @staticmethod
    def order_id_from_callback(params: Mapping[str, str]) -> Optional[str]:
        return params.get("purchase_order_id") or None

    def refund(self, transaction_id: str, amount_paisa: Optional[int] = None, mobile: Optional[str] = None) -> Any:
        """Full refund when amount_paisa is None. `mobile` required for bank/e-banking payments.
        Docs say partial `amount` is paisa but show "50.00"; confirm in sandbox first."""
        body: dict = {}
        if amount_paisa is not None:
            assert_paisa(amount_paisa, "khalti")
            body["amount"] = amount_paisa
        if mobile:
            body["mobile"] = mobile
        url = f"{self.host}/api/merchant-transaction/{urllib.parse.quote(transaction_id, safe='')}/refund/"
        res = http("khalti", url, "POST", self._auth, body, self.timeout)
        if res.status != 200:
            raise PaymentError(_message(res.data), "khalti", _error_key(res.data, res.status), res.status, res.data)
        return res.data


def _error_key(d: Any, status: int) -> str:
    if status == 401:
        return "unauthorized"
    return (isinstance(d, dict) and d.get("error_key")) or f"http_{status}"


def _message(d: Any) -> str:
    if not isinstance(d, dict):
        return f"Khalti error: {str(d)[:200]}"
    if d.get("detail"):
        return f"Khalti: {d['detail']}"
    parts = [f"{k}: {' '.join(v) if isinstance(v, list) else v}" for k, v in d.items()
             if k not in ("error_key", "status_code")]
    return "Khalti: " + ("; ".join(parts) or "unknown error")

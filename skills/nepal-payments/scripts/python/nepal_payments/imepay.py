"""IME Pay web checkout (official WooCommerce/WHMCS plugin flow). Merged into Khalti in July 2025:
prefer Khalti for new builds. Callbacks are unsigned; Recheck is the only proof."""

from __future__ import annotations

import urllib.parse
from typing import Any, Mapping, Optional

from .core import (PaymentError, RedirectResult, VerifyResult, assert_paisa, b64encode, basic_auth, http,
                   rupees_to_paisa)

BASE = {"sandbox": "https://stg.imepay.com.np:7979", "production": "https://payment.imepay.com.np:7979"}


class ImePay:
    id = "imepay"

    def __init__(self, env: str, merchant_code: str, username: str, password: str, module: str,
                 base_url: Optional[str] = None, timeout: float = 20.0):
        self.base = base_url or BASE[env]
        self.merchant_code = merchant_code
        self.timeout = timeout
        self._headers = {"Authorization": basic_auth(username, password), "Module": b64encode(module.encode())}

    @staticmethod
    def _amount(paisa: int) -> str:
        return f"{paisa // 100}.{paisa % 100:02d}"

    def initiate(self, order_id: str, amount_paisa: int, description: str, return_url: str,
                 failure_url: Optional[str] = None, **_: Any) -> RedirectResult:
        assert_paisa(amount_paisa, "imepay")
        amount = self._amount(amount_paisa)
        res = http("imepay", f"{self.base}/api/Web/GetToken", "POST", self._headers,
                   {"MerchantCode": self.merchant_code, "Amount": amount, "RefId": order_id}, self.timeout)
        d = res.data if isinstance(res.data, dict) else {}
        if res.status != 200 or not d.get("TokenId") or str(d.get("ResponseCode")) != "0":
            raise PaymentError(f"IME Pay GetToken failed: {d.get('ResponseDescription') or res.text[:200]}", "imepay",
                               f"imepay_{d.get('ResponseCode', res.status)}", res.status, res.data)
        token = d["TokenId"]
        payload = "|".join([token, self.merchant_code, order_id, amount, "POST", return_url, failure_url or return_url])
        url = f"{self.base}/WebCheckout/Checkout?data={urllib.parse.quote(b64encode(payload.encode()), safe='')}"
        return RedirectResult(url=url, provider_ref=token, raw=d)

    def verify(self, order_id: str, amount_paisa: int, provider_ref: Optional[str] = None,
               callback: Optional[Mapping[str, str]] = None) -> VerifyResult:
        """Recheck. ResponseCode 0 = paid; other codes are inconsistently documented, so they stay pending."""
        if not provider_ref:
            raise PaymentError("IME Pay: stored TokenId required for verify", "imepay", "missing_token")
        res = http("imepay", f"{self.base}/api/Web/Recheck", "POST", self._headers,
                   {"MerchantCode": self.merchant_code, "RefId": order_id, "TokenId": provider_ref}, self.timeout, retries=2)
        d = res.data if isinstance(res.data, dict) else {}
        if res.status != 200 or "ResponseCode" not in d:
            raise PaymentError(f"IME Pay Recheck failed: {res.text[:200]}", "imepay", f"http_{res.status}", res.status, res.data)
        if d.get("RefId") and d["RefId"] != order_id:
            raise PaymentError("IME Pay: Recheck is for a different RefId", "imepay", "callback_mismatch", 400, d)
        paid = str(d["ResponseCode"]) == "0"
        return VerifyResult("imepay", "paid" if paid else "pending", order_id,
                            rupees_to_paisa(d["TranAmount"]) if d.get("TranAmount") not in (None, "") else None,
                            str(d["TransactionId"]) if d.get("TransactionId") else None, d)

    @staticmethod
    def order_id_from_callback(params: Mapping[str, str]) -> Optional[str]:
        return params.get("RefId") or None

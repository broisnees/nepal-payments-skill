"""Khalti KPG-2 (Web Checkout / ePayment) — https://docs.khalti.com/khalti-epayment/"""

from __future__ import annotations

import re
import urllib.parse
from typing import Any, Mapping, Optional, cast

from ...core.errors import PaymentError
from ...core.http import HttpResponse, http
from ...core.money import assert_paisa
from ...core.types import RedirectResult, VerifyResult
from .endpoints import HOST, INITIATE_PATH, LOOKUP_PATH, STATUS, api_base
from .responses import InitiateResponse, LookupResponse, error_key, error_message

PROVIDER = "khalti"

MIN_PAISA = 1000  # Rs 10


class Khalti:
    id = PROVIDER

    def __init__(self, secret_key: str, env: str, website_url: str, timeout: float = 15.0):
        if not secret_key:
            raise ValueError("khalti: secret_key is required")
        if env not in HOST:
            raise ValueError("env must be 'sandbox' or 'production'")
        self.host = HOST[env]
        self.base = api_base(self.host)
        self.website_url = website_url
        self.timeout = timeout
        # Accept the key with or without its "Key " prefix.
        key = re.sub(r"^key\s+", "", secret_key, flags=re.I)
        self._auth = {"Authorization": "Key " + key}

    def initiate(
        self,
        order_id: str,
        amount_paisa: int,
        description: str,
        return_url: str,
        customer: Optional[Mapping[str, str]] = None,
        amount_breakdown: Optional[list] = None,
        product_details: Optional[list] = None,
        merchant_extras: Optional[Mapping[str, str]] = None,
        **_: Any,
    ) -> RedirectResult:
        """Create a payment; redirect the user to `url` and persist `provider_ref` (the pidx)."""
        assert_paisa(amount_paisa, PROVIDER)
        if amount_paisa < MIN_PAISA:
            raise PaymentError("Khalti minimum is Rs 10 (1000 paisa)", PROVIDER, "amount_too_low")
        body = self._initiate_body(
            order_id,
            amount_paisa,
            description,
            return_url,
            customer,
            amount_breakdown,
            product_details,
            merchant_extras,
        )
        # Trailing slash REQUIRED (no slash -> 301 -> POST body lost). No retries: not idempotent.
        res = http(PROVIDER, f"{self.base}{INITIATE_PATH}", "POST", self._auth, body, self.timeout)
        if res.status != 200 or not isinstance(res.data, dict) or "pidx" not in res.data:
            raise self._error(res)
        data = cast(InitiateResponse, res.data)
        return RedirectResult(
            url=data["payment_url"],
            provider_ref=data["pidx"],
            expires_at=data.get("expires_at"),
            raw=res.data,
        )

    def _initiate_body(
        self,
        order_id: str,
        amount_paisa: int,
        description: str,
        return_url: str,
        customer: Optional[Mapping[str, str]],
        amount_breakdown: Optional[list],
        product_details: Optional[list],
        merchant_extras: Optional[Mapping[str, str]],
    ) -> dict[str, Any]:
        body: dict[str, Any] = {
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
        for key, value in (merchant_extras or {}).items():
            if not key.startswith("merchant_"):
                raise ValueError("merchant extras must start with 'merchant_'")
            body[key] = value
        return body

    def verify(
        self,
        order_id: str,
        amount_paisa: int,
        provider_ref: Optional[str] = None,
        callback: Optional[Mapping[str, str]] = None,
    ) -> VerifyResult:
        """Lookup by the pidx stored at initiate time (authoritative)."""
        # Use the pidx stored at initiate time; lookup doesn't return purchase_order_id,
        # so a callback-supplied pidx could be replayed from another payment.
        pidx = provider_ref
        if not pidx:
            raise PaymentError("khalti: stored pidx required for verify", PROVIDER, "missing_pidx")
        if callback and callback.get("pidx") and callback["pidx"] != pidx:
            raise PaymentError(
                "khalti: callback pidx does not match stored pidx",
                PROVIDER,
                "pidx_mismatch",
                400,
                dict(callback),
            )
        res = http(
            PROVIDER,
            f"{self.base}{LOOKUP_PATH}",
            "POST",
            self._auth,
            {"pidx": pidx},
            self.timeout,
            retries=2,
        )
        body = res.data
        # Expired / User canceled arrive as HTTP 400 with a normal body.
        if isinstance(body, dict) and isinstance(body.get("status"), str):
            return self._lookup_result(order_id, cast(LookupResponse, body))
        if res.status == 404 or (isinstance(body, dict) and body.get("detail") == "Not found."):
            return VerifyResult(PROVIDER, "not_found", order_id, None, None, body)
        raise self._error(res)

    @staticmethod
    def _lookup_result(order_id: str, body: LookupResponse) -> VerifyResult:
        total = body.get("total_amount")
        return VerifyResult(
            provider=PROVIDER,
            status=STATUS.get(body["status"].lower(), "unknown"),
            order_id=order_id,
            amount_paisa=total if isinstance(total, int) else None,
            transaction_id=body.get("transaction_id"),
            raw=body,
        )

    @staticmethod
    def order_id_from_callback(params: Mapping[str, str]) -> Optional[str]:
        """Your order_id from the return_url query (purchase_order_id)."""
        return params.get("purchase_order_id") or None

    def refund(
        self,
        transaction_id: str,
        amount_paisa: Optional[int] = None,
        mobile: Optional[str] = None,
    ) -> Any:
        """Full refund when amount_paisa is None. `mobile` required for bank/e-banking payments.

        Docs say partial `amount` is paisa but show "50.00"; confirm in sandbox first.
        """
        body: dict[str, Any] = {}
        if amount_paisa is not None:
            assert_paisa(amount_paisa, PROVIDER)
            body["amount"] = amount_paisa
        if mobile:
            body["mobile"] = mobile
        txn = urllib.parse.quote(transaction_id, safe="")
        url = f"{self.host}/api/merchant-transaction/{txn}/refund/"
        res = http(PROVIDER, url, "POST", self._auth, body, self.timeout)
        if res.status != 200:
            raise self._error(res)
        return res.data

    @staticmethod
    def _error(res: HttpResponse) -> PaymentError:
        # Khalti's message is built from its own error body, not "<summary>: <text>".
        return PaymentError(
            error_message(res.data),
            PROVIDER,
            error_key(res.data, res.status),
            res.status,
            res.data,
        )

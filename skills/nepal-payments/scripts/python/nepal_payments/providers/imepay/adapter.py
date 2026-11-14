"""IME Pay web checkout (official WooCommerce/WHMCS plugin flow)."""

from __future__ import annotations

import urllib.parse
from typing import Any, Mapping, Optional, cast

from ...core.encoding import b64encode
from ...core.errors import PaymentError, http_error
from ...core.http import HttpResponse, basic_auth, http
from ...core.money import assert_paisa, paisa_to_rupees_2dp, rupees_to_paisa
from ...core.types import RedirectResult, VerifyResult
from .endpoints import BASE, CHECKOUT_PATH, GET_TOKEN_PATH, RECHECK_PATH
from .responses import GetTokenResponse, RecheckResponse

PROVIDER = "imepay"


class ImePay:
    id = PROVIDER

    def __init__(
        self,
        env: str,
        merchant_code: str,
        username: str,
        password: str,
        module: str,
        base_url: Optional[str] = None,
        timeout: float = 20.0,
    ):
        self.base = base_url or BASE[env]
        self.merchant_code = merchant_code
        self.timeout = timeout
        self._headers = {
            "Authorization": basic_auth(username, password),
            "Module": b64encode(module.encode()),  # the Module header is base64
        }

    def initiate(
        self,
        order_id: str,
        amount_paisa: int,
        description: str,
        return_url: str,
        failure_url: Optional[str] = None,
        **_: Any,
    ) -> RedirectResult:
        """GetToken, then the checkout URL.

        Persist provider_ref (the TokenId): verify() needs it.
        """
        assert_paisa(amount_paisa, PROVIDER)
        amount = paisa_to_rupees_2dp(amount_paisa)
        token = self._get_token(order_id, amount)
        payload = "|".join(
            [
                token["TokenId"],
                self.merchant_code,
                order_id,
                amount,
                "POST",
                return_url,
                failure_url or return_url,
            ]
        )
        data = urllib.parse.quote(b64encode(payload.encode()), safe="")
        url = f"{self.base}{CHECKOUT_PATH}?data={data}"
        return RedirectResult(url=url, provider_ref=token["TokenId"], raw=token)

    def _get_token(self, order_id: str, amount: str) -> GetTokenResponse:
        body = {"MerchantCode": self.merchant_code, "Amount": amount, "RefId": order_id}
        res = http(
            PROVIDER, f"{self.base}{GET_TOKEN_PATH}", "POST", self._headers, body, self.timeout
        )
        data = cast(GetTokenResponse, res.json_object() or {})
        if res.status != 200 or not data.get("TokenId") or str(data.get("ResponseCode")) != "0":
            raise self._get_token_error(res, data)
        return data

    @staticmethod
    def _get_token_error(res: HttpResponse, data: GetTokenResponse) -> PaymentError:
        return http_error(
            PROVIDER,
            res,
            "IME Pay GetToken failed",
            detail=data.get("ResponseDescription") or res.text[:200],
            code=f"imepay_{data.get('ResponseCode', res.status)}",
        )

    def verify(
        self,
        order_id: str,
        amount_paisa: int,
        provider_ref: Optional[str] = None,
        callback: Optional[Mapping[str, str]] = None,
    ) -> VerifyResult:
        """Recheck with the stored TokenId.

        ResponseCode 0 = paid; other codes are inconsistently documented, so they stay pending.
        """
        if not provider_ref:
            raise PaymentError(
                "IME Pay: stored TokenId required for verify", PROVIDER, "missing_token"
            )
        body = {"MerchantCode": self.merchant_code, "RefId": order_id, "TokenId": provider_ref}
        res = http(
            PROVIDER,
            f"{self.base}{RECHECK_PATH}",
            "POST",
            self._headers,
            body,
            self.timeout,
            retries=2,
        )
        data = cast(RecheckResponse, res.json_object() or {})
        if res.status != 200 or "ResponseCode" not in data:
            raise http_error(PROVIDER, res, "IME Pay Recheck failed")
        if data.get("RefId") and data["RefId"] != order_id:
            raise PaymentError(
                "IME Pay: Recheck is for a different RefId",
                PROVIDER,
                "callback_mismatch",
                400,
                data,
            )
        return self._recheck_result(order_id, data)

    @staticmethod
    def _recheck_result(order_id: str, data: RecheckResponse) -> VerifyResult:
        paid = str(data["ResponseCode"]) == "0"
        amount = data.get("TranAmount")
        transaction_id = data.get("TransactionId")
        return VerifyResult(
            PROVIDER,
            "paid" if paid else "pending",
            order_id,
            rupees_to_paisa(amount) if amount not in (None, "") else None,
            str(transaction_id) if transaction_id else None,
            data,
        )

    @staticmethod
    def order_id_from_callback(params: Mapping[str, str]) -> Optional[str]:
        """Your order_id from the return params (RefId). Callbacks are unsigned: verify() always."""
        return params.get("RefId") or None

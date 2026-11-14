"""GetPay (NCHL card gateway for Nepali banks: Visa/Mastercard with 3-D Secure).

https://getpay.global/web-integration/

merchant-status answers for ANY transaction id regardless of papInfo (checked 2026-11 on UAT), so
a paid status only counts when the token's oprSecret matches YOUR opr_key and data.clientId is
YOUR order_id.
"""

from __future__ import annotations

import html
import re
from typing import Any, Mapping, Optional, cast

from ...core.crypto import safe_equal
from ...core.errors import PaymentError, http_error
from ...core.http import http
from ...core.money import assert_paisa, paisa_to_rupees_2dp, rupees_to_paisa
from ...core.types import SdkResult, VerifyResult
from .config import DEFAULT_CURRENCY, DEFAULT_THEME_COLOR
from .endpoints import BASE, BUNDLE, TXN_STATUS, origin
from .pages import checkout_page_html, payment_page_html, return_page_html
from .responses import MerchantStatus, Statement, error_message, is_not_found
from .signing import get_pay_decode_token, get_pay_opr_secret

PROVIDER = "getpay"

# clientRequestId charset and length.
_ORDER_ID = re.compile(r"[A-Za-z0-9-]{1,50}")


class GetPay:
    id = PROVIDER

    def __init__(
        self,
        env: str,
        pap_info: str,
        opr_key: str,
        website_domain: str,
        business_name: str,
        image_url: str,
        ins_key: Optional[str] = None,
        currency: Optional[str] = None,
        theme_color: Optional[str] = None,
        bundle_url: Optional[str] = None,
        base_url: Optional[str] = None,
        timeout: float = 20.0,
    ):
        """Configure the adapter.

        pap_info: base64 {"institutionId","mid","tid"} from the bank. opr_key: operator key from
        the bank; it also reaches the browser (GetPay's design), so it is not a secret.
        website_domain: your site origin, e.g. "https://shop.example"; GetPay requires the
        callback URLs on this host. image_url: logo on the checkout page.
        """
        self.pap_info = pap_info
        self.opr_key = opr_key
        self.ins_key = ins_key
        self.business_name = business_name
        self.image_url = image_url
        self.currency = currency or DEFAULT_CURRENCY
        self.theme_color = theme_color or DEFAULT_THEME_COLOR
        self.base = (base_url or BASE[env]).rstrip("/")
        self.bundle_url = bundle_url or BUNDLE
        self.timeout = timeout
        self.origin = origin(website_domain)

    def _call(self, path: str, body: Mapping[str, str]) -> Optional[dict[str, Any]]:
        """POST to {base}/{path}; returns `data`, or None when GetPay says "not found"."""
        res = http(
            PROVIDER, f"{self.base}/{path}", "POST", None, dict(body), self.timeout, retries=2
        )
        answer = res.json_object()
        if is_not_found(answer):
            return None
        usable = (
            res.status == 200
            and answer is not None
            and answer.get("status") == 0
            and isinstance(answer.get("data"), dict)
        )
        if not usable:
            raise http_error(
                PROVIDER, res, f"GetPay {path} failed", detail=error_message(answer, res.text)
            )
        return answer["data"]  # type: ignore[index]

    def initiate(
        self,
        order_id: str,
        amount_paisa: int,
        description: str,
        return_url: str,
        failure_url: Optional[str] = None,
        customer: Optional[Mapping[str, str]] = None,
        order_information_ui: Optional[str] = None,
        allow_billing_address_fields: bool = True,
        **_: Any,
    ) -> SdkResult:
        """Options for the browser SDK. clientRequestId = order_id.

        return_url / failure_url must be on website_domain and must serve return_page() (the
        token can arrive in the #hash, which only the browser sees).
        """
        assert_paisa(amount_paisa, PROVIDER)
        if not _ORDER_ID.fullmatch(order_id):
            raise PaymentError(
                "GetPay clientRequestId must be 1–50 chars [A-Za-z0-9-]",
                PROVIDER,
                "invalid_order_id",
            )
        fail_url = failure_url or return_url
        self._check_callback_origin(return_url)
        self._check_callback_origin(fail_url)

        c = customer or {}
        if order_information_ui is None:
            order_information_ui = self._default_order_ui(description, amount_paisa)
        options = {
            "clientRequestId": order_id,
            "papInfo": self.pap_info,
            "oprKey": self.opr_key,
            "insKey": self.ins_key or "",
            "websiteDomain": self.origin,
            "baseUrl": self.base,
            "price": amount_paisa / 100,  # GetPay wants a number, not a string
            "currency": self.currency,
            "businessName": self.business_name,
            "imageUrl": self.image_url,
            "themeColor": self.theme_color,
            "allowBillingAddressFields": allow_billing_address_fields,
            "userInfo": {
                "name": c.get("name") or "",
                "email": c.get("email") or "",
                "state": "",
                "country": "",
                "zipcode": "",
                "city": "",
                "address": "",
            },
            "prefill": {
                "name": bool(c.get("name")),
                "email": bool(c.get("email")),
                "state": False,
                "city": False,
                "address": False,
                "zipcode": False,
                "country": False,
            },
            "disableFields": {},
            "callbackUrl": {"successUrl": return_url, "failUrl": fail_url},
            "orderInformationUI": order_information_ui,
        }
        return SdkResult(script_url=self.bundle_url, options=options)

    def _check_callback_origin(self, url: str) -> None:
        if origin(url) != self.origin:
            raise PaymentError(
                f"GetPay callback {url} must be on websiteDomain {self.origin}",
                PROVIDER,
                "invalid_callback_url",
            )

    def _default_order_ui(self, description: str, amount_paisa: int) -> str:
        amount = paisa_to_rupees_2dp(amount_paisa)
        return (
            f'<div style="font-family:sans-serif"><h3>{html.escape(description)}</h3>'
            f"<p>{html.escape(self.currency)} {amount}</p></div>"
        )

    def verify(
        self,
        order_id: str,
        amount_paisa: int,
        provider_ref: Optional[str] = None,
        callback: Optional[Mapping[str, str]] = None,
    ) -> VerifyResult:
        """Authoritative status.

        With callback["token"]: check oprSecret against opr_key, then merchant-status, then the
        transaction must carry your order_id. Without a token (reconciliation):
        transaction-statement by clientRequestId, which cannot prove the transaction is yours,
        so a success there comes back "unknown" for manual review.
        """
        token = callback.get("token") if callback else None
        if not token:
            return self._verify_by_statement(order_id)
        return self._verify_by_token(order_id, token)

    def _verify_by_statement(self, order_id: str) -> VerifyResult:
        statement = cast(Optional[Statement], self.statement(client_request_id=order_id))
        if statement is None:
            return VerifyResult(PROVIDER, "not_found", order_id, None, None, None)
        status = TXN_STATUS.get(str(statement.get("status") or "").upper(), "unknown")
        amount = statement.get("saleTransactionAmount")
        transaction_id = statement.get("transactionId")
        return VerifyResult(
            PROVIDER,
            "unknown" if status == "paid" else status,
            order_id,
            rupees_to_paisa(amount) if amount is not None else None,
            transaction_id if isinstance(transaction_id, str) else None,
            statement,
        )

    def _verify_by_token(self, order_id: str, token: str) -> VerifyResult:
        decoded = get_pay_decode_token(token)
        if not decoded:
            raise PaymentError(
                "GetPay: return token is not base64 {id, oprSecret}",
                PROVIDER,
                "malformed_callback",
                400,
            )
        transaction_id = decoded["id"]
        if not safe_equal(get_pay_opr_secret(self.opr_key, transaction_id), decoded["oprSecret"]):
            raise PaymentError(
                "GetPay: oprSecret does not match oprKey + id",
                PROVIDER,
                "bad_signature",
                400,
                {"id": transaction_id},
            )
        status = cast(Optional[MerchantStatus], self.status(transaction_id))
        if status is None:
            return VerifyResult(PROVIDER, "not_found", order_id, None, transaction_id, None)
        client_id = status.get("clientId")
        if str(client_id if client_id is not None else "") != order_id:
            raise PaymentError(
                "GetPay: transaction belongs to a different clientRequestId",
                PROVIDER,
                "id_mismatch",
                400,
                status,
            )
        amount = status.get("amount")
        return VerifyResult(
            PROVIDER,
            TXN_STATUS.get(str(status.get("status") or "").upper(), "unknown"),
            order_id,
            rupees_to_paisa(amount) if amount is not None else None,
            transaction_id,
            status,
        )

    def status(self, transaction_id: str) -> Optional[dict[str, Any]]:
        """merchant-status by GetPay transaction id.

        {status, amount, currency, stan, crrn, clientId, remarks}; None if unknown.
        """
        return self._call("merchant-status", {"id": transaction_id, "papInfo": self.pap_info})

    def statement(
        self, transaction_id: Optional[str] = None, client_request_id: Optional[str] = None
    ) -> Optional[dict[str, Any]]:
        """transaction-statement: payer, masked PAN, scheme, stan, crrn.

        Query by transaction_id or client_request_id (exactly one).
        """
        if (transaction_id is None) == (client_request_id is None):
            raise ValueError("getpay: pass exactly one of transaction_id, client_request_id")
        if transaction_id is not None:
            body = {"transactionId": transaction_id}
        else:
            body = {"clientRequestId": cast(str, client_request_id)}
        return self._call("transaction-statement", body)

    @staticmethod
    def order_id_from_callback(params: Mapping[str, str]) -> Optional[str]:
        """The order_id is in YOUR return URL path (GetPay adds only the token).

        Extract it from the route instead; this only reads clientRequestId / orderId params.
        """
        return params.get("clientRequestId") or params.get("orderId") or None

    def checkout_page(self, r: SdkResult, payment_page_url: str) -> str:
        """Page 1: loads the bundle and starts checkout; onSuccess opens `payment_page_url`."""
        return checkout_page_html(r.script_url, r.options, payment_page_url)

    def payment_page(self) -> str:
        """Page 2: GetPay renders the card form into #checkout."""
        return payment_page_html(self.bundle_url)

    def return_page(self, verify_url: str) -> str:
        """Pages 3 and 4 (success and fail URLs).

        Break out of GetPay's iframe, read the token from the query or the #hash, and send it to
        `verify_url` as ?token=. Your server then calls verify() with callback["token"].
        """
        return return_page_html(verify_url)

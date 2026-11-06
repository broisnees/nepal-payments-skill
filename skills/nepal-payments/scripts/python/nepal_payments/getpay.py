"""GetPay (NCHL card gateway for Nepali banks: Visa/Mastercard with 3-D Secure). https://getpay.global/web-integration/
Credentials come from the acquiring bank: pap_info (base64 {institutionId, mid, tid}), opr_key, ins_key (blank when
operator-hosted), the bundle URL and the base URL.

Flow (browser SDK, four pages): checkout page loads bundle.js and runs new GetPay(options).initialize()
  -> onSuccess navigates to the payment page (<div id="checkout">, card form + 3DS)
  -> GetPay redirects to successUrl / failUrl with token=base64(JSON {id, oprSecret}) in the query or the #hash
  -> server: oprSecret == base64(SHA-256(oprKey + id)), then POST {base}/merchant-status {id, papInfo}.

merchant-status answers for ANY transaction id regardless of papInfo (checked 2026-11 on UAT), so a paid status
only counts when the token's oprSecret matches YOUR opr_key and data.clientId is YOUR order_id.
"""

from __future__ import annotations

import hashlib
import html
import json
import re
import urllib.parse
from typing import Any, Mapping, Optional

from .core import (PaymentError, SdkResult, VerifyResult, assert_paisa, b64decode_lenient, b64encode, http,
                   rupees_to_paisa, safe_equal)

BASE = {
    "sandbox": "https://uat-bank-getpay.nchl.com.np/ecom-web-checkout/v1/secure-merchant/transactions",
    "production": "https://ecom-getpay.nchl.com.np/ecom-web-checkout/v1/secure-merchant/transactions",
}
BUNDLE = "https://minio-getpay.nchl.com.np/getpay-cdn/webcheckout/v5/bundle.js"

TXN_STATUS = {
    "SUCCESS": "paid",
    "APPROVED": "paid",
    "FAILED": "failed",
    "FAILURE": "failed",
    "DECLINED": "failed",
    "PENDING": "pending",
    "CANCELLED": "canceled",
    "CANCELED": "canceled",
}


def get_pay_opr_secret(opr_key: str, transaction_id: str) -> str:
    """base64(SHA-256(opr_key + transaction_id)): the oprSecret GetPay puts in the return token."""
    return b64encode(hashlib.sha256((opr_key + transaction_id).encode()).digest())


def get_pay_decode_token(token: str) -> Optional[dict]:
    """Decode the return token. GetPay sends base64 JSON {id, oprSecret}; one integration reports "id:oprSecret"."""
    try:
        text = b64decode_lenient(token).decode("utf-8", "replace")
    except ValueError:
        return None
    try:
        j = json.loads(text)
    except ValueError:
        i = text.find(":")
        return {"id": text[:i], "oprSecret": text[i + 1:]} if 0 < i < len(text) - 1 else None
    if isinstance(j, dict) and isinstance(j.get("id"), str) and isinstance(j.get("oprSecret"), str) \
            and j["id"] and j["oprSecret"]:
        return {"id": j["id"], "oprSecret": j["oprSecret"]}
    return None


def _origin(url: str) -> str:
    """WHATWG URL origin: scheme://host[:port], default port dropped."""
    u = urllib.parse.urlsplit(url)
    if not u.scheme or not u.hostname:
        raise ValueError(f"invalid URL: {url!r}")
    scheme, host, port = u.scheme.lower(), u.hostname, u.port
    if ":" in host:
        host = f"[{host}]"
    if port is None or {"http": 80, "https": 443}.get(scheme) == port:
        return f"{scheme}://{host}"
    return f"{scheme}://{host}:{port}"


def _script_json(v: Any) -> str:
    """JSON safe to embed inside <script>: "<" becomes \\u003c so "</script>" cannot close the tag."""
    return json.dumps(v).replace("<", "\\u003c")


class GetPay:
    id = "getpay"

    def __init__(self, env: str, pap_info: str, opr_key: str, website_domain: str, business_name: str,
                 image_url: str, ins_key: Optional[str] = None, currency: Optional[str] = None,
                 theme_color: Optional[str] = None, bundle_url: Optional[str] = None,
                 base_url: Optional[str] = None, timeout: float = 20.0):
        """pap_info: base64 {"institutionId","mid","tid"} from the bank. opr_key: operator key from the bank; it also
        reaches the browser (GetPay's design), so it is not a secret. website_domain: your site origin, e.g.
        "https://shop.example"; GetPay requires the callback URLs on this host. image_url: logo on the checkout page."""
        self.pap_info = pap_info
        self.opr_key = opr_key
        self.ins_key = ins_key
        self.business_name = business_name
        self.image_url = image_url
        self.currency = currency or "NPR"
        self.theme_color = theme_color or "#5662FF"
        self.base = (base_url or BASE[env]).rstrip("/")
        self.bundle_url = bundle_url or BUNDLE
        self.timeout = timeout
        self.origin = _origin(website_domain)

    def _call(self, path: str, body: Mapping[str, str]) -> Optional[dict]:
        res = http("getpay", f"{self.base}/{path}", "POST", None, dict(body), self.timeout, retries=2)
        d = res.data if isinstance(res.data, dict) else None
        if d is not None and d.get("status") == -1 and re.search(r"not found", str(d.get("message")), re.I):
            return None
        if res.status != 200 or d is None or d.get("status") != 0 or not isinstance(d.get("data"), dict):
            msg = d["message"] if d is not None and d.get("message") is not None else res.text[:200]
            raise PaymentError(f"GetPay {path} failed: {msg}", "getpay", f"http_{res.status}", res.status, res.data)
        return d["data"]

    def initiate(self, order_id: str, amount_paisa: int, description: str, return_url: str,
                 failure_url: Optional[str] = None, customer: Optional[Mapping[str, str]] = None,
                 order_information_ui: Optional[str] = None, allow_billing_address_fields: bool = True,
                 **_: Any) -> SdkResult:
        """Options for the browser SDK. clientRequestId = order_id. return_url / failure_url must be on website_domain
        and must serve return_page() (the token can arrive in the #hash, which only the browser sees)."""
        assert_paisa(amount_paisa, "getpay")
        if not re.fullmatch(r"[A-Za-z0-9-]{1,50}", order_id):
            raise PaymentError("GetPay clientRequestId must be 1–50 chars [A-Za-z0-9-]", "getpay", "invalid_order_id")
        fail_url = failure_url or return_url
        for u in (return_url, fail_url):
            if _origin(u) != self.origin:
                raise PaymentError(f"GetPay callback {u} must be on websiteDomain {self.origin}", "getpay",
                                   "invalid_callback_url")
        c = customer or {}
        amount = f"{amount_paisa // 100}.{amount_paisa % 100:02d}"
        return SdkResult(script_url=self.bundle_url, options={
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
            "userInfo": {"name": c.get("name") or "", "email": c.get("email") or "", "state": "", "country": "",
                         "zipcode": "", "city": "", "address": ""},
            "prefill": {"name": bool(c.get("name")), "email": bool(c.get("email")), "state": False, "city": False,
                        "address": False, "zipcode": False, "country": False},
            "disableFields": {},
            "callbackUrl": {"successUrl": return_url, "failUrl": fail_url},
            "orderInformationUI": order_information_ui if order_information_ui is not None else (
                f'<div style="font-family:sans-serif"><h3>{html.escape(description)}</h3>'
                f'<p>{html.escape(self.currency)} {amount}</p></div>'),
        })

    def verify(self, order_id: str, amount_paisa: int, provider_ref: Optional[str] = None,
               callback: Optional[Mapping[str, str]] = None) -> VerifyResult:
        """With callback["token"]: check oprSecret against opr_key, then merchant-status, then the transaction must
        carry your order_id. Without a token (reconciliation): transaction-statement by clientRequestId, which cannot
        prove the transaction is yours, so a success there comes back "unknown" for manual review."""
        token = callback.get("token") if callback else None
        if not token:
            s = self.statement(client_request_id=order_id)
            if s is None:
                return VerifyResult("getpay", "not_found", order_id, None, None, None)
            st = TXN_STATUS.get(str(s.get("status") or "").upper(), "unknown")
            amt = s.get("saleTransactionAmount")
            tid = s.get("transactionId")
            return VerifyResult("getpay", "unknown" if st == "paid" else st, order_id,  # type: ignore[arg-type]
                                rupees_to_paisa(amt) if amt is not None else None,
                                tid if isinstance(tid, str) else None, s)
        t = get_pay_decode_token(token)
        if not t:
            raise PaymentError("GetPay: return token is not base64 {id, oprSecret}", "getpay", "malformed_callback", 400)
        if not safe_equal(get_pay_opr_secret(self.opr_key, t["id"]), t["oprSecret"]):
            raise PaymentError("GetPay: oprSecret does not match oprKey + id", "getpay", "bad_signature", 400,
                               {"id": t["id"]})
        d = self.status(t["id"])
        if d is None:
            return VerifyResult("getpay", "not_found", order_id, None, t["id"], None)
        if str(d.get("clientId") if d.get("clientId") is not None else "") != order_id:
            raise PaymentError("GetPay: transaction belongs to a different clientRequestId", "getpay", "id_mismatch",
                               400, d)
        amt = d.get("amount")
        return VerifyResult("getpay", TXN_STATUS.get(str(d.get("status") or "").upper(), "unknown"),  # type: ignore[arg-type]
                            order_id, rupees_to_paisa(amt) if amt is not None else None, t["id"], d)

    def status(self, transaction_id: str) -> Optional[dict]:
        """merchant-status by GetPay transaction id: {status, amount, currency, stan, crrn, clientId, remarks};
        None if unknown."""
        return self._call("merchant-status", {"id": transaction_id, "papInfo": self.pap_info})

    def statement(self, transaction_id: Optional[str] = None, client_request_id: Optional[str] = None) -> Optional[dict]:
        """transaction-statement: payer, masked PAN, scheme, stan, crrn. Query by transaction_id or client_request_id."""
        if (transaction_id is None) == (client_request_id is None):
            raise ValueError("getpay: pass exactly one of transaction_id, client_request_id")
        body = {"transactionId": transaction_id} if transaction_id is not None else {"clientRequestId": client_request_id}
        return self._call("transaction-statement", body)  # type: ignore[arg-type]

    @staticmethod
    def order_id_from_callback(params: Mapping[str, str]) -> Optional[str]:
        """The order_id is in YOUR return URL path (GetPay adds only the token); extract it from the route instead."""
        return params.get("clientRequestId") or params.get("orderId") or None

    def checkout_page(self, r: SdkResult, payment_page_url: str) -> str:
        """Page 1: loads the bundle and starts checkout; onSuccess opens `payment_page_url`."""
        return (
            '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" '
            'content="width=device-width,initial-scale=1"><title>Checkout</title>\n'
            f'<script defer src="{html.escape(r.script_url)}"></script></head><body><div id="checkout" hidden></div>'
            '<noscript>JavaScript is required to pay by card.</noscript>\n'
            f'<script>window.addEventListener("load",function(){{var o={_script_json(r.options)};'
            f'o.onSuccess=function(){{location.href={_script_json(payment_page_url)}}};'
            'o.onError=function(e){document.body.insertAdjacentHTML("beforeend","<p>Card checkout could not start. '
            'Please try again.</p>");console.error(e)};new GetPay(o).initialize()});</script></body></html>'
        )

    def payment_page(self) -> str:
        """Page 2: GetPay renders the card form into #checkout."""
        return (
            '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" '
            'content="width=device-width,initial-scale=1"><title>Pay by card</title>\n'
            f'<script defer src="{html.escape(self.bundle_url)}"></script></head><body><div id="checkout"></div>'
            '</body></html>'
        )

    def return_page(self, verify_url: str) -> str:
        """Pages 3 and 4 (success and fail URLs): break out of GetPay's iframe, read the token from the query or the
        #hash, and send it to `verify_url` as ?token=. Your server then calls verify() with callback["token"]."""
        return (
            '<!doctype html><html><head><meta charset="utf-8"><title>Confirming payment</title></head><body>'
            '<p>Confirming your payment...</p>\n'
            '<script>if(window.top!==window.self){window.top.location=window.self.location.href}else{'
            'var h=location.hash||"",q=new URLSearchParams(location.search);var t=q.get("token")||new URLSearchParams('
            'h.indexOf("?")>=0?h.slice(h.indexOf("?")+1):h.replace(/^#/,"")).get("token");'
            f'var u=new URL({_script_json(verify_url)},location.href);if(t)u.searchParams.set("token",t);'
            'location.replace(u.toString())}</script></body></html>'
        )

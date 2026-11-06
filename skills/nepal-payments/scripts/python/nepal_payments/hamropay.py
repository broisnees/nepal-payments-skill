"""Hamro Pay Checkout (Hamro Patro's wallet). https://hamropay.com.np/checkout/developer/reference/
Credentials: UAT merchant portal https://pay-sandbox.hamropatro.com (signup OTP 000000) -> Client Credentials:
merchantId, Client-Id, Client-API-Key, client secret; Configuration -> Webhook gives the webhook signing secret.

Flow: server POST /v1/checkout/sessionId (signed headers) -> server builds the gateway token -> browser form POST to
      {gateway}/api/checkout -> Hamro Pay redirects to success/failure URL with ?MerchantTxnId= -> POST /v1/checkout/transaction.

Every signature is base64(HMAC-SHA512(client_secret, values joined by ",")):
  create session = merchantTxnId,transactionAmount,merchantId,clientId,clientApiKey     (header "Signature")
  gateway token  = merchantId,merchantTxnId,sessionId,transactionAmount,clientId,clientApiKey   (form field "token")
  get txn        = merchantTxnId,merchantId,clientId,clientApiKey                       (header "Signature")
  webhook        = merchantTxnId,merchantId,status,amount   with the webhook secret      (header "Signature")
transactionAmount is PAISA as a string (Rs 10..50,000); every amount Hamro Pay returns is RUPEES.
"""

from __future__ import annotations

import math
import re
from typing import Any, Iterable, Mapping, Optional, Union

from .core import (FormResult, PaymentError, VerifyResult, assert_paisa, b64encode, hmac_digest, http, paisa_to_rupees,
                   rupees_to_paisa, safe_equal)

API = {"sandbox": "https://uat-payclient.hamropatro.com", "production": "https://payclient.hamropatro.com"}
SANDBOX_GATEWAY = "https://uat-checkout-pay.hamropatro.com/api/checkout"
HAMROPAY_MIN_PAISA = 1000
HAMROPAY_MAX_PAISA = 5_000_000

TXN_STATUS = {
    "COMPLETED": "paid",
    "FAILED": "failed",
    "PENDING": "pending",
    "PROCESSING": "pending",
    "NOT_INITIATED": "not_found",
    "CANCELED": "canceled",
    "CANCELLED": "canceled",
}


def hamro_pay_sign(secret: str, values: Iterable[Union[str, int]]) -> str:
    """base64(HMAC-SHA512) over comma-joined values. The join has no escaping, so a comma inside a value would let two
    different tuples share a signature: refuse it instead."""
    parts = [str(v) for v in values]
    if any("," in p for p in parts):
        raise ValueError("hamropay: signed values must not contain commas")
    return b64encode(hmac_digest("sha512", secret, ",".join(parts)))


def _js_number(n: Union[int, float]) -> str:
    """String(n) as JavaScript renders it: 1200.0 -> "1200", 1.5 -> "1.5"."""
    if isinstance(n, float) and n.is_integer() and abs(n) < 1e21:
        return str(int(n))
    return repr(n)


class HamroPay:
    id = "hamropay"

    def __init__(self, env: str, merchant_id: str, client_id: str, client_api_key: str, client_secret: str,
                 webhook_secret: Optional[str] = None, api_base_url: Optional[str] = None,
                 gateway_url: Optional[str] = None, timeout: float = 15.0):
        """webhook_secret: shown when you save the webhook URL in the merchant portal; needed for verify_webhook().
        api_base_url: default UAT https://uat-payclient.hamropatro.com, live https://payclient.hamropatro.com.
        gateway_url: full gateway form URL ({gateway}/api/checkout). Required in production: Hamro Pay issues the live host."""
        self.merchant_id = merchant_id
        self.client_id = client_id
        self.client_api_key = client_api_key
        self.client_secret = client_secret
        self.webhook_secret = webhook_secret
        self.api = (api_base_url or API[env]).rstrip("/")
        self.gateway = gateway_url or (SANDBOX_GATEWAY if env == "sandbox" else None)
        self.timeout = timeout

    def _post(self, path: str, body: dict, signed: list, retries: int = 0) -> dict:
        headers = {
            "Signature": hamro_pay_sign(self.client_secret, signed),
            "Client-Id": self.client_id,
            "Client-API-Key": self.client_api_key,
            # The API drops each TCP connection without marking it closed; a pooled keep-alive socket then fails on
            # the next call. urllib already sends "Connection: close"; kept explicit for other transports.
            "Connection": "close",
        }
        res = http("hamropay", f"{self.api}{path}", "POST", headers, body, self.timeout, retries=retries)
        d = res.data if isinstance(res.data, dict) else None
        if res.status == 401 or (d is not None and d.get("code") == 16):
            raise PaymentError("Hamro Pay: unauthorized (check Client-Id, Client-API-Key and the client secret)",
                               "hamropay", "unauthorized", res.status, res.data)
        if res.status != 200 or d is None:
            msg = d["message"] if d is not None and isinstance(d.get("message"), str) else res.text[:200]
            code = f"code_{d['code']}" if d is not None and d.get("code") is not None else f"http_{res.status}"
            raise PaymentError(f"Hamro Pay {path} failed: {msg}", "hamropay", code, res.status, res.data)
        return d

    def initiate(self, order_id: str, amount_paisa: int, description: str, return_url: str,
                 failure_url: Optional[str] = None, customer: Optional[Mapping[str, str]] = None,
                 remarks: Optional[str] = None, metadata: Optional[Mapping[str, str]] = None, **_: Any) -> FormResult:
        """Create Session, then the signed form for the gateway. merchantTxnId = order_id (<= 25 chars).
        Persist provider_ref (the sessionId). A session lives about 10 minutes.
        A timeout here may still have created the session on Hamro Pay's side: retry with a NEW order_id."""
        assert_paisa(amount_paisa, "hamropay")
        if amount_paisa < HAMROPAY_MIN_PAISA or amount_paisa > HAMROPAY_MAX_PAISA:
            raise PaymentError("Hamro Pay accepts Rs 10 to Rs 50,000 per transaction", "hamropay", "invalid_amount")
        if not re.fullmatch(r"[A-Za-z0-9-]{1,25}", order_id):
            raise PaymentError("Hamro Pay merchantTxnId must be 1–25 chars [A-Za-z0-9-]", "hamropay", "invalid_order_id")
        if not self.gateway:
            raise ValueError("hamropay: gateway_url is required in production (Hamro Pay issues the live gateway host)")
        transaction_amount = str(amount_paisa)  # signed and sent as the same string
        rupees = paisa_to_rupees(amount_paisa)
        body: dict = {
            "merchantTxnId": order_id,
            "merchantId": self.merchant_id,
            "transactionAmount": transaction_amount,
            "successRedirectionUrl": return_url,
            "failedRedirectionUrl": failure_url or return_url,
            "productList": [{"name": description or "Payment", "description": description or "Payment",
                             "price": float(rupees) if "." in rupees else int(rupees), "quantity": 1}],
        }
        if customer and customer.get("phone"):
            body["phone_number"] = customer["phone"]
        if metadata:
            body["metadata"] = dict(metadata)
        session = self._post("/v1/checkout/sessionId", body,
                             [order_id, transaction_amount, self.merchant_id, self.client_id, self.client_api_key])
        session_id = session.get("sessionId")
        if not isinstance(session_id, str) or not session_id:
            raise PaymentError("Hamro Pay: Create Session returned no sessionId", "hamropay", "no_session", 200, session)
        if session.get("merchantId") is not None and session["merchantId"] != self.merchant_id:
            raise PaymentError("Hamro Pay: Create Session answered for a different merchantId", "hamropay",
                               "merchant_mismatch", 200, session)
        token = hamro_pay_sign(self.client_secret, [self.merchant_id, order_id, session_id, transaction_amount,
                                                    self.client_id, self.client_api_key])
        return FormResult(
            action=self.gateway,
            fields={
                "merchant_id": self.merchant_id,
                "session_id": session_id,
                "token": token,
                "merchant_transaction_id": order_id,
                "remarks": (remarks if remarks is not None else description or "")[:250],
            },
            provider_ref=session_id,
        )

    def verify(self, order_id: str, amount_paisa: int, provider_ref: Optional[str] = None,
               callback: Optional[Mapping[str, str]] = None) -> VerifyResult:
        """Get Transaction: authoritative. amount is rupees, and 0 until the payment finishes."""
        r = self._post("/v1/checkout/transaction", {"merchantId": self.merchant_id, "merchantTxnId": order_id},
                       [order_id, self.merchant_id, self.client_id, self.client_api_key], retries=2)
        # The reference names it merchantTransactionId; the live API answers merchantTxnId.
        echoed = r.get("merchantTransactionId")
        if echoed is None:
            echoed = r.get("merchantTxnId")
        if echoed is not None and echoed != "" and str(echoed) != order_id:
            raise PaymentError("Hamro Pay: transaction answer is for a different merchantTxnId", "hamropay",
                               "id_mismatch", 200, r)
        raw_status = r.get("status")
        status = TXN_STATUS.get(("" if raw_status is None else str(raw_status)).upper(), "unknown")
        amt = rupees_to_paisa(r["amount"]) if status == "paid" and r.get("amount") is not None else None
        tracking = r.get("trackingId")
        return VerifyResult("hamropay", status, order_id, amt,  # type: ignore[arg-type]
                            tracking if isinstance(tracking, str) and tracking else None, r)

    @staticmethod
    def order_id_from_callback(params: Mapping[str, str]) -> Optional[str]:
        """Success and failure redirects carry ?MerchantTxnId=<your order_id>."""
        return params.get("MerchantTxnId") or params.get("merchantTxnId") or None

    def verify_webhook(self, body: Mapping[str, Any], signature: Optional[str]) -> bool:
        """Check a webhook's "Signature" header. Hamro Pay signs its own rendering of the amount (a double), which may be
        "1200", "1200.0" or "1200.00", so every form of the PARSED number is tried. Fulfil only after verify()."""
        if not self.webhook_secret:
            raise ValueError("hamropay: webhook_secret required to verify webhooks")
        if not isinstance(signature, str) or not signature:
            return False
        amount = body.get("amount")
        if isinstance(amount, bool) or not isinstance(amount, (int, float)) or not math.isfinite(amount):
            return False
        prefix = [body.get("merchantTxnId"), body.get("merchantId"), body.get("status")]
        if any(not isinstance(v, str) or not v or "," in v for v in prefix):
            return False
        s = _js_number(amount)
        ok = False
        for a in dict.fromkeys([s, f"{amount:.2f}", f"{s}.0", f"{amount:.1f}"]):
            if safe_equal(hamro_pay_sign(self.webhook_secret, [*prefix, a]), signature):  # type: ignore[list-item]
                ok = True
        return ok

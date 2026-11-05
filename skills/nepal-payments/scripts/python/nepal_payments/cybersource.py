"""CyberSource Secure Acceptance Hosted Checkout (bank-issued profile_id / access_key / secret_key).

Being sunset in favour of Unified Checkout (see references/cybersource.md); still works.
Signature: base64(HMAC-SHA256(secret_key RAW UTF-8, "f1=v1,...")) in signed_field_names order.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Mapping, Optional

from .core import (FormResult, PaymentError, VerifyResult, assert_paisa, b64encode, hmac_digest,
                   rupees_to_paisa, safe_equal)

HOST = {"sandbox": "https://testsecureacceptance.cybersource.com",
        "production": "https://secureacceptance.cybersource.com"}


def cybersource_sign(secret_key: str, fields: Mapping[str, str]) -> str:
    names = fields["signed_field_names"].split(",")
    return b64encode(hmac_digest("sha256", secret_key, ",".join(f"{n}={fields.get(n, '')}" for n in names)))


def signed_date_time(now: Optional[datetime] = None) -> str:
    return (now or datetime.now(timezone.utc)).astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _map_decision(decision: str, reason_code: str, txn_type: str) -> str:
    d = (decision or "").upper()
    if d == "ACCEPT":
        return "pending" if txn_type.startswith("authorization") else "paid"
    if d == "REVIEW":
        return "pending"
    if d in ("DECLINE", "ERROR"):
        return "unknown" if reason_code in ("150", "151", "152") else "failed"
    if d == "CANCEL":
        return "canceled"
    return "unknown"


class CyberSource:
    id = "cybersource"

    def __init__(self, env: str, profile_id: str, access_key: str, secret_key: str,
                 transaction_type: str = "sale", currency: str = "NPR", locale: str = "en-us",
                 use_return_url_override: bool = False):
        self.host = HOST[env]
        self.profile_id = profile_id
        self.access_key = access_key
        self.secret = secret_key
        self.transaction_type = transaction_type
        self.currency = currency
        self.locale = locale
        self.override = use_return_url_override

    def initiate(self, order_id: str, amount_paisa: int, description: str, return_url: str,
                 bill_to: Mapping[str, str], failure_url: Optional[str] = None,
                 merchant_defined_data: Optional[Mapping[int, str]] = None, **_: Any) -> FormResult:
        """bill_to keys: forename, surname, email, address_line1, city, country (ISO-2, "NP"), phone?, postal_code?, state?"""
        assert_paisa(amount_paisa, "cybersource")
        if len(order_id) > 50:
            raise PaymentError("CyberSource ids must be <= 50 chars", "cybersource", "invalid_order_id")
        f = {
            "access_key": self.access_key, "profile_id": self.profile_id, "transaction_uuid": order_id,
            "signed_date_time": signed_date_time(), "locale": self.locale, "transaction_type": self.transaction_type,
            "reference_number": order_id, "amount": f"{amount_paisa // 100}.{amount_paisa % 100:02d}",
            "currency": self.currency,
            "bill_to_forename": bill_to["forename"], "bill_to_surname": bill_to["surname"],
            "bill_to_email": bill_to["email"], "bill_to_address_line1": bill_to["address_line1"],
            "bill_to_address_city": bill_to["city"], "bill_to_address_country": bill_to["country"],
        }
        for src, dst in (("phone", "bill_to_phone"), ("postal_code", "bill_to_address_postal_code"),
                         ("state", "bill_to_address_state")):
            if bill_to.get(src):
                f[dst] = bill_to[src]
        if self.override:
            f["override_custom_receipt_page"] = return_url
            if failure_url:
                f["override_custom_cancel_page"] = failure_url
        for i, v in (merchant_defined_data or {}).items():
            f[f"merchant_defined_data{i}"] = v
        names = list(f.keys()) + ["unsigned_field_names", "signed_field_names"]
        f["unsigned_field_names"] = ""
        f["signed_field_names"] = ",".join(names)
        f["signature"] = cybersource_sign(self.secret, f)
        return FormResult(action=f"{self.host}/pay", fields=f)

    def response_valid(self, params: Mapping[str, str]) -> bool:
        if not params.get("signed_field_names") or not params.get("signature"):
            return False
        return safe_equal(cybersource_sign(self.secret, params), params["signature"])

    def verify(self, order_id: str, amount_paisa: int, provider_ref: Optional[str] = None,
               callback: Optional[Mapping[str, str]] = None) -> VerifyResult:
        """The signed response POST (receipt page / Merchant POST URL) is the proof."""
        if not callback:
            raise PaymentError("CyberSource SA: needs the signed response POST; use REST transaction search to reconcile",
                               "cybersource", "verify_unavailable")
        if not self.response_valid(callback):
            raise PaymentError("CyberSource: invalid response signature — treat as malicious", "cybersource", "invalid_signature", 400)
        p = {n: callback[n] for n in callback["signed_field_names"].split(",") if n in callback}
        if (p.get("req_reference_number") or p.get("req_transaction_uuid")) != order_id:
            raise PaymentError("CyberSource: response is for a different order", "cybersource", "callback_mismatch", 400, p)
        if p.get("req_currency") and p["req_currency"] != self.currency:
            raise PaymentError("CyberSource: currency mismatch", "cybersource", "currency_mismatch", 400, p)
        paid = p.get("auth_amount") or p.get("req_amount")
        return VerifyResult("cybersource",
                            _map_decision(p.get("decision", ""), p.get("reason_code", ""),  # type: ignore[arg-type]
                                          p.get("req_transaction_type", self.transaction_type)),
                            order_id, rupees_to_paisa(paid) if paid else None, p.get("transaction_id"), p)

    @staticmethod
    def order_id_from_callback(params: Mapping[str, str]) -> Optional[str]:
        return params.get("req_reference_number") or params.get("req_transaction_uuid") or None

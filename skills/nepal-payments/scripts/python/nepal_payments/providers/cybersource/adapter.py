"""CyberSource Secure Acceptance Hosted Checkout (bank-issued profile_id / access_key / secret_key).

Being sunset in favour of Unified Checkout (see references/cybersource.md); still works.
"""

from __future__ import annotations

from typing import Any, Mapping, Optional

from ...core.crypto import safe_equal
from ...core.errors import PaymentError
from ...core.money import assert_paisa, paisa_to_rupees_2dp, rupees_to_paisa
from ...core.types import FormResult, VerifyResult
from .endpoints import HOST, PAY_PATH
from .responses import map_decision
from .signing import cybersource_sign, signed_date_time

PROVIDER = "cybersource"

# Optional bill_to keys -> form field names.
_OPTIONAL_BILL_TO = (
    ("phone", "bill_to_phone"),
    ("postal_code", "bill_to_address_postal_code"),
    ("state", "bill_to_address_state"),
)


class CyberSource:
    id = PROVIDER

    def __init__(
        self,
        env: str,
        profile_id: str,
        access_key: str,
        secret_key: str,
        transaction_type: str = "sale",
        currency: str = "NPR",
        locale: str = "en-us",
        use_return_url_override: bool = False,
    ):
        self.host = HOST[env]
        self.profile_id = profile_id
        self.access_key = access_key
        self.secret = secret_key
        self.transaction_type = transaction_type
        self.currency = currency
        self.locale = locale
        self.override = use_return_url_override

    def initiate(
        self,
        order_id: str,
        amount_paisa: int,
        description: str,
        return_url: str,
        bill_to: Mapping[str, str],
        failure_url: Optional[str] = None,
        merchant_defined_data: Optional[Mapping[int, str]] = None,
        **_: Any,
    ) -> FormResult:
        """Signed form for {host}/pay.

        bill_to keys (see responses.BillTo): forename, surname, email, address_line1, city,
        country (ISO-2, "NP"), phone?, postal_code?, state?
        """
        assert_paisa(amount_paisa, PROVIDER)
        if len(order_id) > 50:
            raise PaymentError("CyberSource ids must be <= 50 chars", PROVIDER, "invalid_order_id")
        fields = {
            "access_key": self.access_key,
            "profile_id": self.profile_id,
            "transaction_uuid": order_id,
            "signed_date_time": signed_date_time(),
            "locale": self.locale,
            "transaction_type": self.transaction_type,
            "reference_number": order_id,
            "amount": paisa_to_rupees_2dp(amount_paisa),
            "currency": self.currency,
            **_bill_to_fields(bill_to),
        }
        if self.override:
            fields["override_custom_receipt_page"] = return_url
            if failure_url:
                fields["override_custom_cancel_page"] = failure_url
        for index, value in (merchant_defined_data or {}).items():
            fields[f"merchant_defined_data{index}"] = value
        # Every field is signed, including the two name lists themselves.
        names = [*fields.keys(), "unsigned_field_names", "signed_field_names"]
        fields["unsigned_field_names"] = ""
        fields["signed_field_names"] = ",".join(names)
        fields["signature"] = cybersource_sign(self.secret, fields)
        return FormResult(action=f"{self.host}{PAY_PATH}", fields=fields)

    def response_valid(self, params: Mapping[str, str]) -> bool:
        """True when the response POST carries a valid signature over its signed fields."""
        if not params.get("signed_field_names") or not params.get("signature"):
            return False
        return safe_equal(cybersource_sign(self.secret, params), params["signature"])

    def verify(
        self,
        order_id: str,
        amount_paisa: int,
        provider_ref: Optional[str] = None,
        callback: Optional[Mapping[str, str]] = None,
    ) -> VerifyResult:
        """The signed response POST (receipt page / Merchant POST URL) is the proof."""
        if not callback:
            raise PaymentError(
                "CyberSource SA: needs the signed response POST; "
                "use REST transaction search to reconcile",
                PROVIDER,
                "verify_unavailable",
            )
        if not self.response_valid(callback):
            raise PaymentError(
                "CyberSource: invalid response signature — treat as malicious",
                PROVIDER,
                "invalid_signature",
                400,
            )
        # Only signed fields are trusted.
        signed = {
            name: callback[name]
            for name in callback["signed_field_names"].split(",")
            if name in callback
        }
        self._check_same_order(signed, order_id)
        paid = signed.get("auth_amount") or signed.get("req_amount")
        status = map_decision(
            signed.get("decision", ""),
            signed.get("reason_code", ""),
            signed.get("req_transaction_type", self.transaction_type),
        )
        return VerifyResult(
            PROVIDER,
            status,
            order_id,
            rupees_to_paisa(paid) if paid else None,
            signed.get("transaction_id"),
            signed,
        )

    @staticmethod
    def order_id_from_callback(params: Mapping[str, str]) -> Optional[str]:
        """Your order_id from the response POST."""
        return params.get("req_reference_number") or params.get("req_transaction_uuid") or None

    def _check_same_order(self, signed: Mapping[str, str], order_id: str) -> None:
        # An empty req_reference_number falls back to req_transaction_uuid.
        reference = signed.get("req_reference_number") or signed.get("req_transaction_uuid")
        if reference != order_id:
            raise PaymentError(
                "CyberSource: response is for a different order",
                PROVIDER,
                "callback_mismatch",
                400,
                signed,
            )
        if signed.get("req_currency") and signed["req_currency"] != self.currency:
            raise PaymentError(
                "CyberSource: currency mismatch", PROVIDER, "currency_mismatch", 400, signed
            )


def _bill_to_fields(bill_to: Mapping[str, str]) -> dict[str, str]:
    """Required bill_to_* fields, then the optional ones that are set."""
    fields = {
        "bill_to_forename": bill_to["forename"],
        "bill_to_surname": bill_to["surname"],
        "bill_to_email": bill_to["email"],
        "bill_to_address_line1": bill_to["address_line1"],
        "bill_to_address_city": bill_to["city"],
        "bill_to_address_country": bill_to["country"],
    }
    for source, target in _OPTIONAL_BILL_TO:
        if bill_to.get(source):
            fields[target] = bill_to[source]
    return fields

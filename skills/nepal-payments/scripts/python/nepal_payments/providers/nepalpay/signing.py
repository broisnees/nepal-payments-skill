"""Strings NCHL signs or expects signed (RSA-SHA256 with the NPI .pfx key)."""

from __future__ import annotations

from typing import Any, Mapping, Union


def nepal_pay_token_string(
    acquirer_id: str,
    merchant_id: str,
    merchant_category_code: Union[str, int],
    transaction_currency: Union[str, int],
    transaction_amount: str,
    bill_number: str,
    user_id: str,
) -> str:
    """The exact string NCHL expects to be signed for a dynamic QR.

    Comma-joined, no spaces: acquirerId,merchantId,merchantCategoryCode,transactionCurrency,
    transactionAmount,billNumber,userId
    """
    values = (
        acquirer_id,
        merchant_id,
        merchant_category_code,
        transaction_currency,
        transaction_amount,
        bill_number,
        user_id,
    )
    return ",".join(str(v) for v in values)


def nepal_pay_confirmation_string(n: Mapping[str, Any]) -> str:
    """What NCHL signs on a confirm-payment notification.

    The docs name the field payerMobileNumber; the sample sends payerMobile.
    """

    def value(key: str) -> str:
        return "" if n.get(key) is None else str(n[key])

    if n.get("payerMobileNumber") is not None:
        mobile = value("payerMobileNumber")
    else:
        mobile = value("payerMobile")
    return ",".join(
        [
            value("merchantBillNo"),
            value("merchantId"),
            value("merchantName"),
            value("paymentRef"),
            value("channel"),
            mobile,
            value("sessionNo"),
        ]
    )


def confirmation_response_string(
    txn_date: str, status: str, message: str, merchant_bill_no: str, payment_ref: str
) -> str:
    """What we sign in the reply to a confirm-payment notification."""
    return ",".join([txn_date, status, message, merchant_bill_no, payment_ref])

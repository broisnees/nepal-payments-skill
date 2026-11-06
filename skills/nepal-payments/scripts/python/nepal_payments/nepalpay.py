"""NEPALPAY QR (NCHL) merchant dynamic QR. https://doc.connectips.com/docs/NepalPAY-QR/Merchant-QR-generation/introduction
Onboarding via your bank (or businesssupport@nchl.com.np) -> acquirerId, merchantId, MCC, NPI username/password,
and the signing .pfx (NPI.pfx in UAT). Requires `cryptography` (pip install cryptography).

Flow: server signs token (RSA-SHA256) -> POST /qr/generateQR -> show qr_string / qr_image -> customer scans with any
      NEPALPAY QR / mobile banking app -> poll /nQR/v1/merchanttxnreport by validationTraceId (= provider_ref).

Token string (comma-joined, no spaces): acquirerId,merchantId,merchantCategoryCode,transactionCurrency,transactionAmount,billNumber,userId
Paid = debitStatus "000" and creditStatus "000" | "999" | "DEFER".
"""

from __future__ import annotations

import re
import time
import urllib.parse
from typing import Any, Mapping, Optional, Union

from .core import (PaymentError, QrResult, VerifyResult, assert_paisa, basic_auth, http, rsa_pkcs1_encrypt_b64,
                   rsa_sha256_sign_b64, rsa_sha256_verify_b64, rupees_to_paisa)

BASE = {"sandbox": "https://devopennpi.connectips.com", "production": "https://opennpi.connectips.com"}
NPR = 524
CREDIT_OK = {"000", "999", "DEFER"}


def nepal_pay_token_string(acquirer_id: str, merchant_id: str, merchant_category_code: Union[str, int],
                           transaction_currency: Union[str, int], transaction_amount: str, bill_number: str,
                           user_id: str) -> str:
    """The exact string NCHL expects to be signed for a dynamic QR."""
    return ",".join(str(v) for v in (acquirer_id, merchant_id, merchant_category_code, transaction_currency,
                                     transaction_amount, bill_number, user_id))


def nepal_pay_confirmation_string(n: Mapping[str, Any]) -> str:
    """What NCHL signs on a confirm-payment notification. The docs name the field payerMobileNumber; the sample
    sends payerMobile."""
    def v(k: str) -> str:
        return "" if n.get(k) is None else str(n[k])
    mobile = v("payerMobileNumber") if n.get("payerMobileNumber") is not None else v("payerMobile")
    return ",".join([v("merchantBillNo"), v("merchantId"), v("merchantName"), v("paymentRef"), v("channel"), mobile,
                     v("sessionNo")])


class NepalPay:
    id = "nepalpay"

    def __init__(self, env: str, acquirer_id: str, merchant_id: str, merchant_name: str,
                 merchant_category_code: Union[str, int], merchant_city: str, merchant_postal_code: str,
                 store_label: str, username: str, password: str, private_key_pem: bytes,
                 terminal_label: Optional[str] = None, auth: str = "basic", client_id: Optional[str] = None,
                 client_secret: Optional[str] = None, qr_image: bool = True,
                 nchl_public_key_pem: Optional[Union[str, bytes]] = None, ws_url: Optional[str] = None,
                 ws_username: Optional[str] = None, ws_api_token: Optional[str] = None,
                 base_url: Optional[str] = None, timeout: float = 20.0):
        """acquirer_id: 8 digits (your acquiring bank). merchant_name: <= 25 chars, must match the enrolled name.
        username: NPI user, also the `userId` inside the signed token. private_key_pem: from the NPI .pfx.
        auth: "basic" (merchant QR doc) or "oauth" (NPI password grant, needs client_id/client_secret).
        nchl_public_key_pem: NCHL's public key (SPKI PEM, from NPI.cer); verifies confirm-payment notifications and
        encrypts the WebSocket api_token. ws_url / ws_username / ws_api_token: the WebSocket channel issued by NCHL
        (STOMP endpoint ending in /nqrws), with its own username and API token."""
        self.acquirer_id = acquirer_id
        self.merchant_id = merchant_id
        self.merchant_name = merchant_name
        self.merchant_category_code = merchant_category_code
        self.merchant_city = merchant_city
        self.merchant_postal_code = merchant_postal_code
        self.store_label = store_label
        self.terminal_label = terminal_label
        self.username = username
        self.password = password
        self.private_key_pem = private_key_pem if isinstance(private_key_pem, bytes) else private_key_pem.encode()
        self.auth = auth
        self.client_id = client_id
        self.client_secret = client_secret
        self.qr_image = qr_image
        self.nchl_public_key_pem = nchl_public_key_pem
        self.ws_url = ws_url
        self.ws_username = ws_username
        self.ws_api_token = ws_api_token
        self.base = base_url or BASE[env]
        self.timeout = timeout
        self._cached: Optional[tuple] = None  # (token, until epoch seconds)

    def _auth_header(self) -> str:
        if self.auth == "basic":
            return basic_auth(self.username, self.password)
        if not self.client_id or not self.client_secret:
            raise ValueError('nepalpay: client_id/client_secret required for auth "oauth"')
        if self._cached and self._cached[1] > time.time():
            return f"Bearer {self._cached[0]}"
        body = urllib.parse.urlencode({"grant_type": "password", "username": self.username, "password": self.password})
        res = http("nepalpay", f"{self.base}/oauth/token", "POST",
                   {"Authorization": basic_auth(self.client_id, self.client_secret),
                    "Content-Type": "application/x-www-form-urlencoded"}, body, self.timeout)
        d = res.data if isinstance(res.data, dict) else {}
        if res.status != 200 or not d.get("access_token"):
            raise PaymentError(f"NEPALPAY oauth failed: {res.text[:200]}", "nepalpay", "unauthorized", res.status, res.data)
        try:
            ttl = float(d.get("expires_in") or 0) or 60
        except (TypeError, ValueError):
            ttl = 60
        self._cached = (d["access_token"], time.time() + max(ttl - 30, 5))
        return f"Bearer {d['access_token']}"

    def initiate(self, order_id: str, amount_paisa: int, description: str, return_url: str = "", **_: Any) -> QrResult:
        """Dynamic QR. billNumber = order_id (<= 25 chars). Persist `provider_ref` (validationTraceId): verify() needs it.
        return_url is unused: there is no redirect, the payer scans the QR from their own app."""
        assert_paisa(amount_paisa, "nepalpay")
        if not re.fullmatch(r"[A-Za-z0-9-]{1,25}", order_id):
            raise PaymentError("NEPALPAY billNumber must be 1–25 chars [A-Za-z0-9-]", "nepalpay", "invalid_order_id")
        transaction_amount = f"{amount_paisa // 100}.{amount_paisa % 100:02d}"  # always 2 decimals
        token = rsa_sha256_sign_b64(self.private_key_pem, nepal_pay_token_string(
            self.acquirer_id, self.merchant_id, self.merchant_category_code, NPR, transaction_amount, order_id,
            self.username))
        body = {
            "pointOfInitialization": 12,
            "acquirerId": self.acquirer_id,
            "merchantId": self.merchant_id,
            "merchantName": self.merchant_name[:25],
            "merchantCategoryCode": int(self.merchant_category_code),
            "merchantCountry": "NP",
            "merchantCity": self.merchant_city,
            "merchantPostalCode": self.merchant_postal_code,
            "merchantLanguage": "en",
            "transactionCurrency": NPR,
            "transactionAmount": transaction_amount,
            "valueOfConvenienceFeeFixed": "0.00",
            "billNumber": order_id,
            "storeLabel": self.store_label,
            "terminalLabel": self.terminal_label or "0",
            "purposeOfTransaction": (description or "Payment")[:25],
            "qrImage": self.qr_image,
            "token": token,
        }
        res = http("nepalpay", f"{self.base}/qr/generateQR", "POST", {"Authorization": self._auth_header()}, body,
                   self.timeout)
        d = res.data if isinstance(res.data, dict) else {}
        data = d.get("data") if isinstance(d.get("data"), dict) else {}
        if d.get("responseCode") != "000" or not data.get("qrString") or not data.get("validationTraceId"):
            responses = d.get("responses")
            first = responses[0] if isinstance(responses, list) and responses and isinstance(responses[0], dict) else {}
            code = next((c for c in (d.get("responseCode"), first.get("responseCode")) if c is not None), f"http_{res.status}")
            raise PaymentError(f"NEPALPAY generateQR failed: {res.text[:300]}", "nepalpay", str(code), res.status, res.data)
        return QrResult(qr_string=str(data["qrString"]).strip(), provider_ref=str(data["validationTraceId"]),
                        qr_image=str(data["qrImage"]) if data.get("qrImage") else None, raw=res.data)

    def report(self, validation_trace_id: str) -> list:
        """Every payment made against one QR (a failed scan can be retried on the same QR)."""
        body = {"validationTraceId": validation_trace_id, "merchantId": self.merchant_id, "acquirerId": self.acquirer_id}
        res = http("nepalpay", f"{self.base}/nQR/v1/merchanttxnreport", "POST", {"Authorization": self._auth_header()},
                   body, self.timeout, retries=2)
        if res.status == 401:
            raise PaymentError("NEPALPAY: 401 — wrong NPI username/password", "nepalpay", "unauthorized", 401, res.data)
        d = res.data if isinstance(res.data, dict) else {}
        code = str(d.get("responseCode") or "")
        if code == "E010":  # record not found
            return []
        if code not in ("200", "000"):
            raise PaymentError(f"NEPALPAY report failed: {res.text[:200]}", "nepalpay", code or f"http_{res.status}",
                               res.status, res.data)
        rows = d.get("responseBody")
        return rows if isinstance(rows, list) else []

    def verify(self, order_id: str, amount_paisa: int, provider_ref: Optional[str] = None,
               callback: Optional[Mapping[str, str]] = None) -> VerifyResult:
        """merchanttxnreport by validationTraceId: authoritative."""
        if not provider_ref:
            raise PaymentError("NEPALPAY verify needs providerRef (validationTraceId)", "nepalpay", "missing_provider_ref")
        txns = self.report(provider_ref)
        payments = [t for t in txns if (t.get("tranType") or "PMT") == "PMT"]
        paid = next((t for t in payments if t.get("debitStatus") == "000" and str(t.get("creditStatus")) in CREDIT_OK), None)
        pick = paid or (payments[-1] if payments else None)
        if paid:
            status = "paid"
        elif not pick:
            status = "not_found"
        elif pick.get("debitStatus") == "000":
            status = "unknown"  # debited but credit not confirmed: review
        else:
            status = "failed"
        amt = rupees_to_paisa(pick["amount"]) if pick and pick.get("amount") is not None else None
        txn_id = pick.get("nQrTxnId") if pick else None
        return VerifyResult("nepalpay", status, order_id, amt, txn_id, txns)  # type: ignore[arg-type]

    @staticmethod
    def order_id_from_callback(params: Mapping[str, str]) -> Optional[str]:
        """Your order_id from a confirm-payment notification (merchantBillNo = the billNumber you sent)."""
        return params.get("merchantBillNo") or params.get("billNumber") or None

    def verify_confirmation(self, n: Mapping[str, Any]) -> bool:
        """Check a confirm-payment notification's signature with nchl_public_key_pem. NCHL doesn't say which key signs
        it, so False here is a reason to log and alert, not proof of forgery. Fulfil only after verify() either way."""
        if not self.nchl_public_key_pem:
            raise ValueError("nepalpay: nchl_public_key_pem required to verify notifications")
        sig = n.get("signature")
        if not isinstance(sig, str):
            return False
        return rsa_sha256_verify_b64(self.nchl_public_key_pem, nepal_pay_confirmation_string(n), sig)

    def web_socket_request(self, validation_trace_id: str) -> dict:
        """Everything a STOMP client needs to watch one QR live: connect to `url`, subscribe to `subscribe`, then send
        `body` as JSON to `send`. Statuses arrive as ENTR, PARSED, then COMPLETED or FAILED. On COMPLETED, call verify()."""
        if not (self.ws_url and self.ws_username and self.ws_api_token and self.nchl_public_key_pem):
            raise ValueError("nepalpay: ws_url, ws_username, ws_api_token and nchl_public_key_pem required for the "
                             "WebSocket channel")
        return {
            "url": self.ws_url,
            "subscribe": "/user/nqrws/check-txn-status",
            "send": "/nqrws/check-txn-status",
            "body": {
                "merchant_id": self.terminal_label or "0",
                "request_id": validation_trace_id,
                "username": self.ws_username,
                "api_token": rsa_pkcs1_encrypt_b64(self.nchl_public_key_pem, self.ws_api_token),
            },
        }

    def confirmation_response(self, txn_date: str, merchant_bill_no: str, payment_ref: str, ok: bool = True) -> dict:
        """Signed reply to NCHL's POST {your base}/nepalpay/confirm-payment notification.
        The notification is a hint: call verify() before fulfilling."""
        status = "SUCCESS" if ok else "FAILED"
        message = "TRANSACTION SUCCESSFUL" if ok else "TRANSACTION FAILED"
        token_string = ",".join([txn_date, status, message, merchant_bill_no, payment_ref])
        return {"txnDate": txn_date, "status": status, "message": message, "merchantBillNo": merchant_bill_no,
                "paymentRef": payment_ref, "signature": rsa_sha256_sign_b64(self.private_key_pem, token_string)}

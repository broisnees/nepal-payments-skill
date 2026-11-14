import base64
import hashlib
import hmac
import json
import unittest
from unittest import mock

from helpers import resp
from nepal_payments.core import PaymentError
from nepal_payments.providers.hamropay import HamroPay, hamro_pay_sign

HTTP = "nepal_payments.providers.hamropay.adapter.http"


class HamroPayTests(unittest.TestCase):
    cfg = {
        "env": "sandbox",
        "merchant_id": "PN_-Nd99TBnAlBjCgl8ef_b",
        "client_id": "client@123",
        "client_api_key": "merchant-api-key-test",
        "client_secret": "abcdefg",
        "webhook_secret": "whsec",
    }
    h = HamroPay(**cfg)
    M = cfg["merchant_id"]

    @staticmethod
    def node(secret, msg):
        return base64.b64encode(
            hmac.new(secret.encode(), msg.encode(), hashlib.sha512).digest()
        ).decode()

    def test_sign(self):
        self.assertEqual(
            hamro_pay_sign("abcdefg", ["T1", "1000", "M", "C", "K"]),
            self.node("abcdefg", "T1,1000,M,C,K"),
        )
        with self.assertRaisesRegex(ValueError, "commas"):
            hamro_pay_sign("s", ["a,b"])

    def test_initiate(self):
        sid = "ca8f7b70-b9c9-11ee-8611-0a73743c8233"
        with mock.patch(HTTP, return_value=resp({"sessionId": sid, "merchantId": self.M})) as h:
            r = self.h.initiate(
                "P1",
                8992,
                "T-shirt",
                "https://shop.example/ok",
                failure_url="https://shop.example/no",
            )
        _, url, _, headers, body, *_ = h.call_args[0]
        self.assertEqual(url, "https://uat-payclient.hamropatro.com/v1/checkout/sessionId")
        self.assertEqual(
            (headers["Client-Id"], headers["Client-API-Key"], headers["Connection"]),
            ("client@123", "merchant-api-key-test", "close"),
        )
        self.assertEqual(
            headers["Signature"],
            self.node("abcdefg", f"P1,8992,{self.M},client@123,merchant-api-key-test"),
        )
        body = json.loads(json.dumps(body))
        self.assertEqual(
            [
                body["merchantTxnId"],
                body["transactionAmount"],
                body["successRedirectionUrl"],
                body["failedRedirectionUrl"],
                body["productList"][0]["price"],
            ],
            ["P1", "8992", "https://shop.example/ok", "https://shop.example/no", 89.92],
        )
        self.assertEqual(r.kind, "form")
        self.assertEqual(r.action, "https://uat-checkout-pay.hamropatro.com/api/checkout")
        self.assertEqual(r.provider_ref, sid)
        self.assertEqual(
            r.fields["token"],
            self.node("abcdefg", f"{self.M},P1,{sid},8992,client@123,merchant-api-key-test"),
        )
        self.assertEqual(
            list(r.fields),
            ["merchant_id", "session_id", "token", "merchant_transaction_id", "remarks"],
        )

    def test_initiate_validation(self):
        with self.assertRaisesRegex(PaymentError, "Rs 10"):
            self.h.initiate("P1", 999, "x", "https://a/")
        with self.assertRaisesRegex(PaymentError, "Rs 10"):
            self.h.initiate("P1", 5_000_001, "x", "https://a/")
        with self.assertRaisesRegex(PaymentError, "1–25"):
            self.h.initiate("X" * 26, 1000, "x", "https://a/")
        with self.assertRaisesRegex(ValueError, "gateway_url"):
            HamroPay(**{**self.cfg, "env": "production"}).initiate("P1", 1000, "x", "https://a/")
        cases = [
            (resp({"sessionId": "S", "merchantId": "SOMEONE_ELSE"}), "merchant_mismatch"),
            (
                resp({"code": 16, "message": "Unauthorized Request", "details": []}, 401),
                "unauthorized",
            ),
        ]
        for r, code in cases:
            with mock.patch(HTTP, return_value=r):
                with self.assertRaises(PaymentError) as cm:
                    self.h.initiate("P1", 1000, "x", "https://a/")
            self.assertEqual(cm.exception.code, code)

    def test_verify(self):
        cases = [
            (
                {
                    "merchantTxnId": "P1",
                    "status": "COMPLETED",
                    "amount": 89.92,
                    "trackingId": "TRK1",
                },
                "paid",
                8992,
            ),
            ({"merchantTransactionId": "P1", "status": "PROCESSING", "amount": 0}, "pending", None),
            ({"merchantTxnId": "P1", "status": "FAILED", "amount": 0}, "failed", None),
            (
                {
                    "merchantTransactionId": "P1",
                    "trackingId": "",
                    "status": "NOT_INITIATED",
                    "amount": 0,
                    "message": "TRANSACTION NOT INITIATED YET",
                },
                "not_found",
                None,
            ),
            ({"merchantTxnId": "P1", "status": "SOMETHING_NEW"}, "unknown", None),
        ]
        for body, want, amt in cases:
            with mock.patch(HTTP, return_value=resp(body)) as h:
                v = self.h.verify("P1", 8992)
            self.assertEqual((v.status, v.amount_paisa), (want, amt))
            _, url, _, headers, sent, *_ = h.call_args[0]
            self.assertEqual(url, "https://uat-payclient.hamropatro.com/v1/checkout/transaction")
            self.assertEqual(
                headers["Signature"],
                self.node("abcdefg", f"P1,{self.M},client@123,merchant-api-key-test"),
            )
            self.assertEqual(sent, {"merchantId": self.M, "merchantTxnId": "P1"})
        other = resp({"merchantTxnId": "P2", "status": "COMPLETED", "amount": 89.92})
        with mock.patch(HTTP, return_value=other):
            with self.assertRaises(PaymentError) as cm:
                self.h.verify("P1", 8992)
        self.assertEqual(cm.exception.code, "id_mismatch")
        self.assertEqual(HamroPay.order_id_from_callback({"MerchantTxnId": "P1"}), "P1")

    def test_webhook(self):
        body = {
            "merchantTxnId": "P1",
            "merchantId": self.M,
            "amount": 1200,
            "status": "COMPLETED",
            "metadata": {},
        }
        for a in ("1200", "1200.0", "1200.00"):
            self.assertTrue(
                self.h.verify_webhook(body, self.node("whsec", f"P1,{self.M},COMPLETED,{a}"))
            )
            # json.loads gives a float for "1200.0": same renderings must still match
            self.assertTrue(
                self.h.verify_webhook(
                    {**body, "amount": 1200.0}, self.node("whsec", f"P1,{self.M},COMPLETED,{a}")
                )
            )
        self.assertTrue(
            self.h.verify_webhook(
                {**body, "amount": 1.5}, self.node("whsec", f"P1,{self.M},COMPLETED,1.50")
            )
        )
        self.assertFalse(
            self.h.verify_webhook(
                {**body, "amount": 1201}, self.node("whsec", f"P1,{self.M},COMPLETED,1200")
            )
        )
        self.assertFalse(
            self.h.verify_webhook(
                {**body, "amount": "1200"}, self.node("whsec", f"P1,{self.M},COMPLETED,1200")
            )
        )
        self.assertFalse(self.h.verify_webhook(body, None))
        with self.assertRaisesRegex(ValueError, "webhook_secret"):
            HamroPay(**{**self.cfg, "webhook_secret": None}).verify_webhook(body, "x")


if __name__ == "__main__":
    unittest.main()

import base64
import hashlib
import json
import unittest
from unittest import mock

from helpers import b64json, resp
from nepal_payments.core import PaymentError
from nepal_payments.providers.getpay import GetPay, get_pay_decode_token, get_pay_opr_secret

HTTP = "nepal_payments.providers.getpay.adapter.http"


class GetPayTests(unittest.TestCase):
    cfg = {
        "env": "sandbox",
        "pap_info": base64.b64encode(
            json.dumps(
                {"institutionId": "122", "mid": "123123451770986", "tid": "12358762"}
            ).encode()
        ).decode(),
        "opr_key": "4fa4c6b9-3f91-43e5-9b4f-319f68187ba5",
        "website_domain": "https://shop.example",
        "business_name": "Shop",
        "image_url": "https://shop.example/logo.png",
    }
    g = GetPay(**cfg)
    base = "https://uat-bank-getpay.nchl.com.np/ecom-web-checkout/v1/secure-merchant/transactions"
    tid = "0cc5b1a39f3c4cad864bc1c6a524534f"
    secret = base64.b64encode(hashlib.sha256((cfg["opr_key"] + tid).encode()).digest()).decode()
    token = b64json({"id": tid, "oprSecret": secret})

    @staticmethod
    def ok(data):
        return resp({"status": 0, "message": "SUCCESS", "data": data})

    def test_token(self):
        want = {"id": self.tid, "oprSecret": self.secret}
        self.assertEqual(get_pay_opr_secret(self.cfg["opr_key"], self.tid), self.secret)
        self.assertEqual(get_pay_decode_token(self.token), want)
        self.assertEqual(
            get_pay_decode_token(base64.b64encode(f"{self.tid}:{self.secret}".encode()).decode()),
            want,
        )
        self.assertIsNone(get_pay_decode_token("%%%"))
        self.assertIsNone(get_pay_decode_token(b64json({"id": self.tid})))

    def test_initiate_and_pages(self):
        r = self.g.initiate(
            "P1",
            120050,
            "Cup <set>",
            "https://shop.example/ok/P1",
            failure_url="https://shop.example/no/P1",
        )
        self.assertEqual(r.kind, "sdk")
        self.assertEqual(
            r.script_url, "https://minio-getpay.nchl.com.np/getpay-cdn/webcheckout/v5/bundle.js"
        )
        o = r.options
        self.assertEqual(
            (o["price"], o["clientRequestId"], o["baseUrl"], o["insKey"]),
            (1200.5, "P1", self.base, ""),
        )
        self.assertEqual(
            o["callbackUrl"],
            {"successUrl": "https://shop.example/ok/P1", "failUrl": "https://shop.example/no/P1"},
        )
        self.assertIn("Cup &lt;set&gt;", o["orderInformationUI"])
        with self.assertRaises(PaymentError) as cm:
            self.g.initiate("P1", 100, "x", "https://evil.example/ok")
        self.assertEqual(cm.exception.code, "invalid_callback_url")
        page = self.g.checkout_page(r, "/pay/P1</script>")
        self.assertIn("new GetPay(o).initialize()", page)
        self.assertTrue('</script>"' not in page and "\\u003c/script>" in page)
        self.assertIn('<div id="checkout"></div>', self.g.payment_page())
        self.assertIn("window.top.location", self.g.return_page("/payments/getpay/return/P1"))

    def test_verify_with_token(self):
        def run(r, token=None):
            with mock.patch(HTTP, return_value=r) as h:
                return self.g.verify("P1", 120000, callback={"token": token or self.token}), h

        v, h = run(
            self.ok(
                {
                    "status": "SUCCESS",
                    "amount": 1200.0,
                    "currency": "NPR",
                    "stan": "379832",
                    "crrn": "624503379832",
                    "clientId": "P1",
                    "remarks": "Success",
                }
            )
        )
        self.assertEqual((v.status, v.amount_paisa, v.transaction_id), ("paid", 120000, self.tid))
        self.assertEqual(h.call_args[0][1], f"{self.base}/merchant-status")
        self.assertEqual(h.call_args[0][4], {"id": self.tid, "papInfo": self.cfg["pap_info"]})

        forged = b64json({"id": self.tid, "oprSecret": base64.b64encode(b"not the hash").decode()})
        for r, token, code in [
            (
                self.ok({"status": "SUCCESS", "amount": 1200.0, "clientId": "SOMEONE-ELSES-ORDER"}),
                None,
                "id_mismatch",
            ),
            (self.ok({}), forged, "bad_signature"),
            (self.ok({}), "@@", "malformed_callback"),
        ]:
            with self.assertRaises(PaymentError) as cm:
                run(r, token)
            self.assertEqual(cm.exception.code, code)

        self.assertEqual(
            run(self.ok({"status": "FAILED", "amount": 1200.0, "clientId": "P1"}))[0].status,
            "failed",
        )
        nf = resp(
            {
                "status": -1,
                "message": f"Failed to fetch merchant information: Transaction not found for ID: {self.tid}",
            },
            400,
        )
        self.assertEqual(run(nf)[0].status, "not_found")

    def test_verify_without_token(self):
        statement = self.ok(
            {
                "transactionId": self.tid,
                "clientRequestId": "P1",
                "saleTransactionAmount": 1200.0,
                "status": "SUCCESS",
                "paymentScheme": "MASTERCARD",
            }
        )
        with mock.patch(HTTP, return_value=statement) as h:
            v = self.g.verify("P1", 120000)
        self.assertEqual(
            (v.status, v.amount_paisa, v.transaction_id), ("unknown", 120000, self.tid)
        )
        self.assertEqual(h.call_args[0][1], f"{self.base}/transaction-statement")
        self.assertEqual(h.call_args[0][4], {"clientRequestId": "P1"})
        cases = [
            (
                self.ok(
                    {
                        "transactionId": self.tid,
                        "clientRequestId": "P1",
                        "saleTransactionAmount": 1200.0,
                        "status": "FAILED",
                    }
                ),
                "failed",
            ),
            (
                resp(
                    {
                        "status": -1,
                        "message": "Failed to fetch transaction statement: Transaction not found for transaction ID: x",
                    },
                    400,
                ),
                "not_found",
            ),
        ]
        for r, want in cases:
            with mock.patch(HTTP, return_value=r):
                self.assertEqual(self.g.verify("P1", 120000).status, want)
        with mock.patch(HTTP, return_value=resp("oops", 500)):
            with self.assertRaises(PaymentError):
                self.g.verify("P1", 120000)


if __name__ == "__main__":
    unittest.main()

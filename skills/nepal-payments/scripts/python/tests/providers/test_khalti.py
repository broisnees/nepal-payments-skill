import unittest
from unittest import mock

from helpers import resp
from nepal_payments.core import PaymentError
from nepal_payments.providers.khalti import Khalti

HTTP = "nepal_payments.providers.khalti.adapter.http"


class KhaltiTests(unittest.TestCase):
    k = Khalti("live_secret_key_test", "sandbox", "https://shop.example")

    def test_initiate(self):
        initiated = {
            "pidx": "P1",
            "payment_url": "https://test-pay.khalti.com/?pidx=P1",
            "expires_at": "x",
            "expires_in": 1800,
        }
        with mock.patch(HTTP, return_value=resp(initiated)) as h:
            r = self.k.initiate("O1", 1000, "Book", "https://shop.example/r")
        args = h.call_args[0]
        self.assertEqual(args[1], "https://dev.khalti.com/api/v2/epayment/initiate/")
        self.assertEqual(args[3]["Authorization"], "Key live_secret_key_test")
        self.assertEqual(args[4]["amount"], 1000)
        self.assertEqual(r.provider_ref, "P1")
        with self.assertRaises(PaymentError):
            self.k.initiate("O", 999, "x", "https://r")

    def test_lookup(self):
        for status, http_status, expected in [
            ("Completed", 200, "paid"),
            ("Expired", 400, "expired"),
            ("User canceled", 400, "canceled"),
            ("Partially refunded", 200, "partially_refunded"),
        ]:
            body = {
                "pidx": "P",
                "total_amount": 1000,
                "status": status,
                "transaction_id": "T",
                "fee": 0,
                "refunded": False,
            }
            with mock.patch(HTTP, return_value=resp(body, http_status)):
                self.assertEqual(self.k.verify("O", 1000, "P").status, expected)
        with self.assertRaises(PaymentError):
            self.k.verify("O", 1000, "P", callback={"pidx": "OTHER"})


if __name__ == "__main__":
    unittest.main()

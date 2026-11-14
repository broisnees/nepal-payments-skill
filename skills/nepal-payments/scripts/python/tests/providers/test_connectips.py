import base64
import unittest
from unittest import mock

from helpers import new_rsa_key, resp
from nepal_payments.core import PaymentError
from nepal_payments.providers.connectips import ConnectIps, connectips_token_string

HTTP = "nepal_payments.providers.connectips.adapter.http"


class ConnectIpsTests(unittest.TestCase):
    def setUp(self):
        self.key, pem = new_rsa_key(self)
        self.c = ConnectIps("sandbox", 550, "MER-550-APP-1", "Test", "pw", pem)

    def test_token(self):
        from cryptography.hazmat.primitives import hashes
        from cryptography.hazmat.primitives.asymmetric import padding

        f = self.c.initiate("txn123", 500, "Order, #1").fields
        self.assertEqual(f["TXNAMT"], "500")
        self.assertEqual(f["REMARKS"], "Order  #1")
        msg = connectips_token_string(f)
        self.assertTrue(msg.endswith(",TOKEN=TOKEN"))
        self.key.public_key().verify(
            base64.b64decode(f["TOKEN"]), msg.encode(), padding.PKCS1v15(), hashes.SHA256()
        )
        with self.assertRaises(PaymentError):
            self.c.initiate("X" * 21, 100, "x")

    def test_validate(self):
        for status, desc, expected in [
            ("SUCCESS", "TRANSACTION SUCCESSFUL", "paid"),
            ("ERROR", "TRANSACTION NOT FOUND", "not_found"),
            ("ERROR", "TRANSACTION INCOMPLETE", "pending"),
        ]:
            answer = {
                "referenceId": "txn123",
                "txnAmt": "500",
                "status": status,
                "statusDesc": desc,
            }
            with mock.patch(HTTP, return_value=resp(answer)) as h:
                self.assertEqual(self.c.verify("txn123", 500).status, expected)
            body = h.call_args[0][4]
            self.assertEqual((body["referenceId"], body["txnAmt"]), ("txn123", 500))


if __name__ == "__main__":
    unittest.main()

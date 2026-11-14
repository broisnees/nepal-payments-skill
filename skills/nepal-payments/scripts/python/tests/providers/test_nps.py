import hashlib
import hmac
import unittest
from unittest import mock

from helpers import resp
from nepal_payments.providers.nps import Nps, nps_sign

HTTP = "nepal_payments.providers.nps.adapter.http"


class NpsTests(unittest.TestCase):
    def test_sign(self):
        exp = hmac.new(b"secret", b"1009TestMerchantT1", hashlib.sha512).hexdigest()
        payload = {
            "MerchantTxnId": "T1",
            "MerchantName": "TestMerchant",
            "Amount": "100",
            "MerchantId": "9",
        }
        self.assertEqual(nps_sign("secret", payload), exp)

    def test_flow(self):
        n = Nps("sandbox", "9", "TestMerchant", "u", "p", "secret")
        process = resp({"code": "0", "message": "", "errors": [], "data": {"ProcessId": "PROC_1"}})
        with mock.patch(HTTP, return_value=process):
            f = n.initiate("T1", 10000, "x", "https://r")
        self.assertEqual(
            (f.enctype, f.provider_ref, f.fields["Amount"]),
            ("multipart/form-data", "PROC_1", "100"),
        )
        failed = resp(
            {"code": "0", "errors": [], "data": {"Status": "Fail", "MerchantTxnId": "T1"}}
        )
        with mock.patch(HTTP, return_value=failed):
            self.assertEqual(n.verify("T1", 10000).status, "failed")
        not_init = resp(
            {
                "code": "1",
                "errors": [{"error_code": "3", "error_message": "Transaction not initialized yet"}],
                "data": None,
            }
        )
        with mock.patch(HTTP, return_value=not_init):
            self.assertEqual(n.verify("T1", 10000).status, "not_found")


class NpsRegressions(unittest.TestCase):
    def test_nps_null_data_is_unknown(self):
        n = Nps("sandbox", "9", "M", "u", "p", "s")
        with mock.patch(
            HTTP, return_value=resp({"code": "0", "message": "", "errors": [], "data": None})
        ):
            v = n.verify("T1", 10000)
        self.assertEqual((v.status, v.amount_paisa), ("unknown", None))


if __name__ == "__main__":
    unittest.main()

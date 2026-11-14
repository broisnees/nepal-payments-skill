import base64
import unittest
import urllib.parse
from unittest import mock

from helpers import resp
from nepal_payments.providers.imepay import ImePay

HTTP = "nepal_payments.providers.imepay.adapter.http"


class ImePayTests(unittest.TestCase):
    def test_flow(self):
        i = ImePay("sandbox", "MC", "u", "p", "MOD")
        with mock.patch(HTTP, return_value=resp({"TokenId": "TK1", "ResponseCode": 0})) as h:
            r = i.initiate("R1", 10000, "x", "https://s/ok", failure_url="https://s/no")
        self.assertEqual(h.call_args[0][3]["Module"], base64.b64encode(b"MOD").decode())
        data = urllib.parse.parse_qs(urllib.parse.urlparse(r.url).query)["data"][0]
        self.assertEqual(
            base64.b64decode(data).decode(), "TK1|MC|R1|100.00|POST|https://s/ok|https://s/no"
        )
        with mock.patch(HTTP, return_value=resp({"ResponseCode": 1, "RefId": "R1"})):
            self.assertEqual(i.verify("R1", 10000, "TK1").status, "pending")


if __name__ == "__main__":
    unittest.main()

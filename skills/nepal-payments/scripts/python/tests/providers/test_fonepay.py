import unittest
import urllib.parse
from datetime import datetime, timezone
from unittest import mock

from helpers import resp
from nepal_payments.core import HttpResponse, PaymentError
from nepal_payments.providers.fonepay import Fonepay, fonepay_date, fonepay_hmac

HTTP = "nepal_payments.providers.fonepay.adapter.http"


class FonepayTests(unittest.TestCase):
    secret = "a7e3512f5032480a83137793cb2021dc"

    def test_response_dv_vector(self):
        values = [
            "d1580724437729",
            "NBQM",
            "true",
            "successful",
            "36463",
            "NICENPKA",
            "9841845631",
            "20.0",
            "30",
        ]
        self.assertEqual(
            fonepay_hmac(self.secret, values),
            "667860224021DF1891F7DE873A37B1DEDA720CCDC43F63BC88F86ED20F579E0DE66526D37C71B1D14A8D466E4B740D17D4FF274CD2819FD6ED2AA3D9A89D7C52",
        )

    def test_txn_verification_auth_vector(self):
        fp = Fonepay("production", "NBQM", self.secret, "gnw71090@zwoho.com", "Fonepay@12345")
        answer = {"paymentStatus": "success", "requestedAmount": "30", "fonepayTraceId": 12847}
        with mock.patch(HTTP, return_value=resp(answer)) as h:
            v = fp.verify("d1549791827186", 3000)
        _, _, _, headers, body, *_ = h.call_args[0]
        self.assertEqual(body, '{"prn": "d1549791827186","merchantCode": "NBQM","amount": "30"}')
        self.assertEqual(
            headers["auth"],
            "0d3ebe65246182596de0d417e8e39d37ebe2f5da028c52ae0a33a05062a3bded8a737c3ff82b6f1a6d9442d11cfcb0432d86998af81f481948c0af7b346f4fa2",
        )
        self.assertEqual(
            headers["Authorization"], "Basic Z253NzEwOTBAendvaG8uY29tOkZvbmVwYXlAMTIzNDU="
        )
        self.assertEqual((v.status, v.amount_paisa), ("paid", 3000))

    def test_qr_vector(self):
        fp = Fonepay("production", "NBQM", self.secret, "u", "p")
        answer = {"qrMessage": "0002", "thirdpartyQrWebSocketUrl": "wss://localhost:1/x"}
        with mock.patch(HTTP, return_value=resp(answer)) as h:
            r = fp.qr_create("5d76d323-d1f6", 1400, "test1", "test2")
        self.assertEqual(
            h.call_args.kwargs["body"]["dataValidation"],
            "5ae718032328ae5615fa4694dfbf3ecd13432bd49031e7285a3f8bc122ecbb8e833e83c7a11f895d30f3e8fd1906317aece113675166ae0d804ecf32a8bbdbaf",
        )
        self.assertEqual(r["websocket_url"], "wss://ws.fonepay.com/x")

    def test_initiate_and_callback(self):
        fp = Fonepay("sandbox", "NBQM", self.secret)
        url = fp.initiate("NP123", 1050, "Order 1", "https://s.example/r").url
        q = dict(urllib.parse.parse_qsl(urllib.parse.urlparse(url).query))
        self.assertEqual(q["AMT"], "10.50")
        self.assertEqual(
            q["DV"],
            fonepay_hmac(
                self.secret,
                [
                    "NBQM",
                    "P",
                    "NP123",
                    "10.50",
                    "NPR",
                    q["DT"],
                    "Order 1",
                    "N/A",
                    "https://s.example/r",
                ],
            ),
        )
        self.assertEqual(
            fonepay_date(datetime(2026, 11, 4, 20, 0, tzinfo=timezone.utc)), "11/05/2026"
        )
        cb = {
            "PRN": "d1580724437729",
            "PID": "NBQM",
            "PS": "true",
            "RC": "successful",
            "UID": "36463",
            "BC": "NICENPKA",
            "INI": "9841845631",
            "P_AMT": "20.0",
            "R_AMT": "30",
        }
        cb["DV"] = fonepay_hmac(self.secret, list(cb.values())).lower()
        self.assertTrue(fp.callback_valid(cb))
        self.assertFalse(fp.callback_valid({**cb, "R_AMT": "3"}))

    def test_forged_callback_without_dv(self):
        forged = {
            "PRN": "NP123",
            "PID": "NBQM",
            "PS": "false",
            "RC": "failed",
            "UID": "x",
            "BC": "y",
        }
        with self.assertRaises(PaymentError) as ctx:
            Fonepay("sandbox", "NBQM", self.secret).verify("NP123", 1000, callback=forged)
        self.assertEqual(ctx.exception.code, "invalid_signature")
        with self.assertRaises(PaymentError) as ctx:
            lenient = Fonepay("sandbox", "NBQM", self.secret, strict_signature=False)
            lenient.verify("NP123", 1000, callback=forged)
        self.assertEqual(ctx.exception.code, "verify_unavailable")

    def test_legacy_upstream_error(self):
        fp = Fonepay("sandbox", "NBQM", self.secret)
        cb = {
            "PRN": "NP123",
            "PID": "NBQM",
            "PS": "true",
            "RC": "successful",
            "UID": "1",
            "BC": "B",
            "INI": "9",
            "P_AMT": "10",
            "R_AMT": "10",
        }
        cb["DV"] = fonepay_hmac(self.secret, list(cb.values()))
        bad_gateway = HttpResponse(502, "<html>", "<html>Bad Gateway</html>")
        with mock.patch(HTTP, return_value=bad_gateway):
            with self.assertRaises(PaymentError) as ctx:
                fp.verify("NP123", 1000, callback=cb)
        self.assertEqual(ctx.exception.code, "upstream_error")


if __name__ == "__main__":
    unittest.main()

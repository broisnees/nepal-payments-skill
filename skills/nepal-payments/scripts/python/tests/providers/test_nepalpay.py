import base64
import unittest
from unittest import mock

from helpers import new_rsa_key, resp
from nepal_payments.core import PaymentError, rsa_pkcs1_encrypt_b64
from nepal_payments.providers.nepalpay import (
    NepalPay,
    nepal_pay_confirmation_string,
    nepal_pay_token_string,
)

HTTP = "nepal_payments.providers.nepalpay.adapter.http"


class NepalPayTests(unittest.TestCase):
    generated = {
        "timestamp": "2022-05-23 04:25:26",
        "responseCode": "000",
        "responseStatus": "SUCCESS",
        "responseMessage": "QR String generated successfully.",
        "data": {
            "validationTraceId": "2205260000001900KIY",
            "qrString": " 000201010212...6304607F",
            "qrImage": "iVBORw0KGgo=",
        },
    }

    def setUp(self):
        self.key, pem = new_rsa_key(self)
        self.base = {
            "env": "sandbox",
            "acquirer_id": "00001701",
            "merchant_id": "17012UVSTIR",
            "merchant_name": "BBSM",
            "merchant_category_code": 5021,
            "merchant_city": "Kathmandu",
            "merchant_postal_code": "4600",
            "store_label": "Store1",
            "terminal_label": "Terminal1",
            "username": "npiuser",
            "password": "pw",
            "private_key_pem": pem,
        }
        self.n = NepalPay(**self.base)

    def sig_ok(self, sig, msg):
        from cryptography.exceptions import InvalidSignature
        from cryptography.hazmat.primitives import hashes
        from cryptography.hazmat.primitives.asymmetric import padding

        try:
            self.key.public_key().verify(
                base64.b64decode(sig), msg.encode(), padding.PKCS1v15(), hashes.SHA256()
            )
            return True
        except InvalidSignature:
            return False

    @staticmethod
    def txn(**o):
        return {
            "nQrTxnId": "2312060000059575KMB",
            "amount": 10.5,
            "tranType": "PMT",
            "merchantBillNo": "P1",
            **o,
        }

    @staticmethod
    def report(rows):
        return {
            "timestamp": "2024-02-07T07:10:47.928+0000",
            "responseCode": "200",
            "responseStatus": "SUCCESS",
            "responseBody": rows,
        }

    def test_token_string(self):
        self.assertEqual(
            nepal_pay_token_string("00001701", "17012UVSTIR", 5021, 524, "10.50", "P1", "npiuser"),
            "00001701,17012UVSTIR,5021,524,10.50,P1,npiuser",
        )

    def test_initiate(self):
        with mock.patch(HTTP, return_value=resp(self.generated)) as h:
            r = self.n.initiate("P1", 1050, "Everest T-shirt, large and blue", "")
        _, url, _, headers, body, *_ = h.call_args[0]
        self.assertEqual(url, "https://devopennpi.connectips.com/qr/generateQR")
        self.assertEqual(
            headers["Authorization"], "Basic " + base64.b64encode(b"npiuser:pw").decode()
        )
        self.assertEqual(
            (
                body["pointOfInitialization"],
                body["transactionAmount"],
                body["transactionCurrency"],
                body["billNumber"],
            ),
            (12, "10.50", 524, "P1"),
        )
        self.assertEqual(len(body["purposeOfTransaction"]), 25)
        self.assertIs(body["qrImage"], True)
        self.assertTrue(
            self.sig_ok(body["token"], "00001701,17012UVSTIR,5021,524,10.50,P1,npiuser")
        )
        self.assertEqual(
            (r.kind, r.provider_ref, r.qr_string, r.qr_image),
            ("qr", "2205260000001900KIY", "000201010212...6304607F", "iVBORw0KGgo="),
        )
        with mock.patch(HTTP, return_value=resp(self.generated)) as h:
            self.n.initiate("P2", 100000, "x", "")
        self.assertEqual(h.call_args[0][4]["transactionAmount"], "1000.00")

    def test_initiate_errors(self):
        with self.assertRaisesRegex(PaymentError, "1–25"):
            self.n.initiate("X" * 26, 100, "x", "")
        invalid = {"responses": [{"responseCode": "E003", "responseMessage": "INVALID TOKEN"}]}
        with mock.patch(HTTP, return_value=resp(invalid, 400)):
            with self.assertRaises(PaymentError) as cm:
                self.n.initiate("P1", 100, "x", "")
        self.assertEqual(cm.exception.code, "E003")

    def test_verify_success_after_failed_scan(self):
        rows = [
            self.txn(nQrTxnId="A", debitStatus="E001", creditStatus=None),
            self.txn(nQrTxnId="B", debitStatus="000", creditStatus="DEFER"),
        ]
        with mock.patch(HTTP, return_value=resp(self.report(rows))) as h:
            v = self.n.verify("P1", 1050, "2205260000001900KIY")
        self.assertEqual(
            h.call_args[0][1], "https://devopennpi.connectips.com/nQR/v1/merchanttxnreport"
        )
        self.assertEqual(
            h.call_args[0][4],
            {
                "validationTraceId": "2205260000001900KIY",
                "merchantId": "17012UVSTIR",
                "acquirerId": "00001701",
            },
        )
        self.assertEqual((v.status, v.amount_paisa, v.transaction_id), ("paid", 1050, "B"))

    def test_verify_status_mapping(self):
        t, rep = self.txn, self.report
        cases = [
            (rep([t(debitStatus="000", creditStatus="000")]), "paid"),
            (rep([t(debitStatus="000", creditStatus="999")]), "paid"),
            (rep([t(debitStatus="000", creditStatus="E99")]), "unknown"),
            (rep([t(debitStatus="E001", creditStatus=None)]), "failed"),
            (rep([t(debitStatus="000", creditStatus="000", tranType="RFND")]), "not_found"),
            (rep([]), "not_found"),
            ({"responseCode": "E010", "responseMessage": "RECORD NOT FOUND"}, "not_found"),
        ]
        for body, want in cases:
            with mock.patch(HTTP, return_value=resp(body)):
                self.assertEqual(self.n.verify("P1", 1050, "T").status, want)
        with self.assertRaises(PaymentError) as cm:
            self.n.verify("P1", 1050)
        self.assertEqual(cm.exception.code, "missing_provider_ref")

    def test_oauth_token_cached(self):
        o = NepalPay(**self.base, auth="oauth", client_id="cid", client_secret="csec")

        def fake(provider, url, *a, **k):
            if url.endswith("/oauth/token"):
                return resp({"access_token": "AT1", "token_type": "bearer", "expires_in": 299})
            return resp(self.report([]))

        with mock.patch(HTTP, side_effect=fake) as h:
            o.verify("P1", 100, "T")
            o.verify("P1", 100, "T")
        calls = [c[0] for c in h.call_args_list]
        self.assertEqual(len(calls), 3)
        self.assertEqual(
            calls[0][3]["Authorization"], "Basic " + base64.b64encode(b"cid:csec").decode()
        )
        self.assertEqual(calls[0][4], "grant_type=password&username=npiuser&password=pw")
        self.assertEqual(
            [calls[1][3]["Authorization"], calls[2][3]["Authorization"]],
            ["Bearer AT1", "Bearer AT1"],
        )

    def test_confirmation_response(self):
        r = self.n.confirmation_response("2024-11-10 01:35:31", "P1", "2411100000067378ZHU")
        self.assertTrue(
            self.sig_ok(
                r["signature"],
                "2024-11-10 01:35:31,SUCCESS,TRANSACTION SUCCESSFUL,P1,2411100000067378ZHU",
            )
        )
        self.assertEqual(NepalPay.order_id_from_callback({"merchantBillNo": "P1"}), "P1")

    def with_nchl(self):
        from cryptography.hazmat.primitives import serialization

        self.spki = self.key.public_key().public_bytes(
            serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo
        )
        return NepalPay(
            **self.base,
            nchl_public_key_pem=self.spki,
            ws_url="wss://ws.example/nqrws",
            ws_username="wsuser",
            ws_api_token="secret-api-token",
        )

    def test_verify_confirmation(self):
        from cryptography.hazmat.primitives import hashes
        from cryptography.hazmat.primitives.asymmetric import padding

        w = self.with_nchl()
        note = {
            "merchantBillNo": "NA",
            "merchantId": "0010SVQNL9H",
            "merchantName": "Quantum Labs",
            "paymentRef": "2411100000067378ZHU",
            "channel": "CIPS",
            "payerMobile": "+977-9843705813",
            "sessionNo": "5446",
            "status": "SUCCESS",
        }
        msg = "NA,0010SVQNL9H,Quantum Labs,2411100000067378ZHU,CIPS,+977-9843705813,5446"
        self.assertEqual(nepal_pay_confirmation_string(note), msg)
        self.assertEqual(
            nepal_pay_confirmation_string({**note, "payerMobileNumber": "98", "sessionNo": None}),
            "NA,0010SVQNL9H,Quantum Labs,2411100000067378ZHU,CIPS,98,",
        )
        sig = base64.b64encode(
            self.key.sign(msg.encode(), padding.PKCS1v15(), hashes.SHA256())
        ).decode()
        self.assertTrue(w.verify_confirmation({**note, "signature": sig}))
        self.assertFalse(w.verify_confirmation({**note, "sessionNo": "5447", "signature": sig}))
        self.assertFalse(w.verify_confirmation({**note, "signature": "not base64!"}))
        self.assertFalse(w.verify_confirmation(note))
        with self.assertRaisesRegex(ValueError, "nchl_public_key_pem"):
            self.n.verify_confirmation(note)

    def test_web_socket_request(self):
        from cryptography.hazmat.primitives.asymmetric import padding

        w = self.with_nchl()
        r = w.web_socket_request("2205260000001900KIY")
        b = r["body"]
        self.assertEqual(
            (r["url"], r["subscribe"], r["send"], b["merchant_id"], b["request_id"], b["username"]),
            (
                "wss://ws.example/nqrws",
                "/user/nqrws/check-txn-status",
                "/nqrws/check-txn-status",
                "Terminal1",
                "2205260000001900KIY",
                "wsuser",
            ),
        )
        ct = base64.b64decode(b["api_token"])
        self.assertEqual(len(ct), 256)
        self.assertEqual(self.key.decrypt(ct, padding.PKCS1v15()), b"secret-api-token")
        self.assertNotEqual(
            w.web_socket_request("X")["body"]["api_token"],
            w.web_socket_request("X")["body"]["api_token"],
        )
        no_terminal = NepalPay(
            **{**self.base, "terminal_label": None},
            nchl_public_key_pem=self.spki,
            ws_url="u",
            ws_username="u",
            ws_api_token="t",
        )
        self.assertEqual(no_terminal.web_socket_request("X")["body"]["merchant_id"], "0")
        with self.assertRaisesRegex(ValueError, "ws_url"):
            self.n.web_socket_request("X")
        with self.assertRaisesRegex(ValueError, "too long"):
            rsa_pkcs1_encrypt_b64(self.spki, "x" * 246)
        self.assertEqual(len(base64.b64decode(rsa_pkcs1_encrypt_b64(self.spki, "x" * 245))), 256)


if __name__ == "__main__":
    unittest.main()

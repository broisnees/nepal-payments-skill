"""Offline tests: published vectors + mocked HTTP. Run from scripts/python: python -m unittest -v"""

import base64
import hashlib
import hmac
import json
import unittest
from datetime import datetime, timezone
from unittest import mock

from nepal_payments import (ConnectIps, CyberSource, Esewa, Fonepay, GetPay, HamroPay, ImePay, Khalti, NepalPay, Nps, PaymentError,
                            decide_transition, new_order_id, paisa_to_rupees, render_auto_submit_form, rupees_to_paisa)
from nepal_payments.core import FormResult, HttpResponse, b64decode_lenient
from nepal_payments.connectips import connectips_token_string
from nepal_payments.cybersource import cybersource_sign
from nepal_payments.esewa import SANDBOX, esewa_sign
from nepal_payments.fonepay import fonepay_date, fonepay_hmac
from nepal_payments.core import rsa_pkcs1_encrypt_b64
from nepal_payments.nepalpay import nepal_pay_confirmation_string, nepal_pay_token_string
from nepal_payments.getpay import get_pay_decode_token, get_pay_opr_secret
from nepal_payments.hamropay import hamro_pay_sign
from nepal_payments.nps import nps_sign


def resp(data, status=200):
    return HttpResponse(status, data, json.dumps(data) if not isinstance(data, str) else data)


def b64json(d):
    return base64.b64encode(json.dumps(d).encode()).decode()


class Core(unittest.TestCase):
    def test_money(self):
        self.assertEqual(paisa_to_rupees(10000), "100")
        self.assertEqual(paisa_to_rupees(10050), "100.50")
        self.assertEqual(rupees_to_paisa("1,000.0"), 100000)
        self.assertEqual(rupees_to_paisa(100.1), 10010)
        self.assertEqual(rupees_to_paisa("19.995"), 2000)
        self.assertEqual(rupees_to_paisa(1.005), 101)

    def test_decide_transition(self):
        H = 3600
        self.assertEqual(decide_transition("initiated", "paid", 1000, 1000, 0).next, "paid")
        d = decide_transition("pending", "paid", 10, 1000, 0)
        self.assertEqual((d.next, d.review_required), ("unknown", True))
        self.assertTrue(decide_transition("pending", "paid", None, 1000, 0).review_required)
        self.assertIsNone(decide_transition("initiated", "not_found", None, 1000, 300).next)
        self.assertEqual(decide_transition("initiated", "not_found", None, 1000, 2 * H).next, "expired")
        late = decide_transition("expired", "paid", 1000, 1000, 3 * H)
        self.assertEqual((late.next, late.late_paid), ("paid", True))
        self.assertIsNone(decide_transition("paid", "failed", None, 1000, 0).next)
        self.assertIsNone(decide_transition("pending", "pending", None, 1000, 0).next)

    def test_b64_space_restore(self):
        self.assertEqual(b64decode_lenient(" /  "), bytes([251, 255, 190]))  # "+/++" after '+'->' '

    def test_order_id(self):
        for _ in range(500):
            o = new_order_id()
            self.assertTrue(17 <= len(o) <= 20 and o.isalnum())

    def test_form_escape(self):
        html = render_auto_submit_form(FormResult("https://x", {"a": '"><script>'}, enctype="multipart/form-data"))
        self.assertIn("&quot;&gt;&lt;script&gt;", html)
        self.assertIn('enctype="multipart/form-data"', html)


class EsewaTests(unittest.TestCase):
    e = Esewa("sandbox", SANDBOX["product_code"], SANDBOX["secret_key"],
              SANDBOX["intent_product_code"], SANDBOX["intent_access_key"])
    order = ["total_amount", "transaction_uuid", "product_code"]

    def test_vectors(self):
        k = SANDBOX["secret_key"]
        self.assertEqual(esewa_sign(k, {"total_amount": "100", "transaction_uuid": "11-201-13", "product_code": "EPAYTEST"}, self.order),
                         "5DZywcrTKD0gia/rsSMcrRHmJl+4Tbol6S+lWgdJ94E=")
        self.assertEqual(esewa_sign(k, {"total_amount": "110", "transaction_uuid": "ab14a8f2b02c3", "product_code": "EPAYTEST"}, self.order),
                         "0Gh9pc1fiZDZH7OKOBdn42QMx8drH7tOeMPdRQhI83g=")
        self.assertEqual(esewa_sign(SANDBOX["intent_access_key"], {"product_code": "INTENT", "amount": "100", "transaction_uuid": "txn-20251220-001"},
                                    ["product_code", "amount", "transaction_uuid"]), "oVRo2ZkjNpbt5vKs7RSNx1OCcewDaVssoguWsG31HMA=")

    def test_initiate(self):
        f = self.e.initiate("ORD-1", 11050, "x", "https://s/r/ORD-1", tax_paisa=1000)
        self.assertEqual((f.fields["total_amount"], f.fields["amount"]), ("110.50", "100.50"))
        with self.assertRaises(PaymentError):
            self.e.initiate("ORD-1", 1000, "x", "https://s", tax_paisa=1000)
        self.assertEqual(f.fields["signature"], esewa_sign(SANDBOX["secret_key"], f.fields, self.order))
        with self.assertRaises(PaymentError):
            self.e.initiate("a_b", 100, "x", "https://s")

    def _payload(self, **o):
        p = {"transaction_code": "000AWEO", "status": "COMPLETE", "total_amount": "1000.0", "transaction_uuid": "ORD-2",
             "product_code": "EPAYTEST",
             "signed_field_names": "transaction_code,status,total_amount,transaction_uuid,product_code,signed_field_names", **o}
        p["signature"] = esewa_sign(SANDBOX["secret_key"], p, p["signed_field_names"].split(","))
        return p

    def test_parse_success(self):
        p = self._payload()
        self.assertTrue(self.e.parse_success(b64json(p))[1])
        self.assertTrue(self.e.parse_success(b64json(p).replace("+", " "))[1])
        self.assertFalse(self.e.parse_success(b64json({**p, "total_amount": "1.0"}))[1])
        self.assertTrue(self.e.parse_success(b64json({**p, "total_amount": "1,000.0"}))[1])
        raw = json.dumps(p).replace('"total_amount": "1000.0"', '"total_amount": 1000.0')
        self.assertIn('"total_amount": 1000.0', raw)
        self.assertTrue(self.e.parse_success(base64.b64encode(raw.encode()).decode())[1])

    def test_verify(self):
        with mock.patch("nepal_payments.esewa.http", return_value=resp(
                {"product_code": "EPAYTEST", "transaction_uuid": "ORD-2", "total_amount": 1000.0, "status": "COMPLETE", "ref_id": "R1"})) as h:
            v = self.e.verify("ORD-2", 100000, callback={"data": b64json(self._payload())})
        self.assertEqual((v.status, v.amount_paisa, v.transaction_id), ("paid", 100000, "R1"))
        self.assertIn("total_amount=1000&transaction_uuid=ORD-2", h.call_args[0][1])
        with self.assertRaises(PaymentError):
            self.e.verify("ORD-2", 100000, callback={"data": b64json(self._payload(transaction_uuid="OTHER"))})

    def test_intent_book_signs_amount(self):
        with mock.patch("nepal_payments.esewa.http", return_value=resp(
                {"code": "IP-201", "data": {"booking_id": "VkQ=", "deeplink": "https://rc-links.esewa.com.np/pay/VkQ=", "correlation_id": "C1"}})) as h:
            b = self.e.intent_book("txn-20251220-001", 10000, "https://cb", "https://done")
        body = h.call_args.kwargs["body"]
        self.assertEqual(body["signature"], "oVRo2ZkjNpbt5vKs7RSNx1OCcewDaVssoguWsG31HMA=")
        self.assertEqual(body["amount"], 100)
        self.assertEqual(b["provider_ref"], "VkQ=|C1")


class KhaltiTests(unittest.TestCase):
    k = Khalti("live_secret_key_test", "sandbox", "https://shop.example")

    def test_initiate(self):
        with mock.patch("nepal_payments.khalti.http", return_value=resp({"pidx": "P1", "payment_url": "https://test-pay.khalti.com/?pidx=P1", "expires_at": "x", "expires_in": 1800})) as h:
            r = self.k.initiate("O1", 1000, "Book", "https://shop.example/r")
        args = h.call_args[0]
        self.assertEqual(args[1], "https://dev.khalti.com/api/v2/epayment/initiate/")
        self.assertEqual(args[3]["Authorization"], "Key live_secret_key_test")
        self.assertEqual(args[4]["amount"], 1000)
        self.assertEqual(r.provider_ref, "P1")
        with self.assertRaises(PaymentError):
            self.k.initiate("O", 999, "x", "https://r")

    def test_lookup(self):
        for status, http_status, expected in [("Completed", 200, "paid"), ("Expired", 400, "expired"),
                                              ("User canceled", 400, "canceled"), ("Partially refunded", 200, "partially_refunded")]:
            with mock.patch("nepal_payments.khalti.http", return_value=resp({"pidx": "P", "total_amount": 1000, "status": status, "transaction_id": "T", "fee": 0, "refunded": False}, http_status)):
                self.assertEqual(self.k.verify("O", 1000, "P").status, expected)
        with self.assertRaises(PaymentError):
            self.k.verify("O", 1000, "P", callback={"pidx": "OTHER"})


class FonepayTests(unittest.TestCase):
    secret = "a7e3512f5032480a83137793cb2021dc"

    def test_response_dv_vector(self):
        self.assertEqual(fonepay_hmac(self.secret, ["d1580724437729", "NBQM", "true", "successful", "36463", "NICENPKA", "9841845631", "20.0", "30"]),
                         "667860224021DF1891F7DE873A37B1DEDA720CCDC43F63BC88F86ED20F579E0DE66526D37C71B1D14A8D466E4B740D17D4FF274CD2819FD6ED2AA3D9A89D7C52")

    def test_txn_verification_auth_vector(self):
        fp = Fonepay("production", "NBQM", self.secret, "gnw71090@zwoho.com", "Fonepay@12345")
        with mock.patch("nepal_payments.fonepay.http", return_value=resp({"paymentStatus": "success", "requestedAmount": "30", "fonepayTraceId": 12847})) as h:
            v = fp.verify("d1549791827186", 3000)
        _, _, _, headers, body, *_ = h.call_args[0]
        self.assertEqual(body, '{"prn": "d1549791827186","merchantCode": "NBQM","amount": "30"}')
        self.assertEqual(headers["auth"], "0d3ebe65246182596de0d417e8e39d37ebe2f5da028c52ae0a33a05062a3bded8a737c3ff82b6f1a6d9442d11cfcb0432d86998af81f481948c0af7b346f4fa2")
        self.assertEqual(headers["Authorization"], "Basic Z253NzEwOTBAendvaG8uY29tOkZvbmVwYXlAMTIzNDU=")
        self.assertEqual((v.status, v.amount_paisa), ("paid", 3000))

    def test_qr_vector(self):
        fp = Fonepay("production", "NBQM", self.secret, "u", "p")
        with mock.patch("nepal_payments.fonepay.http", return_value=resp({"qrMessage": "0002", "thirdpartyQrWebSocketUrl": "wss://localhost:1/x"})) as h:
            r = fp.qr_create("5d76d323-d1f6", 1400, "test1", "test2")
        self.assertEqual(h.call_args.kwargs["body"]["dataValidation"],
                         "5ae718032328ae5615fa4694dfbf3ecd13432bd49031e7285a3f8bc122ecbb8e833e83c7a11f895d30f3e8fd1906317aece113675166ae0d804ecf32a8bbdbaf")
        self.assertEqual(r["websocket_url"], "wss://ws.fonepay.com/x")

    def test_initiate_and_callback(self):
        fp = Fonepay("sandbox", "NBQM", self.secret)
        import urllib.parse
        q = dict(urllib.parse.parse_qsl(urllib.parse.urlparse(fp.initiate("NP123", 1050, "Order 1", "https://s.example/r").url).query))
        self.assertEqual(q["AMT"], "10.50")
        self.assertEqual(q["DV"], fonepay_hmac(self.secret, ["NBQM", "P", "NP123", "10.50", "NPR", q["DT"], "Order 1", "N/A", "https://s.example/r"]))
        self.assertEqual(fonepay_date(datetime(2026, 11, 4, 20, 0, tzinfo=timezone.utc)), "11/05/2026")
        cb = {"PRN": "d1580724437729", "PID": "NBQM", "PS": "true", "RC": "successful", "UID": "36463", "BC": "NICENPKA", "INI": "9841845631", "P_AMT": "20.0", "R_AMT": "30"}
        cb["DV"] = fonepay_hmac(self.secret, list(cb.values())).lower()
        self.assertTrue(fp.callback_valid(cb))
        self.assertFalse(fp.callback_valid({**cb, "R_AMT": "3"}))

    def test_forged_callback_without_dv(self):
        forged = {"PRN": "NP123", "PID": "NBQM", "PS": "false", "RC": "failed", "UID": "x", "BC": "y"}
        with self.assertRaises(PaymentError) as ctx:
            Fonepay("sandbox", "NBQM", self.secret).verify("NP123", 1000, callback=forged)
        self.assertEqual(ctx.exception.code, "invalid_signature")
        with self.assertRaises(PaymentError) as ctx:
            Fonepay("sandbox", "NBQM", self.secret, strict_signature=False).verify("NP123", 1000, callback=forged)
        self.assertEqual(ctx.exception.code, "verify_unavailable")

    def test_legacy_upstream_error(self):
        fp = Fonepay("sandbox", "NBQM", self.secret)
        cb = {"PRN": "NP123", "PID": "NBQM", "PS": "true", "RC": "successful", "UID": "1", "BC": "B", "INI": "9", "P_AMT": "10", "R_AMT": "10"}
        cb["DV"] = fonepay_hmac(self.secret, list(cb.values()))
        with mock.patch("nepal_payments.fonepay.http", return_value=HttpResponse(502, "<html>", "<html>Bad Gateway</html>")):
            with self.assertRaises(PaymentError) as ctx:
                fp.verify("NP123", 1000, callback=cb)
        self.assertEqual(ctx.exception.code, "upstream_error")


class ConnectIpsTests(unittest.TestCase):
    def setUp(self):
        try:
            from cryptography.hazmat.primitives import serialization
            from cryptography.hazmat.primitives.asymmetric import rsa
        except ImportError:
            self.skipTest("pip install cryptography")
        self.key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        pem = self.key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())
        self.c = ConnectIps("sandbox", 550, "MER-550-APP-1", "Test", "pw", pem)

    def test_token(self):
        from cryptography.hazmat.primitives import hashes
        from cryptography.hazmat.primitives.asymmetric import padding
        f = self.c.initiate("txn123", 500, "Order, #1").fields
        self.assertEqual(f["TXNAMT"], "500")
        self.assertEqual(f["REMARKS"], "Order  #1")
        msg = connectips_token_string(f)
        self.assertTrue(msg.endswith(",TOKEN=TOKEN"))
        self.key.public_key().verify(base64.b64decode(f["TOKEN"]), msg.encode(), padding.PKCS1v15(), hashes.SHA256())
        with self.assertRaises(PaymentError):
            self.c.initiate("X" * 21, 100, "x")

    def test_validate(self):
        for status, desc, expected in [("SUCCESS", "TRANSACTION SUCCESSFUL", "paid"), ("ERROR", "TRANSACTION NOT FOUND", "not_found"), ("ERROR", "TRANSACTION INCOMPLETE", "pending")]:
            with mock.patch("nepal_payments.connectips.http", return_value=resp({"referenceId": "txn123", "txnAmt": "500", "status": status, "statusDesc": desc})) as h:
                self.assertEqual(self.c.verify("txn123", 500).status, expected)
            body = h.call_args[0][4]
            self.assertEqual((body["referenceId"], body["txnAmt"]), ("txn123", 500))


class NepalPayTests(unittest.TestCase):
    generated = {"timestamp": "2022-05-23 04:25:26", "responseCode": "000", "responseStatus": "SUCCESS",
                 "responseMessage": "QR String generated successfully.",
                 "data": {"validationTraceId": "2205260000001900KIY", "qrString": " 000201010212...6304607F", "qrImage": "iVBORw0KGgo="}}

    def setUp(self):
        try:
            from cryptography.hazmat.primitives import serialization
            from cryptography.hazmat.primitives.asymmetric import rsa
        except ImportError:
            self.skipTest("pip install cryptography")
        self.key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        pem = self.key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())
        self.base = dict(env="sandbox", acquirer_id="00001701", merchant_id="17012UVSTIR", merchant_name="BBSM",
                         merchant_category_code=5021, merchant_city="Kathmandu", merchant_postal_code="4600",
                         store_label="Store1", terminal_label="Terminal1", username="npiuser", password="pw", private_key_pem=pem)
        self.n = NepalPay(**self.base)

    def sig_ok(self, sig, msg):
        from cryptography.exceptions import InvalidSignature
        from cryptography.hazmat.primitives import hashes
        from cryptography.hazmat.primitives.asymmetric import padding
        try:
            self.key.public_key().verify(base64.b64decode(sig), msg.encode(), padding.PKCS1v15(), hashes.SHA256())
            return True
        except InvalidSignature:
            return False

    @staticmethod
    def txn(**o):
        return {"nQrTxnId": "2312060000059575KMB", "amount": 10.5, "tranType": "PMT", "merchantBillNo": "P1", **o}

    @staticmethod
    def report(rows):
        return {"timestamp": "2024-02-07T07:10:47.928+0000", "responseCode": "200", "responseStatus": "SUCCESS", "responseBody": rows}

    def test_token_string(self):
        self.assertEqual(nepal_pay_token_string("00001701", "17012UVSTIR", 5021, 524, "10.50", "P1", "npiuser"),
                         "00001701,17012UVSTIR,5021,524,10.50,P1,npiuser")

    def test_initiate(self):
        with mock.patch("nepal_payments.nepalpay.http", return_value=resp(self.generated)) as h:
            r = self.n.initiate("P1", 1050, "Everest T-shirt, large and blue", "")
        _, url, _, headers, body, *_ = h.call_args[0]
        self.assertEqual(url, "https://devopennpi.connectips.com/qr/generateQR")
        self.assertEqual(headers["Authorization"], "Basic " + base64.b64encode(b"npiuser:pw").decode())
        self.assertEqual((body["pointOfInitialization"], body["transactionAmount"], body["transactionCurrency"], body["billNumber"]),
                         (12, "10.50", 524, "P1"))
        self.assertEqual(len(body["purposeOfTransaction"]), 25)
        self.assertIs(body["qrImage"], True)
        self.assertTrue(self.sig_ok(body["token"], "00001701,17012UVSTIR,5021,524,10.50,P1,npiuser"))
        self.assertEqual((r.kind, r.provider_ref, r.qr_string, r.qr_image),
                         ("qr", "2205260000001900KIY", "000201010212...6304607F", "iVBORw0KGgo="))
        with mock.patch("nepal_payments.nepalpay.http", return_value=resp(self.generated)) as h:
            self.n.initiate("P2", 100000, "x", "")
        self.assertEqual(h.call_args[0][4]["transactionAmount"], "1000.00")

    def test_initiate_errors(self):
        with self.assertRaisesRegex(PaymentError, "1–25"):
            self.n.initiate("X" * 26, 100, "x", "")
        with mock.patch("nepal_payments.nepalpay.http", return_value=resp({"responses": [{"responseCode": "E003", "responseMessage": "INVALID TOKEN"}]}, 400)):
            with self.assertRaises(PaymentError) as cm:
                self.n.initiate("P1", 100, "x", "")
        self.assertEqual(cm.exception.code, "E003")

    def test_verify_success_after_failed_scan(self):
        rows = [self.txn(nQrTxnId="A", debitStatus="E001", creditStatus=None), self.txn(nQrTxnId="B", debitStatus="000", creditStatus="DEFER")]
        with mock.patch("nepal_payments.nepalpay.http", return_value=resp(self.report(rows))) as h:
            v = self.n.verify("P1", 1050, "2205260000001900KIY")
        self.assertEqual(h.call_args[0][1], "https://devopennpi.connectips.com/nQR/v1/merchanttxnreport")
        self.assertEqual(h.call_args[0][4], {"validationTraceId": "2205260000001900KIY", "merchantId": "17012UVSTIR", "acquirerId": "00001701"})
        self.assertEqual((v.status, v.amount_paisa, v.transaction_id), ("paid", 1050, "B"))

    def test_verify_status_mapping(self):
        t, rep = self.txn, self.report
        cases = [(rep([t(debitStatus="000", creditStatus="000")]), "paid"),
                 (rep([t(debitStatus="000", creditStatus="999")]), "paid"),
                 (rep([t(debitStatus="000", creditStatus="E99")]), "unknown"),
                 (rep([t(debitStatus="E001", creditStatus=None)]), "failed"),
                 (rep([t(debitStatus="000", creditStatus="000", tranType="RFND")]), "not_found"),
                 (rep([]), "not_found"),
                 ({"responseCode": "E010", "responseMessage": "RECORD NOT FOUND"}, "not_found")]
        for body, want in cases:
            with mock.patch("nepal_payments.nepalpay.http", return_value=resp(body)):
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
        with mock.patch("nepal_payments.nepalpay.http", side_effect=fake) as h:
            o.verify("P1", 100, "T")
            o.verify("P1", 100, "T")
        calls = [c[0] for c in h.call_args_list]
        self.assertEqual(len(calls), 3)
        self.assertEqual(calls[0][3]["Authorization"], "Basic " + base64.b64encode(b"cid:csec").decode())
        self.assertEqual(calls[0][4], "grant_type=password&username=npiuser&password=pw")
        self.assertEqual([calls[1][3]["Authorization"], calls[2][3]["Authorization"]], ["Bearer AT1", "Bearer AT1"])

    def test_confirmation_response(self):
        r = self.n.confirmation_response("2024-11-10 01:35:31", "P1", "2411100000067378ZHU")
        self.assertTrue(self.sig_ok(r["signature"], "2024-11-10 01:35:31,SUCCESS,TRANSACTION SUCCESSFUL,P1,2411100000067378ZHU"))
        self.assertEqual(NepalPay.order_id_from_callback({"merchantBillNo": "P1"}), "P1")

    def with_nchl(self):
        from cryptography.hazmat.primitives import serialization
        self.spki = self.key.public_key().public_bytes(serialization.Encoding.PEM,
                                                       serialization.PublicFormat.SubjectPublicKeyInfo)
        return NepalPay(**self.base, nchl_public_key_pem=self.spki, ws_url="wss://ws.example/nqrws",
                        ws_username="wsuser", ws_api_token="secret-api-token")

    def test_verify_confirmation(self):
        from cryptography.hazmat.primitives import hashes
        from cryptography.hazmat.primitives.asymmetric import padding
        w = self.with_nchl()
        note = {"merchantBillNo": "NA", "merchantId": "0010SVQNL9H", "merchantName": "Quantum Labs",
                "paymentRef": "2411100000067378ZHU", "channel": "CIPS", "payerMobile": "+977-9843705813",
                "sessionNo": "5446", "status": "SUCCESS"}
        msg = "NA,0010SVQNL9H,Quantum Labs,2411100000067378ZHU,CIPS,+977-9843705813,5446"
        self.assertEqual(nepal_pay_confirmation_string(note), msg)
        self.assertEqual(nepal_pay_confirmation_string({**note, "payerMobileNumber": "98", "sessionNo": None}),
                         "NA,0010SVQNL9H,Quantum Labs,2411100000067378ZHU,CIPS,98,")
        sig = base64.b64encode(self.key.sign(msg.encode(), padding.PKCS1v15(), hashes.SHA256())).decode()
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
        self.assertEqual((r["url"], r["subscribe"], r["send"], b["merchant_id"], b["request_id"], b["username"]),
                         ("wss://ws.example/nqrws", "/user/nqrws/check-txn-status", "/nqrws/check-txn-status",
                          "Terminal1", "2205260000001900KIY", "wsuser"))
        ct = base64.b64decode(b["api_token"])
        self.assertEqual(len(ct), 256)
        self.assertEqual(self.key.decrypt(ct, padding.PKCS1v15()), b"secret-api-token")
        self.assertNotEqual(w.web_socket_request("X")["body"]["api_token"], w.web_socket_request("X")["body"]["api_token"])
        self.assertEqual(NepalPay(**{**self.base, "terminal_label": None}, nchl_public_key_pem=self.spki, ws_url="u",
                                  ws_username="u", ws_api_token="t").web_socket_request("X")["body"]["merchant_id"], "0")
        with self.assertRaisesRegex(ValueError, "ws_url"):
            self.n.web_socket_request("X")
        with self.assertRaisesRegex(ValueError, "too long"):
            rsa_pkcs1_encrypt_b64(self.spki, "x" * 246)
        self.assertEqual(len(base64.b64decode(rsa_pkcs1_encrypt_b64(self.spki, "x" * 245))), 256)


class HamroPayTests(unittest.TestCase):
    cfg = dict(env="sandbox", merchant_id="PN_-Nd99TBnAlBjCgl8ef_b", client_id="client@123",
               client_api_key="merchant-api-key-test", client_secret="abcdefg", webhook_secret="whsec")
    h = HamroPay(**cfg)
    M = cfg["merchant_id"]

    @staticmethod
    def node(secret, msg):
        return base64.b64encode(hmac.new(secret.encode(), msg.encode(), hashlib.sha512).digest()).decode()

    def test_sign(self):
        self.assertEqual(hamro_pay_sign("abcdefg", ["T1", "1000", "M", "C", "K"]), self.node("abcdefg", "T1,1000,M,C,K"))
        with self.assertRaisesRegex(ValueError, "commas"):
            hamro_pay_sign("s", ["a,b"])

    def test_initiate(self):
        sid = "ca8f7b70-b9c9-11ee-8611-0a73743c8233"
        with mock.patch("nepal_payments.hamropay.http", return_value=resp({"sessionId": sid, "merchantId": self.M})) as h:
            r = self.h.initiate("P1", 8992, "T-shirt", "https://shop.example/ok", failure_url="https://shop.example/no")
        _, url, _, headers, body, *_ = h.call_args[0]
        self.assertEqual(url, "https://uat-payclient.hamropatro.com/v1/checkout/sessionId")
        self.assertEqual((headers["Client-Id"], headers["Client-API-Key"], headers["Connection"]),
                         ("client@123", "merchant-api-key-test", "close"))
        self.assertEqual(headers["Signature"], self.node("abcdefg", f"P1,8992,{self.M},client@123,merchant-api-key-test"))
        body = json.loads(json.dumps(body))
        self.assertEqual([body["merchantTxnId"], body["transactionAmount"], body["successRedirectionUrl"],
                          body["failedRedirectionUrl"], body["productList"][0]["price"]],
                         ["P1", "8992", "https://shop.example/ok", "https://shop.example/no", 89.92])
        self.assertEqual(r.kind, "form")
        self.assertEqual(r.action, "https://uat-checkout-pay.hamropatro.com/api/checkout")
        self.assertEqual(r.provider_ref, sid)
        self.assertEqual(r.fields["token"], self.node("abcdefg", f"{self.M},P1,{sid},8992,client@123,merchant-api-key-test"))
        self.assertEqual(list(r.fields), ["merchant_id", "session_id", "token", "merchant_transaction_id", "remarks"])

    def test_initiate_validation(self):
        with self.assertRaisesRegex(PaymentError, "Rs 10"):
            self.h.initiate("P1", 999, "x", "https://a/")
        with self.assertRaisesRegex(PaymentError, "Rs 10"):
            self.h.initiate("P1", 5_000_001, "x", "https://a/")
        with self.assertRaisesRegex(PaymentError, "1–25"):
            self.h.initiate("X" * 26, 1000, "x", "https://a/")
        with self.assertRaisesRegex(ValueError, "gateway_url"):
            HamroPay(**{**self.cfg, "env": "production"}).initiate("P1", 1000, "x", "https://a/")
        for r, code in [(resp({"sessionId": "S", "merchantId": "SOMEONE_ELSE"}), "merchant_mismatch"),
                        (resp({"code": 16, "message": "Unauthorized Request", "details": []}, 401), "unauthorized")]:
            with mock.patch("nepal_payments.hamropay.http", return_value=r):
                with self.assertRaises(PaymentError) as cm:
                    self.h.initiate("P1", 1000, "x", "https://a/")
            self.assertEqual(cm.exception.code, code)

    def test_verify(self):
        cases = [({"merchantTxnId": "P1", "status": "COMPLETED", "amount": 89.92, "trackingId": "TRK1"}, "paid", 8992),
                 ({"merchantTransactionId": "P1", "status": "PROCESSING", "amount": 0}, "pending", None),
                 ({"merchantTxnId": "P1", "status": "FAILED", "amount": 0}, "failed", None),
                 ({"merchantTransactionId": "P1", "trackingId": "", "status": "NOT_INITIATED", "amount": 0,
                   "message": "TRANSACTION NOT INITIATED YET"}, "not_found", None),
                 ({"merchantTxnId": "P1", "status": "SOMETHING_NEW"}, "unknown", None)]
        for body, want, amt in cases:
            with mock.patch("nepal_payments.hamropay.http", return_value=resp(body)) as h:
                v = self.h.verify("P1", 8992)
            self.assertEqual((v.status, v.amount_paisa), (want, amt))
            _, url, _, headers, sent, *_ = h.call_args[0]
            self.assertEqual(url, "https://uat-payclient.hamropatro.com/v1/checkout/transaction")
            self.assertEqual(headers["Signature"], self.node("abcdefg", f"P1,{self.M},client@123,merchant-api-key-test"))
            self.assertEqual(sent, {"merchantId": self.M, "merchantTxnId": "P1"})
        with mock.patch("nepal_payments.hamropay.http", return_value=resp({"merchantTxnId": "P2", "status": "COMPLETED", "amount": 89.92})):
            with self.assertRaises(PaymentError) as cm:
                self.h.verify("P1", 8992)
        self.assertEqual(cm.exception.code, "id_mismatch")
        self.assertEqual(HamroPay.order_id_from_callback({"MerchantTxnId": "P1"}), "P1")

    def test_webhook(self):
        body = {"merchantTxnId": "P1", "merchantId": self.M, "amount": 1200, "status": "COMPLETED", "metadata": {}}
        for a in ("1200", "1200.0", "1200.00"):
            self.assertTrue(self.h.verify_webhook(body, self.node("whsec", f"P1,{self.M},COMPLETED,{a}")))
            # json.loads gives a float for "1200.0": same renderings must still match
            self.assertTrue(self.h.verify_webhook({**body, "amount": 1200.0}, self.node("whsec", f"P1,{self.M},COMPLETED,{a}")))
        self.assertTrue(self.h.verify_webhook({**body, "amount": 1.5}, self.node("whsec", f"P1,{self.M},COMPLETED,1.50")))
        self.assertFalse(self.h.verify_webhook({**body, "amount": 1201}, self.node("whsec", f"P1,{self.M},COMPLETED,1200")))
        self.assertFalse(self.h.verify_webhook({**body, "amount": "1200"}, self.node("whsec", f"P1,{self.M},COMPLETED,1200")))
        self.assertFalse(self.h.verify_webhook(body, None))
        with self.assertRaisesRegex(ValueError, "webhook_secret"):
            HamroPay(**{**self.cfg, "webhook_secret": None}).verify_webhook(body, "x")


class GetPayTests(unittest.TestCase):
    cfg = dict(env="sandbox",
               pap_info=base64.b64encode(json.dumps({"institutionId": "122", "mid": "123123451770986", "tid": "12358762"}).encode()).decode(),
               opr_key="4fa4c6b9-3f91-43e5-9b4f-319f68187ba5", website_domain="https://shop.example",
               business_name="Shop", image_url="https://shop.example/logo.png")
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
        self.assertEqual(get_pay_decode_token(base64.b64encode(f"{self.tid}:{self.secret}".encode()).decode()), want)
        self.assertIsNone(get_pay_decode_token("%%%"))
        self.assertIsNone(get_pay_decode_token(b64json({"id": self.tid})))

    def test_initiate_and_pages(self):
        r = self.g.initiate("P1", 120050, "Cup <set>", "https://shop.example/ok/P1", failure_url="https://shop.example/no/P1")
        self.assertEqual(r.kind, "sdk")
        self.assertEqual(r.script_url, "https://minio-getpay.nchl.com.np/getpay-cdn/webcheckout/v5/bundle.js")
        o = r.options
        self.assertEqual((o["price"], o["clientRequestId"], o["baseUrl"], o["insKey"]), (1200.5, "P1", self.base, ""))
        self.assertEqual(o["callbackUrl"], {"successUrl": "https://shop.example/ok/P1", "failUrl": "https://shop.example/no/P1"})
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
            with mock.patch("nepal_payments.getpay.http", return_value=r) as h:
                return self.g.verify("P1", 120000, callback={"token": token or self.token}), h
        v, h = run(self.ok({"status": "SUCCESS", "amount": 1200.0, "currency": "NPR", "stan": "379832",
                            "crrn": "624503379832", "clientId": "P1", "remarks": "Success"}))
        self.assertEqual((v.status, v.amount_paisa, v.transaction_id), ("paid", 120000, self.tid))
        self.assertEqual(h.call_args[0][1], f"{self.base}/merchant-status")
        self.assertEqual(h.call_args[0][4], {"id": self.tid, "papInfo": self.cfg["pap_info"]})

        forged = b64json({"id": self.tid, "oprSecret": base64.b64encode(b"not the hash").decode()})
        for r, token, code in [(self.ok({"status": "SUCCESS", "amount": 1200.0, "clientId": "SOMEONE-ELSES-ORDER"}), None, "id_mismatch"),
                               (self.ok({}), forged, "bad_signature"),
                               (self.ok({}), "@@", "malformed_callback")]:
            with self.assertRaises(PaymentError) as cm:
                run(r, token)
            self.assertEqual(cm.exception.code, code)

        self.assertEqual(run(self.ok({"status": "FAILED", "amount": 1200.0, "clientId": "P1"}))[0].status, "failed")
        nf = resp({"status": -1, "message": f"Failed to fetch merchant information: Transaction not found for ID: {self.tid}"}, 400)
        self.assertEqual(run(nf)[0].status, "not_found")

    def test_verify_without_token(self):
        with mock.patch("nepal_payments.getpay.http", return_value=self.ok({
                "transactionId": self.tid, "clientRequestId": "P1", "saleTransactionAmount": 1200.0,
                "status": "SUCCESS", "paymentScheme": "MASTERCARD"})) as h:
            v = self.g.verify("P1", 120000)
        self.assertEqual((v.status, v.amount_paisa, v.transaction_id), ("unknown", 120000, self.tid))
        self.assertEqual(h.call_args[0][1], f"{self.base}/transaction-statement")
        self.assertEqual(h.call_args[0][4], {"clientRequestId": "P1"})
        cases = [(self.ok({"transactionId": self.tid, "clientRequestId": "P1", "saleTransactionAmount": 1200.0, "status": "FAILED"}), "failed"),
                 (resp({"status": -1, "message": "Failed to fetch transaction statement: Transaction not found for transaction ID: x"}, 400), "not_found")]
        for r, want in cases:
            with mock.patch("nepal_payments.getpay.http", return_value=r):
                self.assertEqual(self.g.verify("P1", 120000).status, want)
        with mock.patch("nepal_payments.getpay.http", return_value=resp("oops", 500)):
            with self.assertRaises(PaymentError):
                self.g.verify("P1", 120000)


class CyberSourceTests(unittest.TestCase):
    def test_vector(self):
        f = {"access_key": "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6", "profile_id": "PROFILE-0001", "transaction_uuid": "7f9c2b1e-5d1a-4c3b-9e8f-1a2b3c4d5e6f",
             "signed_field_names": "access_key,profile_id,transaction_uuid,signed_field_names,unsigned_field_names,signed_date_time,locale,transaction_type,reference_number,amount,currency",
             "unsigned_field_names": "", "signed_date_time": "2026-11-04T10:15:30Z", "locale": "en-us", "transaction_type": "sale",
             "reference_number": "ORDER-1001", "amount": "1500.00", "currency": "NPR"}
        self.assertEqual(cybersource_sign("test_secret_key_do_not_use", f), "QRwjaW8ysHR/UGyQ0LqSIHiGTvnNebKSwwsFRmn4Weg=")

    def test_verify(self):
        cs = CyberSource("sandbox", "P", "A", "S")
        p = {"req_reference_number": "ORD-1", "req_currency": "NPR", "req_transaction_type": "sale", "transaction_id": "7000",
             "decision": "ACCEPT", "reason_code": "100", "auth_amount": "1500.00"}
        p["signed_field_names"] = ",".join(list(p) + ["signed_field_names"])
        p["signature"] = cybersource_sign("S", p)
        v = cs.verify("ORD-1", 150000, callback=p)
        self.assertEqual((v.status, v.amount_paisa), ("paid", 150000))
        with self.assertRaises(PaymentError):
            cs.verify("ORD-1", 150000, callback={**p, "auth_amount": "1.00"})
        f = cs.initiate("ORD-1", 150000, "x", "https://r", bill_to={"forename": "Ram", "surname": "Sharma", "email": "r@e.com",
                                                                      "address_line1": "Thamel", "city": "Kathmandu", "country": "NP"}).fields
        self.assertEqual((f["amount"], f["unsigned_field_names"]), ("1500.00", ""))
        self.assertEqual(f["signature"], cybersource_sign("S", f))


class NpsTests(unittest.TestCase):
    def test_sign(self):
        exp = hmac.new(b"secret", b"1009TestMerchantT1", hashlib.sha512).hexdigest()
        self.assertEqual(nps_sign("secret", {"MerchantTxnId": "T1", "MerchantName": "TestMerchant", "Amount": "100", "MerchantId": "9"}), exp)

    def test_flow(self):
        n = Nps("sandbox", "9", "TestMerchant", "u", "p", "secret")
        with mock.patch("nepal_payments.nps.http", return_value=resp({"code": "0", "message": "", "errors": [], "data": {"ProcessId": "PROC_1"}})):
            f = n.initiate("T1", 10000, "x", "https://r")
        self.assertEqual((f.enctype, f.provider_ref, f.fields["Amount"]), ("multipart/form-data", "PROC_1", "100"))
        with mock.patch("nepal_payments.nps.http", return_value=resp({"code": "0", "errors": [], "data": {"Status": "Fail", "MerchantTxnId": "T1"}})):
            self.assertEqual(n.verify("T1", 10000).status, "failed")
        with mock.patch("nepal_payments.nps.http", return_value=resp({"code": "1", "errors": [{"error_code": "3", "error_message": "Transaction not initialized yet"}], "data": None})):
            self.assertEqual(n.verify("T1", 10000).status, "not_found")


class ImePayTests(unittest.TestCase):
    def test_flow(self):
        i = ImePay("sandbox", "MC", "u", "p", "MOD")
        with mock.patch("nepal_payments.imepay.http", return_value=resp({"TokenId": "TK1", "ResponseCode": 0})) as h:
            r = i.initiate("R1", 10000, "x", "https://s/ok", failure_url="https://s/no")
        self.assertEqual(h.call_args[0][3]["Module"], base64.b64encode(b"MOD").decode())
        import urllib.parse
        data = urllib.parse.parse_qs(urllib.parse.urlparse(r.url).query)["data"][0]
        self.assertEqual(base64.b64decode(data).decode(), "TK1|MC|R1|100.00|POST|https://s/ok|https://s/no")
        with mock.patch("nepal_payments.imepay.http", return_value=resp({"ResponseCode": 1, "RefId": "R1"})):
            self.assertEqual(i.verify("R1", 10000, "TK1").status, "pending")


if __name__ == "__main__":
    unittest.main()


class Regressions(unittest.TestCase):
    """TODO.md correctness list; mirrors the "regressions" block in scripts/ts/test/adapters.test.ts."""
    e = Esewa("sandbox", SANDBOX["product_code"], SANDBOX["secret_key"],
              SANDBOX["intent_product_code"], SANDBOX["intent_access_key"])

    def test_money_sign_and_strict_parse(self):
        self.assertEqual([paisa_to_rupees(p) for p in (-5, -99, -100, -12345)], ["-0.05", "-0.99", "-1", "-123.45"])
        for bad in ("1e3", "+5", "NaN", ""):
            with self.assertRaises(ValueError):
                rupees_to_paisa(bad)

    def test_basic_auth_utf8(self):
        from nepal_payments.core import basic_auth
        self.assertEqual(basic_auth("ü", "पासवर्ड"), "Basic " + base64.b64encode("ü:पासवर्ड".encode()).decode())

    def test_esewa_malformed_data_is_400(self):
        for data in ("!!!!", base64.b64encode(b"not json").decode(), base64.b64encode(b"{").decode(),
                     base64.b64encode(b"\xff\xfe").decode()):
            with self.assertRaises(PaymentError) as cm:
                self.e.verify("X", 1000, callback={"data": data})
            self.assertEqual((cm.exception.code, cm.exception.http_status), ("malformed_callback", 400))

    def test_esewa_error_bodies(self):
        cases = [(resp({"code": 0, "errorMessage": "Service is currently unavailable"}, 503), "esewa_0"),
                 (resp("<html>bad gateway</html>", 502), "http_502")]
        for r, code in cases:
            with mock.patch("nepal_payments.esewa.http", return_value=r):
                with self.assertRaises(PaymentError) as cm:
                    self.e.verify("X", 1000)
            self.assertEqual(cm.exception.code, code)
            if code == "esewa_0":
                self.assertIn("Service is currently unavailable", str(cm.exception))
        with mock.patch("nepal_payments.esewa.http", return_value=resp({"code": "IP-400", "error_message": "Invalid Signature"}, 400)):
            with self.assertRaises(PaymentError) as cm:
                self.e.intent_book("X", 10000, "https://c", "https://r")
        self.assertEqual(cm.exception.code, "esewa_IP-400")
        self.assertIn("Invalid Signature", str(cm.exception))

    def test_esewa_order_id_from_callback_key_order(self):
        self.assertEqual(Esewa.order_id_from_callback({"orderId": "A", "order_id": "B"}), "A")

    def test_intent_callback_formats(self):
        key = SANDBOX["intent_access_key"]
        order = ["product_code", "amount", "reference_code", "status"]
        names = ",".join(order)
        base = {"product_code": "INTENT", "reference_code": "R1", "status": "SUCCESS"}
        sig_exact = esewa_sign(key, {**base, "amount": "100.0"}, order)
        raw = ('{"product_code":"INTENT","amount":100.0,"reference_code":"R1","status":"SUCCESS",'
               f'"signed_field_names":"{names}","signature":"{sig_exact}"}}')
        self.assertTrue(self.e.intent_callback_valid(raw))
        self.assertTrue(self.e.intent_callback_valid(raw.encode()))
        self.assertFalse(self.e.intent_callback_valid(json.loads(raw)))  # parsed: 100.0 signs as "100"
        sig_js = esewa_sign(key, {**base, "amount": "100"}, order)
        raw2 = raw.replace(sig_exact, sig_js)
        self.assertTrue(self.e.intent_callback_valid(raw2))
        self.assertTrue(self.e.intent_callback_valid(json.loads(raw2)))
        sig_null = esewa_sign(key, {**base, "amount": ""}, order)
        self.assertTrue(self.e.intent_callback_valid({**base, "amount": None, "signed_field_names": names, "signature": sig_null}))
        self.assertFalse(self.e.intent_callback_valid(raw.replace("100.0", "1.0")))
        self.assertFalse(self.e.intent_callback_valid("not json"))
        self.assertFalse(self.e.intent_callback_valid("[1]"))

    def test_nps_null_data_is_unknown(self):
        n = Nps("sandbox", "9", "M", "u", "p", "s")
        with mock.patch("nepal_payments.nps.http", return_value=resp({"code": "0", "message": "", "errors": [], "data": None})):
            v = n.verify("T1", 10000)
        self.assertEqual((v.status, v.amount_paisa), ("unknown", None))

    def test_cybersource_empty_reference_number_falls_back(self):
        cs = CyberSource("sandbox", "p", "a", "s")
        p = {"decision": "ACCEPT", "reason_code": "100", "req_reference_number": "", "req_transaction_uuid": "T1",
             "req_amount": "10.00", "req_currency": "NPR", "transaction_id": "X1"}
        p["signed_field_names"] = ",".join([*p, "signed_field_names"])
        p["signature"] = cybersource_sign("s", p)
        self.assertEqual(cs.verify("T1", 1000, callback=p).status, "paid")


class TruncatedBody(unittest.TestCase):
    """Hamro Pay's Envoy front aborts the chunked stream after an error answer: no terminating 0-length chunk."""

    @staticmethod
    def serve(chunk: bytes, status: str = "401 Unauthorized"):
        import re
        import socket
        import threading
        srv = socket.socket()
        srv.bind(("127.0.0.1", 0))
        srv.listen(8)

        def loop():
            while True:
                try:
                    conn, _ = srv.accept()
                except OSError:
                    return
                with conn:
                    buf = b""
                    while b"\r\n\r\n" not in buf:
                        part = conn.recv(65536)
                        if not part:
                            break
                        buf += part
                    head, _, rest = buf.partition(b"\r\n\r\n")
                    m = re.search(rb"(?i)content-length:\s*(\d+)", head)
                    need = int(m.group(1)) if m else 0
                    while len(rest) < need:
                        part = conn.recv(65536)
                        if not part:
                            break
                        rest += part
                    conn.sendall(f"HTTP/1.1 {status}\r\nContent-Type: application/json\r\nTrailer: Grpc-Status\r\n"
                                 f"Transfer-Encoding: chunked\r\n\r\n{len(chunk):x}\r\n".encode() + chunk + b"\r\n")

        threading.Thread(target=loop, daemon=True).start()
        return srv, f"http://127.0.0.1:{srv.getsockname()[1]}"

    def hamro(self, base):
        return HamroPay("sandbox", "m", "c", "k", "s", api_base_url=base, timeout=5)

    def test_complete_json_is_kept(self):
        srv, base = self.serve(b'{"code":16,"message":"Unauthorized Request","details":[]}')
        try:
            with self.assertRaises(PaymentError) as cm:
                self.hamro(base).verify("O1", 1000)
        finally:
            srv.close()
        self.assertEqual((cm.exception.code, cm.exception.http_status), ("unauthorized", 401))
        self.assertEqual(cm.exception.details["message"], "Unauthorized Request")

    def test_truncated_invalid_json_is_network_error(self):
        srv, base = self.serve(b'{"code":16,"message":"Unauth')
        try:
            with mock.patch("nepal_payments.core.time.sleep"), self.assertRaises(PaymentError) as cm:
                self.hamro(base).verify("O1", 1000)
        finally:
            srv.close()
        self.assertEqual(cm.exception.code, "network_error")

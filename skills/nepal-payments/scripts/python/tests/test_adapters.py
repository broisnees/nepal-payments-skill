"""Offline tests: published vectors + mocked HTTP. Run from scripts/python: python -m unittest -v"""

import base64
import hashlib
import hmac
import json
import unittest
from datetime import datetime, timezone
from unittest import mock

from nepal_payments import (ConnectIps, CyberSource, Esewa, Fonepay, ImePay, Khalti, Nps, PaymentError,
                            decide_transition, new_order_id, paisa_to_rupees, render_auto_submit_form, rupees_to_paisa)
from nepal_payments.core import FormResult, HttpResponse, b64decode_lenient
from nepal_payments.connectips import connectips_token_string
from nepal_payments.cybersource import cybersource_sign
from nepal_payments.esewa import SANDBOX, esewa_sign
from nepal_payments.fonepay import fonepay_date, fonepay_hmac
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

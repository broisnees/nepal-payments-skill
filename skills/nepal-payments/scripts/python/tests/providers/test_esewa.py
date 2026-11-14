import base64
import json
import unittest
from unittest import mock

from helpers import b64json, resp
from nepal_payments.core import PaymentError
from nepal_payments.providers.esewa import SANDBOX, Esewa, esewa_sign

HTTP = "nepal_payments.providers.esewa.adapter.http"


def sandbox_esewa() -> Esewa:
    return Esewa(
        "sandbox",
        SANDBOX["product_code"],
        SANDBOX["secret_key"],
        SANDBOX["intent_product_code"],
        SANDBOX["intent_access_key"],
    )


class EsewaTests(unittest.TestCase):
    e = sandbox_esewa()
    order = ["total_amount", "transaction_uuid", "product_code"]

    def test_vectors(self):
        k = SANDBOX["secret_key"]
        fields = {
            "total_amount": "100",
            "transaction_uuid": "11-201-13",
            "product_code": "EPAYTEST",
        }
        self.assertEqual(
            esewa_sign(k, fields, self.order), "5DZywcrTKD0gia/rsSMcrRHmJl+4Tbol6S+lWgdJ94E="
        )
        fields = {
            "total_amount": "110",
            "transaction_uuid": "ab14a8f2b02c3",
            "product_code": "EPAYTEST",
        }
        self.assertEqual(
            esewa_sign(k, fields, self.order), "0Gh9pc1fiZDZH7OKOBdn42QMx8drH7tOeMPdRQhI83g="
        )
        intent = {"product_code": "INTENT", "amount": "100", "transaction_uuid": "txn-20251220-001"}
        self.assertEqual(
            esewa_sign(
                SANDBOX["intent_access_key"], intent, ["product_code", "amount", "transaction_uuid"]
            ),
            "oVRo2ZkjNpbt5vKs7RSNx1OCcewDaVssoguWsG31HMA=",
        )

    def test_initiate(self):
        f = self.e.initiate("ORD-1", 11050, "x", "https://s/r/ORD-1", tax_paisa=1000)
        self.assertEqual((f.fields["total_amount"], f.fields["amount"]), ("110.50", "100.50"))
        with self.assertRaises(PaymentError):
            self.e.initiate("ORD-1", 1000, "x", "https://s", tax_paisa=1000)
        self.assertEqual(
            f.fields["signature"], esewa_sign(SANDBOX["secret_key"], f.fields, self.order)
        )
        with self.assertRaises(PaymentError):
            self.e.initiate("a_b", 100, "x", "https://s")

    def _payload(self, **o):
        p = {
            "transaction_code": "000AWEO",
            "status": "COMPLETE",
            "total_amount": "1000.0",
            "transaction_uuid": "ORD-2",
            "product_code": "EPAYTEST",
            "signed_field_names": (
                "transaction_code,status,total_amount,transaction_uuid,product_code,signed_field_names"
            ),
            **o,
        }
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
        status = {
            "product_code": "EPAYTEST",
            "transaction_uuid": "ORD-2",
            "total_amount": 1000.0,
            "status": "COMPLETE",
            "ref_id": "R1",
        }
        with mock.patch(HTTP, return_value=resp(status)) as h:
            v = self.e.verify("ORD-2", 100000, callback={"data": b64json(self._payload())})
        self.assertEqual((v.status, v.amount_paisa, v.transaction_id), ("paid", 100000, "R1"))
        self.assertIn("total_amount=1000&transaction_uuid=ORD-2", h.call_args[0][1])
        with self.assertRaises(PaymentError):
            other = b64json(self._payload(transaction_uuid="OTHER"))
            self.e.verify("ORD-2", 100000, callback={"data": other})

    def test_intent_book_signs_amount(self):
        booked = {
            "code": "IP-201",
            "data": {
                "booking_id": "VkQ=",
                "deeplink": "https://rc-links.esewa.com.np/pay/VkQ=",
                "correlation_id": "C1",
            },
        }
        with mock.patch(HTTP, return_value=resp(booked)) as h:
            b = self.e.intent_book("txn-20251220-001", 10000, "https://cb", "https://done")
        body = h.call_args.kwargs["body"]
        self.assertEqual(body["signature"], "oVRo2ZkjNpbt5vKs7RSNx1OCcewDaVssoguWsG31HMA=")
        self.assertEqual(body["amount"], 100)
        self.assertEqual(b["provider_ref"], "VkQ=|C1")


class EsewaRegressions(unittest.TestCase):
    """TODO.md correctness list; mirrors the "regressions" block of the TypeScript tests."""

    e = sandbox_esewa()

    def test_esewa_malformed_data_is_400(self):
        for data in (
            "!!!!",
            base64.b64encode(b"not json").decode(),
            base64.b64encode(b"{").decode(),
            base64.b64encode(b"\xff\xfe").decode(),
        ):
            with self.assertRaises(PaymentError) as cm:
                self.e.verify("X", 1000, callback={"data": data})
            self.assertEqual(
                (cm.exception.code, cm.exception.http_status), ("malformed_callback", 400)
            )

    def test_esewa_error_bodies(self):
        cases = [
            (resp({"code": 0, "errorMessage": "Service is currently unavailable"}, 503), "esewa_0"),
            (resp("<html>bad gateway</html>", 502), "http_502"),
        ]
        for r, code in cases:
            with mock.patch(HTTP, return_value=r):
                with self.assertRaises(PaymentError) as cm:
                    self.e.verify("X", 1000)
            self.assertEqual(cm.exception.code, code)
            if code == "esewa_0":
                self.assertIn("Service is currently unavailable", str(cm.exception))
        invalid = resp({"code": "IP-400", "error_message": "Invalid Signature"}, 400)
        with mock.patch(HTTP, return_value=invalid):
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
        raw = (
            '{"product_code":"INTENT","amount":100.0,"reference_code":"R1","status":"SUCCESS",'
            f'"signed_field_names":"{names}","signature":"{sig_exact}"}}'
        )
        self.assertTrue(self.e.intent_callback_valid(raw))
        self.assertTrue(self.e.intent_callback_valid(raw.encode()))
        self.assertFalse(
            self.e.intent_callback_valid(json.loads(raw))
        )  # parsed: 100.0 signs as "100"
        sig_js = esewa_sign(key, {**base, "amount": "100"}, order)
        raw2 = raw.replace(sig_exact, sig_js)
        self.assertTrue(self.e.intent_callback_valid(raw2))
        self.assertTrue(self.e.intent_callback_valid(json.loads(raw2)))
        sig_null = esewa_sign(key, {**base, "amount": ""}, order)
        null_amount = {**base, "amount": None, "signed_field_names": names, "signature": sig_null}
        self.assertTrue(self.e.intent_callback_valid(null_amount))
        self.assertFalse(self.e.intent_callback_valid(raw.replace("100.0", "1.0")))
        self.assertFalse(self.e.intent_callback_valid("not json"))
        self.assertFalse(self.e.intent_callback_valid("[1]"))


if __name__ == "__main__":
    unittest.main()

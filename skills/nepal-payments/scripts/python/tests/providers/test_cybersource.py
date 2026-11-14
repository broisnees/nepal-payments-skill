import unittest

from nepal_payments.core import PaymentError
from nepal_payments.providers.cybersource import CyberSource, cybersource_sign


class CyberSourceTests(unittest.TestCase):
    def test_vector(self):
        f = {
            "access_key": "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6",
            "profile_id": "PROFILE-0001",
            "transaction_uuid": "7f9c2b1e-5d1a-4c3b-9e8f-1a2b3c4d5e6f",
            "signed_field_names": (
                "access_key,profile_id,transaction_uuid,signed_field_names,unsigned_field_names,"
                "signed_date_time,locale,transaction_type,reference_number,amount,currency"
            ),
            "unsigned_field_names": "",
            "signed_date_time": "2026-11-04T10:15:30Z",
            "locale": "en-us",
            "transaction_type": "sale",
            "reference_number": "ORDER-1001",
            "amount": "1500.00",
            "currency": "NPR",
        }
        self.assertEqual(
            cybersource_sign("test_secret_key_do_not_use", f),
            "QRwjaW8ysHR/UGyQ0LqSIHiGTvnNebKSwwsFRmn4Weg=",
        )

    def test_verify(self):
        cs = CyberSource("sandbox", "P", "A", "S")
        p = {
            "req_reference_number": "ORD-1",
            "req_currency": "NPR",
            "req_transaction_type": "sale",
            "transaction_id": "7000",
            "decision": "ACCEPT",
            "reason_code": "100",
            "auth_amount": "1500.00",
        }
        p["signed_field_names"] = ",".join([*list(p), "signed_field_names"])
        p["signature"] = cybersource_sign("S", p)
        v = cs.verify("ORD-1", 150000, callback=p)
        self.assertEqual((v.status, v.amount_paisa), ("paid", 150000))
        with self.assertRaises(PaymentError):
            cs.verify("ORD-1", 150000, callback={**p, "auth_amount": "1.00"})
        bill_to = {
            "forename": "Ram",
            "surname": "Sharma",
            "email": "r@e.com",
            "address_line1": "Thamel",
            "city": "Kathmandu",
            "country": "NP",
        }
        f = cs.initiate("ORD-1", 150000, "x", "https://r", bill_to=bill_to).fields
        self.assertEqual((f["amount"], f["unsigned_field_names"]), ("1500.00", ""))
        self.assertEqual(f["signature"], cybersource_sign("S", f))


class CyberSourceRegressions(unittest.TestCase):
    """TODO.md correctness list; mirrors the "regressions" block of the TypeScript tests."""

    def test_cybersource_empty_reference_number_falls_back(self):
        cs = CyberSource("sandbox", "p", "a", "s")
        p = {
            "decision": "ACCEPT",
            "reason_code": "100",
            "req_reference_number": "",
            "req_transaction_uuid": "T1",
            "req_amount": "10.00",
            "req_currency": "NPR",
            "transaction_id": "X1",
        }
        p["signed_field_names"] = ",".join([*p, "signed_field_names"])
        p["signature"] = cybersource_sign("s", p)
        self.assertEqual(cs.verify("T1", 1000, callback=p).status, "paid")


if __name__ == "__main__":
    unittest.main()

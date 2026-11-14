import unittest

from nepal_payments import paisa_to_rupees, rupees_to_paisa


class MoneyTests(unittest.TestCase):
    def test_money(self):
        self.assertEqual(paisa_to_rupees(10000), "100")
        self.assertEqual(paisa_to_rupees(10050), "100.50")
        self.assertEqual(rupees_to_paisa("1,000.0"), 100000)
        self.assertEqual(rupees_to_paisa(100.1), 10010)
        self.assertEqual(rupees_to_paisa("19.995"), 2000)
        self.assertEqual(rupees_to_paisa(1.005), 101)

    def test_money_sign_and_strict_parse(self):
        self.assertEqual(
            [paisa_to_rupees(p) for p in (-5, -99, -100, -12345)],
            ["-0.05", "-0.99", "-1", "-123.45"],
        )
        for bad in ("1e3", "+5", "NaN", ""):
            with self.assertRaises(ValueError):
                rupees_to_paisa(bad)


if __name__ == "__main__":
    unittest.main()

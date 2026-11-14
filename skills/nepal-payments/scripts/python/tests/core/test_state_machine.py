import unittest

from nepal_payments import decide_transition


class DecideTransitionTests(unittest.TestCase):
    def test_decide_transition(self):
        H = 3600
        self.assertEqual(decide_transition("initiated", "paid", 1000, 1000, 0).next, "paid")
        d = decide_transition("pending", "paid", 10, 1000, 0)
        self.assertEqual((d.next, d.review_required), ("unknown", True))
        self.assertTrue(decide_transition("pending", "paid", None, 1000, 0).review_required)
        self.assertIsNone(decide_transition("initiated", "not_found", None, 1000, 300).next)
        self.assertEqual(
            decide_transition("initiated", "not_found", None, 1000, 2 * H).next, "expired"
        )
        late = decide_transition("expired", "paid", 1000, 1000, 3 * H)
        self.assertEqual((late.next, late.late_paid), ("paid", True))
        self.assertIsNone(decide_transition("paid", "failed", None, 1000, 0).next)
        self.assertIsNone(decide_transition("pending", "pending", None, 1000, 0).next)


if __name__ == "__main__":
    unittest.main()

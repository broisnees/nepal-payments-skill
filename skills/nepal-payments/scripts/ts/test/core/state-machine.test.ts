/** decideTransition: the payment-attempt state machine. */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { decideTransition } from "../../src/index.ts";

describe("state machine", () => {
  test("decideTransition: the state machine", () => {
    const H = 60 * 60_000;
    const paid = { status: "paid" as const, amountPaisa: 1000 };
    assert.equal(decideTransition("initiated", paid, 1000, 0).next, "paid");
    // amount guard: mismatch and missing amount both go to review, never paid
    assert.deepEqual(decideTransition("pending", { status: "paid", amountPaisa: 10 }, 1000, 0), {
      next: "unknown",
      reviewRequired: true,
      latePaid: false,
      reason: "amount mismatch: stored 1000, provider 10",
    });
    assert.equal(
      decideTransition("pending", { status: "paid", amountPaisa: null }, 1000, 0).reviewRequired,
      true,
    );
    // not_found keeps the attempt open inside the window, expires after
    assert.equal(
      decideTransition("initiated", { status: "not_found", amountPaisa: null }, 1000, 5 * 60_000)
        .next,
      null,
    );
    assert.equal(
      decideTransition("initiated", { status: "not_found", amountPaisa: null }, 1000, 2 * H).next,
      "expired",
    );
    // late payment after we closed it is recovered, not dropped
    const late = decideTransition("expired", paid, 1000, 3 * H);
    assert.equal(late.next, "paid");
    assert.equal(late.latePaid, true);
    // paid is terminal for automation; same status is a no-op
    assert.equal(
      decideTransition("paid", { status: "failed", amountPaisa: null }, 1000, 0).next,
      null,
    );
    assert.equal(
      decideTransition("pending", { status: "pending", amountPaisa: null }, 1000, 0).next,
      null,
    );
    assert.equal(
      decideTransition("failed", { status: "canceled", amountPaisa: null }, 1000, 0).next,
      null,
    );
  });
});

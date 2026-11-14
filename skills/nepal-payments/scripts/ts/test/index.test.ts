/** Public entry point: createPayments, paymentsConfigFromEnv, newOrderId. */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createPayments, ESEWA_SANDBOX, newOrderId } from "../src/index.ts";

describe("index", () => {
  test("newOrderId fits every provider", () => {
    for (let i = 0; i < 1000; i++) assert.match(newOrderId(), /^[A-Z0-9]{17,20}$/);
  });

  test("newOrderId uses only the 36-symbol alphabet", () => {
    for (let i = 0; i < 200; i++) assert.match(newOrderId(), /^P[0-9A-Z]{18,19}$/);
  });

  test("provider lookup ignores Object.prototype keys", () => {
    const payments = createPayments({ esewa: { env: "sandbox", ...ESEWA_SANDBOX } });
    for (const id of ["constructor", "__proto__", "toString"])
      assert.throws(() => payments.adapter(id), /not configured/);
    assert.equal(payments.adapter("esewa").id, "esewa");
  });
});

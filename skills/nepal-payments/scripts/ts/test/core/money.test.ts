/** Money: integer paisa <-> rupee strings, exactly. */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { paisaToRupees, rupeesToPaisa } from "../../src/index.ts";

describe("money", () => {
  test("money conversions are exact", () => {
    assert.equal(paisaToRupees(10000), "100");
    assert.equal(paisaToRupees(10050), "100.50");
    assert.equal(paisaToRupees(5), "0.05");
    assert.equal(rupeesToPaisa("1,000.0"), 100000);
    assert.equal(rupeesToPaisa(100.1), 10010);
    assert.equal(rupeesToPaisa("0.1"), 10);
    assert.equal(rupeesToPaisa("19.995"), 2000);
    // same as Python Decimal(str(x)); toFixed(2) would give 100
    assert.equal(rupeesToPaisa(1.005), 101);
  });

  test("paisaToRupees keeps the sign below one rupee", () => {
    assert.equal(paisaToRupees(-5), "-0.05");
    assert.equal(paisaToRupees(-99), "-0.99");
    assert.equal(paisaToRupees(-100), "-1");
    assert.equal(paisaToRupees(-12345), "-123.45");
  });

  test("rupeesToPaisa rejects exponent and explicit plus forms", () => {
    for (const bad of ["1e3", "+5", "NaN", ""])
      assert.throws(() => rupeesToPaisa(bad), /not a rupee amount/);
  });
});

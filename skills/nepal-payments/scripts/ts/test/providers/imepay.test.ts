/** IME Pay: GetToken + checkout payload, Recheck mapping. */
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { imepay } from "../../src/index.ts";
import { calls, header, mockFetch, restoreFetch } from "../helpers.ts";

afterEach(restoreFetch);

describe("imepay", () => {
  const i = imepay({
    env: "sandbox",
    merchantCode: "MC",
    username: "u",
    password: "p",
    module: "MOD",
  });

  test("GetToken + checkout payload format (official plugin)", async () => {
    mockFetch(() => ({ body: { TokenId: "TK1", ResponseCode: 0 } }));
    const r = await i.initiate({
      orderId: "R1",
      amountPaisa: 10000,
      description: "x",
      returnUrl: "https://s/ok",
      failureUrl: "https://s/no",
    });
    assert.equal(calls[0].url, "https://stg.imepay.com.np:7979/api/Web/GetToken");
    assert.equal(header(calls[0], "Module"), btoa("MOD"));
    assert.deepEqual(JSON.parse(String(calls[0].init.body)), {
      MerchantCode: "MC",
      Amount: "100.00",
      RefId: "R1",
    });
    if (r.kind !== "redirect") return assert.fail();
    const data = new URL(r.url).searchParams.get("data")!;
    assert.equal(atob(data), "TK1|MC|R1|100.00|POST|https://s/ok|https://s/no");
  });

  test("Recheck: 0 = paid; anything else stays pending (sources disagree)", async () => {
    mockFetch(() => ({
      body: { ResponseCode: 0, RefId: "R1", TranAmount: "100.00", TransactionId: "X9" },
    }));
    assert.equal(
      (await i.verify({ orderId: "R1", amountPaisa: 10000, providerRef: "TK1" })).status,
      "paid",
    );
    mockFetch(() => ({ body: { ResponseCode: 1, RefId: "R1" } }));
    assert.equal(
      (await i.verify({ orderId: "R1", amountPaisa: 10000, providerRef: "TK1" })).status,
      "pending",
    );
    mockFetch(() => ({ body: { ResponseCode: 0, RefId: "R1", TranAmount: "" } }));
    assert.equal(
      (await i.verify({ orderId: "R1", amountPaisa: 10000, providerRef: "TK1" })).amountPaisa,
      null,
    ); // -> review, no throw
  });
});

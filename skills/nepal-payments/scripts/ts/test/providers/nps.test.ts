/** NPS: sorted-keys HMAC-SHA512, GetProcessId + multipart form, CheckTransactionStatus. */
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { nps, npsSign } from "../../src/index.ts";
import { calls, mockFetch, restoreFetch } from "../helpers.ts";

afterEach(restoreFetch);

describe("nps", () => {
  test("signature = HMAC-SHA512 hex of values of alphabetically sorted keys, no separator", async () => {
    const p = { MerchantTxnId: "T1", MerchantName: "TestMerchant", Amount: "100", MerchantId: "9" };
    const expected = createHmac("sha512", "secret")
      .update("100" + "9" + "TestMerchant" + "T1")
      .digest("hex");
    assert.equal(await npsSign("secret", p), expected);
    assert.equal(
      await npsSign("secret", { MerchantId: "9", MerchantName: "TestMerchant" }),
      createHmac("sha512", "secret").update("9TestMerchant").digest("hex"),
    );
  });

  const n = nps({
    env: "sandbox",
    merchantId: "9",
    merchantName: "TestMerchant",
    apiUsername: "u",
    apiPassword: "p",
    secretKey: "secret",
  });

  test("initiate: GetProcessId then multipart form with matching Amount/MerchantTxnId", async () => {
    mockFetch(() => ({
      body: { code: "0", message: "Success", errors: [], data: { ProcessId: "PROC_1" } },
    }));
    const r = await n.initiate({
      orderId: "T1",
      amountPaisa: 10000,
      description: "x",
      returnUrl: "https://r",
    });
    assert.equal(calls[0].url, "https://apisandbox.nepalpayment.com/GetProcessId");
    const sent = JSON.parse(String(calls[0].init.body));
    assert.equal(
      sent.Signature,
      await npsSign("secret", {
        MerchantId: "9",
        MerchantName: "TestMerchant",
        Amount: "100",
        MerchantTxnId: "T1",
      }),
    );
    if (r.kind !== "form") return assert.fail();
    assert.equal(r.enctype, "multipart/form-data");
    assert.equal(r.fields.Amount, "100");
    assert.equal(r.fields.ProcessId, "PROC_1");
    assert.equal(r.action, "https://gatewaysandbox.nepalpayment.com/Payment/Index");
  });

  test("status: code 0 + Fail is a failed payment; error_code 3 is not_found", async () => {
    mockFetch(() => ({
      body: {
        code: "0",
        message: "",
        errors: [],
        data: { Status: "Fail", Amount: "100", MerchantTxnId: "T1" },
      },
    }));
    assert.equal((await n.verify({ orderId: "T1", amountPaisa: 10000 })).status, "failed");
    mockFetch(() => ({
      body: {
        code: "0",
        message: "",
        errors: [],
        data: {
          Status: "Success",
          Amount: "100.00",
          MerchantTxnId: "T1",
          GatewayReferenceNo: "G1",
        },
      },
    }));
    const v = await n.verify({ orderId: "T1", amountPaisa: 10000 });
    assert.equal(v.status, "paid");
    assert.equal(v.amountPaisa, 10000);
    mockFetch(() => ({
      body: {
        code: "1",
        message: "",
        errors: [{ error_code: "3", error_message: "Transaction not initialized yet" }],
        data: null,
      },
    }));
    assert.equal((await n.verify({ orderId: "T1", amountPaisa: 10000 })).status, "not_found");
  });

  test("NPS: code 0 with null data is unknown, not a TypeError", async () => {
    const n = nps({
      env: "sandbox",
      merchantId: "9",
      merchantName: "M",
      apiUsername: "u",
      apiPassword: "p",
      secretKey: "s",
    });
    mockFetch(() => ({ body: { code: "0", message: "", errors: [], data: null } }));
    const v = await n.verify({ orderId: "T1", amountPaisa: 10000 });
    assert.equal(v.status, "unknown");
    assert.equal(v.amountPaisa, null);
  });
});

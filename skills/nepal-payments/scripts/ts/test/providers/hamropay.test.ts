/** Hamro Pay: HMAC-SHA512 signatures, Create Session + gateway form, Get Transaction, webhooks. */
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { hamropay, hamroPaySign, PaymentError } from "../../src/index.ts";
import { calls, header, mockFetch, restoreFetch } from "../helpers.ts";

afterEach(restoreFetch);

describe("hamropay", () => {
  const cfg = {
    env: "sandbox" as const,
    merchantId: "PN_-Nd99TBnAlBjCgl8ef_b",
    clientId: "client@123",
    clientApiKey: "merchant-api-key-test",
    clientSecret: "abcdefg",
    webhookSecret: "whsec",
  };
  const h = hamropay(cfg);
  const node = (secret: string, msg: string) =>
    createHmac("sha512", secret).update(msg, "utf8").digest("base64");

  test("signature: base64 HMAC-SHA512 over comma-joined values; commas refused", async () => {
    assert.equal(
      await hamroPaySign("abcdefg", ["T1", "1000", "M", "C", "K"]),
      node("abcdefg", "T1,1000,M,C,K"),
    );
    await assert.rejects(hamroPaySign("s", ["a,b"]), /commas/);
  });

  test("initiate: Create Session signed in headers, then a signed gateway form", async () => {
    mockFetch(() => ({
      body: { sessionId: "ca8f7b70-b9c9-11ee-8611-0a73743c8233", merchantId: cfg.merchantId },
    }));
    const r = await h.initiate({
      orderId: "P1",
      amountPaisa: 8992,
      description: "T-shirt",
      returnUrl: "https://shop.example/ok",
      failureUrl: "https://shop.example/no",
    });
    assert.equal(calls[0].url, "https://uat-payclient.hamropatro.com/v1/checkout/sessionId");
    assert.equal(header(calls[0], "Client-Id"), "client@123");
    assert.equal(header(calls[0], "Client-API-Key"), "merchant-api-key-test");
    assert.equal(header(calls[0], "Connection"), "close");
    assert.equal(
      header(calls[0], "Signature"),
      node("abcdefg", `P1,8992,${cfg.merchantId},client@123,merchant-api-key-test`),
    );
    const body = JSON.parse(String(calls[0].init.body));
    assert.deepEqual(
      [
        body.merchantTxnId,
        body.transactionAmount,
        body.successRedirectionUrl,
        body.failedRedirectionUrl,
        body.productList[0].price,
      ],
      ["P1", "8992", "https://shop.example/ok", "https://shop.example/no", 89.92],
    );
    assert.equal(r.kind, "form");
    if (r.kind !== "form") return;
    assert.equal(r.action, "https://uat-checkout-pay.hamropatro.com/api/checkout");
    assert.equal(r.providerRef, "ca8f7b70-b9c9-11ee-8611-0a73743c8233");
    assert.equal(
      r.fields.token,
      node(
        "abcdefg",
        `${cfg.merchantId},P1,ca8f7b70-b9c9-11ee-8611-0a73743c8233,8992,client@123,merchant-api-key-test`,
      ),
    );
    assert.deepEqual(Object.keys(r.fields), [
      "merchant_id",
      "session_id",
      "token",
      "merchant_transaction_id",
      "remarks",
    ]);
  });

  test("initiate: Rs 10..50,000, 25-char id, live gateway required, merchant echo checked", async () => {
    await assert.rejects(
      h.initiate({ orderId: "P1", amountPaisa: 999, description: "x", returnUrl: "https://a/" }),
      /Rs 10/,
    );
    await assert.rejects(
      h.initiate({
        orderId: "P1",
        amountPaisa: 5_000_001,
        description: "x",
        returnUrl: "https://a/",
      }),
      /Rs 10/,
    );
    await assert.rejects(
      h.initiate({
        orderId: "X".repeat(26),
        amountPaisa: 1000,
        description: "x",
        returnUrl: "https://a/",
      }),
      /1–25/,
    );
    await assert.rejects(
      hamropay({ ...cfg, env: "production" }).initiate({
        orderId: "P1",
        amountPaisa: 1000,
        description: "x",
        returnUrl: "https://a/",
      }),
      /gatewayUrl/,
    );
    mockFetch(() => ({ body: { sessionId: "S", merchantId: "SOMEONE_ELSE" } }));
    await assert.rejects(
      h.initiate({ orderId: "P1", amountPaisa: 1000, description: "x", returnUrl: "https://a/" }),
      (e: PaymentError) => e.code === "merchant_mismatch",
    );
    mockFetch(() => ({
      status: 401,
      body: { code: 16, message: "Unauthorized Request", details: [] },
    }));
    await assert.rejects(
      h.initiate({ orderId: "P1", amountPaisa: 1000, description: "x", returnUrl: "https://a/" }),
      (e: PaymentError) => e.code === "unauthorized",
    );
  });

  test("verify: Get Transaction signed, status mapping, rupees to paisa, id echo checked", async () => {
    const cases: [Record<string, unknown>, string, number | null][] = [
      [
        { merchantTxnId: "P1", status: "COMPLETED", amount: 89.92, trackingId: "TRK1" },
        "paid",
        8992,
      ],
      [{ merchantTransactionId: "P1", status: "PROCESSING", amount: 0 }, "pending", null],
      [{ merchantTxnId: "P1", status: "FAILED", amount: 0 }, "failed", null],
      [
        {
          merchantTransactionId: "P1",
          trackingId: "",
          status: "NOT_INITIATED",
          amount: 0,
          message: "TRANSACTION NOT INITIATED YET",
        },
        "not_found",
        null,
      ],
      [{ merchantTxnId: "P1", status: "SOMETHING_NEW" }, "unknown", null],
    ];
    for (const [body, want, amt] of cases) {
      mockFetch(() => ({ body }));
      const v = await h.verify({ orderId: "P1", amountPaisa: 8992 });
      assert.deepEqual([v.status, v.amountPaisa], [want, amt]);
      assert.equal(calls[0].url, "https://uat-payclient.hamropatro.com/v1/checkout/transaction");
      assert.equal(
        header(calls[0], "Signature"),
        node("abcdefg", `P1,${cfg.merchantId},client@123,merchant-api-key-test`),
      );
      assert.deepEqual(JSON.parse(String(calls[0].init.body)), {
        merchantId: cfg.merchantId,
        merchantTxnId: "P1",
      });
    }
    mockFetch(() => ({ body: { merchantTxnId: "P2", status: "COMPLETED", amount: 89.92 } }));
    await assert.rejects(
      h.verify({ orderId: "P1", amountPaisa: 8992 }),
      (e: PaymentError) => e.code === "id_mismatch",
    );
    assert.equal(h.orderIdFromCallback({ MerchantTxnId: "P1" }), "P1");
  });

  test("webhook: signature over merchantTxnId,merchantId,status,amount in any rendering of the amount", async () => {
    const body = {
      merchantTxnId: "P1",
      merchantId: cfg.merchantId,
      amount: 1200,
      status: "COMPLETED",
      metadata: {},
    };
    for (const a of ["1200", "1200.0", "1200.00"]) {
      assert.equal(
        await h.verifyWebhook(body, node("whsec", `P1,${cfg.merchantId},COMPLETED,${a}`)),
        true,
      );
    }
    assert.equal(
      await h.verifyWebhook(
        { ...body, amount: 1.5 },
        node("whsec", `P1,${cfg.merchantId},COMPLETED,1.50`),
      ),
      true,
    );
    assert.equal(
      await h.verifyWebhook(
        { ...body, amount: 1201 },
        node("whsec", `P1,${cfg.merchantId},COMPLETED,1200`),
      ),
      false,
    );
    assert.equal(
      await h.verifyWebhook(
        { ...body, amount: "1200" as unknown as number },
        node("whsec", `P1,${cfg.merchantId},COMPLETED,1200`),
      ),
      false,
    );
    assert.equal(await h.verifyWebhook(body, null), false);
    await assert.rejects(
      hamropay({ ...cfg, webhookSecret: undefined }).verifyWebhook(body, "x"),
      /webhookSecret/,
    );
  });
});

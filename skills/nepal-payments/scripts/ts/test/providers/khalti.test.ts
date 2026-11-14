/** Khalti KPG-2: initiate, lookup status mapping, replay guard, errors. */
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { khalti, PaymentError } from "../../src/index.ts";
import { calls, header, mockFetch, restoreFetch } from "../helpers.ts";

afterEach(restoreFetch);

describe("khalti", () => {
  const k = khalti({
    env: "sandbox",
    secretKey: "live_secret_key_test",
    websiteUrl: "https://shop.example",
  });

  test("initiate: integer paisa, trailing slash, Key header", async () => {
    mockFetch(() => ({
      body: {
        pidx: "PIDX1",
        payment_url: "https://test-pay.khalti.com/?pidx=PIDX1",
        expires_at: "x",
        expires_in: 1800,
      },
    }));
    const r = await k.initiate({
      orderId: "O1",
      amountPaisa: 1000,
      description: "Book",
      returnUrl: "https://shop.example/r",
    });
    assert.equal(calls[0].url, "https://dev.khalti.com/api/v2/epayment/initiate/");
    assert.equal(header(calls[0], "Authorization"), "Key live_secret_key_test");
    assert.equal(JSON.parse(String(calls[0].init.body)).amount, 1000);
    assert.equal(r.kind === "redirect" && r.providerRef, "PIDX1");
  });

  test("minimum Rs 10", async () => {
    await assert.rejects(
      k.initiate({ orderId: "O", amountPaisa: 999, description: "x", returnUrl: "https://r" }),
      /minimum/,
    );
  });

  test("lookup: Expired arrives as HTTP 400 with a normal body", async () => {
    mockFetch(() => ({
      status: 400,
      body: {
        pidx: "P",
        total_amount: 1000,
        status: "Expired",
        transaction_id: null,
        fee: 0,
        refunded: false,
      },
    }));
    assert.equal(
      (await k.verify({ orderId: "O", amountPaisa: 1000, providerRef: "P" })).status,
      "expired",
    );
  });

  test("lookup: Completed / User canceled / Partially Refunded", async () => {
    for (const [s, n] of [
      ["Completed", "paid"],
      ["User canceled", "canceled"],
      ["Partially refunded", "partially_refunded"],
      ["Initiated", "pending"],
    ]) {
      mockFetch(() => ({
        body: {
          pidx: "P",
          total_amount: 1000,
          status: s,
          transaction_id: "T",
          fee: 0,
          refunded: false,
        },
      }));
      assert.equal(
        (await k.verify({ orderId: "O", amountPaisa: 1000, providerRef: "P" })).status,
        n,
      );
    }
  });

  test("refuses callback pidx that differs from the stored one (replay guard)", async () => {
    await assert.rejects(
      k.verify({ orderId: "O", amountPaisa: 1000, providerRef: "P", callback: { pidx: "OTHER" } }),
      /does not match/,
    );
  });

  test("401 surfaces as unauthorized", async () => {
    mockFetch(() => ({ status: 401, body: { detail: "Invalid token.", status_code: 401 } }));
    await assert.rejects(
      k.verify({ orderId: "O", amountPaisa: 1000, providerRef: "P" }),
      (e: PaymentError) => e.code === "unauthorized",
    );
  });
});

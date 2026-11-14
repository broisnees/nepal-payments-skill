/** GetPay: return-token proof, SDK options and pages, merchant-status / statement verification. */
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { getpay, getPayDecodeToken, getPayOprSecret, PaymentError } from "../../src/index.ts";
import { calls, mockFetch, restoreFetch } from "../helpers.ts";

afterEach(restoreFetch);

describe("getpay", () => {
  const cfg = {
    env: "sandbox" as const,
    papInfo: btoa(
      JSON.stringify({ institutionId: "122", mid: "123123451770986", tid: "12358762" }),
    ),
    oprKey: "4fa4c6b9-3f91-43e5-9b4f-319f68187ba5",
    websiteDomain: "https://shop.example",
    businessName: "Shop",
    imageUrl: "https://shop.example/logo.png",
  };
  const g = getpay(cfg);
  const base =
    "https://uat-bank-getpay.nchl.com.np/ecom-web-checkout/v1/secure-merchant/transactions";
  const id = "0cc5b1a39f3c4cad864bc1c6a524534f";
  const secret = createHash("sha256")
    .update(cfg.oprKey + id)
    .digest("base64");
  const token = btoa(JSON.stringify({ id, oprSecret: secret }));
  const ok = (data: Record<string, unknown>) => ({ body: { status: 0, message: "SUCCESS", data } });

  test("oprSecret = base64(SHA-256(oprKey + id)); token decodes from JSON or id:secret", async () => {
    assert.equal(await getPayOprSecret(cfg.oprKey, id), secret);
    assert.deepEqual(getPayDecodeToken(token), { id, oprSecret: secret });
    assert.deepEqual(getPayDecodeToken(btoa(`${id}:${secret}`)), { id, oprSecret: secret });
    assert.equal(getPayDecodeToken("%%%"), null);
    assert.equal(getPayDecodeToken(btoa(JSON.stringify({ id }))), null);
  });

  test("token whose trailing '+' a query parser turned into a space still decodes", () => {
    // btoa("ab:cd~") is "YWI6Y2R+": six bytes, no padding, so the "+" is the last character.
    const raw = btoa("ab:cd~");
    assert.ok(raw.endsWith("+"));
    const mangled = raw.replace(/\+/g, " ");
    assert.deepEqual(getPayDecodeToken(mangled), { id: "ab", oprSecret: "cd~" });
  });

  test("initiate: SDK options with a numeric price, clientRequestId and same-origin callbacks", async () => {
    const r = await g.initiate({
      orderId: "P1",
      amountPaisa: 120050,
      description: "Cup <set>",
      returnUrl: "https://shop.example/ok/P1",
      failureUrl: "https://shop.example/no/P1",
    });
    assert.equal(r.kind, "sdk");
    if (r.kind !== "sdk") return;
    assert.equal(
      r.scriptUrl,
      "https://minio-getpay.nchl.com.np/getpay-cdn/webcheckout/v5/bundle.js",
    );
    assert.equal(r.options.price, 1200.5);
    assert.equal(r.options.clientRequestId, "P1");
    assert.equal(r.options.baseUrl, base);
    assert.equal(r.options.insKey, "");
    assert.deepEqual(r.options.callbackUrl, {
      successUrl: "https://shop.example/ok/P1",
      failUrl: "https://shop.example/no/P1",
    });
    assert.match(String(r.options.orderInformationUI), /Cup &lt;set&gt;/);
    await assert.rejects(
      g.initiate({
        orderId: "P1",
        amountPaisa: 100,
        description: "x",
        returnUrl: "https://evil.example/ok",
      }),
      (e: PaymentError) => e.code === "invalid_callback_url",
    );
    const page = g.checkoutPage(r, "/pay/P1</script>");
    assert.match(page, /new GetPay\(o\)\.initialize\(\)/);
    assert.ok(!page.includes('</script>"') && page.includes("\\u003c/script>"));
    assert.match(g.paymentPage(), /<div id="checkout"><\/div>/);
    assert.match(g.returnPage("/payments/getpay/return/P1"), /window\.top\.location/);
  });

  test("verify with token: oprSecret checked, merchant-status, clientId must be this order", async () => {
    mockFetch(() =>
      ok({
        status: "SUCCESS",
        amount: 1200.0,
        currency: "NPR",
        stan: "379832",
        crrn: "624503379832",
        clientId: "P1",
        remarks: "Success",
      }),
    );
    const v = await g.verify({ orderId: "P1", amountPaisa: 120000, callback: { token } });
    assert.deepEqual([v.status, v.amountPaisa, v.transactionId], ["paid", 120000, id]);
    assert.equal(calls[0].url, `${base}/merchant-status`);
    assert.deepEqual(JSON.parse(String(calls[0].init.body)), { id, papInfo: cfg.papInfo });

    mockFetch(() => ok({ status: "SUCCESS", amount: 1200.0, clientId: "SOMEONE-ELSES-ORDER" }));
    await assert.rejects(
      g.verify({ orderId: "P1", amountPaisa: 120000, callback: { token } }),
      (e: PaymentError) => e.code === "id_mismatch",
    );

    const forged = btoa(JSON.stringify({ id, oprSecret: btoa("not the hash") }));
    await assert.rejects(
      g.verify({ orderId: "P1", amountPaisa: 120000, callback: { token: forged } }),
      (e: PaymentError) => e.code === "bad_signature",
    );
    await assert.rejects(
      g.verify({ orderId: "P1", amountPaisa: 120000, callback: { token: "@@" } }),
      (e: PaymentError) => e.code === "malformed_callback",
    );

    mockFetch(() => ok({ status: "FAILED", amount: 1200.0, clientId: "P1" }));
    assert.equal(
      (await g.verify({ orderId: "P1", amountPaisa: 120000, callback: { token } })).status,
      "failed",
    );
    mockFetch(() => ({
      status: 400,
      body: {
        status: -1,
        message: `Failed to fetch merchant information: Transaction not found for ID: ${id}`,
      },
    }));
    assert.equal(
      (await g.verify({ orderId: "P1", amountPaisa: 120000, callback: { token } })).status,
      "not_found",
    );
  });

  test("verify without token: statement by clientRequestId; a success there is unknown, never paid", async () => {
    mockFetch(() =>
      ok({
        transactionId: id,
        clientRequestId: "P1",
        saleTransactionAmount: 1200.0,
        status: "SUCCESS",
        paymentScheme: "MASTERCARD",
      }),
    );
    const v = await g.verify({ orderId: "P1", amountPaisa: 120000 });
    assert.deepEqual([v.status, v.amountPaisa, v.transactionId], ["unknown", 120000, id]);
    assert.equal(calls[0].url, `${base}/transaction-statement`);
    assert.deepEqual(JSON.parse(String(calls[0].init.body)), { clientRequestId: "P1" });
    mockFetch(() =>
      ok({
        transactionId: id,
        clientRequestId: "P1",
        saleTransactionAmount: 1200.0,
        status: "FAILED",
      }),
    );
    assert.equal((await g.verify({ orderId: "P1", amountPaisa: 120000 })).status, "failed");
    mockFetch(() => ({
      status: 400,
      body: {
        status: -1,
        message:
          "Failed to fetch transaction statement: Transaction not found for transaction ID: x",
      },
    }));
    assert.equal((await g.verify({ orderId: "P1", amountPaisa: 120000 })).status, "not_found");
    mockFetch(() => ({ status: 500, body: "oops" }));
    await assert.rejects(g.verify({ orderId: "P1", amountPaisa: 120000 }), PaymentError);
  });
});

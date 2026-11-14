/**
 * eSewa: signature vectors (eSewa's docs print wrong ones; these are verified), ePay form,
 * success-redirect parsing, status API, Intent callbacks.
 */
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { esewa, ESEWA_SANDBOX, esewaSign, toBase64 } from "../../src/index.ts";
import { calls, isPaymentError, mockFetch, restoreFetch } from "../helpers.ts";

afterEach(restoreFetch);

describe("esewa", () => {
  const e = esewa({ env: "sandbox", ...ESEWA_SANDBOX });
  const order = ["total_amount", "transaction_uuid", "product_code"];

  test("signature test vectors (docs' own examples are wrong; these are verified)", async () => {
    const k = ESEWA_SANDBOX.secretKey;
    assert.equal(
      await esewaSign(
        k,
        { total_amount: "100", transaction_uuid: "11-201-13", product_code: "EPAYTEST" },
        order,
      ),
      "5DZywcrTKD0gia/rsSMcrRHmJl+4Tbol6S+lWgdJ94E=",
    );
    assert.equal(
      await esewaSign(
        k,
        { total_amount: "110", transaction_uuid: "ab14a8f2b02c3", product_code: "EPAYTEST" },
        order,
      ),
      "0Gh9pc1fiZDZH7OKOBdn42QMx8drH7tOeMPdRQhI83g=",
    );
    assert.equal(
      await esewaSign(
        ESEWA_SANDBOX.intent.accessKey,
        { product_code: "INTENT", amount: "100", transaction_uuid: "txn-20251220-001" },
        ["product_code", "amount", "transaction_uuid"],
      ),
      "oVRo2ZkjNpbt5vKs7RSNx1OCcewDaVssoguWsG31HMA=",
    );
  });

  test("initiate: amountPaisa is the total; breakdown included; same string signed and posted", async () => {
    const r = await e.initiate({
      orderId: "ORD-1",
      amountPaisa: 11050,
      taxPaisa: 1000,
      description: "x",
      returnUrl: "https://s/r/ORD-1",
    });
    assert.equal(r.kind, "form");
    if (r.kind !== "form") return;
    assert.equal(r.fields.total_amount, "110.50");
    assert.equal(r.fields.amount, "100.50");
    await assert.rejects(
      e.initiate({
        orderId: "ORD-1",
        amountPaisa: 1000,
        taxPaisa: 1000,
        description: "x",
        returnUrl: "https://s",
      }),
      /less than the total/,
    );
    assert.equal(r.fields.signature, await esewaSign(ESEWA_SANDBOX.secretKey, r.fields, order));
    assert.equal(r.action, "https://rc-epay.esewa.com.np/api/epay/main/v2/form");
  });

  test("rejects uuid with forbidden characters", async () => {
    await assert.rejects(
      e.initiate({ orderId: "a_b", amountPaisa: 100, description: "x", returnUrl: "https://s" }),
      /letters, digits/,
    );
  });

  async function successData(overrides: Record<string, string> = {}) {
    const p: Record<string, string> = {
      transaction_code: "000AWEO",
      status: "COMPLETE",
      total_amount: "1000.0",
      transaction_uuid: "ORD-2",
      product_code: "EPAYTEST",
      signed_field_names:
        "transaction_code,status,total_amount,transaction_uuid,product_code,signed_field_names",
      ...overrides,
    };
    p.signature = await esewaSign(ESEWA_SANDBOX.secretKey, p, p.signed_field_names.split(","));
    return p;
  }

  test("success payload signature verifies; tamper fails; comma variant accepted", async () => {
    const p = await successData();
    const data = toBase64(new TextEncoder().encode(JSON.stringify(p)));
    assert.equal((await e.parseSuccess(data)).signatureValid, true);
    // '+' -> ' ' in query
    assert.equal((await e.parseSuccess(data.replace(/\+/g, " "))).signatureValid, true);
    const tampered = toBase64(
      new TextEncoder().encode(JSON.stringify({ ...p, total_amount: "1.0" })),
    );
    assert.equal((await e.parseSuccess(tampered)).signatureValid, false);
    // eSewa signs "1000.0" but displays "1,000.0"
    const shown = toBase64(
      new TextEncoder().encode(JSON.stringify({ ...p, total_amount: "1,000.0" })),
    );
    assert.equal((await e.parseSuccess(shown)).signatureValid, true);
  });

  test("numeric total_amount is verified against its raw JSON text (1000.0 stays 1000.0)", async () => {
    const p = await successData(); // signed over total_amount=1000.0
    const json = JSON.stringify(p).replace('"total_amount":"1000.0"', '"total_amount":1000.0');
    assert.ok(json.includes('"total_amount":1000.0'));
    assert.equal(
      (await e.parseSuccess(toBase64(new TextEncoder().encode(json)))).signatureValid,
      true,
    );
  });

  test("verify: status API is authoritative and uses the stored total", async () => {
    mockFetch(() => ({
      body: {
        product_code: "EPAYTEST",
        transaction_uuid: "ORD-2",
        total_amount: 1000.0,
        status: "COMPLETE",
        ref_id: "0001TS9",
      },
    }));
    const p = await successData();
    const v = await e.verify({
      orderId: "ORD-2",
      amountPaisa: 100000,
      callback: { data: toBase64(new TextEncoder().encode(JSON.stringify(p))) },
    });
    assert.equal(v.status, "paid");
    assert.equal(v.amountPaisa, 100000);
    assert.equal(v.transactionId, "0001TS9");
    assert.match(
      calls[0].url,
      /^https:\/\/rc\.esewa\.com\.np\/api\/epay\/transaction\/status\/\?product_code=EPAYTEST&total_amount=1000&transaction_uuid=ORD-2$/,
    );
  });

  test("verify: callback for another order is rejected", async () => {
    const p = await successData({ transaction_uuid: "OTHER" });
    await assert.rejects(
      e.verify({
        orderId: "ORD-2",
        amountPaisa: 100000,
        callback: { data: toBase64(new TextEncoder().encode(JSON.stringify(p))) },
      }),
      /does not match/,
    );
  });

  test("status mapping", async () => {
    for (const [s, n] of [
      ["PENDING", "pending"],
      ["AMBIGUOUS", "pending"],
      ["NOT_FOUND", "not_found"],
      ["FULL_REFUND", "refunded"],
      ["CANCELED", "canceled"],
      ["WEIRD", "unknown"],
    ]) {
      mockFetch(() => ({ body: { status: s, total_amount: 10, ref_id: null } }));
      assert.equal((await e.verify({ orderId: "X", amountPaisa: 1000 })).status, n);
    }
  });

  const b64 = (s: string) => toBase64(new TextEncoder().encode(s));

  test("status tables ignore Object.prototype keys", async () => {
    for (const s of ["constructor", "__proto__", "toString"]) {
      mockFetch(() => ({ body: { status: s, total_amount: 10, ref_id: null } }));
      assert.equal((await e.verify({ orderId: "X", amountPaisa: 1000 })).status, "unknown");
    }
  });

  test("eSewa: malformed success data is a 400, not a raw SyntaxError", async () => {
    for (const data of ["!!!!", b64("not json"), b64("{")]) {
      await assert.rejects(e.parseSuccess(data), isPaymentError("malformed_callback", 400));
      await assert.rejects(
        e.verify({ orderId: "X", amountPaisa: 1000, callback: { data } }),
        isPaymentError("malformed_callback", 400),
      );
    }
  });

  test("eSewa: error body read from error_message or errorMessage", async () => {
    mockFetch(() => ({
      status: 503,
      body: { code: 0, errorMessage: "Service is currently unavailable" },
    }));
    await assert.rejects(
      e.verify({ orderId: "X", amountPaisa: 1000 }),
      (err: unknown) =>
        isPaymentError("esewa_0", 503)(err) &&
        /Service is currently unavailable/.test((err as Error).message),
    );
    mockFetch(() => ({
      status: 400,
      body: { code: "IP-400", error_message: "Invalid Signature" },
    }));
    await assert.rejects(
      e.intentBook({
        orderId: "X",
        amountPaisa: 10000,
        callbackUrl: "https://c",
        redirectUrl: "https://r",
      }),
      (err: unknown) =>
        isPaymentError("esewa_IP-400", 400)(err) &&
        /Invalid Signature/.test((err as Error).message),
    );
    mockFetch(() => ({ status: 502, body: "<html>bad gateway</html>" }));
    await assert.rejects(
      e.verify({ orderId: "X", amountPaisa: 1000 }),
      isPaymentError("http_502", 502),
    );
  });

  test("eSewa Intent callback: raw body keeps number text; parsed body uses String(v)", async () => {
    const key = ESEWA_SANDBOX.intent.accessKey;
    const order = ["product_code", "amount", "reference_code", "status"];
    const names = order.join(",");
    const base = { product_code: "INTENT", reference_code: "R1", status: "SUCCESS" };
    // Signed over "100.0", exactly as the JSON text carries it.
    const sigExact = await esewaSign(key, { ...base, amount: "100.0" }, order);
    const raw = `{"product_code":"INTENT","amount":100.0,"reference_code":"R1","status":"SUCCESS","signed_field_names":"${names}","signature":"${sigExact}"}`;
    assert.equal(await e.intentCallbackValid(raw), true);
    assert.equal(await e.intentCallbackValid(JSON.parse(raw)), false); // parsed: 100.0 is just 100
    // Signed over "100", the String(v) form; the raw body is accepted too.
    const sigJs = await esewaSign(key, { ...base, amount: "100" }, order);
    const raw2 = raw.replace(sigExact, sigJs);
    assert.equal(await e.intentCallbackValid(raw2), true);
    assert.equal(await e.intentCallbackValid(JSON.parse(raw2)), true);
    // null signs as "", tamper and junk fail.
    const sigNull = await esewaSign(key, { ...base, amount: "" }, order);
    assert.equal(
      await e.intentCallbackValid({
        ...base,
        amount: null,
        signed_field_names: names,
        signature: sigNull,
      }),
      true,
    );
    assert.equal(await e.intentCallbackValid(raw.replace("100.0", "1.0")), false);
    assert.equal(await e.intentCallbackValid("not json"), false);
    assert.equal(await e.intentCallbackValid("[1]"), false);
  });
});

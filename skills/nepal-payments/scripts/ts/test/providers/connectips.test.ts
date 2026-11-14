/** connectIPS: RSA-signed TOKEN, TXNID rules, validatetxn mapping. */
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { connectips, connectIpsTokenString, fromBase64, toBase64 } from "../../src/index.ts";
import { calls, header, mockFetch, restoreFetch, rsaKeys } from "../helpers.ts";

afterEach(restoreFetch);

describe("connectips", async () => {
  const { keyPair: kp, privateKeyPem: pem } = await rsaKeys();
  const c = connectips({
    env: "sandbox",
    merchantId: 550,
    appId: "MER-550-APP-1",
    appName: "Test",
    appPassword: "pw",
    privateKeyPem: pem,
  });

  test("TOKEN is RSA-SHA256 over the documented string, amount in paisa, DD-MM-YYYY", async () => {
    const r = await c.initiate({
      orderId: "txn123",
      amountPaisa: 500,
      description: "Order, #1",
      returnUrl: "",
    });
    assert.equal(r.kind, "form");
    if (r.kind !== "form") return;
    assert.equal(r.fields.TXNAMT, "500");
    assert.match(r.fields.TXNDATE, /^\d{2}-\d{2}-\d{4}$/);
    assert.equal(r.fields.REMARKS, "Order  #1"); // commas stripped: they'd corrupt the token string
    const msg = connectIpsTokenString(r.fields);
    assert.ok(msg.endsWith(",PARTICULARS=Order  #1,TOKEN=TOKEN"));
    const ok = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      kp.publicKey,
      fromBase64(r.fields.TOKEN) as BufferSource,
      new TextEncoder().encode(msg),
    );
    assert.equal(ok, true);
  });

  test("TXNID max 20 chars", async () => {
    await assert.rejects(
      c.initiate({ orderId: "X".repeat(21), amountPaisa: 100, description: "x", returnUrl: "" }),
      /1–20/,
    );
  });

  test("validatetxn: referenceId = TXNID, Basic auth, status mapping", async () => {
    for (const [status, statusDesc, n] of [
      ["SUCCESS", "TRANSACTION SUCCESSFUL", "paid"],
      ["FAILED", "TRANSACTION UNSUCCESSFUL", "failed"],
      ["ERROR", "TRANSACTION NOT FOUND", "not_found"],
      ["ERROR", "TRANSACTION INCOMPLETE", "pending"],
    ]) {
      mockFetch(() => ({
        body: {
          merchantId: 550,
          appId: "MER-550-APP-1",
          referenceId: "txn123",
          txnAmt: "500",
          status,
          statusDesc,
        },
      }));
      const v = await c.verify({ orderId: "txn123", amountPaisa: 500 });
      assert.equal(v.status, n);
      const body = JSON.parse(String(calls[0].init.body));
      assert.equal(body.referenceId, "txn123");
      assert.equal(body.txnAmt, 500);
      assert.equal(header(calls[0], "Authorization"), "Basic " + btoa("MER-550-APP-1:pw"));
      assert.equal(
        calls[0].url,
        "https://uat.connectips.com/connectipswebws/api/creditor/validatetxn",
      );
    }
  });

  test("connectIPS: txnAmt null is null, empty referenceId/remarks fall back", async () => {
    const kp = await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign"],
    );
    const der = new Uint8Array(await crypto.subtle.exportKey("pkcs8", kp.privateKey));
    const pem = `-----BEGIN PRIVATE KEY-----\n${toBase64(der)}\n-----END PRIVATE KEY-----`;
    const c = connectips({
      env: "sandbox",
      merchantId: 550,
      appId: "A",
      appName: "T",
      appPassword: "pw",
      privateKeyPem: pem,
    });
    mockFetch(() => ({
      body: { status: "ERROR", statusDesc: "TRANSACTION NOT FOUND", txnAmt: null },
    }));
    assert.equal((await c.verify({ orderId: "T1", amountPaisa: 500 })).amountPaisa, null);
    const r = await c.initiate({
      orderId: "T1",
      amountPaisa: 500,
      description: "Shoes",
      returnUrl: "",
      referenceId: "",
      remarks: "",
    });
    if (r.kind !== "form") return assert.fail();
    assert.equal(r.fields.REFERENCEID, "T1");
    assert.equal(r.fields.REMARKS, "Shoes");
  });
});

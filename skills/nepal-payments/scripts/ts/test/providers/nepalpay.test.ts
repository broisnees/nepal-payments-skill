/**
 * NEPALPAY QR: signed token, generateQR, merchanttxnreport mapping, OAuth, notifications,
 * WebSocket.
 */
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  nepalpay,
  nepalPayConfirmationString,
  nepalPayTokenString,
  PaymentError,
  rsaPkcs1EncryptBase64,
  toBase64,
} from "../../src/index.ts";
import { calls, header, mockFetch, restoreFetch, rsaKeys } from "../helpers.ts";

afterEach(restoreFetch);

describe("nepalpay", async () => {
  const {
    keyPair: kp,
    privateKeyPem: pem,
    publicKeyPem: spki,
    verifySignature: verifySig,
  } = await rsaKeys();
  const base = {
    env: "sandbox" as const,
    acquirerId: "00001701",
    merchantId: "17012UVSTIR",
    merchantName: "BBSM",
    merchantCategoryCode: 5021,
    merchantCity: "Kathmandu",
    merchantPostalCode: "4600",
    storeLabel: "Store1",
    terminalLabel: "Terminal1",
    username: "npiuser",
    password: "pw",
    privateKeyPem: pem,
  };
  const n = nepalpay(base);
  const generated = {
    timestamp: "2022-05-23 04:25:26",
    responseCode: "000",
    responseStatus: "SUCCESS",
    responseMessage: "QR String generated successfully.",
    data: {
      validationTraceId: "2205260000001900KIY",
      qrString: " 000201010212...6304607F",
      qrImage: "iVBORw0KGgo=",
    },
  };

  test("token string: comma-joined, no spaces, userId last", () => {
    assert.equal(
      nepalPayTokenString({
        acquirerId: "00001701",
        merchantId: "17012UVSTIR",
        merchantCategoryCode: 5021,
        transactionCurrency: 524,
        transactionAmount: "10.50",
        billNumber: "P1",
        userId: "npiuser",
      }),
      "00001701,17012UVSTIR,5021,524,10.50,P1,npiuser",
    );
  });

  test("initiate: dynamic QR (12), rupees with 2 decimals, signed token, Basic auth, qr result", async () => {
    mockFetch(() => ({ body: generated }));
    const r = await n.initiate({
      orderId: "P1",
      amountPaisa: 1050,
      description: "Everest T-shirt, large and blue",
      returnUrl: "",
    });
    assert.equal(calls[0].url, "https://devopennpi.connectips.com/qr/generateQR");
    assert.equal(header(calls[0], "Authorization"), "Basic " + btoa("npiuser:pw"));
    const body = JSON.parse(String(calls[0].init.body));
    assert.equal(body.pointOfInitialization, 12);
    assert.equal(body.transactionAmount, "10.50");
    assert.equal(body.transactionCurrency, 524);
    assert.equal(body.billNumber, "P1");
    assert.equal(body.purposeOfTransaction.length, 25);
    assert.equal(body.qrImage, true);
    assert.equal(
      await verifySig(body.token, "00001701,17012UVSTIR,5021,524,10.50,P1,npiuser"),
      true,
    );
    assert.deepEqual(
      {
        kind: r.kind,
        providerRef: r.providerRef,
        qrString: r.kind === "qr" && r.qrString,
        qrImage: r.kind === "qr" && r.qrImage,
      },
      {
        kind: "qr",
        providerRef: "2205260000001900KIY",
        qrString: "000201010212...6304607F",
        qrImage: "iVBORw0KGgo=",
      },
    );
    mockFetch(() => ({ body: generated }));
    await n.initiate({ orderId: "P2", amountPaisa: 100000, description: "x", returnUrl: "" });
    assert.equal(JSON.parse(String(calls[0].init.body)).transactionAmount, "1000.00");
  });

  test("initiate: billNumber charset/length, error codes surface", async () => {
    await assert.rejects(
      n.initiate({ orderId: "X".repeat(26), amountPaisa: 100, description: "x", returnUrl: "" }),
      /1–25/,
    );
    mockFetch(() => ({
      status: 400,
      body: { responses: [{ responseCode: "E003", responseMessage: "INVALID TOKEN" }] },
    }));
    await assert.rejects(
      n.initiate({ orderId: "P1", amountPaisa: 100, description: "x", returnUrl: "" }),
      (e: PaymentError) => e.code === "E003",
    );
  });

  const txn = (o: Record<string, unknown>) => ({
    nQrTxnId: "2312060000059575KMB",
    amount: 10.5,
    tranType: "PMT",
    merchantBillNo: "P1",
    ...o,
  });
  const report = (rows: unknown[]) => ({
    timestamp: "2024-02-07T07:10:47.928+0000",
    responseCode: "200",
    responseStatus: "SUCCESS",
    responseBody: rows,
  });

  test("verify: report by validationTraceId; a success after a failed scan counts", async () => {
    mockFetch(() => ({
      body: report([
        txn({ nQrTxnId: "A", debitStatus: "E001", creditStatus: null }),
        txn({ nQrTxnId: "B", debitStatus: "000", creditStatus: "DEFER" }),
      ]),
    }));
    const v = await n.verify({
      orderId: "P1",
      amountPaisa: 1050,
      providerRef: "2205260000001900KIY",
    });
    assert.equal(calls[0].url, "https://devopennpi.connectips.com/nQR/v1/merchanttxnreport");
    assert.deepEqual(JSON.parse(String(calls[0].init.body)), {
      validationTraceId: "2205260000001900KIY",
      merchantId: "17012UVSTIR",
      acquirerId: "00001701",
    });
    assert.deepEqual([v.status, v.amountPaisa, v.transactionId], ["paid", 1050, "B"]);
  });

  test("verify: status mapping", async () => {
    const cases: [unknown, string][] = [
      [report([txn({ debitStatus: "000", creditStatus: "000" })]), "paid"],
      [report([txn({ debitStatus: "000", creditStatus: "999" })]), "paid"],
      [report([txn({ debitStatus: "000", creditStatus: "E99" })]), "unknown"],
      [report([txn({ debitStatus: "E001", creditStatus: null })]), "failed"],
      [report([txn({ debitStatus: "000", creditStatus: "000", tranType: "RFND" })]), "not_found"],
      [report([]), "not_found"],
      [{ responseCode: "E010", responseMessage: "RECORD NOT FOUND" }, "not_found"],
    ];
    for (const [body, want] of cases) {
      mockFetch(() => ({ body }));
      assert.equal(
        (await n.verify({ orderId: "P1", amountPaisa: 1050, providerRef: "T" })).status,
        want,
      );
    }
    await assert.rejects(
      n.verify({ orderId: "P1", amountPaisa: 1050 }),
      (e: PaymentError) => e.code === "missing_provider_ref",
    );
  });

  test("oauth: password grant once, Bearer reused until expiry", async () => {
    const o = nepalpay({ ...base, auth: "oauth", clientId: "cid", clientSecret: "csec" });
    mockFetch((url) =>
      url.endsWith("/oauth/token")
        ? { body: { access_token: "AT1", token_type: "bearer", expires_in: 299 } }
        : { body: report([]) },
    );
    await o.verify({ orderId: "P1", amountPaisa: 100, providerRef: "T" });
    await o.verify({ orderId: "P1", amountPaisa: 100, providerRef: "T" });
    assert.equal(calls.length, 3);
    assert.equal(header(calls[0], "Authorization"), "Basic " + btoa("cid:csec"));
    assert.equal(String(calls[0].init.body), "grant_type=password&username=npiuser&password=pw");
    assert.equal(header(calls[1], "Authorization"), "Bearer AT1");
    assert.equal(header(calls[2], "Authorization"), "Bearer AT1");
  });

  test("confirm-payment reply is signed over txnDate,status,message,merchantBillNo,paymentRef", async () => {
    const r = await n.confirmationResponse({
      txnDate: "2024-11-10 01:35:31",
      merchantBillNo: "P1",
      paymentRef: "2411100000067378ZHU",
    });
    assert.equal(
      await verifySig(
        r.signature,
        "2024-11-10 01:35:31,SUCCESS,TRANSACTION SUCCESSFUL,P1,2411100000067378ZHU",
      ),
      true,
    );
    assert.equal(n.orderIdFromCallback({ merchantBillNo: "P1" }), "P1");
  });

  const withNchl = nepalpay({
    ...base,
    nchlPublicKeyPem: spki,
    wsUrl: "wss://ws.example/nqrws",
    wsUsername: "wsuser",
    wsApiToken: "secret-api-token",
  });

  test("confirm-payment notification: signature over the documented string, payerMobile fallback", async () => {
    const note: Record<string, unknown> = {
      merchantBillNo: "NA",
      merchantId: "0010SVQNL9H",
      merchantName: "Quantum Labs",
      paymentRef: "2411100000067378ZHU",
      channel: "CIPS",
      payerMobile: "+977-9843705813",
      sessionNo: "5446",
      status: "SUCCESS",
    };
    const msg = "NA,0010SVQNL9H,Quantum Labs,2411100000067378ZHU,CIPS,+977-9843705813,5446";
    assert.equal(nepalPayConfirmationString(note), msg);
    const sig = toBase64(
      new Uint8Array(
        await crypto.subtle.sign("RSASSA-PKCS1-v1_5", kp.privateKey, new TextEncoder().encode(msg)),
      ),
    );
    assert.equal(await withNchl.verifyConfirmation({ ...note, signature: sig }), true);
    assert.equal(
      await withNchl.verifyConfirmation({ ...note, sessionNo: "5447", signature: sig }),
      false,
    );
    assert.equal(await withNchl.verifyConfirmation({ ...note, signature: "not base64!" }), false);
    assert.equal(await withNchl.verifyConfirmation(note), false);
    await assert.rejects(n.verifyConfirmation(note), /nchlPublicKeyPem/);
  });

  test("WebSocket request: destinations, terminal as merchant_id, api_token RSA PKCS#1 v1.5 encrypted", async () => {
    const w = await withNchl.webSocketRequest("2205260000001900KIY");
    assert.deepEqual(
      {
        url: w.url,
        subscribe: w.subscribe,
        send: w.send,
        merchant_id: w.body.merchant_id,
        request_id: w.body.request_id,
        username: w.body.username,
      },
      {
        url: "wss://ws.example/nqrws",
        subscribe: "/user/nqrws/check-txn-status",
        send: "/nqrws/check-txn-status",
        merchant_id: "Terminal1",
        request_id: "2205260000001900KIY",
        username: "wsuser",
      },
    );
    // Decrypt with the private exponent and check the PKCS#1 v1.5 type 2 block by hand.
    const jwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
    const big = (b64u: string) => BigInt("0x" + Buffer.from(b64u, "base64url").toString("hex"));
    const [nn, d] = [big(jwk.n!), big(jwk.d!)];
    let m = 1n;
    let b = BigInt("0x" + Buffer.from(w.body.api_token, "base64").toString("hex")) % nn;
    for (let x = d; x > 0n; x >>= 1n) {
      if (x & 1n) m = (m * b) % nn;
      b = (b * b) % nn;
    }
    const em = Buffer.from(m.toString(16).padStart(512, "0"), "hex");
    assert.equal(Buffer.from(w.body.api_token, "base64").length, 256);
    assert.deepEqual([em[0], em[1]], [0, 2]);
    const sep = em.indexOf(0, 2);
    assert.ok(sep >= 10 && !em.subarray(2, sep).includes(0));
    assert.equal(em.subarray(sep + 1).toString(), "secret-api-token");
    assert.notEqual(
      (await withNchl.webSocketRequest("X")).body.api_token,
      (await withNchl.webSocketRequest("X")).body.api_token,
    );
    await assert.rejects(n.webSocketRequest("X"), /wsUrl/);
    await assert.rejects(rsaPkcs1EncryptBase64(spki, "x".repeat(246)), /too long/);
  });
});

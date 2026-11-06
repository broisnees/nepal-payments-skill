/**
 * Offline tests: published test vectors + mocked provider HTTP. Run: `npm test` (Node >= 22.18).
 * Live sandbox smoke test: test/sandbox.ts.
 */
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import {
  basicAuth,
  createPayments,
  decideTransition,
  connectips,
  connectIpsTokenString,
  cybersource,
  cybersourceSign,
  esewa,
  ESEWA_SANDBOX,
  esewaSign,
  fonepay,
  fonepayDate,
  fonepayHmac,
  fromBase64,
  imepay,
  khalti,
  hamropay,
  hamroPaySign,
  getpay,
  getPayOprSecret,
  getPayDecodeToken,
  nepalpay,
  nepalPayTokenString,
  nepalPayConfirmationString,
  rsaPkcs1EncryptBase64,
  newOrderId,
  nps,
  npsSign,
  paisaToRupees,
  PaymentError,
  renderAutoSubmitForm,
  rupeesToPaisa,
  toBase64,
} from "../src/index.ts";

// ---------------------------------------------------------------- fetch mock
type Call = { url: string; init: RequestInit };
let calls: Call[] = [];
const realFetch = globalThis.fetch;
function mockFetch(handler: (url: string, init: RequestInit) => { status?: number; body: unknown }) {
  calls = [];
  globalThis.fetch = (async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const r = handler(String(url), init);
    return new Response(typeof r.body === "string" ? r.body : JSON.stringify(r.body), { status: r.status ?? 200 });
  }) as typeof fetch;
}
afterEach(() => {
  globalThis.fetch = realFetch;
});
const header = (c: Call, name: string) => (c.init.headers as Record<string, string>)[name];

// ---------------------------------------------------------------- core
describe("core", () => {
  test("money conversions are exact", () => {
    assert.equal(paisaToRupees(10000), "100");
    assert.equal(paisaToRupees(10050), "100.50");
    assert.equal(paisaToRupees(5), "0.05");
    assert.equal(rupeesToPaisa("1,000.0"), 100000);
    assert.equal(rupeesToPaisa(100.1), 10010);
    assert.equal(rupeesToPaisa("0.1"), 10);
    assert.equal(rupeesToPaisa("19.995"), 2000);
    assert.equal(rupeesToPaisa(1.005), 101); // same as Python Decimal(str(x)); toFixed(2) would give 100
  });

  test("decideTransition: the state machine", () => {
    const H = 60 * 60_000;
    const paid = { status: "paid" as const, amountPaisa: 1000 };
    assert.equal(decideTransition("initiated", paid, 1000, 0).next, "paid");
    // amount guard: mismatch and missing amount both go to review, never paid
    assert.deepEqual(decideTransition("pending", { status: "paid", amountPaisa: 10 }, 1000, 0), { next: "unknown", reviewRequired: true, latePaid: false, reason: "amount mismatch: stored 1000, provider 10" });
    assert.equal(decideTransition("pending", { status: "paid", amountPaisa: null }, 1000, 0).reviewRequired, true);
    // not_found keeps the attempt open inside the window, expires after
    assert.equal(decideTransition("initiated", { status: "not_found", amountPaisa: null }, 1000, 5 * 60_000).next, null);
    assert.equal(decideTransition("initiated", { status: "not_found", amountPaisa: null }, 1000, 2 * H).next, "expired");
    // late payment after we closed it is recovered, not dropped
    const late = decideTransition("expired", paid, 1000, 3 * H);
    assert.equal(late.next, "paid");
    assert.equal(late.latePaid, true);
    // paid is terminal for automation; same status is a no-op
    assert.equal(decideTransition("paid", { status: "failed", amountPaisa: null }, 1000, 0).next, null);
    assert.equal(decideTransition("pending", { status: "pending", amountPaisa: null }, 1000, 0).next, null);
    assert.equal(decideTransition("failed", { status: "canceled", amountPaisa: null }, 1000, 0).next, null);
  });
  test("base64 tolerates '+' turned into space", () => {
    const b = toBase64(new Uint8Array([251, 255, 190]));
    assert.equal(b, "+/++");
    assert.deepEqual(fromBase64(b.replace(/\+/g, " ")), new Uint8Array([251, 255, 190]));
  });
  test("newOrderId fits every provider", () => {
    for (let i = 0; i < 1000; i++) assert.match(newOrderId(), /^[A-Z0-9]{17,20}$/);
  });
  test("auto-submit form escapes values", () => {
    const html = renderAutoSubmitForm({ kind: "form", action: "https://x/pay", method: "POST", fields: { a: `"><script>` } });
    assert.ok(html.includes("&quot;&gt;&lt;script&gt;"));
  });
});

// ---------------------------------------------------------------- eSewa
describe("esewa", () => {
  const e = esewa({ env: "sandbox", ...ESEWA_SANDBOX });
  const order = ["total_amount", "transaction_uuid", "product_code"];

  test("signature test vectors (docs' own examples are wrong; these are verified)", async () => {
    const k = ESEWA_SANDBOX.secretKey;
    assert.equal(await esewaSign(k, { total_amount: "100", transaction_uuid: "11-201-13", product_code: "EPAYTEST" }, order), "5DZywcrTKD0gia/rsSMcrRHmJl+4Tbol6S+lWgdJ94E=");
    assert.equal(await esewaSign(k, { total_amount: "110", transaction_uuid: "ab14a8f2b02c3", product_code: "EPAYTEST" }, order), "0Gh9pc1fiZDZH7OKOBdn42QMx8drH7tOeMPdRQhI83g=");
    assert.equal(
      await esewaSign(ESEWA_SANDBOX.intent.accessKey, { product_code: "INTENT", amount: "100", transaction_uuid: "txn-20251220-001" }, ["product_code", "amount", "transaction_uuid"]),
      "oVRo2ZkjNpbt5vKs7RSNx1OCcewDaVssoguWsG31HMA=",
    );
  });

  test("initiate: amountPaisa is the total; breakdown included; same string signed and posted", async () => {
    const r = await e.initiate({ orderId: "ORD-1", amountPaisa: 11050, taxPaisa: 1000, description: "x", returnUrl: "https://s/r/ORD-1" });
    assert.equal(r.kind, "form");
    if (r.kind !== "form") return;
    assert.equal(r.fields.total_amount, "110.50");
    assert.equal(r.fields.amount, "100.50");
    await assert.rejects(e.initiate({ orderId: "ORD-1", amountPaisa: 1000, taxPaisa: 1000, description: "x", returnUrl: "https://s" }), /less than the total/);
    assert.equal(r.fields.signature, await esewaSign(ESEWA_SANDBOX.secretKey, r.fields, order));
    assert.equal(r.action, "https://rc-epay.esewa.com.np/api/epay/main/v2/form");
  });

  test("rejects uuid with forbidden characters", async () => {
    await assert.rejects(e.initiate({ orderId: "a_b", amountPaisa: 100, description: "x", returnUrl: "https://s" }), /letters, digits/);
  });

  async function successData(overrides: Record<string, string> = {}) {
    const p: Record<string, string> = {
      transaction_code: "000AWEO",
      status: "COMPLETE",
      total_amount: "1000.0",
      transaction_uuid: "ORD-2",
      product_code: "EPAYTEST",
      signed_field_names: "transaction_code,status,total_amount,transaction_uuid,product_code,signed_field_names",
      ...overrides,
    };
    p.signature = await esewaSign(ESEWA_SANDBOX.secretKey, p, p.signed_field_names.split(","));
    return p;
  }

  test("success payload signature verifies; tamper fails; comma variant accepted", async () => {
    const p = await successData();
    const data = toBase64(new TextEncoder().encode(JSON.stringify(p)));
    assert.equal((await e.parseSuccess(data)).signatureValid, true);
    assert.equal((await e.parseSuccess(data.replace(/\+/g, " "))).signatureValid, true); // '+' -> ' ' in query
    const tampered = toBase64(new TextEncoder().encode(JSON.stringify({ ...p, total_amount: "1.0" })));
    assert.equal((await e.parseSuccess(tampered)).signatureValid, false);
    // eSewa signs "1000.0" but displays "1,000.0"
    const shown = toBase64(new TextEncoder().encode(JSON.stringify({ ...p, total_amount: "1,000.0" })));
    assert.equal((await e.parseSuccess(shown)).signatureValid, true);
  });

  test("numeric total_amount is verified against its raw JSON text (1000.0 stays 1000.0)", async () => {
    const p = await successData(); // signed over total_amount=1000.0
    const json = JSON.stringify(p).replace('"total_amount":"1000.0"', '"total_amount":1000.0');
    assert.ok(json.includes('"total_amount":1000.0'));
    assert.equal((await e.parseSuccess(toBase64(new TextEncoder().encode(json)))).signatureValid, true);
  });

  test("verify: status API is authoritative and uses the stored total", async () => {
    mockFetch(() => ({ body: { product_code: "EPAYTEST", transaction_uuid: "ORD-2", total_amount: 1000.0, status: "COMPLETE", ref_id: "0001TS9" } }));
    const p = await successData();
    const v = await e.verify({ orderId: "ORD-2", amountPaisa: 100000, callback: { data: toBase64(new TextEncoder().encode(JSON.stringify(p))) } });
    assert.equal(v.status, "paid");
    assert.equal(v.amountPaisa, 100000);
    assert.equal(v.transactionId, "0001TS9");
    assert.match(calls[0].url, /^https:\/\/rc\.esewa\.com\.np\/api\/epay\/transaction\/status\/\?product_code=EPAYTEST&total_amount=1000&transaction_uuid=ORD-2$/);
  });

  test("verify: callback for another order is rejected", async () => {
    const p = await successData({ transaction_uuid: "OTHER" });
    await assert.rejects(
      e.verify({ orderId: "ORD-2", amountPaisa: 100000, callback: { data: toBase64(new TextEncoder().encode(JSON.stringify(p))) } }),
      /does not match/,
    );
  });

  test("status mapping", async () => {
    for (const [s, n] of [["PENDING", "pending"], ["AMBIGUOUS", "pending"], ["NOT_FOUND", "not_found"], ["FULL_REFUND", "refunded"], ["CANCELED", "canceled"], ["WEIRD", "unknown"]]) {
      mockFetch(() => ({ body: { status: s, total_amount: 10, ref_id: null } }));
      assert.equal((await e.verify({ orderId: "X", amountPaisa: 1000 })).status, n);
    }
  });
});

// ---------------------------------------------------------------- Khalti
describe("khalti", () => {
  const k = khalti({ env: "sandbox", secretKey: "live_secret_key_test", websiteUrl: "https://shop.example" });

  test("initiate: integer paisa, trailing slash, Key header", async () => {
    mockFetch(() => ({ body: { pidx: "PIDX1", payment_url: "https://test-pay.khalti.com/?pidx=PIDX1", expires_at: "x", expires_in: 1800 } }));
    const r = await k.initiate({ orderId: "O1", amountPaisa: 1000, description: "Book", returnUrl: "https://shop.example/r" });
    assert.equal(calls[0].url, "https://dev.khalti.com/api/v2/epayment/initiate/");
    assert.equal(header(calls[0], "Authorization"), "Key live_secret_key_test");
    assert.equal(JSON.parse(String(calls[0].init.body)).amount, 1000);
    assert.equal(r.kind === "redirect" && r.providerRef, "PIDX1");
  });

  test("minimum Rs 10", async () => {
    await assert.rejects(k.initiate({ orderId: "O", amountPaisa: 999, description: "x", returnUrl: "https://r" }), /minimum/);
  });

  test("lookup: Expired arrives as HTTP 400 with a normal body", async () => {
    mockFetch(() => ({ status: 400, body: { pidx: "P", total_amount: 1000, status: "Expired", transaction_id: null, fee: 0, refunded: false } }));
    assert.equal((await k.verify({ orderId: "O", amountPaisa: 1000, providerRef: "P" })).status, "expired");
  });

  test("lookup: Completed / User canceled / Partially Refunded", async () => {
    for (const [s, n] of [["Completed", "paid"], ["User canceled", "canceled"], ["Partially refunded", "partially_refunded"], ["Initiated", "pending"]]) {
      mockFetch(() => ({ body: { pidx: "P", total_amount: 1000, status: s, transaction_id: "T", fee: 0, refunded: false } }));
      assert.equal((await k.verify({ orderId: "O", amountPaisa: 1000, providerRef: "P" })).status, n);
    }
  });

  test("refuses callback pidx that differs from the stored one (replay guard)", async () => {
    await assert.rejects(k.verify({ orderId: "O", amountPaisa: 1000, providerRef: "P", callback: { pidx: "OTHER" } }), /does not match/);
  });

  test("401 surfaces as unauthorized", async () => {
    mockFetch(() => ({ status: 401, body: { detail: "Invalid token.", status_code: 401 } }));
    await assert.rejects(k.verify({ orderId: "O", amountPaisa: 1000, providerRef: "P" }), (e: any) => e.code === "unauthorized");
  });
});

// ---------------------------------------------------------------- Fonepay
describe("fonepay", () => {
  const secret = "a7e3512f5032480a83137793cb2021dc"; // public dev sample (spec v2.0)

  test("response DV test vector (spec v2.0)", async () => {
    assert.equal(
      await fonepayHmac(secret, ["d1580724437729", "NBQM", "true", "successful", "36463", "NICENPKA", "9841845631", "20.0", "30"]),
      "667860224021DF1891F7DE873A37B1DEDA720CCDC43F63BC88F86ED20F579E0DE66526D37C71B1D14A8D466E4B740D17D4FF274CD2819FD6ED2AA3D9A89D7C52",
    );
  });

  test("txnVerification `auth` header matches spec example byte-for-byte", async () => {
    const fp = fonepay({ env: "production", merchantCode: "NBQM", secretKey: secret, username: "gnw71090@zwoho.com", password: "Fonepay@12345" });
    mockFetch(() => ({ body: { paymentStatus: "success", prn: "d1549791827186", requestedAmount: "30", fonepayTraceId: 12847 } }));
    const v = await fp.verify({ orderId: "d1549791827186", amountPaisa: 3000 });
    assert.equal(String(calls[0].init.body), '{"prn": "d1549791827186","merchantCode": "NBQM","amount": "30"}');
    assert.equal(header(calls[0], "auth"), "0d3ebe65246182596de0d417e8e39d37ebe2f5da028c52ae0a33a05062a3bded8a737c3ff82b6f1a6d9442d11cfcb0432d86998af81f481948c0af7b346f4fa2");
    assert.equal(header(calls[0], "Authorization"), "Basic Z253NzEwOTBAendvaG8uY29tOkZvbmVwYXlAMTIzNDU=");
    assert.equal(v.status, "paid");
    assert.equal(v.amountPaisa, 3000);
  });

  test("Dynamic QR dataValidation matches spec example", async () => {
    const fp = fonepay({ env: "production", merchantCode: "NBQM", secretKey: secret, username: "u", password: "p" });
    mockFetch(() => ({ body: { qrMessage: "000201...", status: "CREATED", thirdpartyQrWebSocketUrl: "wss://localhost:8080/x" } }));
    const r = await fp.qrCreate({ orderId: "5d76d323-d1f6", amountPaisa: 1400, remarks1: "test1", remarks2: "test2" });
    assert.equal(
      JSON.parse(String(calls[0].init.body)).dataValidation,
      "5ae718032328ae5615fa4694dfbf3ecd13432bd49031e7285a3f8bc122ecbb8e833e83c7a11f895d30f3e8fd1906317aece113675166ae0d804ecf32a8bbdbaf",
    );
    assert.equal(r.webSocketUrl, "wss://ws.fonepay.com/x"); // localhost host rewritten
  });

  test("initiate: DV over raw values, PRN length enforced, Kathmandu date", async () => {
    const fp = fonepay({ env: "sandbox", merchantCode: "NBQM", secretKey: secret });
    const r = await fp.initiate({ orderId: "NP123", amountPaisa: 1050, description: "Order 1", returnUrl: "https://s.example/r" });
    assert.equal(r.kind, "redirect");
    if (r.kind !== "redirect") return;
    const q = new URL(r.url).searchParams;
    assert.equal(q.get("AMT"), "10.50");
    assert.match(q.get("DT")!, /^\d{2}\/\d{2}\/\d{4}$/);
    assert.equal(q.get("DV"), await fonepayHmac(secret, ["NBQM", "P", "NP123", "10.50", "NPR", q.get("DT")!, "Order 1", "N/A", "https://s.example/r"]));
    await assert.rejects(fp.initiate({ orderId: "X".repeat(26), amountPaisa: 100, description: "x", returnUrl: "https://r" }), /3–25/);
    assert.equal(fonepayDate(new Date("2026-11-04T20:00:00Z")), "11/05/2026"); // already the 5th in Nepal (UTC+5:45)
  });

  test("forged callback without DV cannot force failed (legacy path)", async () => {
    const fp = fonepay({ env: "sandbox", merchantCode: "NBQM", secretKey: secret });
    const forged = { PRN: "NP123", PID: "NBQM", PS: "false", RC: "failed", UID: "x", BC: "y" };
    await assert.rejects(fp.verify({ orderId: "NP123", amountPaisa: 1000, callback: forged }), (e: any) => e.code === "invalid_signature");
    const lax = fonepay({ env: "sandbox", merchantCode: "NBQM", secretKey: secret, strictSignature: false });
    await assert.rejects(lax.verify({ orderId: "NP123", amountPaisa: 1000, callback: forged }), (e: any) => e.code === "verify_unavailable");
  });

  test("legacy verification: upstream 5xx throws instead of reading as failed", async () => {
    const fp = fonepay({ env: "sandbox", merchantCode: "NBQM", secretKey: secret });
    const cb: Record<string, string> = { PRN: "NP123", PID: "NBQM", PS: "true", RC: "successful", UID: "36463", BC: "NICENPKA", INI: "98", P_AMT: "10", R_AMT: "10" };
    cb.DV = await fonepayHmac(secret, ["PRN", "PID", "PS", "RC", "UID", "BC", "INI", "P_AMT", "R_AMT"].map((k) => cb[k]));
    mockFetch(() => ({ status: 502, body: "<html>Bad Gateway</html>" }));
    await assert.rejects(fp.verify({ orderId: "NP123", amountPaisa: 1000, callback: cb }), (e: any) => e.code === "upstream_error");
    mockFetch(() => ({ body: "<response><response_code>successful</response_code><success>true</success></response>" }));
    const v = await fp.verify({ orderId: "NP123", amountPaisa: 1000, callback: cb });
    assert.equal(v.status, "paid");
    assert.equal(v.amountPaisa, 1000);
  });

  test("callback DV verified case-insensitively; tamper rejected", async () => {
    const fp = fonepay({ env: "sandbox", merchantCode: "NBQM", secretKey: secret });
    const cb: Record<string, string> = { PRN: "d1580724437729", PID: "NBQM", PS: "true", RC: "successful", UID: "36463", BC: "NICENPKA", INI: "9841845631", P_AMT: "20.0", R_AMT: "30" };
    cb.DV = (await fonepayHmac(secret, Object.values(cb))).toLowerCase();
    assert.equal(await fp.callbackValid(cb), true);
    assert.equal(await fp.callbackValid({ ...cb, R_AMT: "3" }), false);
  });
});

// ---------------------------------------------------------------- connectIPS
describe("connectips", async () => {
  const kp = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const der = new Uint8Array(await crypto.subtle.exportKey("pkcs8", kp.privateKey));
  const pem = `-----BEGIN PRIVATE KEY-----\n${toBase64(der).match(/.{1,64}/g)!.join("\n")}\n-----END PRIVATE KEY-----`;
  const c = connectips({ env: "sandbox", merchantId: 550, appId: "MER-550-APP-1", appName: "Test", appPassword: "pw", privateKeyPem: pem });

  test("TOKEN is RSA-SHA256 over the documented string, amount in paisa, DD-MM-YYYY", async () => {
    const r = await c.initiate({ orderId: "txn123", amountPaisa: 500, description: "Order, #1", returnUrl: "" });
    assert.equal(r.kind, "form");
    if (r.kind !== "form") return;
    assert.equal(r.fields.TXNAMT, "500");
    assert.match(r.fields.TXNDATE, /^\d{2}-\d{2}-\d{4}$/);
    assert.equal(r.fields.REMARKS, "Order  #1"); // commas stripped: they'd corrupt the token string
    const msg = connectIpsTokenString(r.fields);
    assert.ok(msg.endsWith(",PARTICULARS=Order  #1,TOKEN=TOKEN"));
    const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", kp.publicKey, fromBase64(r.fields.TOKEN) as BufferSource, new TextEncoder().encode(msg));
    assert.equal(ok, true);
  });

  test("TXNID max 20 chars", async () => {
    await assert.rejects(c.initiate({ orderId: "X".repeat(21), amountPaisa: 100, description: "x", returnUrl: "" }), /1–20/);
  });

  test("validatetxn: referenceId = TXNID, Basic auth, status mapping", async () => {
    for (const [status, statusDesc, n] of [["SUCCESS", "TRANSACTION SUCCESSFUL", "paid"], ["FAILED", "TRANSACTION UNSUCCESSFUL", "failed"], ["ERROR", "TRANSACTION NOT FOUND", "not_found"], ["ERROR", "TRANSACTION INCOMPLETE", "pending"]]) {
      mockFetch(() => ({ body: { merchantId: 550, appId: "MER-550-APP-1", referenceId: "txn123", txnAmt: "500", status, statusDesc } }));
      const v = await c.verify({ orderId: "txn123", amountPaisa: 500 });
      assert.equal(v.status, n);
      const body = JSON.parse(String(calls[0].init.body));
      assert.equal(body.referenceId, "txn123");
      assert.equal(body.txnAmt, 500);
      assert.equal(header(calls[0], "Authorization"), "Basic " + btoa("MER-550-APP-1:pw"));
      assert.equal(calls[0].url, "https://uat.connectips.com/connectipswebws/api/creditor/validatetxn");
    }
  });
});

// ---------------------------------------------------------------- NEPALPAY QR
describe("nepalpay", async () => {
  const kp = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const der = new Uint8Array(await crypto.subtle.exportKey("pkcs8", kp.privateKey));
  const pem = `-----BEGIN PRIVATE KEY-----\n${toBase64(der).match(/.{1,64}/g)!.join("\n")}\n-----END PRIVATE KEY-----`;
  const verifySig = (sig: string, msg: string) =>
    crypto.subtle.verify("RSASSA-PKCS1-v1_5", kp.publicKey, fromBase64(sig) as BufferSource, new TextEncoder().encode(msg));
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
    data: { validationTraceId: "2205260000001900KIY", qrString: " 000201010212...6304607F", qrImage: "iVBORw0KGgo=" },
  };

  test("token string: comma-joined, no spaces, userId last", () => {
    assert.equal(
      nepalPayTokenString({ acquirerId: "00001701", merchantId: "17012UVSTIR", merchantCategoryCode: 5021, transactionCurrency: 524, transactionAmount: "10.50", billNumber: "P1", userId: "npiuser" }),
      "00001701,17012UVSTIR,5021,524,10.50,P1,npiuser",
    );
  });

  test("initiate: dynamic QR (12), rupees with 2 decimals, signed token, Basic auth, qr result", async () => {
    mockFetch(() => ({ body: generated }));
    const r = await n.initiate({ orderId: "P1", amountPaisa: 1050, description: "Everest T-shirt, large and blue", returnUrl: "" });
    assert.equal(calls[0].url, "https://devopennpi.connectips.com/qr/generateQR");
    assert.equal(header(calls[0], "Authorization"), "Basic " + btoa("npiuser:pw"));
    const body = JSON.parse(String(calls[0].init.body));
    assert.equal(body.pointOfInitialization, 12);
    assert.equal(body.transactionAmount, "10.50");
    assert.equal(body.transactionCurrency, 524);
    assert.equal(body.billNumber, "P1");
    assert.equal(body.purposeOfTransaction.length, 25);
    assert.equal(body.qrImage, true);
    assert.equal(await verifySig(body.token, "00001701,17012UVSTIR,5021,524,10.50,P1,npiuser"), true);
    assert.deepEqual(
      { kind: r.kind, providerRef: r.providerRef, qrString: r.kind === "qr" && r.qrString, qrImage: r.kind === "qr" && r.qrImage },
      { kind: "qr", providerRef: "2205260000001900KIY", qrString: "000201010212...6304607F", qrImage: "iVBORw0KGgo=" },
    );
    mockFetch(() => ({ body: generated }));
    await n.initiate({ orderId: "P2", amountPaisa: 100000, description: "x", returnUrl: "" });
    assert.equal(JSON.parse(String(calls[0].init.body)).transactionAmount, "1000.00");
  });

  test("initiate: billNumber charset/length, error codes surface", async () => {
    await assert.rejects(n.initiate({ orderId: "X".repeat(26), amountPaisa: 100, description: "x", returnUrl: "" }), /1–25/);
    mockFetch(() => ({ status: 400, body: { responses: [{ responseCode: "E003", responseMessage: "INVALID TOKEN" }] } }));
    await assert.rejects(n.initiate({ orderId: "P1", amountPaisa: 100, description: "x", returnUrl: "" }), (e: PaymentError) => e.code === "E003");
  });

  const txn = (o: Record<string, unknown>) => ({ nQrTxnId: "2312060000059575KMB", amount: 10.5, tranType: "PMT", merchantBillNo: "P1", ...o });
  const report = (rows: unknown[]) => ({ timestamp: "2024-02-07T07:10:47.928+0000", responseCode: "200", responseStatus: "SUCCESS", responseBody: rows });

  test("verify: report by validationTraceId; a success after a failed scan counts", async () => {
    mockFetch(() => ({ body: report([txn({ nQrTxnId: "A", debitStatus: "E001", creditStatus: null }), txn({ nQrTxnId: "B", debitStatus: "000", creditStatus: "DEFER" })]) }));
    const v = await n.verify({ orderId: "P1", amountPaisa: 1050, providerRef: "2205260000001900KIY" });
    assert.equal(calls[0].url, "https://devopennpi.connectips.com/nQR/v1/merchanttxnreport");
    assert.deepEqual(JSON.parse(String(calls[0].init.body)), { validationTraceId: "2205260000001900KIY", merchantId: "17012UVSTIR", acquirerId: "00001701" });
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
      assert.equal((await n.verify({ orderId: "P1", amountPaisa: 1050, providerRef: "T" })).status, want);
    }
    await assert.rejects(n.verify({ orderId: "P1", amountPaisa: 1050 }), (e: PaymentError) => e.code === "missing_provider_ref");
  });

  test("oauth: password grant once, Bearer reused until expiry", async () => {
    const o = nepalpay({ ...base, auth: "oauth", clientId: "cid", clientSecret: "csec" });
    mockFetch((url) => (url.endsWith("/oauth/token") ? { body: { access_token: "AT1", token_type: "bearer", expires_in: 299 } } : { body: report([]) }));
    await o.verify({ orderId: "P1", amountPaisa: 100, providerRef: "T" });
    await o.verify({ orderId: "P1", amountPaisa: 100, providerRef: "T" });
    assert.equal(calls.length, 3);
    assert.equal(header(calls[0], "Authorization"), "Basic " + btoa("cid:csec"));
    assert.equal(String(calls[0].init.body), "grant_type=password&username=npiuser&password=pw");
    assert.equal(header(calls[1], "Authorization"), "Bearer AT1");
    assert.equal(header(calls[2], "Authorization"), "Bearer AT1");
  });

  test("confirm-payment reply is signed over txnDate,status,message,merchantBillNo,paymentRef", async () => {
    const r = await n.confirmationResponse({ txnDate: "2024-11-10 01:35:31", merchantBillNo: "P1", paymentRef: "2411100000067378ZHU" });
    assert.equal(await verifySig(r.signature, "2024-11-10 01:35:31,SUCCESS,TRANSACTION SUCCESSFUL,P1,2411100000067378ZHU"), true);
    assert.equal(n.orderIdFromCallback({ merchantBillNo: "P1" }), "P1");
  });

  const spki = `-----BEGIN PUBLIC KEY-----\n${toBase64(new Uint8Array(await crypto.subtle.exportKey("spki", kp.publicKey)))}\n-----END PUBLIC KEY-----`;
  const withNchl = nepalpay({ ...base, nchlPublicKeyPem: spki, wsUrl: "wss://ws.example/nqrws", wsUsername: "wsuser", wsApiToken: "secret-api-token" });

  test("confirm-payment notification: signature over the documented string, payerMobile fallback", async () => {
    const note: Record<string, unknown> = {
      merchantBillNo: "NA", merchantId: "0010SVQNL9H", merchantName: "Quantum Labs", paymentRef: "2411100000067378ZHU",
      channel: "CIPS", payerMobile: "+977-9843705813", sessionNo: "5446", status: "SUCCESS",
    };
    const msg = "NA,0010SVQNL9H,Quantum Labs,2411100000067378ZHU,CIPS,+977-9843705813,5446";
    assert.equal(nepalPayConfirmationString(note), msg);
    const sig = toBase64(new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", kp.privateKey, new TextEncoder().encode(msg))));
    assert.equal(await withNchl.verifyConfirmation({ ...note, signature: sig }), true);
    assert.equal(await withNchl.verifyConfirmation({ ...note, sessionNo: "5447", signature: sig }), false);
    assert.equal(await withNchl.verifyConfirmation({ ...note, signature: "not base64!" }), false);
    assert.equal(await withNchl.verifyConfirmation(note), false);
    await assert.rejects(n.verifyConfirmation(note), /nchlPublicKeyPem/);
  });

  test("WebSocket request: destinations, terminal as merchant_id, api_token RSA PKCS#1 v1.5 encrypted", async () => {
    const w = await withNchl.webSocketRequest("2205260000001900KIY");
    assert.deepEqual(
      { url: w.url, subscribe: w.subscribe, send: w.send, merchant_id: w.body.merchant_id, request_id: w.body.request_id, username: w.body.username },
      { url: "wss://ws.example/nqrws", subscribe: "/user/nqrws/check-txn-status", send: "/nqrws/check-txn-status", merchant_id: "Terminal1", request_id: "2205260000001900KIY", username: "wsuser" },
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
    assert.notEqual((await withNchl.webSocketRequest("X")).body.api_token, (await withNchl.webSocketRequest("X")).body.api_token);
    await assert.rejects(n.webSocketRequest("X"), /wsUrl/);
    await assert.rejects(rsaPkcs1EncryptBase64(spki, "x".repeat(246)), /too long/);
  });
});

// ---------------------------------------------------------------- Hamro Pay
describe("hamropay", () => {
  const cfg = { env: "sandbox" as const, merchantId: "PN_-Nd99TBnAlBjCgl8ef_b", clientId: "client@123", clientApiKey: "merchant-api-key-test", clientSecret: "abcdefg", webhookSecret: "whsec" };
  const h = hamropay(cfg);
  const node = (secret: string, msg: string) => createHmac("sha512", secret).update(msg, "utf8").digest("base64");

  test("signature: base64 HMAC-SHA512 over comma-joined values; commas refused", async () => {
    assert.equal(await hamroPaySign("abcdefg", ["T1", "1000", "M", "C", "K"]), node("abcdefg", "T1,1000,M,C,K"));
    await assert.rejects(hamroPaySign("s", ["a,b"]), /commas/);
  });

  test("initiate: Create Session signed in headers, then a signed gateway form", async () => {
    mockFetch(() => ({ body: { sessionId: "ca8f7b70-b9c9-11ee-8611-0a73743c8233", merchantId: cfg.merchantId } }));
    const r = await h.initiate({ orderId: "P1", amountPaisa: 8992, description: "T-shirt", returnUrl: "https://shop.example/ok", failureUrl: "https://shop.example/no" });
    assert.equal(calls[0].url, "https://uat-payclient.hamropatro.com/v1/checkout/sessionId");
    assert.equal(header(calls[0], "Client-Id"), "client@123");
    assert.equal(header(calls[0], "Client-API-Key"), "merchant-api-key-test");
    assert.equal(header(calls[0], "Connection"), "close");
    assert.equal(header(calls[0], "Signature"), node("abcdefg", `P1,8992,${cfg.merchantId},client@123,merchant-api-key-test`));
    const body = JSON.parse(String(calls[0].init.body));
    assert.deepEqual(
      [body.merchantTxnId, body.transactionAmount, body.successRedirectionUrl, body.failedRedirectionUrl, body.productList[0].price],
      ["P1", "8992", "https://shop.example/ok", "https://shop.example/no", 89.92],
    );
    assert.equal(r.kind, "form");
    if (r.kind !== "form") return;
    assert.equal(r.action, "https://uat-checkout-pay.hamropatro.com/api/checkout");
    assert.equal(r.providerRef, "ca8f7b70-b9c9-11ee-8611-0a73743c8233");
    assert.equal(r.fields.token, node("abcdefg", `${cfg.merchantId},P1,ca8f7b70-b9c9-11ee-8611-0a73743c8233,8992,client@123,merchant-api-key-test`));
    assert.deepEqual(Object.keys(r.fields), ["merchant_id", "session_id", "token", "merchant_transaction_id", "remarks"]);
  });

  test("initiate: Rs 10..50,000, 25-char id, live gateway required, merchant echo checked", async () => {
    await assert.rejects(h.initiate({ orderId: "P1", amountPaisa: 999, description: "x", returnUrl: "https://a/" }), /Rs 10/);
    await assert.rejects(h.initiate({ orderId: "P1", amountPaisa: 5_000_001, description: "x", returnUrl: "https://a/" }), /Rs 10/);
    await assert.rejects(h.initiate({ orderId: "X".repeat(26), amountPaisa: 1000, description: "x", returnUrl: "https://a/" }), /1–25/);
    await assert.rejects(hamropay({ ...cfg, env: "production" }).initiate({ orderId: "P1", amountPaisa: 1000, description: "x", returnUrl: "https://a/" }), /gatewayUrl/);
    mockFetch(() => ({ body: { sessionId: "S", merchantId: "SOMEONE_ELSE" } }));
    await assert.rejects(h.initiate({ orderId: "P1", amountPaisa: 1000, description: "x", returnUrl: "https://a/" }), (e: PaymentError) => e.code === "merchant_mismatch");
    mockFetch(() => ({ status: 401, body: { code: 16, message: "Unauthorized Request", details: [] } }));
    await assert.rejects(h.initiate({ orderId: "P1", amountPaisa: 1000, description: "x", returnUrl: "https://a/" }), (e: PaymentError) => e.code === "unauthorized");
  });

  test("verify: Get Transaction signed, status mapping, rupees to paisa, id echo checked", async () => {
    const cases: [Record<string, unknown>, string, number | null][] = [
      [{ merchantTxnId: "P1", status: "COMPLETED", amount: 89.92, trackingId: "TRK1" }, "paid", 8992],
      [{ merchantTransactionId: "P1", status: "PROCESSING", amount: 0 }, "pending", null],
      [{ merchantTxnId: "P1", status: "FAILED", amount: 0 }, "failed", null],
      [{ merchantTransactionId: "P1", trackingId: "", status: "NOT_INITIATED", amount: 0, message: "TRANSACTION NOT INITIATED YET" }, "not_found", null],
      [{ merchantTxnId: "P1", status: "SOMETHING_NEW" }, "unknown", null],
    ];
    for (const [body, want, amt] of cases) {
      mockFetch(() => ({ body }));
      const v = await h.verify({ orderId: "P1", amountPaisa: 8992 });
      assert.deepEqual([v.status, v.amountPaisa], [want, amt]);
      assert.equal(calls[0].url, "https://uat-payclient.hamropatro.com/v1/checkout/transaction");
      assert.equal(header(calls[0], "Signature"), node("abcdefg", `P1,${cfg.merchantId},client@123,merchant-api-key-test`));
      assert.deepEqual(JSON.parse(String(calls[0].init.body)), { merchantId: cfg.merchantId, merchantTxnId: "P1" });
    }
    mockFetch(() => ({ body: { merchantTxnId: "P2", status: "COMPLETED", amount: 89.92 } }));
    await assert.rejects(h.verify({ orderId: "P1", amountPaisa: 8992 }), (e: PaymentError) => e.code === "id_mismatch");
    assert.equal(h.orderIdFromCallback({ MerchantTxnId: "P1" }), "P1");
  });

  test("webhook: signature over merchantTxnId,merchantId,status,amount in any rendering of the amount", async () => {
    const body = { merchantTxnId: "P1", merchantId: cfg.merchantId, amount: 1200, status: "COMPLETED", metadata: {} };
    for (const a of ["1200", "1200.0", "1200.00"]) {
      assert.equal(await h.verifyWebhook(body, node("whsec", `P1,${cfg.merchantId},COMPLETED,${a}`)), true);
    }
    assert.equal(await h.verifyWebhook({ ...body, amount: 1.5 }, node("whsec", `P1,${cfg.merchantId},COMPLETED,1.50`)), true);
    assert.equal(await h.verifyWebhook({ ...body, amount: 1201 }, node("whsec", `P1,${cfg.merchantId},COMPLETED,1200`)), false);
    assert.equal(await h.verifyWebhook({ ...body, amount: "1200" as unknown as number }, node("whsec", `P1,${cfg.merchantId},COMPLETED,1200`)), false);
    assert.equal(await h.verifyWebhook(body, null), false);
    await assert.rejects(hamropay({ ...cfg, webhookSecret: undefined }).verifyWebhook(body, "x"), /webhookSecret/);
  });
});

// ---------------------------------------------------------------- GetPay (NCHL cards)
describe("getpay", () => {
  const cfg = {
    env: "sandbox" as const,
    papInfo: btoa(JSON.stringify({ institutionId: "122", mid: "123123451770986", tid: "12358762" })),
    oprKey: "4fa4c6b9-3f91-43e5-9b4f-319f68187ba5",
    websiteDomain: "https://shop.example",
    businessName: "Shop",
    imageUrl: "https://shop.example/logo.png",
  };
  const g = getpay(cfg);
  const base = "https://uat-bank-getpay.nchl.com.np/ecom-web-checkout/v1/secure-merchant/transactions";
  const id = "0cc5b1a39f3c4cad864bc1c6a524534f";
  const secret = createHash("sha256").update(cfg.oprKey + id).digest("base64");
  const token = btoa(JSON.stringify({ id, oprSecret: secret }));
  const ok = (data: Record<string, unknown>) => ({ body: { status: 0, message: "SUCCESS", data } });

  test("oprSecret = base64(SHA-256(oprKey + id)); token decodes from JSON or id:secret", async () => {
    assert.equal(await getPayOprSecret(cfg.oprKey, id), secret);
    assert.deepEqual(getPayDecodeToken(token), { id, oprSecret: secret });
    assert.deepEqual(getPayDecodeToken(btoa(`${id}:${secret}`)), { id, oprSecret: secret });
    assert.equal(getPayDecodeToken("%%%"), null);
    assert.equal(getPayDecodeToken(btoa(JSON.stringify({ id }))), null);
  });

  test("initiate: SDK options with a numeric price, clientRequestId and same-origin callbacks", async () => {
    const r = await g.initiate({ orderId: "P1", amountPaisa: 120050, description: "Cup <set>", returnUrl: "https://shop.example/ok/P1", failureUrl: "https://shop.example/no/P1" });
    assert.equal(r.kind, "sdk");
    if (r.kind !== "sdk") return;
    assert.equal(r.scriptUrl, "https://minio-getpay.nchl.com.np/getpay-cdn/webcheckout/v5/bundle.js");
    assert.equal(r.options.price, 1200.5);
    assert.equal(r.options.clientRequestId, "P1");
    assert.equal(r.options.baseUrl, base);
    assert.equal(r.options.insKey, "");
    assert.deepEqual(r.options.callbackUrl, { successUrl: "https://shop.example/ok/P1", failUrl: "https://shop.example/no/P1" });
    assert.match(String(r.options.orderInformationUI), /Cup &lt;set&gt;/);
    await assert.rejects(g.initiate({ orderId: "P1", amountPaisa: 100, description: "x", returnUrl: "https://evil.example/ok" }), (e: PaymentError) => e.code === "invalid_callback_url");
    const page = g.checkoutPage(r, "/pay/P1</script>");
    assert.match(page, /new GetPay\(o\)\.initialize\(\)/);
    assert.ok(!page.includes("</script>\"") && page.includes("\\u003c/script>"));
    assert.match(g.paymentPage(), /<div id="checkout"><\/div>/);
    assert.match(g.returnPage("/payments/getpay/return/P1"), /window\.top\.location/);
  });

  test("verify with token: oprSecret checked, merchant-status, clientId must be this order", async () => {
    mockFetch(() => ok({ status: "SUCCESS", amount: 1200.0, currency: "NPR", stan: "379832", crrn: "624503379832", clientId: "P1", remarks: "Success" }));
    const v = await g.verify({ orderId: "P1", amountPaisa: 120000, callback: { token } });
    assert.deepEqual([v.status, v.amountPaisa, v.transactionId], ["paid", 120000, id]);
    assert.equal(calls[0].url, `${base}/merchant-status`);
    assert.deepEqual(JSON.parse(String(calls[0].init.body)), { id, papInfo: cfg.papInfo });

    mockFetch(() => ok({ status: "SUCCESS", amount: 1200.0, clientId: "SOMEONE-ELSES-ORDER" }));
    await assert.rejects(g.verify({ orderId: "P1", amountPaisa: 120000, callback: { token } }), (e: PaymentError) => e.code === "id_mismatch");

    const forged = btoa(JSON.stringify({ id, oprSecret: btoa("not the hash") }));
    await assert.rejects(g.verify({ orderId: "P1", amountPaisa: 120000, callback: { token: forged } }), (e: PaymentError) => e.code === "bad_signature");
    await assert.rejects(g.verify({ orderId: "P1", amountPaisa: 120000, callback: { token: "@@" } }), (e: PaymentError) => e.code === "malformed_callback");

    mockFetch(() => ok({ status: "FAILED", amount: 1200.0, clientId: "P1" }));
    assert.equal((await g.verify({ orderId: "P1", amountPaisa: 120000, callback: { token } })).status, "failed");
    mockFetch(() => ({ status: 400, body: { status: -1, message: `Failed to fetch merchant information: Transaction not found for ID: ${id}` } }));
    assert.equal((await g.verify({ orderId: "P1", amountPaisa: 120000, callback: { token } })).status, "not_found");
  });

  test("verify without token: statement by clientRequestId; a success there is unknown, never paid", async () => {
    mockFetch(() => ok({ transactionId: id, clientRequestId: "P1", saleTransactionAmount: 1200.0, status: "SUCCESS", paymentScheme: "MASTERCARD" }));
    const v = await g.verify({ orderId: "P1", amountPaisa: 120000 });
    assert.deepEqual([v.status, v.amountPaisa, v.transactionId], ["unknown", 120000, id]);
    assert.equal(calls[0].url, `${base}/transaction-statement`);
    assert.deepEqual(JSON.parse(String(calls[0].init.body)), { clientRequestId: "P1" });
    mockFetch(() => ok({ transactionId: id, clientRequestId: "P1", saleTransactionAmount: 1200.0, status: "FAILED" }));
    assert.equal((await g.verify({ orderId: "P1", amountPaisa: 120000 })).status, "failed");
    mockFetch(() => ({ status: 400, body: { status: -1, message: "Failed to fetch transaction statement: Transaction not found for transaction ID: x" } }));
    assert.equal((await g.verify({ orderId: "P1", amountPaisa: 120000 })).status, "not_found");
    mockFetch(() => ({ status: 500, body: "oops" }));
    await assert.rejects(g.verify({ orderId: "P1", amountPaisa: 120000 }), PaymentError);
  });
});

// ---------------------------------------------------------------- CyberSource
describe("cybersource", () => {
  test("Secure Acceptance signature worked example", async () => {
    const f: Record<string, string> = {
      access_key: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6",
      profile_id: "PROFILE-0001",
      transaction_uuid: "7f9c2b1e-5d1a-4c3b-9e8f-1a2b3c4d5e6f",
      signed_field_names: "access_key,profile_id,transaction_uuid,signed_field_names,unsigned_field_names,signed_date_time,locale,transaction_type,reference_number,amount,currency",
      unsigned_field_names: "",
      signed_date_time: "2026-11-04T10:15:30Z",
      locale: "en-us",
      transaction_type: "sale",
      reference_number: "ORDER-1001",
      amount: "1500.00",
      currency: "NPR",
    };
    assert.equal(await cybersourceSign("test_secret_key_do_not_use", f), "QRwjaW8ysHR/UGyQ0LqSIHiGTvnNebKSwwsFRmn4Weg=");
  });

  const cs = cybersource({ env: "sandbox", profileId: "P", accessKey: "A", secretKey: "S" });
  async function response(o: Record<string, string>) {
    const p: Record<string, string> = { req_reference_number: "ORD-1", req_currency: "NPR", req_transaction_type: "sale", transaction_id: "7000", ...o };
    p.signed_field_names = [...Object.keys(p), "signed_field_names"].join(",");
    p.signature = await cybersourceSign("S", p);
    return p;
  }

  test("decisions map correctly; unsigned extra fields ignored; tamper rejected", async () => {
    assert.equal((await cs.verify({ orderId: "ORD-1", amountPaisa: 150000, callback: await response({ decision: "ACCEPT", reason_code: "100", auth_amount: "1500.00" }) })).status, "paid");
    assert.equal((await cs.verify({ orderId: "ORD-1", amountPaisa: 150000, callback: await response({ decision: "DECLINE", reason_code: "203" }) })).status, "failed");
    assert.equal((await cs.verify({ orderId: "ORD-1", amountPaisa: 150000, callback: await response({ decision: "REVIEW", reason_code: "200" }) })).status, "pending");
    assert.equal((await cs.verify({ orderId: "ORD-1", amountPaisa: 150000, callback: await response({ decision: "CANCEL", reason_code: "" }) })).status, "canceled");
    const ok = await response({ decision: "ACCEPT", reason_code: "100", auth_amount: "1500.00" });
    const v = await cs.verify({ orderId: "ORD-1", amountPaisa: 150000, callback: { ...ok, injected: "x" } });
    assert.equal((v.raw as any).injected, undefined);
    await assert.rejects(cs.verify({ orderId: "ORD-1", amountPaisa: 150000, callback: { ...ok, auth_amount: "1.00" } }), /invalid response signature/);
    await assert.rejects(cs.verify({ orderId: "ORD-2", amountPaisa: 150000, callback: ok }), /different order/);
    // signed-but-empty auth_amount falls back to req_amount (same as Python)
    const empty = await response({ decision: "ACCEPT", reason_code: "100", auth_amount: "", req_amount: "1500.00" });
    assert.equal((await cs.verify({ orderId: "ORD-1", amountPaisa: 150000, callback: empty })).amountPaisa, 150000);
  });

  test("initiate signs every field incl. bill_to and sends unsigned_field_names empty", async () => {
    const r = await cs.initiate({
      orderId: "ORD-1", amountPaisa: 150000, description: "x", returnUrl: "https://r",
      billTo: { forename: "Ram", surname: "Sharma", email: "r@e.com", addressLine1: "Thamel", city: "Kathmandu", country: "NP" },
    });
    if (r.kind !== "form") return assert.fail();
    assert.equal(r.fields.amount, "1500.00");
    assert.equal(r.fields.unsigned_field_names, "");
    assert.match(r.fields.signed_date_time, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    assert.ok(r.fields.signed_field_names.includes("bill_to_address_country"));
    assert.equal(r.fields.signature, await cybersourceSign("S", r.fields));
  });
});

// ---------------------------------------------------------------- NPS
describe("nps", () => {
  test("signature = HMAC-SHA512 hex of values of alphabetically sorted keys, no separator", async () => {
    const p = { MerchantTxnId: "T1", MerchantName: "TestMerchant", Amount: "100", MerchantId: "9" };
    const expected = createHmac("sha512", "secret").update("100" + "9" + "TestMerchant" + "T1").digest("hex");
    assert.equal(await npsSign("secret", p), expected);
    assert.equal(await npsSign("secret", { MerchantId: "9", MerchantName: "TestMerchant" }), createHmac("sha512", "secret").update("9TestMerchant").digest("hex"));
  });

  const n = nps({ env: "sandbox", merchantId: "9", merchantName: "TestMerchant", apiUsername: "u", apiPassword: "p", secretKey: "secret" });

  test("initiate: GetProcessId then multipart form with matching Amount/MerchantTxnId", async () => {
    mockFetch(() => ({ body: { code: "0", message: "Success", errors: [], data: { ProcessId: "PROC_1" } } }));
    const r = await n.initiate({ orderId: "T1", amountPaisa: 10000, description: "x", returnUrl: "https://r" });
    assert.equal(calls[0].url, "https://apisandbox.nepalpayment.com/GetProcessId");
    const sent = JSON.parse(String(calls[0].init.body));
    assert.equal(sent.Signature, await npsSign("secret", { MerchantId: "9", MerchantName: "TestMerchant", Amount: "100", MerchantTxnId: "T1" }));
    if (r.kind !== "form") return assert.fail();
    assert.equal(r.enctype, "multipart/form-data");
    assert.equal(r.fields.Amount, "100");
    assert.equal(r.fields.ProcessId, "PROC_1");
    assert.equal(r.action, "https://gatewaysandbox.nepalpayment.com/Payment/Index");
  });

  test("status: code 0 + Fail is a failed payment; error_code 3 is not_found", async () => {
    mockFetch(() => ({ body: { code: "0", message: "", errors: [], data: { Status: "Fail", Amount: "100", MerchantTxnId: "T1" } } }));
    assert.equal((await n.verify({ orderId: "T1", amountPaisa: 10000 })).status, "failed");
    mockFetch(() => ({ body: { code: "0", message: "", errors: [], data: { Status: "Success", Amount: "100.00", MerchantTxnId: "T1", GatewayReferenceNo: "G1" } } }));
    const v = await n.verify({ orderId: "T1", amountPaisa: 10000 });
    assert.equal(v.status, "paid");
    assert.equal(v.amountPaisa, 10000);
    mockFetch(() => ({ body: { code: "1", message: "", errors: [{ error_code: "3", error_message: "Transaction not initialized yet" }], data: null } }));
    assert.equal((await n.verify({ orderId: "T1", amountPaisa: 10000 })).status, "not_found");
  });
});

// ---------------------------------------------------------------- IME Pay
describe("imepay", () => {
  const i = imepay({ env: "sandbox", merchantCode: "MC", username: "u", password: "p", module: "MOD" });

  test("GetToken + checkout payload format (official plugin)", async () => {
    mockFetch(() => ({ body: { TokenId: "TK1", ResponseCode: 0 } }));
    const r = await i.initiate({ orderId: "R1", amountPaisa: 10000, description: "x", returnUrl: "https://s/ok", failureUrl: "https://s/no" });
    assert.equal(calls[0].url, "https://stg.imepay.com.np:7979/api/Web/GetToken");
    assert.equal(header(calls[0], "Module"), btoa("MOD"));
    assert.deepEqual(JSON.parse(String(calls[0].init.body)), { MerchantCode: "MC", Amount: "100.00", RefId: "R1" });
    if (r.kind !== "redirect") return assert.fail();
    const data = new URL(r.url).searchParams.get("data")!;
    assert.equal(atob(data), "TK1|MC|R1|100.00|POST|https://s/ok|https://s/no");
  });

  test("Recheck: 0 = paid; anything else stays pending (sources disagree)", async () => {
    mockFetch(() => ({ body: { ResponseCode: 0, RefId: "R1", TranAmount: "100.00", TransactionId: "X9" } }));
    assert.equal((await i.verify({ orderId: "R1", amountPaisa: 10000, providerRef: "TK1" })).status, "paid");
    mockFetch(() => ({ body: { ResponseCode: 1, RefId: "R1" } }));
    assert.equal((await i.verify({ orderId: "R1", amountPaisa: 10000, providerRef: "TK1" })).status, "pending");
    mockFetch(() => ({ body: { ResponseCode: 0, RefId: "R1", TranAmount: "" } }));
    assert.equal((await i.verify({ orderId: "R1", amountPaisa: 10000, providerRef: "TK1" })).amountPaisa, null); // -> review, no throw
  });
});


// ---------------------------------------------------------------- regressions (TODO.md correctness list)
describe("regressions", () => {
  const e = esewa({ env: "sandbox", ...ESEWA_SANDBOX });
  const b64 = (s: string) => toBase64(new TextEncoder().encode(s));
  const isPaymentError = (code: string, httpStatus?: number) => (err: unknown) =>
    err instanceof PaymentError && err.code === code && err.httpStatus === httpStatus;

  test("paisaToRupees keeps the sign below one rupee", () => {
    assert.equal(paisaToRupees(-5), "-0.05");
    assert.equal(paisaToRupees(-99), "-0.99");
    assert.equal(paisaToRupees(-100), "-1");
    assert.equal(paisaToRupees(-12345), "-123.45");
  });

  test("rupeesToPaisa rejects exponent and explicit plus forms", () => {
    for (const bad of ["1e3", "+5", "NaN", ""]) assert.throws(() => rupeesToPaisa(bad), /not a rupee amount/);
  });

  test("basicAuth encodes UTF-8 credentials", () => {
    assert.equal(basicAuth("ü", "पासवर्ड"), "Basic " + Buffer.from("ü:पासवर्ड").toString("base64"));
  });

  test("newOrderId uses only the 36-symbol alphabet", () => {
    for (let i = 0; i < 200; i++) assert.match(newOrderId(), /^P[0-9A-Z]{18,19}$/);
  });

  test("provider lookup ignores Object.prototype keys", () => {
    const payments = createPayments({ esewa: { env: "sandbox", ...ESEWA_SANDBOX } });
    for (const id of ["constructor", "__proto__", "toString"]) assert.throws(() => payments.adapter(id), /not configured/);
    assert.equal(payments.adapter("esewa").id, "esewa");
  });

  test("status tables ignore Object.prototype keys", async () => {
    for (const s of ["constructor", "__proto__", "toString"]) {
      mockFetch(() => ({ body: { status: s, total_amount: 10, ref_id: null } }));
      assert.equal((await e.verify({ orderId: "X", amountPaisa: 1000 })).status, "unknown");
    }
  });

  test("eSewa: malformed success data is a 400, not a raw SyntaxError", async () => {
    for (const data of ["!!!!", b64("not json"), b64("{")]) {
      await assert.rejects(e.parseSuccess(data), isPaymentError("malformed_callback", 400));
      await assert.rejects(e.verify({ orderId: "X", amountPaisa: 1000, callback: { data } }), isPaymentError("malformed_callback", 400));
    }
  });

  test("eSewa: error body read from error_message or errorMessage", async () => {
    mockFetch(() => ({ status: 503, body: { code: 0, errorMessage: "Service is currently unavailable" } }));
    await assert.rejects(e.verify({ orderId: "X", amountPaisa: 1000 }), (err: unknown) =>
      isPaymentError("esewa_0", 503)(err) && /Service is currently unavailable/.test((err as Error).message));
    mockFetch(() => ({ status: 400, body: { code: "IP-400", error_message: "Invalid Signature" } }));
    await assert.rejects(
      e.intentBook({ orderId: "X", amountPaisa: 10000, callbackUrl: "https://c", redirectUrl: "https://r" }),
      (err: unknown) => isPaymentError("esewa_IP-400", 400)(err) && /Invalid Signature/.test((err as Error).message),
    );
    mockFetch(() => ({ status: 502, body: "<html>bad gateway</html>" }));
    await assert.rejects(e.verify({ orderId: "X", amountPaisa: 1000 }), isPaymentError("http_502", 502));
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
    assert.equal(await e.intentCallbackValid({ ...base, amount: null, signed_field_names: names, signature: sigNull }), true);
    assert.equal(await e.intentCallbackValid(raw.replace("100.0", "1.0")), false);
    assert.equal(await e.intentCallbackValid("not json"), false);
    assert.equal(await e.intentCallbackValid("[1]"), false);
  });

  test("NPS: code 0 with null data is unknown, not a TypeError", async () => {
    const n = nps({ env: "sandbox", merchantId: "9", merchantName: "M", apiUsername: "u", apiPassword: "p", secretKey: "s" });
    mockFetch(() => ({ body: { code: "0", message: "", errors: [], data: null } }));
    const v = await n.verify({ orderId: "T1", amountPaisa: 10000 });
    assert.equal(v.status, "unknown");
    assert.equal(v.amountPaisa, null);
  });

  test("connectIPS: txnAmt null is null, empty referenceId/remarks fall back", async () => {
    const kp = await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["sign"],
    );
    const der = new Uint8Array(await crypto.subtle.exportKey("pkcs8", kp.privateKey));
    const pem = `-----BEGIN PRIVATE KEY-----\n${toBase64(der)}\n-----END PRIVATE KEY-----`;
    const c = connectips({ env: "sandbox", merchantId: 550, appId: "A", appName: "T", appPassword: "pw", privateKeyPem: pem });
    mockFetch(() => ({ body: { status: "ERROR", statusDesc: "TRANSACTION NOT FOUND", txnAmt: null } }));
    assert.equal((await c.verify({ orderId: "T1", amountPaisa: 500 })).amountPaisa, null);
    const r = await c.initiate({ orderId: "T1", amountPaisa: 500, description: "Shoes", returnUrl: "", referenceId: "", remarks: "" });
    if (r.kind !== "form") return assert.fail();
    assert.equal(r.fields.REFERENCEID, "T1");
    assert.equal(r.fields.REMARKS, "Shoes");
  });

  test("CyberSource: empty req_reference_number falls back to req_transaction_uuid", async () => {
    const cs = cybersource({ env: "sandbox", profileId: "p", accessKey: "a", secretKey: "s" });
    const p: Record<string, string> = { decision: "ACCEPT", reason_code: "100", req_reference_number: "", req_transaction_uuid: "T1", req_amount: "10.00", req_currency: "NPR", transaction_id: "X1" };
    p.signed_field_names = [...Object.keys(p), "signed_field_names"].join(",");
    p.signature = await cybersourceSign("s", p);
    assert.equal((await cs.verify({ orderId: "T1", amountPaisa: 1000, callback: p })).status, "paid");
  });
});

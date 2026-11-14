/** Fonepay: spec v2.0 / Dynamic QR v1.1 signature vectors, redirect DV, verification paths. */
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { fonepay, fonepayDate, fonepayHmac, PaymentError } from "../../src/index.ts";
import { calls, header, mockFetch, restoreFetch } from "../helpers.ts";

afterEach(restoreFetch);

describe("fonepay", () => {
  const secret = "a7e3512f5032480a83137793cb2021dc"; // public dev sample (spec v2.0)

  test("response DV test vector (spec v2.0)", async () => {
    assert.equal(
      await fonepayHmac(secret, [
        "d1580724437729",
        "NBQM",
        "true",
        "successful",
        "36463",
        "NICENPKA",
        "9841845631",
        "20.0",
        "30",
      ]),
      "667860224021DF1891F7DE873A37B1DEDA720CCDC43F63BC88F86ED20F579E0DE66526D37C71B1D14A8D466E4B740D17D4FF274CD2819FD6ED2AA3D9A89D7C52",
    );
  });

  test("txnVerification `auth` header matches spec example byte-for-byte", async () => {
    const fp = fonepay({
      env: "production",
      merchantCode: "NBQM",
      secretKey: secret,
      username: "gnw71090@zwoho.com",
      password: "Fonepay@12345",
    });
    mockFetch(() => ({
      body: {
        paymentStatus: "success",
        prn: "d1549791827186",
        requestedAmount: "30",
        fonepayTraceId: 12847,
      },
    }));
    const v = await fp.verify({ orderId: "d1549791827186", amountPaisa: 3000 });
    assert.equal(
      String(calls[0].init.body),
      '{"prn": "d1549791827186","merchantCode": "NBQM","amount": "30"}',
    );
    assert.equal(
      header(calls[0], "auth"),
      "0d3ebe65246182596de0d417e8e39d37ebe2f5da028c52ae0a33a05062a3bded8a737c3ff82b6f1a6d9442d11cfcb0432d86998af81f481948c0af7b346f4fa2",
    );
    assert.equal(
      header(calls[0], "Authorization"),
      "Basic Z253NzEwOTBAendvaG8uY29tOkZvbmVwYXlAMTIzNDU=",
    );
    assert.equal(v.status, "paid");
    assert.equal(v.amountPaisa, 3000);
  });

  test("Dynamic QR dataValidation matches spec example", async () => {
    const fp = fonepay({
      env: "production",
      merchantCode: "NBQM",
      secretKey: secret,
      username: "u",
      password: "p",
    });
    mockFetch(() => ({
      body: {
        qrMessage: "000201...",
        status: "CREATED",
        thirdpartyQrWebSocketUrl: "wss://localhost:8080/x",
      },
    }));
    const r = await fp.qrCreate({
      orderId: "5d76d323-d1f6",
      amountPaisa: 1400,
      remarks1: "test1",
      remarks2: "test2",
    });
    assert.equal(
      JSON.parse(String(calls[0].init.body)).dataValidation,
      "5ae718032328ae5615fa4694dfbf3ecd13432bd49031e7285a3f8bc122ecbb8e833e83c7a11f895d30f3e8fd1906317aece113675166ae0d804ecf32a8bbdbaf",
    );
    assert.equal(r.webSocketUrl, "wss://ws.fonepay.com/x"); // localhost host rewritten
  });

  test("initiate: DV over raw values, PRN length enforced, Kathmandu date", async () => {
    const fp = fonepay({ env: "sandbox", merchantCode: "NBQM", secretKey: secret });
    const r = await fp.initiate({
      orderId: "NP123",
      amountPaisa: 1050,
      description: "Order 1",
      returnUrl: "https://s.example/r",
    });
    assert.equal(r.kind, "redirect");
    if (r.kind !== "redirect") return;
    const q = new URL(r.url).searchParams;
    assert.equal(q.get("AMT"), "10.50");
    assert.match(q.get("DT")!, /^\d{2}\/\d{2}\/\d{4}$/);
    assert.equal(
      q.get("DV"),
      await fonepayHmac(secret, [
        "NBQM",
        "P",
        "NP123",
        "10.50",
        "NPR",
        q.get("DT")!,
        "Order 1",
        "N/A",
        "https://s.example/r",
      ]),
    );
    await assert.rejects(
      fp.initiate({
        orderId: "X".repeat(26),
        amountPaisa: 100,
        description: "x",
        returnUrl: "https://r",
      }),
      /3–25/,
    );
    // already the 5th in Nepal (UTC+5:45)
    assert.equal(fonepayDate(new Date("2026-11-04T20:00:00Z")), "11/05/2026");
  });

  test("forged callback without DV cannot force failed (legacy path)", async () => {
    const fp = fonepay({ env: "sandbox", merchantCode: "NBQM", secretKey: secret });
    const forged = { PRN: "NP123", PID: "NBQM", PS: "false", RC: "failed", UID: "x", BC: "y" };
    await assert.rejects(
      fp.verify({ orderId: "NP123", amountPaisa: 1000, callback: forged }),
      (e: PaymentError) => e.code === "invalid_signature",
    );
    const lax = fonepay({
      env: "sandbox",
      merchantCode: "NBQM",
      secretKey: secret,
      strictSignature: false,
    });
    await assert.rejects(
      lax.verify({ orderId: "NP123", amountPaisa: 1000, callback: forged }),
      (e: PaymentError) => e.code === "verify_unavailable",
    );
  });

  test("legacy verification: upstream 5xx throws instead of reading as failed", async () => {
    const fp = fonepay({ env: "sandbox", merchantCode: "NBQM", secretKey: secret });
    const cb: Record<string, string> = {
      PRN: "NP123",
      PID: "NBQM",
      PS: "true",
      RC: "successful",
      UID: "36463",
      BC: "NICENPKA",
      INI: "98",
      P_AMT: "10",
      R_AMT: "10",
    };
    cb.DV = await fonepayHmac(
      secret,
      ["PRN", "PID", "PS", "RC", "UID", "BC", "INI", "P_AMT", "R_AMT"].map((k) => cb[k]),
    );
    mockFetch(() => ({ status: 502, body: "<html>Bad Gateway</html>" }));
    await assert.rejects(
      fp.verify({ orderId: "NP123", amountPaisa: 1000, callback: cb }),
      (e: PaymentError) => e.code === "upstream_error",
    );
    mockFetch(() => ({
      body: "<response><response_code>successful</response_code><success>true</success></response>",
    }));
    const v = await fp.verify({ orderId: "NP123", amountPaisa: 1000, callback: cb });
    assert.equal(v.status, "paid");
    assert.equal(v.amountPaisa, 1000);
  });

  test("callback DV verified case-insensitively; tamper rejected", async () => {
    const fp = fonepay({ env: "sandbox", merchantCode: "NBQM", secretKey: secret });
    const cb: Record<string, string> = {
      PRN: "d1580724437729",
      PID: "NBQM",
      PS: "true",
      RC: "successful",
      UID: "36463",
      BC: "NICENPKA",
      INI: "9841845631",
      P_AMT: "20.0",
      R_AMT: "30",
    };
    cb.DV = (await fonepayHmac(secret, Object.values(cb))).toLowerCase();
    assert.equal(await fp.callbackValid(cb), true);
    assert.equal(await fp.callbackValid({ ...cb, R_AMT: "3" }), false);
  });
});

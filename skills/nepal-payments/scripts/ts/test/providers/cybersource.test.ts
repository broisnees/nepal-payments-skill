/** CyberSource Secure Acceptance: signature worked example, response checks, initiate form. */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { cybersource, cybersourceSign } from "../../src/index.ts";

describe("cybersource", () => {
  test("Secure Acceptance signature worked example", async () => {
    const f: Record<string, string> = {
      access_key: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6",
      profile_id: "PROFILE-0001",
      transaction_uuid: "7f9c2b1e-5d1a-4c3b-9e8f-1a2b3c4d5e6f",
      signed_field_names:
        "access_key,profile_id,transaction_uuid,signed_field_names,unsigned_field_names,signed_date_time,locale,transaction_type,reference_number,amount,currency",
      unsigned_field_names: "",
      signed_date_time: "2026-11-04T10:15:30Z",
      locale: "en-us",
      transaction_type: "sale",
      reference_number: "ORDER-1001",
      amount: "1500.00",
      currency: "NPR",
    };
    assert.equal(
      await cybersourceSign("test_secret_key_do_not_use", f),
      "QRwjaW8ysHR/UGyQ0LqSIHiGTvnNebKSwwsFRmn4Weg=",
    );
  });

  const cs = cybersource({ env: "sandbox", profileId: "P", accessKey: "A", secretKey: "S" });
  async function response(o: Record<string, string>) {
    const p: Record<string, string> = {
      req_reference_number: "ORD-1",
      req_currency: "NPR",
      req_transaction_type: "sale",
      transaction_id: "7000",
      ...o,
    };
    p.signed_field_names = [...Object.keys(p), "signed_field_names"].join(",");
    p.signature = await cybersourceSign("S", p);
    return p;
  }

  test("decisions map correctly; unsigned extra fields ignored; tamper rejected", async () => {
    assert.equal(
      (
        await cs.verify({
          orderId: "ORD-1",
          amountPaisa: 150000,
          callback: await response({
            decision: "ACCEPT",
            reason_code: "100",
            auth_amount: "1500.00",
          }),
        })
      ).status,
      "paid",
    );
    assert.equal(
      (
        await cs.verify({
          orderId: "ORD-1",
          amountPaisa: 150000,
          callback: await response({ decision: "DECLINE", reason_code: "203" }),
        })
      ).status,
      "failed",
    );
    assert.equal(
      (
        await cs.verify({
          orderId: "ORD-1",
          amountPaisa: 150000,
          callback: await response({ decision: "REVIEW", reason_code: "200" }),
        })
      ).status,
      "pending",
    );
    assert.equal(
      (
        await cs.verify({
          orderId: "ORD-1",
          amountPaisa: 150000,
          callback: await response({ decision: "CANCEL", reason_code: "" }),
        })
      ).status,
      "canceled",
    );
    const ok = await response({ decision: "ACCEPT", reason_code: "100", auth_amount: "1500.00" });
    const v = await cs.verify({
      orderId: "ORD-1",
      amountPaisa: 150000,
      callback: { ...ok, injected: "x" },
    });
    assert.equal((v.raw as Record<string, unknown>).injected, undefined);
    await assert.rejects(
      cs.verify({
        orderId: "ORD-1",
        amountPaisa: 150000,
        callback: { ...ok, auth_amount: "1.00" },
      }),
      /invalid response signature/,
    );
    await assert.rejects(
      cs.verify({ orderId: "ORD-2", amountPaisa: 150000, callback: ok }),
      /different order/,
    );
    // signed-but-empty auth_amount falls back to req_amount (same as Python)
    const empty = await response({
      decision: "ACCEPT",
      reason_code: "100",
      auth_amount: "",
      req_amount: "1500.00",
    });
    assert.equal(
      (await cs.verify({ orderId: "ORD-1", amountPaisa: 150000, callback: empty })).amountPaisa,
      150000,
    );
  });

  test("initiate signs every field incl. bill_to and sends unsigned_field_names empty", async () => {
    const r = await cs.initiate({
      orderId: "ORD-1",
      amountPaisa: 150000,
      description: "x",
      returnUrl: "https://r",
      billTo: {
        forename: "Ram",
        surname: "Sharma",
        email: "r@e.com",
        addressLine1: "Thamel",
        city: "Kathmandu",
        country: "NP",
      },
    });
    if (r.kind !== "form") return assert.fail();
    assert.equal(r.fields.amount, "1500.00");
    assert.equal(r.fields.unsigned_field_names, "");
    assert.match(r.fields.signed_date_time, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    assert.ok(r.fields.signed_field_names.includes("bill_to_address_country"));
    assert.equal(r.fields.signature, await cybersourceSign("S", r.fields));
  });

  test("CyberSource: empty req_reference_number falls back to req_transaction_uuid", async () => {
    const cs = cybersource({ env: "sandbox", profileId: "p", accessKey: "a", secretKey: "s" });
    const p: Record<string, string> = {
      decision: "ACCEPT",
      reason_code: "100",
      req_reference_number: "",
      req_transaction_uuid: "T1",
      req_amount: "10.00",
      req_currency: "NPR",
      transaction_id: "X1",
    };
    p.signed_field_names = [...Object.keys(p), "signed_field_names"].join(",");
    p.signature = await cybersourceSign("s", p);
    assert.equal(
      (await cs.verify({ orderId: "T1", amountPaisa: 1000, callback: p })).status,
      "paid",
    );
  });
});

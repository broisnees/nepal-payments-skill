import assert from "node:assert/strict";
import { test } from "node:test";
import { newId, redactData, validateEvent } from "./events.ts";

const base = { id: "evt_1", type: "payment.started", ts: "2026-11-05T10:00:00.000Z", attempt_id: "a1", gateway: "esewa" };

test("accepts a minimal event", () => {
  const r = validateEvent(base);
  assert.ok(r.ok);
});

test("rejects unknown types, bad timestamps and missing attempt ids", () => {
  assert.equal(validateEvent({ ...base, type: "nope" }).ok, false);
  assert.equal(validateEvent({ ...base, ts: "yesterday" }).ok, false);
  assert.equal(validateEvent({ ...base, attempt_id: "" }).ok, false);
  assert.equal(validateEvent({ ...base, amount_paisa: 1.5 }).ok, false);
});

test("drops unknown data keys, card numbers and PEM blocks; strips query strings", () => {
  const d = redactData({ secret: "x", message: "card 4111 1111 1111 1111", reason: "bad_signature", endpoint: "/status?total=1", provider_code: "-----BEGIN PRIVATE KEY-----" });
  assert.deepEqual(d, { reason: "bad_signature", endpoint: "/status" });
});

test("ids sort by time", () => {
  assert.ok(newId("evt", 1000) < newId("evt", 2000));
  assert.match(newId("evt"), /^evt_[0-9A-Z]{26}$/);
});

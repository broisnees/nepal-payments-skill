import assert from "node:assert/strict";
import { test } from "node:test";
import { explain } from "./explain.ts";

test("matches a gateway code first, then the generic reason", () => {
  assert.match(explain({ gateway: "esewa", provider_code: "ES104" })!.title, /signature/);
  assert.match(explain({ gateway: "khalti", reason: "amount_mismatch" })!.title, /Amount/);
  assert.match(explain({ gateway: "esewa", provider_status: "NOT_FOUND" })!.title, /does not know/);
  assert.match(explain({ gateway: "connectips", provider_code: "403" })!.title, /403/);
});

test("codes are gateway specific and unknown inputs give null", () => {
  assert.equal(explain({ gateway: "khalti", provider_code: "ES104" }), null);
  assert.equal(explain({ gateway: "esewa", provider_status: "COMPLETE" }), null);
  assert.equal(explain({ gateway: "esewa" }), null);
});

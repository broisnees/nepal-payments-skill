/** Encoding and crypto primitives. */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { fromBase64, toBase64 } from "../../src/index.ts";

describe("encoding + crypto", () => {
  test("base64 tolerates '+' turned into space", () => {
    const b = toBase64(new Uint8Array([251, 255, 190]));
    assert.equal(b, "+/++");
    assert.deepEqual(fromBase64(b.replace(/\+/g, " ")), new Uint8Array([251, 255, 190]));
  });
});

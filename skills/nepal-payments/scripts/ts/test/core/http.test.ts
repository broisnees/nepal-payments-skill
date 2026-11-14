/** HTTP client: headers, body encoding, retries, errors. */
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { basicAuth, http, PaymentError } from "../../src/index.ts";
import { calls, header, mockFetch, restoreFetch } from "../helpers.ts";

afterEach(restoreFetch);

describe("http", () => {
  test("basicAuth encodes UTF-8 credentials", () => {
    assert.equal(basicAuth("ü", "पासवर्ड"), "Basic " + Buffer.from("ü:पासवर्ड").toString("base64"));
  });

  test("objects are sent as JSON with a JSON Content-Type; strings keep the caller's", async () => {
    mockFetch(() => ({ body: { ok: true } }));
    const res = await http("esewa", "https://api.example/x", { method: "POST", body: { a: 1 } });
    assert.deepEqual(res, { status: 200, data: { ok: true }, text: '{"ok":true}' });
    assert.equal(String(calls[0].init.body), '{"a":1}');
    assert.equal(header(calls[0], "Content-Type"), "application/json");
    assert.equal(header(calls[0], "Accept"), "application/json");

    mockFetch(() => ({ body: "plain" }));
    const text = await http("esewa", "https://api.example/x", {
      method: "POST",
      body: "a=1",
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    assert.equal(text.data, "plain"); // non-JSON body: kept as text
    assert.equal(header(calls[0], "Content-Type"), undefined);
    assert.equal(header(calls[0], "content-type"), "application/x-www-form-urlencoded");
  });

  test("5xx is returned as-is without retries, retried when asked", async () => {
    mockFetch(() => ({ status: 503, body: "busy" }));
    assert.equal((await http("esewa", "https://api.example/x")).status, 503);
    assert.equal(calls.length, 1);

    let n = 0;
    mockFetch(() => (n++ === 0 ? { status: 503, body: "busy" } : { body: "" }));
    const res = await http("esewa", "https://api.example/x", { retries: 2 });
    assert.deepEqual([res.status, res.data, calls.length], [200, null, 2]);
  });

  test("network failure becomes a network_error PaymentError naming the host", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    await assert.rejects(
      http("khalti", "https://dev.khalti.com/api"),
      (e: unknown) =>
        e instanceof PaymentError &&
        e.code === "network_error" &&
        e.provider === "khalti" &&
        e.message === "request to dev.khalti.com failed: fetch failed",
    );
  });
});

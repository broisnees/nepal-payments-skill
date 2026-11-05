import { afterEach, describe, expect, it, vi } from "vitest";
import { createPaynp } from "../src/index.ts";
import { Transport } from "../src/client.ts";
import { reasonOf } from "../src/reasons.ts";
import { TEST_KEY, startIngest, type MockIngest } from "./ingest.ts";

let ingest: MockIngest | undefined;
afterEach(async () => {
  await ingest?.close();
  ingest = undefined;
  vi.restoreAllMocks();
});

const ev = (paynp: ReturnType<typeof createPaynp>, i: number) =>
  paynp.statusChanged({ attemptId: `a${i}`, gateway: "esewa", from: "initiated", to: "pending" });

describe("batching and flush", () => {
  it("sends on the interval with keepalive and the bearer key", async () => {
    ingest = await startIngest();
    const seen: RequestInit[] = [];
    const paynp = createPaynp({
      key: TEST_KEY,
      endpoint: `${ingest.url}/`,
      flushIntervalMs: 30,
      fetch: (input, init) => (seen.push(init!), fetch(input, init)),
    });
    ev(paynp, 1);
    ev(paynp, 2);
    expect(ingest.requests).toHaveLength(0);
    await ingest.waitFor(2, 1000);
    expect(ingest.requests).toHaveLength(1);
    expect(ingest.requests[0].headers.authorization).toBe(`Bearer ${TEST_KEY}`);
    expect(seen[0].keepalive).toBe(true);
  });

  it("sends at once when maxBatch events are queued, in batches of at most maxBatch", async () => {
    ingest = await startIngest();
    const paynp = createPaynp({ key: TEST_KEY, endpoint: ingest.url, flushIntervalMs: 60_000, maxBatch: 5 });
    for (let i = 0; i < 12; i++) ev(paynp, i);
    await paynp.flush();
    expect(ingest.events).toHaveLength(12);
    expect(ingest.requests.map((r) => r.events.length)).toEqual([5, 5, 2]);
  });

  it("never sends more than 100 events or 256 KB in one request", async () => {
    ingest = await startIngest();
    const t = new Transport({ key: TEST_KEY, endpoint: ingest.url, flushIntervalMs: 60_000, maxBatch: 1000, maxQueue: 5000 });
    const long = "x".repeat(490);
    const data = { op: long, method: long, endpoint: long, provider_status: long, provider_code: long, provider_ref: long, reason: long, message: long };
    for (let i = 0; i < 400; i++) t.push({ type: "error", attempt_id: `big-${i}`, gateway: "esewa", data });
    await t.flush();
    expect(ingest.events).toHaveLength(400);
    expect(ingest.requests.length).toBeGreaterThan(4); // ~4 KB each: the byte limit splits before 100
    for (const r of ingest.requests) {
      expect(r.events.length).toBeLessThanOrEqual(100);
      expect(r.bytes).toBeLessThanOrEqual(256 * 1024);
    }
  });

  it("flush() sends events queued while a send is in flight and never rejects", async () => {
    ingest = await startIngest();
    const paynp = createPaynp({ key: TEST_KEY, endpoint: ingest.url, flushIntervalMs: 60_000 });
    ev(paynp, 1);
    const first = paynp.flush();
    ev(paynp, 2);
    await first;
    await paynp.flush();
    expect(ingest.events).toHaveLength(2);
    const down = createPaynp({ key: TEST_KEY, endpoint: "http://127.0.0.1:1", retryBaseMs: 1, onError: () => {} });
    ev(down, 1);
    await expect(down.flush()).resolves.toBeUndefined();
  });

  it("drops the keepalive option on runtimes that reject it", async () => {
    ingest = await startIngest();
    let calls = 0;
    const paynp = createPaynp({
      key: TEST_KEY,
      endpoint: ingest.url,
      fetch: (input, init) => {
        calls++;
        if (init?.keepalive) throw new TypeError("The 'keepalive' field on 'RequestInitializerDict' is not implemented.");
        return fetch(input, init);
      },
    });
    ev(paynp, 1);
    await paynp.flush();
    ev(paynp, 2);
    await paynp.flush();
    expect(ingest.events).toHaveLength(2);
    expect(calls).toBe(3); // one rejected try, then plain sends
  });
});

describe("retries", () => {
  it("retries 5xx and 429 with backoff, then succeeds", async () => {
    ingest = await startIngest();
    ingest.answer(500, [429, { "retry-after": "0" }], 503);
    const paynp = createPaynp({ key: TEST_KEY, endpoint: ingest.url, retryBaseMs: 5 });
    ev(paynp, 1);
    const t0 = Date.now();
    await paynp.flush();
    expect(ingest.requests).toHaveLength(4);
    expect(ingest.events).toHaveLength(1);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(5 + 10 + 20);
  });

  it("gives up after 3 retries, drops the batch and warns once a minute", async () => {
    ingest = await startIngest();
    ingest.answer(...Array(20).fill(500));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const paynp = createPaynp({ key: TEST_KEY, endpoint: ingest.url, retryBaseMs: 1 });
    ev(paynp, 1);
    await paynp.flush();
    ev(paynp, 2);
    await paynp.flush();
    expect(ingest.requests).toHaveLength(8); // 1 + 3 retries, twice
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/dropped 1 event\(s\): ingest unreachable after 4 tries: HTTP 500/);
  });

  it("does not retry a bad key and reports every failure to onError", async () => {
    ingest = await startIngest();
    ingest.answer(401);
    const errors: Error[] = [];
    const paynp = createPaynp({ key: TEST_KEY, endpoint: ingest.url, onError: (e) => errors.push(e) });
    ev(paynp, 1);
    await paynp.flush();
    expect(ingest.requests).toHaveLength(1);
    expect(errors.map((e) => e.message)).toEqual(["paynp: dropped 1 event(s): ingest answered HTTP 401 (check PAYNP_KEY)"]);
  });

  it("a 400 is final: valid events were accepted, nothing is resent", async () => {
    ingest = await startIngest();
    ingest.answer(400);
    const paynp = createPaynp({ key: TEST_KEY, endpoint: ingest.url, onError: () => {} });
    ev(paynp, 1);
    await paynp.flush();
    expect(ingest.requests).toHaveLength(1);
  });
});

describe("queue cap", () => {
  it("keeps at most 1000 events, dropping the oldest, with one warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const never = vi.fn(() => new Promise<Response>(() => {})); // ingest hangs forever
    const paynp = createPaynp({ key: TEST_KEY, endpoint: "http://127.0.0.1:1", fetch: never, maxBatch: 100, flushIntervalMs: 60_000 });
    for (let i = 0; i < 1600; i++) ev(paynp, i);
    // The first 100 went out in a send that never finishes; the queue holds the newest 1000.
    expect(paynp.queued).toBe(1000);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/queue full \(1000\)/);
  });

  it("maxQueue is configurable", async () => {
    const paynp = createPaynp({ key: TEST_KEY, endpoint: "http://127.0.0.1:1", fetch: () => new Promise(() => {}), maxQueue: 10, maxBatch: 100, onError: () => {} });
    for (let i = 0; i < 25; i++) ev(paynp, i);
    expect(paynp.queued).toBe(10);
  });
});

describe("validation", () => {
  it("drops invalid events locally instead of sending them", async () => {
    ingest = await startIngest();
    const errors: string[] = [];
    const paynp = createPaynp({ key: TEST_KEY, endpoint: ingest.url, onError: (e) => errors.push(e.message) });
    paynp.statusChanged({ attemptId: "", gateway: "esewa", to: "paid" });
    paynp.statusChanged({ attemptId: "ok", gateway: "Not A Gateway", to: "paid" });
    paynp.statusChanged({ attemptId: "ok", gateway: "esewa", to: "paid", amountPaisa: 1.5 });
    await paynp.flush();
    expect(ingest.requests).toHaveLength(0);
    expect(errors).toHaveLength(3);
  });

  it("uses PAYNP_ENDPOINT when no endpoint is passed", async () => {
    ingest = await startIngest();
    process.env.PAYNP_ENDPOINT = ingest.url;
    try {
      const paynp = createPaynp({ key: TEST_KEY });
      ev(paynp, 1);
      await paynp.flush();
      expect(ingest.events).toHaveLength(1);
    } finally {
      delete process.env.PAYNP_ENDPOINT;
    }
  });

  it("timestamps of one attempt never go backwards or tie", async () => {
    ingest = await startIngest();
    const paynp = createPaynp({ key: TEST_KEY, endpoint: ingest.url });
    for (let i = 0; i < 20; i++) paynp.callbackReceived({ attemptId: "same", gateway: "esewa" });
    await paynp.flush();
    const ts = ingest.events.map((e) => Date.parse(e.ts));
    for (let i = 1; i < ts.length; i++) expect(ts[i]).toBeGreaterThan(ts[i - 1]);
  });
});

describe("reasons", () => {
  // Messages and codes the blog modules and the skill adapters really throw.
  const cases: [unknown, string][] = [
    [new Error("eSewa: amount mismatch (100.0)"), "amount_mismatch"],
    [new Error("Khalti: amount mismatch (1000)"), "amount_mismatch"],
    [new Error("IME Pay: Recheck says paid but has no TranAmount"), "amount_mismatch"],
    [new Error("eSewa: bad signature on data"), "bad_signature"],
    [new Error("eSewa: data has no signature"), "bad_signature"],
    [new Error("CyberSource: response is not signed"), "bad_signature"],
    [new Error("Fonepay: missing or bad DV on the return URL"), "bad_signature"],
    [new Error("eSewa: data is for a different payment"), "id_mismatch"],
    [new Error("connectIPS: TXNID is for a different payment"), "id_mismatch"],
    [new Error("NPS: status is for a different payment"), "id_mismatch"],
    [new Error("CyberSource: currency mismatch"), "currency_mismatch"],
    [new Error("eSewa: data is not base64 JSON"), "malformed_callback"],
    [new Error('eSewa status check failed: HTTP 503 {"code":0}'), "gateway_error"],
    [Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }), "timeout"],
    [new TypeError("fetch failed"), "network_error"],
    [Object.assign(new Error("eSewa: invalid response signature"), { code: "invalid_signature" }), "bad_signature"],
    [Object.assign(new Error("x"), { code: "callback_mismatch" }), "id_mismatch"],
    [Object.assign(new Error("request to rc.esewa.com.np failed: The operation was aborted due to timeout"), { code: "network_error" }), "timeout"],
    [Object.assign(new Error("x"), { code: "amount_too_low" }), "amount_too_low"],
    [new Error("something else"), "exception"],
    ["a string", "exception"],
    [undefined, "exception"],
  ];
  it.each(cases)("%s -> %s", (err, reason) => expect(reasonOf(err)).toBe(reason));
});

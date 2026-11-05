import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createPaynp } from "../src/index.ts";
import { activeScopes } from "../src/trace.ts";
import { TEST_KEY, byTime, startIngest, types, type MockIngest } from "./ingest.ts";

// A fake gateway on "localhost" (the ingest mock is on 127.0.0.1, so hosts never overlap).
let gw: { url: string; close: () => Promise<void>; hits: string[] };
let ingest: MockIngest | undefined;
const realFetch = globalThis.fetch;

beforeAll(async () => {
  const hits: string[] = [];
  const server = createServer((req, res) => {
    hits.push(req.url ?? "");
    const delay = /slow/.test(req.url ?? "") ? 60 : 5;
    setTimeout(() => {
      if (req.url?.startsWith("/fail")) return void res.writeHead(503).end("{}");
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ status: "COMPLETE", total_amount: 100, ref_id: "REF1" }));
    }, delay);
  });
  await new Promise<void>((r) => server.listen(0, "localhost", r));
  const { port } = server.address() as AddressInfo;
  gw = { url: `http://localhost:${port}`, hits, close: () => new Promise((r) => server.close(() => r())) };
});
afterAll(() => gw.close());
afterEach(async () => {
  await ingest?.close();
  ingest = undefined;
  expect(globalThis.fetch).toBe(realFetch);
  expect(activeScopes()).toBe(0);
});

class PaymentError extends Error {}

// Shaped like the blog modules: startPayment returns a form, confirmPayment checks a signed
// ?data= (when present) and then asks the status API.
function fakeEsewa(statusPath = "/api/epay/transaction/status/") {
  return {
    helper: () => "kept",
    async startPayment(input: { attemptId: string; amountPaisa: number; returnUrl: string; description: string }) {
      return { type: "form" as const, action: "https://rc-epay.esewa.com.np/api/epay/main/v2/form", fields: { transaction_uuid: input.attemptId } };
    },
    async confirmPayment(input: { attemptId: string; amountPaisa: number; providerRef: string | null; params: Record<string, string> }) {
      if (input.params.data === "forged") throw new PaymentError("eSewa: bad signature on data");
      const res = await fetch(`${gw.url}${statusPath}?total_amount=100&transaction_uuid=${input.attemptId}`);
      const body = await res.json();
      if (!res.ok) throw new Error(`eSewa status check failed: HTTP ${res.status} ${JSON.stringify(body)}`);
      if (input.params.wrong === "amount") throw new PaymentError(`eSewa: amount mismatch (${body.total_amount})`);
      return { status: "paid" as const, providerRef: body.ref_id as string };
    },
  };
}

const startInput = (attemptId: string) => ({ attemptId, amountPaisa: 10000, returnUrl: "http://shop/pay/return/x", description: "Order demo" });
const confirmInput = (attemptId: string, params: Record<string, string> = {}) => ({ attemptId, amountPaisa: 10000, providerRef: null, params });

async function setup(opts: { traceFetch?: boolean; hosts?: string[] } = { hosts: ["localhost"] }) {
  ingest = await startIngest();
  const paynp = createPaynp({ key: TEST_KEY, endpoint: ingest!.url, flushIntervalMs: 10_000 });
  const gateway = paynp.wrapGateway("esewa", fakeEsewa(), opts);
  return { paynp, gateway };
}

describe("no key in production", () => {
  // Outside production a missing key means "send to paynp dev if it runs" (test/dev.test.ts).
  beforeAll(() => void vi.stubEnv("NODE_ENV", "production"));
  afterAll(() => void vi.unstubAllEnvs());

  it("returns the module untouched, never patches fetch, never touches the network", async () => {
    const spy = vi.fn(realFetch);
    for (const key of [undefined, null, "", "   "]) {
      const paynp = createPaynp({ key, endpoint: "http://127.0.0.1:1", fetch: spy });
      const mod = fakeEsewa();
      expect(paynp.enabled).toBe(false);
      expect(paynp.wrapGateway("esewa", mod)).toBe(mod);
      const adapter = { id: "esewa", initiate: async () => ({}), verify: async () => ({}) };
      expect(paynp.wrapAdapter(adapter)).toBe(adapter);
      paynp.statusChanged({ attemptId: "a", gateway: "esewa", from: "initiated", to: "paid" });
      paynp.fulfilled({ attemptId: "a", gateway: "esewa" });
      paynp.callbackReceived({ attemptId: "a", gateway: "esewa", method: "GET" });
      paynp.reconcileChecked({ attemptId: "a", gateway: "esewa", status: "pending" });
      paynp.error({ attemptId: "a", gateway: "esewa", error: new Error("x") });
      await paynp.flush();
      expect(paynp.queued).toBe(0);
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it("the no-op fetch helper is the plain runtime fetch", async () => {
    const paynp = createPaynp({});
    const res = await paynp.fetch({ attemptId: "a", gateway: "esewa" })(`${gw.url}/x`);
    expect(res.status).toBe(200);
  });
});

describe("wrapGateway", () => {
  it("startPayment: started, then redirected with the form's method and path", async () => {
    const { paynp, gateway } = await setup();
    const start = await gateway.startPayment(startInput("att1"));
    expect(start.type).toBe("form");
    expect(gateway.helper()).toBe("kept"); // other exports pass through
    await paynp.flush();
    const [started, redirected] = byTime(ingest!.events);
    expect(types(ingest!.events)).toEqual(["payment.started", "payment.redirected"]);
    expect(started).toMatchObject({ attempt_id: "att1", gateway: "esewa", amount_paisa: 10000, status: "initiated" });
    expect(redirected.data).toEqual({ method: "POST", endpoint: "/api/epay/main/v2/form", gw_env: "sandbox" });
    expect(started.data).toEqual({ return_https: false });
    expect(started.sdk).toEqual({ name: "@paynp/sdk", version: "0.1.0", lang: "ts" });
    expect(ingest!.invalid).toEqual([]);
  });

  it("confirm from the return route: callback, signature ok, timed request, status on the last event", async () => {
    const { paynp, gateway } = await setup();
    const outcome = await gateway.confirmPayment(confirmInput("att2", { data: "eyJ9" }));
    expect(outcome).toEqual({ status: "paid", providerRef: "REF1" });
    await paynp.flush();
    const evs = byTime(ingest!.events);
    expect(evs.map((e) => e.type)).toEqual(["callback.received", "signature.checked", "gateway.request"]);
    expect(evs[0].data).toEqual({ source: "return" });
    expect(evs[1].data).toEqual({ valid: true });
    const req = evs[2];
    expect(req.data).toMatchObject({ op: "status", method: "GET", endpoint: "/api/epay/transaction/status/", http_status: 200, provider_ref: "REF1" });
    expect(req.data).not.toHaveProperty("message");
    expect(req.duration_ms).toBeGreaterThanOrEqual(4);
    expect(req.status).toBe("paid");
    // the query string (amount, attempt id) never leaves the process
    expect(JSON.stringify(ingest!.requests)).not.toContain("total_amount");
  });

  it("confirm from the reconcile job (empty params): request plus reconcile.checked", async () => {
    const { paynp, gateway } = await setup();
    await gateway.confirmPayment(confirmInput("att3"));
    await paynp.flush();
    const evs = byTime(ingest!.events);
    expect(evs.map((e) => e.type)).toEqual(["gateway.request", "reconcile.checked"]);
    expect(evs[0].status).toBeUndefined();
    expect(evs[1]).toMatchObject({ status: "paid", data: { source: "reconcile", provider_ref: "REF1" } });
  });

  it("bad signature: rethrows the same error, emits signature.checked valid=false and an error, no request", async () => {
    const { paynp, gateway } = await setup();
    const err = await gateway.confirmPayment(confirmInput("att4", { data: "forged" })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PaymentError);
    expect((err as Error).message).toBe("eSewa: bad signature on data");
    await paynp.flush();
    const evs = byTime(ingest!.events);
    expect(evs.map((e) => e.type)).toEqual(["callback.received", "signature.checked", "error"]);
    expect(evs[1].data).toEqual({ valid: false, reason: "bad_signature" });
    expect(evs[2].data).toMatchObject({ reason: "bad_signature", message: "eSewa: bad signature on data", op: "status" });
    expect(gw.hits.some((h) => h.includes("att4"))).toBe(false);
  });

  it("amount mismatch after the status call: signature valid, request recorded, error amount_mismatch", async () => {
    const { paynp, gateway } = await setup();
    await expect(gateway.confirmPayment(confirmInput("att5", { data: "x", wrong: "amount" }))).rejects.toThrow("amount mismatch");
    await paynp.flush();
    const evs = byTime(ingest!.events);
    expect(evs.map((e) => e.type)).toEqual(["callback.received", "signature.checked", "gateway.request", "error"]);
    expect(evs[1].data?.valid).toBe(true);
    expect(evs[3].data?.reason).toBe("amount_mismatch");
  });

  it("rethrows exactly what was thrown, including non-Error values", async () => {
    ingest = await startIngest();
    const paynp = createPaynp({ key: TEST_KEY, endpoint: ingest!.url });
    const thrown = [new TypeError("boom"), "a string", 42, undefined, { code: "weird" }];
    for (const value of thrown) {
      const mod = paynp.wrapGateway("khalti", {
        startPayment: async (_: unknown) => {
          throw value;
        },
        confirmPayment: (_: unknown): Promise<never> => {
          throw value; // synchronous throw from a non-async function
        },
      });
      await expect(mod.startPayment(startInput("t"))).rejects.toBe(value);
      await expect(mod.confirmPayment(confirmInput("t"))).rejects.toBe(value);
    }
    await paynp.flush();
    expect(ingest!.events.filter((e) => e.type === "error")).toHaveLength(thrown.length * 2);
    expect(ingest!.invalid).toEqual([]);
  });

  it("a gateway 5xx records the request with its status and an error with reason gateway_error", async () => {
    ingest = await startIngest();
    const paynp = createPaynp({ key: TEST_KEY, endpoint: ingest!.url });
    const gateway = paynp.wrapGateway("esewa", fakeEsewa("/fail"), { hosts: ["localhost"] });
    await expect(gateway.confirmPayment(confirmInput("att6"))).rejects.toThrow("HTTP 503");
    await paynp.flush();
    const evs = byTime(ingest!.events);
    expect(evs.map((e) => e.type)).toEqual(["gateway.request", "error"]);
    expect(evs[0].data).toMatchObject({ http_status: 503, endpoint: "/fail" });
    expect(evs[1].data?.reason).toBe("gateway_error");
  });

  it("overlapping calls for one gateway cannot be told apart: both fall back to whole-call timing", async () => {
    ingest = await startIngest();
    const paynp = createPaynp({ key: TEST_KEY, endpoint: ingest!.url });
    const gateway = paynp.wrapGateway("esewa", fakeEsewa("/slow"), { hosts: ["localhost"] });
    await Promise.all([gateway.confirmPayment(confirmInput("c1")), gateway.confirmPayment(confirmInput("c2"))]);
    await paynp.flush();
    for (const id of ["c1", "c2"]) {
      const reqs = ingest!.events.filter((e) => e.attempt_id === id && e.type === "gateway.request");
      expect(reqs).toHaveLength(1);
      expect(reqs[0].data).toEqual({ op: "status" }); // no endpoint: it is the whole confirm call
      expect(reqs[0].duration_ms).toBeGreaterThanOrEqual(50);
    }
  });

  it("calls one after another are each timed per request", async () => {
    const { paynp, gateway } = await setup();
    await gateway.confirmPayment(confirmInput("s1"));
    await gateway.confirmPayment(confirmInput("s2"));
    await paynp.flush();
    const reqs = ingest!.events.filter((e) => e.type === "gateway.request");
    expect(reqs.map((e) => e.data?.endpoint)).toEqual(["/api/epay/transaction/status/", "/api/epay/transaction/status/"]);
  });

  it("traceFetch: false never touches globalThis.fetch and times the whole confirm call", async () => {
    const { paynp, gateway } = await setup({ traceFetch: false });
    const seen: unknown[] = [];
    const p = gateway.confirmPayment(confirmInput("nf"));
    seen.push(globalThis.fetch);
    await p;
    expect(seen[0]).toBe(realFetch);
    await paynp.flush();
    const req = ingest!.events.find((e) => e.type === "gateway.request")!;
    expect(req.data).toEqual({ op: "status" });
  });

  it("an unknown gateway with no hosts gets whole-call timing", async () => {
    ingest = await startIngest();
    const paynp = createPaynp({ key: TEST_KEY, endpoint: ingest!.url });
    const gateway = paynp.wrapGateway("mybank", fakeEsewa());
    await gateway.confirmPayment(confirmInput("u1"));
    await paynp.flush();
    expect(ingest!.events.find((e) => e.type === "gateway.request")?.data).toEqual({ op: "status" });
  });

  it("fetches to other hosts during a wrapped call are not recorded", async () => {
    ingest = await startIngest();
    const paynp = createPaynp({ key: TEST_KEY, endpoint: ingest!.url });
    const gateway = paynp.wrapGateway("esewa", {
      async confirmPayment(input: { attemptId: string }) {
        await fetch(`${gw.url}/other`); // localhost is not an eSewa host
        return { status: "pending" };
      },
    });
    await gateway.confirmPayment(confirmInput("o1"));
    await paynp.flush();
    expect(types(ingest!.events)).toEqual(["reconcile.checked"]);
  });

  it("a missing attempt id records nothing and still calls through", async () => {
    const { paynp, gateway } = await setup();
    await gateway.startPayment({ ...startInput(""), attemptId: "" });
    await paynp.flush();
    expect(ingest!.requests).toHaveLength(0);
  });

  it("card numbers in error messages never leave the process", async () => {
    ingest = await startIngest();
    const paynp = createPaynp({ key: TEST_KEY, endpoint: ingest!.url });
    const gateway = paynp.wrapGateway("cybersource", {
      startPayment: async (_: unknown) => {
        throw new Error("declined card 4111 1111 1111 1111");
      },
    });
    await gateway.startPayment(startInput("cc")).catch(() => {});
    await paynp.flush();
    const err = ingest!.events.find((e) => e.type === "error")!;
    expect(err.data).toEqual({ reason: "exception", op: "initiate" });
    expect(JSON.stringify(ingest!.requests)).not.toContain("4111");
  });
});

describe("wrapAdapter", () => {
  function adapter() {
    return {
      id: "khalti" as const,
      calls: 0,
      async initiate(input: { orderId: string; amountPaisa: number }) {
        this.calls++; // `this` must still be the adapter
        return { kind: "redirect" as const, url: "https://test-pay.khalti.com/?pidx=PIDX1", providerRef: "PIDX1" };
      },
      async verify(input: { orderId: string; amountPaisa: number; providerRef?: string | null; callback?: Record<string, string> }) {
        if (input.callback?.pidx === "other") {
          throw Object.assign(new Error("Khalti: callback is for a different payment"), { code: "callback_mismatch", httpStatus: 400 });
        }
        const paid = input.callback?.amount === "short" ? 5000 : input.amountPaisa;
        return { provider: "khalti", status: "paid", orderId: input.orderId, amountPaisa: paid, transactionId: "TXN9", raw: { status: "Completed" } };
      },
      orderIdFromCallback: (p: Record<string, string>) => p.purchase_order_id ?? null,
    };
  }

  it("initiate and verify emit the same events as the blog wrapper, with provider_status from raw", async () => {
    ingest = await startIngest();
    const paynp = createPaynp({ key: TEST_KEY, endpoint: ingest!.url });
    const raw = adapter();
    const k = paynp.wrapAdapter(raw);
    expect(k.id).toBe("khalti");
    expect(k.orderIdFromCallback({ purchase_order_id: "o1" })).toBe("o1");
    await k.initiate({ orderId: "ad1", amountPaisa: 10000 });
    expect(raw.calls).toBe(1);
    await k.verify({ orderId: "ad1", amountPaisa: 10000, providerRef: "PIDX1", callback: { pidx: "PIDX1" } });
    await paynp.flush();
    const evs = byTime(ingest!.events);
    // This adapter made no HTTP call, so there is no gateway.request; the status lands on the callback.
    expect(evs.map((e) => e.type)).toEqual(["payment.started", "payment.redirected", "callback.received"]);
    expect(evs[1].data).toEqual({ method: "GET", endpoint: "/", provider_ref: "PIDX1", gw_env: "sandbox" });
    expect(evs[2]).toMatchObject({ status: "paid", data: { source: "return", provider_ref: "TXN9", provider_status: "Completed" } });
  });

  it("paid with the wrong amount is flagged as amount_mismatch with status unknown", async () => {
    ingest = await startIngest();
    const paynp = createPaynp({ key: TEST_KEY, endpoint: ingest!.url });
    const k = paynp.wrapAdapter(adapter());
    await k.verify({ orderId: "ad2", amountPaisa: 10000, callback: {} });
    await k.verify({ orderId: "ad3", amountPaisa: 10000, callback: { amount: "short" } });
    await paynp.flush();
    const short = ingest!.events.filter((e) => e.attempt_id === "ad3").at(-1)!;
    expect(short.status).toBe("unknown");
    expect(short.data).toMatchObject({ reason: "amount_mismatch", message: "amount mismatch: stored 10000, provider 5000" });
    const ok = ingest!.events.find((e) => e.attempt_id === "ad2" && e.type === "reconcile.checked")!;
    expect(ok.status).toBe("paid");
  });

  it("adapter error codes become reasons and the error is rethrown as is", async () => {
    ingest = await startIngest();
    const paynp = createPaynp({ key: TEST_KEY, endpoint: ingest!.url });
    const raw = adapter();
    const k = paynp.wrapAdapter(raw);
    const err = await k.verify({ orderId: "ad4", amountPaisa: 10000, callback: { pidx: "other" } }).catch((e: unknown) => e);
    expect((err as { code: string }).code).toBe("callback_mismatch");
    await paynp.flush();
    expect(ingest!.events.find((e) => e.type === "error")?.data).toMatchObject({ reason: "id_mismatch", http_status: 400 });
  });
});

describe("manual events", () => {
  it("statusChanged, fulfilled, callbackReceived, reconcileChecked and error", async () => {
    ingest = await startIngest();
    const paynp = createPaynp({ key: TEST_KEY, endpoint: ingest!.url });
    paynp.callbackReceived({ attemptId: "m1", gateway: "esewa", method: "get" });
    paynp.statusChanged({ attemptId: "m1", gateway: "esewa", orderId: "demo", from: "initiated", to: "paid", amountPaisa: 10000 });
    paynp.fulfilled({ attemptId: "m1", gateway: "esewa", orderId: "demo" });
    paynp.reconcileChecked({ attemptId: "m1", gateway: "esewa", status: "not_found", providerStatus: "NOT_FOUND" });
    paynp.statusChanged({ attemptId: "m1", gateway: "khalti", from: "pending", to: "partially_refunded" });
    paynp.error({ attemptId: "m1", gateway: "esewa", error: new Error("eSewa: data is for a different payment") });
    await paynp.flush();
    const [cb, sc, ful, rc, sc2, er] = ingest!.events;
    expect(cb.data).toEqual({ method: "GET", source: "return" });
    expect(sc).toMatchObject({ type: "status.changed", status: "paid", order_id: "demo", amount_paisa: 10000, data: { from: "initiated", to: "paid" } });
    expect(ful).toMatchObject({ type: "payment.fulfilled", status: "paid", order_id: "demo" });
    expect(rc.status).toBeUndefined();
    expect(rc.data).toEqual({ source: "reconcile", provider_status: "NOT_FOUND" });
    expect(sc2.status).toBe("refunded");
    expect(er.data).toMatchObject({ reason: "id_mismatch" });
  });

  it("paynp.fetch records every call it makes, retries numbered", async () => {
    ingest = await startIngest();
    const paynp = createPaynp({ key: TEST_KEY, endpoint: ingest!.url });
    const f = paynp.fetch({ attemptId: "f1", gateway: "nps", op: "lookup" });
    await f(`${gw.url}/api/x?secret=1`);
    await f(new URL(`${gw.url}/api/x`), { method: "post" });
    await expect(f("http://127.0.0.1:1/down")).rejects.toThrow();
    await paynp.flush();
    const evs = ingest!.events;
    expect(evs.map((e) => e.data?.endpoint)).toEqual(["/api/x", "/api/x", "/down"]);
    expect(evs[1].data).toMatchObject({ method: "POST", attempt: 2, op: "lookup" });
    expect(evs[2].data?.reason).toBe("network_error");
  });
});

describe("import cycles", () => {
  it("wrapGateway works when the module is not evaluated yet (paynp -> gateway -> payments -> paynp)", async () => {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const dir = join(import.meta.dirname, ".generated", "cycle");
    mkdirSync(dir, { recursive: true });
    const sdk = join(import.meta.dirname, "..", "src", "index.ts");
    writeFileSync(join(dir, "paynp.ts"), `import { createPaynp } from ${JSON.stringify(sdk)};
import * as gw from "./gw.ts";
export const paynp = createPaynp({ key: process.env.CYCLE_KEY, endpoint: process.env.CYCLE_URL });
export const gateway = paynp.wrapGateway("esewa", gw);
`);
    writeFileSync(join(dir, "payments.ts"), `import { paynp } from "./paynp.ts";
export const LIMIT = 1;
export class PaymentError extends Error {}
export function settle(id: string) { paynp.statusChanged({ attemptId: id, gateway: "esewa", to: "paid" }); }
`);
    writeFileSync(join(dir, "gw.ts"), `import { PaymentError, LIMIT } from "./payments.ts";
export const NAME = "gw";
export async function startPayment(i: { attemptId: string }) { if (LIMIT < 0) throw new PaymentError("x"); return { type: "redirect", url: "https://rc-epay.esewa.com.np/x" }; }
`);
    ingest = await startIngest();
    process.env.CYCLE_KEY = TEST_KEY;
    process.env.CYCLE_URL = ingest.url;
    // Entering through payments.ts evaluates paynp.ts before gw.ts has run.
    const payments = await import(/* @vite-ignore */ join(dir, "payments.ts"));
    const { gateway, paynp } = await import(/* @vite-ignore */ join(dir, "paynp.ts"));
    expect(gateway.NAME).toBe("gw");
    await gateway.startPayment({ attemptId: "cy1", amountPaisa: 100 });
    payments.settle("cy1");
    await paynp.flush();
    expect(types(ingest.events)).toEqual(["payment.started", "payment.redirected", "status.changed"]);
  });
});

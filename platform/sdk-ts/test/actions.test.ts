// Signed actions (SPEC-v2 section 3): signature, timestamp window, replay guard, dispatch, emitted events, and the
// Fetch API, Node http, Express-style and Fastify-style adapters.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPaynp, signAction, type ActionHandlerOptions, type PaynpAction } from "../src/index.ts";
import { TEST_KEY, startIngest, type MockIngest } from "./ingest.ts";

const SECRET = "whsec_test_0123456789";
let ingest: MockIngest | undefined;

afterEach(async () => {
  vi.unstubAllEnvs();
  await ingest?.close();
  ingest = undefined;
});

const nowSec = () => Math.floor(Date.now() / 1000);
let seq = 0;
const action = (over: Record<string, unknown> = {}) => ({
  id: `act_${Date.now()}_${seq++}`,
  kind: "refund",
  attempt_id: "att_1",
  gateway: "khalti",
  order_id: "ORD-1",
  amount_paisa: 150000,
  provider_ref: "GFq9PFS7b2iYvL8Lir9oXe",
  refund: { amount_paisa: 150000, reason: "duplicate payment" },
  ...over,
});

async function signed(body: unknown, opts: { secret?: string; ts?: number } = {}): Promise<Request> {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  const headers = await signAction(opts.secret ?? SECRET, text, opts.ts ?? nowSec());
  return new Request("http://shop.local/paynp/actions", { method: "POST", headers, body: text });
}

async function setup(handlers: ActionHandlerOptions) {
  ingest = await startIngest();
  const paynp = createPaynp({ key: TEST_KEY, endpoint: ingest.url, flushIntervalMs: 60_000 });
  return { paynp, handle: paynp.actionHandler({ secret: SECRET, ...handlers }) };
}

const json = async (r: Response) => [r.status, await r.json()] as const;

describe("actionHandler (Fetch API)", () => {
  it("refund: verifies, calls the callback, answers ok with refund_ref, emits payment.refunded with action_id", async () => {
    const seen: PaynpAction[] = [];
    const { handle } = await setup({
      refund: async (a) => {
        seen.push(a);
        return { refundRef: "KHALTI-RF-9" };
      },
    });
    const body = action();
    const res = await handle(await signed(body));
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await json(res)).toEqual([200, { ok: true, refund_ref: "KHALTI-RF-9" }]);
    expect(seen).toEqual([
      {
        id: body.id,
        kind: "refund",
        attemptId: "att_1",
        gateway: "khalti",
        orderId: "ORD-1",
        amountPaisa: 150000,
        providerRef: "GFq9PFS7b2iYvL8Lir9oXe",
        refund: { amountPaisa: 150000, reason: "duplicate payment" },
      },
    ]);
    // the handler flushed before answering
    expect(ingest!.events).toHaveLength(1);
    expect(ingest!.events[0]).toMatchObject({
      type: "payment.refunded",
      attempt_id: "att_1",
      gateway: "khalti",
      order_id: "ORD-1",
      amount_paisa: 150000,
      data: { refund_ref: "KHALTI-RF-9", refund_reason: "duplicate payment", action_id: body.id, provider_ref: "GFq9PFS7b2iYvL8Lir9oXe" },
    });
    expect(ingest!.invalid).toEqual([]);
  });

  it("partial refund: the event carries the refunded amount, not the payment amount", async () => {
    const { handle } = await setup({ refund: () => ({}) });
    const res = await handle(await signed(action({ refund: { amount_paisa: 5000 } })));
    expect(await json(res)).toEqual([200, { ok: true }]);
    expect(ingest!.events[0].amount_paisa).toBe(5000);
  });

  it("a refund with no refund amount refunds the payment amount; status from the callback is passed back", async () => {
    const { handle } = await setup({ refund: () => ({ status: "partially_refunded", amountPaisa: 70000 }) });
    const res = await handle(await signed(action({ refund: undefined })));
    expect(await json(res)).toEqual([200, { ok: true, status: "refunded" }]);
    expect(ingest!.events[0].amount_paisa).toBe(70000);
  });

  it("recheck: answers the status and emits reconcile.checked with action_id", async () => {
    const { handle } = await setup({ recheck: async (a) => ({ status: "paid", providerRef: a.providerRef, providerStatus: "Completed" }) });
    const body = action({ kind: "recheck", refund: undefined });
    expect(await json(await handle(await signed(body)))).toEqual([200, { ok: true, status: "paid" }]);
    expect(ingest!.events[0]).toMatchObject({
      type: "reconcile.checked",
      status: "paid",
      data: { source: "manual", action_id: body.id, provider_ref: "GFq9PFS7b2iYvL8Lir9oXe", provider_status: "Completed" },
    });
  });

  it("rejects a bad signature, a wrong secret, and missing headers with 401 and never calls back", async () => {
    const refund = vi.fn();
    const { handle } = await setup({ refund });
    const body = JSON.stringify(action());
    const ts = nowSec();
    const good = await signAction(SECRET, body, ts);

    const tampered = new Request("http://x/", { method: "POST", headers: good, body: body.replace("150000", "999999") });
    expect(await json(await handle(tampered))).toEqual([401, { ok: false, error: "bad signature" }]);

    expect((await handle(await signed(body, { secret: "wrong" }))).status).toBe(401);

    // one hex digit off
    const sig = good["x-paynp-signature"];
    const noPrefix = { ...good, "x-paynp-signature": sig.slice(0, -1) + (sig.endsWith("0") ? "1" : "0") };
    expect((await handle(new Request("http://x/", { method: "POST", headers: noPrefix, body }))).status).toBe(401);

    const bare = new Request("http://x/", { method: "POST", headers: { "content-type": "application/json" }, body });
    expect(await json(await handle(bare))).toEqual([401, { ok: false, error: "missing X-Paynp-Signature or X-Paynp-Timestamp" }]);

    const badTs = new Request("http://x/", { method: "POST", headers: { ...good, "x-paynp-timestamp": "yesterday" }, body });
    expect((await handle(badTs)).status).toBe(401);

    // the timestamp is part of what is signed: changing it breaks the signature
    const shifted = new Request("http://x/", { method: "POST", headers: { ...good, "x-paynp-timestamp": String(ts + 1) }, body });
    expect(await json(await handle(shifted))).toEqual([401, { ok: false, error: "bad signature" }]);

    expect(refund).not.toHaveBeenCalled();
    expect(ingest!.requests).toHaveLength(0);
  });

  it("rejects timestamps older than 5 minutes or more than 5 minutes ahead", async () => {
    const refund = vi.fn(() => ({}));
    const { handle } = await setup({ refund });
    const stale = await handle(await signed(action(), { ts: nowSec() - 301 }));
    expect(await json(stale)).toEqual([401, { ok: false, error: "timestamp outside the 5 minute window" }]);
    expect((await handle(await signed(action(), { ts: nowSec() + 301 }))).status).toBe(401);
    expect((await handle(await signed(action(), { ts: nowSec() - 290 }))).status).toBe(200);
    expect(refund).toHaveBeenCalledTimes(1);
  });

  it("replay: the same action id is handled once, even with a fresh signature", async () => {
    const refund = vi.fn(() => ({ refundRef: "R1" }));
    const { handle } = await setup({ refund });
    const body = action();
    const req = await signed(body);
    const again = req.clone();
    expect((await handle(req)).status).toBe(200);
    expect(await json(await handle(again))).toEqual([409, { ok: false, error: "action already handled" }]);
    expect((await handle(await signed(body, { ts: nowSec() + 1 }))).status).toBe(409);
    expect(refund).toHaveBeenCalledTimes(1);
    expect(ingest!.events.filter((e) => e.type === "payment.refunded")).toHaveLength(1);
  });

  it("the replay guard is shared by every handler of one paynp instance", async () => {
    ingest = await startIngest();
    const paynp = createPaynp({ key: TEST_KEY, endpoint: ingest.url });
    const a = paynp.actionHandler({ secret: SECRET, refund: () => ({}) });
    const b = paynp.actionHandler({ secret: SECRET, refund: () => ({}) });
    const body = action();
    expect((await a(await signed(body))).status).toBe(200);
    expect((await b(await signed(body))).status).toBe(409);
  });

  it("a callback that throws or returns ok:false answers 200 ok:false and emits nothing", async () => {
    const { handle } = await setup({
      refund: (a) => {
        if (a.orderId === "throw") throw new Error("Khalti refund failed: HTTP 400 {\"detail\":\"Transaction already refunded.\"}");
        return { ok: false, error: "refund window closed" };
      },
    });
    const r1 = await json(await handle(await signed(action({ order_id: "throw" }))));
    expect(r1).toEqual([200, { ok: false, error: 'Khalti refund failed: HTTP 400 {"detail":"Transaction already refunded."}' }]);
    expect(await json(await handle(await signed(action())))).toEqual([200, { ok: false, error: "refund window closed" }]);
    expect(ingest!.events).toHaveLength(0);
  });

  it("no handler for the kind answers ok:false", async () => {
    const { handle } = await setup({});
    const [status, body] = await json(await handle(await signed(action())));
    expect(status).toBe(200);
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/no refund handler/);
    expect((await json(await handle(await signed(action({ kind: "recheck" })))))[1]).toEqual({ ok: false, error: "this server has no recheck handler" });
  });

  it("malformed bodies: 400 after a valid signature", async () => {
    const { handle } = await setup({ refund: () => ({}) });
    expect(await json(await handle(await signed("not json")))).toEqual([400, { ok: false, error: "body is not JSON" }]);
    expect((await json(await handle(await signed(action({ kind: "delete" })))))[0]).toBe(400);
    expect((await json(await handle(await signed(action({ attempt_id: "" })))))[0]).toBe(400);
    expect((await json(await handle(await signed(action({ id: undefined })))))[0]).toBe(400);
  });

  it("ping (the dashboard's Test button): ok after the signature check, no callback, no event", async () => {
    const refund = vi.fn();
    const { handle } = await setup({ refund });
    expect(await json(await handle(await signed({ id: "act_ping1", kind: "ping" })))).toEqual([200, { ok: true }]);
    expect(await json(await handle(await signed({ id: "act_ping2", kind: "ping" }, { secret: "wrong" })))).toEqual([401, { ok: false, error: "bad signature" }]);
    expect(refund).not.toHaveBeenCalled();
    expect(ingest!.requests).toHaveLength(0);
  });

  it("GET is 405; no secret is 500", async () => {
    const { handle } = await setup({ refund: () => ({}) });
    expect((await handle(new Request("http://x/", { method: "GET" }))).status).toBe(405);
    vi.stubEnv("PAYNP_ACTION_SECRET", "");
    const noSecret = createPaynp({ key: TEST_KEY, endpoint: ingest!.url }).actionHandler({ refund: () => ({}) });
    expect(await json(await noSecret(await signed(action())))).toEqual([500, { ok: false, error: "PAYNP_ACTION_SECRET is not set on this server" }]);
  });

  it("reads PAYNP_ACTION_SECRET from the environment", async () => {
    vi.stubEnv("PAYNP_ACTION_SECRET", SECRET);
    ingest = await startIngest();
    const handle = createPaynp({ key: TEST_KEY, endpoint: ingest.url }).actionHandler({ refund: () => ({ refundRef: "E1" }) });
    expect(await json(await handle(await signed(action())))).toEqual([200, { ok: true, refund_ref: "E1" }]);
  });

  it("without a key the refund still runs; nothing is reported", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const refund = vi.fn(() => ({ refundRef: "NK" }));
    const paynp = createPaynp({});
    expect(paynp.enabled).toBe(false);
    const res = await paynp.actionHandler({ secret: SECRET, refund })(await signed(action()));
    expect(await json(res)).toEqual([200, { ok: true, refund_ref: "NK" }]);
    expect(refund).toHaveBeenCalledOnce();
  });

  it("mounts in Hono as a route", async () => {
    const { paynp } = await setup({});
    const app = new Hono();
    app.post("/paynp/actions", (c) => paynp.actionHandler({ secret: SECRET, refund: () => ({ refundRef: "H1" }) })(c.req.raw));
    const text = JSON.stringify(action());
    const res = await app.request("/paynp/actions", { method: "POST", headers: await signAction(SECRET, text, nowSec()), body: text });
    expect(await json(res)).toEqual([200, { ok: true, refund_ref: "H1" }]);
  });
});

describe("nodeActionHandler", () => {
  async function serve(handler: (req: IncomingMessage, res: ServerResponse) => unknown) {
    const server = createServer((req, res) => void handler(req, res));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;
    return { url: `http://127.0.0.1:${port}/paynp/actions`, close: () => new Promise<void>((r) => server.close(() => r())) };
  }
  async function post(url: string, body: unknown, opts: { ts?: number; secret?: string } = {}) {
    const text = JSON.stringify(body);
    const res = await fetch(url, { method: "POST", headers: await signAction(opts.secret ?? SECRET, text, opts.ts ?? nowSec()), body: text });
    return [res.status, await res.json()] as const;
  }

  it("plain node:http: reads the raw stream", async () => {
    const { paynp } = await setup({});
    const s = await serve(paynp.nodeActionHandler({ secret: SECRET, refund: () => ({ refundRef: "N1" }) }) as never);
    try {
      expect(await post(s.url, action())).toEqual([200, { ok: true, refund_ref: "N1" }]);
      expect((await post(s.url, action(), { secret: "nope" }))[0]).toBe(401);
      expect((await post(s.url, action(), { ts: nowSec() - 600 }))[0]).toBe(401);
      expect(ingest!.events.map((e) => e.type)).toEqual(["payment.refunded"]);
    } finally {
      await s.close();
    }
  });

  it("Express style: body already parsed by express.json(), or a Buffer from express.raw()", async () => {
    const { paynp } = await setup({});
    const h = paynp.nodeActionHandler({ secret: SECRET, refund: () => ({ refundRef: "X1" }) });
    // what express.json() leaves behind: the stream consumed, req.body an object
    const parsed = await serve(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      Object.assign(req, { body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
      await h(req as never, res as never);
    });
    const raw = await serve(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      Object.assign(req, { body: Buffer.concat(chunks) });
      await h(req as never, res as never);
    });
    try {
      expect(await post(parsed.url, action())).toEqual([200, { ok: true, refund_ref: "X1" }]);
      expect(await post(raw.url, action())).toEqual([200, { ok: true, refund_ref: "X1" }]);
    } finally {
      await parsed.close();
      await raw.close();
    }
  });

  it("Fastify style: answers through reply.code().header().send()", async () => {
    const { paynp } = await setup({});
    const h = paynp.nodeActionHandler({ secret: SECRET, refund: () => ({ refundRef: "F1" }) });
    const body = action();
    const text = JSON.stringify(body);
    const headers = await signAction(SECRET, text, nowSec());
    const sent: { code?: number; headers: Record<string, string>; body?: string } = { headers: {} };
    const reply = {
      raw: {},
      code(n: number) {
        sent.code = n;
        return reply;
      },
      header(k: string, v: string) {
        sent.headers[k] = v;
        return reply;
      },
      send(b: string) {
        sent.body = b;
        return reply;
      },
    };
    await h({ method: "POST", headers, body: JSON.parse(text) }, reply);
    expect(sent).toEqual({ code: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ ok: true, refund_ref: "F1" }) });
  });
});

describe("README: the Khalti refund callback", () => {
  let loads = 0;
  // Pulls the code block out of the README, so the documented callback is the one under test.
  async function load() {
    const { mkdirSync, readFileSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const readme = readFileSync(join(import.meta.dirname, "..", "README.md"), "utf8");
    const section = readme.slice(readme.indexOf("### Khalti refund callback"));
    const code = /```ts\n([\s\S]*?)```/.exec(section)![1];
    const dir = join(import.meta.dirname, ".generated", "khalti-actions");
    mkdirSync(dir, { recursive: true });
    const sdk = JSON.stringify(join(import.meta.dirname, "..", "src", "index.ts"));
    writeFileSync(join(dir, "paynp.ts"), `export const gateway = { confirmPayment: async (i: { providerRef: string | null }) => ({ status: i.providerRef ? "paid" : "pending" }) };\n`);
    // A new file per load: the module reads KHALTI_ENV once, at import.
    const file = join(dir, `paynp-actions-${loads++}.ts`);
    writeFileSync(file, code.replace('from "@paynp/sdk"', `from ${sdk}`).replace('from "./paynp"', 'from "./paynp.ts"'));
    return (await import(/* @vite-ignore */ file)) as { actions: ActionHandlerOptions };
  }

  function stubKhalti(env: "sandbox" | "production", refundStatus = 200) {
    const calls: { url: string; auth: string | null; body: string }[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (!url.includes("khalti.com")) return real(input, init);
      calls.push({ url, auth: new Headers(init?.headers).get("authorization"), body: String(init?.body ?? "") });
      const host = env === "sandbox" ? "https://dev.khalti.com" : "https://khalti.com";
      if (!url.startsWith(host)) return new Response("wrong host", { status: 500 });
      if (url.endsWith("/epayment/lookup/")) {
        const { pidx } = JSON.parse(String(init?.body));
        return pidx === "PIDX-1"
          ? Response.json({ pidx, status: "Completed", transaction_id: "TXN-1", total_amount: 150000 })
          : Response.json({ detail: "Not found." }, { status: 404 });
      }
      return refundStatus === 200 ? Response.json({ detail: "Transaction refund successful." }) : Response.json({ detail: "Transaction already refunded." }, { status: 400 });
    }) as typeof fetch;
    return { calls, restore: () => void (globalThis.fetch = real) };
  }

  it("sandbox: pidx is looked up to the transaction_id, full refund sends {}, payment.refunded goes out", async () => {
    vi.stubEnv("KHALTI_SECRET_KEY", "test_secret_key_abc");
    vi.stubEnv("KHALTI_ENV", "sandbox");
    const { actions } = await load();
    const k = stubKhalti("sandbox");
    try {
      const { handle } = await setup(actions);
      const res = await handle(await signed(action({ provider_ref: "PIDX-1", refund: { reason: "duplicate" } })));
      expect(await json(res)).toEqual([200, { ok: true, refund_ref: "TXN-1" }]);
      expect(k.calls.map((c) => c.url)).toEqual(["https://dev.khalti.com/api/v2/epayment/lookup/", "https://dev.khalti.com/api/merchant-transaction/TXN-1/refund/"]);
      expect(k.calls[1]).toMatchObject({ auth: "Key test_secret_key_abc", body: "{}" });
      expect(ingest!.events[0]).toMatchObject({ type: "payment.refunded", amount_paisa: 150000, data: { refund_ref: "TXN-1", refund_reason: "duplicate" } });
    } finally {
      k.restore();
    }
  });

  it("production host, partial amount in paisa, a transaction_id passes through lookup's 404", async () => {
    vi.stubEnv("KHALTI_SECRET_KEY", "live_secret_key_abc");
    vi.stubEnv("KHALTI_ENV", "production");
    const { actions } = await load();
    const k = stubKhalti("production");
    try {
      const { handle } = await setup(actions);
      const res = await handle(await signed(action({ provider_ref: "TXN-9", refund: { amount_paisa: 5000 } })));
      expect(await json(res)).toEqual([200, { ok: true, refund_ref: "TXN-9" }]);
      expect(k.calls[1]).toMatchObject({ url: "https://khalti.com/api/merchant-transaction/TXN-9/refund/", body: '{"amount":5000}' });
      expect(ingest!.events[0].amount_paisa).toBe(5000);
    } finally {
      k.restore();
    }
  });

  it("a Khalti error and a gateway without a refund API both answer ok:false", async () => {
    vi.stubEnv("KHALTI_ENV", "sandbox");
    const { actions } = await load();
    const k = stubKhalti("sandbox", 400);
    try {
      const { handle } = await setup(actions);
      const [, failed] = await json(await handle(await signed(action({ provider_ref: "PIDX-1" }))));
      expect(failed).toEqual({ ok: false, error: 'Khalti refund failed: HTTP 400 {"detail":"Transaction already refunded."}' });
      const [, esewa] = await json(await handle(await signed(action({ gateway: "esewa" }))));
      expect(esewa).toEqual({ ok: false, error: "esewa has no refund API; use the checklist in the dashboard" });
      const [, recheck] = await json(await handle(await signed(action({ kind: "recheck", provider_ref: "TXN-1" }))));
      expect(recheck).toEqual({ ok: true, status: "paid" });
      expect(ingest!.events.map((e) => e.type)).toEqual(["reconcile.checked"]);
    } finally {
      k.restore();
    }
  });
});

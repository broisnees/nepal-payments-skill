// SPEC-v2 section 1, SDK side: gw_env from the host the SDK saw, return_https on payment.started, the customer
// getter, paynp.annotate() and paynp.refunded().
import { afterEach, describe, expect, it } from "vitest";
import { SANDBOX_HOSTS, createPaynp, gwEnvOf } from "../src/index.ts";
import { activeScopes } from "../src/trace.ts";
import { TEST_KEY, byTime, startIngest, type MockIngest } from "./ingest.ts";

const realFetch = globalThis.fetch;
let ingest: MockIngest | undefined;

afterEach(async () => {
  globalThis.fetch = realFetch;
  await ingest?.close();
  ingest = undefined;
  expect(activeScopes()).toBe(0);
});

// Every gateway's sandbox and production hosts, from skills/nepal-payments/references/*.md.
const HOSTS: Record<string, { sandbox: string[]; production: string[] }> = {
  esewa: { sandbox: ["rc-epay.esewa.com.np", "rc.esewa.com.np", "rc-checkout.esewa.com.np"], production: ["epay.esewa.com.np", "esewa.com.np"] },
  khalti: { sandbox: ["dev.khalti.com", "test-pay.khalti.com"], production: ["khalti.com", "pay.khalti.com"] },
  fonepay: { sandbox: ["dev-clientapi.fonepay.com", "dev-merchantapi.fonepay.com"], production: ["clientapi.fonepay.com", "merchantapi.fonepay.com"] },
  connectips: { sandbox: ["uat.connectips.com"], production: ["login.connectips.com"] },
  cybersource: { sandbox: ["testsecureacceptance.cybersource.com", "apitest.cybersource.com"], production: ["secureacceptance.cybersource.com", "api.cybersource.com"] },
  nps: { sandbox: ["apisandbox.nepalpayment.com", "gatewaysandbox.nepalpayment.com"], production: ["apigateway.nepalpayment.com", "gateway.nepalpayment.com"] },
  imepay: { sandbox: ["stg.imepay.com.np"], production: ["payment.imepay.com.np"] },
};

describe("gwEnvOf", () => {
  it("classifies every documented host", () => {
    for (const [gw, { sandbox, production }] of Object.entries(HOSTS)) {
      for (const h of sandbox) expect([gw, h, gwEnvOf(`https://${h}/x`)]).toEqual([gw, h, "sandbox"]);
      for (const h of production) expect([gw, h, gwEnvOf(`https://${h}/x`)]).toEqual([gw, h, "production"]);
      expect(SANDBOX_HOSTS[gw].length).toBeGreaterThan(0);
    }
  });

  it("handles ports, URL objects, bare hosts and unknown hosts", () => {
    expect(gwEnvOf("https://stg.imepay.com.np:7979/api/Web/GetToken")).toBe("sandbox");
    expect(gwEnvOf("https://payment.imepay.com.np:7979/api/Web/GetToken")).toBe("production");
    expect(gwEnvOf(new URL("https://dev.khalti.com/api/v2/epayment/lookup/"))).toBe("sandbox");
    expect(gwEnvOf("uat.connectips.com")).toBe("sandbox");
    expect(gwEnvOf("RC.ESEWA.COM.NP")).toBe("sandbox");
    expect(gwEnvOf("http://localhost:3000/x")).toBeUndefined();
    expect(gwEnvOf("https://notkhalti.com/x")).toBeUndefined();
    expect(gwEnvOf("/relative")).toBeUndefined();
    expect(gwEnvOf("")).toBeUndefined();
    expect(gwEnvOf(undefined)).toBeUndefined();
  });
});

// A fetch that answers every gateway host locally, so the wrappers see real gateway hostnames without network.
function stubGatewayFetch(): string[] {
  const seen: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    seen.push(String(input instanceof Request ? input.url : input));
    return new Response('{"status":"COMPLETE"}', { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return seen;
}

async function setup() {
  ingest = await startIngest();
  // The transport keeps the real fetch, so ingest calls never hit the stub.
  return createPaynp({ key: TEST_KEY, endpoint: ingest.url, flushIntervalMs: 60_000, fetch: realFetch });
}

describe("gw_env on events", () => {
  it("gateway.request and payment.redirected carry gw_env per gateway host", async () => {
    const paynp = await setup();
    const seen = stubGatewayFetch();
    let n = 0;
    for (const [gw, { sandbox, production }] of Object.entries(HOSTS)) {
      for (const [env, host] of [["sandbox", sandbox[0]], ["production", production[0]]] as const) {
        const attemptId = `gw${n++}`;
        const mod = paynp.wrapGateway(gw, {
          async startPayment(_: { attemptId: string; amountPaisa: number }) {
            return { type: "redirect", url: `https://${host}/pay?token=secret` };
          },
          async confirmPayment(_: { attemptId: string; amountPaisa: number; params: Record<string, string> }) {
            await fetch(`https://${host}/status?id=${attemptId}`);
            return { status: "pending" };
          },
        });
        await mod.startPayment({ attemptId, amountPaisa: 1000 });
        await mod.confirmPayment({ attemptId, amountPaisa: 1000, params: {} });
        await paynp.flush();
        const evs = byTime(ingest!.events.filter((e) => e.attempt_id === attemptId));
        expect(evs.map((e) => e.type)).toEqual(["payment.started", "payment.redirected", "gateway.request", "reconcile.checked"]);
        expect([gw, env, evs[1].data?.gw_env]).toEqual([gw, env, env]);
        expect([gw, env, evs[2].data?.gw_env]).toEqual([gw, env, env]);
        expect(evs[2].data?.endpoint).toBe("/status");
      }
    }
    expect(seen).toHaveLength(14);
    expect(ingest!.invalid).toEqual([]);
    // the host itself is never sent, only the environment
    expect(JSON.stringify(ingest!.requests)).not.toContain("nepalpayment.com");
  });

  it("a form action sets gw_env on the redirect; an unknown host sets none", async () => {
    const paynp = await setup();
    const mod = paynp.wrapGateway("esewa", {
      async startPayment(i: { attemptId: string; amountPaisa: number }) {
        return i.attemptId === "f1"
          ? { type: "form", action: "https://epay.esewa.com.np/api/epay/main/v2/form", fields: {} }
          : { type: "redirect", url: "http://localhost:9999/fake-gateway" };
      },
    });
    await mod.startPayment({ attemptId: "f1", amountPaisa: 100 });
    await mod.startPayment({ attemptId: "f2", amountPaisa: 100 });
    await paynp.flush();
    const r1 = ingest!.events.find((e) => e.attempt_id === "f1" && e.type === "payment.redirected")!;
    const r2 = ingest!.events.find((e) => e.attempt_id === "f2" && e.type === "payment.redirected")!;
    expect(r1.data).toMatchObject({ method: "POST", gw_env: "production" });
    expect(r2.data).not.toHaveProperty("gw_env");
  });

  it("paynp.fetch records gw_env", async () => {
    const paynp = await setup();
    stubGatewayFetch();
    // paynp.fetch goes through baseFetch(), which is the (stubbed) global fetch when nothing is patched.
    await paynp.fetch({ attemptId: "pf", gateway: "khalti", op: "lookup" })("https://dev.khalti.com/api/v2/epayment/lookup/");
    await paynp.flush();
    expect(ingest!.events[0].data).toMatchObject({ op: "lookup", gw_env: "sandbox", endpoint: "/api/v2/epayment/lookup/" });
  });
});

describe("payment.started: return_https and customer", () => {
  const blogLike = () => ({
    async startPayment(_: { attemptId: string; amountPaisa: number; returnUrl?: string; phone?: string }) {
      return { type: "redirect", url: "https://dev.khalti.com/pay" };
    },
  });

  it("return_https from the blog module's returnUrl", async () => {
    const paynp = await setup();
    const gw = paynp.wrapGateway("khalti", blogLike());
    await gw.startPayment({ attemptId: "h1", amountPaisa: 1000, returnUrl: "https://shop.example.com/pay/return/h1" });
    await gw.startPayment({ attemptId: "h2", amountPaisa: 1000, returnUrl: "http://shop.example.com/pay/return/h2" });
    await gw.startPayment({ attemptId: "h3", amountPaisa: 1000 });
    await paynp.flush();
    const started = (id: string) => ingest!.events.find((e) => e.attempt_id === id && e.type === "payment.started")!;
    expect(started("h1").data).toEqual({ return_https: true });
    expect(started("h2").data).toEqual({ return_https: false });
    expect(started("h3").data).toBeUndefined();
  });

  it("return_https and customer from the adapter input", async () => {
    const paynp = await setup();
    const adapter = paynp.wrapAdapter(
      { id: "khalti", initiate: async (_: unknown) => ({ kind: "redirect", url: "https://pay.khalti.com/?pidx=1" }), verify: async () => ({}) },
      { customer: (i: { customer?: { phone?: string; name?: string } }) => i.customer },
    );
    await adapter.initiate({ orderId: "ad1", amountPaisa: 1000, returnUrl: "https://shop.example.com/r", customer: { phone: "9800000001", name: "Sita" } } as never);
    await paynp.flush();
    const s = ingest!.events.find((e) => e.type === "payment.started")!;
    expect(s.data).toEqual({ return_https: true });
    expect(s.customer).toEqual({ phone: "9800000001", name: "Sita" });
  });

  it("the customer getter sends phone, email and name on payment.started only", async () => {
    const paynp = await setup();
    const calls: unknown[] = [];
    const gw = paynp.wrapGateway("khalti", blogLike(), {
      customer: (input: { phone?: string }) => {
        calls.push(input);
        return { phone: input.phone, email: " buyer@example.com ", name: "Ram", junk: 1 } as never;
      },
    });
    await gw.startPayment({ attemptId: "c1", amountPaisa: 1000, phone: "+977-9812345678" });
    await paynp.flush();
    expect(calls).toHaveLength(1);
    const [started, redirected] = byTime(ingest!.events);
    expect(started.customer).toEqual({ phone: "+977-9812345678", email: "buyer@example.com", name: "Ram" });
    expect(redirected.customer).toBeUndefined();
    expect(ingest!.invalid).toEqual([]);
  });

  it("a throwing or empty getter sends no customer and never breaks the start", async () => {
    const paynp = await setup();
    const boom = paynp.wrapGateway("khalti", blogLike(), {
      customer: () => {
        throw new Error("no session");
      },
    });
    const empty = paynp.wrapGateway("khalti", blogLike(), { customer: () => ({ phone: "  " }) });
    await expect(boom.startPayment({ attemptId: "c2", amountPaisa: 1000 })).resolves.toMatchObject({ type: "redirect" });
    await empty.startPayment({ attemptId: "c3", amountPaisa: 1000 });
    await paynp.flush();
    for (const e of ingest!.events) expect(e.customer).toBeUndefined();
  });
});

describe("annotate and refunded", () => {
  it("payment.annotated carries order and customer, no status", async () => {
    const paynp = await setup();
    paynp.annotate({ attemptId: "a1", gateway: "esewa", orderId: "ORD-7", customer: { phone: "9800000002", email: "a@b.np" } });
    paynp.annotate({ attemptId: "a1", gateway: "esewa", customer: {} });
    await paynp.flush();
    const [a, b] = ingest!.events;
    expect(a).toMatchObject({ type: "payment.annotated", attempt_id: "a1", order_id: "ORD-7", customer: { phone: "9800000002", email: "a@b.np" } });
    expect(a.status).toBeUndefined();
    expect(b.customer).toBeUndefined();
  });

  it("payment.refunded carries the refunded amount, ref and reason", async () => {
    const paynp = await setup();
    paynp.refunded({ attemptId: "r1", gateway: "khalti", amountPaisa: 5000, refundRef: "RF-1", reason: "duplicate", orderId: "o1" });
    await paynp.flush();
    expect(ingest!.events[0]).toMatchObject({
      type: "payment.refunded",
      amount_paisa: 5000,
      order_id: "o1",
      data: { refund_ref: "RF-1", refund_reason: "duplicate" },
    });
    expect(ingest!.events[0].status).toBeUndefined();
  });
});

// Inbound provider webhooks: connecting registers the webhook in Stripe or Dodo (stubbed here), and signed
// deliveries become payments with their own currency.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stripeSignatureHeader } from "../src/inbound/stripe.ts";
import { newWebhookSecret, signedHeaders } from "../src/webhooks/sign.ts";
import { call, ev, ingest, json, payment, setup, type Setup } from "./helpers.ts";

const STRIPE_SECRET = "whsec_stripe_test_secret";
const DODO_SECRET = newWebhookSecret();
let calls: { url: string; method: string; body: string }[] = [];

beforeEach(() => {
  calls = [];
  const real = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";
    if (!url.startsWith("https://api.stripe.com") && !url.includes("dodopayments.com")) return real(input, init);
    calls.push({ url, method, body: init?.body ? String(init.body) : "" });
    if (url === "https://api.stripe.com/v1/webhook_endpoints" && method === "POST") return Response.json({ id: "we_123", secret: STRIPE_SECRET });
    if (url.startsWith("https://api.stripe.com/v1/webhook_endpoints/") && method === "DELETE") return Response.json({ id: "we_123", deleted: true });
    if (url.endsWith("/webhooks") && method === "POST") return Response.json({ id: "whk_9" });
    if (url.endsWith("/webhooks/whk_9/secret")) return Response.json({ secret: DODO_SECRET });
    if (url.endsWith("/webhooks/whk_9") && method === "DELETE") return new Response(null, { status: 200 });
    return Response.json({ error: { message: "unexpected" } }, { status: 500 });
  });
});
afterEach(() => vi.restoreAllMocks());

const connect = (s: Setup, provider: string, api_key: string, env = "test") =>
  call("POST", `/api/projects/${s.projectId}/inbound`, { cookie: s.cookie, body: { env, provider, api_key } });

async function stripeDeliver(path: string, evt: object, secret = STRIPE_SECRET) {
  const raw = JSON.stringify(evt);
  return call("POST", path, { raw, headers: { "stripe-signature": await stripeSignatureHeader(secret, raw, Math.floor(Date.now() / 1000)) } });
}

async function dodoDeliver(path: string, msgId: string, evt: object) {
  const raw = JSON.stringify(evt);
  return call("POST", path, { raw, headers: await signedHeaders([DODO_SECRET], msgId, Math.floor(Date.now() / 1000), raw) });
}

const sec = (msAgo: number) => Math.floor((Date.now() - msAgo) / 1000);
const pi = (id: string, status: string, extra: object = {}) => ({
  id,
  object: "payment_intent",
  amount: 2000,
  currency: "usd",
  status,
  created: sec(120_000),
  metadata: { order_id: "ord_77" },
  latest_charge: "ch_1",
  receipt_email: "buyer@example.com",
  ...extra,
});

describe("stripe", () => {
  it("connects with a matching-mode key and rejects the other mode", async () => {
    const s = await setup();
    const bad = await connect(s, "stripe", "sk_live_abcdefghijklmnop");
    expect(bad.status).toBe(400);
    expect(calls).toHaveLength(0);

    const res = await connect(s, "stripe", "rk_test_abcdefghijklmnop1234");
    expect(res.status).toBe(201);
    const src = await res.json<any>();
    expect(src).toMatchObject({ provider: "stripe", env: "test", provider_webhook_id: "we_123", api_key_hint: "rk_test_abcd****1234", enabled: true });
    expect(src.url).toMatch(/\/v1\/inbound\/ibs_/);
    const form = new URLSearchParams(calls[0].body);
    expect(form.get("url")).toBe(src.url);
    expect(form.getAll("enabled_events[]")).toContain("payment_intent.succeeded");

    expect((await connect(s, "stripe", "rk_test_abcdefghijklmnop1234")).status).toBe(409);
    const list = await json(call("GET", `/api/projects/${s.projectId}/inbound?env=test`, { cookie: s.cookie }));
    expect(list.items).toHaveLength(1);
    expect(JSON.stringify(list)).not.toContain(STRIPE_SECRET);
  });

  it("turns signed PaymentIntent events into a USD payment, once, and refuses bad signatures", async () => {
    const s = await setup();
    const src = await json(connect(s, "stripe", "sk_test_abcdefghijklmnop"));
    const path = new URL(src.url).pathname;
    const succeeded = { id: "evt_1", type: "payment_intent.succeeded", created: sec(60_000), livemode: false, data: { object: pi("pi_1", "succeeded") } };

    const r1 = await stripeDeliver(path, succeeded);
    expect(r1.status).toBe(200);
    expect(await r1.json()).toMatchObject({ accepted: 2 });
    // A Stripe retry of the same event, and the late payment_intent.created, change nothing.
    expect(await json(stripeDeliver(path, succeeded))).toMatchObject({ accepted: 0, duplicates: 2 });
    expect(await json(stripeDeliver(path, { id: "evt_0", type: "payment_intent.created", created: sec(120_000), data: { object: pi("pi_1", "requires_payment_method") } }))).toMatchObject({ accepted: 0 });

    const d = await payment(s, "pi_1");
    expect(d.payment).toMatchObject({ gateway: "stripe", status: "paid", amount_paisa: 2000, currency: "USD", order_id: "ord_77", provider_ref: "ch_1", event_count: 2 });
    expect(d.events.map((e: any) => e.type)).toEqual(["payment.started", "status.changed"]);

    const bad = await stripeDeliver(path, { ...succeeded, id: "evt_2" }, "whsec_wrong");
    expect(bad.status).toBe(400);
    const list = await json(call("GET", `/api/projects/${s.projectId}/inbound`, { cookie: s.cookie }));
    expect(list.items[0].last_error).toMatch(/does not match/);
    expect(list.items[0].last_event_at).toBeTypeOf("number");
  });

  it("records a failed attempt with its decline code, then the later success wins", async () => {
    const s = await setup();
    const path = new URL((await json(connect(s, "stripe", "sk_test_abcdefghijklmnop"))).url).pathname;
    const err = { code: "card_declined", decline_code: "insufficient_funds", message: "Your card has insufficient funds." };
    await stripeDeliver(path, { id: "evt_f", type: "payment_intent.payment_failed", created: sec(90_000), data: { object: pi("pi_2", "requires_payment_method", { last_payment_error: err }) } });
    expect((await payment(s, "pi_2")).payment).toMatchObject({ status: "failed", last_reason: "insufficient_funds", last_message: "Your card has insufficient funds." });
    await stripeDeliver(path, { id: "evt_s", type: "payment_intent.succeeded", created: sec(30_000), data: { object: pi("pi_2", "succeeded") } });
    expect((await payment(s, "pi_2")).payment.status).toBe("paid");
  });

  it("counts a refund once even when refund.created and refund.updated both report it", async () => {
    const s = await setup();
    const path = new URL((await json(connect(s, "stripe", "sk_test_abcdefghijklmnop"))).url).pathname;
    await stripeDeliver(path, { id: "evt_p", type: "payment_intent.succeeded", created: sec(90_000), data: { object: pi("pi_3", "succeeded") } });
    const refund = { id: "re_1", object: "refund", amount: 500, currency: "usd", payment_intent: "pi_3", status: "succeeded", created: sec(20_000), reason: "requested_by_customer" };
    await stripeDeliver(path, { id: "evt_r1", type: "refund.created", created: sec(20_000), data: { object: refund } });
    await stripeDeliver(path, { id: "evt_r2", type: "refund.updated", created: sec(10_000), data: { object: refund } });
    expect(await json(stripeDeliver(path, { id: "evt_r0", type: "refund.created", created: sec(25_000), data: { object: { ...refund, id: "re_0", status: "pending" } } }))).toMatchObject({ ignored: true });
    expect((await payment(s, "pi_3")).payment).toMatchObject({ status: "paid", refunded_paisa: 500 });
  });

  it("keeps revenue per currency: revenue_paisa stays NPR", async () => {
    const s = await setup();
    const path = new URL((await json(connect(s, "stripe", "sk_test_abcdefghijklmnop"))).url).pathname;
    await stripeDeliver(path, { id: "evt_a", type: "payment_intent.succeeded", created: sec(60_000), data: { object: pi("pi_4", "succeeded") } });
    await ingest(s.key, [ev("payment.started", "np1", 0, { amount_paisa: 150000 }), ev("status.changed", "np1", 1000, { status: "paid", data: { to: "paid" } })]);
    const a = await json(call("GET", `/api/projects/${s.projectId}/analytics?env=test`, { cookie: s.cookie }));
    expect(a.totals).toMatchObject({ paid: 2, revenue_paisa: 150000, revenue_by_currency: { NPR: 150000, USD: 2000 } });
    expect(a.by_gateway.find((g: any) => g.gateway === "stripe")).toMatchObject({ revenue_paisa: 0, revenue_by_currency: { USD: 2000 } });
  });

  it("disconnects in Stripe, and later deliveries get 410", async () => {
    const s = await setup();
    const src = await json(connect(s, "stripe", "sk_test_abcdefghijklmnop"));
    expect((await call("DELETE", `/api/projects/${s.projectId}/inbound/${src.id}`, { cookie: s.cookie })).status).toBe(204);
    expect(calls.at(-1)).toMatchObject({ url: "https://api.stripe.com/v1/webhook_endpoints/we_123", method: "DELETE" });
    const r = await stripeDeliver(new URL(src.url).pathname, { id: "evt_x", type: "payment_intent.succeeded", created: sec(1000), data: { object: pi("pi_5", "succeeded") } });
    expect(r.status).toBe(410);
  });
});

describe("dodo", () => {
  it("connects on the test host, fetches the secret, and maps payment and refund events", async () => {
    const s = await setup();
    const res = await connect(s, "dodo", "dodo_test_key_0123456789abcdef");
    expect(res.status).toBe(201);
    const src = await res.json<any>();
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(["POST https://test.dodopayments.com/webhooks", "GET https://test.dodopayments.com/webhooks/whk_9/secret"]);
    expect(JSON.parse(calls[0].body)).toMatchObject({ url: src.url, filter_types: expect.arrayContaining(["payment.succeeded", "refund.succeeded"]) });
    const path = new URL(src.url).pathname;

    const created_at = new Date(Date.now() - 120_000).toISOString();
    const payData = (status: string, extra: object = {}) => ({ payload_type: "Payment", payment_id: "pay_1", total_amount: 4999, currency: "EUR", status, created_at, metadata: { order_id: "o9" }, customer: { email: "a@example.com", name: "Asha" }, ...extra });
    const failed = { business_id: "bus_1", type: "payment.failed", timestamp: new Date(Date.now() - 60_000).toISOString(), data: payData("failed", { error_code: "CARD_DECLINED", error_message: "Declined" }) };
    expect((await dodoDeliver(path, "msg_1", failed)).status).toBe(200);
    expect(await json(dodoDeliver(path, "msg_1", failed))).toMatchObject({ accepted: 0 });
    let p = (await payment(s, "pay_1")).payment;
    expect(p).toMatchObject({ gateway: "dodo", status: "failed", currency: "EUR", amount_paisa: 4999, order_id: "o9", last_reason: "card_declined", customer_mask: expect.any(String) });

    await dodoDeliver(path, "msg_2", { business_id: "bus_1", type: "payment.succeeded", timestamp: new Date(Date.now() - 30_000).toISOString(), data: payData("succeeded") });
    await dodoDeliver(path, "msg_3", { business_id: "bus_1", type: "refund.succeeded", timestamp: new Date().toISOString(), data: { payload_type: "Refund", refund_id: "ref_1", payment_id: "pay_1", amount: 4999, currency: "EUR", created_at: new Date().toISOString() } });
    p = (await payment(s, "pay_1")).payment;
    expect(p).toMatchObject({ status: "refunded", refunded_paisa: 4999 });

    const bad = await call("POST", path, { raw: JSON.stringify(failed), headers: { "webhook-id": "msg_9", "webhook-timestamp": String(Math.floor(Date.now() / 1000)), "webhook-signature": "v1,AAAA" } });
    expect(bad.status).toBe(400);
  });

  it("uses the live host for the live environment", async () => {
    const s = await setup("live");
    expect((await connect(s, "dodo", "dodo_live_key_0123456789abcdef", "live")).status).toBe(201);
    expect(calls[0].url).toBe("https://live.dodopayments.com/webhooks");
  });
});

import { createHash, createHmac } from "node:crypto";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { maskEmail, maskPhone, normaliseEmail, normalisePhone } from "../src/ops/customer.ts";
import { call, ev, ingest, json, payment, setup, type Setup } from "./helpers.ts";

const row = (s: Setup, attempt: string, envName = "test") =>
  env.DB.prepare("SELECT * FROM payments WHERE project_id = ? AND env = ? AND attempt_id = ?").bind(s.projectId, envName, attempt).first<Record<string, any>>();
const salt = async (s: Setup) => (await env.DB.prepare("SELECT salt FROM projects WHERE id = ?").bind(s.projectId).first<{ salt: string }>())!.salt;
const cases = (s: Setup, envName = "test") =>
  env.DB.prepare("SELECT * FROM refund_cases WHERE project_id = ? AND env = ? ORDER BY created_at, id").bind(s.projectId, envName).all<Record<string, any>>().then((r) => r.results);
const paidAt = (id: string, at: number, extra: Record<string, unknown> = {}) => [
  ev("payment.started", id, at, { status: "initiated", amount_paisa: 150000, ...extra }),
  ev("status.changed", id, at + 1000, { data: { to: "paid", provider_ref: `REF-${id}` } }),
];

describe("customer normalisation, hashing and masks", () => {
  it("normalises Nepali mobiles from +977, 977, 0-prefixed and spaced forms", () => {
    for (const raw of ["9812345678", "+977 9812345678", "+977-981-234-5678", "977 98123 45678", "09812345678", "  98123 45678 ", "(+977) 981 2345678", "00977 9812345678"]) {
      expect(normalisePhone(raw), raw).toBe("9812345678");
    }
    // Not a Nepali mobile: kept as its digits.
    expect(normalisePhone("01-4412345")).toBe("014412345");
    expect(normalisePhone("+44 20 7946 0958")).toBe("442079460958");
  });

  it("masks phones as 98XXXXX678 and emails as n***@gmail.com", () => {
    expect(maskPhone("9812345678")).toBe("98XXXXX678");
    expect(maskPhone("12345")).toBe("XXXXX");
    expect(normaliseEmail("  Nischal@Gmail.COM ")).toBe("nischal@gmail.com");
    expect(maskEmail("nischal@gmail.com")).toBe("n***@gmail.com");
  });

  it("stores hex SHA-256(salt + ':' + normalised) and the mask, never the raw phone; same number in any format, same hash", async () => {
    const s = await setup();
    await ingest(s.key, [
      ev("payment.started", "cu1", 0, { amount_paisa: 1000, customer: { phone: "+977 981-234-5678", email: "Buyer@Example.com", name: "Sita Sharma" } }),
      ev("payment.started", "cu2", 10, { amount_paisa: 1000, customer: { phone: "09812345678" } }),
      ev("payment.started", "cu3", 20, { amount_paisa: 1000, customer: { email: "buyer@example.COM" } }),
    ]);
    const sl = await salt(s);
    expect(sl).toMatch(/^[0-9a-f]{32}$/);
    const phoneHash = createHash("sha256").update(`${sl}:9812345678`).digest("hex");
    const emailHash = createHash("sha256").update(`${sl}:buyer@example.com`).digest("hex");
    const r1 = (await row(s, "cu1"))!;
    expect(r1).toMatchObject({ customer_hash: phoneHash, customer_mask: "98XXXXX678", customer_name: "Sita Sharma" });
    expect((await row(s, "cu2"))!.customer_hash).toBe(phoneHash);
    expect((await row(s, "cu3"))!).toMatchObject({ customer_hash: emailHash, customer_mask: "b***@example.com" });
    // The raw values are nowhere in the payment, its events or its refs.
    const dump = JSON.stringify([
      r1,
      (await env.DB.prepare("SELECT * FROM events WHERE project_id = ?").bind(s.projectId).all()).results,
      (await env.DB.prepare("SELECT * FROM payment_refs WHERE project_id = ?").bind(s.projectId).all()).results,
    ]);
    expect(dump).not.toContain("9812345678");
    expect(dump.toLowerCase()).not.toContain("buyer@example.com");
    // The salt is per project.
    const s2 = await setup();
    await ingest(s2.key, [ev("payment.started", "cu1", 0, { customer: { phone: "9812345678" } })]);
    expect((await row(s2, "cu1"))!.customer_hash).not.toBe(phoneHash);
    // The API shows the mask only.
    expect((await payment(s, "cu1")).payment.customer_mask).toBe("98XXXXX678");
  });
});

describe("payment_refs, refunds, fulfilled_at and gw_env on ingest", () => {
  it("indexes attempt, order, provider and refund refs", async () => {
    const s = await setup();
    await ingest(s.key, [
      ev("payment.started", "rf1", 0, { order_id: "ORD-77", amount_paisa: 5000, status: "initiated" }),
      ev("gateway.request", "rf1", 10, { data: { op: "status", provider_ref: "0LD5CEH" } }),
      ev("payment.refunded", "rf1", 20, { amount_paisa: 5000, data: { refund_ref: "RFND-1" } }),
    ]);
    const refs = (await env.DB.prepare("SELECT ref, kind FROM payment_refs WHERE project_id = ? AND attempt_id = 'rf1' ORDER BY ref").bind(s.projectId).all()).results;
    expect(refs).toEqual([
      { ref: "0LD5CEH", kind: "provider" },
      { ref: "ORD-77", kind: "order" },
      { ref: "RFND-1", kind: "refund" },
      { ref: "rf1", kind: "attempt" },
    ]);
  });

  it("payment.refunded adds up refunded_paisa and sets refunded once the total reaches the amount; replays do not double count", async () => {
    const s = await setup();
    const [st, pd] = paidAt("pr1", 0);
    const part1 = ev("payment.refunded", "pr1", 5000, { amount_paisa: 50000, data: { refund_ref: "R1", refund_reason: "partial" } });
    const part2 = ev("payment.refunded", "pr1", 6000, { amount_paisa: 100000, data: { refund_ref: "R2" } });
    await ingest(s.key, [st, pd, part1]);
    let p = (await payment(s, "pr1")).payment;
    expect(p).toMatchObject({ status: "paid", amount_paisa: 150000, refunded_paisa: 50000 });
    await ingest(s.key, [part1]); // replay
    expect((await payment(s, "pr1")).payment.refunded_paisa).toBe(50000);
    await ingest(s.key, [part2]);
    p = (await payment(s, "pr1")).payment;
    expect(p).toMatchObject({ status: "refunded", refunded_paisa: 150000, amount_paisa: 150000 });
    // finished_at stays at the time it was paid.
    expect(p.finished_at).toBe(Date.parse(pd.ts));
    // A bare payment.refunded (no amount) means a full refund.
    const [st2, pd2] = paidAt("pr2", 0);
    await ingest(s.key, [st2, pd2, ev("payment.refunded", "pr2", 9000)]);
    expect((await payment(s, "pr2")).payment.status).toBe("refunded");
  });

  it("records fulfilled_at (first fulfilment) and the last gw_env seen", async () => {
    const s = await setup();
    const f1 = ev("payment.fulfilled", "ff1", 3000);
    await ingest(s.key, [ev("payment.started", "ff1", 0, { data: { gw_env: "sandbox", return_https: true } }), f1, ev("payment.fulfilled", "ff1", 4000)]);
    const p = (await payment(s, "ff1")).payment;
    expect(p.fulfilled_at).toBe(Date.parse(f1.ts));
    expect(p.gw_env).toBe("sandbox");
    expect(p.fulfil_count).toBe(2);
  });

  it("payment.annotated attaches order and customer data without changing the status", async () => {
    const s = await setup();
    await ingest(s.key, [ev("payment.started", "an1", 0, { status: "pending", amount_paisa: 2000 }), ev("payment.annotated", "an1", 100, { order_id: "ORD-AN", customer: { phone: "9800000001" } })]);
    const p = (await payment(s, "an1")).payment;
    expect(p).toMatchObject({ status: "pending", order_id: "ORD-AN", customer_mask: "98XXXXX001", amount_paisa: 2000 });
  });
});

describe("double payments (4.1)", () => {
  it("same order id, any time apart: the later-paid one gets an open duplicate case pointing at the earlier", async () => {
    const s = await setup();
    await ingest(s.key, paidAt("do1", -3 * 86_400_000, { order_id: "ORD-D" }));
    await ingest(s.key, paidAt("do2", 0, { order_id: "ORD-D" }));
    const list = await cases(s);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ kind: "duplicate", status: "open", attempt_id: "do2", related_attempt_id: "do1", reason: "same_order", gateway: "esewa", amount_paisa: 150000 });
    // Re-ingesting more events for either payment does not open a second case.
    await ingest(s.key, [ev("reconcile.checked", "do2", 5000, { status: "paid" })]);
    expect(await cases(s)).toHaveLength(1);
  });

  it("same customer and amount within 30 minutes is a duplicate; after 30 minutes or another amount it is not", async () => {
    const s = await setup();
    const phone = { customer: { phone: "+977 9841000001" } };
    await ingest(s.key, paidAt("dc1", 0, phone));
    await ingest(s.key, paidAt("dc2", 29 * 60_000, { customer: { phone: "9841000001" } }));
    await ingest(s.key, paidAt("dc3", 0, { ...phone, amount_paisa: 99900 }));
    await ingest(s.key, paidAt("dc4", 31 * 60_000 + 29 * 60_000, phone)); // 31 min after dc2
    const list = await cases(s);
    expect(list.map((c) => [c.attempt_id, c.related_attempt_id, c.reason])).toEqual([["dc2", "dc1", "same_customer_amount"]]);
  });

  it("finds the later-paid payment even when it arrives first", async () => {
    const s = await setup();
    await ingest(s.key, paidAt("oo2", 60_000, { order_id: "ORD-O" }));
    await ingest(s.key, paidAt("oo1", 0, { order_id: "ORD-O" }));
    expect((await cases(s)).map((c) => [c.attempt_id, c.related_attempt_id])).toEqual([["oo2", "oo1"]]);
  });

  it("a double_payment rule opens one incident per duplicate and notifies, batched", async () => {
    const s = await setup();
    const hooks: any[] = [];
    const real = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const req = new Request(input as RequestInfo, init);
      if (!req.url.startsWith("https://hooks.test/")) return real(input as RequestInfo, init);
      hooks.push(await req.json());
      return new Response("ok");
    });
    try {
      const ch = await json(call("POST", `/api/projects/${s.projectId}/channels`, { cookie: s.cookie, body: { type: "webhook", name: "w", config: { url: "https://hooks.test/dp" } } }));
      const r = await call("POST", `/api/projects/${s.projectId}/rules`, { cookie: s.cookie, body: { env: "test", type: "double_payment", channel_ids: [ch.id] } });
      expect(r.status).toBe(201);
      expect((await json(r)).params).toEqual({});
      await ingest(s.key, [...paidAt("da1", 0, { order_id: "ORD-A" }), ...paidAt("da2", 2000, { order_id: "ORD-A" })]);
      const incs = (await json(call("GET", `/api/projects/${s.projectId}/incidents`, { cookie: s.cookie }))).items;
      expect(incs).toHaveLength(1);
      expect(incs[0]).toMatchObject({ rule_type: "double_payment", attempt_id: "da2", state: "firing" });
      expect(incs[0].summary).toMatch(/^da2 on esewa \(Rs 1,500\.00\) duplicates da1 \(same order ORD-A\)\. Refund case rfc_[0-9a-f]+ is open\.$/);
      expect(hooks).toHaveLength(1);
      expect(hooks[0].type).toBe("incident.batch");
    } finally {
      vi.restoreAllMocks();
    }
  });
});

describe("refund cases auto-resolve", () => {
  it("a payment.refunded event or a refunded status closes open cases with the refund ref", async () => {
    const s = await setup();
    await ingest(s.key, [...paidAt("ar1", 0, { order_id: "ORD-R" }), ...paidAt("ar2", 2000, { order_id: "ORD-R" })]);
    expect((await cases(s))[0]).toMatchObject({ attempt_id: "ar2", status: "open" });
    await ingest(s.key, [ev("payment.refunded", "ar2", 10_000, { amount_paisa: 150000, data: { refund_ref: "KH-RF-9" } })]);
    expect((await cases(s))[0]).toMatchObject({ status: "refunded", refund_ref: "KH-RF-9", resolved_by: "auto" });

    // Status path: a reconcile that reports refunded.
    await ingest(s.key, [...paidAt("ar3", 0, { order_id: "ORD-S" }), ...paidAt("ar4", 2000, { order_id: "ORD-S" })]);
    await ingest(s.key, [ev("status.changed", "ar4", 20_000, { data: { from: "paid", to: "refunded", provider_status: "FULL_REFUND" } })]);
    expect((await cases(s)).find((c) => c.attempt_id === "ar4")).toMatchObject({ status: "refunded", refund_ref: null });
  });
});

// Kept here so the signature check sits next to the other crypto checks; the HTTP flow is in ops-api.test.ts.
describe("action signature format", () => {
  it("sha256=<hex HMAC-SHA256(secret, timestamp + '.' + body)>", async () => {
    const { signAction } = await import("../src/ops/actions.ts");
    const body = JSON.stringify({ id: "act_1", kind: "refund" });
    expect(await signAction("pas_secret", 1_762_000_000, body)).toBe("sha256=" + createHmac("sha256", "pas_secret").update(`1762000000.${body}`).digest("hex"));
  });
});

afterEach(() => vi.restoreAllMocks());

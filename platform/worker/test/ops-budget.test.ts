// D1 query budget for ingest. The Workers free plan allows 50 D1 queries per invocation, and every statement in a
// batch counts. This counts every statement one POST /v1/events runs (response and waitUntil work together) for a
// full 15-event batch (INGEST_MAX_EVENTS on the free plan) that exercises every v2 path at once.
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { newId, type PaymentEvent } from "@paynp/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index.ts";
import { BASE, call, json, setup } from "./helpers.ts";

/** Wraps a D1 binding and counts statements executed (each batch member counts as one). */
function countingDb(real: D1Database) {
  const state = { count: 0, log: [] as string[] };
  const raw = new WeakMap<object, D1PreparedStatement>();
  const sql = new WeakMap<object, string>();
  const wrap = (s: D1PreparedStatement, q: string): D1PreparedStatement => {
    const p = new Proxy(s, {
      get(target, prop) {
        if (prop === "bind") return (...a: unknown[]) => wrap(target.bind(...a), q);
        if (prop === "first" || prop === "all" || prop === "run" || prop === "raw") {
          return (...a: unknown[]) => {
            state.count++;
            state.log.push(q.trim().slice(0, 60));
            return (target as any)[prop](...a);
          };
        }
        const v = Reflect.get(target, prop, target);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    raw.set(p, s);
    sql.set(p, q);
    return p;
  };
  const db = new Proxy(real, {
    get(target, prop) {
      if (prop === "prepare") return (q: string) => wrap(target.prepare(q), q);
      if (prop === "batch") {
        return (stmts: D1PreparedStatement[]) => {
          state.count += stmts.length;
          for (const s of stmts) state.log.push(`[batch] ${(sql.get(s) ?? "?").trim().slice(0, 60)}`);
          return target.batch(stmts.map((s) => raw.get(s) ?? s));
        };
      }
      const v = Reflect.get(target, prop, target);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  return { db, state };
}

async function countedIngest(key: string, events: PaymentEvent[]) {
  const { db, state } = countingDb(env.DB);
  const req = new Request(`${BASE}/v1/events`, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ events }) });
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, { ...env, DB: db, INGEST_MAX_EVENTS: "15" } as Env, ctx);
  await waitOnExecutionContext(ctx);
  return { res, count: state.count, log: state.log };
}

const at = (type: PaymentEvent["type"], attempt: string, dt: number, extra: Partial<PaymentEvent> = {}): PaymentEvent => ({
  id: newId("evt"), type, ts: new Date(Date.now() - 60_000 + dt).toISOString(), attempt_id: attempt, gateway: "khalti", ...extra,
});

/** 15 events: a double payment (same order), a refund, a failure, a double fulfilment, customer data, sandbox gw_env,
 *  an http return URL, a rupee-sized khalti amount and a failed signature. Every v2 ingest path runs. */
function worstBatch(tag: string): PaymentEvent[] {
  const a = `${tag}a`, b = `${tag}b`, c = `${tag}c`;
  return [
    at("payment.started", a, 0, { status: "initiated", amount_paisa: 500, order_id: `O-${tag}`, customer: { phone: "+977 9841000000", email: "b@example.com", name: "B" }, data: { gw_env: "sandbox", return_https: false } }),
    at("payment.redirected", a, 10),
    at("callback.received", a, 20, { data: { source: "return" } }),
    at("signature.checked", a, 21, { data: { valid: false, reason: "bad_signature" } }),
    at("gateway.request", a, 30, { duration_ms: 400, data: { op: "lookup", http_status: 200, provider_ref: `PX-${tag}` } }),
    at("status.changed", a, 40, { data: { to: "paid" } }),
    at("payment.fulfilled", a, 50),
    at("payment.fulfilled", a, 51),
    at("payment.started", b, 100, { status: "initiated", amount_paisa: 500, order_id: `O-${tag}`, customer: { phone: "9841000000" } }),
    at("gateway.request", b, 110, { duration_ms: 300, data: { op: "lookup", http_status: 200, provider_ref: `PY-${tag}` } }),
    at("status.changed", b, 120, { data: { to: "paid" } }),
    at("payment.refunded", b, 130, { amount_paisa: 200, data: { refund_ref: `RF-${tag}` } }),
    at("payment.started", c, 200, { status: "initiated", amount_paisa: 900 }),
    at("status.changed", c, 210, { data: { to: "failed", reason: "amount_mismatch" } }),
    at("error", c, 220, { data: { reason: "timeout", message: "lookup timed out" } }),
  ];
}

afterEach(() => vi.restoreAllMocks());

describe("ingest D1 statement budget (free plan: 50 per invocation)", () => {
  it("a 15-event batch with every v2 path, every per-payment rule and a channel stays under 50", async () => {
    const real = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const req = new Request(input as RequestInfo, init);
      return req.url.startsWith("https://hooks.test/") ? new Response("ok") : real(input as RequestInfo, init);
    });
    const s = await setup("live");
    const ch = await json(call("POST", `/api/projects/${s.projectId}/channels`, { cookie: s.cookie, body: { type: "webhook", name: "w", config: { url: "https://hooks.test/budget" } } }));
    for (const type of ["payment_failed", "amount_mismatch", "double_fulfilment", "double_payment", "signature_failure", "paid_not_fulfilled"]) {
      expect((await call("POST", `/api/projects/${s.projectId}/rules`, { cookie: s.cookie, body: { env: "live", type, channel_ids: [ch.id] } })).status).toBe(201);
    }

    // First batch: also creates the project salt and stamps the key's last_used_at.
    const first = worstBatch("x");
    expect(first).toHaveLength(15);
    const r1 = await countedIngest(s.key, first);
    expect(r1.res.status).toBe(202);
    expect(await r1.res.json()).toEqual({ accepted: 15, duplicates: 0 });
    // Prove the batch did what it claims, so the count covers real work.
    const cases = await env.DB.prepare("SELECT attempt_id, status FROM refund_cases WHERE project_id = ?").bind(s.projectId).all();
    expect(cases.results).toEqual([{ attempt_id: "xb", status: "refunded" }]);
    const incs = await env.DB.prepare("SELECT COUNT(*) AS n FROM alert_incidents WHERE project_id = ?").bind(s.projectId).first<{ n: number }>();
    expect(incs!.n).toBeGreaterThanOrEqual(4);

    // Second batch in a later minute-slot of notifications: the steady state.
    const r2 = await countedIngest(s.key, worstBatch("y"));
    expect(r2.res.status).toBe(202);

    console.log(`[budget] first batch ${r1.count} statements, steady state ${r2.count}\n${r1.log.join("\n")}`);
    // Measured: 45 on the first batch (salt creation and last_used_at included), 36 after. Both include the finance
    // status_minutes upsert: live only, one statement per batch however many gateway minutes it touches.
    for (const r of [r1, r2]) expect(r.log.filter((l) => l.includes("INTO status_minutes")).length).toBe(1);
    expect(r1.count).toBeLessThanOrEqual(46);
    expect(r2.count).toBeLessThanOrEqual(40);
  });

  it("a plain 15-event batch (no rules, no customers) stays near 22", async () => {
    const s = await setup("test");
    const events = Array.from({ length: 15 }, (_, i) => at(i % 5 === 0 ? "payment.started" : "gateway.request", `plain${Math.floor(i / 5)}`, i, { duration_ms: 100 }));
    const r = await countedIngest(s.key, events);
    expect(r.res.status).toBe(202);
    console.log(`[budget] plain batch ${r.count} statements`);
    expect(r.count).toBeLessThanOrEqual(25);
  });
});

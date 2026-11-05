import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { call, ev, ingest, json, payment, setup } from "./helpers.ts";

describe("POST /v1/events", () => {
  it("rejects missing, malformed, revoked and cross-env keys", async () => {
    const s = await setup();
    expect((await ingest("", [])).status).toBe(401);
    expect((await ingest("pnp_test_short", [])).status).toBe(401);
    expect((await ingest(s.key.replace("pnp_test_", "pnp_live_"), [])).status).toBe(401);
    const keys = await json(call("GET", `/api/projects/${s.projectId}/keys`, { cookie: s.cookie }));
    expect(keys.items[0].prefix).toBe(s.key.slice(0, 13));
    expect(keys.items[0]).not.toHaveProperty("key");
    expect((await call("DELETE", `/api/projects/${s.projectId}/keys/${keys.items[0].id}`, { cookie: s.cookie })).status).toBe(204);
    expect((await ingest(s.key, [])).status).toBe(401);
  });

  it("validates per event: invalid ones are listed, valid ones are still accepted", async () => {
    const s = await setup();
    const good = ev("payment.started", "v1", 0, { amount_paisa: 1000 });
    const res = await ingest(s.key, [good, { ...good, id: "evt_x", type: "nope" }, { id: "evt_y", type: "error", ts: "yesterday", attempt_id: "v1", gateway: "esewa" }]);
    expect(res.status).toBe(400);
    const body = await json(res);
    expect(body.accepted).toBe(1);
    expect(body.errors.map((e: { index: number }) => e.index)).toEqual([1, 2]);
    expect((await payment(s, "v1")).payment.amount_paisa).toBe(1000);
  });

  it("redacts data server side: unknown keys, card numbers and PEM blocks are dropped; the event is kept", async () => {
    const s = await setup();
    const e = ev("error", "r1", 0, {
      data: { secret_key: "8gBm/:&EnhH.1/q", message: "card 4111 1111 1111 1111 declined", reason: "timeout", endpoint: "/status?pidx=abc", provider_code: "-----BEGIN PRIVATE KEY-----" } as never,
    });
    expect((await ingest(s.key, [e])).status).toBe(202);
    const d = await payment(s, "r1");
    expect(d.events[0].data).toEqual({ reason: "timeout", endpoint: "/status" });
  });

  it("413 on more than 100 events or more than 256 KB, 400 on a body that is not {events}", async () => {
    const s = await setup();
    const many = Array.from({ length: 101 }, (_, i) => ev("gateway.request", "big", i));
    expect((await ingest(s.key, many)).status).toBe(413);
    const huge = JSON.stringify({ events: [ev("error", "big", 0, { data: { message: "x".repeat(300 * 1024) } })] });
    expect((await call("POST", "/v1/events", { key: s.key, raw: huge })).status).toBe(413);
    expect((await call("POST", "/v1/events", { key: s.key, raw: "[]" })).status).toBe(400);
    expect((await call("POST", "/v1/events", { key: s.key, raw: "{not json" })).status).toBe(400);
  });

  it("INGEST_MAX_EVENTS lowers the cap for the free plan", async () => {
    const s = await setup();
    const saved = env.INGEST_MAX_EVENTS;
    env.INGEST_MAX_EVENTS = "15";
    try {
      const batch = (n: number) => Array.from({ length: n }, (_, i) => ev("gateway.request", `cap${n}`, i));
      expect((await ingest(s.key, batch(16))).status).toBe(413);
      expect((await ingest(s.key, batch(15))).status).toBe(202);
    } finally {
      env.INGEST_MAX_EVENTS = saved;
    }
  });

  it("429 with Retry-After once a key passes its limit", async () => {
    const s = await setup();
    const statuses: number[] = [];
    let retry: string | null = null;
    for (let i = 0; i < 12; i++) {
      const r = await ingest(s.key, []);
      statuses.push(r.status);
      if (r.status === 429) retry = r.headers.get("retry-after");
    }
    expect(statuses).toContain(202);
    expect(statuses).toContain(429);
    expect(retry).toBe("1");
  });

  it("is idempotent on (project, env, id), within a batch and across retries", async () => {
    const s = await setup();
    const a = ev("payment.started", "i1", 0, { amount_paisa: 500, status: "initiated" });
    const b = ev("payment.fulfilled", "i1", 10);
    expect(await json(ingest(s.key, [a, a, b]))).toEqual({ accepted: 2, duplicates: 1 });
    expect(await json(ingest(s.key, [a, b]))).toEqual({ accepted: 0, duplicates: 2 });
    const d = await payment(s, "i1");
    expect(d.payment.event_count).toBe(2);
    expect(d.payment.fulfil_count).toBe(1);
    expect(d.events).toHaveLength(2);
  });
});

describe("rollup rules", () => {
  it("out-of-order events converge: final status lands even when older, never regresses to open", async () => {
    const s = await setup();
    const started = ev("payment.started", "o1", 0, { status: "initiated", amount_paisa: 150000, order_id: "ORD-1" });
    const pending = ev("status.changed", "o1", 30_000, { data: { to: "pending" } });
    const paid = ev("status.changed", "o1", 20_000, { data: { from: "pending", to: "paid" }, });
    const lateUnknown = ev("reconcile.checked", "o1", 60_000, { status: "unknown" });
    // paid (older) arrives after a newer pending; then a newer non-final status must not reopen it.
    await ingest(s.key, [pending]);
    await ingest(s.key, [paid, started]);
    await ingest(s.key, [lateUnknown]);
    const p = (await payment(s, "o1")).payment;
    expect(p.status).toBe("paid");
    expect(p.started_at).toBe(Date.parse(started.ts));
    expect(p.updated_at).toBe(Date.parse(lateUnknown.ts));
    expect(p.finished_at).toBe(Date.parse(paid.ts));
    expect(p.order_id).toBe("ORD-1");
    expect(p.amount_paisa).toBe(150000);

    // The same events in the opposite order give the same row.
    const s2 = await setup();
    for (const e of [lateUnknown, started, paid, pending]) await ingest(s2.key, [{ ...e, attempt_id: "o1" }]);
    const p2 = (await payment(s2, "o1")).payment;
    expect({ ...p2, env: undefined }).toEqual({ ...p, env: undefined });
  });

  it("an older final status does not replace a newer final status; a newer one does", async () => {
    const s = await setup();
    await ingest(s.key, [ev("status.changed", "f1", 10_000, { data: { to: "failed" } })]);
    await ingest(s.key, [ev("status.changed", "f1", 5_000, { data: { to: "canceled" } })]);
    expect((await payment(s, "f1")).payment.status).toBe("failed");
    // A late paid (reconcile found the money) wins over the earlier failure.
    await ingest(s.key, [ev("status.changed", "f1", 50_000, { data: { to: "paid", source: "reconcile" } })]);
    expect((await payment(s, "f1")).payment.status).toBe("paid");
  });

  it("counts errors, invalid signatures and fulfilments; keeps the latest reason and provider ref", async () => {
    const s = await setup();
    await ingest(s.key, [
      ev("signature.checked", "c1", 3_000, { data: { valid: false, reason: "bad_signature" } }),
      ev("signature.checked", "c1", 4_000, { data: { valid: true } }),
      ev("error", "c1", 1_000, { data: { reason: "timeout", message: "status call timed out" } }),
      ev("gateway.request", "c1", 5_000, { data: { provider_ref: "0LD5CEH", http_status: 200 } }),
      ev("payment.fulfilled", "c1", 6_000),
      ev("payment.fulfilled", "c1", 7_000),
    ]);
    const p = (await payment(s, "c1")).payment;
    expect(p.error_count).toBe(2);
    expect(p.fulfil_count).toBe(2);
    expect(p.last_reason).toBe("bad_signature");
    expect(p.last_message).toBe(null);
    expect(p.provider_ref).toBe("0LD5CEH");
    expect(p.event_count).toBe(6);
  });

  it("minute_stats follow status transitions: no double counting, failed then paid moves the count", async () => {
    const s = await setup();
    await ingest(s.key, [
      ev("payment.started", "m1", 0, { amount_paisa: 1000, status: "initiated" }),
      ev("gateway.request", "m1", 100, { duration_ms: 300, data: { http_status: 200 } }),
      ev("gateway.request", "m1", 200, { duration_ms: 900, data: { http_status: 503 } }),
      ev("status.changed", "m1", 1_000, { data: { to: "failed" } }),
      ev("error", "m1", 1_001, { status: "failed" }),
    ]);
    const sum = async () =>
      env.DB.prepare("SELECT SUM(started) s, SUM(paid) p, SUM(failed) f, SUM(paid_amount_paisa) a, SUM(gw_requests) r, SUM(gw_errors) e, SUM(gw_ms_total) ms, MAX(gw_ms_max) mx FROM minute_stats WHERE project_id = ?")
        .bind(s.projectId)
        .first();
    expect(await sum()).toEqual({ s: 1, p: 0, f: 1, a: 0, r: 2, e: 1, ms: 1200, mx: 900 });
    await ingest(s.key, [ev("status.changed", "m1", 90_000, { data: { to: "paid" } }), ev("status.changed", "m1", 91_000, { status: "paid" })]);
    expect(await sum()).toMatchObject({ s: 1, p: 1, f: 0, a: 1000 });
  });
});

import { describe, expect, it } from "vitest";
import { call, cookieFrom, ev, ingest, json, payment, setup, signUp, tokenFromMail, uniqueEmail, type Setup } from "./helpers.ts";

async function member(owner: Setup, role: "admin" | "viewer") {
  const email = uniqueEmail(role);
  await call("POST", `/api/orgs/${owner.orgId}/invites`, { cookie: owner.cookie, body: { email, role } });
  const cookie = cookieFrom(await call("GET", `/auth/invite?token=${tokenFromMail(email, "/auth/invite")}`));
  const me = await json(call("GET", "/api/me", { cookie }));
  return { email, cookie, userId: me.user.id as string };
}

describe("role checks", () => {
  it("viewer reads, admin manages, owner deletes; outsiders get 404", async () => {
    const owner = await setup();
    const viewer = await member(owner, "viewer");
    const admin = await member(owner, "admin");
    const outsider = await signUp();
    const p = `/api/projects/${owner.projectId}`;

    for (const path of [p, `${p}/payments?env=test`, `${p}/events?env=test`, `${p}/analytics?env=test`, `${p}/health?env=test`, `${p}/incidents`]) {
      expect((await call("GET", path, { cookie: viewer.cookie })).status, path).toBe(200);
      expect((await call("GET", path, { cookie: outsider.cookie })).status, path).toBe(404);
    }
    expect((await call("GET", `${p}/keys`, { cookie: viewer.cookie })).status).toBe(403);
    expect((await call("POST", `${p}/keys`, { cookie: viewer.cookie, body: { env: "test" } })).status).toBe(403);
    expect((await call("GET", `${p}/channels`, { cookie: viewer.cookie })).status).toBe(403);
    expect((await call("GET", `${p}/rules`, { cookie: viewer.cookie })).status).toBe(403);
    expect((await call("PATCH", p, { cookie: viewer.cookie, body: { name: "x" } })).status).toBe(403);
    expect((await call("GET", `/api/orgs/${owner.orgId}/members`, { cookie: viewer.cookie })).status).toBe(403);
    expect((await call("POST", `/api/orgs/${owner.orgId}/projects`, { cookie: viewer.cookie, body: { name: "nope" } })).status).toBe(403);

    expect((await call("POST", `${p}/keys`, { cookie: admin.cookie, body: { env: "live", name: "prod" } })).status).toBe(201);
    expect((await call("PATCH", p, { cookie: admin.cookie, body: { name: "Shop" } })).status).toBe(200);
    expect((await call("DELETE", p, { cookie: admin.cookie })).status).toBe(403);
    // Admins cannot touch owners or create them.
    const members = await json(call("GET", `/api/orgs/${owner.orgId}/members`, { cookie: admin.cookie }));
    const ownerId = members.items.find((m: { role: string }) => m.role === "owner").user_id;
    expect((await call("PATCH", `/api/orgs/${owner.orgId}/members/${ownerId}`, { cookie: admin.cookie, body: { role: "viewer" } })).status).toBe(403);
    expect((await call("PATCH", `/api/orgs/${owner.orgId}/members/${viewer.userId}`, { cookie: admin.cookie, body: { role: "owner" } })).status).toBe(403);
    expect((await call("PATCH", `/api/orgs/${owner.orgId}/members/${viewer.userId}`, { cookie: admin.cookie, body: { role: "admin" } })).status).toBe(200);
    // The last owner cannot be demoted or removed.
    expect((await call("DELETE", `/api/orgs/${owner.orgId}/members/${ownerId}`, { cookie: owner.cookie })).status).toBe(409);
    expect((await call("DELETE", `/api/orgs/${owner.orgId}/members/${admin.userId}`, { cookie: owner.cookie })).status).toBe(204);
    expect((await call("GET", p, { cookie: admin.cookie })).status).toBe(404);

    await ingest(owner.key, [ev("payment.started", "del1", 0)]);
    expect((await call("DELETE", p, { cookie: owner.cookie })).status).toBe(204);
    expect((await call("GET", p, { cookie: owner.cookie })).status).toBe(404);
    expect((await ingest(owner.key, [])).status).toBe(401);
  });
});

describe("payments, events, analytics, health", () => {
  it("cursor pagination walks every payment exactly once, newest first, with filters", async () => {
    const s = await setup();
    const events = Array.from({ length: 7 }, (_, i) =>
      ev("payment.started", `pg${i}`, i * 1000, { order_id: `ORD-${i}`, amount_paisa: (i + 1) * 1000, status: i % 2 ? "failed" : "initiated", gateway: i < 5 ? "esewa" : "khalti" }),
    );
    await ingest(s.key, events);
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const r: { items: { attempt_id: string }[]; next_cursor: string | null } = await json(
        call("GET", `/api/projects/${s.projectId}/payments?env=test&limit=3${cursor ? `&cursor=${cursor}` : ""}`, { cookie: s.cookie }),
      );
      seen.push(...r.items.map((p) => p.attempt_id));
      cursor = r.next_cursor;
    } while (cursor);
    expect(seen).toEqual(["pg6", "pg5", "pg4", "pg3", "pg2", "pg1", "pg0"]);

    const q = (qs: string) => json(call("GET", `/api/projects/${s.projectId}/payments?${qs.includes("env=") ? "" : "env=test&"}${qs}`, { cookie: s.cookie })).then((r) => r.items.map((p: { attempt_id: string }) => p.attempt_id));
    expect(await q("status=failed")).toEqual(["pg5", "pg3", "pg1"]);
    expect(await q("gateway=khalti")).toEqual(["pg6", "pg5"]);
    expect(await q("q=ORD-4")).toEqual(["pg4"]);
    expect(await q("q=pg_")).toEqual([]); // LIKE wildcards are literal
    expect(await q("min=3000&max=4000")).toEqual(["pg3", "pg2"]);
    expect(await q("env=live")).toEqual([]);
    expect((await call("GET", `/api/projects/${s.projectId}/payments?cursor=garbage`, { cookie: s.cookie })).status).toBe(400);
  });

  it("payment detail returns events in time order and the explain card for the failure", async () => {
    const s = await setup();
    await ingest(s.key, [
      ev("status.changed", "d1", 3000, { data: { from: "initiated", to: "failed", reason: "bad_signature" } }),
      ev("payment.started", "d1", 0, { status: "initiated", amount_paisa: 10000 }),
      ev("error", "d1", 2000, { data: { provider_code: "ES104", message: "Invalid payload signature." } }),
    ]);
    const d = await payment(s, "d1");
    expect(d.events.map((e: { type: string }) => e.type)).toEqual(["payment.started", "error", "status.changed"]);
    expect(d.events[0]).toHaveProperty("received_at");
    expect(d.explain.title).toMatch(/eSewa rejected the payload signature/);
    expect(d.explain.docs_url).toMatch(/esewa\.md$/);
    expect((await call("GET", `/api/projects/${s.projectId}/payments/nope?env=test`, { cookie: s.cookie })).status).toBe(404);

    await ingest(s.key, [ev("payment.started", "d2", 0, { status: "initiated" }), ev("status.changed", "d2", 10, { data: { to: "paid" } })]);
    expect((await payment(s, "d2")).explain).toBeNull();
  });

  it("events list filters by type and gateway", async () => {
    const s = await setup();
    await ingest(s.key, [ev("payment.started", "e1", 0), ev("gateway.request", "e1", 10, { duration_ms: 5 }), ev("payment.started", "e2", 20, { gateway: "khalti" })]);
    const r = await json(call("GET", `/api/projects/${s.projectId}/events?env=test&type=payment.started`, { cookie: s.cookie }));
    expect(r.items.map((e: { attempt_id: string }) => e.attempt_id)).toEqual(["e2", "e1"]);
    const g = await json(call("GET", `/api/projects/${s.projectId}/events?env=test&gateway=khalti`, { cookie: s.cookie }));
    expect(g.items).toHaveLength(1);
  });

  it("analytics: totals, success rate, revenue, reasons, time to pay and the funnel", async () => {
    const s = await setup();
    const trace = (id: string, at: number, ok: boolean, amount: number) => [
      ev("payment.started", id, at, { status: "initiated", amount_paisa: amount }),
      ev("payment.redirected", id, at + 100),
      ...(ok
        ? [ev("callback.received", id, at + 30_000), ev("gateway.request", id, at + 30_100, { duration_ms: 400, data: { http_status: 200 } }), ev("status.changed", id, at + 31_000, { data: { to: "paid" } })]
        : [ev("status.changed", id, at + 5_000, { data: { to: "failed", reason: "amount_mismatch" } })]),
    ];
    await ingest(s.key, [...trace("a1", 0, true, 100000), ...trace("a2", 1000, true, 50000), ...trace("a3", 2000, false, 9900), ev("payment.started", "a4", 3000)]);
    const a = await json(call("GET", `/api/projects/${s.projectId}/analytics?env=test&from=${Date.now() - 3600_000}&bucket=hour`, { cookie: s.cookie }));
    expect(a.totals).toEqual({ started: 4, paid: 2, failed: 1, revenue_paisa: 150000, success_rate: 2 / 3 });
    expect(a.by_gateway).toEqual([{ gateway: "esewa", started: 4, paid: 2, failed: 1, revenue_paisa: 150000, success_rate: 2 / 3 }]);
    expect(a.failure_reasons).toEqual([{ reason: "amount_mismatch", count: 1 }]);
    expect(a.time_to_pay_ms).toEqual({ p50: 31000, p95: 31000 });
    expect(a.funnel).toEqual({ started: 4, redirected: 3, callback: 2, paid: 2 });
    const busy = a.series.filter((p: { started: number }) => p.started > 0);
    expect(busy.reduce((n: number, p: { started: number }) => n + p.started, 0)).toBe(4);
    expect(a.series.every((p: { t: number }) => (p.t + (5 * 60 + 45) * 60_000) % 3600_000 === 0)).toBe(true);
    expect(busy[0].gw_latency_avg).toBe(400);
    const day = await json(call("GET", `/api/projects/${s.projectId}/analytics?env=test&bucket=day`, { cookie: s.cookie }));
    expect(day.series).toHaveLength(8);
    expect((await call("GET", `/api/projects/${s.projectId}/analytics?bucket=week`, { cookie: s.cookie })).status).toBe(400);
  });

  it("health marks gateways ok, degraded, down and idle", async () => {
    const s = await setup();
    const recent = (gw: string, i: number, status: number, ms = 200) => ({ ...ev("gateway.request", `h-${gw}`, 0, { gateway: gw, duration_ms: ms, data: { http_status: status } }), ts: new Date(Date.now() - 60_000 - i).toISOString() });
    await ingest(s.key, [
      ...[0, 1, 2, 3].map((i) => recent("esewa", i, 200)),
      ...[0, 1, 2, 3].map((i) => recent("khalti", i, 502)),
      ...[0, 1, 2].map((i) => recent("fonepay", i, 200, 7000)),
      { ...ev("gateway.request", "old", 0, { gateway: "nps", data: { http_status: 200 } }), ts: new Date(Date.now() - 3600_000).toISOString() },
    ]);
    const h = await json(call("GET", `/api/projects/${s.projectId}/health?env=test`, { cookie: s.cookie }));
    const by = Object.fromEntries(h.items.map((g: { gateway: string; state: string }) => [g.gateway, g]));
    expect(by.esewa).toMatchObject({ state: "ok", requests: 4, error_rate: 0, latency_avg: 200 });
    expect(by.khalti).toMatchObject({ state: "down", error_rate: 1 });
    expect(by.fonepay).toMatchObject({ state: "degraded", latency_max: 7000 });
    expect(by.nps).toMatchObject({ state: "idle", requests: 0 });
  });
});

describe("channels and rules", () => {
  it("masks secrets except on create, validates config and rule params", async () => {
    const s = await setup();
    const p = `/api/projects/${s.projectId}`;
    const ch = await json(call("POST", `${p}/channels`, { cookie: s.cookie, body: { type: "webhook", name: "hook", config: { url: "https://hooks.example/paynp" } } }));
    expect(ch.config.secret).toMatch(/^whsec_[0-9A-Za-z]{32}$/);
    const list = await json(call("GET", `${p}/channels`, { cookie: s.cookie }));
    expect(list.items[0].config.secret).toMatch(/\*\*\*\*/);
    // PATCH with the masked secret keeps the real one.
    await call("PATCH", `${p}/channels/${ch.id}`, { cookie: s.cookie, body: { name: "renamed", config: list.items[0].config } });
    const { env } = await import("cloudflare:workers");
    const row = await env.DB.prepare("SELECT config FROM alert_channels WHERE id = ?").bind(ch.id).first<{ config: string }>();
    expect(JSON.parse(row!.config).secret).toBe(ch.config.secret);

    expect((await call("POST", `${p}/channels`, { cookie: s.cookie, body: { type: "email", config: { to: ["not-an-email"] } } })).status).toBe(400);
    expect((await call("POST", `${p}/channels`, { cookie: s.cookie, body: { type: "slack", config: { webhook_url: "ftp://x" } } })).status).toBe(400);
    expect((await call("POST", `${p}/channels`, { cookie: s.cookie, body: { type: "pager" } })).status).toBe(400);

    const rule = await json(call("POST", `${p}/rules`, { cookie: s.cookie, body: { type: "failure_rate", env: "live", params: { threshold_pct: 30 }, channel_ids: [ch.id] } }));
    expect(rule.params).toEqual({ threshold_pct: 30, window_min: 15, min_payments: 5 });
    expect(rule).toMatchObject({ env: "live", cooldown_min: 30, enabled: true });
    expect((await call("POST", `${p}/rules`, { cookie: s.cookie, body: { type: "failure_rate", params: { threshold: 3 } } })).status).toBe(400);
    expect((await call("POST", `${p}/rules`, { cookie: s.cookie, body: { type: "failure_rate", params: { threshold_pct: 300 } } })).status).toBe(400);
    expect((await call("POST", `${p}/rules`, { cookie: s.cookie, body: { type: "payment_failed", channel_ids: ["chn_nope"] } })).status).toBe(400);
    expect((await call("POST", `${p}/rules`, { cookie: s.cookie, body: { type: "unknown" } })).status).toBe(400);
    const patched = await json(call("PATCH", `${p}/rules/${rule.id}`, { cookie: s.cookie, body: { enabled: false, cooldown_min: 5 } }));
    expect(patched).toMatchObject({ enabled: false, cooldown_min: 5 });
    expect((await call("DELETE", `${p}/rules/${rule.id}`, { cookie: s.cookie })).status).toBe(204);
    expect((await json(call("GET", `${p}/rules`, { cookie: s.cookie }))).items).toHaveLength(0);
  });

  it("unknown API routes are JSON 404s", async () => {
    const s = await setup();
    const r = await call("GET", "/api/nothing", { cookie: s.cookie });
    expect(r.status).toBe(404);
    expect(await r.json()).toMatchObject({ error: { code: "not_found" } });
  });
});

describe("test payment", () => {
  it("POST /test-payment ingests the synthetic eSewa trace into the test env", async () => {
    const s = await setup();
    const r = await json(call("POST", `/api/projects/${s.projectId}/test-payment`, { cookie: s.cookie }));
    expect(r).toMatchObject({ env: "test", accepted: 7 });
    const d = await payment(s, r.attempt_id);
    expect(d.payment).toMatchObject({ status: "paid", amount_paisa: 10000, fulfil_count: 1, provider_ref: "0LD5CEH", gateway: "esewa" });
    expect(d.events.map((e: { type: string }) => e.type)).toEqual([
      "payment.started", "payment.redirected", "callback.received", "signature.checked", "gateway.request", "status.changed", "payment.fulfilled",
    ]);
  });
});

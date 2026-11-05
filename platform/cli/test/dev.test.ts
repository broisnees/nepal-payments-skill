// `paynp dev`: ingest, the /api subset the dashboard reads, the live WebSocket, the bundled dashboard with SPA
// fallback, storage, and the command itself.
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { newId, type PaymentEvent } from "../../shared/src/events.ts";
import type { LiveMessage } from "../../shared/src/api.ts";
import { HELP, run } from "../src/cli.ts";
import { startDevServer, type DevServer } from "../src/dev/server.ts";
import { DevStore, loadSqlite } from "../src/dev/store.ts";
import type { Io } from "../src/ui.ts";

const hasSqlite = (await loadSqlite()) !== null;
const tmp = (name: string) => mkdtempSync(join(tmpdir(), `paynp-dev-${name}-`));

let srv: DevServer;
let base: string;
beforeEach(async () => {
  srv = await startDevServer({ port: 0, host: "127.0.0.1", store: await DevStore.open(), dashboardDir: null });
  base = `http://127.0.0.1:${srv.port}`;
});
afterEach(() => srv.close());

const ev = (type: PaymentEvent["type"], attempt: string, offset: number, extra: Partial<PaymentEvent> = {}): PaymentEvent => ({
  id: newId("evt"),
  type,
  ts: new Date(Date.now() - 60_000 + offset).toISOString(),
  attempt_id: attempt,
  gateway: "esewa",
  ...extra,
});
const post = (events: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}/v1/events`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof events === "string" ? events : JSON.stringify({ events }) });
const get = async (path: string) => {
  const r = await fetch(base + path);
  return { status: r.status, body: await r.json() };
};
/** Raw request, so the Host header can be anything. */
const raw = (path: string, host: string, method = "GET", body?: string) =>
  new Promise<number>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: srv.port, path, method, headers: { host, "content-type": "application/json" } }, (res) => {
      res.resume();
      resolve(res.statusCode!);
    });
    req.on("error", reject);
    req.end(body);
  });

describe("ingest", () => {
  it("/v1/health says local, for GET and HEAD", async () => {
    expect(await get("/v1/health")).toEqual({ status: 200, body: { ok: true, mode: "local", name: "paynp", version: expect.any(String) } });
    expect((await fetch(`${base}/v1/health`, { method: "HEAD" })).status).toBe(200);
  });

  it("takes any key or none; pnp_live_ goes to live, the rest to test", async () => {
    expect((await post([ev("payment.started", "k1", 0, { amount_paisa: 100 })])).status).toBe(202);
    expect((await post([ev("payment.started", "k2", 0)], { authorization: "Bearer whatever" })).status).toBe(202);
    expect((await post([ev("payment.started", "k3", 0)], { authorization: "Bearer pnp_live_x" })).status).toBe(202);
    const test = (await get("/api/projects/local/payments?env=test")).body.items.map((p: { attempt_id: string }) => p.attempt_id);
    const live = (await get("/api/projects/local/payments?env=live")).body.items.map((p: { attempt_id: string }) => p.attempt_id);
    expect(test.sort()).toEqual(["k1", "k2"]);
    expect(live).toEqual(["k3"]);
  });

  it("validates and redacts like the worker: 400 lists bad events, good ones still land; duplicates count", async () => {
    const good = ev("error", "v1", 0, { data: { reason: "timeout", secret: "x", message: "card 4111 1111 1111 1111", endpoint: "/s?pidx=1" } as never });
    const r = await post([good, { ...good, id: "evt_bad", type: "nope" }, good]);
    expect(r.status).toBe(400);
    const body = await r.json();
    expect(body).toMatchObject({ accepted: 1, duplicates: 1, errors: [{ index: 1, id: "evt_bad" }], error: { code: "invalid_events" } });
    const d = (await get("/api/projects/local/payments/v1")).body;
    expect(d.events[0].data).toEqual({ reason: "timeout", endpoint: "/s" });
    expect(await (await post([good])).json()).toEqual({ accepted: 0, duplicates: 1 });
  });

  it("413 over 100 events or 256 KB, 400 on a body that is not {events}, 415 without JSON content type", async () => {
    expect((await post(Array.from({ length: 101 }, (_, i) => ev("gateway.request", "big", i)))).status).toBe(413);
    expect((await post(JSON.stringify({ events: [ev("error", "big", 0, { data: { message: "x".repeat(300 * 1024) } })] }))).status).toBe(413);
    expect((await post("[]")).status).toBe(400);
    expect((await post("{nope")).status).toBe(400);
    const plain = await fetch(`${base}/v1/events`, { method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify({ events: [] }) });
    expect(plain.status).toBe(415);
  });

  it("answers ingest from any host, but /api only on localhost", async () => {
    expect(await raw("/v1/events", "evil.example", "POST", JSON.stringify({ events: [] }))).toBe(202);
    expect(await raw("/api/me", "evil.example")).toBe(403);
    expect(await raw("/api/me", `localhost:${srv.port}`)).toBe(200);
    expect(await raw("/", "rebind.example")).toBe(403);
  });
});

describe("/api", () => {
  it("me, mode, the one org and project, in the worker's shapes", async () => {
    expect((await get("/api/me")).body).toEqual({
      user: { id: "local", email: "dev@localhost", name: "Local developer", digest: false },
      orgs: [{ id: "local", name: "Local", role: "owner" }],
      mode: "local",
    });
    expect((await get("/api/mode")).body).toMatchObject({ mode: "local", storage: "memory", project: "local" });
    expect((await get("/api/orgs/local/projects")).body).toEqual({ items: [{ id: "local", org_id: "local", name: "Local", slug: "local", created_at: expect.any(Number) }], next_cursor: null });
    expect((await get("/api/projects/local")).body).toMatchObject({ id: "local", role: "owner" });
    expect((await get("/api/projects/prj_other")).status).toBe(404);
    expect((await get("/api/orgs/other/projects")).status).toBe(404);
  });

  it("alerts, keys, members, sessions and tokens are empty; writes need the CSRF header", async () => {
    for (const p of ["/api/projects/local/incidents?state=firing", "/api/projects/local/rules", "/api/projects/local/channels", "/api/projects/local/keys", "/api/orgs/local/members", "/api/sessions", "/api/pats"]) {
      expect((await get(p)).body).toEqual({ items: [], next_cursor: null });
    }
    expect((await fetch(`${base}/api/projects/local/keys`, { method: "POST", headers: { "x-paynp-csrf": "1" } })).status).toBe(404);
    expect((await fetch(`${base}/api/projects/local/test-payment`, { method: "POST" })).status).toBe(403);
  });

  it("payments: filters, search, cursor pagination; detail with timeline and explain", async () => {
    for (let i = 0; i < 5; i++) await post([ev("payment.started", `pg${i}`, i * 1000, { amount_paisa: 1000 * (i + 1), order_id: `ORD-${i}`, status: "initiated" })]);
    await post([
      ev("callback.received", "pg4", 10_000, { data: { method: "GET" } }),
      ev("signature.checked", "pg4", 10_010, { data: { valid: false, reason: "bad_signature" } }),
      ev("status.changed", "pg3", 12_000, { status: "paid", data: { to: "paid" } }),
    ]);
    const page1 = (await get("/api/projects/local/payments?limit=2")).body;
    expect(page1.items.map((p: { attempt_id: string }) => p.attempt_id)).toEqual(["pg4", "pg3"]);
    const page2 = (await get(`/api/projects/local/payments?limit=2&cursor=${page1.next_cursor}`)).body;
    expect(page2.items.map((p: { attempt_id: string }) => p.attempt_id)).toEqual(["pg2", "pg1"]);
    const page3 = (await get(`/api/projects/local/payments?limit=2&cursor=${page2.next_cursor}`)).body;
    expect(page3).toMatchObject({ items: [{ attempt_id: "pg0" }], next_cursor: null });
    expect((await get("/api/projects/local/payments?status=paid")).body.items.map((p: { attempt_id: string }) => p.attempt_id)).toEqual(["pg3"]);
    expect((await get("/api/projects/local/payments?q=ord-2")).body.items.map((p: { attempt_id: string }) => p.attempt_id)).toEqual(["pg2"]);
    expect((await get("/api/projects/local/payments?min=2000&max=3000")).body.items).toHaveLength(2);
    expect((await get("/api/projects/local/payments?gateway=khalti")).body.items).toEqual([]);
    expect((await get("/api/projects/local/payments?cursor=garbage!")).status).toBe(400);

    const d = (await get("/api/projects/local/payments/pg4")).body;
    expect(d.payment).toMatchObject({ attempt_id: "pg4", status: "initiated", error_count: 1, event_count: 3, amount_paisa: 5000 });
    expect(d.events.map((e: PaymentEvent) => e.type)).toEqual(["payment.started", "callback.received", "signature.checked"]);
    expect(d.explain).toMatchObject({ title: expect.any(String), cause: expect.any(String), fix: expect.any(String) });
    expect((await get("/api/projects/local/payments/pg3")).body.explain).toBeNull();
    expect((await get("/api/projects/local/payments/nope")).status).toBe(404);
  });

  it("events, analytics and health", async () => {
    const r = await fetch(`${base}/api/projects/local/test-payment`, { method: "POST", headers: { "x-paynp-csrf": "1" } });
    expect(r.status).toBe(201);
    const { attempt_id, env, accepted } = await r.json();
    expect({ env, accepted }).toEqual({ env: "test", accepted: 7 });
    const evs = (await get("/api/projects/local/events?limit=3")).body;
    expect(evs.items).toHaveLength(3);
    expect(evs.items[0]).toMatchObject({ type: "payment.fulfilled", attempt_id, received_at: expect.any(Number) });
    expect((await get("/api/projects/local/events?type=gateway.request")).body.items).toHaveLength(1);

    const a = (await get(`/api/projects/local/analytics?from=${Date.now() - 86_400_000}&to=${Date.now() + 60_000}&bucket=hour`)).body;
    expect(Object.keys(a).sort()).toEqual(["by_gateway", "failure_reasons", "funnel", "series", "time_to_pay_ms", "totals"]);
    expect(a.totals).toMatchObject({ started: 1, paid: 1, failed: 0, revenue_paisa: 10000, success_rate: 1 });
    expect(a.funnel).toEqual({ started: 1, redirected: 1, callback: 1, paid: 1 });
    expect(a.by_gateway).toEqual([{ gateway: "esewa", started: 1, paid: 1, failed: 0, revenue_paisa: 10000, success_rate: 1 }]);
    expect(a.time_to_pay_ms.p50).toBeGreaterThan(30_000);
    expect(a.series.length).toBeGreaterThanOrEqual(24);
    expect((await get("/api/projects/local/analytics?bucket=week")).status).toBe(400);

    expect((await get("/api/projects/local/health")).body).toEqual({
      items: [{ gateway: "esewa", requests: 1, error_rate: 0, latency_avg: 612, latency_max: 612, state: "ok" }],
      next_cursor: null,
    });
  });
});

describe("live WebSocket", () => {
  it("backlog first, then each event with its payment; ping answered", async () => {
    await post([ev("payment.started", "ws0", 0, { amount_paisa: 500 })]);
    const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/api/projects/local/live?env=test`);
    const got: LiveMessage[] = [];
    const wait = (pred: () => boolean) =>
      new Promise<void>((resolve, reject) => {
        const t = setInterval(() => pred() && (clearInterval(t), resolve()), 10);
        setTimeout(() => (clearInterval(t), reject(new Error(`timed out; got ${JSON.stringify(got)}`))), 3000);
      });
    ws.onmessage = (m) => got.push(JSON.parse(String(m.data)));
    await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
    await wait(() => got.length >= 1);
    expect(got[0]).toMatchObject({ kind: "backlog", events: [{ attempt_id: "ws0" }] });
    await post([ev("status.changed", "ws0", 100, { status: "paid", data: { to: "paid" } })]);
    await wait(() => got.length >= 2);
    expect(got[1]).toMatchObject({ kind: "event", event: { type: "status.changed", attempt_id: "ws0" }, payment: { attempt_id: "ws0", status: "paid", amount_paisa: 500 } });
    ws.send("ping");
    await wait(() => got.length >= 3);
    expect(got[2]).toEqual({ kind: "pong" });
    // live events do not reach a test-env socket
    await post([ev("payment.started", "ws-live", 0)], { authorization: "Bearer pnp_live_abc" });
    await new Promise((r) => setTimeout(r, 100));
    expect(got).toHaveLength(3);
    ws.close();
  });

  it("refuses other projects", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/api/projects/other/live?env=test`);
    await expect(new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)))).rejects.toBeTruthy();
  });
});

describe("dashboard files", () => {
  it("serves the build with SPA fallback and immutable assets", async () => {
    const dir = tmp("dash");
    mkdirSync(join(dir, "assets"));
    writeFileSync(join(dir, "index.html"), "<!doctype html><div id=root></div>");
    writeFileSync(join(dir, "assets", "app-abc.js"), "console.log(1)");
    const s = await startDevServer({ port: 0, host: "127.0.0.1", store: await DevStore.open(), dashboardDir: dir });
    const b = `http://127.0.0.1:${s.port}`;
    try {
      for (const p of ["/", "/p/local/test/overview", "/p/local/test/payments/att_1"]) {
        const r = await fetch(b + p);
        expect(r.headers.get("content-type")).toContain("text/html");
        expect(await r.text()).toContain("id=root");
      }
      const js = await fetch(`${b}/assets/app-abc.js`);
      expect(js.headers.get("content-type")).toContain("javascript");
      expect(js.headers.get("cache-control")).toContain("immutable");
      expect((await fetch(`${b}/assets/missing.js`)).status).toBe(404);
      expect(await raw("/../../../../etc/passwd", "localhost")).not.toBe(500);
      expect((await fetch(`${b}/%2e%2e/%2e%2e/package.json`)).status).toBe(404);
    } finally {
      await s.close();
    }
  });

  it("without a build, a placeholder page and a working API", async () => {
    const r = await fetch(base + "/");
    expect(await r.text()).toContain("no dashboard bundled");
  });
});

describe("storage", () => {
  it.skipIf(!hasSqlite)("node:sqlite keeps events across restarts and rebuilds the same rows; fresh clears", async () => {
    const dir = join(tmp("store"), ".paynp", "dev");
    const a = await DevStore.open({ dir });
    expect(a.kind).toBe("sqlite");
    a.ingest("test", [ev("payment.started", "s1", 0, { amount_paisa: 900 }), ev("status.changed", "s1", 10, { status: "paid", data: { to: "paid" } })]);
    a.ingest("live", [ev("payment.started", "s2", 0)]);
    const before = { p: [...a.payments.entries()], m: [...a.minutes.entries()], e: [...a.events.entries()] };
    a.close();
    expect(existsSync(join(dir, "events.db"))).toBe(true);
    const b = await DevStore.open({ dir });
    expect({ p: [...b.payments.entries()], m: [...b.minutes.entries()], e: [...b.events.entries()] }).toEqual(before);
    b.close();
    const c = await DevStore.open({ dir, fresh: true });
    expect(c.payments.size).toBe(0);
    c.close();
  });

  it("memory only when asked (or when node:sqlite is missing)", async () => {
    const dir = join(tmp("mem"), ".paynp", "dev");
    const s = await DevStore.open({ dir, memory: true });
    expect(s.kind).toBe("memory");
    expect(existsSync(join(dir, "events.db"))).toBe(false);
  });
});

describe("paynp dev", () => {
  function io() {
    const out: string[] = [];
    const err: string[] = [];
    const i: Io = { out: (s) => void out.push(s), err: (s) => void err.push(s), interactive: false, color: false, ask: async () => "" };
    return { io: i, text: () => out.join("\n"), errText: () => err.join("\n") };
  }

  it("is in the help", () => {
    expect(HELP).toMatch(/^ {2}dev {16}Local dashboard and ingest on http:\/\/localhost:4040/m);
    expect(HELP).toContain("--fresh");
  });

  it("prints the banner with the URL and the env lines, writes to .paynp/dev, stops on abort", async () => {
    const cwd = tmp("cmd");
    const o = io();
    const ac = new AbortController();
    const done = run(["dev", "--port", "0", "--quiet"], { cwd, io: o.io, signal: ac.signal });
    for (let i = 0; i < 100 && !o.text().includes("Ctrl+C"); i++) await new Promise((r) => setTimeout(r, 20));
    const url = /Dashboard {2}(http:\/\/localhost:\d+)/.exec(o.text())?.[1];
    expect(url).toBeTruthy();
    expect(o.text()).toContain(`PAYNP_ENDPOINT=${url}`);
    expect(o.text()).toContain("PAYNP_KEY=pnp_test_local");
    const port = new URL(url!).port;
    const h = await fetch(`http://127.0.0.1:${port}/v1/health`);
    expect((await h.json()).mode).toBe("local");
    if (hasSqlite) expect(existsSync(join(cwd, ".paynp", "dev", "events.db"))).toBe(true);
    ac.abort();
    expect(await done).toBe(0);
    await expect(fetch(`http://127.0.0.1:${port}/v1/health`)).rejects.toThrow();
  });

  it("says so when the port is taken", async () => {
    const o = io();
    const code = await run(["dev", "--port", String(srv.port)], { cwd: tmp("busy"), io: o.io });
    expect(code).toBe(1);
    expect(o.errText()).toMatch(/port \d+ is in use/);
  });

  it("rejects a bad --port", async () => {
    const o = io();
    expect(await run(["dev", "--port", "eighty"], { cwd: tmp("bad"), io: o.io })).toBe(1);
    expect(o.errText()).toContain("--port must be a port number");
  });
});

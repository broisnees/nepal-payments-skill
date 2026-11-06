import { describe, expect, it } from "vitest";
import worker from "../src/index.ts";
import { checkoutPlan } from "../src/api.ts";
import { PROBES, runProbe, runProbes } from "../src/probe.ts";
import { buildReport } from "../../worker/src/status/aggregate.ts";

const MIN = 60_000;
const now = Date.now();
const nowMin = Math.floor(now / MIN);

/** status_minutes rows: esewa failing (down), khalti slow (degraded), fonepay healthy, the rest silent. */
function rows() {
  const out: Record<string, unknown>[] = [];
  const row = (gateway: string, m: number, requests: number, errors: number, slowMs: number) => ({
    gateway, minute: nowMin - m, requests, errors, samples: requests, ms_total: requests * slowMs, ms_max: slowMs,
    h0: 0, h1: 0, h2: slowMs < 1000 ? requests : 0, h3: 0, h4: 0, h5: 0, h6: 0, h7: 0, h8: slowMs >= 10_000 ? requests : 0,
  });
  for (let m = 0; m < 15; m++) {
    out.push(row("esewa", m, 10, 7, 400));
    out.push(row("khalti", m, 10, 0, 12_000));
    out.push(row("fonepay", m, 10, 0, 300));
  }
  return out;
}

/** Just enough D1 for loadReport: a batch of three SELECTs. */
const DB = {
  prepare: () => ({ bind: () => ({}) }),
  batch: async () => [{ results: rows() }, { results: [] }, { results: [] }],
} as unknown as D1Database;
const env = { DB, APP_URL: "https://status.discerns.app", PLATFORM_URL: "https://discerns.app" };
const get = (path: string, headers: Record<string, string> = {}) =>
  worker.fetch(new Request(`https://status.discerns.app${path}`, { headers }), env as unknown as Env, {} as ExecutionContext) as Promise<Response>;

describe("status API", () => {
  it("lists every gateway with a state, a checkout action and a buyer message", async () => {
    const res = await get("/v1/status");
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const body = (await res.json()) as any;
    const by = Object.fromEntries(body.gateways.map((g: any) => [g.gateway, g]));
    expect(by.esewa).toMatchObject({ state: "down", action: "disable" });
    expect(by.esewa.message).toMatch(/not working right now/);
    expect(by.khalti).toMatchObject({ state: "degraded", action: "warn" });
    expect(by.fonepay).toMatchObject({ state: "operational", action: "show", message: null });
    expect(by.imepay).toMatchObject({ state: "no_data", action: "show" });
    expect(body.overall).toMatchObject({ state: "down", down: 1, degraded: 1, operational: 1 });
  });

  it("orders a checkout healthy first and keeps unknown ids aside", async () => {
    const body = (await (await get("/v1/checkout?gateways=esewa,khalti,imepay,fonepay,paypal")).json()) as any;
    expect(body.order).toEqual(["fonepay", "imepay", "khalti", "esewa"]);
    expect(body.available).toEqual(["fonepay", "imepay", "khalti"]);
    expect(body.unknown).toEqual(["paypal"]);
    expect((await get("/v1/checkout")).status).toBe(400);
  });

  it("keeps the checkout's own order among equally healthy gateways", () => {
    const r = buildReport(now, [], [], []);
    expect(checkoutPlan(r, ["khalti", "esewa"], "https://x").order).toEqual(["khalti", "esewa"]);
  });

  it("answers one gateway in full and 404s unknown ones", async () => {
    const one = (await (await get("/v1/status/ESEWA")).json()) as any;
    expect(one).toMatchObject({ gateway: "esewa", action: "disable" });
    expect(one.detail.uptime_90d).toHaveLength(90);
    expect((await get("/v1/status/paypal")).status).toBe(404);
  });
});

describe("pages, badges and feed", () => {
  it("renders the overview with discerns branding and live hooks, and the gateway page with checkout advice", async () => {
    const home = await (await get("/")).text();
    expect(home).toContain("<title>Is eSewa down? Live status of Nepali payment gateways</title>");
    expect(home).toContain("discerns <span>status</span>");
    expect(home).toContain('data-pill="esewa"');
    expect(home).toContain("https://discerns.app/logos/");
    expect(home).not.toMatch(/paynp/i);
    expect(home).not.toMatch(/[–—…]/);
    const esewa = await (await get("/esewa")).text();
    expect(esewa).toContain("Switch its button off and point buyers to another method.");
    expect(esewa).toContain("Checked every minute with <code>GET epay.esewa.com.np/api/epay/transaction/status/</code>");
    expect(esewa).toContain('<link rel="canonical" href="https://status.discerns.app/esewa">');
    expect((await get("/paypal")).status).toBe(404);
  });

  it("renders the developers page and redirects old /status links", async () => {
    const dev = await (await get("/developers")).text();
    expect(dev).toContain("Status API");
    expect(dev).toContain("If-None-Match");
    expect(dev).not.toMatch(/widget|script src/i);
    expect(dev).not.toMatch(/[–—…]/);
    const old = await get("/status/khalti");
    expect(old.status).toBe(301);
    expect(old.headers.get("location")).toBe("/khalti");
  });

  it("serves badges, the Atom feed, the widget and robots", async () => {
    const svg = await (await get("/badge/esewa.svg")).text();
    expect(svg).toContain("eSewa: down");
    expect((await get("/feed.xml")).headers.get("content-type")).toContain("atom");
    expect((await get("/widget.js")).status).toBe(404);
    expect(await (await get("/robots.txt")).text()).toContain("sitemap.xml");
  });
});

describe("API conventions", () => {
  it("answers 304 to a matching If-None-Match", async () => {
    const first = await get("/v1/status");
    const tag = first.headers.get("etag")!;
    expect(tag).toMatch(/^W\/"[0-9a-f]+"$/);
    const again = await get("/v1/status", { "if-none-match": tag });
    expect(again.status).toBe(304);
    expect(await again.text()).toBe("");
  });

  it("uses one error shape for 400, 404 and 405", async () => {
    const bad = (await (await get("/v1/incidents?ongoing=maybe")).json()) as any;
    expect(bad).toEqual({ error: { code: "bad_ongoing", message: expect.any(String) } });
    expect(((await (await get("/v1/nope")).json()) as any).error.code).toBe("not_found");
    const post = await worker.fetch(new Request("https://status.discerns.app/v1/status", { method: "POST" }), env as unknown as Env, {} as ExecutionContext);
    expect(post.status).toBe(405);
  });

  it("publishes an OpenAPI 3.1 document listing every endpoint", async () => {
    const doc = (await (await get("/v1/openapi.json")).json()) as any;
    expect(doc.openapi).toBe("3.1.0");
    expect(Object.keys(doc.paths)).toEqual(["/v1/status", "/v1/status/{gateway}", "/v1/checkout", "/v1/incidents"]);
  });
});

describe("probes", () => {
  const answer = (status: number) => (async () => new Response("{}", { status })) as unknown as typeof fetch;

  it("passes on any answer below 500 and fails on 5xx, timeouts and network errors", async () => {
    const p = PROBES[0];
    expect(await runProbe(p, answer(401))).toMatchObject({ ok: true, http_status: 401, error: null });
    expect(await runProbe(p, answer(503))).toMatchObject({ ok: false, http_status: 503, error: "HTTP 503" });
    const timeout = (async () => {
      throw Object.assign(new Error("t"), { name: "TimeoutError" });
    }) as unknown as typeof fetch;
    expect(await runProbe(p, timeout)).toMatchObject({ ok: false, http_status: null, error: "no answer in 10 s" });
  });

  it("covers every gateway except IME Pay and writes one row per gateway", async () => {
    expect(PROBES.map((p) => p.gateway).sort()).toEqual(["connectips", "cybersource", "esewa", "fonepay", "getpay", "hamropay", "khalti", "nepalpay", "nps"]);
    let bound = "";
    const db = { prepare: () => ({ bind: (a: string) => ((bound = a), { run: async () => ({}) }) }) } as unknown as D1Database;
    const out = await runProbes({ DB: db } as Env, Date.now(), answer(400));
    expect(out).toHaveLength(PROBES.length);
    const rows = JSON.parse(bound) as unknown[][];
    expect(rows).toHaveLength(PROBES.length);
    expect(rows[0][2]).toBe(0); // errors: a 400 is a passing check
  });
});

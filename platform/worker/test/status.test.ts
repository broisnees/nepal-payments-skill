import { createScheduledController } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { newId, type PaymentEvent, type StatusReport } from "@paynp/shared";
import { describe, expect, it } from "vitest";
import { DAILY_CRON } from "../src/cron.ts";
import worker from "../src/index.ts";
import { DAY, MINUTE } from "../src/lib/util.ts";
import { buildReport, detectIncidents, isBad, loadReport, nptDay, rollupStatus, stateOf, type MinuteRow } from "../src/status/aggregate.ts";
import { BOUNDS, bucketOf, emptyHist, p95 } from "../src/status/buckets.ts";
import { aggregateStatus } from "../src/status/ingest.ts";
import { call, ingest, setup } from "./helpers.ts";

const gwReq = (gateway: string, ts: number, duration_ms: number, http_status = 200, attempt = "st-a"): PaymentEvent => ({
  id: newId("evt"),
  type: "gateway.request",
  ts: new Date(ts).toISOString(),
  attempt_id: attempt,
  gateway,
  duration_ms,
  data: { op: "status", http_status },
});

const minuteRow = (gateway: string, minute: number, requests: number, errors: number, ms: number): MinuteRow => {
  const hist = emptyHist();
  hist[bucketOf(ms)] = requests;
  return { gateway, minute, requests, errors, samples: requests, ms_total: ms * requests, ms_max: ms, hist };
};

const row = (gateway: string, minute: number) =>
  env.DB.prepare("SELECT * FROM status_minutes WHERE gateway = ? AND minute = ?").bind(gateway, minute).first<Record<string, number>>();

describe("latency histogram", () => {
  it("puts samples in buckets and reads p95 as the bucket bound", () => {
    expect(bucketOf(0)).toBe(0);
    expect(bucketOf(100)).toBe(0);
    expect(bucketOf(101)).toBe(1);
    expect(bucketOf(5000)).toBe(6);
    expect(bucketOf(5001)).toBe(7);
    expect(bucketOf(60_000)).toBe(8);
    const h = emptyHist();
    h[2] = 95; // <= 500 ms
    h[6] = 5; // <= 5 s
    expect(p95(h, 4800)).toBe(500);
    h[6] = 6;
    // The bucket bound is 5 s, but no sample was slower than 4.8 s.
    expect(p95(h, 4800)).toBe(4800);
    expect(p95(h, 0)).toBe(5000);
    expect(p95(emptyHist(), 0)).toBeNull();
    const slow = emptyHist();
    slow[8] = 10;
    expect(p95(slow, 25_000)).toBe(25_000);
    expect(BOUNDS.length).toBe(8);
  });

  it("aggregates a batch per gateway and minute, counting 5xx, status 0 and network errors", () => {
    const t = Date.UTC(2026, 0, 1, 0, 0, 10);
    const net: PaymentEvent = { ...gwReq("khalti", t, 30_000), data: { op: "status", reason: "timeout" } };
    const a = aggregateStatus([gwReq("khalti", t, 200), gwReq("khalti", t + 1000, 900, 502), net, gwReq("esewa", t + 60_000, 100), { ...gwReq("khalti", t, 0), type: "error" }]);
    expect(a).toHaveLength(2);
    expect(a[0]).toMatchObject({ gateway: "khalti", minute: t / MINUTE - 10 / 60, requests: 3, errors: 2, samples: 3, ms_total: 31_100, ms_max: 30_000 });
  });
});

describe("status_minutes on ingest", () => {
  it("counts distinct projects once per gateway-minute, live only, with one statement per batch", async () => {
    const live = await Promise.all([setup("live"), setup("live"), setup("live")]);
    const test = await setup("test");
    const t = Math.floor(Date.now() / MINUTE) * MINUTE - 3 * MINUTE + 5000;
    const minute = t / MINUTE - 5000 / MINUTE;
    const m = Math.floor(t / MINUTE);
    // Project 1: two batches in the same minute; the second must not count the project again.
    await ingest(live[0].key, [gwReq("imepay", t, 300), gwReq("imepay", t + 1000, 400)]);
    await ingest(live[0].key, [gwReq("imepay", t + 2000, 6000, 503)]);
    expect(await row("imepay", m)).toMatchObject({ projects: 1, requests: 3, errors: 1, samples: 3, ms_total: 6700, ms_max: 6000 });
    await ingest(live[1].key, [gwReq("imepay", t + 3000, 200)]);
    await ingest(test.key, [gwReq("imepay", t + 3000, 200)]);
    expect(await row("imepay", m)).toMatchObject({ projects: 2, requests: 4 });
    // A resent (duplicate) event changes nothing.
    const dup = gwReq("imepay", t + 4000, 250);
    await ingest(live[2].key, [dup]);
    await ingest(live[2].key, [dup]);
    const r = await row("imepay", m);
    expect(r).toMatchObject({ projects: 3, requests: 5, errors: 1 });
    // The merged histogram's p95: 5 samples, 95th is the 5th (6000 ms, the <= 10 s bucket).
    expect(r!.ms_p95).toBe(10_000);
    expect(minute).toBe(m);
  });

  it("shows a gateway only for minutes with >= 3 projects, and never volumes", async () => {
    const t = Date.now();
    const m = Math.floor(t / MINUTE) - 2;
    await env.DB.batch([
      env.DB.prepare("INSERT INTO status_minutes (gateway, minute, projects, requests, errors, ms_total, samples, ms_max, h2) VALUES ('nps', ?, 2, 50, 40, 25000, 50, 500, 50)").bind(m),
      env.DB.prepare("INSERT INTO status_minutes (gateway, minute, projects, requests, errors, ms_total, samples, ms_max, h2) VALUES ('connectips', ?, 3, 50, 1, 25000, 50, 500, 50)").bind(m),
    ]);
    const report = await loadReport(env, t);
    const nps = report.gateways.find((g) => g.gateway === "nps")!;
    const cips = report.gateways.find((g) => g.gateway === "connectips")!;
    expect(nps).toMatchObject({ state: "no_data", error_rate: null, p95_ms: null });
    expect(nps.last_24h.every((p) => p.error_rate === null)).toBe(true);
    expect(cips).toMatchObject({ state: "operational", error_rate: 0.02, p95_ms: 500 });
    const text = JSON.stringify(report);
    expect(text).not.toMatch(/"requests"|"projects"|"samples"/);
  });
});

describe("states and incidents", () => {
  const base = 29_000_000; // an epoch minute
  it("rates state: down at >= 50% errors, degraded at >= 10% or p95 > 5 s", () => {
    expect(stateOf([])).toBe("no_data");
    expect(stateOf([minuteRow("x", base, 10, 0, 300)])).toBe("operational");
    expect(stateOf([minuteRow("x", base, 10, 1, 300)])).toBe("degraded");
    expect(stateOf([minuteRow("x", base, 10, 0, 6000)])).toBe("degraded");
    expect(stateOf([minuteRow("x", base, 10, 5, 300)])).toBe("down");
    expect(isBad(minuteRow("x", base, 10, 2, 300))).toBe(false); // 20% is not over 20%
    expect(isBad(minuteRow("x", base, 10, 3, 300))).toBe(true);
  });

  it("opens an incident for >= 5 unhealthy minutes, tolerating 2-minute gaps, broken by a healthy minute", () => {
    const bad = (m: number) => minuteRow("khalti", base + m, 10, 5, 300);
    const slow = (m: number) => minuteRow("khalti", base + m, 10, 0, 8000);
    const good = (m: number) => minuteRow("khalti", base + m, 10, 0, 300);
    // 0..4 errors (5 min) with a gap at 2 -> one incident; 10..13 is only 4 minutes -> none;
    // 20..22 bad, 23 healthy, 24..26 bad -> none (healthy minute splits it); 30..36 slow -> latency incident, ongoing.
    const minutes = [bad(0), bad(1), bad(3), bad(4), bad(10), bad(11), bad(12), bad(13), bad(20), bad(21), bad(22), good(23), bad(24), bad(25), bad(26), slow(30), slow(31), slow(32), slow(33), slow(34), slow(35), slow(36)];
    const inc = detectIncidents(minutes, base + 37);
    expect(inc.map((i) => [i.started_at / MINUTE - base, i.minutes, i.kind, i.ongoing])).toEqual([
      [30, 7, "latency", true],
      [0, 5, "errors", false],
    ]);
    expect(inc[1].peak_error_rate).toBe(0.5);
    expect(inc[0].peak_p95_ms).toBe(8000);
  });

  it("builds 24 hourly points, 90 uptime days, peak hours by Nepal hour and merges stored incidents", () => {
    const t = Date.UTC(2026, 10, 5, 6, 0, 0); // 11:45 NPT
    const nowMin = t / MINUTE;
    const today = nptDay(t);
    const recent = [minuteRow("esewa", nowMin - 5, 10, 0, 400), minuteRow("esewa", nowMin - 65, 10, 1, 400)];
    const hours = Array.from({ length: 24 }, () => new Array(12).fill(0));
    hours[19] = [10, 30_000, 4000, 0, 0, 0, 0, 0, 10, 0, 0, 0]; // 19:00 NPT, all <= 3 s
    const days = [{ gateway: "esewa", day: today - 3, shown_minutes: 100, ok_minutes: 90, hours: JSON.stringify(hours) }];
    const stored = [{ gateway: "esewa", started_minute: nowMin - 3 * 1440, ended_minute: nowMin - 3 * 1440 + 6, kind: "errors", peak_error_rate: 0.6, peak_p95_ms: 500 }];
    const r: StatusReport = buildReport(t, recent, days, stored);
    const g = r.gateways.find((x) => x.gateway === "esewa")!;
    expect(r.gateways.map((x) => x.gateway)).toEqual(["esewa", "khalti", "fonepay", "connectips", "cybersource", "nps", "imepay", "nepalpay", "hamropay", "getpay"]);
    expect(g.last_24h).toHaveLength(24);
    expect(g.last_24h[23]).toMatchObject({ error_rate: 0, p95_ms: 400 });
    expect(g.last_24h[22]).toMatchObject({ error_rate: 0.1 });
    expect(g.uptime_90d).toHaveLength(90);
    expect(g.uptime_90d[89]).toEqual({ date: "2026-11-05", uptime: 1 });
    expect(g.uptime_90d[86]).toEqual({ date: "2026-11-02", uptime: 0.9 });
    expect(g.uptime_90d[0].uptime).toBeNull();
    expect(g.uptime_90d_pct).toBeCloseTo(92 / 102, 10);
    expect(g.peak_hours[19]).toEqual({ hour: 19, avg_ms: 3000, p95_ms: 3000 });
    expect(g.peak_hours[3]).toEqual({ hour: 3, avg_ms: null, p95_ms: null });
    expect(g.incidents).toEqual([{ started_at: (nowMin - 3 * 1440) * MINUTE, ended_at: (nowMin - 3 * 1440 + 6) * MINUTE, minutes: 6, kind: "errors", peak_error_rate: 0.6, peak_p95_ms: 500, ongoing: false }]);
  });

  it("daily cron rolls up complete days, stores incidents and keeps 90 days of minutes", async () => {
    const t = Date.now();
    const yesterdayNoon = (nptDay(t) - 1) * DAY - (5 * 60 + 45) * MINUTE + 12 * 3600_000;
    const m0 = yesterdayNoon / MINUTE;
    const stmts = [];
    for (let i = 0; i < 6; i++) {
      stmts.push(env.DB.prepare("INSERT INTO status_minutes (gateway, minute, projects, requests, errors, ms_total, samples, ms_max, h2) VALUES ('cybersource', ?, 4, 10, 6, 4000, 10, 400, 10)").bind(m0 + i));
    }
    stmts.push(env.DB.prepare("INSERT INTO status_minutes (gateway, minute, projects, requests, errors, ms_total, samples, ms_max, h2) VALUES ('cybersource', ?, 4, 10, 0, 4000, 10, 400, 10)").bind(m0 + 6));
    stmts.push(env.DB.prepare("INSERT INTO status_minutes (gateway, minute, projects, requests, errors, ms_total) VALUES ('cybersource', ?, 4, 1, 0, 1)").bind(Math.floor((t - 91 * DAY) / MINUTE)));
    await env.DB.batch(stmts);
    const out = await rollupStatus(env, t);
    expect(out.minutes_deleted).toBeGreaterThanOrEqual(1);
    const day = await env.DB.prepare("SELECT * FROM status_days WHERE gateway = 'cybersource' AND day = ?").bind(nptDay(t) - 1).first<Record<string, any>>();
    expect(day).toMatchObject({ shown_minutes: 7, ok_minutes: 1 });
    expect(JSON.parse(day!.hours)[12][0]).toBe(70);
    const inc = await env.DB.prepare("SELECT * FROM status_incidents WHERE gateway = 'cybersource'").all<Record<string, any>>();
    expect(inc.results).toEqual([{ gateway: "cybersource", started_minute: m0, ended_minute: m0 + 6, kind: "errors", peak_error_rate: 0.6, peak_p95_ms: 400 }]);
    // The scheduled handler runs it as part of the daily cron.
    await worker.scheduled(createScheduledController({ cron: DAILY_CRON, scheduledTime: t }), env, {} as ExecutionContext);
  });
});

describe("status pages", () => {
  it("/status and /status/:gateway redirect to the status site", async () => {
    const all = await call("GET", "/status");
    expect(all.status).toBe(301);
    expect(all.headers.get("location")).toBe("https://status.discerns.app/");
    const one = await call("GET", "/status/Khalti");
    expect(one.status).toBe(301);
    expect(one.headers.get("location")).toBe("https://status.discerns.app/khalti");
  });

  it("serves /status.json with CORS and the report shape", async () => {
    const res = await call("GET", "/status.json");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const body = await res.json<StatusReport>();
    expect(body.min_projects).toBe(3);
    expect(body.gateways).toHaveLength(10);
    expect(body.gateways[0]).toHaveProperty("uptime_90d");
  });
});

describe("gateway probes", () => {
  it("stores one row per gateway per minute and the probe report turns failures into states", async () => {
    const { runProbes } = await import("../../status/src/probe.ts");
    const { PROBES } = await import("../src/status/aggregate.ts");
    const t0 = Date.now() - 20 * 60_000;
    // eSewa answers 503 for 15 minutes, everyone else answers 401 quickly.
    const fetcher = (async (url: string) => new Response("{}", { status: String(url).includes("esewa") ? 503 : 401 })) as unknown as typeof fetch;
    for (let m = 0; m < 16; m++) await runProbes(env, t0 + m * 60_000 + 5 * 60_000, fetcher);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM probe_minutes").first<{ n: number }>();
    expect(n!.n).toBe(16 * 9);
    const r = await loadReport(env, Date.now(), PROBES);
    const by = Object.fromEntries(r.gateways.map((g) => [g.gateway, g.state]));
    expect(by.esewa).toBe("down");
    expect(by.khalti).toBe("operational");
    expect(by.imepay).toBe("no_data");
  });
});

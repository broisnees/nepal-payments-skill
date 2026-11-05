import { env } from "cloudflare:workers";
import type { PaymentEvent } from "@paynp/shared";
import { newId } from "@paynp/shared";
import { describe, expect, it } from "vitest";
import { runAlertCron } from "../src/alerts/engine.ts";
import { ingestEvents } from "../src/ingest.ts";
import { runDoctorCron } from "../src/ops/cron-ops.ts";
import { call, ingest, json, setup, type Setup } from "./helpers.ts";

const MIN = 60_000;
/** An event at an absolute time. */
const at = (type: PaymentEvent["type"], attempt: string, ts: number, extra: Partial<PaymentEvent> = {}): PaymentEvent => ({
  id: newId("evt"), type, ts: new Date(ts).toISOString(), attempt_id: attempt, gateway: "esewa", ...extra,
});
const paidAt = (id: string, ts: number, extra: Partial<PaymentEvent> = {}) => [
  at("payment.started", id, ts - 30_000, { status: "initiated", amount_paisa: 120000, ...extra }),
  at("status.changed", id, ts, { data: { to: "paid" } }),
];
const incidentsFor = async (s: Setup) => (await json(call("GET", `/api/projects/${s.projectId}/incidents`, { cookie: s.cookie }))).items as any[];
const doctor = (s: Setup, envName = "live") => json(call("GET", `/api/projects/${s.projectId}/doctor?env=${envName}`, { cookie: s.cookie }));
const finding = async (s: Setup, code: string, envName = "live") => (await doctor(s, envName)).findings.find((f: any) => f.code === code);

describe("paid_not_fulfilled (4.3)", () => {
  it("fires per payment once N minutes pass, only for projects that report fulfilment; resolves on payment.fulfilled", async () => {
    const s = await setup();
    const r = await call("POST", `/api/projects/${s.projectId}/rules`, { cookie: s.cookie, body: { env: "test", type: "paid_not_fulfilled", params: { after_min: 15 } } });
    expect(r.status).toBe(201);
    const T = Date.now();
    await ingestEvents(env, s.projectId, "test", [...paidAt("pn1", T - 20 * MIN), ...paidAt("pn2", T - 5 * MIN), ...paidAt("pn3", T - 2 * 86_400_000)]);

    // The project has never sent payment.fulfilled: the rule stays quiet.
    await runAlertCron(env, T);
    expect(await incidentsFor(s)).toEqual([]);

    // Once it fulfils something, unfulfilled paid payments older than 15 min (and younger than 24 h) fire.
    await ingestEvents(env, s.projectId, "test", [...paidAt("pn0", T - 60 * MIN), at("payment.fulfilled", "pn0", T - 59 * MIN)]);
    await runAlertCron(env, T);
    let incs = await incidentsFor(s);
    expect(incs.map((i) => [i.attempt_id, i.rule_type, i.state])).toEqual([["pn1", "paid_not_fulfilled", "firing"]]);
    expect(incs[0].summary).toMatch(/^pn1 on esewa \(Rs 1,200\.00\) was paid 20 min ago and is not fulfilled$/);
    // Not opened twice.
    await runAlertCron(env, T + MIN);
    expect(await incidentsFor(s)).toHaveLength(1);
    // pn2 crosses 15 min later.
    await runAlertCron(env, T + 11 * MIN);
    expect((await incidentsFor(s)).map((i) => i.attempt_id).sort()).toEqual(["pn1", "pn2"]);

    await ingest(s.key, [at("payment.fulfilled", "pn1", T)]);
    incs = await incidentsFor(s);
    expect(incs.find((i) => i.attempt_id === "pn1").state).toBe("resolved");
    expect(incs.find((i) => i.attempt_id === "pn2").state).toBe("firing");
  });
});

describe("doctor findings (4.4)", () => {
  it("sandbox_gateway_in_live, http_return_url and amount_looks_like_rupees (khalti) from live events", async () => {
    const s = await setup("live");
    await ingest(s.key, [
      at("payment.started", "dl1", Date.now(), { gateway: "khalti", amount_paisa: 150, status: "initiated", data: { gw_env: "sandbox", return_https: false } }),
      at("gateway.request", "dl1", Date.now() + 10, { gateway: "khalti", data: { op: "initiate", gw_env: "sandbox" } }),
    ]);
    const sandbox = await finding(s, "sandbox_gateway_in_live");
    expect(sandbox).toMatchObject({ severity: "critical", gateway: "khalti", count: 2, example_attempt: "dl1" });
    expect(sandbox.title).toBe("Live payments are going to a sandbox gateway");
    expect(sandbox.fix).toContain("production");
    expect(sandbox.docs_url).toMatch(/references\/env\.md$/);
    expect(await finding(s, "http_return_url")).toMatchObject({ severity: "critical", count: 1 });
    expect(await finding(s, "amount_looks_like_rupees")).toMatchObject({ severity: "warning", gateway: "khalti" });

    // The same traffic in test is fine.
    const t = await setup("test");
    await ingest(t.key, [at("payment.started", "dl1", Date.now(), { gateway: "khalti", amount_paisa: 150, data: { gw_env: "sandbox", return_https: false } })]);
    const rep = await doctor(t, "test");
    expect(rep.findings).toEqual([]);
    expect(rep.passed.find((p: any) => p.code === "sandbox_gateway_in_live")).toMatchObject({ status: "not_checked", line: "Checked on live traffic only." });
    expect(rep.passed.find((p: any) => p.code === "double_fulfilment")).toMatchObject({ status: "passed", line: "Every payment is fulfilled at most once." });
  });

  it("amount_looks_like_rupees: 3 of the last 10 under 100 paisa while the 30-day median is over Rs 100", async () => {
    const s = await setup("live");
    const T = Date.now() - 10 * MIN;
    const big = Array.from({ length: 12 }, (_, i) => at("payment.started", `big${i}`, T - (i + 1) * 3600_000, { amount_paisa: 250000, gateway: "fonepay" }));
    await ingestEvents(env, s.projectId, "live", big);
    await ingest(s.key, [at("payment.started", "sm1", T, { amount_paisa: 25, gateway: "fonepay" }), at("payment.started", "sm2", T + 1, { amount_paisa: 25, gateway: "fonepay" })]);
    expect(await finding(s, "amount_looks_like_rupees")).toBeUndefined();
    await ingest(s.key, [at("payment.started", "sm3", T + 2, { amount_paisa: 25, gateway: "fonepay" })]);
    expect(await finding(s, "amount_looks_like_rupees")).toMatchObject({ gateway: "fonepay", example_attempt: "sm3" });
  });

  it("signature_failures: three failed checks within 10 minutes", async () => {
    const s = await setup();
    const sig = (id: string, dt: number) => at("signature.checked", id, Date.now() + dt, { data: { valid: false, reason: "bad_signature" } });
    await ingest(s.key, [sig("sg1", 0), sig("sg2", 1)]);
    expect(await finding(s, "signature_failures", "test")).toBeUndefined();
    await ingest(s.key, [sig("sg3", 2)]);
    expect(await finding(s, "signature_failures", "test")).toMatchObject({ severity: "critical", gateway: "esewa", example_attempt: "sg3" });
  });

  it("fulfil_without_paid and double_fulfilment", async () => {
    const s = await setup();
    const T = Date.now();
    await ingest(s.key, [at("payment.started", "fw1", T, { status: "pending" }), at("payment.fulfilled", "fw1", T + 1)]);
    expect(await finding(s, "fulfil_without_paid", "test")).toMatchObject({ example_attempt: "fw1", count: 1 });
    await ingest(s.key, [...paidAt("df1", T), at("payment.fulfilled", "df1", T + 10), at("payment.fulfilled", "df1", T + 20)]);
    expect(await finding(s, "double_fulfilment", "test")).toMatchObject({ example_attempt: "df1", count: 1 });
    expect(await finding(s, "fulfil_without_paid", "test")).toMatchObject({ count: 1 });
  });

  it("no_status_check_after_return: the cron flags callbacks with no status call within 60 s", async () => {
    const s = await setup();
    const T = Math.floor(Date.now() / MIN) * MIN + 5 * MIN; // cron time, minute aligned
    const cb = T - 2 * MIN + 1000; // inside the minute the cron judges
    await ingestEvents(env, s.projectId, "test", [
      at("callback.received", "ns1", cb, { data: { source: "return" } }),
      at("callback.received", "ns2", cb, { data: { source: "return" } }),
      at("gateway.request", "ns2", cb + 500, { data: { op: "status", http_status: 200 } }),
      at("callback.received", "ns3", cb, { gateway: "khalti", data: { source: "return" } }),
      at("gateway.request", "ns3", cb + 70_000, { gateway: "khalti", data: { op: "lookup" } }), // too late
    ], T - MIN);
    await runDoctorCron(env, T);
    const rep = await doctor(s, "test");
    const f = rep.findings.filter((x: any) => x.code === "no_status_check_after_return");
    expect(f.map((x: any) => [x.gateway, x.count, x.example_attempt]).sort()).toEqual([["esewa", 1, "ns1"], ["khalti", 1, "ns3"]]);
    // The next minute judges the next window; the same callbacks are not counted again.
    await runDoctorCron(env, T + MIN);
    expect((await finding(s, "no_status_check_after_return", "test")).count).toBe(1);
  });

  it("no_reconcile: live payments open over an hour and no reconcile.checked in 24 h", async () => {
    const s = await setup("live");
    const T = Math.floor(Date.now() / (15 * MIN)) * 15 * MIN + 15 * MIN; // a quarter hour
    await ingestEvents(env, s.projectId, "live", [at("payment.started", "nr1", T - 2 * 3600_000, { status: "initiated" }), at("payment.started", "nr2", T - 3 * 3600_000, { status: "pending" })], T);
    await runDoctorCron(env, T);
    expect(await finding(s, "no_reconcile")).toMatchObject({ severity: "warning", gateway: null, count: 2 });

    // With a reconcile job running, a different project stays clean.
    const ok = await setup("live");
    await ingestEvents(env, ok.projectId, "live", [at("payment.started", "nr3", T - 2 * 3600_000, { status: "initiated" }), at("reconcile.checked", "nr3", T - 3600_000, { status: "pending" })], T);
    await runDoctorCron(env, T);
    expect(await finding(ok, "no_reconcile")).toBeUndefined();
  });

  it("GET /doctor sorts critical first and counts; POST /doctor/:code/resolve hides it until it happens again", async () => {
    const s = await setup("live");
    await ingest(s.key, [at("payment.started", "rs1", Date.now(), { gateway: "khalti", amount_paisa: 200, data: { gw_env: "sandbox" } })]);
    let rep = await doctor(s);
    expect(rep).toMatchObject({ env: "live", critical: 1, warnings: 1 });
    expect(rep.findings.map((f: any) => f.code)).toEqual(["sandbox_gateway_in_live", "amount_looks_like_rupees"]);
    expect(rep.passed.map((p: any) => p.code)).not.toContain("sandbox_gateway_in_live");
    expect(rep.passed.every((p: any) => p.status === "passed")).toBe(true);

    const r = await call("POST", `/api/projects/${s.projectId}/doctor/sandbox_gateway_in_live/resolve`, { cookie: s.cookie, body: { env: "live" } });
    expect(await json(r)).toEqual({ resolved: 1 });
    rep = await doctor(s);
    expect(rep.findings.map((f: any) => f.code)).toEqual(["amount_looks_like_rupees"]);
    expect((await call("POST", `/api/projects/${s.projectId}/doctor/sandbox_gateway_in_live/resolve`, { cookie: s.cookie, body: { env: "live" } })).status).toBe(404);
    expect((await call("POST", `/api/projects/${s.projectId}/doctor/made_up/resolve`, { cookie: s.cookie, body: { env: "live" } })).status).toBe(404);

    await ingest(s.key, [at("payment.started", "rs2", Date.now(), { gateway: "khalti", amount_paisa: 5000, data: { gw_env: "sandbox" } })]);
    expect((await finding(s, "sandbox_gateway_in_live")).resolved_at).toBeNull();
  });
});

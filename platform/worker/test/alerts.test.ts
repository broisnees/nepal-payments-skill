import { createHmac } from "node:crypto";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { onIngest, runAlertCron } from "../src/alerts/engine.ts";
import { signWebhook } from "../src/alerts/notify.ts";
import { devOutbox } from "../src/email.ts";
import { ingestEvents } from "../src/ingest.ts";
import { call, ev, ingest, json, setup, type Setup } from "./helpers.ts";

interface Delivery {
  url: string;
  headers: Headers;
  raw: string;
  body: any;
}

let deliveries: Delivery[] = [];
let failNext = 0;

beforeEach(() => {
  deliveries = [];
  failNext = 0;
  const real = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const req = new Request(input as RequestInfo, init);
    if (!req.url.startsWith("https://hooks.test/")) return real(input as RequestInfo, init);
    const raw = await req.text();
    deliveries.push({ url: req.url, headers: req.headers, raw, body: JSON.parse(raw) });
    if (failNext > 0) {
      failNext--;
      return new Response("nope", { status: 500 });
    }
    return new Response("ok");
  });
});
afterEach(() => vi.restoreAllMocks());

const hook = (name: string) => `https://hooks.test/${name}/${crypto.randomUUID()}`;
const to = (url: string) => deliveries.filter((d) => d.url === url);

async function channel(s: Setup, type: string, config: Record<string, unknown>) {
  return json(call("POST", `/api/projects/${s.projectId}/channels`, { cookie: s.cookie, body: { type, name: type, config } }));
}
async function rule(s: Setup, body: Record<string, unknown>) {
  const r = await call("POST", `/api/projects/${s.projectId}/rules`, { cookie: s.cookie, body: { env: "test", ...body } });
  expect(r.status).toBe(201);
  return json(r);
}
async function incidents(s: Setup) {
  return (await json(call("GET", `/api/projects/${s.projectId}/incidents`, { cookie: s.cookie }))).items;
}
const failed = (id: string, at: number) => [ev("payment.started", id, at, { status: "initiated", amount_paisa: 5000 }), ev("status.changed", id, at + 10, { data: { to: "failed", reason: "timeout" } })];
const paid = (id: string, at: number) => [ev("payment.started", id, at, { status: "initiated", amount_paisa: 5000 }), ev("status.changed", id, at + 10, { data: { to: "paid" } })];

describe("webhook signatures", () => {
  it("X-Paynp-Signature is sha256=<hex HMAC of the raw body> and a timestamp is sent", async () => {
    const s = await setup();
    const url = hook("sig");
    const ch = await channel(s, "webhook", { url, secret: "test-secret-0123456789" });
    const r = await call("POST", `/api/projects/${s.projectId}/channels/${ch.id}/test`, { cookie: s.cookie });
    expect(await r.json()).toEqual({ ok: true });
    const [d] = to(url);
    const expected = "sha256=" + createHmac("sha256", "test-secret-0123456789").update(d.raw).digest("hex");
    expect(d.headers.get("x-paynp-signature")).toBe(expected);
    expect(await signWebhook("test-secret-0123456789", d.raw)).toBe(expected);
    expect(Number(d.headers.get("x-paynp-timestamp"))).toBeGreaterThan(1_700_000_000);
    expect(d.body.type).toBe("test");
  });

  it("Slack and Discord get their own formats; a failure retries once and is recorded", async () => {
    const s = await setup();
    const slackUrl = hook("slack");
    const discordUrl = hook("discord");
    const slack = await channel(s, "slack", { webhook_url: slackUrl });
    const discord = await channel(s, "discord", { webhook_url: discordUrl });
    await call("POST", `/api/projects/${s.projectId}/channels/${slack.id}/test`, { cookie: s.cookie });
    expect(to(slackUrl)[0].body.text).toMatch(/^\*Test alert from paynp\*/);
    failNext = 1;
    const r = await call("POST", `/api/projects/${s.projectId}/channels/${discord.id}/test`, { cookie: s.cookie });
    expect(r.status).toBe(200);
    expect(to(discordUrl)).toHaveLength(2);
    expect(to(discordUrl)[1].body.content).toMatch(/^\*\*Test alert/);
    failNext = 2;
    const bad = await call("POST", `/api/projects/${s.projectId}/channels/${discord.id}/test`, { cookie: s.cookie });
    expect(bad.status).toBe(502);
    expect(await bad.json()).toEqual({ ok: false, error: "HTTP 500" });
    const rows = await env.DB.prepare("SELECT ok, error FROM notifications WHERE channel_id = ? ORDER BY sent_at").bind(discord.id).all();
    expect(rows.results).toEqual([{ ok: 1, error: null }, { ok: 0, error: "HTTP 500" }]);
  });
});

describe("aggregate rule lifecycle (failure_rate)", () => {
  it("opens, respects cooldown, renotifies on a changed summary, resolves after 2 clear evaluations", async () => {
    const s = await setup();
    const url = hook("rate");
    const ch = await channel(s, "webhook", { url, secret: "rate-secret-0123456789" });
    await rule(s, { type: "failure_rate", params: { threshold_pct: 50, window_min: 60, min_payments: 2 }, channel_ids: [ch.id], cooldown_min: 10 });
    await ingest(s.key, [...failed("fr1", 0), ...failed("fr2", 100), ...failed("fr3", 200), ...paid("fr4", 300)]);
    const T = Date.now();

    await runAlertCron(env, T);
    let incs = await incidents(s);
    expect(incs).toHaveLength(1);
    expect(incs[0]).toMatchObject({ state: "firing", rule_type: "failure_rate" });
    expect(incs[0].summary).toMatch(/75% of payments failed \(3 of 4\)/);
    expect(to(url).map((d) => d.body.type)).toEqual(["incident.firing"]);
    expect(to(url)[0].body.incident.id).toBe(incs[0].id);

    // Summary changes but the cooldown has not passed: no message.
    await ingest(s.key, failed("fr5", 400));
    await runAlertCron(env, T + 60_000);
    expect(to(url)).toHaveLength(1);
    // Cooldown passed and the summary changed: notify again.
    await runAlertCron(env, T + 11 * 60_000);
    expect(to(url)).toHaveLength(2);
    expect(to(url)[1].body.incident.summary).toMatch(/80% .*\(4 of 5\)/);
    // Cooldown passed again but nothing changed: quiet.
    await runAlertCron(env, T + 25 * 60_000);
    expect(to(url)).toHaveLength(2);

    // Window empties: first clear evaluation keeps it firing, the second resolves it.
    await runAlertCron(env, T + 2 * 3600_000);
    expect((await incidents(s))[0].state).toBe("firing");
    expect(to(url)).toHaveLength(2);
    await runAlertCron(env, T + 2 * 3600_000 + 60_000);
    incs = await incidents(s);
    expect(incs[0].state).toBe("resolved");
    expect(incs[0].resolved_at).toBe(T + 2 * 3600_000 + 60_000);
    expect(to(url).map((d) => d.body.type)).toEqual(["incident.firing", "incident.firing", "incident.resolved"]);
    // A clear evaluation in between resets the count.
  });

  it("a trigger between two clear evaluations resets the clear count", async () => {
    const s = await setup();
    const url = hook("reset");
    const ch = await channel(s, "webhook", { url });
    const r = await rule(s, { type: "stuck_pending", params: { older_than_min: 1 }, channel_ids: [ch.id] });
    await ingest(s.key, [ev("payment.started", "sp1", 0, { status: "pending" })]);
    const T = Date.now();
    await runAlertCron(env, T);
    expect((await incidents(s))[0].summary).toBe("1 payment open longer than 1 min");
    await ingest(s.key, [ev("status.changed", "sp1", 1000, { data: { to: "paid" } })]);
    await runAlertCron(env, T + 60_000); // clear 1
    await ingest(s.key, [ev("payment.started", "sp2", 0, { status: "pending" })]);
    await runAlertCron(env, T + 120_000); // triggered again: reset
    await ingest(s.key, [ev("status.changed", "sp2", 1000, { data: { to: "failed" } })]);
    await runAlertCron(env, T + 180_000); // clear 1
    expect((await incidents(s))[0].state).toBe("firing");
    await runAlertCron(env, T + 240_000); // clear 2
    expect((await incidents(s))[0].state).toBe("resolved");
    expect(r.type).toBe("stuck_pending");
  });
});

describe("per-payment rules", () => {
  it("payment_failed opens one incident per payment and batches: one message per channel per minute", async () => {
    const s = await setup();
    const url = hook("batch");
    const mail = `ops-${crypto.randomUUID()}@example.com`;
    const ch = await channel(s, "webhook", { url });
    const em = await channel(s, "email", { to: [mail] });
    await rule(s, { type: "payment_failed", params: { gateways: ["esewa"], min_amount_paisa: 1000 }, channel_ids: [ch.id, em.id] });
    const minute = Math.floor(Date.now() / 60_000) * 60_000 + 60_000;
    let t = minute + 1000;
    for (const id of ["pf1", "pf2", "pf3"]) {
      const res = await ingestEvents(env, s.projectId, "test", failed(id, 0));
      await onIngest(env, s.projectId, "test", res.transitions, t++);
    }
    // Filtered out: other gateway, small amount.
    const other = await ingestEvents(env, s.projectId, "test", [ev("status.changed", "pf4", 0, { gateway: "khalti", data: { to: "failed" } }), ev("status.changed", "pf5", 0, { amount_paisa: 10, data: { to: "failed" } })]);
    await onIngest(env, s.projectId, "test", other.transitions, t++);

    expect(to(url)).toHaveLength(1);
    expect(to(url)[0].body.incidents.map((i: { attempt_id: string }) => i.attempt_id)).toEqual(["pf1"]);
    expect(devOutbox.filter((m) => m.to.includes(mail))).toHaveLength(1);

    await runAlertCron(env, minute + 60_000);
    expect(to(url)).toHaveLength(2);
    expect(to(url)[1].body.type).toBe("incident.batch");
    expect(to(url)[1].body.incidents.map((i: { attempt_id: string }) => i.attempt_id)).toEqual(["pf2", "pf3"]);
    const mails = devOutbox.filter((m) => m.to.includes(mail));
    expect(mails).toHaveLength(2);
    expect(mails[1].text).toMatch(/pf2.*\n.*pf3/);

    const incs = await incidents(s);
    expect(incs.map((i: { attempt_id: string }) => i.attempt_id).sort()).toEqual(["pf1", "pf2", "pf3"]);
    const pending = await env.DB.prepare("SELECT COUNT(*) AS n FROM alert_incidents WHERE project_id = ? AND pending = 1").bind(s.projectId).first<{ n: number }>();
    expect(pending!.n).toBe(0);

    // Replaying the failure does not open a second incident for the same payment.
    await ingest(s.key, [ev("status.changed", "pf1", 99, { data: { to: "failed" } })]);
    expect(await incidents(s)).toHaveLength(3);
    // The payment later succeeds: its incident closes quietly.
    await ingest(s.key, [ev("status.changed", "pf1", 50_000, { data: { to: "paid" } })]);
    expect((await incidents(s)).find((i: { attempt_id: string }) => i.attempt_id === "pf1").state).toBe("resolved");
  });

  it("concurrent flushes (one per ingest request) never send the same payment twice or two batches in a minute", async () => {
    const s = await setup();
    const url = hook("race");
    const ch = await channel(s, "webhook", { url });
    await rule(s, { type: "payment_failed", channel_ids: [ch.id] });
    const t = Math.floor(Date.now() / 60_000) * 60_000 + 120_000;
    const a = await ingestEvents(env, s.projectId, "test", failed("rc1", 0));
    const b = await ingestEvents(env, s.projectId, "test", failed("rc2", 0));
    await Promise.all([onIngest(env, s.projectId, "test", a.transitions, t), onIngest(env, s.projectId, "test", b.transitions, t), runAlertCron(env, t)]);
    expect(to(url)).toHaveLength(1);
    await Promise.all([runAlertCron(env, t + 60_000), runAlertCron(env, t + 60_000)]);
    const sent = to(url).flatMap((d) => d.body.incidents.map((i: { attempt_id: string }) => i.attempt_id)).sort();
    expect(sent).toEqual(["rc1", "rc2"]);
  });

  it("amount_mismatch and double_fulfilment fire on ingest, once per payment", async () => {
    const s = await setup();
    const url = hook("pp");
    const ch = await channel(s, "webhook", { url });
    await rule(s, { type: "amount_mismatch", channel_ids: [ch.id] });
    await rule(s, { type: "double_fulfilment", channel_ids: [ch.id] });
    await ingest(s.key, [ev("error", "am1", 0, { data: { reason: "amount_mismatch" } }), ev("payment.fulfilled", "df1", 0), ev("payment.fulfilled", "df1", 10)]);
    await ingest(s.key, [ev("payment.fulfilled", "df1", 20)]);
    const incs = await incidents(s);
    expect(incs.map((i: { rule_type: string; attempt_id: string }) => `${i.rule_type}:${i.attempt_id}`).sort()).toEqual(["amount_mismatch:am1", "double_fulfilment:df1"]);
    expect(incs.find((i: { rule_type: string }) => i.rule_type === "double_fulfilment").summary).toMatch(/fulfilled 2 times/);
    expect(to(url).length).toBeGreaterThanOrEqual(1);
  });
});

describe("other rules", () => {
  it("signature_failure opens on ingest without waiting for the cron", async () => {
    const s = await setup();
    const url = hook("sig-rule");
    const ch = await channel(s, "webhook", { url });
    await rule(s, { type: "signature_failure", params: { threshold: 2, window_min: 10 }, channel_ids: [ch.id] });
    const recent = (id: string) => ({ ...ev("signature.checked", id, 0, { data: { valid: false } }), ts: new Date().toISOString() });
    await ingest(s.key, [recent("sg1")]);
    expect(await incidents(s)).toHaveLength(0);
    await ingest(s.key, [recent("sg2")]);
    const incs = await incidents(s);
    expect(incs).toHaveLength(1);
    expect(incs[0].summary).toBe("2 signature checks failed in the last 10 min");
    expect(to(url)).toHaveLength(1);
  });

  it("gateway_errors and gateway_slow pick the worst gateway; no_traffic only in live after earlier traffic", async () => {
    const s = await setup();
    const url = hook("gw");
    const ch = await channel(s, "webhook", { url });
    await rule(s, { type: "gateway_errors", params: { error_rate_pct: 50, window_min: 10, min_requests: 2 }, channel_ids: [ch.id] });
    await rule(s, { type: "gateway_slow", params: { avg_ms: 3000, window_min: 10 }, channel_ids: [ch.id] });
    await rule(s, { type: "no_traffic", params: { window_min: 1 }, channel_ids: [ch.id] });
    const now = Date.now();
    const req = (gw: string, status: number, ms: number) => ({ ...ev("gateway.request", `g-${gw}`, 0, { gateway: gw, duration_ms: ms, data: { http_status: status } }), ts: new Date(now - 30_000).toISOString() });
    await ingest(s.key, [req("khalti", 500, 100), req("khalti", 502, 100), req("esewa", 200, 6000), req("esewa", 200, 4000), ev("payment.started", "nt", 0)]);
    await runAlertCron(env, now);
    const summaries = (await incidents(s)).map((i: { summary: string }) => i.summary).sort();
    expect(summaries).toEqual(["esewa: gateway calls averaged 5000 ms over 2 requests in the last 10 min", "khalti: 100% of gateway calls failed (2 of 2) in the last 10 min"]);
    // no_traffic is a live-only rule: the test env rule never fires even with traffic a while ago.
    await runAlertCron(env, now + 3600_000);
    expect((await incidents(s)).some((i: { rule_type: string }) => i.rule_type === "no_traffic")).toBe(false);

    const live = await setup("live");
    const lch = await channel(live, "webhook", { url: hook("live") });
    await rule(live, { env: "live", type: "no_traffic", params: { window_min: 1 }, channel_ids: [lch.id] });
    await runAlertCron(env, Date.now());
    expect(await incidents(live)).toHaveLength(0); // never had traffic
    await ingest(live.key, [{ ...ev("payment.started", "lv1", 0), ts: new Date(Date.now() - 10 * 60_000).toISOString() }]);
    await runAlertCron(env, Date.now());
    expect((await incidents(live))[0].summary).toBe("No payments started in the last 1 min");
  });
});

describe("sendMail through Resend", () => {
  it("posts the message to Resend when RESEND_API_KEY is set and throws on an error answer", async () => {
    const { sendMail } = await import("../src/email.ts");
    const calls: { url: string; init: RequestInit }[] = [];
    const realFetch = globalThis.fetch;
    let status = 200;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(status === 200 ? '{"id":"x"}' : '{"message":"invalid from"}', { status });
    }) as typeof fetch;
    const testEnv = { EMAIL_FROM: "paynp <noreply@paynp.discerns.app>", RESEND_API_KEY: "re_test" } as unknown as Env;
    try {
      await sendMail(testEnv, { to: ["a@example.com", "a@example.com"], subject: "Hi", text: "t", html: "<p>t</p>" });
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe("https://api.resend.com/emails");
      expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer re_test");
      expect(JSON.parse(calls[0].init.body as string)).toEqual({ from: "paynp <noreply@paynp.discerns.app>", to: ["a@example.com"], subject: "Hi", text: "t", html: "<p>t</p>" });
      status = 422;
      await expect(sendMail(testEnv, { to: ["b@example.com"], subject: "Hi", text: "t", html: "" })).rejects.toThrow(/Resend answered 422/);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

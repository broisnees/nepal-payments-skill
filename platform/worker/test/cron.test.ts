import { createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { NPT_OFFSET } from "../src/api/data.ts";
import { cleanup, DAILY_CRON, sendDigests } from "../src/cron.ts";
import { devOutbox } from "../src/email.ts";
import worker from "../src/index.ts";
import { DAY } from "../src/lib/util.ts";
import { call, ev, ingest, setup, tokenFromMail, uniqueEmail } from "./helpers.ts";

const todayStartNpt = () => Math.floor((Date.now() + NPT_OFFSET) / DAY) * DAY - NPT_OFFSET;

describe("daily digest", () => {
  it("mails yesterday's volume, success rate, revenue, top reasons and open incidents to owners and admins", async () => {
    const s = await setup("live");
    const viewer = uniqueEmail("dv");
    await call("POST", `/api/orgs/${s.orgId}/invites`, { cookie: s.cookie, body: { email: viewer, role: "viewer" } });
    await call("GET", `/auth/invite?token=${tokenFromMail(viewer, "/auth/invite")}`);
    const y = todayStartNpt() - 3 * 3600_000; // 21:00 NPT yesterday
    const at = (id: string, type: Parameters<typeof ev>[0], dt: number, extra = {}) => ({ ...ev(type, id, 0, extra), ts: new Date(y + dt).toISOString() });
    await ingest(s.key, [
      at("dg1", "payment.started", 0, { status: "initiated", amount_paisa: 125000 }),
      at("dg1", "status.changed", 1000, { data: { to: "paid" } }),
      at("dg2", "payment.started", 0, { status: "initiated", amount_paisa: 5000 }),
      at("dg2", "status.changed", 1000, { data: { to: "failed", reason: "timeout" } }),
      // Today: not in yesterday's digest.
      { ...ev("payment.started", "dg3", 0, { status: "initiated" }), ts: new Date().toISOString() },
    ]);
    const before = devOutbox.length;
    await sendDigests(env, Date.now());
    const mails = devOutbox.slice(before).filter((m) => m.subject.includes(`'s org: payments on`));
    const mine = mails.find((m) => m.to.includes(s.email));
    expect(mine).toBeDefined();
    expect(mine!.to).not.toContain(viewer);
    expect(mine!.subject).toContain(new Date(y + NPT_OFFSET).toISOString().slice(0, 10));
    expect(mine!.text).toContain("Default (live): 2 payments, 50% success, Rs 1,250.00 revenue. Top failures: timeout (1)");

    // Opt out.
    expect((await call("PATCH", "/api/me", { cookie: s.cookie, body: { digest: false } })).status).toBe(200);
    const before2 = devOutbox.length;
    await sendDigests(env, Date.now());
    expect(devOutbox.slice(before2).some((m) => m.to.includes(s.email))).toBe(false);
  });
});

describe("retention", () => {
  it("drops events after 30 days, payments and minute_stats after 400, and expired auth rows", async () => {
    const t = Date.now();
    const old = t - 31 * DAY;
    await env.DB.batch([
      env.DB.prepare("INSERT INTO events (project_id, env, id, attempt_id, type, ts, received_at, gateway) VALUES ('rp', 'test', 'old', 'a', 'error', ?, ?, 'esewa')").bind(old, old),
      env.DB.prepare("INSERT INTO events (project_id, env, id, attempt_id, type, ts, received_at, gateway) VALUES ('rp', 'test', 'new', 'a', 'error', ?, ?, 'esewa')").bind(t, t),
      env.DB.prepare("INSERT INTO payments (project_id, env, attempt_id, gateway, status, started_at, updated_at, event_count) VALUES ('rp', 'test', 'p-old', 'esewa', 'paid', ?, ?, 1)").bind(t - 401 * DAY, t - 401 * DAY),
      env.DB.prepare("INSERT INTO payments (project_id, env, attempt_id, gateway, status, started_at, updated_at, event_count) VALUES ('rp', 'test', 'p-mid', 'esewa', 'paid', ?, ?, 1)").bind(old, old),
      env.DB.prepare("INSERT INTO minute_stats (project_id, env, gateway, minute) VALUES ('rp', 'test', 'esewa', ?)").bind(Math.floor((t - 401 * DAY) / 60_000)),
      env.DB.prepare("INSERT INTO minute_stats (project_id, env, gateway, minute) VALUES ('rp', 'test', 'esewa', ?)").bind(Math.floor(old / 60_000)),
      env.DB.prepare("INSERT INTO login_tokens (token_hash, email, expires_at) VALUES ('h', 'x@example.com', 1)"),
    ]);
    const removed = await cleanup(env, t);
    expect(removed).toMatchObject({ events: 1, payments: 1, minute_stats: 1, login_tokens: 1 });
    const ids = await env.DB.prepare("SELECT id FROM events WHERE project_id = 'rp'").all();
    expect(ids.results).toEqual([{ id: "new" }]);
    const pays = await env.DB.prepare("SELECT attempt_id FROM payments WHERE project_id = 'rp'").all();
    expect(pays.results).toEqual([{ attempt_id: "p-mid" }]);
  });

  it("the scheduled handler routes the daily cron and the minute cron", async () => {
    await env.DB.prepare("INSERT INTO login_tokens (token_hash, email, expires_at) VALUES ('h2', 'y@example.com', 1)").run();
    for (const cron of ["* * * * *", DAILY_CRON]) {
      const ctx = createExecutionContext();
      await worker.scheduled!(createScheduledController({ cron, scheduledTime: Date.now() }), env, ctx);
      await waitOnExecutionContext(ctx);
    }
    // Only the daily cron runs retention.
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM login_tokens WHERE token_hash = 'h2'").first("n")).toBe(0);
  });
});

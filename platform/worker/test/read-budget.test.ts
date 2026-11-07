// D1 rows-read budget. The free plan allows 5M rows read per day for the whole Cloudflare account, so one heavy
// query here takes every other database on the account down with it (it did: the status report and the doctor
// cron read about 5M rows a day between them). These tests count rows_read, the number D1 bills, for the jobs that
// run every minute or on every status page build, with realistic data, and hold each to a budget.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { runDoctorCron } from "../src/ops/cron-ops.ts";
import { PROBES, STATUS_GATEWAYS, hourOf, hourStartMinute, loadReport, rollupRecentHours, windowStart } from "../src/status/aggregate.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** A D1 binding that adds up meta.rows_read of everything it runs. */
function counted(real: D1Database) {
  const state = { rows: 0 };
  const raw = new WeakMap<object, D1PreparedStatement>();
  const add = <T extends { meta?: { rows_read?: number } }>(r: T) => ((state.rows += r.meta?.rows_read ?? 0), r);
  const wrap = (s: D1PreparedStatement): D1PreparedStatement => {
    const p = new Proxy(s, {
      get(target, prop) {
        if (prop === "bind") return (...a: unknown[]) => wrap(target.bind(...a));
        if (prop === "all" || prop === "run") return async () => add(await target[prop]());
        // first() has no meta: run it as all() so its rows count too.
        if (prop === "first") return async (col?: string) => {
          const row = add(await target.all()).results[0] as Record<string, unknown> | undefined;
          return row ? (col ? row[col] : row) : null;
        };
        const v = Reflect.get(target, prop, target);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    raw.set(p, s);
    return p;
  };
  const db = new Proxy(real, {
    get(target, prop) {
      if (prop === "prepare") return (q: string) => wrap(target.prepare(q));
      if (prop === "batch") return async (stmts: D1PreparedStatement[]) => (await target.batch(stmts.map((s) => raw.get(s) ?? s))).map(add);
      const v = Reflect.get(target, prop, target);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  return { env: { ...env, DB: db } as Env, state };
}

async function measure<T>(fn: (e: Env) => Promise<T>): Promise<{ value: T; rows: number }> {
  const c = counted(env.DB);
  const value = await fn(c.env);
  return { value, rows: c.state.rows };
}

describe("status report", () => {
  // 07:07 UTC = 12:52 NPT, so the window and the open hour both start mid-way through a UTC hour.
  const t = Date.UTC(2026, 9, 1, 7, 7);
  const nowMin = t / MINUTE;

  it("reads hour rows, not 48 h of minutes, and builds exactly the same report", async () => {
    // A full window of probes for every gateway, plus an hour past t for the steady-state check below.
    // eSewa fails for 10 minutes; Khalti is slow for 7 minutes across a Nepal hour boundary (two incidents).
    const first = windowStart(nowMin) - 60;
    const boundary = hourStartMinute(hourOf(nowMin) - 5);
    const rows: (string | number)[][] = [];
    for (const gw of STATUS_GATEWAYS) {
      for (let m = first; m <= nowMin + 60; m++) {
        if (gw === "nps" && m % 7 === 0) continue; // gaps
        const errs = gw === "esewa" && m >= nowMin - 300 && m < nowMin - 290 ? 6 : 0;
        const slow = gw === "khalti" && m >= boundary - 3 && m < boundary + 4;
        rows.push([gw, m, 10, errs, slow ? 80_000 : 3000, 10, slow ? 8000 : 400, slow ? 0 : 10, slow ? 10 : 0]);
      }
    }
    for (let i = 0; i < rows.length; i += 1000) {
      await env.DB.prepare(
        `INSERT INTO probe_minutes (gateway, minute, projects, requests, errors, ms_total, samples, ms_max, h2, h7)
         SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'), 1, json_extract(value, '$[2]'), json_extract(value, '$[3]'),
           json_extract(value, '$[4]'), json_extract(value, '$[5]'), json_extract(value, '$[6]'), json_extract(value, '$[7]'), json_extract(value, '$[8]')
         FROM json_each(?)`,
      )
        .bind(JSON.stringify(rows.slice(i, i + 1000)))
        .run();
    }

    // Before any hour is rolled up, a build falls back to minutes: the old cost.
    const before = await measure((e) => loadReport(e, t, PROBES));
    expect(before.rows).toBeGreaterThan(27_000);
    const esewa = before.value.gateways.find((g) => g.gateway === "esewa")!;
    const khalti = before.value.gateways.find((g) => g.gateway === "khalti")!;
    expect(esewa.incidents).toHaveLength(1);
    expect(khalti.incidents[0]).toMatchObject({ minutes: 7, kind: "latency" });

    // The first rollup backfills the window once.
    const backfill = await measure((e) => rollupRecentHours(e, t, PROBES));
    expect(backfill.value.hours).toBeGreaterThanOrEqual(48);

    const after = await measure((e) => loadReport(e, t, PROBES));
    expect(after.value).toEqual(before.value);
    // About 49 hour rows and 1 sentinel per hour, plus the open hour's minutes (52 here) and the last 15, per gateway.
    expect(after.rows).toBeLessThan(2_000);

    // Steady state, an hour later: the hourly job reads the hour index and one hour of minutes.
    const next = await measure((e) => rollupRecentHours(e, t + HOUR, PROBES));
    expect(next.value.hours).toBe(1);
    expect(next.rows).toBeLessThan(1_500);
  });
});

describe("doctor cron", () => {
  it("reads only the minute's callbacks, not every recent event", async () => {
    const t = Date.UTC(2026, 9, 2, 7, 7, 30); // minute 7: not a 15-minute no_reconcile run
    const judged = Math.floor(t / MINUTE) * MINUTE - 2 * MINUTE;
    const events: (string | number | null)[][] = [];
    // 3,000 gateway calls received over the last 30 minutes: what the old query walked through every minute.
    for (let i = 0; i < 3000; i++) events.push([`evt_n${i}`, `att_n${i % 500}`, "gateway.request", t - 30 * MINUTE + i * 600, '{"op":"initiate"}']);
    // Four callbacks in the judged minute: two followed by a status check, two not.
    for (let i = 0; i < 4; i++) {
      events.push([`evt_cb${i}`, `att_cb${i}`, "callback.received", judged + i * 1000, null]);
      if (i < 2) events.push([`evt_st${i}`, `att_cb${i}`, "gateway.request", judged + i * 1000 + 500, '{"op":"status"}']);
    }
    for (let i = 0; i < events.length; i += 500) {
      await env.DB.prepare(
        `INSERT INTO events (project_id, env, id, attempt_id, type, ts, received_at, gateway, data)
         SELECT 'prj_budget', 'live', json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]'),
           json_extract(value, '$[3]'), json_extract(value, '$[3]'), 'esewa', json_extract(value, '$[4]')
         FROM json_each(?)`,
      )
        .bind(JSON.stringify(events.slice(i, i + 500)))
        .run();
    }

    const run = await measure((e) => runDoctorCron(e, t));
    expect(run.value.no_status_check_after_return).toBe(1); // one group: prj_budget / live / esewa
    const f = await env.DB.prepare("SELECT count, example_attempt FROM doctor_findings WHERE project_id = 'prj_budget' AND code = 'no_status_check_after_return'").first<{ count: number; example_attempt: string }>();
    expect(f).toMatchObject({ count: 2, example_attempt: "att_cb3" });
    expect(run.rows).toBeLessThan(100);
  });
});

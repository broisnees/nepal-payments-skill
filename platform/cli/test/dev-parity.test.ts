// The dev server's rollup against the worker's: the same fixture through worker/src/ingest.ts (its real SQL,
// on node:sqlite through a D1 shim) and through DevStore must give identical payments, minute_stats, accept and
// duplicate counts, and gateway health.
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { GatewayHealth } from "../../shared/src/api.ts";
import type { PaymentEvent } from "../../shared/src/events.ts";
import { gatewayHealth } from "../src/dev/queries.ts";
import { DevStore, LOCAL_PROJECT, loadSqlite } from "../src/dev/store.ts";
import { d1 } from "./d1-sqlite.ts";
import { FIXTURE_BATCHES, FIXTURE_T0 } from "./rollup-fixture.ts";

const hasSqlite = (await loadSqlite()) !== null;

// The worker's modules, loaded by path so this package's typecheck does not pull in the Workers types.
type WorkerEnv = { DB: unknown };
type WorkerIngest = (env: WorkerEnv, project: string, env2: string, events: PaymentEvent[], at: number) => Promise<{
  accepted: number;
  duplicates: number;
  stored: { event: { id: string }; attempt_id: string }[];
  payments: Map<string, unknown>;
}>;
const worker = join(import.meta.dirname, "../../worker/src");
const { ingestEvents } = (await import(/* @vite-ignore */ join(worker, "ingest.ts"))) as { ingestEvents: WorkerIngest };
const { gatewayHealth: workerHealth } = (await import(/* @vite-ignore */ join(worker, "api/data.ts"))) as {
  gatewayHealth: (env: WorkerEnv, project: string, envName: string, t: number) => Promise<GatewayHealth[]>;
};
const sortBy = <T extends Record<string, unknown>>(rows: T[], ...keys: string[]) =>
  [...rows].sort((a, b) => {
    for (const k of keys) if (a[k] !== b[k]) return String(a[k]) < String(b[k]) ? -1 : 1;
    return 0;
  });

describe.skipIf(!hasSqlite)("rollup parity with the worker", () => {
  it("same payments, minute_stats, counts and health from the same batches", async () => {
    const shim = (await d1())!;
    const env: WorkerEnv = { DB: shim.DB };
    const store = await DevStore.open();
    const at = FIXTURE_T0 + 500_000;
    for (const batch of FIXTURE_BATCHES) {
      const w = await ingestEvents(env, LOCAL_PROJECT, "test", batch, at);
      const d = store.ingest("test", batch, at);
      expect({ accepted: d.accepted, duplicates: d.duplicates }).toEqual({ accepted: w.accepted, duplicates: w.duplicates });
      // The payment row each accepted event produced (what the live stream sends) matches too.
      expect(d.stored.map((s) => s.event.id)).toEqual(w.stored.map((s) => s.event.id));
      const last = new Map(d.stored.map((s) => [s.event.attempt_id, s.payment]));
      expect(Object.fromEntries(last)).toEqual(Object.fromEntries(w.payments));
    }

    const wPayments = (await shim.DB.prepare("SELECT * FROM payments").all()).results;
    const wMinutes = (await shim.DB.prepare("SELECT * FROM minute_stats").all()).results;
    const wEvents = (await shim.DB.prepare("SELECT * FROM events").all()).results;
    expect(wPayments).toHaveLength(7);
    expect(wMinutes.length).toBeGreaterThan(3);
    expect(sortBy([...store.payments.values()] as never, "attempt_id")).toEqual(sortBy(wPayments, "attempt_id"));
    expect(sortBy([...store.minutes.values()] as never, "gateway", "minute")).toEqual(sortBy(wMinutes, "gateway", "minute"));
    expect(sortBy([...store.events.values()].map((e) => ({ ...e, received_at: at })) as never, "id")).toEqual(sortBy(wEvents, "id"));

    // The rules this fixture is built around, so a shared bug cannot pass silently.
    const p = (id: string) => store.payments.get(`test|${id}`)!;
    expect(p("p1")).toMatchObject({ status: "paid", fulfil_count: 1, provider_ref: "0LD5CEH", order_id: "ORD-1" });
    expect(p("p2")).toMatchObject({ status: "failed", last_reason: "amount_mismatch" });
    expect(p("p3")).toMatchObject({ status: "refunded", fulfil_count: 2 });
    expect(p("p4")).toMatchObject({ status: "initiated", error_count: 2 });
    expect(p("p5")).toMatchObject({ status: "paid" });
    // v2: a partial refund leaves the status, the one that completes it sets refunded; a bare refund is a full one.
    expect(p("p6")).toMatchObject({ status: "refunded", refunded_paisa: 20000, gw_env: "sandbox", customer_name: "Sita", customer_hash: null, fulfilled_at: FIXTURE_T0 + 70_100 });
    expect(p("p7")).toMatchObject({ status: "refunded", refunded_paisa: 0, amount_paisa: 3000 });

    for (const t of [FIXTURE_T0 + 120_000, FIXTURE_T0 + 3_600_000]) {
      expect(gatewayHealth(store, "test", t)).toEqual(await workerHealth(env, LOCAL_PROJECT, "test", t));
    }
    shim.close();
  });
});

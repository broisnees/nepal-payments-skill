// The fake live stream: schedules future events from new traces and plays them out in real time, the way the
// ProjectLive Durable Object would broadcast them (SPEC section 7).
import type { Env, LiveMessage, StoredEvent } from "@paynp/shared";
import { addTrace, hourWeight, nextOrder, type Db, type ProjectData } from "./db.ts";
import { GATEWAY_MIX, between, seeded, trace, weighted } from "./gen.ts";

type Listener = (m: LiveMessage) => void;

const SPEEDUP = 5;
const BACKFILL_MS = 12 * 60_000;

export interface Hub {
  subscribe(project: string, env: Env, fn: Listener): () => void;
  backlog(project: string, env: Env): StoredEvent[];
  testPayment(pd: ProjectData, env: Env): string;
}

interface Pending {
  at: number;
  project: string;
  env: Env;
  event: StoredEvent;
}

export function createHub(db: Db): Hub {
  const listeners = new Map<string, Set<Listener>>();
  const queue: Pending[] = [];
  const r = seeded(Date.now() % 100_000);
  const nextSpawn = new Map<string, number>();

  function schedule(pd: ProjectData, env: Env, events: StoredEvent[]) {
    for (const event of events) queue.push({ at: Date.parse(event.ts), project: pd.project.id, env, event });
    queue.sort((a, z) => a.at - z.at);
  }

  function spawn(pd: ProjectData, env: Env, start: number) {
    const gateway = weighted(r, GATEWAY_MIX);
    // Buyers in the demo pay faster than in life so a trace completes while someone is watching.
    // Fonepay is having a slow afternoon, as in the seeded history and the firing incident.
    const slow = gateway === "fonepay" ? between(r, 4, 7) : 1;
    let ev = trace({ r, start, env, gateway, orderId: nextOrder(pd), buyerMs: between(r, 4_000, 22_000), slow });
    // Expired traces jump 15 minutes ahead; in the live demo they would never arrive, so play them as cancels.
    if (Date.parse(ev[ev.length - 1].ts) - start > 120_000) ev = trace({ r, start, env, gateway, orderId: nextOrder(pd), buyerMs: between(r, 4_000, 14_000), scenario: "canceled" });
    return ev;
  }

  const gapMs = (rate: number, at: number, speed = SPEEDUP) => {
    // A few times the real rate, so the feed moves. Exponential gaps keep it bursty like real traffic.
    const perHour = Math.max(rate * hourWeight(at), rate * 0.25) * speed;
    return Math.min(30_000, -Math.log(1 - r()) * (3_600_000 / perHour));
  };

  // Backfill the last few minutes as if the stream had been running: health has recent data and some
  // payments are mid-flight when the page opens. Their remaining events play out live.
  {
    const now = Date.now();
    for (const pd of db.projects.values()) {
      for (const env of ["live", "test"] as Env[]) {
        const rate = pd.rate[env];
        if (!rate) continue;
        const b = pd.env[env];
        for (let t = now - BACKFILL_MS + gapMs(rate, now, 2); t < now; t += gapMs(rate, t, 2)) {
          const ev = spawn(pd, env, t);
          const past = ev.filter((e) => Date.parse(e.ts) <= now);
          if (past.length) {
            addTrace(b, env, past);
            b.recent.push(...past);
          }
          schedule(pd, env, ev.filter((e) => Date.parse(e.ts) > now));
        }
        b.recent.sort((a, z) => Date.parse(a.ts) - Date.parse(z.ts));
      }
    }
  }

  function tick() {
    const now = Date.now();
    for (const pd of db.projects.values()) {
      for (const env of ["live", "test"] as Env[]) {
        const rate = pd.rate[env];
        if (!rate) continue;
        const k = `${pd.project.id}:${env}`;
        const due = nextSpawn.get(k);
        if (due === undefined) {
          nextSpawn.set(k, now + between(r, 300, 2500));
          continue;
        }
        if (now < due) continue;
        schedule(pd, env, spawn(pd, env, now));
        nextSpawn.set(k, now + gapMs(rate, now));
      }
    }
    while (queue.length && queue[0].at <= now) {
      const { project, env, event } = queue.shift()!;
      const pd = db.projects.get(project);
      if (!pd) continue;
      const b = pd.env[env];
      const payment = addTrace(b, env, [event]);
      b.recent.push(event);
      if (b.recent.length > 20_000) b.recent.splice(0, 5_000);
      const msg: LiveMessage = { kind: "event", event: { ...event, received_at: Date.now() }, payment: { ...payment } };
      for (const fn of listeners.get(`${project}:${env}`) ?? []) fn(msg);
    }
  }

  setInterval(tick, 200);
  setInterval(() => {
    for (const set of listeners.values()) for (const fn of set) fn({ kind: "ping" });
  }, 30_000);

  return {
    subscribe(project, env, fn) {
      const k = `${project}:${env}`;
      let set = listeners.get(k);
      if (!set) listeners.set(k, (set = new Set()));
      set.add(fn);
      return () => set.delete(fn);
    },
    backlog(project, env) {
      return db.projects.get(project)?.env[env].recent.slice(-200) ?? [];
    },
    testPayment(pd, env) {
      const ev = trace({ r, start: Date.now() + 150, env, gateway: "esewa", orderId: `test-${Date.now().toString(36)}`, scenario: "paid", buyerMs: 1800, amountPaisa: 10_000 });
      schedule(pd, env, ev);
      return ev[0].attempt_id;
    },
  };
}

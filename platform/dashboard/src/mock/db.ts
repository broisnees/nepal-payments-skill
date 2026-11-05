// In-memory data for mock mode: a fictional Kathmandu clothing store with 30 days of traffic, a second org, and
// one empty project so the onboarding state is reachable.
import type { AlertChannel, AlertRule, ApiKey, Env, Incident, Me, Payment, Project, Session, StoredEvent } from "@paynp/shared";
import { NPT_OFFSET_MS } from "../lib/format.ts";
import type { Invite, Member, Pat } from "../lib/types.ts";
import { GATEWAY_MIX, between, int, rollup, seeded, trace, weighted, type Rng, type Scenario } from "./gen.ts";

export interface Bucket {
  payments: Payment[]; // newest first
  byId: Map<string, Payment>;
  events: Map<string, StoredEvent[]>;
  recent: StoredEvent[]; // every event, time order, for backlog, events API and health
}

export interface ProjectData {
  project: Project;
  env: Record<Env, Bucket>;
  keys: ApiKey[];
  channels: AlertChannel[];
  rules: AlertRule[];
  incidents: Incident[];
  orderSeq: number;
  /** Payments per hour at the daily peak, per env. Zero means no traffic. */
  rate: Record<Env, number>;
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export const ME: Me = {
  user: { id: "usr_sita", email: "sita@himalayanthreads.com.np", name: "Sita Gurung", digest: true } as Me["user"],
  orgs: [
    { id: "org_ht", name: "Himalayan Threads", role: "owner" },
    { id: "org_tb", name: "Thamel Books", role: "admin" },
  ],
};

function bucket(): Bucket {
  return { payments: [], byId: new Map(), events: new Map(), recent: [] };
}

// Kathmandu shopping hours: quiet overnight, a lunch bump, the evening peak after work.
const DIURNAL = [0.08, 0.05, 0.04, 0.03, 0.04, 0.08, 0.18, 0.32, 0.48, 0.62, 0.74, 0.86, 0.92, 0.84, 0.72, 0.68, 0.7, 0.78, 0.9, 1, 0.96, 0.78, 0.5, 0.22];

export function hourWeight(ms: number): number {
  const h = new Date(ms + NPT_OFFSET_MS).getUTCHours();
  const dow = new Date(ms + NPT_OFFSET_MS).getUTCDay();
  // Saturday is the weekend in Nepal: a little busier for a shop.
  return DIURNAL[h] * (dow === 6 ? 1.15 : 1);
}

function pickGateway(r: Rng) {
  return weighted(r, GATEWAY_MIX);
}

export function addTrace(b: Bucket, env: Env, events: StoredEvent[]) {
  const id = events[0].attempt_id;
  const prev = b.events.get(id) ?? [];
  const all = prev.concat(events);
  b.events.set(id, all);
  const p = rollup(env, all);
  const existing = b.byId.get(id);
  if (existing) Object.assign(existing, p);
  else {
    b.byId.set(id, p);
    // Keep newest first. New payments are almost always the newest, so unshift is the common path.
    if (!b.payments.length || p.started_at >= b.payments[0].started_at) b.payments.unshift(p);
    else {
      const i = b.payments.findIndex((x) => x.started_at < p.started_at);
      b.payments.splice(i === -1 ? b.payments.length : i, 0, p);
    }
  }
  return b.byId.get(id)!;
}

function history(pd: ProjectData, env: Env, seed: number, days: number, now: number) {
  const r = seeded(seed);
  const b = pd.env[env];
  const peak = pd.rate[env];
  if (!peak) return;
  const start = now - days * DAY;
  const all: StoredEvent[] = [];
  for (let h = start; h < now - 4 * MIN; h += HOUR) {
    // Slow growth over the month, so the 30 day chart has a direction.
    const growth = 0.75 + 0.25 * ((h - start) / (now - start));
    const expected = peak * hourWeight(h) * growth;
    const n = Math.round(expected * between(r, 0.7, 1.3));
    for (let i = 0; i < n; i++) {
      const t0 = h + Math.floor(r() * HOUR);
      if (t0 > now - 4 * MIN) continue;
      const gateway = pickGateway(r);
      // A slow Fonepay afternoon: the last two hours carry higher latency and more timeouts.
      const fonepaySlow = gateway === "fonepay" && now - t0 < 2 * HOUR;
      let scenario: Scenario | undefined;
      if (fonepaySlow && r() < 0.18) scenario = "timeout";
      // Payments younger than the reconcile window that were going to expire are still pending.
      const ev = trace({ r, start: t0, env, gateway, orderId: nextOrder(pd), scenario, slow: fonepaySlow ? between(r, 4, 7) : 1 });
      const cut = ev.filter((e) => Date.parse(e.ts) <= now - 2000);
      if (!cut.length) continue;
      all.push(...cut);
      addTrace(b, env, cut);
    }
  }
  // A few stuck ones for the stuck_pending rule: started 40 to 90 minutes ago, never came back.
  if (env === "live" && peak > 10) {
    for (let i = 0; i < 3; i++) {
      const t0 = now - int(r, 40, 90) * MIN;
      const ev = trace({ r, start: t0, env, gateway: i === 2 ? "khalti" : "esewa", orderId: nextOrder(pd), scenario: "pending" });
      all.push(...ev);
      addTrace(b, env, ev);
    }
  }
  b.payments.sort((a, z) => z.started_at - a.started_at);
  b.recent = all.sort((a, z) => Date.parse(a.ts) - Date.parse(z.ts));
}

export function nextOrder(pd: ProjectData): string {
  pd.orderSeq += 1;
  return `${pd.project.slug === "storefront" ? "HT" : pd.project.slug === "thamelbooks" ? "TB" : "WH"}-${pd.orderSeq}`;
}

function key(id: string, env: Env, tail: string, name: string, created: number, last: number | null, revoked: number | null = null): ApiKey {
  return { id, env, prefix: `pnp_${env}_${tail}`, name, created_at: created, last_used_at: last, revoked_at: revoked };
}

export interface Db {
  projects: Map<string, ProjectData>;
  members: Record<string, Member[]>;
  invites: Record<string, Invite[]>;
  sessions: Session[];
  pats: Pat[];
  signedIn: boolean;
}

export function createDb(now = Date.now()): Db {
  const mk = (id: string, org_id: string, name: string, slug: string, created: number, rate: Record<Env, number>): ProjectData => ({
    project: { id, org_id, name, slug, created_at: created },
    env: { test: bucket(), live: bucket() },
    keys: [],
    channels: [],
    rules: [],
    incidents: [],
    orderSeq: 10_000,
    rate,
  });

  const store = mk("prj_storefront", "org_ht", "Storefront", "storefront", now - 120 * DAY, { live: 22, test: 1.2 });
  const wholesale = mk("prj_wholesale", "org_ht", "Wholesale portal", "wholesale", now - 2 * DAY, { live: 0, test: 0 });
  const books = mk("prj_books", "org_tb", "thamelbooks.com", "thamelbooks", now - 300 * DAY, { live: 6, test: 0.4 });

  history(store, "live", 7, 30, now);
  history(store, "test", 8, 10, now);
  history(books, "live", 9, 30, now);
  history(books, "test", 10, 5, now);

  store.keys = [
    key("key_1", "live", "8fKq", "Production server", now - 90 * DAY, now - 40_000),
    key("key_2", "test", "Zr2M", "Local dev", now - 92 * DAY, now - 3 * HOUR),
    key("key_3", "test", "aP0x", "Old laptop", now - 110 * DAY, now - 60 * DAY, now - 58 * DAY),
  ];
  books.keys = [key("key_4", "live", "Qm7c", "Render", now - 200 * DAY, now - 2 * MIN)];

  store.channels = [
    { id: "ch_email", type: "email", name: "Owners", config: { to: ["sita@himalayanthreads.com.np", "ramesh@himalayanthreads.com.np"] }, created_at: now - 80 * DAY },
    { id: "ch_slack", type: "slack", name: "#payments", config: { webhook_url: "https://hooks.slack.com/services/T04****/B07****/****" }, created_at: now - 60 * DAY },
    { id: "ch_hook", type: "webhook", name: "Ops pager", config: { url: "https://ops.himalayanthreads.com.np/hooks/paynp", secret: "whsec_****" }, created_at: now - 20 * DAY },
  ];
  const rule = (id: string, type: AlertRule["type"], params: Record<string, unknown>, channel_ids: string[], enabled = true, cooldown_min = 30): AlertRule => ({
    id,
    env: "live",
    type,
    params,
    channel_ids,
    cooldown_min,
    enabled,
    created_at: now - 70 * DAY,
  });
  store.rules = [
    rule("rul_1", "failure_rate", { threshold_pct: 20, window_min: 15, min_payments: 5 }, ["ch_email", "ch_slack"]),
    rule("rul_2", "gateway_slow", { avg_ms: 3000, window_min: 10 }, ["ch_slack"]),
    rule("rul_3", "stuck_pending", { older_than_min: 30 }, ["ch_slack"]),
    rule("rul_4", "amount_mismatch", {}, ["ch_email", "ch_slack", "ch_hook"], true, 0),
    rule("rul_5", "payment_failed", { min_amount_paisa: 500_000 }, ["ch_email"]),
    rule("rul_6", "double_fulfilment", {}, ["ch_email", "ch_hook"], true, 0),
    rule("rul_7", "no_traffic", { window_min: 60 }, ["ch_email"], false),
  ];
  store.incidents = [
    {
      id: "inc_5",
      rule_id: "rul_2",
      state: "firing",
      opened_at: now - 38 * MIN,
      resolved_at: null,
      last_notified_at: now - 8 * MIN,
      summary: "Fonepay status checks average 4.8 s over the last 10 minutes (limit 3 s)",
      context: { gateway: "fonepay", avg_ms: 4810 },
    },
    {
      id: "inc_4",
      rule_id: "rul_3",
      state: "firing",
      opened_at: now - 12 * MIN,
      resolved_at: null,
      last_notified_at: now - 12 * MIN,
      summary: "3 payments open for more than 30 minutes",
      context: { count: 3 },
    },
    {
      id: "inc_3",
      rule_id: "rul_1",
      state: "resolved",
      opened_at: now - 2 * DAY - 3 * HOUR,
      resolved_at: now - 2 * DAY - 3 * HOUR + 24 * MIN,
      last_notified_at: now - 2 * DAY - 3 * HOUR,
      summary: "eSewa failure rate 27.3% over 15 minutes (limit 20%, 22 payments)",
      context: { gateway: "esewa" },
    },
    {
      id: "inc_2",
      rule_id: "rul_4",
      state: "resolved",
      opened_at: now - 5 * DAY - 7 * HOUR,
      resolved_at: now - 5 * DAY - 7 * HOUR + 2 * MIN,
      last_notified_at: now - 5 * DAY - 7 * HOUR,
      summary: "Amount mismatch on HT-10422: gateway reported Rs 1,192.40, order total Rs 1,355.00",
      context: null,
    },
    {
      id: "inc_1",
      rule_id: "rul_5",
      state: "resolved",
      opened_at: now - 9 * DAY,
      resolved_at: now - 9 * DAY + 40 * MIN,
      last_notified_at: now - 9 * DAY,
      summary: "Payment of Rs 24,999.00 failed on Khalti (Expired)",
      context: null,
    },
  ];
  books.channels = [{ id: "ch_tb", type: "discord", name: "#shop-alerts", config: { webhook_url: "https://discord.com/api/webhooks/****" }, created_at: now - 100 * DAY }];
  books.rules = [rule("rul_tb1", "failure_rate", { threshold_pct: 25, window_min: 30, min_payments: 5 }, ["ch_tb"])];

  return {
    projects: new Map([store, wholesale, books].map((p) => [p.project.id, p])),
    members: {
      org_ht: [
        { user_id: "usr_sita", email: ME.user.email, name: "Sita Gurung", role: "owner", created_at: now - 120 * DAY },
        { user_id: "usr_ramesh", email: "ramesh@himalayanthreads.com.np", name: "Ramesh Thapa", role: "admin", created_at: now - 100 * DAY },
        { user_id: "usr_anita", email: "anita.rai@gmail.com", name: "Anita Rai", role: "viewer", created_at: now - 30 * DAY },
      ],
      org_tb: [
        { user_id: "usr_bikash", email: "bikash@thamelbooks.com", name: "Bikash Shrestha", role: "owner", created_at: now - 300 * DAY },
        { user_id: "usr_sita", email: ME.user.email, name: "Sita Gurung", role: "admin", created_at: now - 200 * DAY },
      ],
    },
    invites: { org_ht: [{ id: "inv_1", email: "accounts@himalayanthreads.com.np", role: "viewer", expires_at: now + 5 * DAY }], org_tb: [] },
    sessions: [
      { id: "ses_1", user_agent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36", ip: "103.10.28.44", created_at: now - 6 * DAY, last_seen_at: now, current: true },
      { id: "ses_2", user_agent: "Mozilla/5.0 (iPhone; CPU iPhone OS 19_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.1 Mobile/15E148 Safari/604.1", ip: "27.34.68.201", created_at: now - 14 * DAY, last_seen_at: now - 5 * HOUR, current: false },
      { id: "ses_3", user_agent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:144.0) Gecko/20100101 Firefox/144.0", ip: "110.44.115.9", created_at: now - 27 * DAY, last_seen_at: now - 11 * DAY, current: false },
    ],
    pats: [
      { id: "pat_1", name: "paynp CLI on sita-thinkpad", created_at: now - 40 * DAY, last_used_at: now - 25 * MIN },
      { id: "pat_2", name: "paynp CLI on ci-runner", created_at: now - 18 * DAY, last_used_at: now - 2 * DAY },
    ],
    signedIn: readSignedIn(),
  };
}

function readSignedIn(): boolean {
  try {
    return sessionStorage.getItem("paynp-mock-signed-out") !== "1";
  } catch {
    return true;
  }
}

export function setSignedIn(db: Db, v: boolean) {
  db.signedIn = v;
  try {
    if (v) sessionStorage.removeItem("paynp-mock-signed-out");
    else sessionStorage.setItem("paynp-mock-signed-out", "1");
  } catch {
    /* private mode: state lives in memory only */
  }
}

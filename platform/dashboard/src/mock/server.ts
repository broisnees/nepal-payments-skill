// The REST API of SPEC section 6, answered from memory. Same paths, same shapes, same CSRF rule.
import {
  CSRF_HEADER,
  OPEN_STATUSES,
  explain,
  newId,
  type AlertChannel,
  type AlertRule,
  type Analytics,
  type CreatedKey,
  type Env,
  type GatewayHealth,
  type Page,
  type Payment,
  type PaymentDetail,
  type SeriesPoint,
  type StoredEvent,
} from "@paynp/shared";
import { NPT_OFFSET_MS, nptStartOfDay } from "../lib/format.ts";
import { ME, setSignedIn, type Db } from "./db.ts";
import type { Hub } from "./hub.ts";

export interface MockRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
  headers: Headers;
}
export interface MockResponse {
  status: number;
  body?: unknown;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ok = (body: unknown, status = 200): MockResponse => ({ status, body });
const noContent: MockResponse = { status: 204 };
const fail = (status: number, code: string, message: string): MockResponse => ({ status, body: { error: { code, message } } });

function page<T>(all: T[], q: URLSearchParams, def = 50): Page<T> {
  const limit = Math.min(200, Number(q.get("limit")) || def);
  const offset = Number(q.get("cursor")) || 0;
  const items = all.slice(offset, offset + limit);
  return { items, next_cursor: offset + limit < all.length ? String(offset + limit) : null };
}

const B62 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const secret = (n: number) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => B62[b % 62]).join("");

export function createServer(db: Db, hub: Hub) {
  const project = (id: string) => db.projects.get(id);
  const envOf = (q: URLSearchParams): Env => (q.get("env") === "test" ? "test" : "live");

  return async function handle(req: MockRequest): Promise<MockResponse> {
    const { method, path, query: q } = req;
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (method !== "GET" && path.startsWith("/api/") && req.headers.get(CSRF_HEADER) !== "1") {
      return fail(403, "csrf", `Missing ${CSRF_HEADER} header`);
    }

    // ---------------------------------------------------------------- auth
    if (path === "/auth/login" && method === "POST") return noContent;
    if (path === "/auth/logout" && method === "POST") {
      setSignedIn(db, false);
      return noContent;
    }
    if (path === "/auth/mock-verify" && method === "POST") {
      setSignedIn(db, true);
      return noContent;
    }
    if (path === "/api/device/approve" && method === "POST") {
      if (!db.signedIn) return fail(401, "unauthorized", "Sign in first");
      const code = String(body.user_code ?? "").toUpperCase();
      if (!/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code)) return fail(400, "invalid_code", "That code is not valid. Check the code in your terminal.");
      if (code === "EXPD-0000") return fail(410, "expired", "This code has expired. Run paynp login again for a new one.");
      return ok({ approved: true });
    }

    if (!path.startsWith("/api/")) return fail(404, "not_found", "No such route");
    if (!db.signedIn) return fail(401, "unauthorized", "Sign in to continue");

    const seg = path.slice(5).split("/").filter(Boolean);

    // ---------------------------------------------------------------- user scope
    if (seg[0] === "me") {
      if (method === "PATCH") {
        if (typeof body.name === "string") ME.user.name = body.name || null;
        if (typeof body.digest === "boolean") (ME.user as { digest?: boolean }).digest = body.digest;
        return ok({ user: ME.user });
      }
      return ok(ME);
    }
    if (seg[0] === "sessions") {
      if (method === "GET") return ok(page(db.sessions, q));
      if (method === "DELETE" && seg[1]) {
        db.sessions = db.sessions.filter((s) => s.id !== seg[1]);
        return noContent;
      }
    }
    if (seg[0] === "pats") {
      if (method === "GET") return ok(page(db.pats, q));
      if (method === "DELETE" && seg[1]) {
        db.pats = db.pats.filter((s) => s.id !== seg[1]);
        return noContent;
      }
    }

    // ---------------------------------------------------------------- orgs
    if (seg[0] === "orgs" && seg[1]) {
      const org = seg[1];
      if (seg[2] === "projects") {
        if (method === "GET") return ok(page([...db.projects.values()].filter((p) => p.project.org_id === org).map((p) => p.project), q));
        if (method === "POST") {
          const name = String(body.name ?? "").trim();
          if (!name) return fail(400, "invalid", "Name is required");
          const id = newId("prj").slice(0, 16).toLowerCase();
          const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
          db.projects.set(id, {
            project: { id, org_id: org, name, slug, created_at: Date.now() },
            env: { test: emptyBucket(), live: emptyBucket() },
            keys: [],
            channels: [],
            rules: [],
            incidents: [],
            orderSeq: 1000,
            rate: { live: 0, test: 0 },
          });
          return ok(db.projects.get(id)!.project, 201);
        }
      }
      if (seg[2] === "members") {
        if (method === "GET" && !seg[3]) return ok(page(db.members[org] ?? [], q));
        const list = db.members[org] ?? [];
        const m = list.find((x) => x.user_id === seg[3]);
        if (!m) return fail(404, "not_found", "No such member");
        if (method === "PATCH") {
          if (m.role === "owner" && list.filter((x) => x.role === "owner").length === 1 && body.role !== "owner") return fail(409, "last_owner", "An organization needs at least one owner");
          m.role = body.role as typeof m.role;
          return ok(m);
        }
        if (method === "DELETE") {
          db.members[org] = list.filter((x) => x !== m);
          return noContent;
        }
      }
      if (seg[2] === "invites") {
        if (method === "GET") return ok({ items: db.invites[org] ?? [], next_cursor: null });
        if (method === "POST") {
          const email = String(body.email ?? "").trim();
          if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return fail(400, "invalid_email", "Enter a valid email address");
          const inv = { id: newId("inv"), email, role: (body.role as "viewer") ?? "viewer", expires_at: Date.now() + 7 * DAY };
          (db.invites[org] ??= []).push(inv);
          return ok(inv, 201);
        }
        if (method === "DELETE" && seg[3]) {
          db.invites[org] = (db.invites[org] ?? []).filter((i) => i.id !== seg[3]);
          return noContent;
        }
      }
      if (method === "PATCH" && !seg[2]) {
        const o = ME.orgs.find((x) => x.id === org);
        if (o && typeof body.name === "string") o.name = body.name;
        return ok(o);
      }
    }

    // ---------------------------------------------------------------- projects
    if (seg[0] !== "projects" || !seg[1]) return fail(404, "not_found", "No such route");
    const pd = project(seg[1]);
    if (!pd) return fail(404, "not_found", "Project not found");
    const env = envOf(q);
    const b = pd.env[env];
    const sub = seg[2];

    if (!sub) {
      if (method === "GET") return ok(pd.project);
      if (method === "PATCH") {
        if (typeof body.name === "string" && body.name.trim()) pd.project.name = body.name.trim();
        return ok(pd.project);
      }
      if (method === "DELETE") {
        db.projects.delete(pd.project.id);
        return noContent;
      }
    }

    if (sub === "keys") {
      if (method === "GET") return ok(page(pd.keys, q));
      if (method === "POST") {
        const kenv: Env = body.env === "live" ? "live" : "test";
        const full = `pnp_${kenv}_${secret(32)}`;
        const k: CreatedKey = { id: newId("key"), env: kenv, prefix: full.slice(0, 13), name: (body.name as string) || null, created_at: Date.now(), last_used_at: null, revoked_at: null, key: full };
        const { key: _drop, ...stored } = k;
        void _drop;
        pd.keys.unshift(stored);
        return ok(k, 201);
      }
      if (method === "DELETE" && seg[3]) {
        const k = pd.keys.find((x) => x.id === seg[3]);
        if (k) k.revoked_at = Date.now();
        return noContent;
      }
    }

    if (sub === "payments" && method === "GET") {
      if (seg[3]) {
        const p = b.byId.get(decodeURIComponent(seg[3]));
        if (!p) return fail(404, "not_found", "No payment with that attempt id in this environment");
        const events = [...(b.events.get(p.attempt_id) ?? [])].sort((a, z) => Date.parse(a.ts) - Date.parse(z.ts));
        const last = [...events].reverse();
        const ex =
          p.status === "paid" && !p.error_count
            ? null
            : explain({
                gateway: p.gateway,
                provider_code: last.find((e) => e.data?.provider_code)?.data?.provider_code,
                reason: p.last_reason,
                provider_status: last.find((e) => e.data?.provider_status)?.data?.provider_status,
              });
        const detail: PaymentDetail = { payment: p, events, explain: ex };
        return ok(detail);
      }
      return ok(page(filterPayments(b.payments, q), q));
    }

    if (sub === "events" && method === "GET") {
      const type = q.get("type");
      const gw = q.get("gateway");
      const since = Number(q.get("since")) || 0;
      const list = b.recent.filter((e) => (!type || e.type === type) && (!gw || e.gateway === gw) && Date.parse(e.ts) >= since).slice(-200).reverse();
      return ok(page(list, q, 100));
    }

    if (sub === "analytics" && method === "GET") return ok(analytics(b, q));
    if (sub === "health" && method === "GET") return ok({ items: health(b), next_cursor: null });

    if (sub === "test-payment" && method === "POST") {
      const attempt_id = hub.testPayment(pd, "test");
      return ok({ attempt_id, env: "test", accepted: 7 }, 201);
    }

    if (sub === "channels") {
      if (method === "GET") return ok(page(pd.channels, q));
      if (seg[3] && seg[4] === "test" && method === "POST") {
        const ch = pd.channels.find((c) => c.id === seg[3]);
        if (!ch) return fail(404, "not_found", "No such channel");
        await new Promise((r) => setTimeout(r, 500));
        if (ch.type === "webhook" && String(ch.config.url).includes("localhost")) return fail(502, "delivery_failed", "Connection refused by localhost:4000");
        return noContent;
      }
      if (method === "POST") {
        const ch: AlertChannel = { id: newId("ch"), type: body.type as AlertChannel["type"], name: String(body.name ?? ""), config: (body.config as Record<string, unknown>) ?? {}, created_at: Date.now() };
        if (ch.type === "webhook" && ch.config.secret) ch.config = { ...ch.config, secret: "whsec_****" };
        pd.channels.push(ch);
        return ok(ch, 201);
      }
      const ch = pd.channels.find((c) => c.id === seg[3]);
      if (!ch) return fail(404, "not_found", "No such channel");
      if (method === "PATCH") {
        Object.assign(ch, body);
        return ok(ch);
      }
      if (method === "DELETE") {
        pd.channels = pd.channels.filter((c) => c !== ch);
        for (const r of pd.rules) r.channel_ids = r.channel_ids.filter((id) => id !== ch.id);
        return noContent;
      }
    }

    if (sub === "rules") {
      if (method === "GET") return ok(page(pd.rules, q));
      if (method === "POST") {
        const r: AlertRule = {
          id: newId("rul"),
          env: (body.env as Env) ?? "live",
          type: body.type as AlertRule["type"],
          params: (body.params as Record<string, unknown>) ?? {},
          channel_ids: (body.channel_ids as string[]) ?? [],
          cooldown_min: Number(body.cooldown_min ?? 30),
          enabled: body.enabled !== false,
          created_at: Date.now(),
        };
        pd.rules.push(r);
        return ok(r, 201);
      }
      const r = pd.rules.find((x) => x.id === seg[3]);
      if (!r) return fail(404, "not_found", "No such rule");
      if (method === "PATCH") {
        Object.assign(r, body);
        return ok(r);
      }
      if (method === "DELETE") {
        pd.rules = pd.rules.filter((x) => x !== r);
        return noContent;
      }
    }

    if (sub === "incidents" && method === "GET") {
      const state = q.get("state");
      const withRule = pd.incidents.map((i) => ({ ...i, rule_type: pd.rules.find((r) => r.id === i.rule_id)?.type, env: "live", attempt_id: (i as { attempt_id?: string }).attempt_id ?? null }));
      return ok(page(withRule.filter((i) => !state || i.state === state), q));
    }

    return fail(404, "not_found", "No such route");
  };
}

function emptyBucket() {
  return { payments: [], byId: new Map(), events: new Map(), recent: [] };
}

function filterPayments(all: Payment[], q: URLSearchParams): Payment[] {
  const status = q.get("status");
  const gateway = q.get("gateway");
  const term = (q.get("q") ?? "").trim().toLowerCase();
  const from = Number(q.get("from")) || 0;
  const to = Number(q.get("to")) || Infinity;
  const min = q.get("min") ? Number(q.get("min")) : null;
  const max = q.get("max") ? Number(q.get("max")) : null;
  const statuses = status === "open" ? OPEN_STATUSES : status ? status.split(",") : null;
  return all.filter(
    (p) =>
      (!statuses || statuses.includes(p.status)) &&
      (!gateway || p.gateway === gateway) &&
      p.started_at >= from &&
      p.started_at <= to &&
      (min === null || (p.amount_paisa ?? 0) >= min) &&
      (max === null || (p.amount_paisa ?? 0) <= max) &&
      (!term || p.attempt_id.toLowerCase().startsWith(term) || (p.order_id ?? "").toLowerCase().startsWith(term) || (p.provider_ref ?? "").toLowerCase().startsWith(term)),
  );
}

const NOT_PAID = new Set(["failed", "canceled", "expired"]);

function analytics(b: { payments: Payment[]; events: Map<string, StoredEvent[]> }, q: URLSearchParams): Analytics {
  const now = Date.now();
  const to = Number(q.get("to")) || now;
  const from = Number(q.get("from")) || to - DAY;
  const bucketMs = q.get("bucket") === "day" ? DAY : HOUR;
  const gw = q.get("gateway");
  const align = (t: number) => (bucketMs === DAY ? nptStartOfDay(t) : Math.floor((t + NPT_OFFSET_MS) / HOUR) * HOUR - NPT_OFFSET_MS);
  const first = align(from);
  const n = Math.max(1, Math.ceil((to - first) / bucketMs));
  const rows = Array.from({ length: n }, (_, i) => ({ t: first + i * bucketMs, started: 0, paid: 0, failed: 0, revenue_paisa: 0, lat: 0, req: 0, err: 0 }));
  const byGw = new Map<string, { started: number; paid: number; failed: number; revenue_paisa: number }>();
  const reasons = new Map<string, number>();
  const ttp: number[] = [];
  const funnel = { started: 0, redirected: 0, callback: 0, paid: 0 };

  for (const p of b.payments) {
    if (p.started_at < from || p.started_at > to) continue;
    if (gw && p.gateway !== gw) continue;
    const row = rows[Math.floor((p.started_at - first) / bucketMs)];
    if (!row) continue;
    const g = byGw.get(p.gateway) ?? { started: 0, paid: 0, failed: 0, revenue_paisa: 0 };
    byGw.set(p.gateway, g);
    row.started++;
    g.started++;
    funnel.started++;
    if (p.status === "paid") {
      row.paid++;
      g.paid++;
      row.revenue_paisa += p.amount_paisa ?? 0;
      g.revenue_paisa += p.amount_paisa ?? 0;
      if (p.finished_at) ttp.push(p.finished_at - p.started_at);
    } else if (NOT_PAID.has(p.status)) {
      row.failed++;
      g.failed++;
      const reason = p.last_reason ?? (p.status === "canceled" ? "canceled_by_buyer" : p.status);
      reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
    }
    let redirected = false;
    let callback = false;
    for (const e of b.events.get(p.attempt_id) ?? []) {
      if (e.type === "payment.redirected") redirected = true;
      if (e.type === "callback.received") callback = true;
      if (e.type === "gateway.request") {
        const r = rows[Math.floor((Date.parse(e.ts) - first) / bucketMs)];
        if (!r) continue;
        r.req++;
        r.lat += e.duration_ms ?? 0;
        if ((e.data?.http_status ?? 200) >= 500 || e.data?.reason === "timeout" || e.data?.http_status === 401) r.err++;
      }
    }
    if (redirected) funnel.redirected++;
    if (callback || p.status === "paid") funnel.callback++;
    if (p.status === "paid") funnel.paid++;
  }

  const rate = (paid: number, failed: number) => (paid + failed ? paid / (paid + failed) : null);
  const series: SeriesPoint[] = rows.map((r) => ({
    t: r.t,
    started: r.started,
    paid: r.paid,
    failed: r.failed,
    revenue_paisa: r.revenue_paisa,
    success_rate: rate(r.paid, r.failed),
    gw_latency_avg: r.req ? Math.round(r.lat / r.req) : null,
    gw_error_rate: r.req ? r.err / r.req : null,
  }));
  const totals = series.reduce((s, r) => ({ started: s.started + r.started, paid: s.paid + r.paid, failed: s.failed + r.failed, revenue_paisa: s.revenue_paisa + r.revenue_paisa }), { started: 0, paid: 0, failed: 0, revenue_paisa: 0 });
  ttp.sort((a, z) => a - z);
  const pct = (p: number) => (ttp.length ? ttp[Math.min(ttp.length - 1, Math.floor(p * ttp.length))] : null);
  return {
    series,
    totals: { ...totals, success_rate: rate(totals.paid, totals.failed) },
    by_gateway: [...byGw.entries()].map(([gateway, g]) => ({ gateway, ...g, success_rate: rate(g.paid, g.failed) })).sort((a, z) => z.started - a.started),
    failure_reasons: [...reasons.entries()].map(([reason, count]) => ({ reason, count })).sort((a, z) => z.count - a.count),
    time_to_pay_ms: { p50: pct(0.5), p95: pct(0.95) },
    funnel,
  };
}

function health(b: { recent: StoredEvent[] }): GatewayHealth[] {
  const since = Date.now() - 15 * 60_000;
  const by = new Map<string, { n: number; err: number; sum: number; max: number }>();
  for (const g of ["esewa", "khalti", "fonepay"]) by.set(g, { n: 0, err: 0, sum: 0, max: 0 });
  for (let i = b.recent.length - 1; i >= 0; i--) {
    const e = b.recent[i];
    if (Date.parse(e.ts) < since) break;
    if (e.type !== "gateway.request") continue;
    const h = by.get(e.gateway) ?? { n: 0, err: 0, sum: 0, max: 0 };
    by.set(e.gateway, h);
    h.n++;
    h.sum += e.duration_ms ?? 0;
    h.max = Math.max(h.max, e.duration_ms ?? 0);
    if ((e.data?.http_status ?? 200) >= 500 || e.data?.reason === "timeout") h.err++;
  }
  return [...by.entries()].map(([gateway, h]) => {
    const error_rate = h.n ? h.err / h.n : null;
    const latency_avg = h.n ? Math.round(h.sum / h.n) : null;
    const state: GatewayHealth["state"] = !h.n ? "idle" : (error_rate ?? 0) > 0.5 ? "down" : (error_rate ?? 0) > 0.1 || (latency_avg ?? 0) > 3000 ? "degraded" : "ok";
    return { gateway, requests: h.n, error_rate, latency_avg, latency_max: h.n ? h.max : null, state };
  });
}


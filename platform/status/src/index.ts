// status.discerns.app: public gateway status pages, the v1 status API, badges and an incident feed, all built from
// the site's own once-a-minute probes of each gateway's production API (src/probe.ts). Public, read-only, cached.
import { STATUS_SITE_NAME, type GatewayState, type StatusReport } from "@paynp/shared";
import { Hono, type Context } from "hono";
import { PROBES as PROBE_SOURCE, STATUS_GATEWAYS, loadReport } from "../../worker/src/status/aggregate.ts";
import { checkoutPlan, incidentList, statusList, summarize } from "./api.ts";
import { esc, renderDevelopers, renderGateway, renderNotFound, renderOverview, setPlatform } from "./page.ts";
import { OPENAPI } from "./openapi.ts";

/** Pages and API answers are rebuilt at most this often per location. */
const MAX_AGE = 30;

const app = new Hono<{ Bindings: Env }>();

const origin = (c: Context<{ Bindings: Env }>) => (c.env.APP_URL || new URL(c.req.url).origin).replace(/\/+$/, "");

app.use("*", async (c, next) => {
  setPlatform(c.env.PLATFORM_URL || "https://discerns.app");
  await next();
});

/** Serves from the edge cache, else builds, caches 200s, and adds Cache-Control. Keyed on the full URL. */
async function cached(c: Context<{ Bindings: Env }>, build: () => Promise<Response>): Promise<Response> {
  const cache = (globalThis as { caches?: { default?: Cache } }).caches?.default;
  const key = new Request(c.req.url, { method: "GET" });
  if (cache) {
    const hit = await cache.match(key);
    if (hit) return hit;
  }
  const res = await build();
  res.headers.set("cache-control", `public, max-age=${MAX_AGE}`);
  if (cache && res.status === 200) c.executionCtx.waitUntil(cache.put(key, res.clone()));
  return res;
}

const SECURITY = { "x-content-type-options": "nosniff", "referrer-policy": "strict-origin-when-cross-origin" };
const html = (body: string, status = 200) => new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", ...SECURITY } });
const API_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "access-control-allow-origin": "*",
  "access-control-expose-headers": "etag",
  ...SECURITY,
};

/** A weak ETag over the body, so pollers can send If-None-Match and get an empty 304. */
async function etagOf(body: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(body));
  return `W/"${[...new Uint8Array(d)].slice(0, 10).map((b) => b.toString(16).padStart(2, "0")).join("")}"`;
}

const json = async (body: unknown, status = 200) => {
  const text = JSON.stringify(body);
  return new Response(text, { status, headers: { ...API_HEADERS, ...(status === 200 ? { etag: await etagOf(text) } : {}) } });
};

/** Every API error has the same shape: { "error": { "code", "message" } }. */
const apiError = (status: number, code: string, message: string) =>
  new Response(JSON.stringify({ error: { code, message } }), { status, headers: { ...API_HEADERS, "cache-control": "no-store" } });

/** Answers 304 when the client already has this version. */
function notModified(c: Context<{ Bindings: Env }>, res: Response): Response {
  const tag = res.headers.get("etag");
  if (tag && c.req.header("if-none-match") === tag) {
    return new Response(null, { status: 304, headers: { etag: tag, "cache-control": res.headers.get("cache-control") ?? "", "access-control-allow-origin": "*" } });
  }
  return res;
}
// Checks land once a minute, so the report is as of the minute: same data, same body, same ETag. Every page and API
// route shares one build per location per minute through the edge cache; a build reads D1, the pages do not.
async function report(c: Context<{ Bindings: Env }>): Promise<StatusReport> {
  const t = Math.floor(Date.now() / 60_000) * 60_000;
  const cache = (globalThis as { caches?: { default?: Cache } }).caches?.default;
  const key = new Request(`https://status-report.internal/probes/${t}`);
  if (cache) {
    const hit = await cache.match(key);
    if (hit) return (await hit.json()) as StatusReport;
  }
  const r = await loadReport(c.env, t, PROBE_SOURCE);
  if (cache) c.executionCtx.waitUntil(cache.put(key, new Response(JSON.stringify(r), { headers: { "content-type": "application/json", "cache-control": "max-age=120" } })));
  return r;
}

// ---- API ----

app.options("/v1/*", () =>
  new Response(null, { status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, OPTIONS", "access-control-allow-headers": "if-none-match", "access-control-max-age": "86400" } }),
);

app.get("/v1/status", async (c) => notModified(c, await cached(c, async () => json(statusList(await report(c), origin(c))))));

app.get("/v1/status/:gateway", async (c) =>
  notModified(c, await cached(c, async () => {
    const r = await report(c);
    const g = r.gateways.find((x) => x.gateway === c.req.param("gateway").toLowerCase());
    if (!g) return apiError(404, "unknown_gateway", `unknown gateway; one of ${STATUS_GATEWAYS.join(", ")}`);
    return json({ generated_at: r.generated_at, ...summarize(g, origin(c)), detail: g });
  })),
);

app.get("/v1/checkout", async (c) =>
  notModified(c, await cached(c, async () => {
    const wanted = (c.req.query("gateways") ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
      .slice(0, 20);
    if (!wanted.length) return apiError(400, "missing_gateways", "pass gateways=esewa,khalti,... (comma-separated gateway ids)");
    return json(checkoutPlan(await report(c), [...new Set(wanted)], origin(c)));
  })),
);

app.get("/v1/incidents", async (c) =>
  notModified(c, await cached(c, async () => {
    const gateway = c.req.query("gateway")?.toLowerCase();
    const ongoing = c.req.query("ongoing");
    if (gateway && !STATUS_GATEWAYS.includes(gateway)) return apiError(404, "unknown_gateway", `unknown gateway; one of ${STATUS_GATEWAYS.join(", ")}`);
    if (ongoing !== undefined && ongoing !== "true" && ongoing !== "false") return apiError(400, "bad_ongoing", "ongoing must be true or false");
    const limit = Math.min(200, Math.max(1, Number(c.req.query("limit")) || 50));
    return json(incidentList(await report(c), { gateway, ongoing: ongoing === "true" ? true : ongoing === "false" ? false : undefined, limit }));
  })),
);

app.get("/v1/openapi.json", () => new Response(JSON.stringify(OPENAPI, null, 2), { headers: { ...API_HEADERS, "cache-control": "public, max-age=3600" } }));
app.all("/v1/*", (c) =>
  c.req.method === "GET" || c.req.method === "HEAD" ? apiError(404, "not_found", `no endpoint ${c.req.path}; see ${origin(c)}/v1/openapi.json`) : apiError(405, "method_not_allowed", "the status API is read-only: GET only"),
);


// The platform's old /status.json shape, for anything that already reads it.
app.get("/status.json", (c) => cached(c, async () => json(await report(c))));

// ---- Badges, feed ----


const BADGE: Record<GatewayState, [string, string]> = { operational: ["operational", "#178a4c"], degraded: ["degraded", "#a86400"], down: ["down", "#c62828"], no_data: ["no data", "#6b7280"] };

/** A flat two-part badge. Character widths are estimated (6.5 px), which is close enough for these short labels. */
function badge(label: string, value: string, color: string): string {
  const w = (s: string) => Math.round(s.length * 6.5 + 12);
  const lw = w(label);
  const vw = w(value);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${lw + vw}" height="20" role="img" aria-label="${esc(`${label}: ${value}`)}"><title>${esc(`${label}: ${value}`)}</title><rect width="${lw}" height="20" fill="#3f3f46"/><rect x="${lw}" width="${vw}" height="20" fill="${color}"/><g fill="#fff" font-family="Verdana,DejaVu Sans,sans-serif" font-size="11" text-anchor="middle"><text x="${lw / 2}" y="14">${esc(label)}</text><text x="${lw + vw / 2}" y="14">${esc(value)}</text></g></svg>`;
}

app.get("/badge/:file", (c) =>
  cached(c, async () => {
    const id = c.req.param("file").replace(/\.svg$/, "").toLowerCase();
    const g = (await report(c)).gateways.find((x) => x.gateway === id);
    if (!g) return new Response("unknown gateway", { status: 404 });
    const [value, color] = BADGE[g.state];
    return new Response(badge(g.name, value, color), { headers: { "content-type": "image/svg+xml", "access-control-allow-origin": "*", ...SECURITY } });
  }),
);

app.get("/feed.xml", (c) =>
  cached(c, async () => {
    const r = await report(c);
    const o = origin(c);
    const items = incidentList(r, { limit: 50 }).incidents;
    const iso = (t: number) => new Date(t).toISOString();
    const KIND = { errors: "errors", latency: "slow responses", errors_and_latency: "errors and slow responses" } as const;
    const entries = items
      .map((i) => {
        const title = `${i.name}: ${KIND[i.kind]}${i.ongoing ? " (ongoing)" : ` for ${i.minutes} min`}`;
        const id = `${o}/${i.gateway}#incident-${i.started_at}`;
        return `<entry><id>${esc(id)}</id><title>${esc(title)}</title><updated>${iso(i.ended_at)}</updated><published>${iso(i.started_at)}</published><link href="${esc(`${o}/${i.gateway}`)}"/><summary>${esc(`Worst minute: ${Math.round(i.peak_error_rate * 100)}% errors${i.peak_p95_ms !== null ? `, p95 ${i.peak_p95_ms} ms` : ""}.`)}</summary></entry>`;
      })
      .join("");
    const updated = iso(items[0]?.ended_at ?? r.generated_at);
    const xml = `<?xml version="1.0" encoding="utf-8"?><feed xmlns="http://www.w3.org/2005/Atom"><id>${esc(o)}/feed.xml</id><title>${esc(STATUS_SITE_NAME)}: gateway incidents</title><updated>${updated}</updated><link rel="self" href="${esc(o)}/feed.xml"/><link href="${esc(o)}/"/>${entries}</feed>`;
    return new Response(xml, { headers: { "content-type": "application/atom+xml; charset=utf-8", ...SECURITY } });
  }),
);

// ---- Site ----

const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="#0a0a0a"/><circle cx="16" cy="16" r="6" fill="#3ccf7f"/></svg>`;
app.get("/favicon.svg", () => new Response(FAVICON, { headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=86400" } }));
app.get("/robots.txt", (c) => new Response(`User-agent: *\nAllow: /\nSitemap: ${origin(c)}/sitemap.xml\n`, { headers: { "content-type": "text/plain" } }));
app.get("/sitemap.xml", (c) => {
  const o = origin(c);
  const urls = ["/", "/developers", ...STATUS_GATEWAYS.map((g) => `/${g}`)].map((p) => `<url><loc>${esc(o + p)}</loc></url>`).join("");
  return new Response(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`, { headers: { "content-type": "application/xml" } });
});

app.get("/", (c) => cached(c, async () => html(renderOverview(await report(c), origin(c)))));
app.get("/developers", (c) => cached(c, async () => html(renderDevelopers(await report(c), origin(c)))));
// Links from the platform's old /status pages.
app.get("/status", (c) => c.redirect("/", 301));
app.get("/status/:gateway", (c) => c.redirect(`/${encodeURIComponent(c.req.param("gateway"))}`, 301));
app.get("/:gateway", (c) =>
  cached(c, async () => {
    const r = await report(c);
    const id = c.req.param("gateway").toLowerCase();
    const g = r.gateways.find((x) => x.gateway === id);
    if (!g) return html(renderNotFound(r, origin(c)), 404);
    return html(renderGateway(r, g, origin(c)));
  }),
);
app.notFound(async (c) => html(renderNotFound(await report(c), origin(c)), 404));

export default app;

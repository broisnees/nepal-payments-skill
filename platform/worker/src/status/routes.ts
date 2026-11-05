// Public routes: GET /status, /status/:gateway, /status.json. No auth; cached for 60 s at the edge.
import type { Context, Hono } from "hono";
import { appOrigin, now } from "../lib/util.ts";
import type { AppEnv } from "../types.ts";
import { STATUS_GATEWAYS, loadReport } from "./aggregate.ts";
import { renderGateway, renderNotFound, renderOverview } from "./page.ts";

export const STATUS_MAX_AGE = 60;

async function cached(c: Context<AppEnv>, build: () => Promise<Response>): Promise<Response> {
  const cache = (globalThis as { caches?: { default?: Cache } }).caches?.default;
  const key = new Request(new URL(c.req.path, c.req.url).toString(), { method: "GET" });
  if (cache) {
    const hit = await cache.match(key);
    if (hit) return hit;
  }
  const res = await build();
  res.headers.set("Cache-Control", `public, max-age=${STATUS_MAX_AGE}`);
  if (cache && res.status === 200) c.executionCtx.waitUntil(cache.put(key, res.clone()));
  return res;
}

const html = (body: string, status = 200) =>
  new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", "x-content-type-options": "nosniff", "referrer-policy": "strict-origin-when-cross-origin" } });

export function registerStatus(app: Hono<AppEnv>) {
  app.get("/status.json", (c) =>
    cached(c, async () => {
      const report = await loadReport(c.env, now());
      return new Response(JSON.stringify(report), { headers: { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*" } });
    }),
  );
  app.get("/status", (c) => cached(c, async () => html(renderOverview(await loadReport(c.env, now()), appOrigin(c.env, c.req.raw)))));
  app.get("/status/", (c) => c.redirect("/status", 301));
  app.get("/status/:gateway", (c) =>
    cached(c, async () => {
      const report = await loadReport(c.env, now());
      const gw = c.req.param("gateway").toLowerCase();
      const g = report.gateways.find((x) => x.gateway === gw);
      if (!g || !STATUS_GATEWAYS.includes(gw)) return html(renderNotFound(report, appOrigin(c.env, c.req.raw)), 404);
      return html(renderGateway(report, g, appOrigin(c.env, c.req.raw)));
    }),
  );
}

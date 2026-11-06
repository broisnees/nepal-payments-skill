// Public routes: GET /status.json (cached for 60 s at the edge). The status pages moved to their own Worker on
// STATUS_SITE_URL (platform/status); /status and /status/:gateway redirect there.
import type { Context, Hono } from "hono";
import { STATUS_SITE_URL } from "@paynp/shared";
import { now } from "../lib/util.ts";
import type { AppEnv } from "../types.ts";
import { loadReport } from "./aggregate.ts";

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

export function registerStatus(app: Hono<AppEnv>) {
  app.get("/status.json", (c) =>
    cached(c, async () => {
      const report = await loadReport(c.env, now());
      return new Response(JSON.stringify(report), { headers: { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*" } });
    }),
  );
  app.get("/status", (c) => c.redirect(`${STATUS_SITE_URL}/`, 301));
  app.get("/status/", (c) => c.redirect(`${STATUS_SITE_URL}/`, 301));
  app.get("/status/:gateway", (c) => c.redirect(`${STATUS_SITE_URL}/${encodeURIComponent(c.req.param("gateway").toLowerCase())}`, 301));
}

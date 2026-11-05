// paynp Worker: public ingest (/v1), auth (/auth), REST API (/api), live stream (Durable Object), cron alerts,
// and the dashboard as static assets (everything else).
import { Hono, type ErrorHandler } from "hono";
import { registerAccount } from "./api/account.ts";
import { registerAlerts } from "./api/alerts.ts";
import { registerData } from "./api/data.ts";
import { registerFinance } from "./api/finance.ts";
import { registerOps } from "./api/ops.ts";
import { registerProjects } from "./api/projects.ts";
import { registerAuth, requireAuth } from "./auth.ts";
import { scheduled } from "./cron.ts";
import { handleIngest } from "./ingest.ts";
import { HttpError, errorBody } from "./lib/util.ts";
import { registerStatusPage } from "./ops/status-page.ts";
import { registerStatus } from "./status/routes.ts";
import type { AppEnv } from "./types.ts";

export { ProjectLive } from "./live.ts";

const app = new Hono<AppEnv>();

const onError: ErrorHandler<AppEnv> = (err, c) => {
  if (err instanceof HttpError) return c.json(errorBody(err.code, err.message), err.status);
  console.error(JSON.stringify({ msg: "unhandled error", path: c.req.path, error: String(err), stack: err instanceof Error ? err.stack : undefined }));
  return c.json(errorBody("internal", "internal error"), 500);
};
app.onError(onError);

app.post("/v1/events", handleIngest);
app.get("/v1/health", (c) => c.json({ ok: true }));

registerAuth(app);
registerStatus(app);
registerStatusPage(app);

const api = new Hono<AppEnv>();
api.onError(onError);
api.use("*", requireAuth);
registerAccount(api);
registerProjects(api);
registerData(api);
registerAlerts(api);
registerFinance(api);
registerOps(api);
api.all("*", (c) => c.json(errorBody("not_found", `no route for ${c.req.method} ${c.req.path}`), 404));
app.route("/api", api);

app.all("/v1/*", (c) => c.json(errorBody("not_found", "no such endpoint"), 404));
app.all("/auth/*", (c) => c.json(errorBody("not_found", "no such endpoint"), 404));
// Anything else is the dashboard. In production assets are served before the Worker runs; this covers dev and tests.
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default {
  fetch: app.fetch,
  scheduled,
} satisfies ExportedHandler<Env>;

export { app };

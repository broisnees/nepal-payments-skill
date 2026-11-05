// `paynp dev`: the local ingest, the subset of /api the dashboard reads, the live WebSocket and the built
// dashboard, on one port with no account and no key. node:http only.
//
// Differences from the hosted worker, on purpose:
// - /v1/events takes any key or none. A pnp_live_ key files events under "live", anything else under "test".
// - One org and one project, both "local". /api/me says {"mode": "local"}, which puts the dashboard in local mode.
// - Alerts, keys, members, sessions and tokens answer empty lists (GET) or 404; the dashboard hides those pages.
import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, normalize, sep } from "node:path";
import type { Me, Project } from "../../../shared/src/api.ts";
import { CSRF_HEADER, NAME } from "../../../shared/src/brand.ts";
import { MAX_BATCH_BYTES, MAX_BATCH_EVENTS, validateEvent, type PaymentEvent } from "../../../shared/src/events.ts";
import { syntheticEsewaTrace } from "../../../shared/src/synthetic.ts";
import { VERSION } from "../version.ts";
import { LiveHub, BACKLOG_SIZE } from "./live.ts";
import { HttpError, analytics, gatewayHealth, listEvents, listPayments, notFound, parseEnv, paymentDetail, toEvent, toPayment } from "./queries.ts";
import { DevStore, LOCAL_PROJECT, type EnvName, type IngestOutcome } from "./store.ts";

export const DEFAULT_DEV_PORT = 4040;
export const LOCAL_ORG = "local";

export interface DevServerOptions {
  port?: number;
  /** Interface to bind. Default 127.0.0.1 (plus ::1 when the machine has it). */
  host?: string;
  store: DevStore;
  /** Folder with the built dashboard (index.html + assets). Missing: a small placeholder page. */
  dashboardDir?: string | null;
  heartbeatMs?: number;
  /** Called after every accepted ingest batch, for the terminal log. */
  onIngest?: (env: EnvName, out: IngestOutcome) => void;
}

export interface DevServer {
  url: string;
  port: number;
  store: DevStore;
  hub: LiveHub;
  close(): Promise<void>;
}

const created = Date.now();
const localProject = (): Project => ({ id: LOCAL_PROJECT, org_id: LOCAL_ORG, name: "Local", slug: "local", created_at: created });
export const LOCAL_ME: Me & { mode: "local"; user: { digest: boolean } } = {
  user: { id: "local", email: "dev@localhost", name: "Local developer", digest: false },
  orgs: [{ id: LOCAL_ORG, name: "Local", role: "owner" }],
  mode: "local",
};

const json = (res: ServerResponse, status: number, body: unknown, head = false) => {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "content-length": Buffer.byteLength(text) });
  res.end(head ? undefined : text);
};
const fail = (res: ServerResponse, status: number, code: string, message: string) => json(res, status, { error: { code, message } });
const emptyPage = { items: [], next_cursor: null };

// The dashboard and its API are for this machine. A Host other than localhost means DNS rebinding or a
// request from another device; only ingest answers those.
const LOCAL_HOST = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:\d+)?$/i;

function readBody(req: IncomingMessage, max: number): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > max) over = true;
      else chunks.push(c);
    });
    req.on("end", () => resolve(over ? null : Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

const PLACEHOLDER = `<!doctype html><meta charset="utf-8"><title>${NAME} dev</title>
<body style="font:15px/1.5 system-ui;max-width:560px;margin:64px auto;padding:0 16px">
<h1 style="font-size:20px">${NAME} dev server</h1>
<p>The ingest API and /api are running, but this build has no dashboard bundled.
Build it with <code>npm run build --workspace cli</code> from <code>platform/</code>.</p>`;

export async function startDevServer(opts: DevServerOptions): Promise<DevServer> {
  const { store } = opts;
  const hub = new LiveHub(opts.heartbeatMs);
  const dash = opts.dashboardDir && existsSync(join(opts.dashboardDir, "index.html")) ? opts.dashboardDir : null;

  const ingest = (env: EnvName, events: PaymentEvent[]) => {
    const out = store.ingest(env, events);
    if (out.stored.length) hub.publish(env, out.stored.map((s) => ({ event: toEvent(s.event), payment: toPayment(s.payment) })));
    if (out.accepted) opts.onIngest?.(env, out);
    return out;
  };

  async function handleIngest(req: IncomingMessage, res: ServerResponse) {
    const auth = req.headers.authorization ?? "";
    const env: EnvName = /^Bearer\s+pnp_live_/.test(auth) ? "live" : "test";
    // JSON only: a browser cannot send this cross-origin without a preflight, which this server never approves.
    if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) return fail(res, 415, "unsupported_media_type", "send Content-Type: application/json");
    if (Number(req.headers["content-length"] ?? 0) > MAX_BATCH_BYTES) return fail(res, 413, "too_large", `body over ${MAX_BATCH_BYTES} bytes`);
    const text = await readBody(req, MAX_BATCH_BYTES);
    if (text === null) return fail(res, 413, "too_large", `body over ${MAX_BATCH_BYTES} bytes`);
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return fail(res, 400, "bad_request", "body must be JSON");
    }
    const list = (body as { events?: unknown })?.events;
    if (!Array.isArray(list)) return fail(res, 400, "bad_request", 'body must be {"events": [...]}');
    if (list.length > MAX_BATCH_EVENTS) return fail(res, 413, "too_large", `at most ${MAX_BATCH_EVENTS} events per batch`);
    const valid: PaymentEvent[] = [];
    const errors: { index: number; id?: string; error: string }[] = [];
    list.forEach((raw, index) => {
      const r = validateEvent(raw);
      if (r.ok) valid.push(r.event);
      else errors.push({ index, id: typeof (raw as { id?: unknown })?.id === "string" ? (raw as { id: string }).id : undefined, error: r.error });
    });
    const out = ingest(env, valid);
    const payload = { accepted: out.accepted, duplicates: out.duplicates };
    if (errors.length) return json(res, 400, { ...payload, errors, error: { code: "invalid_events", message: `${errors.length} invalid event(s)` } });
    return json(res, 202, payload);
  }

  function handleApi(req: IncomingMessage, res: ServerResponse, url: URL) {
    const method = req.method ?? "GET";
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const q = url.searchParams;
    if (method !== "GET" && method !== "HEAD" && req.headers[CSRF_HEADER.toLowerCase()] !== "1") return fail(res, 403, "csrf", `missing ${CSRF_HEADER} header`);
    const get = method === "GET" || method === "HEAD";
    const head = method === "HEAD";

    if (get && path === "/api/mode") return json(res, 200, { mode: "local", version: VERSION, storage: store.kind, project: LOCAL_PROJECT }, head);
    if (get && path === "/api/me") return json(res, 200, LOCAL_ME, head);
    if (get && (path === "/api/sessions" || path === "/api/pats")) return json(res, 200, emptyPage, head);

    let m = /^\/api\/orgs\/([^/]+)(\/.*)?$/.exec(path);
    if (m) {
      if (m[1] !== LOCAL_ORG) throw notFound("org");
      if (get && m[2] === "/projects") return json(res, 200, { items: [localProject()], next_cursor: null }, head);
      if (get && (m[2] === "/members" || m[2] === "/invites")) return json(res, 200, emptyPage, head);
      throw notFound("route");
    }

    m = /^\/api\/projects\/([^/]+)(\/.*)?$/.exec(path);
    if (!m) throw notFound("route");
    if (decodeURIComponent(m[1]) !== LOCAL_PROJECT) throw notFound("project");
    const rest = m[2] ?? "";
    if (get && rest === "") return json(res, 200, { ...localProject(), role: "owner" }, head);
    if (get && rest === "/payments") return json(res, 200, listPayments(store, q), head);
    const pm = /^\/payments\/([^/]+)$/.exec(rest);
    if (get && pm) return json(res, 200, paymentDetail(store, decodeURIComponent(pm[1]), q), head);
    if (get && rest === "/events") return json(res, 200, listEvents(store, q), head);
    if (get && rest === "/analytics") return json(res, 200, analytics(store, q), head);
    if (get && rest === "/health") return json(res, 200, { items: gatewayHealth(store, parseEnv(q.get("env"))), next_cursor: null }, head);
    if (get && rest === "/live") return fail(res, 400, "upgrade_required", "expected a WebSocket upgrade");
    if (get && ["/incidents", "/rules", "/channels", "/keys"].includes(rest)) return json(res, 200, emptyPage, head);
    if (method === "POST" && rest === "/test-payment") {
      const t = Date.now();
      const events = syntheticEsewaTrace(t, { name: "paynp-dashboard", version: VERSION, lang: "ts" });
      const out = ingest("test", events);
      return json(res, 201, { attempt_id: events[0].attempt_id, env: "test", accepted: out.accepted });
    }
    throw notFound("route");
  }

  function serveStatic(req: IncomingMessage, res: ServerResponse, url: URL) {
    const head = req.method === "HEAD";
    if (req.method !== "GET" && !head) return fail(res, 405, "method_not_allowed", "GET only");
    if (!dash) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(head ? undefined : PLACEHOLDER);
    }
    let rel: string;
    try {
      rel = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, "");
    } catch {
      rel = "";
    }
    let file = join(dash, rel);
    const inside = file === dash || file.startsWith(dash + sep);
    let isFile = false;
    try {
      isFile = inside && statSync(file).isFile();
    } catch {
      isFile = false;
    }
    // SPA fallback: any path that is not a file (and does not look like one) is the app.
    if (!isFile) {
      if (extname(rel) && rel !== "index.html") return fail(res, 404, "not_found", "no such file");
      file = join(dash, "index.html");
    }
    const body = readFileSync(file);
    const immutable = rel.startsWith("assets/") && isFile;
    res.writeHead(200, {
      "content-type": TYPES[extname(file)] ?? "application/octet-stream",
      "content-length": body.length,
      "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
    });
    res.end(head ? undefined : body);
  }

  const handler = (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const p = url.pathname;
    const run = async () => {
      if (p === "/v1/health" && (req.method === "GET" || req.method === "HEAD")) {
        return json(res, 200, { ok: true, mode: "local", name: NAME, version: VERSION }, req.method === "HEAD");
      }
      if (p === "/v1/events") {
        if (req.method !== "POST") return fail(res, 405, "method_not_allowed", "POST only");
        return handleIngest(req, res);
      }
      if (p.startsWith("/v1/")) return fail(res, 404, "not_found", "no such endpoint");
      if (!LOCAL_HOST.test(req.headers.host ?? "")) return fail(res, 403, "forbidden", "the local dashboard answers on localhost only");
      if (p === "/api" || p.startsWith("/api/")) return handleApi(req, res, url);
      if (p.startsWith("/auth/")) {
        if (p === "/auth/logout" && req.method === "POST") return void res.writeHead(204).end();
        return fail(res, 404, "not_found", "no sign-in on the local dev server");
      }
      return serveStatic(req, res, url);
    };
    run().catch((err: unknown) => {
      if (res.headersSent) return void res.end();
      if (err instanceof HttpError) return fail(res, err.status, err.code, err.message);
      fail(res, 500, "internal", String((err as Error)?.message ?? err));
    });
  };

  const upgrade = (req: IncomingMessage, socket: import("node:stream").Duplex) => {
    socket.on("error", () => {});
    const url = new URL(req.url ?? "/", "http://localhost");
    const m = /^\/api\/projects\/([^/]+)\/live$/.exec(url.pathname);
    if (!m || decodeURIComponent(m[1]) !== LOCAL_PROJECT || !LOCAL_HOST.test(req.headers.host ?? "")) {
      return void socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
    }
    let env: EnvName;
    try {
      env = parseEnv(url.searchParams.get("env"));
    } catch {
      return void socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    }
    const backlog = store
      .eventsOf(env)
      .sort((a, b) => b.ts - a.ts || (a.id < b.id ? 1 : -1))
      .slice(0, BACKLOG_SIZE)
      .reverse()
      .map(toEvent);
    hub.accept(req, socket, env, backlog);
  };

  const servers: Server[] = [];
  const listen = (host: string, port: number) =>
    new Promise<Server>((resolve, reject) => {
      const s = createServer(handler);
      s.on("upgrade", upgrade);
      s.once("error", reject);
      s.listen(port, host, () => {
        s.off("error", reject);
        resolve(s);
      });
    });

  const host = opts.host ?? "127.0.0.1";
  const first = await listen(host, opts.port ?? DEFAULT_DEV_PORT);
  servers.push(first);
  const port = (first.address() as AddressInfo).port;
  // "localhost" resolves to ::1 first on some machines; answer there too when it exists.
  if (!opts.host) {
    try {
      servers.push(await listen("::1", port));
    } catch {
      // no IPv6 loopback, or the port is taken there: 127.0.0.1 is enough
    }
  }

  return {
    url: `http://localhost:${port}`,
    port,
    store,
    hub,
    async close() {
      hub.close();
      await Promise.all(
        servers.map(
          (s) =>
            new Promise<void>((r) => {
              s.close(() => r());
              s.closeAllConnections?.();
            }),
        ),
      );
      store.close();
    },
  };
}

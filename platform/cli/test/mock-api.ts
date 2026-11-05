// Just the endpoints the CLI calls, as SPEC sections 3, 5, 6 and 7 describe them.
import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { validateEvent, type PaymentEvent } from "../../shared/src/events.ts";
import { frame, parseFrames } from "../src/ws.ts";

const b62 = (n: number) => {
  const a = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from(randomBytes(n), (b) => a[b % 62]).join("");
};

export interface MockState {
  pendingPolls: number; // 428 answers before a device code is approved
  devicePolls: { device_code: string }[];
  pats: Map<string, { id: string; revoked: boolean }>;
  orgs: { id: string; name: string; role: "owner" | "admin" | "viewer" }[];
  projects: { id: string; org_id: string; name: string; slug: string; created_at: number }[];
  keys: { id: string; project_id: string; env: "test" | "live"; key: string; name: string | null; created_at: number; revoked_at: number | null }[];
  events: (PaymentEvent & { project_id: string; env: string })[];
  invalid: string[];
  csrfMissing: string[];
  liveAuth: string[];
  /** GET /api/projects/:p/doctor answers, keyed "project|env" (SPEC-v2 4.4). Missing: 404 like a server without v2. */
  doctor: Record<string, unknown>;
  doctorRequests: string[];
}

export interface MockApi {
  url: string;
  state: MockState;
  close(): Promise<void>;
}

export async function startMockApi(opts: { verificationOrigin?: string } = {}): Promise<MockApi> {
  const state: MockState = {
    pendingPolls: 2,
    devicePolls: [],
    pats: new Map(),
    orgs: [{ id: "org_1", name: "Acme Traders", role: "owner" }],
    projects: [{ id: "prj_existing", org_id: "org_1", name: "Storefront", slug: "storefront", created_at: Date.now() }],
    keys: [],
    events: [],
    invalid: [],
    csrfMissing: [],
    liveAuth: [],
    doctor: {},
    doctorRequests: [],
  };
  const devices = new Map<string, { user_code: string; polls: number }>();
  const sockets = new Set<{ project: string; env: string; sock: Duplex }>();
  let url = "";

  const json = (res: ServerResponse, status: number, body?: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(body === undefined ? "" : JSON.stringify(body));
  };
  const err = (res: ServerResponse, status: number, code: string, message: string) => json(res, status, { error: { code, message } });
  const readBody = (req: IncomingMessage) =>
    new Promise<any>((resolve) => {
      let s = "";
      req.on("data", (c) => (s += c));
      req.on("end", () => {
        try {
          resolve(s ? JSON.parse(s) : {});
        } catch {
          resolve(null);
        }
      });
    });
  const patOf = (req: IncomingMessage) => {
    const h = req.headers.authorization ?? "";
    const t = h.startsWith("Bearer ") ? h.slice(7) : "";
    const p = state.pats.get(t);
    return p && !p.revoked ? { token: t, ...p } : null;
  };
  const page = <T>(items: T[]) => ({ items, next_cursor: null });

  const server = createServer(async (req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    const path = u.pathname;
    const m = (re: RegExp) => re.exec(`${req.method} ${path}`);
    let g: RegExpExecArray | null;

    // ---- ingest
    if (req.method === "POST" && path === "/v1/events") {
      const key = state.keys.find((k) => `Bearer ${k.key}` === req.headers.authorization && !k.revoked_at);
      if (!key) return err(res, 401, "unauthorized", "bad key");
      const body = await readBody(req);
      let accepted = 0;
      for (const e of body?.events ?? []) {
        const r = validateEvent(e);
        if (!r.ok) {
          state.invalid.push(r.error);
          continue;
        }
        accepted++;
        const stored = { ...r.event, received_at: Date.now() };
        state.events.push({ ...stored, project_id: key.project_id, env: key.env });
        for (const s of sockets) {
          if (s.project === key.project_id && s.env === key.env) s.sock.write(frame(0x1, Buffer.from(JSON.stringify({ kind: "event", event: stored, payment: { attempt_id: stored.attempt_id } })), false));
        }
      }
      return json(res, 202, { accepted, duplicates: 0 });
    }

    // ---- device login
    if (m(/^POST \/auth\/device$/)) {
      const device_code = b62(32);
      const user_code = `${b62(4).toUpperCase()}-${b62(4).toUpperCase()}`;
      devices.set(device_code, { user_code, polls: 0 });
      return json(res, 200, { device_code, user_code, verification_url: `${opts.verificationOrigin ?? url}/device?code=${user_code}`, interval: 0.02, expires_in: 600 });
    }
    if (m(/^POST \/auth\/device\/token$/)) {
      const body = await readBody(req);
      state.devicePolls.push(body);
      const d = devices.get(body?.device_code);
      if (!d) return json(res, 400, { error: "expired_token" });
      if (d.polls++ < state.pendingPolls) return json(res, 428, { error: "authorization_pending" });
      devices.delete(body.device_code);
      const token = `pnp_pat_${b62(32)}`;
      state.pats.set(token, { id: `pat_${state.pats.size + 1}`, revoked: false });
      return json(res, 200, { token });
    }
    if (m(/^POST \/auth\/logout$/)) {
      const p = patOf(req);
      if (p) state.pats.get(p.token)!.revoked = true;
      return json(res, 204);
    }

    // ---- /api: PAT auth, CSRF header on state changes
    if (path.startsWith("/api/")) {
      const pat = patOf(req);
      if (!pat) return err(res, 401, "unauthorized", "unknown or revoked token");
      if (req.method !== "GET" && req.headers["x-paynp-csrf"] !== "1") {
        state.csrfMissing.push(`${req.method} ${path}`);
        return err(res, 403, "csrf", "missing X-Paynp-CSRF");
      }
      if (m(/^GET \/api\/me$/)) return json(res, 200, { user: { id: "usr_1", email: "owner@shop.np", name: null }, orgs: state.orgs });
      if (m(/^GET \/api\/pats$/)) {
        const items = [...state.pats.entries()].filter(([, p]) => !p.revoked).map(([t, p]) => ({ id: p.id, name: null, created_at: 0, last_used_at: null, current: t === pat.token }));
        return json(res, 200, page(items));
      }
      if ((g = m(/^DELETE \/api\/pats\/([^/]+)$/))) {
        const entry = [...state.pats.values()].find((p) => p.id === g![1] && !p.revoked);
        if (!entry) return err(res, 404, "not_found", "token not found");
        entry.revoked = true;
        return json(res, 204);
      }
      if ((g = m(/^GET \/api\/orgs\/([^/]+)\/projects$/))) return json(res, 200, page(state.projects.filter((p) => p.org_id === g![1])));
      if ((g = m(/^POST \/api\/orgs\/([^/]+)\/projects$/))) {
        const body = await readBody(req);
        if (typeof body?.name !== "string" || !body.name) return err(res, 400, "invalid", "name required");
        const p = { id: `prj_${b62(8)}`, org_id: g[1], name: body.name, slug: body.name.toLowerCase().replace(/[^a-z0-9]+/g, "-"), created_at: Date.now() };
        state.projects.push(p);
        return json(res, 201, p);
      }
      const project = (id: string) => state.projects.find((p) => p.id === id);
      if ((g = m(/^GET \/api\/projects\/([^/]+)\/keys$/))) {
        if (!project(g[1])) return err(res, 404, "not_found", "project not found");
        return json(res, 200, page(state.keys.filter((k) => k.project_id === g![1]).map(({ key, project_id, ...k }) => ({ ...k, prefix: key.slice(0, 13), last_used_at: null }))));
      }
      if ((g = m(/^POST \/api\/projects\/([^/]+)\/keys$/))) {
        if (!project(g[1])) return err(res, 404, "not_found", "project not found");
        const body = await readBody(req);
        if (body?.env !== "test" && body?.env !== "live") return err(res, 400, "invalid", "env must be test or live");
        const k = { id: `key_${b62(8)}`, project_id: g[1], env: body.env, key: `pnp_${body.env}_${b62(32)}`, name: body.name ?? null, created_at: Date.now(), revoked_at: null };
        state.keys.push(k);
        const { project_id, ...rest } = k;
        return json(res, 201, { ...rest, prefix: k.key.slice(0, 13), last_used_at: null });
      }
      if ((g = m(/^GET \/api\/projects\/([^/]+)\/doctor$/))) {
        const env = u.searchParams.get("env") ?? "test";
        state.doctorRequests.push(`${g[1]}|${env}`);
        if (!project(g[1])) return err(res, 404, "not_found", "project not found");
        const r = state.doctor[`${g[1]}|${env}`];
        return r === undefined ? err(res, 404, "not_found", `${req.method} ${path}`) : json(res, 200, r);
      }
      if ((g = m(/^DELETE \/api\/projects\/([^/]+)\/keys\/([^/]+)$/))) {
        const k = state.keys.find((x) => x.project_id === g![1] && x.id === g![2] && !x.revoked_at);
        if (!k) return err(res, 404, "not_found", "key not found");
        k.revoked_at = Date.now();
        return json(res, 204);
      }
      return err(res, 404, "not_found", `${req.method} ${path}`);
    }
    err(res, 404, "not_found", path);
  });

  // ---- live WebSocket: GET /api/projects/:p/live?env=
  server.on("upgrade", (req, sock: Duplex) => {
    const u = new URL(req.url ?? "/", "http://x");
    const g = /^\/api\/projects\/([^/]+)\/live$/.exec(u.pathname);
    state.liveAuth.push(req.headers.authorization ?? "");
    const refuse = (code: number) => sock.end(`HTTP/1.1 ${code} No\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}`);
    if (!g) return refuse(404);
    if (!patOf(req)) return refuse(401);
    const accept = createHash("sha1").update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const entry = { project: g[1], env: u.searchParams.get("env") ?? "test", sock };
    sockets.add(entry);
    const backlog = state.events.filter((e) => e.project_id === entry.project && e.env === entry.env).slice(-200);
    sock.write(frame(0x1, Buffer.from(JSON.stringify({ kind: "backlog", events: backlog })), false));
    sock.write(frame(0x1, Buffer.from(JSON.stringify({ kind: "ping" })), false));
    let buf = Buffer.alloc(0);
    sock.on("data", (c: Buffer) => {
      buf = Buffer.concat([buf, c]);
      const { frames, rest } = parseFrames(buf);
      buf = Buffer.from(rest);
      for (const f of frames) if (f.opcode === 0x8) sock.end(frame(0x8, f.payload.subarray(0, 2), false));
    });
    sock.on("close", () => sockets.delete(entry));
    sock.on("error", () => sockets.delete(entry));
  });

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    state,
    close: () =>
      new Promise<void>((r) => {
        for (const s of sockets) s.sock.destroy();
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  };
}

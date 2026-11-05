// Mock mode (VITE_MOCK=1): answers /api, /auth and /v1 in the browser and fakes the live WebSocket,
// so the dashboard runs with no backend. Never part of a normal build.
import { createDb } from "./db.ts";
import { createHub } from "./hub.ts";
import { createServer } from "./server.ts";

export function installMock() {
  const db = createDb();
  const hub = createHub(db);
  const handle = createServer(db, hub);
  const realFetch = window.fetch.bind(window);

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const url = new URL(req.url, location.href);
    if (url.origin !== location.origin || !/^\/(api|auth|v1)\//.test(url.pathname)) return realFetch(input, init);
    const text = await req.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = undefined;
    }
    // A little latency so loading states are real, not instant.
    await new Promise((r) => setTimeout(r, 60 + Math.random() * 140));
    const res = await handle({ method: req.method.toUpperCase(), path: url.pathname, query: url.searchParams, body, headers: req.headers });
    if (res.status === 204) return new Response(null, { status: 204 });
    return new Response(JSON.stringify(res.body ?? null), { status: res.status, headers: { "content-type": "application/json" } });
  };

  const RealWS = window.WebSocket;
  class MockSocket extends EventTarget {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    readyState = 0;
    onopen: ((e: Event) => void) | null = null;
    onmessage: ((e: MessageEvent) => void) | null = null;
    onclose: ((e: CloseEvent) => void) | null = null;
    onerror: ((e: Event) => void) | null = null;
    private off: (() => void) | null = null;

    constructor(readonly url: string) {
      super();
      const u = new URL(url);
      const m = u.pathname.match(/^\/api\/projects\/([^/]+)\/live$/);
      const env = u.searchParams.get("env") === "test" ? "test" : "live";
      setTimeout(() => {
        if (this.readyState !== 0) return;
        if (!m || !db.signedIn) return this.finish(1008);
        this.readyState = 1;
        this.fire("open", new Event("open"));
        this.deliver({ kind: "backlog", events: hub.backlog(m[1], env) });
        this.off = hub.subscribe(m[1], env, (msg) => this.deliver(msg));
      }, 120);
    }
    private deliver(msg: unknown) {
      if (this.readyState === 1) this.fire("message", new MessageEvent("message", { data: JSON.stringify(msg) }));
    }
    private fire(type: "open" | "message" | "close", ev: Event) {
      this.dispatchEvent(ev);
      const h = this[`on${type}`] as ((e: Event) => void) | null;
      h?.(ev);
    }
    private finish(code: number) {
      this.off?.();
      this.readyState = 3;
      this.fire("close", new CloseEvent("close", { code }));
    }
    send() {}
    close() {
      if (this.readyState < 2) this.finish(1000);
    }
  }

  window.WebSocket = new Proxy(RealWS, {
    construct(target, args: [string | URL, (string | string[])?]) {
      const url = new URL(String(args[0]), location.href);
      if (url.pathname.startsWith("/api/")) return new MockSocket(url.href) as unknown as WebSocket;
      return new target(...args);
    },
  });
}

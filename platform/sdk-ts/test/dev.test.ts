// No key outside production: events go to a running `paynp dev` server, found with one cached probe of
// /v1/health. No key in production: nothing at all. With a key: exactly the old behavior.
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEV_URL, devTarget } from "../src/client.ts";
import { createPaynp } from "../src/index.ts";
import type { PaymentEvent } from "../src/shared.ts";
import { TEST_KEY, startIngest, type MockIngest } from "./ingest.ts";

interface FakeDev {
  url: string;
  health: number;
  posts: { headers: IncomingHttpHeaders; events: PaymentEvent[] }[];
  close(): Promise<void>;
}

/** Answers like `paynp dev`, or like the hosted worker (`{"ok": true}` with no mode), or slowly. */
async function fakeDev(kind: "local" | "hosted" | "slow" = "local"): Promise<FakeDev> {
  const out = { health: 0, posts: [] as FakeDev["posts"] };
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      if (req.url === "/v1/health") {
        out.health++;
        const body = JSON.stringify(kind === "hosted" ? { ok: true } : { ok: true, mode: "local" });
        const send = () => res.writeHead(200, { "content-type": "application/json" }).end(body);
        return kind === "slow" ? void setTimeout(send, 2000) : send();
      }
      if (req.url === "/v1/events" && req.method === "POST") {
        out.posts.push({ headers: req.headers, events: JSON.parse(Buffer.concat(chunks).toString()).events });
        return void res.writeHead(202, { "content-type": "application/json" }).end('{"accepted":1,"duplicates":0}');
      }
      res.writeHead(404).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    get health() {
      return out.health;
    },
    posts: out.posts,
    close: () => new Promise<void>((r) => (server.closeAllConnections(), server.close(() => r()))),
  };
}

/** A port nothing listens on. */
async function deadUrl(): Promise<string> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address() as AddressInfo;
  await new Promise<void>((r) => s.close(() => r()));
  return `http://127.0.0.1:${port}`;
}

const record = (paynp: ReturnType<typeof createPaynp>, id = "att_dev_1") =>
  paynp.statusChanged({ attemptId: id, gateway: "esewa", from: "initiated", to: "pending" });

let dev: FakeDev | undefined;
let ingest: MockIngest | undefined;
afterEach(async () => {
  await dev?.close();
  await ingest?.close();
  dev = ingest = undefined;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("where events go without a key", () => {
  it("defaults to http://localhost:4040 outside production", () => {
    vi.stubEnv("NODE_ENV", "development");
    for (const k of ["PAYNP_DEV_URL", "PAYNP_ENDPOINT", "PAYNP_DEV", "PAYNP_ENV"]) vi.stubEnv(k, "");
    expect(DEV_URL).toBe("http://localhost:4040");
    expect(devTarget({})).toBe("http://localhost:4040");
    vi.stubEnv("NODE_ENV", "");
    expect(devTarget({})).toBe("http://localhost:4040"); // unset NODE_ENV counts as development
  });

  it("takes dev, then endpoint, then PAYNP_DEV_URL, then PAYNP_ENDPOINT", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("PAYNP_ENDPOINT", "http://localhost:9000/");
    expect(devTarget({})).toBe("http://localhost:9000");
    vi.stubEnv("PAYNP_DEV_URL", "http://localhost:5050");
    expect(devTarget({})).toBe("http://localhost:5050");
    expect(devTarget({ endpoint: "http://127.0.0.1:7/" })).toBe("http://127.0.0.1:7");
    expect(devTarget({ dev: "http://h:1", endpoint: "http://127.0.0.1:7" })).toBe("http://h:1");
  });

  it("is off in production, with PAYNP_DEV=0, with dev: false", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(devTarget({})).toBeNull();
    expect(devTarget({ dev: "http://localhost:4040" })).toBeNull();
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("PAYNP_ENV", "production");
    expect(devTarget({})).toBeNull();
    vi.stubEnv("PAYNP_ENV", "");
    vi.stubEnv("PAYNP_DEV", "0");
    expect(devTarget({})).toBeNull();
    vi.stubEnv("PAYNP_DEV", "");
    expect(devTarget({ dev: false })).toBeNull();
  });

  it("is off on Cloudflare Workers unless a URL is given", () => {
    vi.stubEnv("NODE_ENV", "");
    vi.stubEnv("PAYNP_DEV_URL", "");
    vi.stubGlobal("navigator", { userAgent: "Cloudflare-Workers" });
    try {
      expect(devTarget({})).toBeNull();
      expect(devTarget({ dev: "http://localhost:4040" })).toBe("http://localhost:4040");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("dev server running", () => {
  it("sends there with no Authorization header, after one probe", async () => {
    dev = await fakeDev();
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("PAYNP_DEV_URL", dev.url);
    const paynp = createPaynp({ flushIntervalMs: 10_000 });
    expect(paynp.enabled).toBe(true);
    record(paynp, "a1");
    await paynp.flush();
    record(paynp, "a2");
    await paynp.flush();
    expect(dev.health).toBe(1); // cached
    expect(dev.posts.map((p) => p.events[0].attempt_id)).toEqual(["a1", "a2"]);
    expect(dev.posts[0].headers.authorization).toBeUndefined();
    expect(dev.posts[0].events[0]).toMatchObject({ type: "status.changed", status: "pending", sdk: { name: "@paynp/sdk" } });
  });

  it("wrapGateway reports through it", async () => {
    dev = await fakeDev();
    const paynp = createPaynp({ dev: dev.url, flushIntervalMs: 10_000 });
    const mod = { startPayment: async (i: { attemptId: string; amountPaisa: number }) => ({ type: "redirect" as const, url: `https://rc-epay.esewa.com.np/x?a=${i.attemptId}` }) };
    const gw = paynp.wrapGateway("esewa", mod);
    expect(gw).not.toBe(mod);
    await gw.startPayment({ attemptId: "w1", amountPaisa: 10000 });
    await paynp.flush();
    expect(dev.posts.flatMap((p) => p.events.map((e) => e.type))).toEqual(["payment.started", "payment.redirected"]);
  });
});

describe("no dev server", () => {
  it("drops quietly: no warning, no error callback, one probe per 30 s", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let calls = 0;
    const url = await deadUrl();
    const paynp = createPaynp({ dev: url, flushIntervalMs: 10_000, fetch: (i, init) => (calls++, fetch(i, init)) });
    for (let i = 0; i < 3; i++) {
      record(paynp, `x${i}`);
      await paynp.flush();
    }
    expect(paynp.queued).toBe(0);
    expect(calls).toBe(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it("a slow port never holds up a flush for more than the probe timeout", async () => {
    dev = await fakeDev("slow");
    const paynp = createPaynp({ dev: dev.url, flushIntervalMs: 10_000 });
    const t = Date.now();
    record(paynp); // returns at once: recording never waits on the network
    expect(Date.now() - t).toBeLessThan(50);
    await paynp.flush();
    expect(Date.now() - t).toBeLessThan(1500);
    expect(dev.posts).toEqual([]);
  });

  it("a hosted endpoint is not mistaken for the dev server", async () => {
    dev = await fakeDev("hosted");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const paynp = createPaynp({ endpoint: dev.url, flushIntervalMs: 10_000 });
    record(paynp);
    await paynp.flush();
    expect(dev.health).toBe(1);
    expect(dev.posts).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("production, no key", () => {
  it("is a strict no-op: nothing wrapped, no fetch at all", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PAYNP_DEV_URL", "http://127.0.0.1:1");
    const spy = vi.fn(fetch);
    const paynp = createPaynp({ fetch: spy });
    expect(paynp.enabled).toBe(false);
    const mod = { startPayment: async () => ({}) };
    expect(paynp.wrapGateway("esewa", mod)).toBe(mod);
    record(paynp);
    await paynp.flush();
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("with a key", () => {
  it("sends to the endpoint with the key, never probes, even with a dev server configured", async () => {
    ingest = await startIngest();
    dev = await fakeDev();
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("PAYNP_DEV_URL", dev.url);
    const paynp = createPaynp({ key: TEST_KEY, endpoint: ingest.url, flushIntervalMs: 10_000 });
    record(paynp);
    await paynp.flush();
    expect(ingest.events).toHaveLength(1);
    expect(ingest.requests[0].headers.authorization).toBe(`Bearer ${TEST_KEY}`);
    expect(dev.health).toBe(0);
    expect(dev.posts).toEqual([]);
  });
});

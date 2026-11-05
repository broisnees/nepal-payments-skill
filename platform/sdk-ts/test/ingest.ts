// A local stand-in for POST /v1/events (SPEC section 3). Validates every event with the shared
// validator, records requests, and answers with whatever status the test queues up.
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { validateEvent, type PaymentEvent } from "../../shared/src/events.ts";

export interface IngestRequest {
  headers: IncomingHttpHeaders;
  events: PaymentEvent[];
  bytes: number;
}

export interface MockIngest {
  url: string;
  requests: IngestRequest[];
  events: PaymentEvent[];
  invalid: { event: unknown; error: string }[];
  /** Queue answers for the next requests: a status code, or [status, headers]. Default 202. */
  answer(...codes: (number | [number, Record<string, string>])[]): void;
  waitFor(n: number, timeoutMs?: number): Promise<PaymentEvent[]>;
  close(): Promise<void>;
}

export async function startIngest(): Promise<MockIngest> {
  const requests: IngestRequest[] = [];
  const events: PaymentEvent[] = [];
  const invalid: MockIngest["invalid"] = [];
  const answers: (number | [number, Record<string, string>])[] = [];

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      if (req.method !== "POST" || req.url !== "/v1/events") return void res.writeHead(404).end();
      const next = answers.shift() ?? 202;
      const [code, headers] = Array.isArray(next) ? next : [next, {}];
      const body = JSON.parse(raw.toString("utf8")) as { events: PaymentEvent[] };
      requests.push({ headers: req.headers, events: body.events, bytes: raw.length });
      if (code !== 202) return void res.writeHead(code, { "content-type": "application/json", ...headers }).end('{"error":{"code":"x","message":"x"}}');
      if (!/^Bearer pnp_(test|live)_/.test(req.headers.authorization ?? "")) return void res.writeHead(401).end();
      for (const e of body.events) {
        const r = validateEvent(e);
        if (r.ok) events.push(e);
        else invalid.push({ event: e, error: r.error });
      }
      res.writeHead(202, { "content-type": "application/json" }).end(JSON.stringify({ accepted: body.events.length, duplicates: 0 }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    events,
    invalid,
    answer: (...codes) => void answers.push(...codes),
    async waitFor(n, timeoutMs = 5000) {
      const end = Date.now() + timeoutMs;
      while (events.length < n) {
        if (Date.now() > end) throw new Error(`waited for ${n} events, got ${events.length}`);
        await new Promise((r) => setTimeout(r, 10));
      }
      return events;
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

/** Events in the order a timeline would show them. */
export const byTime = (events: PaymentEvent[]) => [...events].sort((a, b) => a.ts.localeCompare(b.ts) || a.id.localeCompare(b.id));
export const types = (events: PaymentEvent[]) => byTime(events).map((e) => e.type);

export const TEST_KEY = "pnp_test_0123456789abcdefghijklmnopqrstuv";

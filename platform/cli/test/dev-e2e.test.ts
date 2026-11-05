// End to end, no account and no key: `paynp dev` (the built CLI, as a child process), the blog's Express app with
// the real eSewa module wrapped by @paynp/sdk and NO PAYNP_KEY, a real start against eSewa's sandbox and a signed
// return that makes the module call the real status API. The events must show up in the local API and on the
// live WebSocket.
//
// Needs network and a folder with express and tsx installed:
//   PAYNP_E2E_DEPS=/path/with/node_modules npx vitest run test/dev-e2e.test.ts
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LiveMessage, PaymentDetail } from "../../shared/src/api.ts";
import { esewa as esewaBlog } from "../../../website/src/data/blog-code/esewa.ts";
import { reconcile, routes, store, types } from "../../../website/src/data/blog-code/shared/ts.ts";

const DEPS = process.env.PAYNP_E2E_DEPS;
const root = join(import.meta.dirname, "..");
const app = join(import.meta.dirname, ".generated", "e2e-shop");
const sdkSrc = join(root, "..", "sdk-ts", "src", "index.ts");
const SECRET = "8gBm/:&EnhH.1/q"; // eSewa's public sandbox secret

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });
const portFree = (port: number) =>
  new Promise<boolean>((resolve) => {
    const s = createServer();
    s.once("error", () => resolve(false));
    s.listen(port, "127.0.0.1", () => s.close(() => resolve(true)));
  });

async function waitFor<T>(fn: () => Promise<T | undefined> | T | undefined, ms: number, what: string): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    try {
      const v = await fn();
      if (v !== undefined && v !== null && v !== false) return v;
    } catch {
      // not yet
    }
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

function assemble(): void {
  rmSync(app, { recursive: true, force: true });
  mkdirSync(join(app, "node_modules"), { recursive: true });
  const g = { id: "esewa", name: "eSewa", ts: "esewa", py: "esewa", php: "EsewaGateway", go: "NewEsewa", java: "EsewaGateway", kotlin: "EsewaGateway" };
  const blocks = [types, store, reconcile, ...routes(g as never).express];
  for (const b of blocks) writeFileSync(join(app, b.file), b.code);
  const e = esewaBlog.ts;
  writeFileSync(join(app, e.file), (["config", "sign", "start", "confirm"] as const).map((p) => e.parts[p]).join("\n\n") + "\n");
  // The wiring from the SDK README, with no key at all.
  writeFileSync(
    join(app, "paynp.ts"),
    `import { createPaynp } from ${JSON.stringify(sdkSrc)};\nimport * as esewa from "./esewa";\n\nexport const paynp = createPaynp({ key: process.env.PAYNP_KEY });\nexport const gateway = paynp.wrapGateway("esewa", esewa);\n`,
  );
  const server = join(app, "server.ts");
  const src = blocks.find((b) => b.file === "server.ts")!.code;
  if (!src.includes('import * as gateway from "./esewa";')) throw new Error("server.ts changed shape");
  writeFileSync(server, src.replace('import * as gateway from "./esewa";', 'import { gateway } from "./paynp";'));
  writeFileSync(join(app, "package.json"), JSON.stringify({ name: "e2e-shop", private: true }));
  for (const name of readdirSync(join(DEPS!, "node_modules"))) symlinkSync(join(DEPS!, "node_modules", name), join(app, "node_modules", name));
}

const children: ChildProcess[] = [];
function start(cmd: string, args: string[], env: Record<string, string | undefined>, cwd: string, log: string[]): ChildProcess {
  const c = spawn(cmd, args, { cwd, env: env as NodeJS.ProcessEnv, stdio: ["ignore", "pipe", "pipe"] });
  c.stdout!.on("data", (d) => log.push(String(d)));
  c.stderr!.on("data", (d) => log.push(String(d)));
  children.push(c);
  return c;
}

describe.skipIf(!DEPS || process.env.PAYNP_SKIP_SANDBOX === "1")("paynp dev, end to end with the blog's Express app and eSewa's sandbox", () => {
  let devUrl: string;
  let shopUrl: string;
  const devLog: string[] = [];
  const shopLog: string[] = [];
  const live: LiveMessage[] = [];
  let ws: WebSocket;

  beforeAll(async () => {
    if (!existsSync(join(root, "dist", "paynp.js"))) throw new Error("build the CLI first: npm run build");
    assemble();
    // The real default when it is free, so the SDK finds the server with no configuration at all.
    const useDefault = await portFree(4040);
    const devPort = useDefault ? 4040 : await freePort();
    devUrl = `http://localhost:${devPort}`;
    const devCwd = join(app, "dev-cwd");
    mkdirSync(devCwd, { recursive: true });
    start(process.execPath, [join(root, "dist", "paynp.js"), "dev", "--port", String(devPort), "--fresh"], { ...process.env, NO_COLOR: "1" }, devCwd, devLog);
    await waitFor(async () => (await (await fetch(`${devUrl}/v1/health`)).json()).mode === "local", 10_000, "paynp dev");

    const shopPort = await freePort();
    shopUrl = `http://localhost:${shopPort}`;
    const env: Record<string, string | undefined> = { ...process.env, PORT: String(shopPort), BASE_URL: shopUrl, NODE_ENV: "development" };
    delete env.PAYNP_KEY;
    delete env.PAYNP_ENDPOINT;
    delete env.VITEST;
    if (useDefault) delete env.PAYNP_DEV_URL;
    else env.PAYNP_DEV_URL = devUrl;
    start(process.execPath, [join(DEPS!, "node_modules", "tsx", "dist", "cli.mjs"), "server.ts"], env, app, shopLog);
    await waitFor(async () => (await fetch(shopUrl)).ok, 20_000, "the Express app");

    ws = new WebSocket(`${devUrl.replace("http", "ws")}/api/projects/local/live?env=test`);
    ws.onmessage = (m) => live.push(JSON.parse(String(m.data)));
    await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
  }, 60_000);

  afterAll(async () => {
    ws?.close();
    for (const c of children) c.kill("SIGINT");
    await new Promise((r) => setTimeout(r, 300));
    for (const c of children) if (c.exitCode === null) c.kill("SIGKILL");
    if (process.env.PAYNP_E2E_VERBOSE) console.log(devLog.join(""), shopLog.join(""));
  });

  it("start, eSewa accepts the form, signed return, real status API; all of it in the local API and on the WebSocket", async () => {
    // 1. The buyer clicks "Pay with eSewa": the app answers with the auto-POST form.
    const page = await (await fetch(`${shopUrl}/pay/demo`, { method: "POST" })).text();
    const action = /<form[^>]*action="([^"]+)"/.exec(page)?.[1];
    const fields = Object.fromEntries([...page.matchAll(/<input[^>]*name="([^"]+)"[^>]*value="([^"]*)"/g)].map((m) => [m[1], m[2].replace(/&amp;/g, "&")]));
    expect(action).toBe("https://rc-epay.esewa.com.np/api/epay/main/v2/form");
    const attemptId = fields.transaction_uuid;
    expect(attemptId).toBeTruthy();

    // 2. The browser posts it to eSewa's sandbox, which accepts it and sends the buyer to its login page.
    const esewa = await fetch(action!, { method: "POST", body: new URLSearchParams(fields), redirect: "manual", signal: AbortSignal.timeout(30_000) });
    expect(esewa.status).toBe(302);
    expect(esewa.headers.get("location")).toContain("bookingId=");

    // 3. The buyer comes back with a correctly signed ?data=. The module checks it and asks the real status API.
    const names = "transaction_code,status,total_amount,transaction_uuid,product_code,signed_field_names";
    const payload: Record<string, string> = { transaction_code: "000E2E1", status: "COMPLETE", total_amount: fields.total_amount, transaction_uuid: attemptId, product_code: "EPAYTEST", signed_field_names: names };
    const { createHmac } = await import("node:crypto");
    payload.signature = createHmac("sha256", SECRET).update(names.split(",").map((n) => `${n}=${payload[n]}`).join(",")).digest("base64");
    const back = await fetch(`${fields.success_url}?data=${encodeURIComponent(Buffer.from(JSON.stringify(payload)).toString("base64"))}`, { redirect: "manual", signal: AbortSignal.timeout(30_000) });
    expect(back.status).toBe(303);

    // 4. The SDK sends in the background (every 2 s). Everything lands in the local API...
    const detail = await waitFor(
      async () => {
        const r = await fetch(`${devUrl}/api/projects/local/payments/${attemptId}?env=test`);
        if (!r.ok) return undefined;
        const d = (await r.json()) as PaymentDetail;
        return d.events.some((e) => e.type === "gateway.request") ? d : undefined;
      },
      20_000,
      "the events in the local API",
    );
    const typesSeen = detail.events.map((e) => e.type);
    expect(typesSeen.slice(0, 5)).toEqual(["payment.started", "payment.redirected", "callback.received", "signature.checked", "gateway.request"]);
    expect(detail.payment).toMatchObject({ attempt_id: attemptId, gateway: "esewa", amount_paisa: 10000, env: "test" });
    const req = detail.events.find((e) => e.type === "gateway.request")!;
    expect(req.data).toMatchObject({ op: "status", method: "GET", endpoint: "/api/epay/transaction/status/", http_status: 200 });
    expect(req.duration_ms).toBeGreaterThan(0);
    expect(detail.events.find((e) => e.type === "signature.checked")!.data).toEqual({ valid: true });
    // The signed payload never leaves the app.
    expect(JSON.stringify(detail)).not.toContain(payload.signature);

    const list = await (await fetch(`${devUrl}/api/projects/local/payments`)).json();
    expect(list.items.map((p: { attempt_id: string }) => p.attempt_id)).toContain(attemptId);
    const health = await (await fetch(`${devUrl}/api/projects/local/health`)).json();
    expect(health.items[0]).toMatchObject({ gateway: "esewa", requests: expect.any(Number) });

    // ...and on the live WebSocket, each event with its payment row.
    const streamed = live.flatMap((m) => (m.kind === "event" && m.event.attempt_id === attemptId ? [m.event.type] : []));
    expect(streamed.slice(0, 5)).toEqual(typesSeen.slice(0, 5));
    const last = live.filter((m) => m.kind === "event").at(-1) as Extract<LiveMessage, { kind: "event" }>;
    expect(last.payment.attempt_id).toBe(attemptId);

    // The dev server printed them too.
    expect(devLog.join("")).toContain(attemptId);
    console.log(`e2e: ${attemptId}: ${typesSeen.join(", ")}; status API ${req.duration_ms} ms; dev server at ${devUrl}`);
  }, 120_000);
});

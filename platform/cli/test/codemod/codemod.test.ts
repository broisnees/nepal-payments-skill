// `paynp init` wiring the SDK into real app code: the blog's apps for all four JS frameworks and an app
// on the skill's adapters. Exact diffs (file snapshots under __snapshots__), idempotency, git safety,
// dry run, tsc on the edited apps, and the edited Express app against eSewa's real sandbox.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { run } from "../../src/cli.ts";
import { unifiedDiff } from "../../src/codemod/diff.ts";
import { applyPlan, planWiring, type Plan } from "../../src/codemod/plan.ts";
import { parseEnv } from "../../src/envfile.ts";
import type { StackId } from "../../src/stacks.ts";
import type { Io } from "../../src/ui.ts";
import { startMockApi, type MockApi } from "../mock-api.ts";
import { TSC, depsDir } from "./deps.ts";
import { adapterApp, blogApp, blogFiles, commitAll, git, linkDeps, write, type Framework } from "./fixtures.ts";

const FRAMEWORKS: Framework[] = ["express", "hono", "fastify", "nextjs"];
const SKIP_DEPS = !!process.env.PAYNP_SKIP_DEPS;
const SKIP_SANDBOX = SKIP_DEPS || !!process.env.PAYNP_SKIP_SANDBOX;

const diffOf = (plan: Plan) => plan.changes.map((c) => unifiedDiff(c.rel, c.before, c.after)).join("\n\n") + "\n";
const snap = (name: string) => join(import.meta.dirname, "__snapshots__", `${name}.diff`);

function io(answers: string[] = [], interactive = false) {
  const out: string[] = [];
  const i: Io = { out: (s) => void out.push(s), err: (s) => void out.push(s), interactive, color: false, ask: async (q) => (out.push(q), answers.shift() ?? "") };
  return { io: i, text: () => out.join("\n") };
}

const tree = (dir: string) => git(dir, "status", "--porcelain");

describe("planWiring on the blog apps", () => {
  it.each(FRAMEWORKS)("%s: exact edits, then a second run changes nothing", async (fw) => {
    const dir = blogApp(fw);
    const plan = planWiring(dir, { stack: fw });
    await expect(diffOf(plan)).toMatchFileSnapshot(snap(fw));
    expect(plan.skipped).toEqual([]);
    expect(plan.manual).toEqual([]);
    applyPlan(dir, plan);

    const again = planWiring(dir, { stack: fw });
    expect(again.changes).toEqual([]);
    expect(again.found).toBe(true);
    expect(again.already).toContain("payments.ts");
    expect(again.already.length).toBeGreaterThan(1);
  });

  it("Khalti: the generated file and settle() name the gateway the app has", () => {
    const dir = blogApp("express", { gateway: "khalti" });
    const plan = planWiring(dir, { stack: "express" });
    const paynp = plan.changes.find((c) => c.rel === "paynp.ts")!;
    expect(paynp.after).toContain('export const gateway = paynp.wrapGateway("khalti", khalti);');
    expect(plan.changes.find((c) => c.rel === "payments.ts")!.after).toContain('gateway: "khalti", to: s');
  });

  it("settle() from the earlier blog version, with a one-line `if (...) fulfil(...)`", () => {
    const blog = blogFiles("express")["payments.ts"];
    const old = blog.replace(/if \(transition\(attempt\.id, \[\.\.\.OPEN\], s\) && s === "paid"\) \{[\s\S]*?\n {4}\}\n/, 'if (transition(attempt.id, [...OPEN], s) && s === "paid") fulfil(attempt.orderId);\n');
    expect(old).not.toBe(blog);
    const dir = blogApp("express", { extra: { "payments.ts": old } });
    const plan = planWiring(dir, { stack: "express" });
    expect(plan.manual).toEqual([]);
    expect(plan.changes.find((c) => c.rel === "payments.ts")!.after).toContain(
      [
        "    if (transition(attempt.id, [...OPEN], s)) {",
        '      paynp.statusChanged({ attemptId: attempt.id, gateway: "esewa", to: s, orderId: attempt.orderId, amountPaisa: attempt.amountPaisa });',
        '      if (s === "paid") {',
        "        fulfil(attempt.orderId);",
        '        paynp.fulfilled({ attemptId: attempt.id, gateway: "esewa", orderId: attempt.orderId, amountPaisa: attempt.amountPaisa });',
        "      }",
        "    }",
        '  } else if (s === "pending") {',
      ].join("\n"),
    );
    applyPlan(dir, plan);
    expect(planWiring(dir, { stack: "express" }).changes).toEqual([]);
  });

  it("Hono on Cloudflare Workers:reads the key from the Worker env and flushes with waitUntil", async () => {
    const files = blogFiles("hono");
    const server = files["server.ts"]
      .replace('import { serve } from "@hono/node-server";\n', "")
      .replace(/serve\(\{ fetch: app\.fetch[^\n]*\n/, "export default app;\n")
      .replace("startReconcileLoop(gateway);\n", "");
    const dir = blogApp("hono", { extra: { "server.ts": server, "wrangler.jsonc": '{ "name": "shop", "main": "server.ts" }\n' } });
    const plan = planWiring(dir, { stack: "hono" });
    await expect(diffOf(plan)).toMatchFileSnapshot(snap("hono-workers"));
    expect(plan.manual).toEqual(["Workers: set the key with `wrangler secret put PAYNP_KEY`. The paynp file reads it from the `cloudflare:workers` env."]);
  });

  it("plain JavaScript modules get a paynp.mjs without types", async () => {
    const dir = mkdtempSync(join(tmpdir(), "paynp-codemod-js-"));
    write(dir, {
      "package.json": '{"name":"shop","dependencies":{"express":"5.3.0"}}\n',
      "esewa.mjs": "export async function startPayment(input) {\n  return { type: 'form', action: '', fields: {} }\n}\nexport async function confirmPayment(input) {\n  return { status: 'pending' }\n}\n",
      "server.mjs": "import express from 'express'\nimport * as esewa from './esewa.mjs'\n\nconst app = express()\napp.post('/pay', async (_req, res) => res.json(await esewa.startPayment({ attemptId: 'a', amountPaisa: 100 })))\n",
    });
    commitAll(dir);
    await expect(diffOf(planWiring(dir, { stack: "express" }))).toMatchFileSnapshot(snap("javascript"));
  });

  it("names imported from a gateway module are left alone, with the manual step", () => {
    const dir = mkdtempSync(join(tmpdir(), "paynp-codemod-named-"));
    write(dir, { ...blogFiles("express"), "server.ts": 'import { startPayment } from "./esewa";\nvoid startPayment;\n', "package.json": "{}" });
    commitAll(dir);
    const plan = planWiring(dir, { stack: "express" });
    expect(plan.changes).toEqual([]);
    expect(plan.found).toBe(true);
    expect(plan.manual[0]).toContain('server.ts: imports names from "./esewa". Import the wrapped module instead: `import { gateway } from "./paynp"`');
  });

  it("an existing paynp.ts that init did not write is never overwritten", () => {
    const dir = blogApp("express", { extra: { "paynp.ts": "export const mine = 1;\n" } });
    const plan = planWiring(dir, { stack: "express" });
    expect(plan.changes).toEqual([]);
    expect(plan.manual[0]).toContain("paynp.ts exists and was not written by paynp init");
  });
});

describe("planWiring on the skill adapters", () => {
  it("wraps createPayments and the adapter factories, then a second run changes nothing", async () => {
    const dir = adapterApp();
    const plan = planWiring(dir, { stack: "express" });
    await expect(diffOf(plan)).toMatchFileSnapshot(snap("adapters"));
    expect(plan.changes.map((c) => c.rel)).toEqual(["src/server/paynp.ts", "src/server/checkout.ts"]); // types-only.ts untouched
    applyPlan(dir, plan);
    const again = planWiring(dir, { stack: "express" });
    expect(again.changes).toEqual([]);
    expect(again.already).toEqual(["src/server/checkout.ts"]);
  });
});

describe("git safety", () => {
  it("skips a file with uncommitted changes, edits it with --force", () => {
    const dir = blogApp("express");
    writeFileSync(join(dir, "server.ts"), readFileSync(join(dir, "server.ts"), "utf8") + "// my change\n");
    const plan = planWiring(dir, { stack: "express" });
    // server.ts is the only import site, so paynp.ts and settle() are left alone too: nothing would use them.
    expect(plan.changes).toEqual([]);
    expect(plan.skipped).toEqual([{ rel: "server.ts", reason: "has uncommitted changes (commit or stash them, or rerun with --force)" }]);
    expect(planWiring(dir, { stack: "express", force: true }).changes.map((c) => c.rel)).toEqual(["paynp.ts", "payments.ts", "server.ts"]);
  });

  it("an untracked or staged file counts as uncommitted; the rest is still wired", () => {
    const dir = blogApp("express");
    writeFileSync(join(dir, "payments.ts"), readFileSync(join(dir, "payments.ts"), "utf8") + "\n");
    git(dir, "add", "payments.ts");
    const plan = planWiring(dir, { stack: "express" });
    expect(plan.changes.map((c) => c.rel)).toEqual(["paynp.ts", "server.ts"]);
    expect(plan.skipped.map((s) => s.rel)).toEqual(["payments.ts"]);
  });

  it("never edits node_modules or files reached through a symlink", () => {
    const dir = blogApp("express");
    const outside = blogApp("express");
    linkDeps(dir, outside); // node_modules -> another project with the same gateway imports
    const plan = planWiring(dir, { stack: "express" });
    expect(plan.changes.every((c) => !c.rel.includes("node_modules"))).toBe(true);
    expect(tree(outside)).toBe("");
  });
});

describe("paynp init", () => {
  let api: MockApi;
  beforeAll(() => {
    process.env.PAYNP_NO_BROWSER = "1";
  });
  beforeEach(async () => {
    process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "paynp-home-"));
    delete process.env.PAYNP_ENDPOINT;
    api = await startMockApi();
  });
  afterEach(() => api.close());
  afterAll(() => {
    delete process.env.XDG_CONFIG_HOME;
  });

  const login = async () => expect(await run(["login", "--endpoint", api.url], { io: io().io, cwd: tmpdir() })).toBe(0);

  it("--dry-run prints the diff and writes nothing, without logging in", async () => {
    const dir = blogApp("express");
    const r = io();
    expect(await run(["init", "--dry-run", "--endpoint", api.url], { io: r.io, cwd: dir })).toBe(0);
    const out = r.text();
    expect(out).toContain("Dry run: no login, no key, no install, nothing written.");
    expect(out).toContain("--- /dev/null\n+++ b/paynp.ts");
    expect(out).toContain('-import * as gateway from "./esewa";\n+import { gateway } from "./paynp";');
    expect(out).toContain("Dry run: nothing written.");
    expect(tree(dir)).toBe("");
    expect(existsSync(join(dir, ".env"))).toBe(false);
    expect(api.state.projects.filter((p) => p.name === "shop")).toEqual([]);
  });

  it("--yes applies the edits and prints what changed; running it again changes nothing", async () => {
    await login();
    const dir = blogApp("express");
    const r = io();
    expect(await run(["init", "--yes", "--skip-install"], { io: r.io, cwd: dir })).toBe(0);
    expect(r.text()).toContain("Wired paynp into 3 files:");
    expect(r.text()).toContain("  created paynp.ts: wraps eSewa with createPaynp");
    expect(r.text()).toContain("  edited  server.ts: imports gateway from ./paynp");
    expect(tree(dir).split("\n").filter(Boolean).sort()).toEqual([" M payments.ts", " M server.ts", "?? .paynp/", "?? paynp.ts"]);
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "paynp");
    const r2 = io();
    expect(await run(["init", "--yes", "--skip-install"], { io: r2.io, cwd: dir })).toBe(0);
    expect(r2.text()).toContain("paynp is already wired into the code (payments.ts, server.ts). Nothing to change.");
    expect(tree(dir)).toBe("");
  });

  it("asks once; an empty answer applies, n leaves the code alone", async () => {
    await login();
    const no = blogApp("fastify");
    const r = io(["1", "n"], true);
    expect(await run(["init", "--skip-install"], { io: r.io, cwd: no })).toBe(0);
    expect(r.text()).toContain("Apply these changes? [Y/n] ");
    expect(r.text()).toContain("Left the code as it was.");
    expect(tree(no).split("\n").filter(Boolean)).toEqual(["?? .paynp/"]);

    const yes = blogApp("fastify");
    const r2 = io(["1", ""], true);
    expect(await run(["init", "--skip-install"], { io: r2.io, cwd: yes })).toBe(0);
    expect(r2.text()).toContain("Wired paynp into 3 files:");
  });

  it("non-interactive without --yes shows the diff but does not apply it", async () => {
    await login();
    const dir = blogApp("hono");
    const r = io();
    expect(await run(["init", "--skip-install", "--project", "shop", "--create"], { io: r.io, cwd: dir })).toBe(0);
    expect(r.text()).toContain("Not applied: there is no terminal to ask. Rerun with --yes to apply these edits.");
    expect(existsSync(join(dir, "paynp.ts"))).toBe(false);
  });

  it("dirty files are listed as not edited", async () => {
    await login();
    const dir = blogApp("express");
    writeFileSync(join(dir, "server.ts"), "// wip\n" + readFileSync(join(dir, "server.ts"), "utf8"));
    const r = io();
    expect(await run(["init", "--yes", "--skip-install"], { io: r.io, cwd: dir })).toBe(0);
    expect(r.text()).toContain("Not edited:\n  - server.ts: has uncommitted changes (commit or stash them, or rerun with --force)");
    expect(existsSync(join(dir, "paynp.ts"))).toBe(false);
  });

  it("Python, PHP, Go, Java and Kotlin keep the printed snippet and say the code is not edited", async () => {
    const cases: [Record<string, string>, string][] = [
      [{ "requirements.txt": "Django==5.2\n" }, "paynp has no Python SDK yet, so init does not edit Django code. Add this yourself:"],
      [{ "composer.json": '{"require":{"laravel/framework":"^12.0"}}' }, "paynp has no PHP SDK yet, so init does not edit Laravel code."],
      [{ "go.mod": "module shop\n" }, "paynp has no Go SDK yet, so init does not edit Go code."],
      [{ "pom.xml": "<groupId>org.springframework.boot</groupId>" }, "paynp has no Java SDK yet, so init does not edit Spring Boot code."],
      [{ "build.gradle.kts": 'implementation("io.ktor:ktor-server-core:3.2.0")' }, "paynp has no Kotlin SDK yet, so init does not edit Ktor code."],
    ];
    for (const [files, line] of cases) {
      const dir = mkdtempSync(join(tmpdir(), "paynp-nonjs-"));
      write(dir, files);
      const r = io();
      expect(await run(["init", "--dry-run"], { io: r.io, cwd: dir })).toBe(0);
      expect(r.text()).toContain(line);
    }
  });

  it("a JS app with no gateway imports falls back to the printed snippet", async () => {
    const dir = mkdtempSync(join(tmpdir(), "paynp-plain-"));
    write(dir, { "package.json": '{"dependencies":{"express":"5"}}', "server.ts": "export {};\n" });
    const r = io();
    expect(await run(["init", "--dry-run"], { io: r.io, cwd: dir })).toBe(0);
    expect(r.text()).toContain("I found no gateway module or adapter import to wire, so here is what to add:");
    expect(r.text()).toContain('export const gateway = paynp.wrapGateway("esewa", esewa);');
  });
});

describe.skipIf(SKIP_DEPS)("the edited apps typecheck", () => {
  let nm: string;
  beforeAll(() => {
    nm = depsDir();
  }, 600_000);

  const tsc = (dir: string) => execFileSync(process.execPath, [TSC, "--noEmit", "-p", dir], { encoding: "utf8" });

  it.each([...FRAMEWORKS, "adapters" as const])("%s", (w) => {
    const dir = w === "adapters" ? adapterApp() : blogApp(w);
    linkDeps(dir, nm);
    tsc(dir); // the blog's code typechecks as published
    applyPlan(dir, planWiring(dir, { stack: (w === "adapters" ? "express" : w) as StackId }));
    expect(() => tsc(dir)).not.toThrow();
  }, 120_000);
});

describe.skipIf(SKIP_SANDBOX)("the edited Express app against eSewa's sandbox", () => {
  let api: MockApi;
  let app: ChildProcess | undefined;
  let nm: string;
  beforeAll(async () => {
    nm = depsDir();
    process.env.PAYNP_NO_BROWSER = "1";
    process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "paynp-home-"));
    api = await startMockApi();
  }, 600_000);
  afterAll(() => {
    app?.kill();
    api?.close();
    delete process.env.XDG_CONFIG_HOME;
  });

  it("start, eSewa accepts the signed form, return, bad signature: every step reaches the ingest", async () => {
    const dir = blogApp("express");
    linkDeps(dir, nm);
    expect(await run(["login", "--endpoint", api.url], { io: io().io, cwd: dir })).toBe(0);
    const r = io();
    expect(await run(["init", "--yes", "--skip-install", "--endpoint", api.url], { io: r.io, cwd: dir })).toBe(0);
    expect(r.text()).toContain("Wired paynp into 3 files:");
    const env = parseEnv(readFileSync(join(dir, ".env"), "utf8"));
    expect(env.PAYNP_ENDPOINT).toBe(api.url);

    const port = await freePort();
    const base = `http://localhost:${port}`;
    app = spawn(process.execPath, [join(nm, "tsx", "dist", "cli.mjs"), "server.ts"], {
      cwd: dir,
      env: { ...process.env, ...env, PORT: String(port), BASE_URL: base },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let log = "";
    app.stdout!.on("data", (d) => (log += d));
    app.stderr!.on("data", (d) => (log += d));
    await until(async () => (await fetch(base + "/").catch(() => null))?.ok === true, 30_000, () => log);

    const home = await fetch(base + "/");
    expect(await home.text()).toContain("Order demo");

    // Start: the app answers with the signed form for eSewa.
    const page = await (await fetch(base + "/pay/demo", { method: "POST" })).text();
    const action = /<form[^>]*action="([^"]+)"/.exec(page)?.[1];
    const fields = Object.fromEntries([...page.matchAll(/<input[^>]*name="([^"]*)"[^>]*value="([^"]*)"/g)].map((m) => [m[1], unescape(m[2])]));
    expect(action).toBe("https://rc-epay.esewa.com.np/api/epay/main/v2/form");
    const attemptId = fields.transaction_uuid;
    expect(attemptId).toMatch(/^[0-9a-f]{20}$/);

    // eSewa's sandbox accepts the signature: it redirects to its login page with a booking id.
    const esewa = await retry(() => fetch(action!, { method: "POST", body: new URLSearchParams(fields), redirect: "manual" }));
    expect(esewa.status).toBe(302);
    expect(esewa.headers.get("location")).toContain("/epay?bookingId=");

    // Return with no data: the app asks eSewa's status API. The sandbox answers PENDING for a fresh
    // booking, and lately COMPLETE for any id; settle() moves the attempt either way.
    const back = await fetch(`${base}/pay/return/${attemptId}`, { redirect: "manual" });
    expect(back.status).toBe(303);
    const status = /: (\w+)$/.exec(await (await fetch(base + "/orders/demo")).text())?.[1];
    expect(["pending", "paid"]).toContain(status);

    // A forged callback is refused.
    const forged = Buffer.from(JSON.stringify({ transaction_code: "000AAA1", status: "COMPLETE", total_amount: "100.0", transaction_uuid: attemptId, product_code: "EPAYTEST", signed_field_names: "transaction_code,status,total_amount,transaction_uuid,product_code,signed_field_names", signature: Buffer.alloc(32, 120).toString("base64") })).toString("base64");
    expect((await fetch(`${base}/pay/return/${attemptId}?data=${encodeURIComponent(forged)}`, { redirect: "manual" })).status).toBe(400);

    // The SDK sends in the background every 2 s.
    const types = () => api.state.events.filter((e) => e.attempt_id === attemptId).map((e) => e.type);
    await until(() => types().includes("error"), 20_000, () => `${JSON.stringify(types())}\n${log}`);
    const events = api.state.events.filter((e) => e.attempt_id === attemptId);
    expect(api.state.invalid).toEqual([]);
    expect(events.every((e) => e.gateway === "esewa" && e.env === "test")).toBe(true);
    expect(types()).toEqual([
      "payment.started",
      "payment.redirected",
      "gateway.request", // the status API call, timed
      "reconcile.checked",
      "status.changed", // from settle(): initiated -> pending or paid
      ...(status === "paid" ? ["payment.fulfilled"] : []), // from settle(), next to fulfil()
      "callback.received",
      "signature.checked",
      "error",
    ]);
    const by = (t: string) => events.find((e) => e.type === t)!;
    expect(by("payment.started").amount_paisa).toBe(10000);
    expect(by("gateway.request").data).toMatchObject({ op: "status", method: "GET", endpoint: "/api/epay/transaction/status/", http_status: 200 });
    expect(by("reconcile.checked").status).toBe(status);
    expect(by("status.changed")).toMatchObject({ status, order_id: "demo", amount_paisa: 10000 });
    expect(by("signature.checked").data).toMatchObject({ valid: false });
    expect(by("error").data).toMatchObject({ reason: "bad_signature" });
  }, 120_000);
});

function unescape(s: string): string {
  return s.replaceAll("&quot;", '"').replaceAll("&#39;", "'").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
}

// eSewa's sandbox host drops connections now and then; a connect timeout is retried, an answer is not.
async function retry<T>(fn: () => Promise<T>, tries = 4): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= tries) throw err;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
}

async function until(cond: () => boolean | Promise<boolean>, ms: number, info: () => string = () => ""): Promise<void> {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error(`timed out\n${info()}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { EVENT_TYPES } from "../../shared/src/events.ts";
import { parseArgs, run } from "../src/cli.ts";
import { credentialsPath, readCredentials } from "../src/config.ts";
import { addToEnvFile, ensureGitignored, parseEnv } from "../src/envfile.ts";
import { formatEvent } from "../src/format.ts";
import type { Io } from "../src/ui.ts";
import { startMockApi, type MockApi } from "./mock-api.ts";

const exec = promisify(execFile);
let api: MockApi;
let home: string;

function io(answers: string[] = [], interactive = false) {
  const out: string[] = [];
  const err: string[] = [];
  const asked: string[] = [];
  const i: Io = {
    out: (s) => void out.push(s),
    err: (s) => void err.push(s),
    interactive,
    color: false,
    ask: async (q) => (asked.push(q), answers.shift() ?? ""),
  };
  return { io: i, out, err, asked, text: () => out.join("\n"), errText: () => err.join("\n") };
}

const tmp = (name: string) => mkdtempSync(join(tmpdir(), `paynp-${name}-`));

function expressApp(): string {
  const dir = tmp("express");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@acme/shop", dependencies: { express: "^5.1.0" } }));
  writeFileSync(join(dir, "esewa.ts"), "export async function startPayment() {}\n");
  writeFileSync(join(dir, ".gitignore"), "node_modules");
  writeFileSync(join(dir, ".env"), "PORT=3000");
  return dir;
}

async function loggedIn(): Promise<void> {
  const r = io();
  expect(await run(["login", "--endpoint", api.url], { io: r.io, cwd: tmp("login") })).toBe(0);
}

beforeAll(() => {
  process.env.PAYNP_NO_BROWSER = "1";
});
beforeEach(async () => {
  home = tmp("home");
  process.env.XDG_CONFIG_HOME = home;
  delete process.env.PAYNP_ENDPOINT;
  delete process.env.PAYNP_KEY;
  api = await startMockApi();
});
afterEach(() => api.close());
afterAll(() => {
  delete process.env.XDG_CONFIG_HOME;
});

describe("args", () => {
  it("parses commands, values, booleans and --k=v", () => {
    expect(parseArgs(["keys", "revoke", "key_1", "--endpoint=http://x", "-y", "--env", "live", "--json"])).toEqual({
      args: ["keys", "revoke", "key_1"],
      flags: { endpoint: "http://x", y: true, yes: true, env: "live", json: true },
    });
  });

  it("help, version and unknown commands", async () => {
    const r = io();
    expect(await run(["--version"], { io: r.io })).toBe(0);
    expect(r.out).toEqual(["0.1.0"]);
    expect(await run(["--help"], { io: r.io })).toBe(0);
    expect(r.text()).toContain("Usage: paynp <command>");
    expect(await run(["nope"], { io: r.io })).toBe(1);
    expect(r.errText()).toContain('unknown command "nope"');
  });
});

describe("login / logout", () => {
  it("device login: polls through 428 until approved, stores the PAT with mode 600", async () => {
    const r = io();
    expect(await run(["login", "--endpoint", `${api.url}/`], { io: r.io, cwd: tmp("x") })).toBe(0);
    expect(r.text()).toMatch(/Your code: [A-Z0-9]{4}-[A-Z0-9]{4}/);
    expect(r.text()).toContain(`Open ${api.url}/device?code=`);
    expect(r.text()).toContain("Logged in as owner@shop.np");
    expect(api.state.devicePolls).toHaveLength(3); // two pending, then the token
    const creds = readCredentials();
    expect(creds.default).toBe(api.url);
    expect(creds.tokens[api.url].token).toMatch(/^pnp_pat_/);
    expect(creds.tokens[api.url].dashboard).toBe(api.url);
    expect(credentialsPath()).toBe(join(home, "paynp", "credentials.json"));
    expect(statSync(credentialsPath()).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, "paynp")).mode & 0o777).toBe(0o700);
  });

  it("login can be canceled while it waits for approval", async () => {
    const r = io();
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 30);
    api.state.pendingPolls = 1e9;
    expect(await run(["login", "--endpoint", api.url], { io: r.io, signal: ac.signal })).toBe(1);
    expect(r.errText()).toContain("login canceled");
  });

  it("logout revokes the current PAT on the server and deletes the file", async () => {
    await loggedIn();
    const token = readCredentials().tokens[api.url].token;
    const r = io();
    expect(await run(["logout"], { io: r.io })).toBe(0); // endpoint from the last login
    expect(api.state.pats.get(token)?.revoked).toBe(true);
    expect(existsSync(credentialsPath())).toBe(false);
    expect(r.text()).toContain("revoked and deleted");
    expect(api.state.csrfMissing).toEqual([]);
  });

  it("commands that need a login say how to get one", async () => {
    const dir = expressApp();
    mkdirSync(join(dir, ".paynp"));
    writeFileSync(join(dir, ".paynp", "project.json"), JSON.stringify({ org: "org_1", project: "prj_existing" }));
    const r = io();
    expect(await run(["keys", "--endpoint", api.url], { io: r.io, cwd: dir })).toBe(1);
    expect(r.errText()).toContain(`not logged in to ${api.url}. Run: paynp login --endpoint ${api.url}`);
  });
});

describe("init", () => {
  it("Express app, non-interactive: creates the project and a test key, writes .env, .gitignore and the link, prints the wiring", async () => {
    await loggedIn();
    const dir = expressApp();
    const r = io();
    expect(await run(["init", "--yes", "--skip-install"], { io: r.io, cwd: dir })).toBe(0);
    const out = r.text();
    expect(out).toContain("Stack: Express (from package.json)");
    expect(out).toContain("Creating project shop");

    const project = api.state.projects.find((p) => p.name === "shop")!;
    expect(project).toBeDefined();
    const key = api.state.keys.find((k) => k.project_id === project.id)!;
    expect(key.env).toBe("test");

    const env = readFileSync(join(dir, ".env"), "utf8");
    expect(env).toBe(`PORT=3000\nPAYNP_KEY=${key.key}\nPAYNP_ENDPOINT=${api.url}\n`);
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe("node_modules\n.env\n");
    expect(JSON.parse(readFileSync(join(dir, ".paynp", "project.json"), "utf8"))).toEqual({ org: "org_1", project: project.id });
    expect(out).toContain('export const gateway = paynp.wrapGateway("esewa", esewa);');
    expect(out).toContain("Skipped install. Run: npm install @paynp/sdk");
    expect(out).toContain("--env-file");

    // Second run: same project, key kept, nothing duplicated.
    const r2 = io();
    expect(await run(["init", "--yes", "--skip-install"], { io: r2.io, cwd: dir })).toBe(0);
    expect(r2.text()).toContain("PAYNP_KEY is already in .env, kept it.");
    expect(api.state.keys).toHaveLength(1);
    expect(api.state.projects.filter((p) => p.name === "shop")).toHaveLength(1);
    expect(readFileSync(join(dir, ".env"), "utf8")).toBe(env);
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe("node_modules\n.env\n");
  });

  it("interactive: picks an existing project from the menu", async () => {
    await loggedIn();
    const dir = expressApp();
    const r = io(["1"], true);
    expect(await run(["init", "--skip-install"], { io: r.io, cwd: dir })).toBe(0);
    expect(r.text()).toContain('2) Create a new project "shop"');
    expect(JSON.parse(readFileSync(join(dir, ".paynp", "project.json"), "utf8")).project).toBe("prj_existing");
  });

  it("logs in first when there is no token", async () => {
    const dir = expressApp();
    const r = io();
    expect(await run(["init", "--yes", "--skip-install", "--endpoint", api.url], { io: r.io, cwd: dir })).toBe(0);
    expect(r.text()).toContain("Not logged in yet. Starting login.");
    expect(r.text()).toContain("Logged in as");
  });

  it("installs @paynp/sdk with the project's package manager", async () => {
    await loggedIn();
    const bin = tmp("bin");
    const log = join(bin, "calls.log");
    for (const pm of ["npm", "pnpm"]) {
      writeFileSync(join(bin, pm), `#!/bin/sh\necho "${pm} $*" >> "${log}"\n`);
      chmodSync(join(bin, pm), 0o755);
    }
    const oldPath = process.env.PATH;
    process.env.PATH = `${bin}:${oldPath}`;
    try {
      const a = expressApp();
      expect(await run(["init", "--yes"], { io: io().io, cwd: a })).toBe(0);
      const b = expressApp();
      writeFileSync(join(b, "pnpm-lock.yaml"), "");
      expect(await run(["init", "--yes"], { io: io().io, cwd: b })).toBe(0);
      const c = expressApp();
      writeFileSync(join(c, "package.json"), JSON.stringify({ dependencies: { express: "5", "@paynp/sdk": "0.1.0" } }));
      expect(await run(["init", "--yes"], { io: io().io, cwd: c })).toBe(0); // already installed: no call
    } finally {
      process.env.PATH = oldPath;
    }
    expect(readFileSync(log, "utf8").trim().split("\n")).toEqual(["npm install @paynp/sdk", "pnpm add @paynp/sdk"]);
  });

  it("a non-JS stack gets no install, and the default endpoint is not written to .env", async () => {
    // PAYNP_ENDPOINT is already in .env: it is kept, not added twice.
    await loggedIn();
    const dir = tmp("django");
    writeFileSync(join(dir, "requirements.txt"), "Django>=5.1\npsycopg[binary]\n");
    writeFileSync(join(dir, ".env"), `PAYNP_ENDPOINT=${api.url}\n`);
    const r = io();
    expect(await run(["init", "--yes"], { io: r.io, cwd: dir })).toBe(0);
    expect(r.text()).toContain("Stack: Django (from requirements.txt)");
    expect(r.text()).not.toContain("@paynp/sdk");
    expect(r.text()).toContain("def paynp_event(type, attempt_id");
    expect(readFileSync(join(dir, ".env"), "utf8").match(/PAYNP_ENDPOINT/g)).toHaveLength(1);
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe(".env\n");
  });
});

describe("stack detection", () => {
  const cases: [string, Record<string, string>, string, string][] = [
    ["Express", { "package.json": '{"dependencies":{"express":"5"}}' }, "express", "wrapGateway"],
    ["Hono", { "package.json": '{"dependencies":{"hono":"4","@hono/node-server":"1"}}' }, "hono", "waitUntil"],
    ["Next.js", { "package.json": '{"dependencies":{"next":"16","react":"19"}}' }, "nextjs", "after(() => paynp.flush())"],
    ["Fastify", { "package.json": '{"dependencies":{"fastify":"5"}}' }, "fastify", "wrapGateway"],
    ["Laravel", { "composer.json": '{"require":{"laravel/framework":"^12.0"}}' }, "laravel", "afterResponse()"],
    ["plain PHP", { "composer.json": '{"require":{}}' }, "php", "curl_init"],
    ["plain PHP files", { "index.php": "<?php" }, "php", "curl_init"],
    ["Django", { "requirements.txt": "Django==5.2\n" }, "django", "# Django:"],
    ["FastAPI", { "pyproject.toml": '[project]\ndependencies = ["fastapi>=0.115", "uvicorn"]\n' }, "fastapi", "# FastAPI:"],
    ["Flask", { "requirements.txt": "flask\n" }, "flask", "# Flask:"],
    ["Go", { "go.mod": "module shop\n\ngo 1.23\n" }, "go", "func PaynpEvent"],
    ["Spring", { "build.gradle.kts": 'plugins { id("org.springframework.boot") version "3.5.0" }' }, "spring", "public final class Paynp"],
    ["Spring (maven)", { "pom.xml": "<groupId>org.springframework.boot</groupId>" }, "spring", "sendAsync"],
    ["Ktor", { "build.gradle.kts": 'implementation("io.ktor:ktor-server-core:3.2.0")' }, "ktor", "object Paynp"],
  ];
  it.each(cases)("%s", async (_name, files, id, marker) => {
    const { detectStack, snippet } = await import("../src/stacks.ts");
    const dir = tmp("stack");
    for (const [f, body] of Object.entries(files)) writeFileSync(join(dir, f), body);
    const s = detectStack(dir);
    expect(s.id).toBe(id);
    expect(snippet(s.id, "khalti").code).toContain(marker);
  });

  it("picks the gateway module the app already has", async () => {
    const { detectGateway } = await import("../src/stacks.ts");
    const dir = tmp("gw");
    expect(detectGateway(dir)).toBe("esewa");
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "khalti.ts"), "");
    expect(detectGateway(dir)).toBe("khalti");
  });
});

describe(".env and .gitignore rules", () => {
  it("never overwrites, keeps comments, adds a newline when missing", () => {
    const dir = tmp("env");
    const p = join(dir, ".env");
    writeFileSync(p, "# app\nexport PAYNP_KEY='pnp_test_old' # mine\nA=1");
    const w = addToEnvFile(p, { PAYNP_KEY: "new", PAYNP_ENDPOINT: "http://localhost:8787" });
    expect(w).toEqual({ created: false, added: ["PAYNP_ENDPOINT"], kept: ["PAYNP_KEY"] });
    expect(readFileSync(p, "utf8")).toBe("# app\nexport PAYNP_KEY='pnp_test_old' # mine\nA=1\nPAYNP_ENDPOINT=http://localhost:8787\n");
    expect(parseEnv(readFileSync(p, "utf8")).PAYNP_KEY).toBe("pnp_test_old");
    const q = join(dir, "new.env");
    expect(addToEnvFile(q, { PAYNP_KEY: "k" }).created).toBe(true);
    expect(statSync(q).mode & 0o777).toBe(0o600);
  });

  it.each([
    [".env", false],
    ["/.env", false],
    [".env*", false],
    ["*.env", false],
    ["**/.env", false],
    [".env\n!.env", true],
    [".env.local", true],
    ["node_modules/", true],
    ["", true],
  ])("gitignore %j -> appends: %s", (content, appends) => {
    const p = join(tmp("gi"), ".gitignore");
    if (content) writeFileSync(p, content);
    expect(ensureGitignored(p)).toBe(appends);
  });
});

describe("test, tail, keys, open", () => {
  async function linkedApp(): Promise<string> {
    await loggedIn();
    const dir = expressApp();
    expect(await run(["init", "--yes", "--skip-install"], { io: io().io, cwd: dir })).toBe(0);
    return dir;
  }

  it("test: sends the synthetic eSewa trace with the test key and prints the payment link", async () => {
    const dir = await linkedApp();
    const r = io();
    expect(await run(["test"], { io: r.io, cwd: dir })).toBe(0);
    expect(api.state.invalid).toEqual([]);
    const evs = api.state.events;
    expect(evs.map((e) => e.type)).toEqual([
      "payment.started", "payment.redirected", "callback.received", "signature.checked", "gateway.request", "status.changed", "payment.fulfilled",
    ]);
    expect(new Set(evs.map((e) => e.attempt_id)).size).toBe(1);
    expect(evs.every((e) => e.env === "test" && e.gateway === "esewa")).toBe(true);
    const sorted = [...evs].sort((a, b) => a.ts.localeCompare(b.ts));
    expect(sorted).toEqual(evs);
    expect(evs.find((e) => e.type === "gateway.request")?.data?.provider_status).toBe("COMPLETE");
    const project = JSON.parse(readFileSync(join(dir, ".paynp", "project.json"), "utf8")).project;
    expect(r.text()).toContain(`See it: ${api.url}/p/${project}/test/payments/${evs[0].attempt_id}`);
  });

  it("test: refuses a live key and a missing key", async () => {
    const dir = tmp("nokey");
    const r = io();
    expect(await run(["test", "--endpoint", api.url], { io: r.io, cwd: dir })).toBe(1);
    expect(r.errText()).toContain("no PAYNP_KEY");
    process.env.PAYNP_KEY = "pnp_live_abcdefghijklmnopqrstuvwxyz012345";
    expect(await run(["test", "--endpoint", api.url], { io: r.io, cwd: dir })).toBe(1);
    expect(r.errText()).toContain("live key");
  });

  it("tail: backlog first, then live events as they are ingested; --json gives one event per line", async () => {
    const dir = await linkedApp();
    expect(await run(["test"], { io: io().io, cwd: dir })).toBe(0); // backlog of 7

    for (const json of [false, true]) {
      const r = io();
      const ac = new AbortController();
      const done = run(["tail", ...(json ? ["--json"] : [])], { io: r.io, cwd: dir, signal: ac.signal });
      const backlog = api.state.events.length;
      await until(() => r.out.length >= backlog);
      expect(await run(["test"], { io: io().io, cwd: dir })).toBe(0); // 7 more, live
      await until(() => r.out.length >= backlog + 7);
      ac.abort();
      expect(await done).toBe(0);
      expect(r.out).toHaveLength(backlog + 7);
      if (json) {
        const parsed = r.out.map((l) => JSON.parse(l));
        expect(parsed.every((e) => (EVENT_TYPES as readonly string[]).includes(e.type))).toBe(true);
      } else {
        const cols = (l: string) => l.split(/\s{2,}/);
        expect(cols(r.out[0])).toEqual([expect.stringMatching(/^\d\d:\d\d:\d\d\.\d{3}$/), "esewa", "payment.started", expect.stringMatching(/^att_[0-9a-z]{26}$/), "Rs 100", "initiated"]);
        expect(cols(r.out.find((l) => l.includes("gateway.request"))!).slice(4)).toEqual(["status GET /api/epay/transaction/status/", "200", "COMPLETE", "612ms"]);
      }
    }
    expect(api.state.liveAuth.every((h) => /^Bearer pnp_pat_/.test(h))).toBe(true);
  });

  it("tail: a revoked token is a clear error, not a reconnect loop", async () => {
    const dir = await linkedApp();
    for (const p of api.state.pats.values()) p.revoked = true;
    const r = io();
    expect(await run(["tail"], { io: r.io, cwd: dir })).toBe(1);
    expect(r.errText()).toContain("did not accept the saved token");
  });

  it("keys: list, create (shown once), revoke", async () => {
    const dir = await linkedApp();
    let r = io();
    expect(await run(["keys", "create", "--env", "live", "--name", "prod"], { io: r.io, cwd: dir })).toBe(0);
    const live = api.state.keys.find((k) => k.env === "live")!;
    expect(r.out).toContain(live.key);
    r = io();
    expect(await run(["keys"], { io: r.io, cwd: dir })).toBe(0);
    expect(r.out[0]).toMatch(/^ID\s+ENV\s+PREFIX\s+NAME\s+CREATED\s+LAST USED\s+STATE$/);
    expect(r.text()).toContain("prod");
    expect(r.text()).not.toContain(live.key);
    r = io(["y"], true);
    expect(await run(["keys", "revoke", live.id], { io: r.io, cwd: dir })).toBe(0);
    expect(live.revoked_at).not.toBeNull();
    r = io();
    expect(await run(["keys", "revoke", "key_nope", "--yes"], { io: r.io, cwd: dir })).toBe(1);
    expect(r.errText()).toContain("key not found (HTTP 404, not_found)");
  });

  it("open: prints the project's dashboard URL", async () => {
    const dir = await linkedApp();
    const r = io();
    expect(await run(["open", "--no-browser"], { io: r.io, cwd: dir })).toBe(0);
    const project = JSON.parse(readFileSync(join(dir, ".paynp", "project.json"), "utf8")).project;
    expect(r.out).toEqual([`${api.url}/p/${project}/test/overview`]);
  });

  it("endpoint: --endpoint, then PAYNP_ENDPOINT, then .env", async () => {
    const dir = tmp("ep");
    writeFileSync(join(dir, ".env"), "PAYNP_KEY=pnp_test_abcdefghijklmnopqrstuvwxyz012345\nPAYNP_ENDPOINT=http://127.0.0.1:2\n");
    const reach = async (argv: string[]) => {
      const r = io();
      await run(argv, { io: r.io, cwd: dir });
      return /could not reach (\S+)/.exec(r.errText())?.[1];
    };
    expect(await reach(["test"])).toBe("http://127.0.0.1:2");
    process.env.PAYNP_ENDPOINT = "http://127.0.0.1:1";
    expect(await reach(["test"])).toBe("http://127.0.0.1:1");
    expect(await reach(["test", "--endpoint", "http://127.0.0.1:3/"])).toBe("http://127.0.0.1:3");
  });
});

describe("format", () => {
  it("one line per event, colored by status", () => {
    const e = { id: "evt_1", type: "error" as const, ts: "2026-11-05T10:00:00.120Z", attempt_id: "a1", gateway: "khalti", data: { reason: "amount_mismatch", message: "Khalti: amount mismatch (1000)" } };
    expect(formatEvent(e, false).split(/\s{2,}/).slice(1)).toEqual(["khalti", "error", "a1", "amount_mismatch: Khalti: amount mismatch (1000)"]);
    expect(formatEvent({ ...e, type: "payment.fulfilled", status: "paid", data: undefined }, true)).toContain("\x1b[32mpaid");
  });
});

describe("built binary", () => {
  it("dist/paynp.js runs on its own: --version, login, test", async () => {
    const root = join(import.meta.dirname, "..");
    await exec("npm", ["run", "build"], { cwd: root });
    const bin = join(root, "dist", "paynp.js");
    expect(readFileSync(bin, "utf8").startsWith("#!/usr/bin/env node\n")).toBe(true);
    const env = { ...process.env, XDG_CONFIG_HOME: home, PAYNP_NO_BROWSER: "1" };
    expect((await exec("node", [bin, "--version"], { env })).stdout.trim()).toBe("0.1.0");
    const login = await exec("node", [bin, "login", "--endpoint", api.url], { env });
    expect(login.stdout).toContain("Logged in as owner@shop.np");
    const dir = expressApp();
    await exec("node", [bin, "init", "--yes", "--skip-install"], { env, cwd: dir });
    const t = await exec("node", [bin, "test"], { env, cwd: dir });
    expect(t.stdout).toContain("Sent a test eSewa payment: 7 events");
  }, 60_000);
});

async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

// `paynp doctor` (SPEC-v2 4.4): every local check on small fixtures, the config readers, the server findings from a
// mock GET /api/projects/:p/doctor, human output (file snapshot), --json and the exit code.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DOCTOR_CHECKS, type DoctorReport } from "../../shared/src/ops.ts";
import { run } from "../src/cli.ts";
import { writeLink } from "../src/config.ts";
import { renderDoctor, type DoctorResult } from "../src/doctor/index.ts";
import { localDoctor, readScopes, secretName, wranglerTomlVars, type LocalReport } from "../src/doctor/static.ts";
import { detectStack } from "../src/stacks.ts";
import type { Io } from "../src/ui.ts";
import { blogApp, commitAll, git, write } from "./codemod/fixtures.ts";
import { startMockApi, type MockApi } from "./mock-api.ts";

const tmp = (files: Record<string, string>, opts: { git?: boolean } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "paynp-doctor-"));
  write(dir, files);
  if (opts.git) commitAll(dir);
  return dir;
};
const doctor = (dir: string) => localDoctor(dir, detectStack(dir));
const codes = (r: LocalReport) => r.findings.map((f) => `${f.severity}:${f.code}`);
const passed = (r: LocalReport) => r.passed.map((p) => p.code);

function io() {
  const out: string[] = [];
  const i: Io = { out: (s) => void out.push(s), err: (s) => void out.push(s), interactive: false, color: false, ask: async () => "" };
  return { io: i, text: () => out.join("\n") };
}

const PKG = { "package.json": '{"name":"shop","dependencies":{"express":"5.3.0"}}\n' };

describe("config readers", () => {
  it("env cascade per mode: .env < .env.production < .env.local < .env.production.local; examples ignored", () => {
    const dir = tmp({
      ".env": "A=base\nB=base\nPAYNP_KEY=pnp_test_x\n",
      ".env.production": "B=prod\nC=prod\n",
      ".env.local": "C=local\n",
      ".env.production.local": "D=prodlocal\n",
      ".env.example": "ESEWA_PRODUCT_CODE=EPAYTEST\n",
      ".env.development": "E=dev\n",
    });
    const { scopes, files } = readScopes(dir);
    expect(files).toEqual([".env", ".env.development", ".env.local", ".env.production", ".env.production.local"]);
    const prod = scopes.find((s) => s.name.includes(".env.production"))!;
    expect(prod.name).toBe(".env + .env.production + .env.local + .env.production.local");
    expect(prod.vars).toEqual({ A: "base", B: "prod", C: "local", D: "prodlocal", PAYNP_KEY: "pnp_test_x" });
    expect(prod.from.B).toBe(".env.production");
    expect(prod).toMatchObject({ production: true, why: ".env.production is the production config" });
    const dev = scopes.find((s) => s.name.includes("development"))!;
    expect(dev.production).toBe(false);
    expect(scopes.every((s) => !s.name.includes("example"))).toBe(true);
  });

  it("a lone .env is production when it holds a live key or NODE_ENV=production", () => {
    expect(readScopes(tmp({ ".env": "PAYNP_KEY=pnp_live_abc\n" })).scopes[0]).toMatchObject({ production: true, why: "PAYNP_KEY is a live key" });
    expect(readScopes(tmp({ ".env": "NODE_ENV=production\n" })).scopes[0]).toMatchObject({ production: true, why: "NODE_ENV=production" });
    expect(readScopes(tmp({ ".env": "PAYNP_KEY=pnp_test_abc\n" })).scopes[0].production).toBe(false);
  });

  it("wrangler.jsonc: top-level vars and env.<name>.vars, with comments and trailing commas", () => {
    const dir = tmp({
      "wrangler.jsonc": `{
  // deploy config
  "name": "shop",
  "vars": { "ESEWA_ENV": "sandbox", "PORT": 8787, },
  "env": { "staging": { "vars": { "BASE_URL": "http://staging.shop.np" } }, "production": { "vars": { "BASE_URL": "https://shop.np" } } },
}`,
    });
    const { scopes } = readScopes(dir);
    expect(scopes.map((s) => [s.name, s.production])).toEqual([
      ["wrangler.jsonc vars", true],
      ["wrangler.jsonc env.staging.vars", false],
      ["wrangler.jsonc env.production.vars", true],
    ]);
    expect(scopes[0].vars).toEqual({ ESEWA_ENV: "sandbox", PORT: "8787" });
  });

  it("wrangler.toml [vars] and [env.x.vars]", () => {
    expect(wranglerTomlVars(`name = "shop"\n[vars]\nESEWA_ENV = "production" # live\nBASE_URL = 'https://shop.np'\n[env.dev.vars]\nKHALTI_ENV = "sandbox"\n[[d1_databases]]\nbinding = "DB"\n`)).toEqual({
      "": { ESEWA_ENV: "production", BASE_URL: "https://shop.np" },
      dev: { KHALTI_ENV: "sandbox" },
    });
  });

  it("secret names: gateway keys and SECRET/PASSWORD/PRIVATE, not public keys", () => {
    for (const k of ["NEXT_PUBLIC_ESEWA_SECRET_KEY", "VITE_KHALTI_SECRET_KEY", "PUBLIC_PAYNP_KEY", "NEXT_PUBLIC_FONEPAY_SECRET_KEY", "VITE_DB_PASSWORD", "NEXT_PUBLIC_CONNECTIPS_PRIVATE_KEY_PEM", "PAYNP_ACTION_SECRET"]) expect([k, secretName(k)]).toEqual([k, true]);
    for (const k of ["NEXT_PUBLIC_KHALTI_PUBLIC_KEY", "NEXT_PUBLIC_SITE_URL", "VITE_RECAPTCHA_SITE_KEY", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "ESEWA_ENV"]) expect([k, secretName(k)]).toEqual([k, false]);
  });
});

describe("local checks", () => {
  it("sandbox gateway in production: public sandbox values and *_ENV=sandbox are critical, a missing *_ENV a warning", () => {
    const r = doctor(
      tmp({
        ...PKG,
        ".env.production": "PAYNP_KEY=pnp_live_abc\nESEWA_PRODUCT_CODE=EPAYTEST\nESEWA_SECRET_KEY=8gBm/:&EnhH.1/q\nKHALTI_ENV=sandbox\nKHALTI_SECRET_KEY=live_secret_x\nFONEPAY_MERCHANT_CODE=REALPID\n",
      }),
    );
    const sandbox = r.findings.filter((f) => f.code === "sandbox_gateway_config");
    expect(sandbox.map((f) => f.severity)).toEqual(["critical", "critical", "warning"]);
    expect(sandbox[0].detail).toContain("ESEWA_PRODUCT_CODE=EPAYTEST is eSewa's public sandbox value");
    expect(sandbox[0].detail).toContain("ESEWA_SECRET_KEY=(the public sandbox key)");
    expect(sandbox[0].detail).toContain("this config is production (.env.production is the production config)");
    expect(sandbox[1].detail).toContain("Khalti runs against its sandbox here (KHALTI_ENV=sandbox)");
    expect(sandbox[2]).toMatchObject({ severity: "warning", detail: expect.stringContaining("FONEPAY_ENV is not set here") });
    // secret values never reach the output
    expect(JSON.stringify(r)).not.toContain("8gBm");
    expect(JSON.stringify(r)).not.toContain("live_secret_x");
  });

  it("gateway code in a production config without *_ENV=production is a warning; with it, passed", () => {
    const app = blogApp("express");
    write(app, { ".env.production": "PAYNP_KEY=pnp_live_abc\n" });
    expect(codes(doctor(app))).toContain("warning:sandbox_gateway_config");
    write(app, { ".env.production": "PAYNP_KEY=pnp_live_abc\nESEWA_ENV=production\n" });
    const r = doctor(app);
    expect(codes(r).filter((c) => c.includes("sandbox_gateway_config"))).toEqual([]);
    expect(passed(r)).toContain("sandbox_gateway_config");
  });

  it("*_ENV=production with sandbox credentials, and *_ENV=sandbox with a production URL, disagree (any config)", () => {
    const r = doctor(tmp({ ...PKG, ".env": "ESEWA_ENV=production\nESEWA_PRODUCT_CODE=EPAYTEST\nNPS_ENV=sandbox\nNPS_API_URL=https://apigateway.nepalpayment.com\n" }));
    expect(codes(r)).toEqual(["critical:gateway_env_mismatch", "critical:gateway_env_mismatch"]);
    expect(r.findings[0].detail).toBe("ESEWA_ENV=production, but ESEWA_PRODUCT_CODE=EPAYTEST is eSewa's public sandbox value.");
    expect(r.findings[1].detail).toContain("NPS_API_URL=https://apigateway.nepalpayment.com points at production");
    expect(doctor(tmp({ ...PKG, ".env": "ESEWA_ENV=sandbox\nESEWA_PRODUCT_CODE=EPAYTEST\n" })).findings).toEqual([]);
  });

  it("a test paynp key in production config is a warning", () => {
    const r = doctor(tmp({ ...PKG, ".env.production": "PAYNP_KEY=pnp_test_abc\n" }));
    expect(codes(r)).toEqual(["warning:test_key_in_production"]);
  });

  it("http and localhost return/base URLs in production config are critical; https passes; dev config is not checked", () => {
    const r = doctor(tmp({ ...PKG, ".env": "BASE_URL=http://localhost:3000\n", ".env.production": "BASE_URL=http://shop.example.com\nKHALTI_WEBSITE_URL=http://localhost:3000\nESEWA_STATUS_URL=http://rc.esewa.com.np/x\n" }));
    // ESEWA_STATUS_URL is a sandbox host, so that is a sandbox finding, not an http one
    expect(codes(r).filter((c) => c.includes("http_return_url"))).toEqual(["critical:http_return_url", "critical:http_return_url"]);
    r.findings = r.findings.filter((f) => f.code === "http_return_url");
    expect(r.findings[0]).toMatchObject({ where: ".env.production", detail: expect.stringContaining("BASE_URL=http://shop.example.com is plain http") });
    expect(r.findings[1].detail).toContain("KHALTI_WEBSITE_URL=http://localhost:3000 points at this machine");
    const ok = doctor(tmp({ ...PKG, ".env": "BASE_URL=http://localhost:3000\n", ".env.production": "BASE_URL=https://shop.example.com\n" }));
    expect(codes(ok)).toEqual([]);
    expect(passed(ok)).toContain("http_return_url");
    const dev = doctor(tmp({ ...PKG, ".env": "BASE_URL=http://localhost:3000\n" }));
    expect(dev.skipped.map((s) => s.code)).toContain("http_return_url");
  });

  it("secrets in client bundles: client-prefixed env vars, code that reads them, next.config env", () => {
    const r = doctor(
      tmp({
        "package.json": '{"name":"shop","dependencies":{"next":"16.4.5"}}\n',
        ".env.local": "NEXT_PUBLIC_ESEWA_SECRET_KEY=abc\nNEXT_PUBLIC_KHALTI_PUBLIC_KEY=pub\nNEXT_PUBLIC_SITE_URL=https://shop.np\n",
        "app/pay.tsx": "export const k = import.meta.env.VITE_KHALTI_SECRET_KEY;\nexport const ok = process.env.NEXT_PUBLIC_SITE_URL;\n",
        "next.config.ts": "export default { env: { FONEPAY_SECRET_KEY: process.env.FONEPAY_SECRET_KEY, SITE: 'x' } };\n",
      }),
    );
    expect(r.findings.filter((f) => f.code === "secret_in_client_bundle").map((f) => [f.where, f.detail.split(":")[0].split(" ")[0]])).toEqual([
      [".env.local", "NEXT_PUBLIC_ESEWA_SECRET_KEY"],
      ["app/pay.tsx", "The"],
      ["next.config.ts", "FONEPAY_SECRET_KEY"],
    ]);
    expect(r.findings[1].detail).toContain("VITE_KHALTI_SECRET_KEY");
    expect(JSON.stringify(r)).not.toContain("=abc");
  });

  it("action route without PAYNP_ACTION_SECRET: warning; an empty placeholder counts as missing; set passes", () => {
    const route = { ...PKG, "server.ts": 'app.post("/paynp/actions", paynp.nodeActionHandler(actions));\n' };
    expect(codes(doctor(tmp({ ...route, ".env": "PAYNP_ACTION_SECRET=\n" })))).toEqual(["warning:action_route_without_secret"]);
    const workers = doctor(tmp({ ...route, "wrangler.toml": 'name = "x"\n' }));
    expect(workers.findings[0].fix).toContain("wrangler secret put PAYNP_ACTION_SECRET");
    const ok = doctor(tmp({ ...route, ".env": "PAYNP_ACTION_SECRET=whsec_1\n" }));
    expect(ok.passed.find((p) => p.code === "action_route_without_secret")?.line).toBe("The action route (server.ts) has PAYNP_ACTION_SECRET.");
    expect(doctor(tmp(PKG)).passed.find((p) => p.code === "action_route_without_secret")?.line).toContain("No action route");
  });

  it("gateway modules not wrapped: one warning listing the files; passed once init wired them", async () => {
    const app = blogApp("express");
    const r = doctor(app);
    expect(r.findings.filter((f) => f.code === "gateway_not_wrapped")).toEqual([
      expect.objectContaining({ severity: "warning", where: "server.ts", fix: "Run `paynp init` (it shows the diff first)." }),
    ]);
    expect(await run(["init", "--dry-run"], { io: io().io, cwd: app })).toBe(0);
    const { applyPlan, planWiring } = await import("../src/codemod/plan.ts");
    applyPlan(app, planWiring(app, { stack: "express" }));
    const after = doctor(app);
    expect(codes(after)).toEqual([]);
    expect(after.passed.find((p) => p.code === "gateway_not_wrapped")?.line).toBe("Every gateway import goes through paynp (payments.ts, server.ts).");
    // named imports are reported with the manual step
    const named = doctor(tmp({ ...PKG, "esewa.ts": "export async function startPayment() {}\n", "server.ts": 'import { startPayment } from "./esewa";\nvoid startPayment;\n' }));
    expect(named.findings[0]).toMatchObject({ code: "gateway_not_wrapped", where: "server.ts" });
    expect(named.findings[0].fix).toContain("by hand:");
  });

  it("an env file with secrets tracked by git is critical; sandbox-only values are not secrets", () => {
    const dir = tmp({ ...PKG, ".env": "KHALTI_SECRET_KEY=live_x\n", ".env.example": "KHALTI_SECRET_KEY=\n", ".gitignore": "" }, { git: true });
    const r = doctor(dir);
    expect(r.findings.find((f) => f.code === "env_file_committed")).toMatchObject({ severity: "critical", where: ".env", detail: expect.stringContaining("KHALTI_SECRET_KEY") });
    const sandboxOnly = tmp({ ...PKG, ".env": "ESEWA_SECRET_KEY=8gBm/:&EnhH.1/q\nESEWA_PRODUCT_CODE=EPAYTEST\n" }, { git: true });
    expect(passed(doctor(sandboxOnly))).toContain("env_file_committed");
    git(dir, "rm", "-q", "--cached", ".env");
    expect(passed(doctor(dir))).toContain("env_file_committed");
    expect(doctor(tmp(PKG)).skipped.map((s) => s.code)).toContain("env_file_committed");
  });

  it("wrangler deploy vars count as production", () => {
    const r = doctor(tmp({ ...PKG, "wrangler.jsonc": '{ "vars": { "KHALTI_ENV": "sandbox", "BASE_URL": "http://shop.np" } }' }));
    expect(codes(r)).toEqual(["critical:sandbox_gateway_config", "critical:http_return_url"]);
    expect(r.findings[0].where).toBe("wrangler.jsonc vars");
  });

  it("a clean production setup passes every check", async () => {
    const app = blogApp("express");
    const { applyPlan, planWiring } = await import("../src/codemod/plan.ts");
    applyPlan(app, planWiring(app, { stack: "express" }));
    write(app, { ".env.production": "PAYNP_KEY=pnp_live_abc\nESEWA_ENV=production\nESEWA_PRODUCT_CODE=NP-ES-SHOP\nBASE_URL=https://shop.np\n" });
    const r = doctor(app);
    expect(r.findings).toEqual([]);
    expect(passed(r)).toEqual([
      "sandbox_gateway_config",
      "gateway_env_mismatch",
      "test_key_in_production",
      "http_return_url",
      "secret_in_client_bundle",
      "action_route_without_secret",
      "gateway_not_wrapped",
      "env_file_committed",
    ]);
  });
});

// ---------------------------------------------------------------- the command

const T = Date.UTC(2026, 10, 5, 6, 0, 0);
const finding = (code: keyof typeof DOCTOR_CHECKS, extra: Partial<DoctorReport["findings"][number]> = {}): DoctorReport["findings"][number] => {
  const c = DOCTOR_CHECKS[code];
  return { code, severity: c.severity, gateway: "esewa", title: c.title, why: c.why, fix: c.fix, docs_url: c.docs_url, count: 3, first_seen: T - 7200_000, last_seen: T - 3600_000, example_attempt: "att_01", resolved_at: null, ...extra };
};
const report = (findings: DoctorReport["findings"]): DoctorReport => ({
  env: "live",
  critical: findings.filter((f) => f.severity === "critical").length,
  warnings: findings.filter((f) => f.severity === "warning").length,
  findings,
  passed: [
    { code: "signature_failures", severity: "critical", title: DOCTOR_CHECKS.signature_failures.title, status: "passed", line: DOCTOR_CHECKS.signature_failures.passed },
    { code: "no_reconcile", severity: "warning", title: DOCTOR_CHECKS.no_reconcile.title, status: "not_checked", line: "Needs an hour of live traffic first." },
  ],
});

describe("paynp doctor", () => {
  let api: MockApi;
  beforeAll(() => {
    process.env.PAYNP_NO_BROWSER = "1";
  });
  beforeEach(async () => {
    process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "paynp-home-"));
    delete process.env.PAYNP_ENDPOINT;
    delete process.env.PAYNP_ACTION_SECRET;
    api = await startMockApi();
  });
  afterEach(() => api.close());
  afterAll(() => {
    delete process.env.XDG_CONFIG_HOME;
  });
  const login = async () => expect(await run(["login", "--endpoint", api.url], { io: io().io, cwd: tmpdir() })).toBe(0);

  it("human output: findings with fixes, passed and skipped lines, the summary (snapshot)", async () => {
    const dir = tmp({ ...PKG, ".env.production": "PAYNP_KEY=pnp_live_abc\nESEWA_ENV=production\nESEWA_PRODUCT_CODE=EPAYTEST\nBASE_URL=http://shop.np\n", "server.ts": "export {};\n" });
    const r: DoctorResult = {
      local: localDoctor(dir, detectStack(dir)),
      server: { state: "ok", project: "prj_shop", report: report([finding("sandbox_gateway_in_live", { count: 14 }), finding("no_reconcile", { gateway: null, example_attempt: null, count: 1 })]) },
      critical: 0,
      warnings: 0,
    };
    r.critical = r.local.findings.filter((f) => f.severity === "critical").length + 1;
    r.warnings = r.local.findings.filter((f) => f.severity === "warning").length + 1;
    const text = renderDoctor(r, { color: false, cwd: "/srv/shop", endpoint: "https://paynp.discerns.app", now: T });
    await expect(text + "\n").toMatchFileSnapshot(join(import.meta.dirname, "__snapshots__", "doctor.txt"));
    expect(text).not.toMatch(/[\u2013\u2014\u2026]/);
  });

  it("exit 1 on a local critical, 0 with only warnings; server skipped when not logged in", async () => {
    const bad = tmp({ ...PKG, ".env.production": "PAYNP_KEY=pnp_live_x\nBASE_URL=http://shop.np\n" });
    const r = io();
    expect(await run(["doctor"], { io: r.io, cwd: bad })).toBe(1);
    expect(r.text()).toContain("CRITICAL  Return URL is not https in production config");
    expect(r.text()).toContain("skipped   not logged in and this folder is not linked. Run paynp login, then paynp init.");
    expect(r.text()).toContain("1 critical, 0 warnings. Fix the critical ones before going live.");
    expect(r.text()).not.toContain("paynp: "); // no error line, just the exit code

    const warn = tmp({ ...PKG, ".env.production": "PAYNP_KEY=pnp_test_x\n" });
    const w = io();
    expect(await run(["doctor"], { io: w.io, cwd: warn })).toBe(0);
    expect(w.text()).toContain("0 critical, 1 warning. Nothing blocks a go-live");
  });

  it("--json: counts, local findings and the server part", async () => {
    const dir = tmp({ ...PKG, ".env.production": "PAYNP_KEY=pnp_live_x\nNEXT_PUBLIC_ESEWA_SECRET_KEY=s\n" });
    const r = io();
    expect(await run(["doctor", "--json", "--local"], { io: r.io, cwd: dir })).toBe(1);
    const j = JSON.parse(r.text());
    expect(j).toMatchObject({ critical: 1, warnings: 0, ok: false, server: { state: "skipped", reason: "--local" } });
    expect(j.local.findings[0]).toMatchObject({ code: "secret_in_client_bundle", severity: "critical", where: ".env.production" });
    expect(j.local.passed.length).toBeGreaterThan(3);
  });

  it("logged in and linked: prints the server findings for live, and a server critical alone exits 1", async () => {
    await login();
    const dir = tmp({ ...PKG, ".env": "PAYNP_KEY=pnp_test_x\n" });
    writeLink(dir, { org: "org_1", project: "prj_existing" });
    api.state.doctor["prj_existing|live"] = report([finding("http_return_url", { count: 9 })]);
    const r = io();
    expect(await run(["doctor", "--endpoint", api.url], { io: r.io, cwd: dir })).toBe(1);
    expect(api.state.doctorRequests).toEqual(["prj_existing|live"]);
    const t = r.text();
    expect(t).toContain(`Live traffic  (project prj_existing, live env, ${api.url})`);
    expect(t).toContain("CRITICAL  Return URL is plain http  http_return_url");
    expect(t).toMatch(/9 times, last \d+[smhd] ago, gateway esewa, e\.g\. attempt att_01/);
    expect(t).toContain("fix: Use an https BASE_URL for success and failure URLs in production.");
    expect(t).toContain("ok        No bursts of failed signature checks.");
    expect(t).toContain("skipped   Needs an hour of live traffic first.");

    // --env test asks for test; resolved findings don't count
    api.state.doctor["prj_existing|test"] = report([finding("double_fulfilment", { resolved_at: T })]);
    const r2 = io();
    expect(await run(["doctor", "--env", "test", "--json", "--endpoint", api.url], { io: r2.io, cwd: dir })).toBe(0);
    expect(JSON.parse(r2.text())).toMatchObject({ critical: 0, server: { state: "ok", env: "live" } });
    expect(api.state.doctorRequests.at(-1)).toBe("prj_existing|test");
  });

  it("server errors are reported and never fail the run on their own", async () => {
    await login();
    const dir = tmp(PKG);
    writeLink(dir, { org: "org_1", project: "prj_existing" });
    const r = io();
    expect(await run(["doctor", "--endpoint", api.url], { io: r.io, cwd: dir })).toBe(0);
    expect(r.text()).toContain("Live traffic  (could not load)");
    expect(r.text()).toContain("no doctor on");

    const unlinked = tmp(PKG);
    const r2 = io();
    expect(await run(["doctor", "--endpoint", api.url], { io: r2.io, cwd: unlinked })).toBe(0);
    expect(r2.text()).toContain("this folder is not linked to a project. Run paynp init.");

    writeLink(unlinked, { org: "org_1", project: "prj_existing" });
    process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "paynp-home-"));
    const r3 = io();
    expect(await run(["doctor", "--endpoint", api.url], { io: r3.io, cwd: unlinked })).toBe(0);
    expect(r3.text()).toContain(`not logged in to ${api.url}. Run paynp login --endpoint ${api.url}.`);
  });
});

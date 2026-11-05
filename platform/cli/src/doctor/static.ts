// `paynp doctor`, the local half (SPEC-v2 section 4.4): reads env files, wrangler config and the code, and flags
// what breaks a go-live. No network. Values are never printed unless they are public (sandbox constants from the
// gateways' docs, *_ENV values, URLs).
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gwEnvOf } from "../../../sdk-ts/src/env.ts";
import { parseEnv } from "../envfile.ts";
import { parseJsonc, sourceFiles } from "../codemod/files.ts";
import { planWiring } from "../codemod/plan.ts";
import { GATEWAY_NAMES } from "../codemod/templates.ts";
import type { Stack } from "../stacks.ts";

export type Severity = "critical" | "warning";

export interface LocalFinding {
  code: LocalCode;
  severity: Severity;
  title: string;
  /** File (and section) the finding is about. */
  where: string;
  detail: string;
  fix: string;
}

export const LOCAL_CHECKS = {
  sandbox_gateway_config: { title: "Sandbox gateway in production config", passed: "Production config points every gateway at production." },
  gateway_env_mismatch: { title: "Gateway mode and credentials disagree", passed: "Each gateway's *_ENV matches its credentials and URLs." },
  test_key_in_production: { title: "Test paynp key in production config", passed: "Production config uses a live paynp key (or none here)." },
  http_return_url: { title: "Return URL is not https in production config", passed: "Return and base URLs in production config are https." },
  secret_in_client_bundle: { title: "Secret exposed to the browser bundle", passed: "No secret is exposed through NEXT_PUBLIC_, VITE_, PUBLIC_ or next.config env." },
  action_route_without_secret: { title: "Action route without PAYNP_ACTION_SECRET", passed: "The action route has PAYNP_ACTION_SECRET, or there is no action route." },
  gateway_not_wrapped: { title: "Gateway code not reported to paynp", passed: "Every gateway module and adapter import goes through paynp." },
  env_file_committed: { title: "Env file with secrets is committed to git", passed: "No env file with secrets is tracked by git." },
} as const;
export type LocalCode = keyof typeof LOCAL_CHECKS;

export interface LocalReport {
  findings: LocalFinding[];
  passed: { code: LocalCode; line: string }[];
  /** Checks that could not run here, with the reason. */
  skipped: { code: LocalCode; line: string }[];
  /** Files that were read. */
  sources: string[];
}

// ---------------------------------------------------------------- config sources

/** One set of variables that is in force together: an env file cascade, or one wrangler environment. */
export interface Scope {
  name: string;
  vars: Record<string, string>;
  /** Where each variable came from. */
  from: Record<string, string>;
  /** Named or keyed as production: live paynp key, NODE_ENV=production, .env.production, wrangler deploy vars. */
  production: boolean;
  /** Why it counts as production, for messages. */
  why?: string;
}

const EXAMPLE = /\.(example|sample|template|dist|defaults?)$/i;

function envFiles(cwd: string): string[] {
  let names: string[] = [];
  try {
    names = readdirSync(cwd).filter((f) => (f === ".env" || f.startsWith(".env.")) && !EXAMPLE.test(f));
  } catch {
    /* unreadable */
  }
  return names.sort();
}

const read = (p: string): string | null => {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
};

/** Minimal TOML for wrangler: `[vars]` and `[env.<name>.vars]` tables with string values. */
export function wranglerTomlVars(text: string): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  let section: string | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, "").trim();
    if (!line || line.startsWith("#")) continue;
    const h = /^\[\[?\s*([^\]]+?)\s*\]\]?$/.exec(line);
    if (h) {
      if (line.startsWith("[[")) {
        section = null; // an array of tables ([[d1_databases]]) never holds vars
        continue;
      }
      const m = /^(?:env\.([A-Za-z0-9_-]+)\.)?vars$/.exec(h[1]);
      section = m ? (m[1] ?? "") : null;
      continue;
    }
    if (section === null) continue;
    const kv = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+))$/.exec(line);
    if (kv) (out[section] ??= {})[kv[1]] = kv[2] ?? kv[3] ?? kv[4];
  }
  return out;
}

function wranglerVars(cwd: string): { file: string; envs: Record<string, Record<string, string>> } | null {
  for (const f of ["wrangler.jsonc", "wrangler.json"]) {
    const text = read(join(cwd, f));
    if (text === null) continue;
    try {
      const cfg = parseJsonc(text) as { vars?: Record<string, unknown>; env?: Record<string, { vars?: Record<string, unknown> }> };
      const str = (o?: Record<string, unknown>) => Object.fromEntries(Object.entries(o ?? {}).flatMap(([k, v]) => (typeof v === "string" ? [[k, v]] : typeof v === "number" || typeof v === "boolean" ? [[k, String(v)]] : [])));
      const envs: Record<string, Record<string, string>> = { "": str(cfg.vars) };
      for (const [name, e] of Object.entries(cfg.env ?? {})) envs[name] = str(e?.vars);
      return { file: f, envs };
    } catch {
      return { file: f, envs: {} };
    }
  }
  const toml = read(join(cwd, "wrangler.toml"));
  if (toml !== null) return { file: "wrangler.toml", envs: wranglerTomlVars(toml) };
  return null;
}

const isLiveKey = (v: string | undefined) => !!v && v.startsWith("pnp_live_");

function scope(name: string, layers: [string, Record<string, string>][], named: boolean, namedWhy: string): Scope {
  const vars: Record<string, string> = {};
  const from: Record<string, string> = {};
  for (const [file, v] of layers) {
    for (const [k, val] of Object.entries(v)) {
      vars[k] = val;
      from[k] = file;
    }
  }
  let why: string | undefined = named ? namedWhy : undefined;
  if (!why && isLiveKey(vars.PAYNP_KEY)) why = "PAYNP_KEY is a live key";
  if (!why && vars.NODE_ENV === "production") why = "NODE_ENV=production";
  if (!why && vars.PAYNP_ENV === "production") why = "PAYNP_ENV=production";
  return { name, vars, from, production: !!why, why };
}

/**
 * The env scopes, the way Next.js, Vite and dotenv-flow load them: `.env` < `.env.<mode>` < `.env.local` <
 * `.env.<mode>.local`. One scope per mode that has a file; `.env` (+ `.env.local`) alone when there is none.
 * Wrangler: one scope per environment (top-level vars are what `wrangler deploy` uses, so production).
 */
export function readScopes(cwd: string): { scopes: Scope[]; files: string[] } {
  const files = envFiles(cwd);
  const parsed = new Map(files.map((f) => [f, parseEnv(read(join(cwd, f)) ?? "")]));
  const layer = (f: string): [string, Record<string, string>][] => (parsed.has(f) ? [[f, parsed.get(f)!]] : []);
  const modes = new Set<string>();
  for (const f of files) {
    const m = /^\.env\.([^.]+)(\.local)?$/.exec(f);
    if (m && m[1] !== "local") modes.add(m[1]);
  }
  const scopes: Scope[] = [];
  for (const mode of [...modes].sort()) {
    const layers = [...layer(".env"), ...layer(`.env.${mode}`), ...(mode === "test" ? [] : layer(".env.local")), ...layer(`.env.${mode}.local`)];
    const prod = /^(prod|production|live)$/.test(mode);
    scopes.push(scope(layers.map((l) => l[0]).join(" + "), layers, prod, `.env.${mode} is the production config`));
  }
  if (!modes.size && (parsed.has(".env") || parsed.has(".env.local"))) {
    const layers = [...layer(".env"), ...layer(".env.local")];
    scopes.push(scope(layers.map((l) => l[0]).join(" + "), layers, false, ""));
  }
  const w = wranglerVars(cwd);
  const used = [...files];
  if (w) {
    used.push(w.file);
    for (const [env, vars] of Object.entries(w.envs)) {
      const label = env ? `${w.file} env.${env}.vars` : `${w.file} vars`;
      const prod = env === "" || /prod|live/i.test(env);
      scopes.push(scope(label, [[label, vars]], prod, env ? `wrangler env "${env}"` : "wrangler deploy uses these vars"));
    }
  }
  return { scopes, files: used };
}

// ---------------------------------------------------------------- gateway facts

const PREFIX: Record<string, string> = { esewa: "ESEWA_", khalti: "KHALTI_", fonepay: "FONEPAY_", connectips: "CONNECTIPS_", cybersource: "CYBERSOURCE_", nps: "NPS_", imepay: "IMEPAY_" };

/** Values published in the gateways' docs for their sandboxes (references/*.md). Safe to print. */
const PUBLIC_SANDBOX: Record<string, Record<string, string>> = {
  esewa: { ESEWA_PRODUCT_CODE: "EPAYTEST", ESEWA_SECRET_KEY: "8gBm/:&EnhH.1/q", ESEWA_INTENT_PRODUCT_CODE: "INTENT", ESEWA_INTENT_ACCESS_KEY: "LB0REg8HUSw3MTYrI1s6JTE8Kyc6JyAqJiA3MQ==" },
  fonepay: { FONEPAY_MERCHANT_CODE: "NBQM", FONEPAY_PID: "NBQM", FONEPAY_SECRET_KEY: "a7e3512f5032480a83137793cb2021dc" },
};

const PRODUCTION_MODE = /^(production|live|prod)$/i;
const SANDBOX_MODE = /^(sandbox|test|testing|uat|dev|development|staging|stg)$/i;

interface GatewaySignals {
  configured: boolean;
  mode: string | undefined;
  /** "ESEWA_PRODUCT_CODE=EPAYTEST is eSewa's public sandbox product code" style lines. */
  sandbox: string[];
  production: string[];
}

function signals(s: Scope, gw: string): GatewaySignals {
  const pre = PREFIX[gw];
  const keys = Object.keys(s.vars).filter((k) => k.startsWith(pre) && s.vars[k] !== "");
  const out: GatewaySignals = { configured: keys.some((k) => k !== `${pre}ENV`), mode: s.vars[`${pre}ENV`] || undefined, sandbox: [], production: [] };
  const name = GATEWAY_NAMES[gw];
  for (const k of keys) {
    const v = s.vars[k];
    if (PUBLIC_SANDBOX[gw]?.[k] === v) out.sandbox.push(`${k}=${k.includes("SECRET") || k.includes("ACCESS_KEY") ? "(the public sandbox key)" : v} is ${name}'s public sandbox value`);
    if (/^https?:\/\//.test(v)) {
      const env = gwEnvOf(v);
      if (env === "sandbox") out.sandbox.push(`${k}=${v} is a ${name} sandbox host`);
      if (env === "production") out.production.push(`${k}=${v}`);
    }
  }
  return out;
}

// ---------------------------------------------------------------- checks

const CLIENT_PREFIXES = ["NEXT_PUBLIC_", "VITE_", "PUBLIC_", "REACT_APP_", "EXPO_PUBLIC_", "NUXT_PUBLIC_", "GATSBY_"];
const clientPrefix = (name: string) => CLIENT_PREFIXES.find((p) => name.startsWith(p));
const GATEWAY_SECRET = /^(PAYNP_KEY|PAYNP_ACTION_SECRET|(ESEWA|KHALTI|FONEPAY|CONNECTIPS|CYBERSOURCE|NPS|IMEPAY)_.*(SECRET|KEY|PASSWORD|PEM|PFX|ACCESS))/;

/** Is this variable name (prefix stripped) a secret? Public keys (Khalti's mobile SDK key, reCAPTCHA site keys) are not. */
export function secretName(name: string): boolean {
  const bare = clientPrefix(name) ? name.slice(clientPrefix(name)!.length) : name;
  if (/PUBLIC_KEY|PUBLISHABLE|SITE_KEY|ANON_KEY/.test(bare)) return false;
  return GATEWAY_SECRET.test(bare) || /SECRET|PRIVATE|PASSWORD|PASSWD/.test(bare);
}

const URL_NAME = /(^|_)(BASE|APP|SITE|WEBSITE|PUBLIC|RETURN|SUCCESS|FAILURE|CALLBACK|REDIRECT|RESPONSE|CANCEL|RESP)(_PUBLIC)?_URL$|^(BASE_URL|APP_URL|SITE_URL|PUBLIC_URL|ORIGIN|NEXTAUTH_URL)$/;

function checkGatewayConfig(scopes: Scope[], codeGateways: Set<string>, add: (f: LocalFinding) => void): void {
  for (const s of scopes) {
    for (const gw of Object.keys(PREFIX)) {
      const sig = signals(s, gw);
      const name = GATEWAY_NAMES[gw];
      const envVar = `${PREFIX[gw]}ENV`;
      const used = sig.configured || sig.mode !== undefined || codeGateways.has(gw);
      if (!used) continue;
      const modeProd = sig.mode !== undefined && PRODUCTION_MODE.test(sig.mode);
      const modeSandbox = sig.mode !== undefined && SANDBOX_MODE.test(sig.mode);
      // *_ENV=production with sandbox credentials or hosts: the gateway rejects the signature or the key.
      if (modeProd && sig.sandbox.length) {
        add({
          code: "gateway_env_mismatch",
          severity: "critical",
          title: LOCAL_CHECKS.gateway_env_mismatch.title,
          where: s.name,
          detail: `${envVar}=${sig.mode}, but ${sig.sandbox.join("; ")}.`,
          fix: `Put the production credentials from ${name} in ${s.name}, or set ${envVar}=sandbox while testing.`,
        });
        continue;
      }
      if (modeSandbox && sig.production.length) {
        add({
          code: "gateway_env_mismatch",
          severity: "critical",
          title: LOCAL_CHECKS.gateway_env_mismatch.title,
          where: s.name,
          detail: `${envVar}=${sig.mode}, but ${sig.production.join(", ")} points at production.`,
          fix: `Use one environment for ${name}: sandbox hosts and keys with ${envVar}=sandbox, production with ${envVar}=production.`,
        });
        continue;
      }
      if (!s.production) continue;
      if (modeSandbox || sig.sandbox.length) {
        const reasons = [...(modeSandbox ? [`${envVar}=${sig.mode}`] : []), ...sig.sandbox];
        add({
          code: "sandbox_gateway_config",
          severity: "critical",
          title: LOCAL_CHECKS.sandbox_gateway_config.title,
          where: s.name,
          detail: `${name} runs against its sandbox here (${reasons.join("; ")}), and this config is production (${s.why}). Live payments would never move real money.`,
          fix: `Set ${envVar}=production and the production credentials ${name} issued at onboarding.`,
        });
      } else if (sig.mode === undefined && (sig.configured || codeGateways.has(gw))) {
        add({
          code: "sandbox_gateway_config",
          severity: "warning",
          title: LOCAL_CHECKS.sandbox_gateway_config.title,
          where: s.name,
          detail: `${envVar} is not set here, and the gateway modules use the sandbox unless it is "production". This config is production (${s.why}).`,
          fix: `Add ${envVar}=production here, or confirm it is set on the host.`,
        });
      }
    }
  }
}

function checkKeysAndUrls(scopes: Scope[], add: (f: LocalFinding) => void): void {
  for (const s of scopes) {
    if (!s.production) continue;
    const key = s.vars.PAYNP_KEY;
    if (key && key.startsWith("pnp_test_") && !/PAYNP_KEY/.test(s.why ?? "")) {
      add({
        code: "test_key_in_production",
        severity: "warning",
        title: LOCAL_CHECKS.test_key_in_production.title,
        where: s.name,
        detail: `PAYNP_KEY is a test key (pnp_test_...) in production config (${s.why}). Live payments would show up under test, and live alerts would never fire.`,
        fix: "Create a live key (paynp keys create --env live) and set it as PAYNP_KEY on the production host.",
      });
    }
    for (const [k, v] of Object.entries(s.vars)) {
      if (!URL_NAME.test(k) || !/^https?:\/\//i.test(v) || gwEnvOf(v)) continue;
      let host = "";
      try {
        host = new URL(v).hostname;
      } catch {
        continue;
      }
      const local = host === "localhost" || host.endsWith(".localhost") || /^127\./.test(host) || host === "[::1]" || host === "0.0.0.0";
      if (v.toLowerCase().startsWith("https://") && !local) continue;
      add({
        code: "http_return_url",
        severity: "critical",
        title: LOCAL_CHECKS.http_return_url.title,
        where: `${s.from[k] ?? s.name}`,
        detail: local
          ? `${k}=${v} points at this machine, in production config (${s.why}). Buyers would be sent back to localhost after paying.`
          : `${k}=${v} is plain http in production config (${s.why}). Gateways send the buyer back over it; some refuse http, and the callback can be changed in transit.`,
        fix: `Set ${k} to the public https URL of the site.`,
      });
    }
  }
}

function checkClientSecrets(cwd: string, scopes: Scope[], files: string[], add: (f: LocalFinding) => void): void {
  const seen = new Set<string>();
  for (const s of scopes) {
    for (const k of Object.keys(s.vars)) {
      const p = clientPrefix(k);
      if (!p || !secretName(k) || seen.has(k)) continue;
      seen.add(k);
      add({
        code: "secret_in_client_bundle",
        severity: "critical",
        title: LOCAL_CHECKS.secret_in_client_bundle.title,
        where: s.from[k] ?? s.name,
        detail: `${k}: variables starting with ${p} are compiled into the JavaScript every visitor downloads.`,
        fix: `Rename it without ${p} and read it only on the server. If it was ever deployed, rotate the secret.`,
      });
    }
  }
  // Source code reading a client-prefixed secret.
  const ref = /\b(?:process\.env|import\.meta\.env)\.([A-Z][A-Z0-9_]*)/g;
  for (const f of files) {
    const text = read(f);
    if (!text) continue;
    for (const m of text.matchAll(ref)) {
      const k = m[1];
      if (!clientPrefix(k) || !secretName(k) || seen.has(k)) continue;
      seen.add(k);
      add({
        code: "secret_in_client_bundle",
        severity: "critical",
        title: LOCAL_CHECKS.secret_in_client_bundle.title,
        where: rel(cwd, f),
        detail: `The code reads ${k}; the bundler inlines ${clientPrefix(k)} variables into the browser bundle.`,
        fix: `Move the call that needs ${k} to a server route and rename the variable without ${clientPrefix(k)}.`,
      });
    }
  }
  // next.config env: every key there is inlined into the client bundle too.
  for (const f of ["next.config.js", "next.config.mjs", "next.config.ts", "next.config.cjs", "next.config.mts"]) {
    const text = read(join(cwd, f));
    if (!text) continue;
    const block = /\benv\s*:\s*\{([^}]*)\}/.exec(text);
    if (!block) continue;
    for (const m of block[1].matchAll(/(?:^|[,{\s])["']?([A-Z][A-Z0-9_]*)["']?\s*:/g)) {
      const k = m[1];
      if (!secretName(k) || seen.has(`next:${k}`)) continue;
      seen.add(`next:${k}`);
      add({
        code: "secret_in_client_bundle",
        severity: "critical",
        title: LOCAL_CHECKS.secret_in_client_bundle.title,
        where: f,
        detail: `${k} is listed under \`env\` in ${f}; Next.js inlines those values into the client bundle.`,
        fix: `Remove ${k} from \`env\` in ${f}; server code reads process.env.${k} without it.`,
      });
    }
  }
}

const rel = (cwd: string, f: string) => (f.startsWith(cwd) ? f.slice(cwd.length + 1) : f).split("\\").join("/");

const ACTION_ROUTE = /\b(?:nodeActionHandler|actionHandler)\s*\(|["'`]\/paynp\/actions["'`]/;

function checkActionSecret(cwd: string, scopes: Scope[], files: string[], hasWrangler: boolean, add: (f: LocalFinding) => void, pass: (c: LocalCode, line: string) => void): void {
  const route = files.find((f) => ACTION_ROUTE.test(read(f) ?? ""));
  if (!route) return pass("action_route_without_secret", "No action route in the code (refunds and re-checks from the dashboard are off).");
  const set = scopes.some((s) => (s.vars.PAYNP_ACTION_SECRET ?? "") !== "") || !!process.env.PAYNP_ACTION_SECRET;
  if (set) return pass("action_route_without_secret", `The action route (${rel(cwd, route)}) has PAYNP_ACTION_SECRET.`);
  add({
    code: "action_route_without_secret",
    severity: "warning",
    title: LOCAL_CHECKS.action_route_without_secret.title,
    where: rel(cwd, route),
    detail: "The code handles paynp actions, but PAYNP_ACTION_SECRET is empty or missing in every env file I can see. The route answers 500 and refunds from the dashboard fail.",
    fix: `Copy the secret from the dashboard (Settings, Action endpoint) into PAYNP_ACTION_SECRET${hasWrangler ? ", or run `wrangler secret put PAYNP_ACTION_SECRET`" : " on the server"}.`,
  });
}

function checkWrapped(cwd: string, stack: Stack, add: (f: LocalFinding) => void, pass: (c: LocalCode, line: string) => void, skip: (c: LocalCode, line: string) => void): Set<string> {
  const gateways = new Set<string>();
  if (!stack.js) {
    skip("gateway_not_wrapped", stack.id === "unknown" ? "No package.json here, so I can't check the wiring." : `${stack.name}: no paynp SDK for this language yet, so I can't check the wiring.`);
    return gateways;
  }
  // The same analysis init uses, ignoring git state: what would init still change?
  const plan = planWiring(cwd, { stack: stack.id, force: true });
  for (const c of plan.changes) {
    for (const m of c.after.matchAll(/wrapGateway\(["'](\w+)["']/g)) gateways.add(m[1]);
  }
  for (const f of plan.already) {
    const t = read(join(cwd, f)) ?? "";
    for (const g of Object.keys(PREFIX)) if (t.includes(g)) gateways.add(g);
  }
  if (!plan.found) {
    skip("gateway_not_wrapped", "No blog gateway module or nepal-payments adapter import found.");
    return gateways;
  }
  const sites = plan.changes.filter((c) => c.before !== null && c.what.some((w) => /^imports /.test(w)));
  const manual = plan.manual.filter((m) => /imports names from|loads ".*" with/.test(m));
  if (!sites.length && !manual.length) {
    pass("gateway_not_wrapped", `Every gateway import goes through paynp (${plan.already.join(", ")}).`);
    return gateways;
  }
  const where = [...sites.map((c) => c.rel), ...manual.map((m) => m.split(": ")[0])];
  add({
    code: "gateway_not_wrapped",
    severity: "warning",
    title: LOCAL_CHECKS.gateway_not_wrapped.title,
    where: [...new Set(where)].join(", "),
    detail: "These files use the gateway code directly, so paynp sees nothing from them: no timeline, no alerts, no findings from live traffic.",
    fix: `Run \`paynp init\` (it shows the diff first)${manual.length ? `; by hand: ${manual.map((m) => m.split(": ").slice(1).join(": ")).join(" ")}` : ""}.`,
  });
  return gateways;
}

function checkCommitted(cwd: string, add: (f: LocalFinding) => void, pass: (c: LocalCode, line: string) => void, skip: (c: LocalCode, line: string) => void): void {
  const r = spawnSync("git", ["ls-files", "-z", "--", ".env", ".env.*"], { cwd, encoding: "utf8" });
  if (r.status !== 0) return skip("env_file_committed", "Not a git repository.");
  const tracked = r.stdout.split("\0").filter((f) => f && !EXAMPLE.test(f) && !f.includes("/"));
  let bad = false;
  for (const f of tracked) {
    const vars = parseEnv(read(join(cwd, f)) ?? "");
    const secrets = Object.entries(vars).filter(([k, v]) => v && secretName(k) && !Object.values(PUBLIC_SANDBOX).some((p) => p[k] === v));
    if (!secrets.length) continue;
    bad = true;
    add({
      code: "env_file_committed",
      severity: "critical",
      title: LOCAL_CHECKS.env_file_committed.title,
      where: f,
      detail: `${f} is tracked by git and holds ${secrets.map(([k]) => k).join(", ")}. Anyone with the repository has them.`,
      fix: `git rm --cached ${f}, add it to .gitignore, and rotate those secrets.`,
    });
  }
  if (!bad) pass("env_file_committed", LOCAL_CHECKS.env_file_committed.passed);
}

/** Runs every local check. */
export function localDoctor(cwd: string, stack: Stack): LocalReport {
  const findings: LocalFinding[] = [];
  const passed: LocalReport["passed"] = [];
  const skipped: LocalReport["skipped"] = [];
  const add = (f: LocalFinding) => void findings.push(f);
  const pass = (code: LocalCode, line: string) => void passed.push({ code, line });
  const skip = (code: LocalCode, line: string) => void skipped.push({ code, line });

  const { scopes, files } = readScopes(cwd);
  const code = sourceFiles(cwd);
  const hasWrangler = files.some((f) => f.startsWith("wrangler."));

  const gateways = checkWrapped(cwd, stack, add, pass, skip);
  checkGatewayConfig(scopes, gateways, add);
  checkKeysAndUrls(scopes, add);
  checkClientSecrets(cwd, scopes, code, add);
  checkActionSecret(cwd, scopes, code, hasWrangler, add, pass);
  checkCommitted(cwd, add, pass, skip);

  // A passed line for every config check that ran and found nothing.
  const anyProd = scopes.some((s) => s.production);
  const prodChecks = (["sandbox_gateway_config", "test_key_in_production", "http_return_url"] as const).filter((c) => !findings.some((f) => f.code === c));
  const mismatch = findings.some((f) => f.code === "gateway_env_mismatch");
  if (anyProd) {
    for (const c of prodChecks) if (!(c === "sandbox_gateway_config" && mismatch)) pass(c, LOCAL_CHECKS[c].passed);
  } else if (prodChecks.length) {
    // One line for the three checks that only look at production config.
    for (const c of prodChecks) skipped.push({ code: c, line: "" });
    skipped[skipped.length - 1].line = `${scopes.length ? "No production config here (.env.production, a live PAYNP_KEY, NODE_ENV=production or wrangler vars)" : "No env files or wrangler config found"}, so the sandbox, test key and https checks did not run.`;
  }
  for (const c of ["gateway_env_mismatch", "secret_in_client_bundle"] as const) {
    if (!findings.some((f) => f.code === c)) pass(c, LOCAL_CHECKS[c].passed);
  }
  const order = (f: LocalFinding) => (f.severity === "critical" ? 0 : 1);
  findings.sort((a, b) => order(a) - order(b));
  const sortCodes = Object.keys(LOCAL_CHECKS);
  passed.sort((a, b) => sortCodes.indexOf(a.code) - sortCodes.indexOf(b.code));
  return { findings, passed, skipped, sources: files.filter((f) => existsSync(join(cwd, f))) };
}

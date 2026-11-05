import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { basename, join } from "node:path";
import type { LiveMessage, Project } from "../../shared/src/api.ts";
import { DEFAULT_ENDPOINT, KEY_PREFIX, NAME } from "../../shared/src/brand.ts";
import type { PaymentEvent } from "../../shared/src/events.ts";
import { Api, ApiError } from "./api.ts";
import { readCredentials, readLink, writeCredentials, writeLink, type ProjectLink } from "./config.ts";
import { addToEnvFile, ensureGitignored, readEnvFile } from "./envfile.ts";
import { formatEvent } from "./format.ts";
import { colorDiff, unifiedDiff } from "./codemod/diff.ts";
import { ACTION_PATH, applyPlan, planActionRoute, planWiring, type Plan } from "./codemod/plan.ts";
import { detectGateway, detectStack, envHint, snippet, type Stack } from "./stacks.ts";
import { syntheticEsewaTrace } from "../../shared/src/synthetic.ts";
import { VERSION } from "./version.ts";
import { choose, openBrowser, paint, type Io } from "./ui.ts";
import { connect } from "./ws.ts";
import { doctorJson, renderDoctor, runDoctor } from "./doctor/index.ts";

export type Flags = Record<string, string | boolean | undefined>;

export interface Ctx {
  cwd: string;
  io: Io;
  endpoint: string;
  flags: Flags;
  args: string[];
  signal?: AbortSignal;
}

export class CliError extends Error {}

/** Ends the command with this exit code and no error message (the command already printed why). */
export class ExitCode extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
  });

const flagStr = (ctx: Ctx, k: string): string | undefined => (typeof ctx.flags[k] === "string" ? (ctx.flags[k] as string) : undefined);
const c = (ctx: Ctx, color: Parameters<typeof paint>[1], s: string) => paint(ctx.io.color, color, s);

function token(ctx: Ctx): string | undefined {
  return readCredentials().tokens[ctx.endpoint]?.token;
}

function authed(ctx: Ctx): Api {
  const t = token(ctx);
  if (!t) throw new CliError(`not logged in to ${ctx.endpoint}. Run: ${NAME} login${ctx.endpoint === DEFAULT_ENDPOINT ? "" : ` --endpoint ${ctx.endpoint}`}`);
  return new Api(ctx.endpoint, t);
}

function dashboard(ctx: Ctx): string {
  return readCredentials().tokens[ctx.endpoint]?.dashboard ?? ctx.endpoint;
}

function requireLink(ctx: Ctx): ProjectLink {
  const link = readLink(ctx.cwd);
  if (!link) throw new CliError(`this folder is not linked to a project. Run: ${NAME} init`);
  return link;
}

// Turns API errors into one-line messages a person can act on.
async function guard<T>(ctx: Ctx, p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (err) {
    if (err instanceof ApiError) {
      if (err.status === 401) throw new CliError(`the server did not accept the saved token (${err.message}). Run: ${NAME} login`);
      if (err.status === 0) throw new CliError(err.message);
      throw new CliError(`${err.message} (HTTP ${err.status}${err.code !== "error" ? `, ${err.code}` : ""})`);
    }
    throw err;
  }
}

// ---------------------------------------------------------------- login / logout

export async function login(ctx: Ctx): Promise<void> {
  const api = new Api(ctx.endpoint);
  const d = await guard(ctx, api.deviceStart());
  const url = d.verification_url.includes("code=") ? d.verification_url : `${d.verification_url}${d.verification_url.includes("?") ? "&" : "?"}code=${encodeURIComponent(d.user_code)}`;
  ctx.io.out(`Your code: ${c(ctx, "bold", d.user_code)}`);
  const opened = !ctx.flags["no-browser"] && openBrowser(url);
  ctx.io.out(opened ? `Opened ${url} in your browser. Check that it shows the same code and approve.` : `Open ${url} in a browser, check that it shows the same code and approve.`);
  ctx.io.out(c(ctx, "gray", "Waiting for approval (Ctrl+C to cancel)"));

  let interval = Math.max(0.01, Number(d.interval) || 3) * 1000;
  const deadline = Date.now() + (Number(d.expires_in) || 600) * 1000;
  let pat: string | undefined;
  while (!pat) {
    if (ctx.signal?.aborted) throw new CliError("login canceled");
    if (Date.now() > deadline) throw new CliError("the code expired before it was approved. Run login again.");
    await sleep(interval, ctx.signal);
    const r = await guard(ctx, api.deviceToken(d.device_code));
    if (r.status === 200 && typeof r.data?.token === "string") pat = r.data.token;
    else if (r.status === 429 || r.data?.error === "slow_down") interval += 5000;
  }
  if (!pat.startsWith(KEY_PREFIX.pat)) throw new CliError("the server sent something that is not a personal access token");

  const me = await guard(ctx, new Api(ctx.endpoint, pat).me());
  const creds = readCredentials();
  creds.tokens[ctx.endpoint] = { token: pat, email: me.user.email, dashboard: new URL(url).origin, created_at: new Date().toISOString() };
  creds.default = ctx.endpoint;
  writeCredentials(creds);
  ctx.io.out(`${c(ctx, "green", "Logged in")} as ${me.user.email}${ctx.endpoint === DEFAULT_ENDPOINT ? "" : ` on ${ctx.endpoint}`}.`);
}

export async function logout(ctx: Ctx): Promise<void> {
  const creds = readCredentials();
  const saved = creds.tokens[ctx.endpoint];
  if (!saved) {
    ctx.io.out(`Not logged in to ${ctx.endpoint}.`);
    return;
  }
  const api = new Api(ctx.endpoint, saved.token);
  let revoked = false;
  try {
    const current = (await api.pats()).find((p) => p.current);
    if (current) {
      await api.revokePat(current.id);
      revoked = true;
    } else {
      await api.logout(); // POST /auth/logout with the bearer token revokes it
      revoked = true;
    }
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) revoked = true; // already revoked or expired
    else ctx.io.err(`Could not revoke the token on the server (${(err as Error).message}). Revoke it under Settings, CLI tokens.`);
  }
  delete creds.tokens[ctx.endpoint];
  if (creds.default === ctx.endpoint) delete creds.default;
  writeCredentials(creds);
  ctx.io.out(revoked ? "Logged out. The token is revoked and deleted." : "Logged out. The token is deleted from this machine.");
}

// ---------------------------------------------------------------- init

const slugify = (s: string) => s.toLowerCase().replace(/^@[^/]+\//, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "app";

function appName(cwd: string): string {
  try {
    const name = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")).name;
    if (typeof name === "string" && name) return name.replace(/^@[^/]+\//, "");
  } catch {
    /* no package.json */
  }
  return basename(cwd);
}

function packageManager(cwd: string): [string, string[]] {
  if (existsSync(join(cwd, "pnpm-lock.yaml"))) return ["pnpm", ["add"]];
  if (existsSync(join(cwd, "yarn.lock"))) return ["yarn", ["add"]];
  if (existsSync(join(cwd, "bun.lockb")) || existsSync(join(cwd, "bun.lock"))) return ["bun", ["add"]];
  return ["npm", ["install"]];
}

function hasSdk(cwd: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"));
    return "@paynp/sdk" in { ...pkg.dependencies, ...pkg.devDependencies };
  } catch {
    return false;
  }
}

async function pickOrg(ctx: Ctx, api: Api, link: ProjectLink | null): Promise<string> {
  const me = await guard(ctx, api.me());
  if (me.orgs.length === 0) throw new CliError("this account has no organization yet. Sign in to the dashboard once, then run init again.");
  const want = flagStr(ctx, "org") ?? link?.org;
  if (want) {
    const o = me.orgs.find((x) => x.id === want || x.name === want);
    if (o) return o.id;
    if (flagStr(ctx, "org")) throw new CliError(`no organization "${want}" on this account`);
  }
  if (me.orgs.length === 1 || !ctx.io.interactive || ctx.flags.yes) {
    return (me.orgs.find((o) => o.role !== "viewer") ?? me.orgs[0]).id;
  }
  const i = await choose(ctx.io, "Organization:", me.orgs.map((o) => `${o.name} (${o.role})`));
  return me.orgs[i].id;
}

async function pickProject(ctx: Ctx, api: Api, org: string, link: ProjectLink | null): Promise<Project> {
  const projects = await guard(ctx, api.projects(org));
  const want = flagStr(ctx, "project") ?? (link?.org === org ? link.project : undefined);
  if (want) {
    const p = projects.find((x) => x.id === want || x.slug === want || x.name === want);
    if (p) return p;
    if (flagStr(ctx, "project") && !ctx.flags.create) throw new CliError(`no project "${want}" in this organization (add --create to create it)`);
  }
  const name = flagStr(ctx, "project") ?? appName(ctx.cwd);
  const slug = slugify(name);
  const match = projects.find((p) => p.slug === slug || p.name === name);
  if (ctx.flags.yes || !ctx.io.interactive) {
    if (match) return match;
    ctx.io.out(`Creating project ${c(ctx, "bold", name)}`);
    return guard(ctx, api.createProject(org, name));
  }
  const options = [...projects.map((p) => `${p.name} ${c(ctx, "gray", p.slug)}`), `Create a new project "${name}"`];
  const def = match ? projects.indexOf(match) : projects.length;
  const i = await choose(ctx.io, "Project:", options, def);
  if (i < projects.length) return projects[i];
  ctx.io.out(`Creating project ${c(ctx, "bold", name)}`);
  return guard(ctx, api.createProject(org, name));
}

export async function init(ctx: Ctx): Promise<void> {
  const io = ctx.io;
  const stack = detectStack(ctx.cwd);
  const gateway = flagStr(ctx, "gateway") ?? detectGateway(ctx.cwd);
  io.out(stack.id === "unknown" ? "Stack: not detected, I'll print the raw HTTP call." : `Stack: ${c(ctx, "bold", stack.name)} (from ${stack.from})`);

  if (ctx.flags["dry-run"]) {
    io.out("Dry run: no login, no key, no install, nothing written.");
    return wire(ctx, stack, gateway);
  }

  if (!token(ctx)) {
    io.out("Not logged in yet. Starting login.");
    await login(ctx);
  }
  const api = authed(ctx);
  const link = readLink(ctx.cwd);
  const org = await pickOrg(ctx, api, link);
  const project = await pickProject(ctx, api, org, link);
  io.out(`Project: ${c(ctx, "bold", project.name)} (${project.id})`);

  // .env: never overwrite. A PAYNP_KEY already there is kept and no new key is made.
  const envPath = join(ctx.cwd, ".env");
  const existing = readEnvFile(envPath).values;
  const vars: Record<string, string> = {};
  if (existing.PAYNP_KEY && !ctx.flags["new-key"]) {
    io.out("PAYNP_KEY is already in .env, kept it.");
  } else if (!existing.PAYNP_KEY) {
    const key = await guard(ctx, api.createKey(project.id, "test", `${hostname()} (${NAME} init)`));
    vars.PAYNP_KEY = key.key;
    io.out(`Created test key ${key.prefix}`);
  } else {
    io.out("PAYNP_KEY is already in .env; I don't overwrite it. Remove the line first to get a new key.");
  }
  if (ctx.endpoint !== DEFAULT_ENDPOINT) vars.PAYNP_ENDPOINT = ctx.endpoint;
  const w = addToEnvFile(envPath, vars);
  if (w.added.length) io.out(`${w.created ? "Created" : "Updated"} .env: added ${w.added.join(", ")}`);
  for (const k of w.kept.filter((k) => k !== "PAYNP_KEY")) io.out(`${k} is already in .env, kept it.`);
  if (ensureGitignored(join(ctx.cwd, ".gitignore"))) io.out("Added .env to .gitignore");

  if (stack.js && !hasSdk(ctx.cwd)) {
    const [pm, args] = packageManager(ctx.cwd);
    const cmd = [pm, ...args, "@paynp/sdk"];
    if (ctx.flags["skip-install"]) io.out(`Skipped install. Run: ${cmd.join(" ")}`);
    else {
      io.out(`Running ${cmd.join(" ")}`);
      const r = spawnSync(cmd[0], cmd.slice(1), { cwd: ctx.cwd, stdio: "inherit", shell: process.platform === "win32" });
      if (r.status !== 0) io.err(`Install failed. Run it yourself: ${cmd.join(" ")}`);
    }
  }

  writeLink(ctx.cwd, { org, project: project.id });
  io.out(`Linked this folder: .${NAME}/project.json`);

  await wire(ctx, stack, gateway);
}

const LANGS: Record<string, string> = { python: "Python", php: "PHP", go: "Go", java: "Java", kotlin: "Kotlin" };

// JS/TS: edit the app so it reports to paynp (diff, one question, apply). Other stacks: print the code to add.
async function wire(ctx: Ctx, stack: Stack, gateway: string): Promise<void> {
  const io = ctx.io;
  const dry = !!ctx.flags["dry-run"];
  const printSnippet = (intro: string) => {
    io.out("");
    io.out(c(ctx, "bold", intro));
    io.out("");
    io.out(snippet(stack.id, gateway).code);
  };
  const outro = () => {
    io.out("");
    io.out(`${stack.id === "unknown" ? "Environment" : stack.name}: ${envHint(stack.id)}`);
    if (!dry) io.out(`Then run ${c(ctx, "bold", `${NAME} test`)} to send a sample payment, and ${c(ctx, "bold", `${NAME} tail`)} to watch events live.`);
  };
  const list = (title: string, items: string[]) => {
    if (!items.length) return;
    io.out("");
    io.out(c(ctx, "bold", title));
    for (const i of items) io.out(`  - ${i}`);
  };

  if (!stack.js) {
    const lang = LANGS[snippet(stack.id, gateway).lang];
    printSnippet(lang ? `${NAME} has no ${lang} SDK yet, so init does not edit ${stack.name} code. Add this yourself:` : "Wire it up:");
    return outro();
  }

  const plan = planWiring(ctx.cwd, { stack: stack.id, force: !!ctx.flags.force });
  const skipped = plan.skipped.map((s) => `${s.rel}: ${s.reason}`);
  if (!plan.changes.length) {
    if (!plan.found) printSnippet("I found no gateway module or adapter import to wire, so here is what to add:");
    else if (plan.already.length) {
      io.out("");
      io.out(`paynp is already wired into the code (${plan.already.join(", ")}). Nothing to change.`);
    }
    list("Not edited:", skipped);
    list("Still to do by hand:", plan.manual);
    if (plan.found) await offerActions(ctx, stack);
    return outro();
  }

  io.out("");
  io.out(c(ctx, "bold", `Wiring paynp into the code: ${plan.changes.length} file${plan.changes.length === 1 ? "" : "s"}`));
  for (const ch of plan.changes) {
    io.out("");
    io.out(colorDiff(unifiedDiff(ch.rel, ch.before, ch.after), io.color));
  }
  list("Not edited:", skipped);

  let apply = !dry && !!ctx.flags.yes;
  if (dry) {
    io.out("");
    io.out("Dry run: nothing written. Run init without --dry-run to apply these edits.");
  } else if (!apply && io.interactive) {
    io.out("");
    const a = await io.ask("Apply these changes? [Y/n] ");
    apply = a === "" || /^y(es)?$/i.test(a);
    if (!apply) io.out("Left the code as it was. Run init again to see the edits, or --dry-run to only print them.");
  } else if (!apply) {
    io.out("");
    io.out("Not applied: there is no terminal to ask. Rerun with --yes to apply these edits.");
  }
  if (apply) {
    applyPlan(ctx.cwd, plan);
    io.out("");
    io.out(c(ctx, "green", `Wired paynp into ${plan.changes.length} file${plan.changes.length === 1 ? "" : "s"}:`));
    for (const ch of plan.changes) io.out(`  ${ch.before === null ? "created" : "edited "} ${ch.rel}: ${ch.what.join("; ")}`);
  }
  list("Still to do by hand:", plan.manual);
  // The action route builds on the wiring: offered once that is in place (or, in a dry run, on top of its diff).
  if (apply || dry) await offerActions(ctx, stack, dry ? { base: plan } : { wrote: plan.changes.map((ch) => ch.file) });
  outro();
}

const ACTION_SECRET_LINES = [
  "# Refunds and re-checks from the paynp dashboard. Copy the secret from Settings, Action endpoint (shown once).",
  `# Until it is set, ${ACTION_PATH} answers 500 and nothing runs.`,
  "PAYNP_ACTION_SECRET=",
];

/**
 * Opt-in: the POST /paynp/actions route the dashboard's Re-check and Send refund buttons call. Shown as a diff;
 * asked separately (default no). --actions says yes, --no-actions skips it, --yes alone leaves it out with a hint.
 */
async function offerActions(ctx: Ctx, stack: Stack, from: { base?: Plan; wrote?: string[] } = {}): Promise<void> {
  const io = ctx.io;
  if (ctx.flags["no-actions"]) return;
  const dry = !!ctx.flags["dry-run"];
  const plan = planActionRoute(ctx.cwd, { stack: stack.id, force: !!ctx.flags.force, wrote: from.wrote }, from.base);
  if (!plan.changes.length) {
    if (plan.manual.length && (ctx.flags.actions || dry || io.interactive)) {
      io.out("");
      io.out(c(ctx, "bold", "Refunds and re-checks from the dashboard:"));
      for (const m of plan.manual) io.out(`  - ${m}`);
    }
    return;
  }
  const envPath = join(ctx.cwd, ".env");
  const hasSecretLine = Object.hasOwn(readEnvFile(envPath).values, "PAYNP_ACTION_SECRET");
  const show = () => {
    io.out("");
    io.out(c(ctx, "bold", `Optional: a route for refunds and re-checks from the dashboard (POST ${ACTION_PATH})`));
    io.out(c(ctx, "gray", "paynp never holds gateway keys: the dashboard sends a signed request here and this server acts with its own."));
    for (const ch of plan.changes) {
      io.out("");
      io.out(colorDiff(unifiedDiff(ch.rel, ch.before, ch.after), io.color));
    }
    if (!hasSecretLine) {
      io.out("");
      io.out(colorDiff(unifiedDiff(".env", null, ACTION_SECRET_LINES.join("\n") + "\n").replace("--- /dev/null", "--- a/.env").replace("+++ b/.env", "+++ b/.env (appended)"), io.color));
    }
  };
  if (dry) {
    show();
    io.out("");
    io.out(`Dry run: nothing written. ${NAME} init --actions adds this route.`);
    return;
  }
  let apply = !!ctx.flags.actions;
  if (!apply && io.interactive && !ctx.flags.yes) {
    show();
    io.out("");
    const a = await io.ask(`Add the ${ACTION_PATH} route? [y/N] `);
    apply = /^y(es)?$/i.test(a);
  } else if (!apply) {
    io.out("");
    io.out(`Refunds and re-checks from the dashboard: rerun ${c(ctx, "bold", `${NAME} init --actions`)} to add the ${ACTION_PATH} route (shown as a diff first with ${NAME} init --dry-run).`);
    return;
  } else show();
  if (!apply) {
    io.out(`Left it out. ${NAME} init --actions adds it later.`);
    return;
  }
  applyPlan(ctx.cwd, plan);
  if (!hasSecretLine) {
    const text = readEnvFile(envPath).text;
    writeFileSync(envPath, `${text}${text && !text.endsWith("\n") ? "\n" : ""}${ACTION_SECRET_LINES.join("\n")}\n`, { mode: 0o600 });
  }
  io.out("");
  io.out(c(ctx, "green", `Added the action route:`));
  for (const ch of plan.changes) io.out(`  ${ch.before === null ? "created" : "edited "} ${ch.rel}: ${ch.what.join("; ")}`);
  if (!hasSecretLine) io.out("  edited  .env: PAYNP_ACTION_SECRET placeholder");
  list(ctx, "Still to do by hand:", plan.manual);
  const workers = existsSync(join(ctx.cwd, "wrangler.toml")) || existsSync(join(ctx.cwd, "wrangler.json")) || existsSync(join(ctx.cwd, "wrangler.jsonc"));
  io.out("");
  io.out(c(ctx, "bold", "To turn it on:"));
  io.out(`  1. Deploy, then in the dashboard open Settings, Action endpoint and enter https://<your site>${ACTION_PATH}.`);
  io.out(`  2. Copy the secret it shows once into PAYNP_ACTION_SECRET${workers ? " (wrangler secret put PAYNP_ACTION_SECRET)" : " on the server (and in .env to try it locally)"}.`);
  io.out(`  3. Press Test. ${NAME} doctor warns while the route has no secret.`);
}

function list(ctx: Ctx, title: string, items: string[]): void {
  if (!items.length) return;
  ctx.io.out("");
  ctx.io.out(c(ctx, "bold", title));
  for (const i of items) ctx.io.out(`  - ${i}`);
}

// ---------------------------------------------------------------- tail

export async function tail(ctx: Ctx): Promise<void> {
  const link = requireLink(ctx);
  const t = token(ctx);
  if (!t) authed(ctx); // throws the login hint
  const env = ctx.flags.live ? "live" : (flagStr(ctx, "env") ?? "test");
  if (env !== "test" && env !== "live") throw new CliError("--env must be test or live");
  const url = `${ctx.endpoint.replace(/^http/, "ws")}/api/projects/${encodeURIComponent(link.project)}/live?env=${env}`;
  const json = !!ctx.flags.json;
  const seen = new Set<string>();
  const print = (e: PaymentEvent) => {
    if (seen.has(e.id)) return; // the backlog repeats after a reconnect
    seen.add(e.id);
    if (seen.size > 5000) seen.delete(seen.values().next().value!);
    ctx.io.out(json ? JSON.stringify(e) : formatEvent(e, ctx.io.color));
  };
  if (!json) ctx.io.err(c(ctx, "gray", `Tailing ${env} events for project ${link.project} (Ctrl+C to stop)`));

  let backoff = 1000;
  while (!ctx.signal?.aborted) {
    const result = await new Promise<{ code: number; reason: string; opened: boolean }>((resolve) => {
      let opened = false;
      const conn = connect(url, { Authorization: `Bearer ${t}`, "User-Agent": `${NAME}-cli` }, {
        onOpen: () => {
          opened = true;
          backoff = 1000;
        },
        onMessage: (text) => {
          let m: LiveMessage;
          try {
            m = JSON.parse(text);
          } catch {
            return;
          }
          if (m.kind === "backlog") for (const e of m.events) print(e);
          else if (m.kind === "event") print(m.event);
        },
        onClose: (code, reason) => resolve({ code, reason, opened }),
      });
      ctx.signal?.addEventListener("abort", () => conn.close(), { once: true });
    });
    if (ctx.signal?.aborted) break;
    if (!result.opened && [401, 403, 404].includes(result.code)) {
      throw new CliError(result.code === 401 ? `the server did not accept the saved token. Run: ${NAME} login` : `live stream refused (HTTP ${result.code}): ${result.reason}`);
    }
    if (!json) ctx.io.err(c(ctx, "yellow", `Disconnected (${result.code}${result.reason ? `, ${result.reason}` : ""}), reconnecting in ${backoff / 1000}s`));
    await sleep(backoff, ctx.signal);
    backoff = Math.min(backoff * 2, 30_000);
  }
}

// ---------------------------------------------------------------- test

export async function test(ctx: Ctx): Promise<void> {
  const key = process.env.PAYNP_KEY || readEnvFile(join(ctx.cwd, ".env")).values.PAYNP_KEY;
  if (!key) throw new CliError(`no PAYNP_KEY in the environment or .env. Run: ${NAME} init`);
  if (key.startsWith(KEY_PREFIX.live)) throw new CliError(`PAYNP_KEY is a live key; ${NAME} test only sends to the test environment`);
  if (!key.startsWith(KEY_PREFIX.test)) throw new CliError(`PAYNP_KEY does not look like a key (expected ${KEY_PREFIX.test}...)`);

  // The same trace as the dashboard's "send a test payment" button.
  const events = syntheticEsewaTrace(Date.now(), { name: "paynp-cli", version: VERSION, lang: "ts" });
  const attemptId = events[0].attempt_id;
  let res: Response;
  try {
    res = await fetch(`${ctx.endpoint}/v1/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ events }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new CliError(`could not reach ${ctx.endpoint}`);
  }
  const body = (await res.json().catch(() => null)) as { accepted?: number; duplicates?: number } | null;
  if (res.status === 401) throw new CliError("the ingest API did not accept PAYNP_KEY (revoked, or for another endpoint?)");
  if (res.status !== 202) throw new CliError(`ingest answered HTTP ${res.status}: ${JSON.stringify(body)}`);
  ctx.io.out(`${c(ctx, "green", "Sent")} a test eSewa payment: ${body?.accepted ?? events.length} events (attempt ${attemptId}).`);
  const link = readLink(ctx.cwd);
  const dash = dashboard(ctx);
  ctx.io.out(link ? `See it: ${dash}/p/${encodeURIComponent(link.project)}/test/payments/${attemptId}` : `See it in the dashboard: ${dash}`);
}

// ---------------------------------------------------------------- keys

const date = (ms: number | null) => (ms ? new Date(ms).toISOString().slice(0, 16).replace("T", " ") : "never");

export async function keys(ctx: Ctx): Promise<void> {
  const link = requireLink(ctx);
  const api = authed(ctx);
  const sub = ctx.args[0] ?? "list";
  if (sub === "list" || sub === "ls") {
    const list = await guard(ctx, api.keys(link.project));
    if (ctx.flags.json) return void ctx.io.out(JSON.stringify(list, null, 2));
    if (!list.length) return void ctx.io.out(`No keys. Create one: ${NAME} keys create`);
    const rows = list.map((k) => [k.id, k.env, k.prefix, k.name ?? "", date(k.created_at), date(k.last_used_at), k.revoked_at ? `revoked ${date(k.revoked_at)}` : "active"]);
    const head = ["ID", "ENV", "PREFIX", "NAME", "CREATED", "LAST USED", "STATE"];
    const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
    const line = (r: string[]) => r.map((x, i) => x.padEnd(widths[i])).join("  ").trimEnd();
    ctx.io.out(c(ctx, "gray", line(head)));
    for (const r of rows) ctx.io.out(r[6] === "active" ? line(r) : c(ctx, "gray", line(r)));
    return;
  }
  if (sub === "create") {
    const env = ctx.flags.live ? "live" : (flagStr(ctx, "env") ?? "test");
    if (env !== "test" && env !== "live") throw new CliError("--env must be test or live");
    const k = await guard(ctx, api.createKey(link.project, env, flagStr(ctx, "name") ?? `${hostname()} (${NAME} keys)`));
    if (ctx.flags.json) return void ctx.io.out(JSON.stringify(k, null, 2));
    ctx.io.out(`Created ${env} key ${k.id}. It is shown once; store it as PAYNP_KEY on the server:`);
    ctx.io.out(k.key);
    return;
  }
  if (sub === "revoke" || sub === "rm") {
    const id = ctx.args[1];
    if (!id) throw new CliError(`usage: ${NAME} keys revoke <key id>`);
    if (ctx.io.interactive && !ctx.flags.yes) {
      const a = await ctx.io.ask(`Revoke key ${id}? Apps using it stop sending events. [y/N] `);
      if (!/^y(es)?$/i.test(a)) return void ctx.io.out("Kept it.");
    }
    await guard(ctx, api.revokeKey(link.project, id));
    ctx.io.out(`Revoked ${id}.`);
    return;
  }
  throw new CliError(`unknown keys command "${sub}". Use: list, create, revoke <id>`);
}

// ---------------------------------------------------------------- open

export async function open(ctx: Ctx): Promise<void> {
  const link = readLink(ctx.cwd);
  const env = ctx.flags.live ? "live" : "test";
  const url = link ? `${dashboard(ctx)}/p/${encodeURIComponent(link.project)}/${env}/overview` : `${dashboard(ctx)}/`;
  const opened = !ctx.flags["no-browser"] && openBrowser(url);
  ctx.io.out(opened ? `Opened ${url}` : url);
}

// ---------------------------------------------------------------- doctor

export async function doctor(ctx: Ctx): Promise<void> {
  const r = await runDoctor(ctx);
  ctx.io.out(ctx.flags.json ? JSON.stringify(doctorJson(r), null, 2) : renderDoctor(r, { color: ctx.io.color, cwd: ctx.cwd, endpoint: ctx.endpoint }));
  if (r.critical) throw new ExitCode(1);
}

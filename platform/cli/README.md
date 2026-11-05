# paynp CLI

The terminal side of paynp: I sign in, link an app to a project, get a test key into `.env`, see the exact lines to add for my framework, and watch payment events arrive live.

Node 20 or newer. No runtime dependencies: the build bundles everything, including the parser `init` uses to edit code, into one file.

```bash
npx paynp dev       # local dashboard while I build, no account
npx paynp login
npx paynp init
npx paynp test
npx paynp tail
npx paynp doctor    # before going live
```

## Commands

| Command | What it does |
|---|---|
| `paynp login` | Device login. Prints a code, opens the approval page in my browser, waits until I approve, then stores a personal access token in `~/.config/paynp/credentials.json` (mode 600, directory 700; `$XDG_CONFIG_HOME` is respected). |
| `paynp logout` | Revokes the token on the server and deletes it locally. |
| `paynp init` | Detects the stack, picks or creates the project, creates a test key, writes `.env`, makes git ignore `.env`, installs `@paynp/sdk` for JS stacks, links the folder and wires the SDK into my code (JS/TS) or prints the code to add (other stacks). Logs in first if needed. `--dry-run` only prints the code edits, `--force` also edits files with uncommitted changes. |
| `paynp tail` | Live events for the linked project, one colored line each. `--json` prints one event per line. `--env live` (or `--live`) for production. Reconnects on its own. |
| `paynp test` | Sends a synthetic eSewa payment (started, redirected, callback, signature ok, status COMPLETE, paid, fulfilled) with `PAYNP_KEY` and prints the link to its timeline. Refuses live keys. |
| `paynp keys` | Lists keys. `keys create --env test\|live --name prod` (the key is shown once), `keys revoke <id>`. |
| `paynp open` | Opens the linked project in the dashboard. `--no-browser` just prints the URL. |
| `paynp doctor` | Go-live checks on the env files, wrangler config and code, then the findings paynp computed from live traffic. `--json`, `--env test` for the server half (default live), `--local` to skip it. Exits 1 when anything is critical. See below. |
| `paynp dev` | Local dev server: ingest and dashboard on `http://localhost:4040` with no account and no key. `--port`, `--fresh`, `--open`, `--quiet`. See below. |

`--yes` (`-y`) never prompts and takes the defaults. `--json` works on `tail`, `keys` and `doctor`.

## What `init` does to my project

- **Stack**: from `package.json` dependencies (Next.js, Hono, Fastify, Express, else plain Node), `composer.json` (Laravel, else PHP; loose `*.php` files count too), `requirements.txt` / `pyproject.toml` / `Pipfile` (Django, FastAPI, Flask), `go.mod`, and `build.gradle(.kts)` / `pom.xml` (Ktor, Spring Boot). The gateway in the snippet is whichever module I already have (`esewa.ts`, `khalti.py`, ...), else eSewa.
- **Project**: `--project <id|slug|name>` picks one (`--create` makes it if missing). Interactively I get a menu of my projects plus "create". With `--yes`, a project whose slug matches the app name (from `package.json`, else the folder name) is reused, otherwise one is created. `--org` picks the organization when I have several.
- **`.env`**: created if missing (mode 600). `PAYNP_KEY` is added, plus `PAYNP_ENDPOINT` when I'm not on the default endpoint. A variable that is already there is never overwritten, and if `PAYNP_KEY` exists no new key is created at all.
- **`.gitignore`**: gets a `.env` line (and is created) unless an existing pattern already ignores `.env` (`.env`, `/.env`, `.env*`, `*.env`; a later `!.env` counts as not ignored).
- **Install**: `npm install @paynp/sdk`, or `pnpm add` / `yarn add` / `bun add` when that lockfile is there. Skipped when the package is already a dependency, or with `--skip-install`.
- **Link**: `.paynp/project.json` with `{ "org", "project" }`. It holds ids, not secrets, so I commit it and teammates get the same link.

- **Code (JS/TS)**: see below. For PHP, Python, Go, Java and Kotlin there is no SDK yet, so init edits no code there. It prints a small self-contained function that posts events to the ingest API in the background, and says so.

### Wiring the code (Express, Hono, Fastify, Next.js, plain Node)

`init` parses every source file in the project with `@babel/parser`, finds where the payment code is imported, and makes small text edits with `magic-string`, so formatting and comments stay as they were. It shows a colored unified diff of every edit and asks once (`Apply these changes? [Y/n]`). `--yes` applies without asking, `--dry-run` prints the diff and stops before login, keys or any write. Without a terminal and without `--yes` it shows the diff and applies nothing.

Two shapes are recognised:

- **The blog's gateway modules** (`esewa.ts`, `khalti.ts`, `fonepay.ts`, `connectips.ts`, `cybersource.ts`, `nps.ts`, `imepay.ts`, each exporting `startPayment` / `confirmPayment`). `paynp.ts` is written next to the module with `createPaynp` and `export const gateway = paynp.wrapGateway("esewa", esewa)`. Every `import * as gateway from "./esewa"` (or `"@/esewa"`) becomes `import { gateway } from "./paynp"`, and Next.js's `await import("./esewa")` in `instrumentation.ts` becomes `const { gateway } = await import("./paynp")`. If `payments.ts` has the blog's `settle()`, it gets `paynp.statusChanged(...)` where `transition()` moved the attempt and `paynp.fulfilled(...)` next to `fulfil()`.
- **The skill's adapters** (`createPayments`, `esewa({...})` and the other factories, from a copied `payments/index.ts` or the `nepal-payments` package). `paynp.ts` is written beside the library: it re-exports everything and replaces each factory and `createPayments` with a version whose adapters go through `paynp.wrapAdapter`. Imports of the library that use a factory or `createPayments` are pointed at `paynp.ts`; type-only imports stay.

Serverless: Next.js route handlers (`app/**/route.ts`) get `after(() => paynp.flush())` as their first line (Next.js 15 and later). Hono on Cloudflare Workers (a `wrangler` config next to `package.json`) gets a middleware that calls `c.executionCtx.waitUntil(paynp.flush())` after each response, and `paynp.ts` reads `PAYNP_KEY` from the `cloudflare:workers` env. Shapes I don't edit (a plain Worker `fetch`, `pages/api`, names imported from a gateway module, `require()`) get a precise manual step in the summary instead.

Customer details: the generated `paynp.ts` ends with a commented `customer` getter. Uncommenting it sends the buyer's phone, email or name on `payment.started`, which paynp stores only as a salted hash and a masked form, so support can search payments by phone.

### The action route (opt-in)

After the wiring, `init` offers a route for the dashboard's "Re-check" and "Send refund" buttons: `POST /paynp/actions`, which paynp calls signed with `PAYNP_ACTION_SECRET` so that refunds run on my server with my own gateway keys. It is a second diff and a second question, `Add the /paynp/actions route? [y/N]`, and the default is no. `--actions` answers yes, `--no-actions` skips the question, and `--yes` alone leaves it out and prints how to add it. `--dry-run` shows its diff after the wiring diff.

- `paynp-actions.ts` next to `paynp.ts`: `recheck` loads the attempt from the blog's store, runs `confirmPayment` with empty params (the reconcile path) and `settle()`; `refund` stays a comment, with a pointer to the Khalti callback in the `@paynp/sdk` README, or a note that the gateway has no refund API.
- The route: Express `app.post("/paynp/actions", express.raw({ type: "application/json" }), paynp.nodeActionHandler(actions))`, Fastify `paynp.nodeActionHandler(actions)`, Hono `paynp.actionHandler(actions)(c.req.raw)` (on Workers with `secret` read from `c.env`), Next.js `app/paynp/actions/route.ts` exporting `POST`.
- `.env` gets an empty `PAYNP_ACTION_SECRET=` with a comment saying where the value comes from. Until it is set, the route answers 500 and `paynp doctor` warns.
- The adapters, several gateway modules in one paynp file, or an app object init can't find get a manual step instead.

Rules it keeps:

- Running it again changes nothing: files that already import from `paynp.ts` and a `settle()` that already calls paynp are left alone.
- A file with uncommitted changes (modified, staged or untracked) is not edited, and is listed with the reason; `--force` edits it anyway. Outside a git repo the diff and the question are the only guard.
- Only files inside the project: never `node_modules`, build output or anything reached through a symlink. An existing `paynp.ts` that `init` did not write is never overwritten.
- Nothing recognisable found: it prints the wiring snippet, as before.

## `paynp doctor`

```bash
npx paynp doctor          # exit 1 on anything critical, so it can gate a deploy
npx paynp doctor --json
```

Local checks need no network and never print a secret value (only the public sandbox constants, `*_ENV` values and URLs):

| Check | Severity | Flags |
|---|---|---|
| `sandbox_gateway_config` | critical | Production config (`.env.production`, a `.env` with a live `PAYNP_KEY` or `NODE_ENV=production`, wrangler deploy vars) where a gateway runs in sandbox: `*_ENV=sandbox`, public sandbox values (`EPAYTEST`, eSewa's and Fonepay's published test keys) or sandbox hosts. A missing `*_ENV` for a gateway the code or config uses is a warning, since the modules default to sandbox. |
| `gateway_env_mismatch` | critical | `*_ENV=production` with sandbox credentials or hosts, or `*_ENV=sandbox` with a production URL, in any config. |
| `test_key_in_production` | warning | A `pnp_test_` key in production config. |
| `http_return_url` | critical | `BASE_URL`, `*_RETURN_URL`, `*_WEBSITE_URL` and similar on http or localhost in production config. |
| `secret_in_client_bundle` | critical | Secrets behind `NEXT_PUBLIC_`, `VITE_`, `PUBLIC_`, `REACT_APP_`, `EXPO_PUBLIC_`, `NUXT_PUBLIC_`, `GATSBY_` in env files or read in code, and secrets under `env` in `next.config`. Public keys (`*_PUBLIC_KEY`, site keys) are fine. |
| `action_route_without_secret` | warning | The code serves `/paynp/actions` but `PAYNP_ACTION_SECRET` is empty or missing everywhere I can see. |
| `gateway_not_wrapped` | warning | Files that still import the gateway modules or adapters directly (the same analysis `init` uses). |
| `env_file_committed` | critical | A tracked `.env*` file (not `.example`/`.sample`) with secret values. |

Env files load the way Next.js and Vite load them: `.env` < `.env.<mode>` < `.env.local` < `.env.<mode>.local`, one set per mode. `wrangler.jsonc`, `wrangler.json` and `wrangler.toml` vars count per environment; secrets set with `wrangler secret put` are invisible to the CLI, so the messages say when that matters.

Logged in and linked, it then prints the server findings from `GET /api/projects/:p/doctor?env=live` (sandbox hosts on live traffic, http return URLs, rupee-sized amounts, signature bursts, missing status checks, fulfilment problems, no reconcile job), each with its count, last time, an example attempt, the fix and a docs link, plus the passed checks. A server that can't be reached or has no doctor yet is reported and doesn't fail the run on its own.

## `paynp dev`

```bash
npx paynp dev
```

One process on `http://localhost:4040` (or `--port`, or `PAYNP_DEV_PORT`) that serves:

- `POST /v1/events` with the same validation, redaction and rollup as the hosted ingest. Any key works, and so does none. A `pnp_live_` key files events under live, everything else under test.
- `GET /v1/health`, answering `{"ok": true, "mode": "local"}`. The SDK uses it to find the server.
- The parts of `/api` the dashboard reads, in the hosted API's shapes: one org and one project, both `local`; payments with filters and the error explainer, events, analytics, gateway health, the live WebSocket and the "send a test payment" button. `/api/me` carries `"mode": "local"`, which makes the dashboard skip sign-in and hide the project switcher, alerts and settings.
- The dashboard itself, built into `dist/dashboard` by `npm run build`, with SPA fallback.

`/api` and the dashboard answer only requests addressed to `localhost`, `127.x` or `[::1]`, and `/v1/events` takes JSON only, so a web page cannot post into it from the browser.

Events are kept in `.paynp/dev/events.db` in the current folder when Node has `node:sqlite` (22.5 and newer; before 22.13 only with `--experimental-sqlite`), and only in memory otherwise. The folder gets its own `.gitignore`. `--fresh` clears it on start.

The app needs nothing when it uses `@paynp/sdk` with no `PAYNP_KEY` outside production: the SDK finds the server on its own. Otherwise these two lines in the app's `.env` point it here:

```bash
PAYNP_ENDPOINT=http://localhost:4040
PAYNP_KEY=pnp_test_local
```

## Local development

```bash
paynp login --endpoint http://localhost:8787
```

The endpoint is taken from, in order: `--endpoint`, `PAYNP_ENDPOINT`, `PAYNP_ENDPOINT` in the project's `.env`, the endpoint I last logged in to, then `https://paynp.discerns.app`. Tokens are stored per endpoint, so local and production logins live side by side. `PAYNP_NO_BROWSER=1` (or `CI`) stops it from opening a browser.

## Development

```bash
npm run build   # tsup: one file, dist/paynp.js; then the dashboard into dist/dashboard
npm test        # vitest against a local mock of the API (SPEC sections 3, 5, 6, 7) and the dev server
                # test/codemod: init's code edits on the blog apps for all four frameworks (assembled from
                # website/src/data/blog-code) and on the skill adapters: exact diffs, idempotency, git safety,
                # tsc on the edited apps, and the edited Express app against eSewa's sandbox.
                # The first run installs the frameworks once into $TMPDIR/paynp-codemod-deps-v1.
PAYNP_SKIP_DEPS=1 npm test      # skip the tests that need those packages (tsc, sandbox)
PAYNP_SKIP_SANDBOX=1 npm test   # skip only the sandbox run

# The dev server end to end: the blog's Express app with the real eSewa module, no key, eSewa's sandbox.
# Needs network and a folder whose node_modules has express and tsx.
PAYNP_E2E_DEPS=/path/to/that/folder npx vitest run test/dev-e2e.test.ts
```

`paynp tail` speaks WebSocket through a small client in `src/ws.ts`, because the runtime's `WebSocket` cannot send an `Authorization` header and Node 20 has none.

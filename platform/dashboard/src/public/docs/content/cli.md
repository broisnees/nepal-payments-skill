# CLI

The terminal side of paynp: sign in, link an app to a project, get a test key into `.env`, wire the SDK, send a test payment and watch events arrive live. Node 20 or newer, no runtime dependencies.

```bash
npx paynp dev       # local dashboard while building, no account
npx paynp login
npx paynp init
npx paynp test
npx paynp tail
npx paynp doctor    # before going live
```

## Commands

| Command | What it does |
|---|---|
| `paynp login` | Device login. Prints a code, opens the approval page in the browser, waits for approval, then stores a personal access token in `~/.config/paynp/credentials.json` (mode 600; `$XDG_CONFIG_HOME` is respected). |
| `paynp logout` | Revokes the token on the server and deletes it locally. |
| `paynp init` | Detects the stack, picks or creates the project, creates a test key, writes `.env`, makes git ignore `.env`, installs `@paynp/sdk` for JS stacks, links the folder and wires the SDK into the code (JS/TS) or prints the code to add (other stacks). `--dry-run` only prints the edits, `--force` also edits files with uncommitted changes. |
| `paynp tail` | Live events for the linked project, one colored line each. `--json` prints one event per line. `--env live` (or `--live`) for production. Reconnects on its own. |
| `paynp test` | Sends a synthetic eSewa payment (started, redirected, callback, signature ok, status COMPLETE, paid, fulfilled) with `PAYNP_KEY` and prints the link to its timeline. Refuses live keys. |
| `paynp keys` | Lists keys. `keys create --env test\|live --name prod` (the key is shown once), `keys revoke <id>`. |
| `paynp open` | Opens the linked project in the dashboard. `--no-browser` just prints the URL. |
| `paynp doctor` | Go-live checks on env files, wrangler config and code, then the findings computed from live traffic. Exits 1 when anything is critical. |
| `paynp dev` | Local dev server: ingest and dashboard on `http://localhost:4040` with no account and no key. `--port`, `--fresh`, `--open`, `--quiet`. |

`--yes` (`-y`) never prompts and takes the defaults. `--json` works on `tail`, `keys` and `doctor`.

## What `init` changes

- **Stack**: from `package.json` dependencies (Next.js, Hono, Fastify, Express, else plain Node), `composer.json` (Laravel, PHP), `requirements.txt` / `pyproject.toml` / `Pipfile` (Django, FastAPI, Flask), `go.mod`, and `build.gradle(.kts)` / `pom.xml` (Ktor, Spring Boot).
- **`.env`**: created if missing (mode 600). `PAYNP_KEY` is added, plus `PAYNP_ENDPOINT` off the default endpoint. A variable that is already there is never overwritten.
- **`.gitignore`**: gets a `.env` line unless a pattern already ignores it.
- **Install**: `npm install @paynp/sdk`, or `pnpm add` / `yarn add` / `bun add` when that lockfile is there.
- **Link**: `.paynp/project.json` with `{ "org", "project" }`. It holds ids, not secrets, so it can be committed.
- **Code**: for Express, Hono, Fastify, Next.js and plain Node it writes `paynp.ts` next to the gateway module or the skill adapters and points the imports at it, then shows a unified diff and asks once. For PHP, Python, Go, Java and Kotlin there is no SDK yet; it prints a small function that posts events to the ingest API.

Rules it keeps: a second run changes nothing, files with uncommitted changes are left alone (unless `--force`), and it never touches `node_modules`, build output or anything outside the project.

## `paynp doctor`

Local checks need no network and never print a secret value:

| Check | Severity | Flags |
|---|---|---|
| `sandbox_gateway_config` | critical | Production config where a gateway runs in sandbox |
| `gateway_env_mismatch` | critical | `*_ENV=production` with sandbox credentials or hosts, or the reverse |
| `test_key_in_production` | warning | A `pnp_test_` key in production config |
| `http_return_url` | critical | Return and base URLs on http or localhost in production config |
| `secret_in_client_bundle` | critical | Secrets behind `NEXT_PUBLIC_`, `VITE_`, `PUBLIC_` and similar prefixes |
| `action_route_without_secret` | warning | `/paynp/actions` served with no `PAYNP_ACTION_SECRET` |
| `gateway_not_wrapped` | warning | Files that still import the gateway modules or adapters directly |
| `env_file_committed` | critical | A tracked `.env*` file with secret values |

Logged in and linked, it then prints the server's findings from live traffic. See [Go-live checklist](/docs/go-live).

## `paynp dev`

One process on `http://localhost:4040` serving ingest with the same validation and redaction as the hosted API, the parts of the API the dashboard reads, the live stream and the dashboard itself. Any key works, and so does none. It answers only requests addressed to `localhost`, `127.x` or `[::1]`.

Events are kept in `.paynp/dev/events.db` when Node has `node:sqlite`, and only in memory otherwise. `--fresh` clears them.

## Endpoint

```bash
paynp login --endpoint http://localhost:8787
```

The endpoint comes from, in order: `--endpoint`, `PAYNP_ENDPOINT`, `PAYNP_ENDPOINT` in the project's `.env`, the endpoint last logged in to, then `https://paynp.discerns.app`. Tokens are stored per endpoint.

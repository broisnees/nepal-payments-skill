# Go-live checklist

Two halves: `paynp doctor` reads the config and code before deploying, and the Go-live tab watches live traffic after.

## Before deploying

```bash
npx paynp doctor          # exit 1 on anything critical, so it can gate a deploy
npx paynp doctor --json
```

It checks the env files (`.env` < `.env.<mode>` < `.env.local` < `.env.<mode>.local`, the way Next.js and Vite load them), the wrangler config and the code, and never prints a secret value. The checks are listed in the [CLI docs](/docs/cli#paynp-doctor): sandbox gateway config in production, mismatched gateway environments, a test key in production, http return URLs, secrets in client bundles, an action route with no secret, gateway modules that are not wrapped, and committed `.env` files.

## On live traffic

The server computes these on ingest and on the minute job, and keeps each finding with its first and last time, count and an example payment:

| Check | Severity | What it means |
|---|---|---|
| `sandbox_gateway_in_live` | critical | Live payments are going to a sandbox gateway: events on a live key say `gw_env: sandbox` |
| `http_return_url` | critical | The return URL is plain http |
| `amount_looks_like_rupees` | warning | Amounts look like rupees sent as paisa (for example Khalti payments under Rs 10, its minimum) |
| `signature_failures` | critical | 3 or more failed signature checks within 10 minutes |
| `no_status_check_after_return` | critical | The return route trusts the redirect: no status call or reconcile within 60 seconds of the callback |
| `fulfil_without_paid` | critical | An order was fulfilled before its payment was paid |
| `double_fulfilment` | critical | An order was fulfilled more than once |
| `no_reconcile` | warning | Open live payments older than an hour and no reconcile job in the last 24 hours |

Each finding links to the fix and the gateway notes. The tab also lists the checks that passed, and a finding can be marked resolved once fixed. `paynp doctor` prints the same server findings when the folder is linked to a project.

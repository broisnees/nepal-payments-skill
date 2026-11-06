# Self-hosting and limits

The whole platform is one Cloudflare Worker: ingest (`/v1`), auth (`/auth`), the REST API (`/api`), the live stream (a Durable Object per project and environment), the cron jobs, the public status pages and this dashboard as static assets. Data lives in D1.

## Limits on the hosted service

The hosted service at `discerns.app` runs on the Workers free plan. D1 allows 50 queries per invocation there, so:

| Limit | Value |
|---|---|
| Events per ingest request | 15 (`INGEST_MAX_EVENTS`); the SDK's default batch is 15 to match |
| Request body | 256 KB |
| Requests per key | 50 per second, then `429` with `Retry-After` |
| Settlement statement upload | 5 MB CSV |
| Event retention | 30 days |
| Payments and analytics retention | 400 days |
| Status page data | 90 days |

A 15-event batch uses 22 to 45 D1 statements, including alert rules and notifications. On a paid plan `INGEST_MAX_EVENTS` can go up to the API's own maximum of 100.

## Running it locally

```bash
cd platform && npm install
npm run db:migrate   # applies worker/migrations to the local D1
npm run dev          # wrangler dev: Worker, local D1 and the Durable Object
```

With no email provider configured, emails (including the sign-in link) are printed to the wrangler console, so local sign-in works without one. Point the SDK and the CLI at it:

```bash
PAYNP_ENDPOINT=http://localhost:8787
npx paynp login --endpoint http://localhost:8787
```

For building an app with no account at all, `npx paynp dev` is simpler: see the [CLI docs](/docs/cli#paynp-dev).

## Deploying my own

1. Create a D1 database and put its id in `worker/wrangler.jsonc` (`d1_databases`).
2. Set `APP_URL` and `EMAIL_FROM` in `vars`, and the route or custom domain.
3. Apply the migrations with `wrangler d1 migrations apply DB --remote`.
4. Mail goes through Resend with the `RESEND_API_KEY` secret (`wrangler secret put RESEND_API_KEY`). On Workers Paid, the Cloudflare Email Sending binding (`send_email` named `EMAIL`) works instead.
5. Build the dashboard into `worker/public` (`npm run build --workspace dashboard`) and run `wrangler deploy` from `worker`.
6. Point the SDK at it with `PAYNP_ENDPOINT`, and the CLI with `--endpoint`.

The cron triggers run every minute (alerts, batched notifications) and at 03:15 UTC, which is 09:00 in Nepal (digest and retention).

# Quickstart

From an empty account to the first payment on the dashboard. Node 20 or newer.

## 1. Sign up

[Create an account](/signup) with a name, a work email and the company name. The email gets a sign-in link that works once, for 15 minutes. Opening it creates the account, an organization with that name and a first project called Default, with a test and a live environment.

## 2. Create a key

The CLI does it from the app's folder:

```bash
npx paynp login
npx paynp init
```

`login` prints a code and opens the approval page in the browser. `init` picks or creates the project, creates a test key, writes `PAYNP_KEY` to `.env` (never overwriting a value that is already there), makes git ignore `.env`, installs `@paynp/sdk` and links the folder in `.paynp/project.json`.

Without the CLI: open the project, then Settings, API keys, and create a test key. It is shown once.

```bash
PAYNP_KEY=pnp_test_...
```

## 3. Install the SDK

```bash
npm install @paynp/sdk
```

Zero runtime dependencies. It runs on Node 20+, Bun, Deno, Cloudflare Workers and the Next.js edge runtime.

## 4. Wrap the payment code

For the skill's adapters (`createPayments` and the gateway factories), wrap each adapter:

```ts
import { createPaynp } from "@paynp/sdk";
import { esewa } from "nepal-payments";

export const paynp = createPaynp({ key: process.env.PAYNP_KEY });
const adapter = paynp.wrapAdapter(esewa({ env: "sandbox", productCode: "EPAYTEST", secretKey }));
```

`paynp init` does this for me: it writes `paynp.ts` beside the library, re-exports everything and replaces each factory and `createPayments` with a version whose adapters go through `paynp.wrapAdapter`, then points the imports at it. It shows the diff and asks once before changing anything.

For the blog's gateway modules (`startPayment` / `confirmPayment`):

```ts
// paynp.ts
import { createPaynp } from "@paynp/sdk";
import * as esewa from "./esewa";

export const paynp = createPaynp({ key: process.env.PAYNP_KEY });
export const gateway = paynp.wrapGateway("esewa", esewa);
```

The wrapped module has the same functions and types. The wrappers rethrow exactly what the module threw.

On serverless, hand the background send to the platform:

```ts
ctx.waitUntil(paynp.flush());   // Cloudflare Workers
after(() => paynp.flush());     // Next.js route handlers
```

## 5. See the first payment

Send a synthetic eSewa payment with the test key:

```bash
npx paynp test
```

It sends started, redirected, callback, signature ok, status COMPLETE, paid and fulfilled, then prints the link to its timeline. It refuses live keys. Then run a real sandbox payment through the app and watch it arrive:

```bash
npx paynp tail
```

> While building, `npx paynp dev` runs the same dashboard on `http://localhost:4040` with no account and no key. The SDK finds it on its own outside production.

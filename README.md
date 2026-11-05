# nepal-payments-skill

[![CI](https://github.com/broisnees/nepal-payments-skill/actions/workflows/ci.yml/badge.svg)](https://github.com/broisnees/nepal-payments-skill/actions/workflows/ci.yml)
[![Agent Skills](https://img.shields.io/badge/Agent%20Skills-spec%20compliant-blue)](https://agentskills.io/specification)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

An [Agent Skill](https://agentskills.io) that integrates Nepali payment gateways into any backend, web app or mobile app: **eSewa, Khalti, Fonepay, connectIPS, CyberSource (via Nepali banks), NPS OnePG and IME Pay**.

Ask your coding agent to "add eSewa and Khalti checkout to this app" and it follows a tested recipe instead of guessing: server-side signing, server-to-server verification, exactly-once fulfilment and reconciliation. The skill ships working adapters in TypeScript and Python with the providers' own signature test vectors.

## Install

**Claude Code** (plugin marketplace):
```
/plugin marketplace add broisnees/nepal-payments-skill
/plugin install nepal-payments@nepal-payments-skill
```

**Any agent that supports Agent Skills** (Claude Code, Codex, Cursor, Gemini CLI, GitHub Copilot and others) via the [skills CLI](https://github.com/vercel-labs/skills):
```bash
npx skills add broisnees/nepal-payments-skill        # this project
npx skills add broisnees/nepal-payments-skill -g     # all projects
```

**Manual**: copy `skills/nepal-payments/` into your agent's skills folder, for example:
```bash
git clone https://github.com/broisnees/nepal-payments-skill
cp -r nepal-payments-skill/skills/nepal-payments ~/.claude/skills/
```

## Use it

Talk to your agent normally. The skill loads when you mention a provider or Nepali payments:

- "Add eSewa and Khalti payments to my Hono API on Cloudflare Workers with D1."
- "Integrate Fonepay dynamic QR for our restaurant POS."
- "Our eSewa callback says ES104 invalid signature. Fix it."
- "Add Khalti checkout to the Flutter app; the backend is FastAPI."
- "Set up connectIPS with our .pfx and a reconciliation job."

## Providers

| Provider | Flows | Adapter | Live-tested |
|---|---|---|---|
| eSewa | ePay v2 (web), Intent (app-to-app) | TS + Python | Sandbox: form, status API, Intent book/status/cancel |
| Khalti | KPG-2 checkout, refunds | TS + Python | With your test key (`KHALTI_SECRET_KEY`) |
| Fonepay | Web redirect, Dynamic QR + WebSocket | TS + Python | Dev gateway: signed redirect accepted, bad signature rejected |
| connectIPS | Direct bank debit (RSA `.pfx`) | TS + Python | Signing verified with OpenSSL; needs NCHL credentials |
| CyberSource | Secure Acceptance (cards via Nepali banks) | TS + Python | Published signature vector; needs a bank-issued profile |
| NPS OnePG | ~29 banks, wallets, cards in one | TS + Python | Offline; needs NPS credentials |
| IME Pay | Wallet (merged into Khalti, 2025) | TS + Python | Offline; needs IME credentials |
| HBL 2C2P, Moru, Prabhu Pay, CellPay, Namaste Pay | | Docs only | |

## What's inside

```
skills/nepal-payments/
├── SKILL.md            workflow, non-negotiable rules, provider table, traps
├── references/         one file per provider + architecture, web, mobile, env, testing
└── scripts/
    ├── ts/             zero-dependency adapters (Node 22.18+, Bun, Deno, Workers, Next.js edge)
    │   ├── src/        core + 7 provider adapters
    │   ├── test/       37 offline tests + live sandbox check
    │   └── examples/   runnable demo server (eSewa + Fonepay sandboxes, no setup)
    └── python/         stdlib adapters (Python 3.10+) + 25 tests
```

The adapters work without any agent too. Copy `scripts/ts/src` or `scripts/python/nepal_payments` into your server code:

```ts
import { createPayments, paymentsConfigFromEnv, newOrderId } from "./payments/index.ts";

const payments = createPayments(paymentsConfigFromEnv());
const init = await payments.get("khalti").initiate({
  orderId: newOrderId(), amountPaisa: 150000, description: "Order #42",
  returnUrl: "https://shop.example.com/payments/khalti/return",
});
// later, in the return handler: verify server-to-server with values from your DB
const result = await payments.get("khalti").verify({
  orderId: attempt.id, amountPaisa: attempt.amountPaisa, providerRef: attempt.providerRef,
});
```

## Guarantees the skill enforces

- Secrets and signing stay on the server; clients only send an order id.
- A redirect or callback is never proof of payment. The provider's status API decides.
- Verification uses the amount and ids from your database, not from the callback.
- State changes go through one tested function (`decideTransition`) that handles early return-URL hits, late payments after an attempt was closed, missing or mismatched amounts and duplicate payments.
- A reconciliation job settles payments where the customer closed the tab.

## Run the tests

```bash
cd skills/nepal-payments/scripts/ts
npm ci && npm test && npm run typecheck   # 37 offline tests + strict tsc
node test/sandbox.ts                      # live eSewa + Fonepay sandbox checks
node examples/server.ts                   # demo on http://localhost:3000

cd ../python
python -m unittest discover -s tests -v   # 25 tests (pip install cryptography for connectIPS)
```

CI runs the official [`skills-ref`](https://github.com/agentskills/agentskills/tree/main/skills-ref) validator plus both test suites on every push.

## Contributing

Provider APIs change. If a sandbox URL, field or status code is out of date, open an issue or PR with the source (official doc, SDK commit or a captured sandbox response). New adapters need the provider's published test vectors as tests before the implementation.

## Disclaimer

Not affiliated with or endorsed by any payment provider. Sandbox credentials in this repo are the public ones from each provider's documentation. Test with your own merchant credentials before going live.

## License

[MIT](LICENSE)

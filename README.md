# nepal-payments-skill

[![CI](https://github.com/broisnees/nepal-payments-skill/actions/workflows/ci.yml/badge.svg)](https://github.com/broisnees/nepal-payments-skill/actions/workflows/ci.yml)
[![Agent Skills](https://img.shields.io/badge/Agent%20Skills-spec%20compliant-blue)](https://agentskills.io/specification)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

An [Agent Skill](https://agentskills.io) that integrates Nepali payment gateways into any backend, web app or mobile app: **eSewa, Khalti, Fonepay, connectIPS, CyberSource (via Nepali banks), NPS OnePG and IME Pay**.

Ask your coding agent to "add eSewa and Khalti checkout to this app" and it follows a tested recipe instead of guessing: server-side signing, server-to-server verification, exactly-once fulfilment and reconciliation. The skill ships working adapters in **TypeScript, Python, Java, Kotlin, PHP and Go**, each tested against the providers' own signature test vectors.

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
| eSewa | ePay v2 (web), Intent (app-to-app) | all 6 | Sandbox: form, status API, Intent book/status/cancel |
| Khalti | KPG-2 checkout, refunds | all 6 | With your test key (`KHALTI_SECRET_KEY`) |
| Fonepay | Web redirect, Dynamic QR + WebSocket | all 6 | Dev gateway: signed redirect accepted, bad signature rejected |
| connectIPS | Direct bank debit (RSA `.pfx`) | all 6 | Signing verified with OpenSSL; needs NCHL credentials |
| CyberSource | Secure Acceptance (cards via Nepali banks) | all 6 | Published signature vector; needs a bank-issued profile |
| NPS OnePG | ~29 banks, wallets, cards in one | all 6 | Offline; needs NPS credentials |
| IME Pay | Wallet (merged into Khalti, 2025) | all 6 | Offline; needs IME credentials |
| HBL 2C2P, Moru, Prabhu Pay, CellPay, Namaste Pay | | Docs only | |

## What's inside

```
skills/nepal-payments/
├── SKILL.md            workflow, non-negotiable rules, provider table, traps
├── references/         one file per provider + architecture, web, mobile, env, testing
└── scripts/
    ├── ts/             Node 22.18+, Bun, Deno, Workers, Next.js edge · 37 tests + demo server
    ├── python/         Python 3.10+, stdlib · 25 tests
    ├── java/           JDK 17+, no dependencies (Spring Boot, Quarkus) · 98 tests
    ├── kotlin/         JDK 17+, suspend API (Ktor, Spring) · 71 tests
    ├── php/            PHP 8.1+, ext-curl/openssl (Laravel, Symfony) · 56 tests
    └── go/             Go 1.22+, stdlib · 56 tests
```
Every suite runs the same signature vectors and mocked-provider cases, and each has a live eSewa + Fonepay sandbox check.

The adapters work without any agent too. Copy the folder for your language into your server code:

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
cd skills/nepal-payments/scripts
(cd ts && npm ci && npm test && npm run typecheck)            # 37 tests + strict tsc
(cd python && python -m unittest discover -s tests)           # 25 tests
(cd java && ./gradlew test)                                    # 98 tests
(cd kotlin && ./gradlew test)                                  # 71 tests
(cd php && composer install && vendor/bin/phpunit)             # 56 tests
(cd go && go test -race ./...)                                 # 56 tests
```
Live sandbox checks: `node test/sandbox.ts`, `./gradlew sandbox`, `php tests/sandbox.php`, `go run ./cmd/sandbox`. Demo: `node examples/server.ts`.

Open work is tracked in [TODO.md](TODO.md).

## Contributing

Provider APIs change. If a sandbox URL, field or status code is out of date, open an issue or PR with the source (official doc, SDK commit or a captured sandbox response). New adapters need the provider's published test vectors as tests before the implementation.

## Disclaimer

Not affiliated with or endorsed by any payment provider. Sandbox credentials in this repo are the public ones from each provider's documentation. Test with your own merchant credentials before going live.

## License

[MIT](LICENSE)

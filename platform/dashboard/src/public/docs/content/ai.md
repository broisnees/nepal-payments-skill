# AI and agents

discerns can answer questions about a project's payments, explain new incidents in the alert itself, and give coding agents the same read access the dashboard has.

## Model

| Setting | Model |
|---|---|
| `ANTHROPIC_API_KEY` secret on the Worker | Claude (`claude-opus-5-5`; override with `AI_MODEL`) |
| No key, Workers AI bound as `AI` | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` (override with `AI_MODEL_WORKERS`) |
| Neither | Ask answers 503 and alerts go out without a summary |

Claude requests carry Anthropic's server-side fallback, so a declined request is retried on the fallback model inside the same call.

## Ask

The **Ask** tab answers questions about the open project and environment: "why did Khalti fail today", "which gateway is slowest this week", "what did we collect yesterday". It works only through the same API the dashboard uses, with my own role, so it sees exactly what I can see. Admins can also ask it to recheck a payment through the action endpoint. Every number in an answer comes from a tool call shown above the answer.

Each project gets 200 questions per day. Conversations stay in the browser tab and are not stored on the server.

## Incident summaries

When an alert opens a new incident, discerns reads the last hour of payment outcomes for that environment and adds two or three sentences to the message: what is failing, on which gateway, and what to check first. Generic webhooks get it as `ai_summary`. Renotifications and resolved notices stay as they were. If the model takes longer than 12 seconds, the alert goes out without it.

## MCP server for coding agents

`https://discerns.app/mcp` is a Model Context Protocol server (Streamable HTTP). It authenticates with a personal access token: create one in **Settings, Tokens** (it prints the Claude Code command too), or run `paynp login` and read it from `~/.config/paynp/credentials.json`.

Claude Code:

```bash
claude mcp add --transport http discerns https://discerns.app/mcp \
  --header "Authorization: Bearer pnp_pat_..."
```

Cursor, Windsurf and other clients take the same URL and header in their MCP settings.

| Tool | Does |
|---|---|
| `list_projects` | Projects I can read, with org and role |
| `search_payments` | Attempts by status, gateway, time window or reference |
| `get_payment` | One attempt's full timeline and the explainer's diagnosis |
| `payment_analytics` | Totals, success rate, revenue, reasons, funnel |
| `gateway_health` | Success rate, error rate and latency per gateway |
| `list_incidents` | Firing and resolved alert incidents |
| `integration_doctor` | Integration problems discerns detected |
| `recheck_payment` | Ask my server to re-check a payment with the gateway (admin) |

Every tool takes `project_id` and `env` (`test` or `live`, default `live`). Refunds are not exposed; they stay a deliberate action in the dashboard.

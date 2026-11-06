// Ask discerns (POST /api/projects/:p/ask), the AI status the dashboard reads (GET /api/ai), and the MCP server for
// coding agents (POST /mcp, Streamable HTTP, stateless, Bearer pnp_pat_...).
import { DISPLAY_NAME } from "@paynp/shared";
import type { Context, Hono } from "hono";
import { requireAuth } from "../auth.ts";
import { requireProject } from "../lib/access.ts";
import { HttpError, badRequest, readJson } from "../lib/util.ts";
import { ROLE_RANK, type AppEnv } from "../types.ts";
import { CLAUDE_MODEL, WORKERS_AI_MODEL, provider, runAgent, type Turn } from "./model.ts";
import { paynpTools, runTool, type Dispatch, type Scope } from "./tools.ts";

/** Questions per project per day, so a stuck client or a loop cannot run up the model bill. */
export const ASK_DAILY_LIMIT = 200;
const MAX_TURNS = 20;
const MAX_TURN_CHARS = 4000;

const ASK_SYSTEM = `You are Ask ${DISPLAY_NAME}, the assistant inside ${DISPLAY_NAME}, a payment observability dashboard for Nepali gateways (eSewa, Khalti, Fonepay, connectIPS, CyberSource, NPS, IME Pay, NEPALPAY QR, Hamro Pay, GetPay).

You answer questions about one project's payments using the tools. Every number you state comes from a tool result in this conversation; if the tools cannot answer, say what is missing.

Facts about the data:
- Amounts are integer paisa. Show rupees: 12500 paisa is Rs 125.
- A payment attempt is one try to pay; an order can have several. Statuses: initiated, pending, paid, failed, canceled, expired, refunded, unknown.
- Timestamps are epoch milliseconds. Show times in Nepal time (UTC+05:45).
- The explainer's diagnosis on a failed payment comes from the gateway's documentation; quote it when it fits.

Answer in short paragraphs or a compact list. Name attempt ids in backticks so I can open them. Do not speculate about card or wallet holders.`;

/** Calls this Worker's own /api with the caller's credentials, as the dashboard would. */
function dispatcher(c: Context<AppEnv>, app: Hono<AppEnv>): Dispatch {
  return async (method, path, body) => {
    const headers = new Headers({ accept: "application/json", "x-paynp-csrf": "1" });
    for (const h of ["cookie", "authorization", "user-agent", "cf-connecting-ip"]) {
      const v = c.req.header(h);
      if (v) headers.set(h, v);
    }
    if (body !== undefined) headers.set("content-type", "application/json");
    const req = new Request(new URL(path, c.req.url), { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const res = await app.fetch(req, c.env, c.executionCtx);
    return { status: res.status, body: await res.json().catch(() => null) };
  };
}

function parseTurns(v: unknown): Turn[] {
  if (!Array.isArray(v) || v.length === 0) throw badRequest("messages must be a non-empty array");
  if (v.length > MAX_TURNS) throw badRequest(`at most ${MAX_TURNS} messages; start a new conversation`);
  const turns = v.map((m, i) => {
    const t = m as { role?: unknown; content?: unknown };
    if ((t.role !== "user" && t.role !== "assistant") || typeof t.content !== "string" || !t.content.trim()) throw badRequest(`messages[${i}] needs role user|assistant and text content`);
    return { role: t.role, content: t.content.slice(0, MAX_TURN_CHARS) } as Turn;
  });
  if (turns[turns.length - 1].role !== "user") throw badRequest("the last message must be from the user");
  return turns;
}

async function countAsk(env: Env, projectId: string): Promise<number> {
  const day = new Date().toISOString().slice(0, 10);
  const r = await env.DB.prepare("INSERT INTO ai_usage (project_id, day, calls) VALUES (?, ?, 1) ON CONFLICT (project_id, day) DO UPDATE SET calls = calls + 1 RETURNING calls")
    .bind(projectId, day)
    .first<{ calls: number }>();
  return r?.calls ?? 1;
}

export function registerAiApi(api: Hono<AppEnv>, app: Hono<AppEnv>) {
  api.get("/ai", (c) => {
    const p = provider(c.env);
    return c.json({ enabled: p !== null, provider: p, model: p === "claude" ? c.env.AI_MODEL || CLAUDE_MODEL : p ? c.env.AI_MODEL_WORKERS || WORKERS_AI_MODEL : null });
  });

  api.post("/projects/:p/ask", async (c) => {
    const { project, role } = await requireProject(c, c.req.param("p"), "viewer");
    if (!provider(c.env)) throw new HttpError(503, "ai_unavailable", "no AI provider is configured on this server");
    const body = await readJson(c.req.raw);
    const env = body.env === "test" ? "test" : body.env === "live" ? "live" : null;
    if (!env) throw badRequest("env must be test or live");
    const history = parseTurns(body.messages);
    if ((await countAsk(c.env, project.id)) > ASK_DAILY_LIMIT) throw new HttpError(429, "rate_limited", `Ask is limited to ${ASK_DAILY_LIMIT} questions per project per day`);

    const scope: Scope = { projectId: project.id, env };
    const dispatch = dispatcher(c, app);
    const result = await runAgent(c.env, {
      system: `${ASK_SYSTEM}\n\nProject: ${project.name} (${project.id}), environment: ${env}. Dashboard links: /p/${project.id}/${env}/payments/<attempt id>.`,
      history,
      tools: paynpTools(scope, { writes: ROLE_RANK[role] >= ROLE_RANK.admin }),
      exec: (name, input) => runTool(dispatch, scope, name, input),
    });
    return c.json({ answer: result.text, tool_calls: result.calls, provider: result.provider, model: result.model });
  });
}

// ---- MCP (Streamable HTTP, stateless: each POST is one JSON-RPC message, answered with JSON) ----

const MCP_PROTOCOL = "2025-06-18";

interface RpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

const rpcResult = (id: RpcRequest["id"], result: unknown) => ({ jsonrpc: "2.0", id: id ?? null, result });
const rpcError = (id: RpcRequest["id"], code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

export function registerMcp(app: Hono<AppEnv>) {
  app.use("/mcp", requireAuth);
  app.get("/mcp", (c) => c.body(null, 405, { allow: "POST" }));
  app.delete("/mcp", (c) => c.body(null, 405, { allow: "POST" }));

  app.post("/mcp", async (c) => {
    const msg = (await c.req.json().catch(() => null)) as RpcRequest | RpcRequest[] | null;
    if (!msg || Array.isArray(msg) || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return c.json(rpcError(null, -32600, "expected one JSON-RPC 2.0 request"), 400);
    // Notifications (no id) need no answer.
    if (msg.id === undefined) return c.body(null, 202);

    const scope: Scope = {};
    const tools = paynpTools(scope, { writes: true });
    switch (msg.method) {
      case "initialize":
        return c.json(
          rpcResult(msg.id, {
            protocolVersion: MCP_PROTOCOL,
            capabilities: { tools: {} },
            serverInfo: { name: DISPLAY_NAME, version: "1.0.0" },
            instructions: `${DISPLAY_NAME} records every payment attempt on Nepali gateways as a timeline. Start with list_projects, then search_payments or get_payment. Amounts are paisa (100 = Rs 1). env defaults to live.`,
          }),
        );
      case "ping":
        return c.json(rpcResult(msg.id, {}));
      case "tools/list":
        return c.json(rpcResult(msg.id, { tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.input_schema })) }));
      case "tools/call": {
        const name = typeof msg.params?.name === "string" ? msg.params.name : "";
        if (!tools.some((t) => t.name === name)) return c.json(rpcError(msg.id, -32602, `unknown tool ${name}`));
        const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
        try {
          const text = await runTool(dispatcher(c, app), scope, name, args);
          return c.json(rpcResult(msg.id, { content: [{ type: "text", text }], isError: false }));
        } catch (e) {
          return c.json(rpcResult(msg.id, { content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }], isError: true }));
        }
      }
      default:
        return c.json(rpcError(msg.id, -32601, `method not found: ${msg.method}`));
    }
  });
}

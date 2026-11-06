// The language model behind Ask discerns and incident summaries. Claude when ANTHROPIC_API_KEY is set, else Workers AI
// through the AI binding, else none (every AI feature then answers 503 or is skipped).
import Anthropic from "@anthropic-ai/sdk";

export const CLAUDE_MODEL = "claude-opus-5-5";
export const WORKERS_AI_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

export type Provider = "claude" | "workers-ai";

export interface ToolDef {
  name: string;
  description: string;
  /** JSON Schema for the input object. */
  input_schema: { type: "object"; properties: Record<string, unknown>; required?: string[]; additionalProperties?: boolean };
}

export interface Turn {
  role: "user" | "assistant";
  content: string;
}

export interface ToolCall {
  name: string;
  input: Record<string, unknown>;
  ok: boolean;
}

export interface AgentResult {
  text: string;
  calls: ToolCall[];
  provider: Provider;
  model: string;
}

/** Runs one tool; returns its result as text for the model. Throwing marks the call failed. */
export type ExecTool = (name: string, input: Record<string, unknown>) => Promise<string>;

export function provider(env: Env): Provider | null {
  if (env.ANTHROPIC_API_KEY) return "claude";
  if (env.AI) return "workers-ai";
  return null;
}

/** A model loop over tools: ask, run the tools it calls, feed the results back, until it answers or steps run out. */
export async function runAgent(env: Env, opts: { system: string; history: Turn[]; tools: ToolDef[]; exec: ExecTool; maxSteps?: number }): Promise<AgentResult> {
  const p = provider(env);
  if (p === "claude") return claudeAgent(env, opts);
  if (p === "workers-ai") return workersAgent(env, opts);
  throw new Error("no AI provider configured");
}

/** One prompt, one answer, no tools. Null when no provider is configured or the call fails. */
export async function complete(env: Env, opts: { system: string; prompt: string }): Promise<string | null> {
  try {
    const r = await runAgent(env, { system: opts.system, history: [{ role: "user", content: opts.prompt }], tools: [], exec: async () => "", maxSteps: 1 });
    return r.text.trim() || null;
  } catch (e) {
    console.error(JSON.stringify({ msg: "ai completion failed", error: String(e) }));
    return null;
  }
}

async function claudeAgent(env: Env, opts: { system: string; history: Turn[]; tools: ToolDef[]; exec: ExecTool; maxSteps?: number }): Promise<AgentResult> {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 2 });
  const model = env.AI_MODEL || CLAUDE_MODEL;
  const messages: Anthropic.Beta.BetaMessageParam[] = opts.history.map((t) => ({ role: t.role, content: t.content }));
  const tools: Anthropic.Beta.BetaTool[] = opts.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema }));
  const calls: ToolCall[] = [];
  const maxSteps = opts.maxSteps ?? 8;

  for (let step = 0; step < maxSteps; step++) {
    const res = await client.beta.messages.create({
      model,
      max_tokens: 16000,
      // The system prompt and tool list never change within a conversation, so they cache.
      system: [{ type: "text", text: opts.system, cache_control: { type: "ephemeral" } }],
      ...(tools.length ? { tools } : {}),
      output_config: { effort: "medium" },
      betas: [FALLBACK_BETA],
      fallbacks: "default",
      messages,
    });

    if (res.stop_reason === "refusal") return { text: "I can't help with that one.", calls, provider: "claude", model };
    // Keep the whole assistant turn (thinking blocks included) so the next request continues it unchanged.
    messages.push({ role: "assistant", content: res.content });
    if (res.stop_reason === "pause_turn") continue;

    const uses = res.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    if (res.stop_reason !== "tool_use" || uses.length === 0) {
      const text = res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n");
      return { text, calls, provider: "claude", model };
    }

    // Every tool result goes back in one user message.
    const results: Anthropic.Beta.BetaToolResultBlockParam[] = await Promise.all(
      uses.map(async (u) => {
        const input = (u.input ?? {}) as Record<string, unknown>;
        try {
          const out = await opts.exec(u.name, input);
          calls.push({ name: u.name, input, ok: true });
          return { type: "tool_result" as const, tool_use_id: u.id, content: out };
        } catch (e) {
          calls.push({ name: u.name, input, ok: false });
          return { type: "tool_result" as const, tool_use_id: u.id, content: e instanceof Error ? e.message : String(e), is_error: true };
        }
      }),
    );
    messages.push({ role: "user", content: results });
  }
  return { text: "That took more steps than I allow for one question. Try narrowing it down.", calls, provider: "claude", model };
}

// Workers AI models answer in one of two shapes: the classic { response, tool_calls } or OpenAI's choices[].
interface WorkersCall {
  id?: string;
  name?: string;
  arguments?: unknown;
  function?: { name: string; arguments: unknown };
}
interface WorkersOut {
  response?: string | null;
  tool_calls?: WorkersCall[];
  choices?: { message?: { content?: string | null; tool_calls?: WorkersCall[] } }[];
}

const parseArgs = (a: unknown): Record<string, unknown> => {
  if (a && typeof a === "object") return a as Record<string, unknown>;
  if (typeof a === "string") {
    try {
      const v = JSON.parse(a);
      return v && typeof v === "object" ? v : {};
    } catch {
      return {};
    }
  }
  return {};
};

async function workersAgent(env: Env, opts: { system: string; history: Turn[]; tools: ToolDef[]; exec: ExecTool; maxSteps?: number }): Promise<AgentResult> {
  const model = env.AI_MODEL_WORKERS || WORKERS_AI_MODEL;
  type Msg = { role: string; content: string; name?: string; tool_call_id?: string; tool_calls?: unknown[] };
  const messages: Msg[] = [{ role: "system", content: opts.system }, ...opts.history];
  const tools = opts.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } }));
  const calls: ToolCall[] = [];
  const maxSteps = opts.maxSteps ?? 6;

  for (let step = 0; step < maxSteps; step++) {
    const out = (await env.AI!.run(model as keyof AiModels, { messages, ...(tools.length ? { tools } : {}), max_tokens: 2048 } as never)) as WorkersOut;
    const msg = out.choices?.[0]?.message;
    const raw = msg?.tool_calls ?? out.tool_calls ?? [];
    const text = (msg?.content ?? out.response ?? "").toString();
    if (raw.length === 0) return { text, calls, provider: "workers-ai", model };

    const parsed = raw.map((c, i) => ({ id: c.id ?? `call_${step}_${i}`, name: c.function?.name ?? c.name ?? "", input: parseArgs(c.function?.arguments ?? c.arguments) }));
    messages.push({ role: "assistant", content: text, tool_calls: parsed.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.input) } })) });
    for (const c of parsed) {
      let content: string;
      try {
        content = await opts.exec(c.name, c.input);
        calls.push({ name: c.name, input: c.input, ok: true });
      } catch (e) {
        content = `error: ${e instanceof Error ? e.message : String(e)}`;
        calls.push({ name: c.name, input: c.input, ok: false });
      }
      messages.push({ role: "tool", name: c.name, tool_call_id: c.id, content });
    }
  }
  return { text: "That took more steps than I allow for one question. Try narrowing it down.", calls, provider: "workers-ai", model };
}

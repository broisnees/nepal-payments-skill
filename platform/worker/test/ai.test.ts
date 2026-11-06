import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { call, ev, ingest, json, setup } from "./helpers.ts";

async function pat(cookie: string): Promise<string> {
  const d = await json(call("POST", "/auth/device"));
  await call("POST", "/api/device/approve", { cookie, body: { user_code: d.user_code } });
  return (await json(call("POST", "/auth/device/token", { body: { device_code: d.device_code } }))).token;
}

const rpc = (token: string | undefined, method: string, params?: unknown, id: number | null = 1) =>
  call("POST", "/mcp", { ...(token ? { pat: token } : {}), body: { jsonrpc: "2.0", ...(id === null ? {} : { id }), method, ...(params ? { params } : {}) } });

describe("MCP server", () => {
  it("needs a token", async () => {
    expect((await rpc(undefined, "initialize")).status).toBe(401);
  });

  it("initializes, lists tools, and answers tool calls through the REST API with my permissions", async () => {
    const s = await setup("live");
    await ingest(s.key, [ev("payment.started", "mcp-1", 0, { amount_paisa: 12500, status: "initiated" }), ev("error", "mcp-1", 10, { data: { reason: "bad_signature" } })]);
    const token = await pat(s.cookie);

    const init = await json(rpc(token, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } }));
    expect(init.result.protocolVersion).toBe("2025-06-18");
    expect(init.result.capabilities.tools).toBeDefined();
    expect((await rpc(token, "notifications/initialized", undefined, null)).status).toBe(202);

    const list = await json(rpc(token, "tools/list"));
    const names = list.result.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual(expect.arrayContaining(["list_projects", "search_payments", "get_payment", "payment_analytics", "recheck_payment"]));
    expect(list.result.tools.find((t: { name: string }) => t.name === "get_payment").inputSchema.required).toEqual(["project_id", "attempt_id"]);

    const projects = await json(rpc(token, "tools/call", { name: "list_projects", arguments: {} }));
    expect(projects.result.isError).toBe(false);
    expect(projects.result.content[0].text).toContain(s.projectId);

    const found = await json(rpc(token, "tools/call", { name: "search_payments", arguments: { project_id: s.projectId, env: "live" } }));
    expect(JSON.parse(found.result.content[0].text).items.map((p: { attempt_id: string }) => p.attempt_id)).toContain("mcp-1");

    const detail = await json(rpc(token, "tools/call", { name: "get_payment", arguments: { project_id: s.projectId, attempt_id: "mcp-1" } }));
    expect(JSON.parse(detail.result.content[0].text).events.length).toBeGreaterThan(0);
  });

  it("reports API errors as tool errors and refuses projects I am not in", async () => {
    const a = await setup();
    const b = await setup();
    const token = await pat(a.cookie);
    const other = await json(rpc(token, "tools/call", { name: "search_payments", arguments: { project_id: b.projectId } }));
    expect(other.result.isError).toBe(true);
    const missing = await json(rpc(token, "tools/call", { name: "get_payment", arguments: { project_id: a.projectId, attempt_id: "nope" } }));
    expect(missing.result.isError).toBe(true);
    expect((await json(rpc(token, "tools/call", { name: "drop_tables", arguments: {} }))).error.code).toBe(-32602);
    expect((await json(rpc(token, "resources/list"))).error.code).toBe(-32601);
  });
});

describe("Ask paynp", () => {
  it("reports whether a model is configured and validates the conversation", async () => {
    const s = await setup();
    const ai = await json(call("GET", "/api/ai", { cookie: s.cookie }));
    expect(ai.enabled).toBe(!!((env as { ANTHROPIC_API_KEY?: string }).ANTHROPIC_API_KEY || env.AI));
    const ask = (body: unknown) => call("POST", `/api/projects/${s.projectId}/ask`, { cookie: s.cookie, body });
    if (!ai.enabled) {
      expect((await ask({ env: "test", messages: [{ role: "user", content: "hi" }] })).status).toBe(503);
      return;
    }
    expect((await ask({ env: "test", messages: [] })).status).toBe(400);
    expect((await ask({ env: "test", messages: [{ role: "assistant", content: "hi" }] })).status).toBe(400);
  });
});

describe("tokens from the dashboard", () => {
  it("a session can create a token that works on /mcp; a token cannot create another", async () => {
    const s = await setup();
    const r = await call("POST", "/api/pats", { cookie: s.cookie, body: { name: "Claude Code" } });
    expect(r.status).toBe(201);
    const { token } = (await r.json()) as { token: string };
    expect(token).toMatch(/^pnp_pat_/);
    expect((await rpc(token, "ping")).status).toBe(200);
    expect((await call("POST", "/api/pats", { pat: token, body: {} })).status).toBe(403);
  });
});

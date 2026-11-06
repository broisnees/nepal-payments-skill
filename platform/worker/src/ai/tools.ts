// The discerns tools that Ask discerns and the MCP server share. Each one is a call to the REST API made with the caller's
// own credentials, so permissions and response shapes are exactly the dashboard's.
import type { ToolDef } from "./model.ts";

/** Calls /api with the caller's credentials. Returns the status and the parsed JSON body. */
export type Dispatch = (method: "GET" | "POST", path: string, body?: unknown) => Promise<{ status: number; body: unknown }>;

/** Fixed when the dashboard asks (the open project); chosen per call by an MCP client. */
export interface Scope {
  projectId?: string;
  env?: "test" | "live";
}

const STATUSES = ["initiated", "pending", "paid", "failed", "canceled", "expired", "refunded", "unknown"];
const HOUR = 3_600_000;
// Tool results go back into the model's context; a 1000-event timeline would crowd out everything else.
const MAX_RESULT_CHARS = 14_000;

const projectParams = {
  project_id: { type: "string", description: "Project id (prj_...). list_projects shows the ones I can read." },
  env: { type: "string", enum: ["test", "live"], description: "Environment. Default live." },
};

function withScope(scope: Scope, props: Record<string, unknown>, required: string[] = []): ToolDef["input_schema"] {
  if (scope.projectId) return { type: "object", properties: props, required, additionalProperties: false };
  return { type: "object", properties: { ...projectParams, ...props }, required: ["project_id", ...required], additionalProperties: false };
}

export function paynpTools(scope: Scope, opts: { writes: boolean }): ToolDef[] {
  const tools: ToolDef[] = [];
  if (!scope.projectId) {
    tools.push({ name: "list_projects", description: "Lists the discerns projects I can read, with their org and my role.", input_schema: { type: "object", properties: {}, additionalProperties: false } });
  }
  tools.push(
    {
      name: "search_payments",
      description:
        "Finds payment attempts, newest first. Filter by status, gateway, a time window, or a search on attempt id, order id or the gateway's reference. Amounts are in paisa (100 paisa = Rs 1).",
      input_schema: withScope(scope, {
        status: { type: "array", items: { type: "string", enum: STATUSES }, description: "Only these statuses." },
        gateway: { type: "string", description: "Gateway id: esewa, khalti, fonepay, connectips, cybersource, nps, imepay, nepalpay, hamropay, getpay." },
        query: { type: "string", description: "Prefix of an attempt id, order id or provider reference." },
        since_hours: { type: "number", description: "Only attempts started in the last N hours." },
        limit: { type: "number", description: "Up to 50. Default 20." },
      }),
    },
    {
      name: "get_payment",
      description: "One payment attempt with its full event timeline (requests to the gateway, callbacks, signature checks, status changes) and the explainer's diagnosis when it failed.",
      input_schema: withScope(scope, { attempt_id: { type: "string" } }, ["attempt_id"]),
    },
    {
      name: "payment_analytics",
      description: "Totals, success rate, revenue, top failure reasons, time to pay and the funnel over a window, optionally for one gateway.",
      input_schema: withScope(scope, {
        since_hours: { type: "number", description: "Window length in hours. Default 168 (7 days)." },
        gateway: { type: "string" },
      }),
    },
    {
      name: "gateway_health",
      description: "Each gateway's success rate, error rate and latency over the last hour and day.",
      input_schema: withScope(scope, {}),
    },
    {
      name: "list_incidents",
      description: "Alert incidents (firing or resolved), newest first, with the rule that raised them.",
      input_schema: withScope(scope, { state: { type: "string", enum: ["firing", "resolved"] } }),
    },
    {
      name: "integration_doctor",
      description: "Problems discerns found in how the integration reports payments: sandbox gateway in live, http return URLs, rupees sent as paisa, missing status checks, double fulfilment.",
      input_schema: withScope(scope, {}),
    },
  );
  if (opts.writes) {
    tools.push({
      name: "recheck_payment",
      description:
        "Asks my server, through the signed action endpoint, to check this payment's status with the gateway again. Read-only at the gateway; needs the admin role and an action endpoint.",
      input_schema: withScope(scope, { attempt_id: { type: "string" } }, ["attempt_id"]),
    });
  }
  return tools;
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const num = (v: unknown, min: number, max: number, dflt: number) => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
};

function clip(body: unknown): string {
  const s = JSON.stringify(body);
  return s.length <= MAX_RESULT_CHARS ? s : `${s.slice(0, MAX_RESULT_CHARS)}... (cut at ${MAX_RESULT_CHARS} characters; narrow the query for the rest)`;
}

/** Runs one tool. Throws with the API's error message when the call fails, so the model sees why. */
export async function runTool(dispatch: Dispatch, scope: Scope, name: string, input: Record<string, unknown>): Promise<string> {
  const call = async (method: "GET" | "POST", path: string, body?: unknown) => {
    const r = await dispatch(method, path, body);
    if (r.status >= 400) {
      const err = (r.body as { error?: { message?: string } } | null)?.error?.message ?? `HTTP ${r.status}`;
      throw new Error(err);
    }
    return r.body;
  };

  if (name === "list_projects") {
    const me = (await call("GET", "/api/me")) as { orgs: { id: string; name: string; role: string }[] };
    const out = await Promise.all(
      me.orgs.map(async (o) => {
        const ps = (await call("GET", `/api/orgs/${o.id}/projects`)) as { items: { id: string; name: string; slug: string }[] };
        return { org: o.name, role: o.role, projects: ps.items.map((p) => ({ id: p.id, name: p.name, slug: p.slug })) };
      }),
    );
    return clip(out);
  }

  const projectId = scope.projectId ?? str(input.project_id);
  if (!projectId || !/^prj_[A-Za-z0-9]+$/.test(projectId)) throw new Error("project_id is required (prj_...)");
  const env = scope.env ?? (input.env === "test" ? "test" : "live");
  const base = `/api/projects/${projectId}`;
  const t = Date.now();

  switch (name) {
    case "search_payments": {
      const q = new URLSearchParams({ env, limit: String(num(input.limit, 1, 50, 20)) });
      const statuses = Array.isArray(input.status) ? input.status.filter((s): s is string => typeof s === "string" && STATUSES.includes(s)) : [];
      if (statuses.length) q.set("status", statuses.join(","));
      if (str(input.gateway)) q.set("gateway", str(input.gateway)!);
      if (str(input.query)) q.set("q", str(input.query)!);
      if (input.since_hours !== undefined) q.set("from", String(t - num(input.since_hours, 1, 24 * 400, 24) * HOUR));
      return clip(await call("GET", `${base}/payments?${q}`));
    }
    case "get_payment": {
      const id = str(input.attempt_id);
      if (!id) throw new Error("attempt_id is required");
      return clip(await call("GET", `${base}/payments/${encodeURIComponent(id)}?env=${env}`));
    }
    case "payment_analytics": {
      const hours = num(input.since_hours, 1, 24 * 400, 168);
      const q = new URLSearchParams({ env, from: String(t - hours * HOUR), to: String(t), bucket: hours > 72 ? "day" : "hour" });
      if (str(input.gateway)) q.set("gateway", str(input.gateway)!);
      return clip(await call("GET", `${base}/analytics?${q}`));
    }
    case "gateway_health":
      return clip(await call("GET", `${base}/health?env=${env}`));
    case "list_incidents": {
      const q = new URLSearchParams({ limit: "20" });
      if (input.state === "firing" || input.state === "resolved") q.set("state", input.state);
      return clip(await call("GET", `${base}/incidents?${q}`));
    }
    case "integration_doctor":
      return clip(await call("GET", `${base}/doctor?env=${env}`));
    case "recheck_payment": {
      const id = str(input.attempt_id);
      if (!id) throw new Error("attempt_id is required");
      return clip(await call("POST", `${base}/payments/${encodeURIComponent(id)}/recheck`, { env }));
    }
  }
  throw new Error(`unknown tool ${name}`);
}

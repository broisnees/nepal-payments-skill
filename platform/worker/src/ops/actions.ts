// Signed actions (SPEC-v2 section 3): paynp POSTs to the merchant's own server, which acts with its own gateway keys.
//   X-Paynp-Signature: sha256=<hex HMAC-SHA256(secret, timestamp + "." + body)>
//   X-Paynp-Timestamp: <unix seconds>
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, newId, type ActionKind, type ActionPayload, type ActionRecord, type ActionReply, type Env as PayEnv, type PaymentStatus } from "@paynp/shared";
import { hmacSha256Hex, now, parseJson } from "../lib/util.ts";

export const ACTION_TIMEOUT_MS = 20_000;

export interface EndpointRow {
  project_id: string;
  env: string;
  url: string;
  secret: string;
  created_at: number;
  last_ok_at: number | null;
  last_error: string | null;
}

export interface ActionRow {
  id: string;
  project_id: string;
  env: string;
  kind: ActionKind;
  attempt_id: string;
  payload: string;
  status: "pending" | "ok" | "failed";
  response: string | null;
  created_at: number;
  finished_at: number | null;
  requested_by: string | null;
}

export async function signAction(secret: string, timestamp: number, body: string): Promise<string> {
  return `sha256=${await hmacSha256Hex(secret, `${timestamp}.${body}`)}`;
}

export function toAction(r: ActionRow): ActionRecord {
  return {
    id: r.id,
    env: r.env as PayEnv,
    kind: r.kind,
    attempt_id: r.attempt_id,
    status: r.status,
    payload: parseJson(r.payload, {} as ActionPayload),
    response: parseJson(r.response, null),
    created_at: r.created_at,
    finished_at: r.finished_at,
    requested_by: r.requested_by,
  };
}

const STATUSES = new Set(["initiated", "pending", "paid", "failed", "canceled", "expired", "refunded", "unknown"]);

/** Reads the merchant's answer: HTTP 200 with {ok: boolean, ...}. Anything else is a failure with the reason. */
async function readReply(res: Response): Promise<ActionReply & { http_status: number }> {
  const text = (await res.text()).slice(0, 4000);
  const body = parseJson<Record<string, unknown> | null>(text, null);
  if (res.status !== 200) return { ok: false, http_status: res.status, error: `HTTP ${res.status}${typeof body?.error === "string" ? `: ${body.error.slice(0, 300)}` : ""}` };
  if (!body || typeof body.ok !== "boolean") return { ok: false, http_status: 200, error: "response is not {\"ok\": boolean}" };
  const reply: ActionReply & { http_status: number } = { ok: body.ok, http_status: 200 };
  if (typeof body.refund_ref === "string" && body.refund_ref) reply.refund_ref = body.refund_ref.slice(0, 200);
  if (typeof body.status === "string" && STATUSES.has(body.status)) reply.status = body.status as PaymentStatus;
  if (typeof body.error === "string") reply.error = body.error.slice(0, 500);
  if (!reply.ok && !reply.error) reply.error = "merchant answered ok: false";
  return reply;
}

/**
 * Records the action, POSTs it signed, records the answer and the endpoint's health. Never throws for delivery
 * problems: a timeout, a network error or a non-200 is a failed action with the reason in `response.error`.
 */
export async function sendAction(
  env: Env,
  ep: EndpointRow,
  input: Omit<ActionPayload, "id">,
  requestedBy: string | null,
  t = now(),
): Promise<ActionRecord> {
  const payload: ActionPayload = { id: newId("act", t), ...input };
  const body = JSON.stringify(payload);
  const row: ActionRow = {
    id: payload.id, project_id: ep.project_id, env: ep.env, kind: payload.kind, attempt_id: payload.attempt_id, payload: body,
    status: "pending", response: null, created_at: t, finished_at: null, requested_by: requestedBy,
  };
  await env.DB.prepare("INSERT INTO actions (id, project_id, env, kind, attempt_id, payload, status, created_at, requested_by) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)")
    .bind(row.id, row.project_id, row.env, row.kind, row.attempt_id, body, t, requestedBy)
    .run();

  const ts = Math.floor(Date.now() / 1000);
  let reply: ActionReply & { http_status?: number };
  try {
    const res = await fetch(ep.url, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "paynp-actions/1", [SIGNATURE_HEADER]: await signAction(ep.secret, ts, body), [TIMESTAMP_HEADER]: String(ts) },
      body,
      signal: AbortSignal.timeout(ACTION_TIMEOUT_MS),
    });
    reply = await readReply(res);
  } catch (e) {
    const name = e instanceof Error ? e.name : "";
    reply = { ok: false, error: name === "TimeoutError" || name === "AbortError" ? `no answer within ${ACTION_TIMEOUT_MS / 1000} s` : String(e instanceof Error ? e.message : e).slice(0, 300) };
  }
  const done = now();
  const status = reply.ok ? "ok" : "failed";
  // The endpoint is healthy when it answered properly, even with ok: false (that is the merchant's gateway saying no).
  const reachable = reply.http_status === 200 && (reply.ok || reply.error !== "response is not {\"ok\": boolean}");
  await env.DB.batch([
    env.DB.prepare("UPDATE actions SET status = ?, response = ?, finished_at = ? WHERE id = ?").bind(status, JSON.stringify(reply), done, row.id),
    reachable
      ? env.DB.prepare("UPDATE action_endpoints SET last_ok_at = ?, last_error = NULL WHERE project_id = ? AND env = ?").bind(done, ep.project_id, ep.env)
      : env.DB.prepare("UPDATE action_endpoints SET last_error = ? WHERE project_id = ? AND env = ?").bind(reply.error ?? "failed", ep.project_id, ep.env),
  ]);
  return toAction({ ...row, status, response: JSON.stringify(reply), finished_at: done });
}

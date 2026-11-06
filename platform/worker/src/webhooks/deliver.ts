// Sends due webhook deliveries for one project environment and records each attempt. Called from the
// WebhookSender alarm, so each run has its own D1 and subrequest budget: at most 20 sends and 25 statements.
// Deliveries to one endpoint go out in order, one at a time; different endpoints run in parallel.
import { WEBHOOK_DISABLE_AFTER_MS, WEBHOOK_RETRY_DELAYS_MS } from "@paynp/shared";
import { now as clock } from "../lib/util.ts";
import { signedHeaders } from "./sign.ts";

export const SEND_BATCH = 20;
export const SEND_TIMEOUT_MS = 15_000;
const SNIPPET = 500;

export interface EndpointSecrets {
  secret: string;
  prev_secret: string | null;
  prev_secret_until: number | null;
}

export interface SendResult {
  ok: boolean;
  status: number | null;
  ms: number;
  error: string | null;
  response: string | null;
}

/** Current secret first; the previous one too while a rotation's grace period lasts. */
export const secretsOf = (e: EndpointSecrets, t: number) => (e.prev_secret && (e.prev_secret_until ?? 0) > t ? [e.secret, e.prev_secret] : [e.secret]);

async function snippet(res: Response): Promise<string | null> {
  if (!res.body) return null;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (text.length < SNIPPET) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  await reader.cancel().catch(() => {});
  return text.slice(0, SNIPPET) || null;
}

/** One signed POST. Only a 2xx counts; redirects are not followed. Never throws. */
export async function send(url: string, secrets: string[], eventId: string, body: string, t = clock()): Promise<SendResult> {
  const started = Date.now();
  try {
    const headers = await signedHeaders(secrets, eventId, Math.floor(t / 1000), body);
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "paynp-webhooks/1", ...headers },
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    const ok = res.status >= 200 && res.status < 300;
    const response = await snippet(res).catch(() => null);
    return { ok, status: res.status, ms: Date.now() - started, error: ok ? null : `HTTP ${res.status}`, response };
  } catch (e) {
    const timeout = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
    const error = timeout ? `no response in ${SEND_TIMEOUT_MS / 1000} s` : String(e instanceof Error ? e.message : e).slice(0, 300);
    return { ok: false, status: null, ms: Date.now() - started, error, response: null };
  }
}

/** Status and next try after attempt number `n` (1-based). */
export function afterAttempt(ok: boolean, n: number, at: number): { status: "delivered" | "pending" | "failed"; next_at: number | null } {
  if (ok) return { status: "delivered", next_at: null };
  const delay = WEBHOOK_RETRY_DELAYS_MS[n - 1];
  return delay === undefined ? { status: "failed", next_at: null } : { status: "pending", next_at: at + delay };
}

interface DueRow extends EndpointSecrets {
  id: string;
  endpoint_id: string;
  event_id: string;
  payload: string;
  attempts: number;
  url: string;
}

const DISABLED_REASON = "Every delivery failed for 5 days";

/** Sends what is due and returns when the next pending delivery is due (null when none is). */
export async function deliverDue(env: Env, projectId: string, envName: string, t = clock()): Promise<number | null> {
  const due = (
    await env.DB.prepare(
      `SELECT d.id, d.endpoint_id, d.event_id, d.payload, d.attempts, w.url, w.secret, w.prev_secret, w.prev_secret_until
       FROM webhook_deliveries d JOIN webhook_endpoints w ON w.id = d.endpoint_id
       WHERE d.project_id = ? AND d.env = ? AND d.status = 'pending' AND d.next_at <= ? AND w.enabled = 1
       ORDER BY d.next_at, d.created_at LIMIT ?`,
    )
      .bind(projectId, envName, t, SEND_BATCH)
      .all<DueRow>()
  ).results;

  const groups = new Map<string, DueRow[]>();
  for (const r of due) groups.set(r.endpoint_id, [...(groups.get(r.endpoint_id) ?? []), r]);
  const results = new Map<string, SendResult>();
  await Promise.all(
    [...groups.values()].map(async (rows) => {
      for (const r of rows) results.set(r.id, await send(r.url, secretsOf(r, t), r.event_id, r.payload, t));
    }),
  );

  const at = clock();
  const stmts: D1PreparedStatement[] = due.map((r) => {
    const res = results.get(r.id)!;
    const n = r.attempts + 1;
    const next = afterAttempt(res.ok, n, at);
    return env.DB.prepare(
      "UPDATE webhook_deliveries SET status = ?, attempts = ?, next_at = ?, last_at = ?, last_status = ?, last_error = ?, last_ms = ?, last_response = ? WHERE id = ? AND status = 'pending'",
    ).bind(next.status, n, next.next_at, at, res.status, res.error, res.ms, res.response, r.id);
  });

  // An endpoint works if anything reached it this run. One that has failed everything for 5 days is turned off,
  // and its queue fails with it so nothing piles up behind a dead URL.
  const working = [...groups].filter(([, rows]) => rows.some((r) => results.get(r.id)!.ok)).map(([id]) => id);
  const failing = [...groups.keys()].filter((id) => !working.includes(id));
  const ph = (ids: string[]) => ids.map(() => "?").join(",");
  if (working.length) stmts.push(env.DB.prepare(`UPDATE webhook_endpoints SET failing_since = NULL WHERE id IN (${ph(working)})`).bind(...working));
  if (failing.length) {
    const cutoff = at - WEBHOOK_DISABLE_AFTER_MS;
    stmts.push(
      env.DB.prepare(
        `UPDATE webhook_endpoints SET failing_since = COALESCE(failing_since, ?1),
           enabled = CASE WHEN COALESCE(failing_since, ?1) <= ?2 THEN 0 ELSE enabled END,
           disabled_reason = CASE WHEN COALESCE(failing_since, ?1) <= ?2 THEN ?3 ELSE disabled_reason END
         WHERE id IN (${failing.map((_, i) => `?${4 + i}`).join(",")})`,
      ).bind(at, cutoff, DISABLED_REASON, ...failing),
      failPendingStatement(env, failing, "endpoint disabled", at, true),
    );
  }
  stmts.push(
    env.DB.prepare(
      "SELECT MIN(d.next_at) AS next FROM webhook_deliveries d JOIN webhook_endpoints w ON w.id = d.endpoint_id WHERE d.project_id = ? AND d.env = ? AND d.status = 'pending' AND w.enabled = 1",
    ).bind(projectId, envName),
  );
  const out = await env.DB.batch(stmts);
  return (out[out.length - 1].results[0] as { next: number | null } | undefined)?.next ?? null;
}

/** Fails the pending deliveries of these endpoints (only the disabled ones when `onlyDisabled`). */
export function failPendingStatement(env: Env, endpointIds: string[], reason: string, at: number, onlyDisabled = false): D1PreparedStatement {
  const ids = endpointIds.map((_, i) => `?${4 + i}`).join(",");
  const scope = onlyDisabled ? `SELECT id FROM webhook_endpoints WHERE enabled = 0 AND id IN (${ids})` : ids;
  return env.DB.prepare(`UPDATE webhook_deliveries SET status = 'failed', next_at = NULL, last_error = ?1, last_at = COALESCE(last_at, ?2) WHERE status = ?3 AND endpoint_id IN (${scope})`).bind(
    reason,
    at,
    "pending",
    ...endpointIds,
  );
}

/** Kicks the sender of every scope with a delivery overdue by 2 minutes: a lost alarm never strands a queue. */
export async function kickOverdue(env: Env, t = clock()): Promise<number> {
  const rows = (
    await env.DB.prepare("SELECT DISTINCT project_id, env FROM webhook_deliveries WHERE status = 'pending' AND next_at <= ? LIMIT 20").bind(t - 120_000).all<{ project_id: string; env: string }>()
  ).results;
  await Promise.all(rows.map((r) => kick(env, r.project_id, r.env)));
  return rows.length;
}

export function kick(env: Env, projectId: string, envName: string): Promise<void> {
  return env.WEBHOOKS.getByName(`${projectId}:${envName}`)
    .kick(projectId, envName)
    .catch((e: unknown) => console.error(JSON.stringify({ msg: "webhook kick failed", project: projectId, env: envName, error: String(e) })));
}

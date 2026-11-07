// POST /v1/inbound/:id: a provider's webhook delivery. Verified with the source's signing secret, mapped to
// PaymentEvents and ingested exactly like SDK events (live feed, alerts, outbound webhooks all follow).
// Status codes are for the provider's retry logic: 2xx stops retries, anything else is retried.
import { MAX_BATCH_BYTES, validateEvent, type PaymentEvent } from "@paynp/shared";
import type { Context } from "hono";
import { afterIngest, ingestEvents, readCapped } from "../ingest.ts";
import { open } from "../lib/crypto.ts";
import { errorBody, now } from "../lib/util.ts";
import type { AppEnv } from "../types.ts";
import { ADAPTERS, type SourceRow } from "./registry.ts";

export async function handleInbound(c: Context<AppEnv>): Promise<Response> {
  const env = c.env;
  const row = await env.DB.prepare(
    `SELECT s.*, p.salt, EXISTS (SELECT 1 FROM webhook_endpoints w WHERE w.project_id = s.project_id AND w.env = s.env AND w.enabled = 1) AS hooks
     FROM inbound_sources s JOIN projects p ON p.id = s.project_id WHERE s.id = ?`,
  )
    .bind(c.req.param("id"))
    .first<SourceRow & { salt: string | null; hooks: number }>();
  // 410 tells the provider the endpoint is gone; Stripe and Dodo both stop retrying and eventually disable it.
  if (!row || !row.enabled) return c.json(errorBody("gone", "no such inbound source"), 410);
  const adapter = ADAPTERS[row.provider];

  const { success } = await env.INGEST_LIMITER.limit({ key: row.id });
  if (!success) {
    c.header("Retry-After", "1");
    return c.json(errorBody("rate_limited", "too many requests"), 429);
  }
  const raw = await readCapped(c.req.raw, MAX_BATCH_BYTES);
  if (raw === null) return c.json(errorBody("too_large", `body over ${MAX_BATCH_BYTES} bytes`), 413);

  const t = now();
  const secret = await open(env, row.secret_enc, `${row.id}:secret`);
  const v = await adapter.verify(raw, c.req.raw.headers, secret, t);
  if (!v.ok) {
    c.executionCtx.waitUntil(env.DB.prepare("UPDATE inbound_sources SET last_error = ? WHERE id = ?").bind(v.error, row.id).run());
    return c.json(errorBody("bad_signature", v.error), 400);
  }

  const mapped = adapter.map(v.body, v.deliveryId);
  const events: PaymentEvent[] = [];
  for (const m of mapped) {
    const r = validateEvent(m);
    if (r.ok) events.push(r.event);
    else console.warn(JSON.stringify({ msg: "inbound event dropped", provider: row.provider, source: row.id, error: r.error }));
  }
  let accepted = 0;
  let duplicates = 0;
  if (events.length) {
    const result = await ingestEvents(env, row.project_id, row.env, events, t, { salt: row.salt, webhooks: !!row.hooks });
    accepted = result.accepted;
    duplicates = result.duplicates;
    if (result.accepted) c.executionCtx.waitUntil(afterIngest(env, row.project_id, row.env, result, t));
  }
  c.executionCtx.waitUntil(env.DB.prepare("UPDATE inbound_sources SET last_event_at = ?, last_error = NULL WHERE id = ?").bind(t, row.id).run());
  return c.json({ received: true, accepted, duplicates, ignored: mapped.length === 0 }, 200);
}

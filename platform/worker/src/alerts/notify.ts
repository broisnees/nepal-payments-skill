// Channel senders (platform/SPEC.md section 8): email, Slack, Discord, signed webhook. One retry on failure;
// every attempt that reaches a channel writes one notifications row per incident it covered.
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, newId, type ChannelType } from "@paynp/shared";
import { htmlMail, sendMail } from "../email.ts";
import { appOrigin, hmacSha256Hex, now, parseJson } from "../lib/util.ts";

export interface ChannelRow {
  id: string;
  project_id: string;
  type: ChannelType;
  name: string;
  config: string;
  created_at: number;
}

export interface Message {
  kind: "incident.firing" | "incident.resolved" | "incident.batch" | "test";
  title: string;
  lines: string[];
  link: string;
  /** Structured body for generic webhooks. */
  payload: Record<string, unknown>;
}

export interface SendResult {
  ok: boolean;
  error?: string;
}

export const projectLink = (env: Env, projectId: string, path = "") => `${appOrigin(env)}/projects/${projectId}${path}`;

/** Webhook signature: `sha256=<hex HMAC-SHA256 of the raw body with the channel secret>`. */
export async function signWebhook(secret: string, body: string): Promise<string> {
  return `sha256=${await hmacSha256Hex(secret, body)}`;
}

async function post(url: string, body: string, headers: Record<string, string> = {}): Promise<void> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "paynp-alerts/1", ...headers },
    body,
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  await res.body?.cancel();
}

async function deliver(env: Env, channel: ChannelRow, msg: Message): Promise<void> {
  const cfg = parseJson<Record<string, unknown>>(channel.config, {});
  const text = [msg.title, ...msg.lines, msg.link].join("\n");
  switch (channel.type) {
    case "email": {
      const to = Array.isArray(cfg.to) ? (cfg.to as string[]) : [];
      await sendMail(env, { to, subject: `[discerns] ${msg.title}`, text, html: htmlMail(msg.title, msg.lines, { href: msg.link, label: "Open in discerns" }) });
      return;
    }
    case "slack":
      return post(String(cfg.webhook_url), JSON.stringify({ text: `*${msg.title}*\n${msg.lines.join("\n")}\n<${msg.link}|Open in discerns>` }));
    case "discord":
      return post(String(cfg.webhook_url), JSON.stringify({ content: `**${msg.title}**\n${msg.lines.join("\n")}\n${msg.link}`.slice(0, 2000) }));
    case "webhook": {
      const body = JSON.stringify({ type: msg.kind, title: msg.title, lines: msg.lines, link: msg.link, ...msg.payload, sent_at: new Date().toISOString() });
      return post(String(cfg.url), body, {
        [SIGNATURE_HEADER]: await signWebhook(String(cfg.secret ?? ""), body),
        [TIMESTAMP_HEADER]: String(Math.floor(Date.now() / 1000)),
      });
    }
  }
}

/** Delivers with one retry. Never throws. */
export async function deliverWithRetry(env: Env, channel: ChannelRow, msg: Message): Promise<SendResult> {
  let result: SendResult = { ok: true };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await deliver(env, channel, msg);
      return { ok: true };
    } catch (e) {
      result = { ok: false, error: String(e instanceof Error ? e.message : e).slice(0, 300) };
    }
  }
  console.error(JSON.stringify({ msg: "alert delivery failed", channel: channel.id, type: channel.type, error: result.error }));
  return result;
}

/** Sends with one retry and records the outcome for each incident id (or one row with no incident for tests). */
export async function sendToChannel(env: Env, channel: ChannelRow, msg: Message, incidentIds: (string | null)[], at = now()): Promise<SendResult> {
  const result = await deliverWithRetry(env, channel, msg);
  const ids = incidentIds.length ? incidentIds : [null];
  await env.DB.batch(
    ids.map((id) =>
      env.DB.prepare("INSERT INTO notifications (id, incident_id, channel_id, sent_at, ok, error) VALUES (?, ?, ?, ?, ?, ?)").bind(newId("ntf", at), id, channel.id, at, result.ok ? 1 : 0, result.error ?? null),
    ),
  );
  return result;
}

export async function loadChannels(env: Env, projectId: string, ids: string[]): Promise<ChannelRow[]> {
  if (!ids.length) return [];
  const r = await env.DB.prepare(`SELECT * FROM alert_channels WHERE project_id = ? AND id IN (${ids.map(() => "?").join(",")})`)
    .bind(projectId, ...ids)
    .all<ChannelRow>();
  return r.results;
}

// Verifies paynp payment webhooks (Standard Webhooks: https://www.standardwebhooks.com). Web Crypto only, so it runs
// on Node 20+, Bun, Deno, Cloudflare Workers and edge runtimes.
//
//   const event = await verifyWebhook(process.env.PAYNP_WEBHOOK_SECRET!, req.headers, rawBody);
//   if (event.type === "payment.succeeded") await fulfil(event.data.order_id);   // once per webhook-id
//
// Pass the raw body exactly as received: a re-serialised JSON body has a different signature.
import type { PaymentStatus } from "./shared.ts";

export type WebhookEventType =
  | "payment.created"
  | "payment.processing"
  | "payment.succeeded"
  | "payment.failed"
  | "payment.canceled"
  | "payment.expired"
  | "payment.refunded"
  | "webhook.test";

/** The payment as paynp sees it when the webhook was queued. */
export interface WebhookPayment {
  attempt_id: string;
  env: "test" | "live";
  order_id: string | null;
  gateway: string;
  amount_paisa: number | null;
  status: PaymentStatus;
  started_at: number;
  updated_at: number;
  finished_at: number | null;
  provider_ref: string | null;
  refunded_paisa?: number;
  [key: string]: unknown;
}

export interface WebhookEvent<T = WebhookPayment> {
  /** The webhook-id header. The same on every retry: store it and skip ids you have already handled. */
  id: string;
  type: WebhookEventType;
  timestamp: string;
  data: T;
}

export class WebhookVerificationError extends Error {
  override name = "WebhookVerificationError";
}

type HeaderSource = Headers | Record<string, string | string[] | undefined>;

function header(h: HeaderSource, name: string): string | undefined {
  if (typeof (h as Headers).get === "function") return (h as Headers).get(name) ?? undefined;
  const rec = h as Record<string, string | string[] | undefined>;
  const v = rec[name] ?? rec[Object.keys(rec).find((k) => k.toLowerCase() === name) ?? ""];
  return Array.isArray(v) ? v[0] : v;
}

const encoder = new TextEncoder();
const fromBase64 = (s: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/**
 * Checks the signature and timestamp, then returns the parsed event. Throws WebhookVerificationError when the
 * request did not come from paynp with this secret, or is older than `toleranceSec` (default 5 minutes).
 */
export async function verifyWebhook<T = WebhookPayment>(
  secret: string,
  headers: HeaderSource,
  body: string | Uint8Array,
  opts: { toleranceSec?: number; now?: number } = {},
): Promise<WebhookEvent<T>> {
  const id = header(headers, "webhook-id");
  const ts = header(headers, "webhook-timestamp");
  const sigs = header(headers, "webhook-signature");
  if (!id || !ts || !sigs) throw new WebhookVerificationError("missing webhook-id, webhook-timestamp or webhook-signature header");
  const seconds = Number(ts);
  const now = Math.floor((opts.now ?? Date.now()) / 1000);
  if (!Number.isInteger(seconds) || Math.abs(now - seconds) > (opts.toleranceSec ?? 300)) throw new WebhookVerificationError("timestamp too old or too new");

  const raw = typeof body === "string" ? body : new TextDecoder().decode(body);
  let keyBytes: Uint8Array<ArrayBuffer>;
  try {
    keyBytes = fromBase64(secret.startsWith("whsec_") ? secret.slice(6) : secret);
  } catch {
    throw new WebhookVerificationError("secret must be the whsec_... value from the paynp dashboard");
  }
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const signed = encoder.encode(`${id}.${seconds}.${raw}`);
  let valid = false;
  for (const part of sigs.split(" ")) {
    const [version, sig] = part.split(",", 2);
    if (version !== "v1" || !sig) continue;
    let mac: Uint8Array<ArrayBuffer>;
    try {
      mac = fromBase64(sig);
    } catch {
      continue;
    }
    // crypto.subtle.verify compares in constant time.
    if (await crypto.subtle.verify("HMAC", key, mac, signed)) {
      valid = true;
      break;
    }
  }
  if (!valid) throw new WebhookVerificationError("signature does not match");
  let parsed: { type: WebhookEventType; timestamp: string; data: T };
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new WebhookVerificationError("body is not JSON");
  }
  return { id, type: parsed.type, timestamp: parsed.timestamp, data: parsed.data };
}

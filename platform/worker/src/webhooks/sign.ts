// Standard Webhooks signing: HMAC-SHA256 over "<webhook-id>.<webhook-timestamp>.<body>", keyed with the base64
// bytes after "whsec_", sent as "v1,<base64 signature>". Several signatures are space separated (key rotation).
const encoder = new TextEncoder();

const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const fromBase64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export const SECRET_PREFIX = "whsec_";

export function newWebhookSecret(): string {
  return SECRET_PREFIX + toBase64(crypto.getRandomValues(new Uint8Array(24)));
}

export async function signature(secret: string, msgId: string, timestamp: number, body: string): Promise<string> {
  const raw = secret.startsWith(SECRET_PREFIX) ? secret.slice(SECRET_PREFIX.length) : secret;
  const key = await crypto.subtle.importKey("raw", fromBase64(raw), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(`${msgId}.${timestamp}.${body}`));
  return `v1,${toBase64(new Uint8Array(mac))}`;
}

/** The three Standard Webhooks headers, signed with every secret given (current first). */
export async function signedHeaders(secrets: string[], msgId: string, timestamp: number, body: string): Promise<Record<string, string>> {
  const sigs = await Promise.all(secrets.map((s) => signature(s, msgId, timestamp, body)));
  return { "webhook-id": msgId, "webhook-timestamp": String(timestamp), "webhook-signature": sigs.join(" ") };
}

export const maskSecret = (s: string) => `${s.slice(0, 10)}****${s.slice(-4)}`;

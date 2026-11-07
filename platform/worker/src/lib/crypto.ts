// AES-256-GCM for secrets paynp must read back (inbound provider signing secrets and API keys). The key is the
// INBOUND_ENC_KEY Worker secret: 32 random bytes, base64 (`openssl rand -base64 32`). The row id is bound as
// additional data, so a ciphertext copied onto another row does not decrypt.
import { HttpError } from "./util.ts";

const enc = new TextEncoder();
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function key(env: Env): Promise<CryptoKey> {
  const raw = env.INBOUND_ENC_KEY ? unb64(env.INBOUND_ENC_KEY) : null;
  if (!raw || raw.byteLength !== 32) throw new HttpError(503, "not_configured", "INBOUND_ENC_KEY is not set to 32 base64 bytes; provider connections are disabled");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** "v1.<iv>.<ciphertext>", both base64. */
export async function seal(env: Env, plaintext: string, aad: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(aad) }, await key(env), enc.encode(plaintext));
  return `v1.${b64(iv)}.${b64(new Uint8Array(ct))}`;
}

export async function open(env: Env, sealed: string, aad: string): Promise<string> {
  const [v, iv, ct] = sealed.split(".");
  if (v !== "v1" || !iv || !ct) throw new Error("unknown sealed format");
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv), additionalData: enc.encode(aad) }, await key(env), unb64(ct));
  return new TextDecoder().decode(pt);
}

/**
 * GetPay's only proof is the return token: base64(JSON {id, oprSecret}) where
 * oprSecret = base64(SHA-256(oprKey + id)).
 */
import { sha256 } from "../../core/crypto.ts";
import { fromBase64, toBase64 } from "../../core/encoding.ts";
import { isRecord } from "../../core/records.ts";

/** base64(SHA-256(oprKey + transactionId)): the oprSecret GetPay puts in the return token. */
export async function getPayOprSecret(oprKey: string, transactionId: string): Promise<string> {
  return toBase64(await sha256(oprKey + transactionId));
}

/** "id:oprSecret", the form one integration reports instead of JSON. */
function splitColonToken(text: string): { id: string; oprSecret: string } | null {
  const i = text.indexOf(":");
  if (i <= 0 || i >= text.length - 1) return null;
  return { id: text.slice(0, i), oprSecret: text.slice(i + 1) };
}

/**
 * Decode the return token. GetPay sends base64 JSON {id, oprSecret}; one integration reports
 * "id:oprSecret".
 */
export function getPayDecodeToken(token: string): { id: string; oprSecret: string } | null {
  let text: string;
  try {
    text = new TextDecoder().decode(fromBase64(token.trim().replace(/ /g, "+")));
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return splitColonToken(text);
  }
  if (!isRecord(parsed)) return null;
  const { id, oprSecret } = parsed;
  if (typeof id !== "string" || typeof oprSecret !== "string" || !id || !oprSecret) return null;
  return { id, oprSecret };
}

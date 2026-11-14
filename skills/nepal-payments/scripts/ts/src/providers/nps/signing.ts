/**
 * Signature: HMAC-SHA512(secretKey, values of payload keys sorted alphabetically (excluding
 * Signature), concatenated with NO separator) as lowercase hex.
 */
import { hmac } from "../../core/crypto.ts";
import { toHex } from "../../core/encoding.ts";

/** Sorted-keys, no-separator HMAC-SHA512 (lowercase hex). */
export async function npsSign(secretKey: string, payload: Record<string, string>): Promise<string> {
  const message = Object.keys(payload)
    .filter((k) => k !== "Signature")
    .sort()
    .map((k) => payload[k])
    .join("");
  return toHex(await hmac("SHA-512", secretKey, message));
}

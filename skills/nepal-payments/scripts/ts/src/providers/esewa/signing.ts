/**
 * Signature (ePay and Intent): base64(HMAC-SHA256(secret, "k1=v1,k2=v2,...")) in
 * `signed_field_names` order.
 * NOTE: the example signatures printed in eSewa's docs are wrong; see the vectors in
 * test/providers/esewa.test.ts.
 */
import { hmac } from "../../core/crypto.ts";
import { toBase64 } from "../../core/encoding.ts";
import { lookup } from "../../core/records.ts";

/** base64(HMAC-SHA256(key, "f1=v1,f2=v2")) for the given field order. */
export async function esewaSign(
  key: string,
  fields: Record<string, string | number>,
  order: string[],
): Promise<string> {
  const message = order.map((f) => `${f}=${fields[f] ?? ""}`).join(",");
  return toBase64(await hmac("SHA-256", key, message));
}

/** `fields` plus `signed_field_names` and `signature`, as every Intent request body needs. */
export async function signedIntentBody<F extends Record<string, string>>(
  accessKey: string,
  fields: F,
  order: (keyof F & string)[],
) {
  const signature = await esewaSign(accessKey, fields, order);
  return { ...fields, signed_field_names: order.join(","), signature };
}

/** "a, b,c" -> ["a", "b", "c"]. */
export const parseFieldNames = (names: string): string[] => names.split(",").map((s) => s.trim());

/**
 * Exact text of a field as eSewa sent it, so numbers keep their formatting
 * ("1000.0" stays "1000.0").
 */
export function rawValue(text: string, payload: Record<string, unknown>, field: string): string {
  const value = lookup(payload, field);
  if (typeof value !== "number") return String(value ?? "");
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = text.match(new RegExp(`"${escaped}"\\s*:\\s*(-?[0-9][0-9.eE+-]*)`));
  return match ? match[1] : String(value);
}

/** Each signed field as eSewa's JSON text carries it. */
export const rawFields = (text: string, payload: Record<string, unknown>, order: string[]) =>
  Object.fromEntries(order.map((f) => [f, rawValue(text, payload, f)]));

/** Each signed field as String(value) (null/undefined sign as ""). */
export const stringFields = (payload: Record<string, unknown>, order: string[]) =>
  Object.fromEntries(order.map((f) => [f, String(lookup(payload, f) ?? "")]));

/**
 * Signature: base64(HMAC-SHA256(secret_key as RAW UTF-8, "f1=v1,f2=v2,...")) over
 * `signed_field_names` order.
 * (REST API secrets are base64-DECODED instead — don't mix them up.)
 */
import { hmac } from "../../core/crypto.ts";
import { toBase64 } from "../../core/encoding.ts";

export async function cybersourceSign(
  secretKey: string,
  fields: Record<string, string>,
): Promise<string> {
  const names = fields.signed_field_names.split(",");
  const message = names.map((n) => `${n}=${fields[n] ?? ""}`).join(",");
  return toBase64(await hmac("SHA-256", secretKey, message));
}

/** UTC "yyyy-MM-dd'T'HH:mm:ss'Z'" — keep the server clock NTP-synced. */
export const signedDateTime = (d = new Date()) => d.toISOString().replace(/\.\d{3}Z$/, "Z");

/**
 * signed_field_names for a request: every field present, then unsigned_field_names and
 * signed_field_names themselves (both are signed too).
 */
export function requestSignedFieldNames(fields: Record<string, string>): string {
  const dataFields = Object.keys(fields).filter((k) => k !== "unsigned_field_names");
  return [...dataFields, "unsigned_field_names", "signed_field_names"].join(",");
}

/** Only trust fields listed in the response's signed_field_names. */
export function signedOnly(params: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of (params.signed_field_names ?? "").split(",")) {
    if (Object.hasOwn(params, name)) out[name] = params[name];
  }
  return out;
}

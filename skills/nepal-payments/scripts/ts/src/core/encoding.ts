/** Byte <-> text encodings. Runtime-neutral (btoa/atob + TextEncoder), no Buffer. */

const encoder = new TextEncoder();

export const utf8 = (s: string): Uint8Array => encoder.encode(s);

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

/** Tolerates url-safe alphabet, missing padding, and '+' turned into ' ' by query parsers. */
export function fromBase64(b64: string): Uint8Array {
  // Spaces back to "+" BEFORE trimming, or a leading/trailing "+" is lost.
  let normalized = b64.replace(/ /g, "+").trim().replace(/-/g, "+").replace(/_/g, "/");
  while (normalized.length % 4) normalized += "=";
  const binary = atob(normalized);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export const base64Json = (b64: string): unknown =>
  JSON.parse(new TextDecoder().decode(fromBase64(b64)));

export function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, "0");
  return hex;
}

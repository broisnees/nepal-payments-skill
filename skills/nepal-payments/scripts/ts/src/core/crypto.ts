/**
 * Hashing, HMAC, RSA and constant-time comparison on WebCrypto. Works on Node >= 18, Bun, Deno,
 * Cloudflare Workers and Vercel/Next.js edge with zero dependencies.
 */
import { fromBase64, toBase64, toHex, utf8 } from "./encoding.ts";

const subtle = globalThis.crypto.subtle;

// The `as BufferSource` casts below are type-only: TS 5.7+ types Uint8Array as
// Uint8Array<ArrayBufferLike>, which the DOM lib's BufferSource does not accept.
const bytesOf = (data: string | Uint8Array): BufferSource =>
  (typeof data === "string" ? utf8(data) : data) as BufferSource;

export async function hmac(
  hash: "SHA-256" | "SHA-512",
  key: string | Uint8Array,
  message: string | Uint8Array,
): Promise<Uint8Array> {
  const cryptoKey = await subtle.importKey("raw", bytesOf(key), { name: "HMAC", hash }, false, [
    "sign",
  ]);
  return new Uint8Array(await subtle.sign("HMAC", cryptoKey, bytesOf(message)));
}

export async function sha256(data: string | Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await subtle.digest("SHA-256", bytesOf(data)));
}

/** Constant-time string comparison (avoid leaking signature prefixes via timing). */
export function safeEqual(a: string, b: string): boolean {
  const x = utf8(a);
  const y = utf8(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

// ---------------------------------------------------------------------------
// RSA signatures (connectIPS, NEPALPAY QR)
// ---------------------------------------------------------------------------

const RSA_SHA256 = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;

/** Base64 body of a PEM block, without the BEGIN/END lines or whitespace. */
function pemBody(pem: string, label: "PRIVATE KEY" | "PUBLIC KEY"): Uint8Array {
  const armor = new RegExp(`-----(BEGIN|END) ${label}-----`, "g");
  return fromBase64(pem.replace(armor, "").replace(/\s+/g, ""));
}

/**
 * RSA PKCS#1 v1.5 + SHA-256 signature, base64 output.
 * `pkcs8Pem` must be "-----BEGIN PRIVATE KEY-----". Convert a .pfx once with:
 *   openssl pkcs12 -in CREDITOR.pfx -nocerts -nodes \
 *     | openssl pkcs8 -topk8 -nocrypt -out creditor.key.pem
 * (add -legacy on OpenSSL 3+ if the .pfx uses RC2/3DES).
 */
export async function rsaSha256SignBase64(pkcs8Pem: string, message: string): Promise<string> {
  if (pkcs8Pem.includes("BEGIN RSA PRIVATE KEY")) {
    throw new Error(
      "PKCS#1 key given; convert with: openssl pkcs8 -topk8 -nocrypt -in key.pem -out key.pk8.pem",
    );
  }
  const der = pemBody(pkcs8Pem, "PRIVATE KEY");
  const key = await subtle.importKey("pkcs8", der as BufferSource, RSA_SHA256, false, ["sign"]);
  const signature = await subtle.sign(RSA_SHA256.name, key, bytesOf(message));
  return toBase64(new Uint8Array(signature));
}

/**
 * SPKI DER from "-----BEGIN PUBLIC KEY-----". From a certificate (.cer/.crt):
 *   openssl x509 -in NPI.cer [-inform der] -pubkey -noout > npi.pub.pem
 */
function spkiDer(spkiPem: string): Uint8Array {
  if (!spkiPem.includes("BEGIN PUBLIC KEY")) {
    throw new Error(
      "expected a PUBLIC KEY PEM; extract it from the certificate with: " +
        "openssl x509 -in NPI.cer -pubkey -noout",
    );
  }
  return pemBody(spkiPem, "PUBLIC KEY");
}

/** Verify an RSA PKCS#1 v1.5 + SHA-256 signature (base64). False on any malformed input. */
export async function rsaSha256VerifyBase64(
  spkiPem: string,
  message: string,
  signatureB64: string,
): Promise<boolean> {
  try {
    const der = spkiDer(spkiPem) as BufferSource;
    const key = await subtle.importKey("spki", der, RSA_SHA256, false, ["verify"]);
    const signature = fromBase64(signatureB64) as BufferSource;
    return await subtle.verify(RSA_SHA256.name, key, signature, bytesOf(message));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// RSA PKCS#1 v1.5 encryption (NEPALPAY WebSocket api_token)
// ---------------------------------------------------------------------------

const base64UrlToBytes = (s: string): Uint8Array =>
  fromBase64(
    s
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(Math.ceil(s.length / 4) * 4, "="),
  );

const bytesToBigInt = (bytes: Uint8Array): bigint => BigInt("0x" + (toHex(bytes) || "0"));

/** base^exponent mod modulus by square-and-multiply. */
function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  let result = 1n;
  let square = base % modulus;
  for (let e = exponent; e > 0n; e >>= 1n) {
    if (e & 1n) result = (result * square) % modulus;
    square = (square * square) % modulus;
  }
  return result;
}

/** EM = 0x00 || 0x02 || PS (nonzero random, >= 8 bytes) || 0x00 || M, `keyBytes` long. */
function pkcs1Type2Pad(message: Uint8Array, keyBytes: number): Uint8Array {
  const em = new Uint8Array(keyBytes);
  em[1] = 2;
  const padding = em.subarray(2, keyBytes - message.length - 1);
  for (let filled = 0; filled < padding.length; ) {
    const random = globalThis.crypto.getRandomValues(new Uint8Array(padding.length));
    for (const b of random) if (b !== 0 && filled < padding.length) padding[filled++] = b;
  }
  em.set(message, keyBytes - message.length);
  return em;
}

/**
 * RSA PKCS#1 v1.5 encryption ("RSA/ECB/PKCS1Padding"), base64 output. WebCrypto only offers
 * OAEP, so this pads and runs the modular exponentiation with BigInt. The key is imported
 * through WebCrypto only to read n and e.
 */
export async function rsaPkcs1EncryptBase64(spkiPem: string, plaintext: string): Promise<string> {
  const algorithm = { name: "RSA-OAEP", hash: "SHA-256" };
  const der = spkiDer(spkiPem) as BufferSource;
  const key = await subtle.importKey("spki", der, algorithm, true, ["encrypt"]);
  const jwk = await subtle.exportKey("jwk", key);
  if (!jwk.n || !jwk.e) throw new Error("RSA public key has no modulus/exponent");

  const modulusBytes = base64UrlToBytes(jwk.n);
  const modulus = bytesToBigInt(modulusBytes);
  const exponent = bytesToBigInt(base64UrlToBytes(jwk.e));
  // A leading 0x00 byte keeps the DER integer positive; it is not part of the key length.
  const keyBytes = modulusBytes[0] === 0 ? modulusBytes.length - 1 : modulusBytes.length;

  const message = utf8(plaintext);
  if (message.length > keyBytes - 11) {
    throw new Error(
      `plaintext too long for a ${keyBytes * 8}-bit RSA key (max ${keyBytes - 11} bytes)`,
    );
  }
  const encoded = pkcs1Type2Pad(message, keyBytes);
  const cipher = modPow(bytesToBigInt(encoded), exponent, modulus);
  const hex = cipher.toString(16).padStart(keyBytes * 2, "0");
  const cipherBytes = new Uint8Array(keyBytes);
  for (let i = 0; i < keyBytes; i++) cipherBytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return toBase64(cipherBytes);
}

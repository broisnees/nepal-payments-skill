/**
 * Shared test helpers: a fetch mock that records every call, and RSA keys for the providers that
 * sign with RSA (connectIPS, NEPALPAY). Use `afterEach(restoreFetch)` in every file that mocks.
 */
import { fromBase64, PaymentError, toBase64 } from "../src/index.ts";

export type Call = { url: string; init: RequestInit };
export type MockResponse = { status?: number; body: unknown };

/** Calls made since the last mockFetch(). Live binding: always read it after the call. */
export let calls: Call[] = [];

const realFetch = globalThis.fetch;

/** Replace fetch: `handler` answers each request; bodies that aren't strings are JSON-encoded. */
export function mockFetch(handler: (url: string, init: RequestInit) => MockResponse) {
  calls = [];
  globalThis.fetch = (async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const r = handler(String(url), init);
    const body = typeof r.body === "string" ? r.body : JSON.stringify(r.body);
    return new Response(body, { status: r.status ?? 200 });
  }) as typeof fetch;
}

export function restoreFetch() {
  globalThis.fetch = realFetch;
}

/** A request header as the adapter set it. */
export const header = (c: Call, name: string) => (c.init.headers as Record<string, string>)[name];

/** The JSON body an adapter sent. */
export const sentJson = (c: Call): Record<string, unknown> => JSON.parse(String(c.init.body));

/** assert.rejects predicate: a PaymentError with this code (and HTTP status, when given). */
export const isPaymentError =
  (code: string, httpStatus?: number) =>
  (err: unknown): boolean =>
    err instanceof PaymentError && err.code === code && err.httpStatus === httpStatus;

/** A fresh RSA-2048 key pair with PKCS#8 / SPKI PEMs, as connectIPS and NEPALPAY expect. */
export async function rsaKeys() {
  const keyPair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", keyPair.privateKey));
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", keyPair.publicKey));
  const pem = (label: string, der: Uint8Array) =>
    `-----BEGIN ${label}-----\n${toBase64(der)
      .match(/.{1,64}/g)!
      .join("\n")}\n-----END ${label}-----`;
  /** Check an RSA-SHA256 base64 signature over `message` with the public key. */
  const verifySignature = (signatureB64: string, message: string) =>
    crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      keyPair.publicKey,
      fromBase64(signatureB64) as BufferSource,
      new TextEncoder().encode(message),
    );
  return {
    keyPair,
    privateKeyPem: pem("PRIVATE KEY", pkcs8),
    publicKeyPem: pem("PUBLIC KEY", spki),
    verifySignature,
  };
}

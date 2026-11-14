/**
 * Shared primitives for every provider adapter.
 *
 * Runtime: anything with WebCrypto + fetch (Node >= 18, Bun, Deno,
 * Cloudflare Workers, Vercel/Next.js edge). Zero dependencies.
 *
 * This barrel is part of the public API (src/index.ts re-exports all of it). Internal helpers
 * (responseError, isRecord, env readers, ...) are imported from their own files instead.
 */
export type {
  ProviderId,
  PaymentStatus,
  VerifyResult,
  InitiateResult,
  Customer,
  InitiateInput,
  VerifyInput,
  PaymentAdapter,
} from "./types.ts";
export {
  type AttemptStatus,
  OPEN_STATUSES,
  type TransitionDecision,
  decideTransition,
} from "./state-machine.ts";
export { PaymentError } from "./errors.ts";
export { assertPaisa, paisaToRupees, rupeesToPaisa } from "./money.ts";
export { utf8, toBase64, fromBase64, base64Json, toHex } from "./encoding.ts";
export { lookup } from "./records.ts";
export {
  hmac,
  sha256,
  rsaSha256SignBase64,
  rsaSha256VerifyBase64,
  rsaPkcs1EncryptBase64,
  safeEqual,
} from "./crypto.ts";
export { type HttpOptions, http, basicAuth } from "./http.ts";
export { escapeHtml, renderAutoSubmitForm } from "./html.ts";

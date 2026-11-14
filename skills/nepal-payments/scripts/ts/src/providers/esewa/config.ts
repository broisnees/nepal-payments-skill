import { environmentFrom, type EnvVars } from "../../core/env.ts";
import type { Environment } from "../../core/types.ts";

export interface EsewaConfig {
  env: Environment;
  /** ePay product code. Sandbox: "EPAYTEST". */
  productCode: string;
  /**
   * ePay secret key. Sandbox: "8gBm/:&EnhH.1/q".
   * Watch for HTML-escaping (&amp;) when loading from config UIs.
   */
  secretKey: string;
  /**
   * Intent (mobile) credentials — only needed if you use intentBook().
   * Sandbox: "INTENT" / access key below.
   */
  intent?: { productCode: string; accessKey: string; baseUrl?: string };
  /** Override endpoints (e.g. if eSewa gives you different hosts at go-live). */
  formUrl?: string;
  statusUrl?: string;
  /**
   * Throw when the success-redirect signature doesn't verify (default true).
   * Status API is checked regardless.
   */
  strictSignature?: boolean;
  timeoutMs?: number;
}

/** eSewa's public sandbox credentials. */
export const ESEWA_SANDBOX = {
  productCode: "EPAYTEST",
  secretKey: "8gBm/:&EnhH.1/q",
  intent: {
    productCode: "INTENT",
    // use as raw string, NOT base64-decoded
    accessKey: "LB0REg8HUSw3MTYrI1s6JTE8Kyc6JyAqJiA3MQ==",
  },
} as const;

/**
 * ESEWA_PRODUCT_CODE + ESEWA_SECRET_KEY enable ePay. Intent is enabled too when
 * ESEWA_INTENT_PRODUCT_CODE + ESEWA_INTENT_ACCESS_KEY are set (ESEWA_INTENT_BASE_URL optional).
 */
export function esewaConfigFromEnv(env: EnvVars): EsewaConfig | undefined {
  if (!env.ESEWA_PRODUCT_CODE || !env.ESEWA_SECRET_KEY) return undefined;
  const intentProductCode = env.ESEWA_INTENT_PRODUCT_CODE;
  const intentAccessKey = env.ESEWA_INTENT_ACCESS_KEY;
  return {
    env: environmentFrom(env.ESEWA_ENV),
    productCode: env.ESEWA_PRODUCT_CODE,
    secretKey: env.ESEWA_SECRET_KEY,
    ...(intentProductCode &&
      intentAccessKey && {
        intent: {
          productCode: intentProductCode,
          accessKey: intentAccessKey,
          baseUrl: env.ESEWA_INTENT_BASE_URL,
        },
      }),
  };
}

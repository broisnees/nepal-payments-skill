import { environmentFrom, type EnvVars } from "../../core/env.ts";
import type { Environment } from "../../core/types.ts";

export interface FonepayConfig {
  env: Environment;
  /** PID / merchant code (3–20 chars). Public dev sample: "NBQM". */
  merchantCode: string;
  /**
   * HMAC secret from the merchant profile page.
   * Public dev sample: "a7e3512f5032480a83137793cb2021dc".
   */
  secretKey: string;
  /**
   * Merchant-panel username/password — required for txnVerification (recommended) and
   * Dynamic QR.
   */
  username?: string;
  password?: string;
  /** Endpoint overrides (Fonepay sometimes issues different hosts per merchant/bank). */
  paymentUrl?: string;
  txnVerificationUrl?: string;
  legacyVerifyUrl?: string;
  qrBaseUrl?: string;
  strictSignature?: boolean;
  timeoutMs?: number;
}

/**
 * FONEPAY_MERCHANT_CODE + FONEPAY_SECRET_KEY enable Fonepay.
 * FONEPAY_USERNAME / FONEPAY_PASSWORD (optional) unlock txnVerification and Dynamic QR.
 */
export function fonepayConfigFromEnv(env: EnvVars): FonepayConfig | undefined {
  if (!env.FONEPAY_MERCHANT_CODE || !env.FONEPAY_SECRET_KEY) return undefined;
  return {
    env: environmentFrom(env.FONEPAY_ENV),
    merchantCode: env.FONEPAY_MERCHANT_CODE,
    secretKey: env.FONEPAY_SECRET_KEY,
    username: env.FONEPAY_USERNAME,
    password: env.FONEPAY_PASSWORD,
  };
}

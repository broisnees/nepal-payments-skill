import { environmentFrom, pemFromEnv, type EnvVars } from "../../core/env.ts";
import type { Environment } from "../../core/types.ts";

export interface ConnectIpsConfig {
  env: Environment;
  merchantId: number | string;
  appId: string; // e.g. "MER-550-APP-1"
  appName: string; // <= 30 chars
  /** App password for Basic auth on validatetxn / gettxndetail. */
  appPassword: string;
  /** PKCS#8 PEM ("-----BEGIN PRIVATE KEY-----") extracted from the creditor .pfx. */
  privateKeyPem: string;
  baseUrl?: string;
  timeoutMs?: number;
}

/** CONNECTIPS_MERCHANT_ID + CONNECTIPS_APP_ID + CONNECTIPS_PRIVATE_KEY_PEM enable connectIPS. */
export function connectIpsConfigFromEnv(env: EnvVars): ConnectIpsConfig | undefined {
  if (!env.CONNECTIPS_MERCHANT_ID || !env.CONNECTIPS_APP_ID || !env.CONNECTIPS_PRIVATE_KEY_PEM) {
    return undefined;
  }
  return {
    env: environmentFrom(env.CONNECTIPS_ENV),
    merchantId: env.CONNECTIPS_MERCHANT_ID,
    appId: env.CONNECTIPS_APP_ID,
    appName: env.CONNECTIPS_APP_NAME ?? "",
    appPassword: env.CONNECTIPS_APP_PASSWORD ?? "",
    privateKeyPem: pemFromEnv(env.CONNECTIPS_PRIVATE_KEY_PEM),
  };
}

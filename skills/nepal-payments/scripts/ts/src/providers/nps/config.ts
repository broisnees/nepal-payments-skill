import { environmentFrom, type EnvVars } from "../../core/env.ts";
import type { Environment } from "../../core/types.ts";

export interface NpsConfig {
  env: Environment;
  merchantId: string;
  merchantName: string;
  apiUsername: string;
  apiPassword: string;
  secretKey: string;
  apiBaseUrl?: string;
  gatewayUrl?: string;
  timeoutMs?: number;
}

/** NPS_MERCHANT_ID + NPS_SECRET_KEY enable NPS. */
export function npsConfigFromEnv(env: EnvVars): NpsConfig | undefined {
  if (!env.NPS_MERCHANT_ID || !env.NPS_SECRET_KEY) return undefined;
  return {
    env: environmentFrom(env.NPS_ENV),
    merchantId: env.NPS_MERCHANT_ID,
    merchantName: env.NPS_MERCHANT_NAME ?? "",
    apiUsername: env.NPS_API_USERNAME ?? "",
    apiPassword: env.NPS_API_PASSWORD ?? "",
    secretKey: env.NPS_SECRET_KEY,
  };
}

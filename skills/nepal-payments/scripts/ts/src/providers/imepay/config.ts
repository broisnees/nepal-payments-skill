import { environmentFrom, type EnvVars } from "../../core/env.ts";
import type { Environment } from "../../core/types.ts";

export interface ImePayConfig {
  env: Environment;
  merchantCode: string;
  username: string;
  password: string;
  /** Module name issued with the account; sent base64-encoded in the `Module` header. */
  module: string;
  baseUrl?: string;
  timeoutMs?: number;
}

/** IMEPAY_MERCHANT_CODE + IMEPAY_USERNAME enable IME Pay. */
export function imePayConfigFromEnv(env: EnvVars): ImePayConfig | undefined {
  if (!env.IMEPAY_MERCHANT_CODE || !env.IMEPAY_USERNAME) return undefined;
  return {
    env: environmentFrom(env.IMEPAY_ENV),
    merchantCode: env.IMEPAY_MERCHANT_CODE,
    username: env.IMEPAY_USERNAME,
    password: env.IMEPAY_PASSWORD ?? "",
    module: env.IMEPAY_MODULE ?? "",
  };
}

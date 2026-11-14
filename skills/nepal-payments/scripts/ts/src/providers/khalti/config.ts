import { environmentFrom, type EnvVars } from "../../core/env.ts";
import type { Environment } from "../../core/types.ts";

export interface KhaltiConfig {
  /** "live_secret_key" from test-admin.khalti.com (sandbox) or admin.khalti.com (production). */
  secretKey: string;
  env: Environment;
  /** Your site's public URL (required by Khalti). */
  websiteUrl: string;
  timeoutMs?: number;
}

/** KHALTI_SECRET_KEY + KHALTI_WEBSITE_URL enable Khalti. */
export function khaltiConfigFromEnv(env: EnvVars): KhaltiConfig | undefined {
  if (!env.KHALTI_SECRET_KEY || !env.KHALTI_WEBSITE_URL) return undefined;
  return {
    env: environmentFrom(env.KHALTI_ENV),
    secretKey: env.KHALTI_SECRET_KEY,
    websiteUrl: env.KHALTI_WEBSITE_URL,
  };
}

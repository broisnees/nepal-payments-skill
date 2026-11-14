import { environmentFrom, type EnvVars } from "../../core/env.ts";
import type { Environment } from "../../core/types.ts";

export interface HamroPayConfig {
  env: Environment;
  merchantId: string;
  clientId: string;
  clientApiKey: string;
  clientSecret: string;
  /**
   * Signing secret shown when you save the webhook URL in the merchant portal.
   * Needed for verifyWebhook().
   */
  webhookSecret?: string;
  /**
   * API host override. Default UAT https://uat-payclient.hamropatro.com,
   * live https://payclient.hamropatro.com.
   */
  apiBaseUrl?: string;
  /**
   * Full gateway form URL ({gateway}/api/checkout). Required in production: Hamro Pay issues
   * the live host.
   */
  gatewayUrl?: string;
  timeoutMs?: number;
}

/** Hamro Pay's per-transaction limits: Rs 10 to Rs 50,000. */
export const HAMROPAY_MIN_PAISA = 1000;
export const HAMROPAY_MAX_PAISA = 5_000_000;

/**
 * HAMROPAY_MERCHANT_ID + HAMROPAY_CLIENT_ID + HAMROPAY_CLIENT_API_KEY + HAMROPAY_CLIENT_SECRET
 * enable Hamro Pay.
 */
export function hamroPayConfigFromEnv(env: EnvVars): HamroPayConfig | undefined {
  const merchantId = env.HAMROPAY_MERCHANT_ID;
  const clientId = env.HAMROPAY_CLIENT_ID;
  const clientApiKey = env.HAMROPAY_CLIENT_API_KEY;
  const clientSecret = env.HAMROPAY_CLIENT_SECRET;
  if (!merchantId || !clientId || !clientApiKey || !clientSecret) return undefined;
  return {
    env: environmentFrom(env.HAMROPAY_ENV),
    merchantId,
    clientId,
    clientApiKey,
    clientSecret,
    webhookSecret: env.HAMROPAY_WEBHOOK_SECRET,
    apiBaseUrl: env.HAMROPAY_API_BASE_URL,
    gatewayUrl: env.HAMROPAY_GATEWAY_URL,
  };
}

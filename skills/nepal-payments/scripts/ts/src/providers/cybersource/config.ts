import { environmentFrom, type EnvVars } from "../../core/env.ts";
import type { Environment } from "../../core/types.ts";

export interface CyberSourceConfig {
  env: Environment;
  profileId: string;
  accessKey: string;
  secretKey: string;
  /**
   * "sale" (auth+capture, typical) or "authorization" (capture later via Business Center /
   * API).
   */
  transactionType?: "sale" | "authorization";
  currency?: "NPR" | "USD" | string;
  locale?: string; // "en-us"
  /**
   * Set when you host the receipt page yourself and want to override the profile's URL per
   * request.
   */
  useReturnUrlOverride?: boolean;
  timeoutMs?: number;
}

/** Billing details CyberSource requires for sale/authorization. */
export interface BillTo {
  forename: string;
  surname: string;
  email: string;
  addressLine1: string;
  city: string;
  /** ISO 3166 alpha-2, e.g. "NP". */
  country: string;
  phone?: string;
  postalCode?: string; // required only for US/CA
  state?: string; // required only for US/CA
}

/**
 * CYBERSOURCE_PROFILE_ID + CYBERSOURCE_ACCESS_KEY + CYBERSOURCE_SECRET_KEY enable CyberSource.
 * CYBERSOURCE_CURRENCY defaults to NPR.
 */
export function cyberSourceConfigFromEnv(env: EnvVars): CyberSourceConfig | undefined {
  if (!env.CYBERSOURCE_PROFILE_ID || !env.CYBERSOURCE_ACCESS_KEY || !env.CYBERSOURCE_SECRET_KEY) {
    return undefined;
  }
  return {
    env: environmentFrom(env.CYBERSOURCE_ENV),
    profileId: env.CYBERSOURCE_PROFILE_ID,
    accessKey: env.CYBERSOURCE_ACCESS_KEY,
    secretKey: env.CYBERSOURCE_SECRET_KEY,
    currency: env.CYBERSOURCE_CURRENCY ?? "NPR",
  };
}

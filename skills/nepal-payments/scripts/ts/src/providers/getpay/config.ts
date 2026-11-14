import { environmentFrom, type EnvVars } from "../../core/env.ts";
import type { Environment } from "../../core/types.ts";

export interface GetPayConfig {
  env: Environment;
  /** Base64 {"institutionId","mid","tid"} from the bank. */
  papInfo: string;
  /**
   * Operator key from the bank. It also reaches the browser (GetPay's design); it is not a
   * secret.
   */
  oprKey: string;
  insKey?: string;
  /**
   * Your site origin, e.g. "https://shop.example". GetPay requires the callback URLs on this
   * host.
   */
  websiteDomain: string;
  businessName: string;
  /** Logo shown on the checkout page (absolute URL). */
  imageUrl: string;
  currency?: string;
  themeColor?: string;
  bundleUrl?: string;
  baseUrl?: string;
  timeoutMs?: number;
}

/** GETPAY_PAP_INFO + GETPAY_OPR_KEY + GETPAY_WEBSITE_DOMAIN enable GetPay. */
export function getPayConfigFromEnv(env: EnvVars): GetPayConfig | undefined {
  if (!env.GETPAY_PAP_INFO || !env.GETPAY_OPR_KEY || !env.GETPAY_WEBSITE_DOMAIN) return undefined;
  return {
    env: environmentFrom(env.GETPAY_ENV),
    papInfo: env.GETPAY_PAP_INFO,
    oprKey: env.GETPAY_OPR_KEY,
    insKey: env.GETPAY_INS_KEY,
    websiteDomain: env.GETPAY_WEBSITE_DOMAIN,
    businessName: env.GETPAY_BUSINESS_NAME ?? "",
    imageUrl: env.GETPAY_IMAGE_URL ?? "",
    currency: env.GETPAY_CURRENCY,
    bundleUrl: env.GETPAY_BUNDLE_URL,
    baseUrl: env.GETPAY_BASE_URL,
  };
}

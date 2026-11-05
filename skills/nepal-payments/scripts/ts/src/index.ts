/**
 * nepal-payments — one interface over Nepali payment providers.
 *
 *   const payments = createPayments(paymentsConfigFromEnv());
 *   const r = await payments.get("khalti").initiate({ orderId, amountPaisa, description, returnUrl });
 *   const v = await payments.get("khalti").verify({ orderId, amountPaisa, providerRef });
 */
export * from "./core.ts";
export { esewa, esewaSign, ESEWA_SANDBOX, type EsewaConfig } from "./esewa.ts";
export { khalti, type KhaltiConfig } from "./khalti.ts";
export { fonepay, fonepayHmac, fonepayDate, type FonepayConfig } from "./fonepay.ts";
export { connectips, connectIpsTokenString, connectIpsDate, type ConnectIpsConfig } from "./connectips.ts";
export { cybersource, cybersourceSign, signedDateTime, type CyberSourceConfig, type BillTo } from "./cybersource.ts";
export { nps, npsSign, type NpsConfig } from "./nps.ts";
export { imepay, type ImePayConfig } from "./imepay.ts";

import type { PaymentAdapter, ProviderId } from "./core.ts";
import { esewa, type EsewaConfig } from "./esewa.ts";
import { khalti, type KhaltiConfig } from "./khalti.ts";
import { fonepay, type FonepayConfig } from "./fonepay.ts";
import { connectips, type ConnectIpsConfig } from "./connectips.ts";
import { cybersource, type CyberSourceConfig } from "./cybersource.ts";
import { nps, type NpsConfig } from "./nps.ts";
import { imepay, type ImePayConfig } from "./imepay.ts";

export interface PaymentsConfig {
  esewa?: EsewaConfig;
  khalti?: KhaltiConfig;
  fonepay?: FonepayConfig;
  connectips?: ConnectIpsConfig;
  cybersource?: CyberSourceConfig;
  nps?: NpsConfig;
  imepay?: ImePayConfig;
}

type Adapters = {
  esewa: ReturnType<typeof esewa>;
  khalti: ReturnType<typeof khalti>;
  fonepay: ReturnType<typeof fonepay>;
  connectips: ReturnType<typeof connectips>;
  cybersource: ReturnType<typeof cybersource>;
  nps: ReturnType<typeof nps>;
  imepay: ReturnType<typeof imepay>;
};

export function createPayments(cfg: PaymentsConfig) {
  const built: Partial<Adapters> = {};
  if (cfg.esewa) built.esewa = esewa(cfg.esewa);
  if (cfg.khalti) built.khalti = khalti(cfg.khalti);
  if (cfg.fonepay) built.fonepay = fonepay(cfg.fonepay);
  if (cfg.connectips) built.connectips = connectips(cfg.connectips);
  if (cfg.cybersource) built.cybersource = cybersource(cfg.cybersource);
  if (cfg.nps) built.nps = nps(cfg.nps);
  if (cfg.imepay) built.imepay = imepay(cfg.imepay);

  return {
    /** Typed access to a configured provider (throws if not configured). */
    get<P extends ProviderId>(id: P): Adapters[P] {
      const a = built[id];
      if (!a) throw new Error(`payment provider "${id}" is not configured`);
      return a as Adapters[P];
    },
    /** Untyped access for generic handlers keyed by a route param. */
    adapter(id: string): PaymentAdapter {
      if (!(id in built)) throw new Error(`payment provider "${id}" is not configured`);
      return built[id as ProviderId] as PaymentAdapter;
    },
    enabled: Object.keys(built) as ProviderId[],
  };
}

/**
 * Build config from environment variables. A provider is enabled when its required vars are present.
 * See references/env.md for the full list.
 */
export function paymentsConfigFromEnv(env: Record<string, string | undefined> = (globalThis as any).process?.env ?? {}): PaymentsConfig {
  const mode = (v?: string): "sandbox" | "production" => (v === "production" || v === "live" ? "production" : "sandbox");
  const cfg: PaymentsConfig = {};
  if (env.ESEWA_PRODUCT_CODE && env.ESEWA_SECRET_KEY) {
    cfg.esewa = {
      env: mode(env.ESEWA_ENV),
      productCode: env.ESEWA_PRODUCT_CODE,
      secretKey: env.ESEWA_SECRET_KEY,
      ...(env.ESEWA_INTENT_PRODUCT_CODE &&
        env.ESEWA_INTENT_ACCESS_KEY && {
          intent: { productCode: env.ESEWA_INTENT_PRODUCT_CODE, accessKey: env.ESEWA_INTENT_ACCESS_KEY, baseUrl: env.ESEWA_INTENT_BASE_URL },
        }),
    };
  }
  if (env.KHALTI_SECRET_KEY && env.KHALTI_WEBSITE_URL) {
    cfg.khalti = { env: mode(env.KHALTI_ENV), secretKey: env.KHALTI_SECRET_KEY, websiteUrl: env.KHALTI_WEBSITE_URL };
  }
  if (env.FONEPAY_MERCHANT_CODE && env.FONEPAY_SECRET_KEY) {
    cfg.fonepay = {
      env: mode(env.FONEPAY_ENV),
      merchantCode: env.FONEPAY_MERCHANT_CODE,
      secretKey: env.FONEPAY_SECRET_KEY,
      username: env.FONEPAY_USERNAME,
      password: env.FONEPAY_PASSWORD,
    };
  }
  if (env.CONNECTIPS_MERCHANT_ID && env.CONNECTIPS_APP_ID && env.CONNECTIPS_PRIVATE_KEY_PEM) {
    cfg.connectips = {
      env: mode(env.CONNECTIPS_ENV),
      merchantId: env.CONNECTIPS_MERCHANT_ID,
      appId: env.CONNECTIPS_APP_ID,
      appName: env.CONNECTIPS_APP_NAME ?? "",
      appPassword: env.CONNECTIPS_APP_PASSWORD ?? "",
      privateKeyPem: env.CONNECTIPS_PRIVATE_KEY_PEM.replace(/\\n/g, "\n"),
    };
  }
  if (env.CYBERSOURCE_PROFILE_ID && env.CYBERSOURCE_ACCESS_KEY && env.CYBERSOURCE_SECRET_KEY) {
    cfg.cybersource = {
      env: mode(env.CYBERSOURCE_ENV),
      profileId: env.CYBERSOURCE_PROFILE_ID,
      accessKey: env.CYBERSOURCE_ACCESS_KEY,
      secretKey: env.CYBERSOURCE_SECRET_KEY,
      currency: env.CYBERSOURCE_CURRENCY ?? "NPR",
    };
  }
  if (env.NPS_MERCHANT_ID && env.NPS_SECRET_KEY) {
    cfg.nps = {
      env: mode(env.NPS_ENV),
      merchantId: env.NPS_MERCHANT_ID,
      merchantName: env.NPS_MERCHANT_NAME ?? "",
      apiUsername: env.NPS_API_USERNAME ?? "",
      apiPassword: env.NPS_API_PASSWORD ?? "",
      secretKey: env.NPS_SECRET_KEY,
    };
  }
  if (env.IMEPAY_MERCHANT_CODE && env.IMEPAY_USERNAME) {
    cfg.imepay = {
      env: mode(env.IMEPAY_ENV),
      merchantCode: env.IMEPAY_MERCHANT_CODE,
      username: env.IMEPAY_USERNAME,
      password: env.IMEPAY_PASSWORD ?? "",
      module: env.IMEPAY_MODULE ?? "",
    };
  }
  return cfg;
}

/**
 * Short, provider-safe attempt id: <= 20 chars, [A-Za-z0-9] (fits connectIPS TXNID 20, Fonepay PRN 25,
 * eSewa uuid charset, Khalti/NPS/IME/CyberSource limits). Example: "P1KX3M9Q2ZAB7C4D8E".
 */
export function newOrderId(prefix = "P"): string {
  const time = Date.now().toString(36).toUpperCase(); // 8–9 chars
  const rand = new Uint8Array(10);
  globalThis.crypto.getRandomValues(rand);
  const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const tail = Array.from(rand, (b) => alphabet[b % 36]).join("");
  return (prefix + time + tail).slice(0, 20);
}

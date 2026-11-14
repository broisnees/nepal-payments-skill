/**
 * nepal-payments — one interface over Nepali payment providers.
 *
 *   const payments = createPayments(paymentsConfigFromEnv());
 *   const khalti = payments.get("khalti");
 *   const r = await khalti.initiate({ orderId, amountPaisa, description, returnUrl });
 *   const v = await khalti.verify({ orderId, amountPaisa, providerRef });
 *
 * Adding a provider: see CONTRIBUTING.md. In this file it is one line in each of
 * PaymentsConfig, ADAPTER_FACTORIES and ENV_READERS, plus its public exports below.
 */
export * from "./core/index.ts";
export { esewa, esewaSign, ESEWA_SANDBOX, type EsewaConfig } from "./providers/esewa/index.ts";
export { khalti, type KhaltiConfig } from "./providers/khalti/index.ts";
export {
  fonepay,
  fonepayHmac,
  fonepayDate,
  type FonepayConfig,
} from "./providers/fonepay/index.ts";
export {
  connectips,
  connectIpsTokenString,
  connectIpsDate,
  type ConnectIpsConfig,
} from "./providers/connectips/index.ts";
export {
  cybersource,
  cybersourceSign,
  signedDateTime,
  type CyberSourceConfig,
  type BillTo,
} from "./providers/cybersource/index.ts";
export { nps, npsSign, type NpsConfig } from "./providers/nps/index.ts";
export { imepay, type ImePayConfig } from "./providers/imepay/index.ts";
export {
  hamropay,
  hamroPaySign,
  HAMROPAY_MIN_PAISA,
  HAMROPAY_MAX_PAISA,
  type HamroPayConfig,
} from "./providers/hamropay/index.ts";
export {
  getpay,
  getPayOprSecret,
  getPayDecodeToken,
  type GetPayConfig,
} from "./providers/getpay/index.ts";
export {
  nepalpay,
  nepalPayTokenString,
  nepalPayConfirmationString,
  type NepalPayConfig,
  type NepalPayTxn,
} from "./providers/nepalpay/index.ts";

import type { EnvVars } from "./core/env.ts";
import type { PaymentAdapter, ProviderId } from "./core/types.ts";
import { connectips, type ConnectIpsConfig } from "./providers/connectips/index.ts";
import { connectIpsConfigFromEnv } from "./providers/connectips/config.ts";
import { cybersource, type CyberSourceConfig } from "./providers/cybersource/index.ts";
import { cyberSourceConfigFromEnv } from "./providers/cybersource/config.ts";
import { esewa, type EsewaConfig } from "./providers/esewa/index.ts";
import { esewaConfigFromEnv } from "./providers/esewa/config.ts";
import { fonepay, type FonepayConfig } from "./providers/fonepay/index.ts";
import { fonepayConfigFromEnv } from "./providers/fonepay/config.ts";
import { getpay, type GetPayConfig } from "./providers/getpay/index.ts";
import { getPayConfigFromEnv } from "./providers/getpay/config.ts";
import { hamropay, type HamroPayConfig } from "./providers/hamropay/index.ts";
import { hamroPayConfigFromEnv } from "./providers/hamropay/config.ts";
import { imepay, type ImePayConfig } from "./providers/imepay/index.ts";
import { imePayConfigFromEnv } from "./providers/imepay/config.ts";
import { khalti, type KhaltiConfig } from "./providers/khalti/index.ts";
import { khaltiConfigFromEnv } from "./providers/khalti/config.ts";
import { nepalpay, type NepalPayConfig } from "./providers/nepalpay/index.ts";
import { nepalPayConfigFromEnv } from "./providers/nepalpay/config.ts";
import { nps, type NpsConfig } from "./providers/nps/index.ts";
import { npsConfigFromEnv } from "./providers/nps/config.ts";

export interface PaymentsConfig {
  esewa?: EsewaConfig;
  khalti?: KhaltiConfig;
  fonepay?: FonepayConfig;
  connectips?: ConnectIpsConfig;
  cybersource?: CyberSourceConfig;
  nps?: NpsConfig;
  imepay?: ImePayConfig;
  nepalpay?: NepalPayConfig;
  hamropay?: HamroPayConfig;
  getpay?: GetPayConfig;
}

// ---------------------------------------------------------------------------
// Provider registry. Key order is the order of `enabled` and of paymentsConfigFromEnv's keys.
// ---------------------------------------------------------------------------

const FACTORIES = {
  esewa,
  khalti,
  fonepay,
  connectips,
  cybersource,
  nps,
  imepay,
  nepalpay,
  hamropay,
  getpay,
};

/** What each factory returns, including its provider-specific extras (intentBook, refund, ...). */
type Adapters = { [P in ProviderId]: ReturnType<(typeof FACTORIES)[P]> };

/** Typed so a provider missing from ProviderId, PaymentsConfig or FACTORIES fails to compile. */
const ADAPTER_FACTORIES: {
  [P in ProviderId]: (config: NonNullable<PaymentsConfig[P]>) => Adapters[P];
} = FACTORIES;

const ENV_READERS: { [P in ProviderId]: (env: EnvVars) => PaymentsConfig[P] | undefined } = {
  esewa: esewaConfigFromEnv,
  khalti: khaltiConfigFromEnv,
  fonepay: fonepayConfigFromEnv,
  connectips: connectIpsConfigFromEnv,
  cybersource: cyberSourceConfigFromEnv,
  nps: npsConfigFromEnv,
  imepay: imePayConfigFromEnv,
  nepalpay: nepalPayConfigFromEnv,
  hamropay: hamroPayConfigFromEnv,
  getpay: getPayConfigFromEnv,
};

// Object.keys loses the key type; FACTORIES has exactly the ProviderId keys (checked above).
const PROVIDER_IDS = Object.keys(FACTORIES) as ProviderId[];

const isProviderId = (id: string): id is ProviderId => Object.hasOwn(FACTORIES, id);

const notConfigured = (id: string) => new Error(`payment provider "${id}" is not configured`);

export function createPayments(cfg: PaymentsConfig) {
  const built: Partial<Adapters> = {};
  const build = <P extends ProviderId>(id: P) => {
    const config = cfg[id];
    if (config) built[id] = ADAPTER_FACTORIES[id](config);
  };
  for (const id of PROVIDER_IDS) build(id);

  return {
    /** Typed access to a configured provider (throws if not configured). */
    get<P extends ProviderId>(id: P): Adapters[P] {
      const adapter = built[id];
      if (!adapter) throw notConfigured(id);
      return adapter;
    },
    /** Untyped access for generic handlers keyed by a route param. */
    adapter(id: string): PaymentAdapter {
      // Own-property check: "constructor" / "__proto__" must not reach Object.prototype.
      const adapter = isProviderId(id) && Object.hasOwn(built, id) ? built[id] : undefined;
      if (!adapter) throw notConfigured(id);
      return adapter;
    },
    enabled: Object.keys(built) as ProviderId[],
  };
}

/** process.env where it exists (Node, Bun, Deno compat), else empty. Typed without @types/node. */
function processEnv(): EnvVars {
  const host = globalThis as { process?: { env?: EnvVars } };
  return host.process?.env ?? {};
}

/**
 * Build config from environment variables. A provider is enabled when its required vars are
 * present. See references/env.md for the full list.
 */
export function paymentsConfigFromEnv(
  env: Record<string, string | undefined> = processEnv(),
): PaymentsConfig {
  const cfg: PaymentsConfig = {};
  const read = <P extends ProviderId>(id: P) => {
    const config = ENV_READERS[id](env);
    if (config) cfg[id] = config;
  };
  for (const id of PROVIDER_IDS) read(id);
  return cfg;
}

/**
 * Short, provider-safe attempt id: <= 20 chars, [A-Za-z0-9] (fits connectIPS TXNID 20, Fonepay
 * PRN 25, eSewa uuid charset, Khalti/NPS/IME/CyberSource limits). Example: "P1KX3M9Q2ZAB7C4D8E".
 */
export function newOrderId(prefix = "P"): string {
  const time = Date.now().toString(36).toUpperCase(); // 8–9 chars
  const randomBytes = new Uint8Array(10);
  const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let tail = "";
  while (tail.length < 10) {
    globalThis.crypto.getRandomValues(randomBytes);
    // 252 = 7 * 36: dropping bytes >= 252 removes the modulo bias toward the first 4 symbols.
    for (const b of randomBytes) if (b < 252 && tail.length < 10) tail += alphabet[b % 36];
  }
  return (prefix + time + tail).slice(0, 20);
}

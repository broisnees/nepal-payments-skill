import { environmentFrom, pemFromEnv, type EnvVars } from "../../core/env.ts";
import type { Environment } from "../../core/types.ts";

export interface NepalPayConfig {
  env: Environment;
  /** 8 digits, e.g. "00002501" (your acquiring bank). */
  acquirerId: string;
  /** Creditor id / merchant code, e.g. "2501ELFDRY2". */
  merchantId: string;
  /** <= 25 chars; must match the enrolled name. */
  merchantName: string;
  merchantCategoryCode: string | number;
  merchantCity: string;
  merchantPostalCode: string;
  storeLabel: string;
  terminalLabel?: string;
  /** NPI user issued to the merchant. Also the `userId` inside the signed token. */
  username: string;
  password: string;
  /** PKCS#8 PEM extracted from the NPI .pfx. */
  privateKeyPem: string;
  /**
   * "basic" (merchant QR doc) or "oauth" (NPI password grant, needs clientId/clientSecret).
   * Default "basic".
   */
  auth?: "basic" | "oauth";
  clientId?: string;
  clientSecret?: string;
  /** Ask NCHL for a base64 PNG alongside the QR string. Default true. */
  qrImage?: boolean;
  /**
   * NCHL's public key (SPKI PEM, from NPI.cer): verifies confirm-payment notifications, encrypts
   * the WebSocket api_token.
   */
  nchlPublicKeyPem?: string;
  /**
   * WebSocket channel issued by NCHL (STOMP endpoint ending in /nqrws), with its own username
   * and API token.
   */
  wsUrl?: string;
  wsUsername?: string;
  wsApiToken?: string;
  baseUrl?: string;
  timeoutMs?: number;
}

/**
 * NEPALPAY_ACQUIRER_ID + NEPALPAY_MERCHANT_ID + NEPALPAY_USERNAME + NEPALPAY_PRIVATE_KEY_PEM
 * enable NEPALPAY QR. NEPALPAY_CLIENT_ID switches auth to OAuth; NEPALPAY_NCHL_PUBLIC_KEY_PEM and
 * NEPALPAY_WS_* enable notification checks and the WebSocket channel.
 */
export function nepalPayConfigFromEnv(env: EnvVars): NepalPayConfig | undefined {
  const acquirerId = env.NEPALPAY_ACQUIRER_ID;
  const merchantId = env.NEPALPAY_MERCHANT_ID;
  const username = env.NEPALPAY_USERNAME;
  const privateKeyPem = env.NEPALPAY_PRIVATE_KEY_PEM;
  if (!acquirerId || !merchantId || !username || !privateKeyPem) return undefined;
  return {
    env: environmentFrom(env.NEPALPAY_ENV),
    acquirerId,
    merchantId,
    merchantName: env.NEPALPAY_MERCHANT_NAME ?? "",
    merchantCategoryCode: env.NEPALPAY_MCC ?? "",
    merchantCity: env.NEPALPAY_MERCHANT_CITY ?? "Kathmandu",
    merchantPostalCode: env.NEPALPAY_MERCHANT_POSTAL_CODE ?? "44600",
    storeLabel: env.NEPALPAY_STORE_LABEL ?? "Store1",
    terminalLabel: env.NEPALPAY_TERMINAL_LABEL,
    username,
    password: env.NEPALPAY_PASSWORD ?? "",
    privateKeyPem: pemFromEnv(privateKeyPem),
    ...(env.NEPALPAY_CLIENT_ID && {
      auth: "oauth" as const,
      clientId: env.NEPALPAY_CLIENT_ID,
      clientSecret: env.NEPALPAY_CLIENT_SECRET ?? "",
    }),
    ...(env.NEPALPAY_NCHL_PUBLIC_KEY_PEM && {
      nchlPublicKeyPem: pemFromEnv(env.NEPALPAY_NCHL_PUBLIC_KEY_PEM),
    }),
    ...(env.NEPALPAY_WS_URL && {
      wsUrl: env.NEPALPAY_WS_URL,
      wsUsername: env.NEPALPAY_WS_USERNAME,
      wsApiToken: env.NEPALPAY_WS_API_TOKEN,
    }),
  };
}

// Port 7979 must be reachable outbound (IME may need to whitelist your server IP).
export const BASE = {
  sandbox: "https://stg.imepay.com.np:7979",
  production: "https://payment.imepay.com.np:7979",
} as const;

export const GET_TOKEN_PATH = "/api/Web/GetToken";
export const RECHECK_PATH = "/api/Web/Recheck";
export const CHECKOUT_PATH = "/WebCheckout/Checkout";

/** Recheck ResponseCode 0 = paid. Every other code is treated as pending (see adapter.ts). */
export const isPaidResponseCode = (code: unknown) => String(code) === "0";

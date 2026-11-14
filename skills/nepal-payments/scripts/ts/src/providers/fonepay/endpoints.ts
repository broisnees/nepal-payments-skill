import type { Environment, PaymentStatus } from "../../core/types.ts";

const MERCHANT_API_PATH = "/api/merchant/merchantDetailsForThirdParty";

export const URLS = {
  sandbox: {
    payment: "https://dev-clientapi.fonepay.com/api/merchantRequest",
    legacyVerify: "https://dev-clientapi.fonepay.com/api/merchantRequest/verificationMerchant",
    // Dev merchant API hosts are not in public DNS (Fonepay whitelists / issues them on
    // onboarding).
    txnVerification: `https://dev-merchantapi.fonepay.com${MERCHANT_API_PATH}/txnVerification`,
    qrBase: `https://dev-merchantapi.fonepay.com${MERCHANT_API_PATH}`,
  },
  production: {
    payment: "https://clientapi.fonepay.com/api/merchantRequest",
    legacyVerify: "https://clientapi.fonepay.com/api/merchantRequest/verificationMerchant",
    txnVerification: `https://merchantapi.fonepay.com${MERCHANT_API_PATH}/txnVerification`,
    qrBase: `https://merchantapi.fonepay.com${MERCHANT_API_PATH}`,
  },
} as const;

/** The resource string signed into the txnVerification `auth` header. */
export const TXN_RESOURCE = "/merchant/merchantDetailsForThirdParty/txnVerification";

/** Real QR websocket host for each env (Fonepay sometimes answers with a localhost URL). */
export const QR_WEBSOCKET_HOST: Record<Environment, string> = {
  sandbox: "wss://dev-ws.fonepay.com",
  production: "wss://ws.fonepay.com",
};

/** txnVerification / QR status `paymentStatus`, lowercased -> PaymentStatus. */
export const TXN_STATUS: Record<string, PaymentStatus> = {
  success: "paid",
  pending: "pending",
  failed: "failed",
};

export const BASE = {
  sandbox: "https://devopennpi.connectips.com",
  production: "https://opennpi.connectips.com",
} as const;

export const OAUTH_TOKEN_PATH = "/oauth/token";
export const GENERATE_QR_PATH = "/qr/generateQR";
export const TXN_REPORT_PATH = "/nQR/v1/merchanttxnreport";

/** STOMP destinations on the NCHL WebSocket channel. */
export const WS_SUBSCRIBE = "/user/nqrws/check-txn-status";
export const WS_SEND = "/nqrws/check-txn-status";

/** ISO 4217 numeric code for NPR. */
export const NPR = 524;

/** generateQR success code. */
export const QR_OK = "000";
/** merchanttxnreport success codes, and "record not found". */
export const REPORT_OK = ["200", "000"];
export const REPORT_NOT_FOUND = "E010";

/** Paid = debitStatus "000" and creditStatus "000" | "999" | "DEFER". */
export const DEBIT_OK = "000";
export const CREDIT_OK = new Set(["000", "999", "DEFER"]);

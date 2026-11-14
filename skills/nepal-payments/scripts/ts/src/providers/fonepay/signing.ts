/**
 * Signatures: HMAC-SHA512(secretKey UTF-8, comma-joined values) as HEX. Compare
 * case-insensitively.
 *   request DV       = PID,MD,PRN,AMT,CRN,DT,R1,R2,RU
 *   response DV      = PRN,PID,PS,RC,UID,BC,INI,P_AMT,R_AMT   (raw strings as received)
 *   txnVerification  = username,password,POST,application/json,
 *                      /merchant/merchantDetailsForThirdParty/txnVerification,<exact JSON body>
 *   QR create        = amount,prn,merchantCode,remarks1,remarks2
 *   QR status        = prn,merchantCode
 */
import { hmac } from "../../core/crypto.ts";
import { toHex } from "../../core/encoding.ts";
import { TXN_RESOURCE } from "./endpoints.ts";

export const RESPONSE_DV_FIELDS = [
  "PRN",
  "PID",
  "PS",
  "RC",
  "UID",
  "BC",
  "INI",
  "P_AMT",
  "R_AMT",
] as const;

export async function fonepayHmac(secret: string, values: (string | number)[]): Promise<string> {
  return toHex(await hmac("SHA-512", secret, values.join(","))).toUpperCase();
}

/** MM/DD/YYYY in Asia/Kathmandu (Fonepay rejects other formats). */
export function fonepayDate(d = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Kathmandu",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${part("month")}/${part("day")}/${part("year")}`;
}

/** The request DV over the redirect params, in the documented order, on RAW (unencoded) values. */
export function requestDvValues(p: Record<string, string>): string[] {
  return [p.PID, p.MD, p.PRN, p.AMT, p.CRN, p.DT, p.R1, p.R2, p.RU];
}

/**
 * txnVerification body. It is signed byte-for-byte, so build it once and send exactly that
 * string (format follows the spec example).
 */
export function txnVerificationBody(prn: string, merchantCode: string, amount: string): string {
  return (
    `{"prn": ${JSON.stringify(prn)},` +
    `"merchantCode": ${JSON.stringify(merchantCode)},` +
    `"amount": ${JSON.stringify(amount)}}`
  );
}

/** Lowercase-hex HMAC for the txnVerification `auth` header. */
export async function txnVerificationAuth(
  secret: string,
  username: string,
  password: string,
  body: string,
): Promise<string> {
  const message = [username, password, "POST", "application/json", TXN_RESOURCE, body].join(",");
  return toHex(await hmac("SHA-512", secret, message));
}

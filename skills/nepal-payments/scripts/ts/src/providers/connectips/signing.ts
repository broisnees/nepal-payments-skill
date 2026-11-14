/**
 * Every connectIPS token is RSA-SHA256 (creditor private key, PKCS#8 PEM) over a
 * "KEY=value,KEY=value" string, base64.
 */

/** DD-MM-YYYY in Asia/Kathmandu. */
export function connectIpsDate(d = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kathmandu",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${part("day")}-${part("month")}-${part("year")}`;
}

/** The exact string connectIPS expects to be signed for the gateway form. */
export function connectIpsTokenString(f: Record<string, string>): string {
  return (
    `MERCHANTID=${f.MERCHANTID},APPID=${f.APPID},APPNAME=${f.APPNAME},TXNID=${f.TXNID},` +
    `TXNDATE=${f.TXNDATE},TXNCRNCY=${f.TXNCRNCY},TXNAMT=${f.TXNAMT},` +
    `REFERENCEID=${f.REFERENCEID},REMARKS=${f.REMARKS},PARTICULARS=${f.PARTICULARS},TOKEN=TOKEN`
  );
}

/** The string signed for validatetxn / gettxndetail. REFERENCEID is the TXNID you sent. */
export function validationTokenString(
  merchantId: number | string,
  appId: string,
  txnId: string,
  amountPaisa: number,
): string {
  return `MERCHANTID=${merchantId},APPID=${appId},REFERENCEID=${txnId},TXNAMT=${amountPaisa}`;
}

/** Commas/equals would corrupt the token string: replace them with spaces, then cut to `max`. */
export const clip = (s: string, max: number) => s.replace(/[,=]/g, " ").slice(0, max);

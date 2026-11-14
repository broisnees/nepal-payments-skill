/**
 * Every NEPALPAY signature is RSA-SHA256 (NPI private key, PKCS#8 PEM) over comma-joined values,
 * base64. The strings:
 *   QR token     = acquirerId,merchantId,merchantCategoryCode,transactionCurrency,
 *                  transactionAmount,billNumber,userId            (no spaces)
 *   confirmation = merchantBillNo,merchantId,merchantName,paymentRef,channel,payerMobile,sessionNo
 *   our reply    = txnDate,status,message,merchantBillNo,paymentRef
 */

/** The exact string NCHL expects to be signed for a dynamic QR. */
export function nepalPayTokenString(f: {
  acquirerId: string;
  merchantId: string;
  merchantCategoryCode: string | number;
  transactionCurrency: string | number;
  transactionAmount: string;
  billNumber: string;
  userId: string;
}): string {
  return [
    f.acquirerId,
    f.merchantId,
    f.merchantCategoryCode,
    f.transactionCurrency,
    f.transactionAmount,
    f.billNumber,
    f.userId,
  ].join(",");
}

/**
 * What NCHL signs on a confirm-payment notification. The docs name the field
 * payerMobileNumber; the sample sends payerMobile.
 */
export function nepalPayConfirmationString(n: Record<string, unknown>): string {
  const text = (key: string) => (n[key] == null ? "" : String(n[key]));
  const payerMobile = n.payerMobileNumber != null ? text("payerMobileNumber") : text("payerMobile");
  return [
    text("merchantBillNo"),
    text("merchantId"),
    text("merchantName"),
    text("paymentRef"),
    text("channel"),
    payerMobile,
    text("sessionNo"),
  ].join(",");
}

/** The string we sign on our reply to a confirm-payment notification. */
export function confirmationReplyString(r: {
  txnDate: string;
  status: string;
  message: string;
  merchantBillNo: string;
  paymentRef: string;
}): string {
  return [r.txnDate, r.status, r.message, r.merchantBillNo, r.paymentRef].join(",");
}

/** "10.50", "1000.00": always 2 decimals. */
export function transactionAmount(amountPaisa: number): string {
  const rupees = Math.trunc(amountPaisa / 100);
  const paisa = String(amountPaisa % 100).padStart(2, "0");
  return `${rupees}.${paisa}`;
}

/** Typed shapes of connectIPS responses, and the guards that produce them from untyped JSON. */
import { isRecord } from "../../core/records.ts";

export interface ConnectIpsTxnDetail {
  merchantId: number;
  appId: string;
  referenceId: string;
  txnAmt: string | number;
  status: "SUCCESS" | "FAILED" | "ERROR" | string;
  statusDesc: string;
  debitBankCode?: string;
  txnId?: number | string;
  batchId?: number | string;
  txnDate?: number;
  chargeAmt?: number;
  chargeLiability?: "MN" | "CG";
  creditStatus?: string;
  [k: string]: unknown;
}

/**
 * A validatetxn / gettxndetail answer carries a truthy `status`. Other fields are taken as
 * documented (verify() still reads txnAmt defensively).
 */
export function isTxnDetail(value: unknown): value is ConnectIpsTxnDetail {
  return isRecord(value) && Boolean(value.status);
}

/** txnAmt (paisa) as a whole number, or null when absent or not numeric. */
export function txnAmountPaisa(txnAmt: unknown): number | null {
  if (txnAmt === undefined || txnAmt === null) return null; // Number(null) would be 0
  const amount = Math.round(Number(txnAmt));
  return Number.isFinite(amount) ? amount : null;
}

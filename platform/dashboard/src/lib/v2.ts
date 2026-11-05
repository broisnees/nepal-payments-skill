// Merchant operations shapes (SPEC-v2). The API types live in @paynp/shared (ops.ts, finance.ts); this file adds
// the few the dashboard needs on top.
import type { PaymentDetail, PaymentOps, RefundStatus } from "@paynp/shared";

export type {
  ActionEndpoint,
  ActionRecord,
  ChecklistStep,
  DoctorCheck,
  DoctorFinding,
  DoctorReport,
  GatewayFee,
  LookupMatch,
  LookupResult,
  MissingSettlement,
  PaymentOps,
  PaymentSummary,
  RefundCase,
  RefundKind,
  RefundStatus,
  RowFilter,
  Statement,
  StatementMapping,
  StatementNeedsMapping,
  StatementRow,
  StatementSummary,
  StatusLink,
  Verdict,
  YearRow,
  YearSummary,
} from "@paynp/shared";


/** The payment detail response, with the ops view when the API includes it. */
export type PaymentDetailV2 = PaymentDetail & { ops?: PaymentOps };

/** Cases that still need someone. */
export const OPEN_REFUND: RefundStatus[] = ["open", "requested", "failed"];

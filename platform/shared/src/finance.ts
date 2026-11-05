// API types for the v2 finance features (statements, exports, public status) and the Bikram Sambat calendar
// table the exports use. See SPEC-v2.md sections 4.5 to 4.7.

// ------------------------------------------------------------------ Bikram Sambat calendar

/** Nepal Standard Time is UTC+05:45. */
export const NEPAL_OFFSET_MS = (5 * 60 + 45) * 60_000;
const DAY_MS = 86_400_000;

export const BS_MONTHS = ["Baisakh", "Jestha", "Asar", "Shrawan", "Bhadra", "Asoj", "Kartik", "Mangsir", "Poush", "Magh", "Falgun", "Chaitra"] as const;

/**
 * Days per BS month from Baisakh 2080 to Asar 2085, which covers fiscal years 2080/81 to 2084/85.
 *
 * Source: the month lengths in the nepali-date-converter (3.4.2) and bikram-sambat (1.8.1) npm tables, which agree
 * with each other for every month here, cross-checked against the Hamro Patro calendar pages
 * (hamropatro.com/calendar/YYYY/M) for Asar, Shrawan, Bhadra, Poush and Chaitra 2084, Asoj, Mangsir and Magh 2083,
 * and Baisakh and Asar 2085. nepali-datetime (2.0.0) disagrees for parts of 2084 and 2085 and was not used.
 * BS month lengths are set each year by the Nepal Panchanga Nirnayak Samiti; extend the table when 2085/86 is
 * published (the rest of 2085 is left out on purpose because the published tables still disagree on it).
 */
export const BS_MONTH_DAYS: Readonly<Record<number, readonly number[]>> = {
  2080: [31, 32, 31, 32, 31, 30, 30, 30, 29, 29, 30, 30],
  2081: [31, 32, 31, 32, 31, 30, 30, 30, 29, 30, 29, 31],
  2082: [31, 31, 32, 31, 31, 31, 30, 29, 30, 29, 30, 30],
  2083: [31, 31, 32, 31, 31, 31, 30, 29, 30, 29, 30, 30],
  2084: [31, 31, 32, 31, 31, 30, 30, 30, 29, 30, 30, 30],
  2085: [31, 32, 31],
};
/** Baisakh 1, 2080 is 14 April 2023 (as a UTC midnight date). */
const BS_EPOCH = Date.UTC(2023, 3, 14);
export const BS_FIRST_YEAR = 2080;
export const BS_LAST_YEAR = 2085;
/** Fiscal years the table covers: "2080-81" to "2084-85". */
export const FISCAL_YEARS = ["2080-81", "2081-82", "2082-83", "2083-84", "2084-85"] as const;

export interface BsDate {
  year: number;
  /** 1 to 12, Baisakh = 1 */
  month: number;
  day: number;
}

/** The BS date of the Nepal calendar day that contains the instant `ms`. Null outside the table. */
export function toBs(ms: number): BsDate | null {
  let left = Math.floor((ms + NEPAL_OFFSET_MS) / DAY_MS) - BS_EPOCH / DAY_MS;
  if (left < 0) return null;
  for (let y = BS_FIRST_YEAR; y <= BS_LAST_YEAR; y++) {
    const months = BS_MONTH_DAYS[y];
    for (let m = 0; m < months.length; m++) {
      if (left < months[m]) return { year: y, month: m + 1, day: left + 1 };
      left -= months[m];
    }
  }
  return null;
}

/** Start of the Nepal day for a BS date, as epoch ms (00:00 NPT). Null outside the table or for an invalid day. */
export function fromBs(year: number, month: number, day = 1): number | null {
  const months = BS_MONTH_DAYS[year];
  if (!months || month < 1 || month > months.length || day < 1 || day > months[month - 1]) return null;
  let days = 0;
  for (let y = BS_FIRST_YEAR; y < year; y++) days += BS_MONTH_DAYS[y].reduce((s, d) => s + d, 0);
  for (let m = 0; m < month - 1; m++) days += months[m];
  return BS_EPOCH + (days + day - 1) * DAY_MS - NEPAL_OFFSET_MS;
}

/** "2082-04-15" (BS) for an instant, or null outside the table. */
export function formatBs(ms: number): string | null {
  const d = toBs(ms);
  return d ? `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}` : null;
}

export interface BsMonthRange {
  /** "2082-04" */
  month: string;
  /** "Shrawan 2082" */
  label: string;
  /** Epoch ms of 00:00 NPT on day 1. */
  from: number;
  /** Epoch ms of 00:00 NPT on day 1 of the next month (exclusive). */
  to: number;
}

/** One BS month as an AD half-open range. Null outside the table. */
export function bsMonthRange(year: number, month: number): BsMonthRange | null {
  const from = fromBs(year, month, 1);
  const days = BS_MONTH_DAYS[year]?.[month - 1];
  if (from === null || days === undefined) return null;
  return { month: `${year}-${String(month).padStart(2, "0")}`, label: `${BS_MONTHS[month - 1]} ${year}`, from, to: from + days * DAY_MS };
}

export interface FiscalYear {
  /** "2082-83" */
  fy: string;
  /** 00:00 NPT on Shrawan 1. */
  from: number;
  /** 00:00 NPT on the next Shrawan 1 (exclusive): the end of Asar. */
  to: number;
  months: BsMonthRange[];
}

/**
 * Nepal's fiscal year runs Shrawan 1 to the last day of Asar. Accepts "2082-83", "2082/83", "2082-2083" or "2082".
 * Null for a malformed value or a year outside the table.
 */
export function fiscalYear(input: string): FiscalYear | null {
  const m = /^(\d{4})(?:[-/](\d{2}|\d{4}))?$/.exec(input.trim());
  if (!m) return null;
  const start = Number(m[1]);
  if (m[2]) {
    const end = m[2].length === 2 ? Math.floor(start / 100) * 100 + Number(m[2]) + (Number(m[2]) < start % 100 ? 100 : 0) : Number(m[2]);
    if (end !== start + 1) return null;
  }
  const months: BsMonthRange[] = [];
  for (let i = 0; i < 12; i++) {
    const y = i < 9 ? start : start + 1;
    const r = bsMonthRange(y, ((3 + i) % 12) + 1);
    if (!r) return null;
    months.push(r);
  }
  return { fy: `${start}-${String((start + 1) % 100).padStart(2, "0")}`, from: months[0].from, to: months[11].to, months };
}

/** The fiscal year ("2082-83") that contains an instant, or null outside the table. */
export function fiscalYearOf(ms: number): string | null {
  const d = toBs(ms);
  if (!d) return null;
  const start = d.month >= 4 ? d.year : d.year - 1;
  return fiscalYear(String(start)) ? `${start}-${String((start + 1) % 100).padStart(2, "0")}` : null;
}

// ------------------------------------------------------------------ 4.5 statements

export type StatementUnit = "rupees" | "paisa";

/** Which CSV column holds what. Column names match headers case-insensitively, ignoring spaces and punctuation. */
export interface StatementMapping {
  date: string;
  ref: string;
  /** More reference columns tried after `ref` (for example an order id or product id column). */
  ref_alt?: string[];
  amount: string;
  fee?: string;
  net?: string;
  status?: string;
  settled_at?: string;
  /** Amount columns are in rupees (default) or paisa. */
  unit?: StatementUnit;
  /** How to read 03/04/2025. Default "auto": day first unless the file has a value that only works month first. */
  date_order?: "auto" | "dmy" | "mdy";
  /** Zero-based index of the header row. Default: detected (title rows above the header are skipped). */
  header_row?: number;
}

export interface StatementPreset {
  gateway: string;
  /** Always true in v2: built from common column names, not from verified merchant exports. */
  unverified: true;
  /** Candidate header names per field, in order of preference. */
  columns: Record<"date" | "ref" | "amount" | "fee" | "net" | "status" | "settled_at", string[]>;
}

/** 422 body from POST /statements when no saved mapping or preset fits. */
export interface StatementNeedsMapping {
  error: { code: "mapping_required"; message: string };
  headers: string[];
  header_row: number;
  sample: string[][];
  /** The best partial guess (fields it could find), for the UI to prefill. */
  mapping: Partial<StatementMapping> | null;
  missing: ("date" | "ref" | "amount")[];
}

export interface StatementTotals {
  count: number;
  amount_paisa: number;
}

export interface StatementDay {
  /** 00:00 NPT of the day, epoch ms. */
  day: number;
  /** "2025-07-17" (NPT) */
  date: string;
  gross_paisa: number;
  refunds_paisa: number;
  fees_paisa: number;
  net_paisa: number;
  matched: number;
  unmatched: number;
}

export interface Statement {
  id: string;
  env: "test" | "live";
  gateway: string;
  filename: string;
  period_from: number | null;
  period_to: number | null;
  row_count: number;
  uploaded_at: number;
  uploaded_by: string | null;
  mapping: StatementMapping;
  /** How the mapping was chosen. */
  mapping_source: "request" | "saved" | "preset";
  /** True when an unverified preset picked the columns. */
  unverified_preset: boolean;
}

export interface StatementSummary extends Statement {
  /** Payment rows (positive, not void) and refund rows. */
  payments: StatementTotals;
  refunds: StatementTotals;
  /** Rows with a failed/cancelled status: kept, not counted. */
  void: number;
  /** Rows that could not be parsed (bad date or amount). */
  errors: number;
  matched: StatementTotals & { by_ref: number; by_amount_time: number };
  /** Statement rows that match nothing in paynp. */
  not_in_paynp: StatementTotals;
  /** paynp paid payments in the statement period (same gateway and env) that no statement row matched. */
  missing_settlement: StatementTotals;
  /** Matched rows whose amount differs from paynp's. */
  mismatch: StatementTotals & { diff_paisa: number };
  gross_paisa: number;
  refunds_paisa: number;
  fees_paisa: number;
  net_paisa: number;
  /** fees / gross, 0 to 1. */
  effective_fee_rate: number | null;
  per_day: StatementDay[];
}

export type StatementRowKind = "payment" | "refund" | "void" | "error";
export type MatchKind = "ref" | "amount_time" | "none";
export type RowFilter = "all" | "matched" | "unmatched" | "missing" | "mismatch" | "errors";

export interface StatementRow {
  row: number;
  kind: StatementRowKind;
  txn_at: number | null;
  ref: string | null;
  amount_paisa: number | null;
  fee_paisa: number | null;
  net_paisa: number | null;
  status: string | null;
  settled_at: number | null;
  match_attempt_id: string | null;
  match_kind: MatchKind;
  /** paynp's amount for the matched payment. */
  paynp_amount_paisa: number | null;
  order_id: string | null;
  error: string | null;
  /** The original CSV cells. */
  raw: string[];
}

/** Items of GET /statements/:id/rows?filter=missing. */
export interface MissingSettlement {
  attempt_id: string;
  order_id: string | null;
  gateway: string;
  amount_paisa: number | null;
  status: string;
  finished_at: number | null;
  provider_ref: string | null;
}

export interface GatewayFee {
  gateway: string;
  /** Percentage in basis points: 150 = 1.5%. */
  pct_bp: number;
  fixed_paisa: number;
}

// ------------------------------------------------------------------ 4.7 exports

export interface YearRow {
  gateway: string;
  count: number;
  gross_paisa: number;
  refunds_paisa: number;
  fees_paisa: number;
  /** Fees from matched statement rows. */
  fees_actual_paisa: number;
  /** Fees estimated from gateway_fees for payments with no statement fee. */
  fees_estimated_paisa: number;
  net_paisa: number;
}

export type YearTotals = Omit<YearRow, "gateway">;

export interface YearMonth extends YearTotals {
  /** "2082-04" (BS) */
  month: string;
  /** "Shrawan 2082" */
  label: string;
  from: number;
  to: number;
  gateways: YearRow[];
}

export interface YearSummary {
  fy: string;
  env: "test" | "live";
  from: number;
  to: number;
  /** "2025-07-17" and "2026-07-16": first and last AD day of the fiscal year. */
  from_date: string;
  to_date: string;
  gateways: YearRow[];
  months: YearMonth[];
  totals: YearTotals;
}

// ------------------------------------------------------------------ 4.6 public status

export type GatewayState = "operational" | "degraded" | "down" | "no_data";

export interface StatusPoint {
  /** Bucket start, epoch ms. */
  t: number;
  /** Null when the bucket had too little traffic to show. */
  error_rate: number | null;
  p95_ms: number | null;
}

export interface StatusDay {
  /** "2026-11-04" (NPT) */
  date: string;
  /** Share of shown minutes that were healthy, 0 to 1; null when no minute had enough traffic. */
  uptime: number | null;
}

export interface StatusIncident {
  started_at: number;
  ended_at: number;
  minutes: number;
  kind: "errors" | "latency" | "errors_and_latency";
  peak_error_rate: number;
  peak_p95_ms: number | null;
  ongoing: boolean;
}

export interface GatewayStatus {
  gateway: string;
  name: string;
  state: GatewayState;
  /** Last 15 minutes. */
  error_rate: number | null;
  p95_ms: number | null;
  /** 24 hourly points, oldest first. */
  last_24h: StatusPoint[];
  /** 90 NPT days, oldest first. */
  uptime_90d: StatusDay[];
  uptime_90d_pct: number | null;
  /** Average and p95 latency by Nepal hour of day (0 to 23) over the last 7 days. */
  peak_hours: { hour: number; avg_ms: number | null; p95_ms: number | null }[];
  incidents: StatusIncident[];
}

export interface StatusReport {
  generated_at: number;
  /** A minute is shown only when at least this many projects sent traffic for the gateway. */
  min_projects: number;
  gateways: GatewayStatus[];
}

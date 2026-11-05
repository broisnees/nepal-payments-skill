// Accounting exports (SPEC-v2 4.7). All dates are Nepal time; amounts are rupees with 2 decimals.
import { GATEWAYS, NEPAL_OFFSET_MS, bsMonthRange, fiscalYear, formatBs, type YearMonth, type YearRow, type YearSummary, type YearTotals } from "@paynp/shared";
import { DAY } from "../lib/util.ts";
import { GATEWAY_NAMES } from "../status/aggregate.ts";
import { captureProjectStatements, creditNoteNo } from "./credit-notes.ts";
import { nptDate, nptDateTime, rupees, toCsv } from "./csv.ts";

export const SETTLED = ["paid", "refunded"];
const PAGE = 5000;
const MAX_PAGES = 20;
/** Payments that finish more than this long after they start are left out of month and year exports. */
const FINISH_LAG = 7 * DAY;

export const gatewayName = (g: string) => (GATEWAY_NAMES[g] ?? g).replace(/ \(cards\)$/, "");

/** Merchant-entered MDR estimate for one payment, rounded half up to the paisa. Same formula as the SQL in yearSummary. */
export const estimateFee = (amount: number, pctBp: number, fixed: number) => Math.floor((amount * pctBp + 5000) / 10000) + fixed;

export interface Range {
  from: number;
  to: number;
  /** "2025-07" or "2082-04" */
  label: string;
  bs: boolean;
}

/**
 * "YYYY-MM": a Gregorian month in Nepal time, or a Bikram Sambat month when the year is 2080 or later (inside the
 * calendar table), so accountants can ask for Shrawan 2082 as "2082-04".
 */
export function parseMonth(raw: string | undefined): Range | null {
  const m = /^(\d{4})-(\d{2})$/.exec(raw ?? "");
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  if (mo < 1 || mo > 12) return null;
  if (y >= 2070) {
    const r = bsMonthRange(y, mo);
    return r ? { from: r.from, to: r.to, label: r.month, bs: true } : null;
  }
  if (y < 2000) return null;
  return { from: Date.UTC(y, mo - 1, 1) - NEPAL_OFFSET_MS, to: Date.UTC(y, mo, 1) - NEPAL_OFFSET_MS, label: raw!, bs: false };
}

export interface ExportPayment {
  attempt_id: string;
  order_id: string | null;
  gateway: string;
  provider_ref: string | null;
  status: string;
  amount_paisa: number | null;
  started_at: number;
  finished_at: number | null;
  stmt_fee: number | null;
  refunded: number;
  pct_bp: number | null;
  fixed_paisa: number | null;
}

export interface FeeInfo {
  fee: number | null;
  source: "statement" | "estimate" | null;
}

export function feeOf(p: ExportPayment): FeeInfo {
  if (!SETTLED.includes(p.status)) return { fee: null, source: null };
  if (p.stmt_fee !== null) return { fee: p.stmt_fee, source: "statement" };
  if (p.pct_bp !== null && p.amount_paisa !== null) return { fee: estimateFee(p.amount_paisa, p.pct_bp, p.fixed_paisa ?? 0), source: "estimate" };
  return { fee: null, source: null };
}

const PAYMENT_SELECT = `SELECT p.attempt_id, p.order_id, p.gateway, p.provider_ref, p.status, p.amount_paisa, p.started_at, p.finished_at,
  (SELECT SUM(r.fee_paisa) FROM statement_rows r JOIN statements s ON s.id = r.statement_id
    WHERE r.match_attempt_id = p.attempt_id AND s.project_id = p.project_id AND s.env = p.env AND r.kind = 'payment') AS stmt_fee,
  MAX(p.refunded_paisa, COALESCE((SELECT SUM(c.amount_paisa) FROM credit_notes c WHERE c.project_id = p.project_id AND c.env = p.env AND c.attempt_id = p.attempt_id), 0),
    CASE WHEN p.status = 'refunded' AND p.refunded_paisa = 0 THEN COALESCE(p.amount_paisa, 0) ELSE 0 END) AS refunded,
  f.pct_bp, f.fixed_paisa
FROM payments p LEFT JOIN gateway_fees f ON f.project_id = p.project_id AND f.gateway = p.gateway`;

/** Payments by start time (or, with `finished`, settled payments by finish time), with fees and refunds. */
export async function loadPayments(env: Env, projectId: string, envName: string, from: number, to: number, finished = false): Promise<ExportPayment[]> {
  const out: ExportPayment[] = [];
  let cursor: [number, string] = [-1, ""];
  const where = finished
    ? `p.project_id = ?1 AND p.env = ?2 AND p.started_at >= ?3 - ${FINISH_LAG} AND p.started_at < ?4 AND p.status IN ('paid','refunded') AND p.finished_at >= ?3 AND p.finished_at < ?4`
    : "p.project_id = ?1 AND p.env = ?2 AND p.started_at >= ?3 AND p.started_at < ?4";
  for (let i = 0; i < MAX_PAGES; i++) {
    const rows = await env.DB.prepare(`${PAYMENT_SELECT} WHERE ${where} AND (p.started_at, p.attempt_id) > (?5, ?6) ORDER BY p.started_at, p.attempt_id LIMIT ${PAGE}`)
      .bind(projectId, envName, from, to, cursor[0], cursor[1])
      .all<ExportPayment>();
    out.push(...rows.results);
    if (rows.results.length < PAGE) break;
    const last = rows.results[rows.results.length - 1];
    cursor = [last.started_at, last.attempt_id];
  }
  return out;
}

export interface CreditNoteRow {
  month: string;
  seq: number;
  attempt_id: string;
  gateway: string;
  refunded_at: number;
  amount_paisa: number;
  reason: string | null;
  refund_ref: string | null;
  order_id: string | null;
}

export async function loadCreditNotes(env: Env, projectId: string, envName: string, from: number, to: number, t: number): Promise<CreditNoteRow[]> {
  const [, , rows] = await env.DB.batch([
    ...captureProjectStatements(env, projectId, envName, from, to, t),
    env.DB.prepare(
      `SELECT c.month, c.seq, c.attempt_id, c.gateway, c.refunded_at, c.amount_paisa, c.reason, c.refund_ref, p.order_id
       FROM credit_notes c LEFT JOIN payments p ON p.project_id = c.project_id AND p.env = c.env AND p.attempt_id = c.attempt_id
       WHERE c.project_id = ? AND c.env = ? AND c.refunded_at >= ? AND c.refunded_at < ? ORDER BY c.refunded_at, c.month, c.seq`,
    ).bind(projectId, envName, from, to),
  ]);
  return rows.results as CreditNoteRow[];
}

// ------------------------------------------------------------------ transactions.csv

export const TRANSACTIONS_HEADER = ["date", "attempt_id", "order_id", "gateway", "provider_ref", "status", "amount", "refunded", "fee", "net", "fee_source", "date_bs"];

export function transactionsCsv(payments: ExportPayment[]): string {
  const rows = payments.map((p) => {
    const { fee, source } = feeOf(p);
    const settled = SETTLED.includes(p.status);
    const amount = p.amount_paisa;
    const net = settled && amount !== null ? amount - p.refunded - (fee ?? 0) : null;
    return [nptDateTime(p.started_at), p.attempt_id, p.order_id, p.gateway, p.provider_ref, p.status, rupees(amount), rupees(p.refunded), rupees(fee), rupees(net), source, formatBs(p.started_at)];
  });
  return toCsv(TRANSACTIONS_HEADER, rows, { numeric: [6, 7, 8, 9] });
}

// ------------------------------------------------------------------ tally.csv

export const TALLY_HEADER = ["Date", "Voucher Type", "Ledger", "Debit", "Credit", "Narration"];
export const TALLY_NOTE =
  "Tally-style CSV; map ledgers on import. Layout unverified (not checked against a Tally import template). Columns: Date (DD-MM-YYYY, Nepal time), Voucher Type, Ledger, Debit, Credit, Narration. Each voucher is two lines that balance.";

const ddmmyyyy = (ms: number) => {
  const d = nptDate(ms);
  return `${d.slice(8, 10)}-${d.slice(5, 7)}-${d.slice(0, 4)}`;
};

const narr = (p: { order_id: string | null; attempt_id: string }, extra: string[]) =>
  [p.order_id ? `Order ${p.order_id}` : null, `attempt ${p.attempt_id}`, ...extra].filter(Boolean).join(", ");

/** Receipts per payment, credit notes per refund, and one fee journal per gateway per day. */
export function tallyCsv(payments: ExportPayment[], notes: CreditNoteRow[]): string {
  type Line = { at: number; order: number; cells: (string | null)[] };
  const lines: Line[] = [];
  const fees = new Map<string, { at: number; gateway: string; fee: number; statement: number; estimate: number }>();
  for (const p of payments) {
    if (p.amount_paisa === null || p.finished_at === null) continue;
    const date = ddmmyyyy(p.finished_at);
    const ledger = `${gatewayName(p.gateway)} Receipts`;
    const n = narr(p, [p.provider_ref ? `${gatewayName(p.gateway)} ref ${p.provider_ref}` : ""]);
    lines.push({ at: p.finished_at, order: 0, cells: [date, "Receipt", ledger, rupees(p.amount_paisa), null, n] });
    lines.push({ at: p.finished_at, order: 0, cells: [date, "Receipt", "Sales", null, rupees(p.amount_paisa), n] });
    const f = feeOf(p);
    if (f.fee) {
      const k = `${nptDate(p.finished_at)}|${p.gateway}`;
      const e = fees.get(k) ?? { at: p.finished_at, gateway: p.gateway, fee: 0, statement: 0, estimate: 0 };
      e.fee += f.fee;
      if (f.source === "statement") e.statement++;
      else e.estimate++;
      e.at = Math.max(e.at, p.finished_at);
      fees.set(k, e);
    }
  }
  for (const c of notes) {
    const date = ddmmyyyy(c.refunded_at);
    const n = narr(c, [creditNoteNo(c.month, c.seq), c.refund_ref ? `refund ref ${c.refund_ref}` : "", c.reason ? `reason: ${c.reason}` : ""]);
    lines.push({ at: c.refunded_at, order: 1, cells: [date, "Credit Note", "Sales Returns", rupees(c.amount_paisa), null, n] });
    lines.push({ at: c.refunded_at, order: 1, cells: [date, "Credit Note", `${gatewayName(c.gateway)} Receipts`, null, rupees(c.amount_paisa), n] });
  }
  for (const [k, e] of fees) {
    const day = k.split("|")[0];
    const date = `${day.slice(8, 10)}-${day.slice(5, 7)}-${day.slice(0, 4)}`;
    const parts = [e.statement ? `${e.statement} from statement` : "", e.estimate ? `${e.estimate} estimated from the fee table` : ""].filter(Boolean).join(", ");
    const n = `${gatewayName(e.gateway)} charges for ${day} (${parts})`;
    // Sort fee journals at the end of their day.
    const endOfDay = (Math.floor((e.at + NEPAL_OFFSET_MS) / DAY) + 1) * DAY - NEPAL_OFFSET_MS - 1;
    lines.push({ at: endOfDay, order: 2, cells: [date, "Journal", "Payment Gateway Charges", rupees(e.fee), null, n] });
    lines.push({ at: endOfDay, order: 2, cells: [date, "Journal", `${gatewayName(e.gateway)} Receipts`, null, rupees(e.fee), n] });
  }
  // Stable: pairs stay together because both lines share at/order and Array.sort is stable.
  lines.sort((a, b) => a.at - b.at || a.order - b.order);
  return toCsv(TALLY_HEADER, lines.map((l) => l.cells), { comment: TALLY_NOTE, numeric: [3, 4] });
}

// ------------------------------------------------------------------ hamrokhata.csv

export const HAMROKHATA_HEADER = ["Date", "Miti", "Voucher Type", "Reference", "Order ID", "Particulars", "Payment Method", "Amount", "Fee", "Net Amount"];
export const HAMROKHATA_NOTE = `Hamrokhata-style sales and receipts CSV. Layout unverified (not checked against a Hamrokhata import template). Columns: ${HAMROKHATA_HEADER.join(", ")}. Date is AD, Miti is BS, both Nepal time; refunds are Sales Return rows with negative amounts.`;

export function hamrokhataCsv(payments: ExportPayment[], notes: CreditNoteRow[]): string {
  type Row = { at: number; cells: (string | null)[] };
  const rows: Row[] = [];
  for (const p of payments) {
    if (p.amount_paisa === null || p.finished_at === null) continue;
    const f = feeOf(p);
    rows.push({
      at: p.finished_at,
      cells: [
        nptDate(p.finished_at), formatBs(p.finished_at), "Sales Receipt", p.provider_ref ?? p.attempt_id, p.order_id,
        `Online payment via ${gatewayName(p.gateway)}`, gatewayName(p.gateway), rupees(p.amount_paisa), rupees(f.fee), rupees(p.amount_paisa - (f.fee ?? 0)),
      ],
    });
  }
  for (const c of notes) {
    rows.push({
      at: c.refunded_at,
      cells: [
        nptDate(c.refunded_at), formatBs(c.refunded_at), "Sales Return", creditNoteNo(c.month, c.seq), c.order_id,
        `Refund of attempt ${c.attempt_id}${c.reason ? `: ${c.reason}` : ""}`, gatewayName(c.gateway), rupees(-c.amount_paisa), null, rupees(-c.amount_paisa),
      ],
    });
  }
  rows.sort((a, b) => a.at - b.at);
  return toCsv(HAMROKHATA_HEADER, rows.map((r) => r.cells), { comment: HAMROKHATA_NOTE, numeric: [7, 8, 9] });
}

// ------------------------------------------------------------------ credit-notes.csv

export const CREDIT_NOTES_HEADER = ["credit_note_no", "date", "date_bs", "original_attempt", "original_order", "gateway", "amount", "reason", "refund_ref"];

export function creditNotesCsv(notes: CreditNoteRow[]): string {
  return toCsv(
    CREDIT_NOTES_HEADER,
    notes.map((c) => [creditNoteNo(c.month, c.seq), nptDate(c.refunded_at), formatBs(c.refunded_at), c.attempt_id, c.order_id, c.gateway, rupees(c.amount_paisa), c.reason, c.refund_ref]),
    { numeric: [6] },
  );
}

// ------------------------------------------------------------------ year summary

const zero = (): YearTotals => ({ count: 0, gross_paisa: 0, refunds_paisa: 0, fees_paisa: 0, fees_actual_paisa: 0, fees_estimated_paisa: 0, net_paisa: 0 });

function addInto(t: YearTotals, r: Partial<YearTotals>) {
  t.count += r.count ?? 0;
  t.gross_paisa += r.gross_paisa ?? 0;
  t.refunds_paisa += r.refunds_paisa ?? 0;
  t.fees_actual_paisa += r.fees_actual_paisa ?? 0;
  t.fees_estimated_paisa += r.fees_estimated_paisa ?? 0;
  t.fees_paisa = t.fees_actual_paisa + t.fees_estimated_paisa;
  t.net_paisa = t.gross_paisa - t.refunds_paisa - t.fees_paisa;
}

const gwOrder = (a: string, b: string) => {
  const ia = (GATEWAYS as readonly string[]).indexOf(a);
  const ib = (GATEWAYS as readonly string[]).indexOf(b);
  return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
};

/** Nepal fiscal year (Shrawan 1 to Asar end): per gateway and per BS month. 3 queries (plus 2 to number new refunds). */
export async function yearSummary(env: Env, projectId: string, envName: string, fy: string, t: number): Promise<YearSummary | null> {
  const year = fiscalYear(fy);
  if (!year) return null;
  const D = `((p.finished_at + ${NEPAL_OFFSET_MS}) / ${DAY})`;
  const res = await env.DB.batch([
    ...captureProjectStatements(env, projectId, envName, year.from, year.to, t),
    env.DB.prepare(
      `SELECT p.gateway, ${D} AS d, COUNT(*) AS n, SUM(COALESCE(p.amount_paisa, 0)) AS gross, SUM(COALESCE(sf.fee, 0)) AS fee_actual,
         SUM(CASE WHEN sf.fee IS NULL AND f.pct_bp IS NOT NULL AND p.amount_paisa IS NOT NULL THEN (p.amount_paisa * f.pct_bp + 5000) / 10000 + f.fixed_paisa ELSE 0 END) AS fee_est
       FROM payments p
       LEFT JOIN gateway_fees f ON f.project_id = p.project_id AND f.gateway = p.gateway
       LEFT JOIN (SELECT r.match_attempt_id AS a, SUM(r.fee_paisa) AS fee FROM statement_rows r JOIN statements s ON s.id = r.statement_id
                  WHERE s.project_id = ?1 AND s.env = ?2 AND r.kind = 'payment' AND r.match_attempt_id IS NOT NULL GROUP BY r.match_attempt_id) sf ON sf.a = p.attempt_id
       WHERE p.project_id = ?1 AND p.env = ?2 AND p.started_at >= ?3 - ${FINISH_LAG} AND p.started_at < ?4 AND p.status IN ('paid','refunded')
         AND p.finished_at >= ?3 AND p.finished_at < ?4
       GROUP BY p.gateway, d`,
    ).bind(projectId, envName, year.from, year.to),
    env.DB.prepare(
      `SELECT c.gateway, ((c.refunded_at + ${NEPAL_OFFSET_MS}) / ${DAY}) AS d, SUM(c.amount_paisa) AS refunds
       FROM credit_notes c WHERE c.project_id = ? AND c.env = ? AND c.refunded_at >= ? AND c.refunded_at < ? GROUP BY c.gateway, d`,
    ).bind(projectId, envName, year.from, year.to),
  ]);
  const pays = res[2].results as { gateway: string; d: number; n: number; gross: number; fee_actual: number; fee_est: number }[];
  const refunds = res[3].results as { gateway: string; d: number; refunds: number }[];

  const monthOf = (day: number) => year.months.findIndex((m) => day * DAY - NEPAL_OFFSET_MS >= m.from && day * DAY - NEPAL_OFFSET_MS < m.to);
  const months: YearMonth[] = year.months.map((m) => ({ ...zero(), month: m.month, label: m.label, from: m.from, to: m.to, gateways: [] }));
  const cell = (mi: number, gw: string): YearRow => {
    let r = months[mi].gateways.find((g) => g.gateway === gw);
    if (!r) months[mi].gateways.push((r = { gateway: gw, ...zero() }));
    return r;
  };
  for (const p of pays) {
    const mi = monthOf(p.d);
    if (mi < 0) continue;
    const add = { count: p.n, gross_paisa: p.gross, fees_actual_paisa: p.fee_actual, fees_estimated_paisa: p.fee_est };
    addInto(cell(mi, p.gateway), add);
    addInto(months[mi], add);
  }
  for (const r of refunds) {
    const mi = monthOf(r.d);
    if (mi < 0) continue;
    addInto(cell(mi, r.gateway), { refunds_paisa: r.refunds });
    addInto(months[mi], { refunds_paisa: r.refunds });
  }
  const byGw = new Map<string, YearRow>();
  const totals = zero();
  for (const m of months) {
    m.gateways.sort((a, b) => gwOrder(a.gateway, b.gateway));
    for (const g of m.gateways) {
      if (!byGw.has(g.gateway)) byGw.set(g.gateway, { gateway: g.gateway, ...zero() });
      addInto(byGw.get(g.gateway)!, g);
    }
    addInto(totals, m);
  }
  return {
    fy: year.fy,
    env: envName as "test" | "live",
    from: year.from,
    to: year.to,
    from_date: nptDate(year.from),
    to_date: nptDate(year.to - 1),
    gateways: [...byGw.values()].sort((a, b) => gwOrder(a.gateway, b.gateway)),
    months,
    totals,
  };
}

export const YEAR_HEADER = ["fiscal_year", "month_bs", "month", "from", "to", "gateway", "payments", "gross", "refunds", "fees_actual", "fees_estimated", "fees", "net"];

/** One row per month and gateway, a "total" row per month, then per-gateway and grand totals for the year. */
export function yearSummaryCsv(s: YearSummary): string {
  const rows: (string | number | null)[][] = [];
  const line = (month: string, label: string, from: string, to: string, gw: string, r: YearTotals) => [
    s.fy, month, label, from, to, gw, r.count, rupees(r.gross_paisa), rupees(r.refunds_paisa), rupees(r.fees_actual_paisa), rupees(r.fees_estimated_paisa), rupees(r.fees_paisa), rupees(r.net_paisa),
  ];
  for (const m of s.months) {
    const from = nptDate(m.from);
    const to = nptDate(m.to - 1);
    for (const g of m.gateways) rows.push(line(m.month, m.label, from, to, g.gateway, g));
    rows.push(line(m.month, m.label, from, to, "total", m));
  }
  for (const g of s.gateways) rows.push(line("year", `FY ${s.fy}`, s.from_date, s.to_date, g.gateway, g));
  rows.push(line("year", `FY ${s.fy}`, s.from_date, s.to_date, "total", s.totals));
  return toCsv(YEAR_HEADER, rows, { numeric: [6, 7, 8, 9, 10, 11, 12] });
}



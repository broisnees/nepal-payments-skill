// Settlement statements (SPEC-v2 4.5): column presets, mapping, row extraction and matching against discerns payments.
import type { MatchKind, StatementMapping, StatementNeedsMapping, StatementPreset, StatementRowKind } from "@paynp/shared";
import { detectDateOrder, parseAmount, parseDate, type DateOrder } from "./csv.ts";

const COMMON = {
  date: ["transaction date", "txn date", "transaction date time", "transaction datetime", "date time", "datetime", "created date", "created at", "created on", "trans date", "date"],
  amount: ["amount", "transaction amount", "txn amount", "total amount", "amount rs", "amount npr", "gross amount", "paid amount"],
  fee: ["service charge", "commission", "charge", "charges", "fee", "fees", "mdr", "merchant commission", "transaction fee", "commission amount"],
  net: ["net amount", "net", "settled amount", "settlement amount", "net settlement", "payable amount", "net payable"],
  status: ["status", "transaction status", "txn status", "state"],
  settled_at: ["settlement date", "settled date", "settled on", "settled at", "settlement time", "settlement datetime"],
};

const REFS: Record<string, string[]> = {
  esewa: ["reference code", "ref id", "refid", "transaction code", "transaction id", "reference id", "reference", "product id", "transaction uuid"],
  khalti: ["transaction id", "idx", "pidx", "transaction idx", "reference", "purchase order id", "product identity"],
  fonepay: ["prn", "fonepay trace id", "trace id", "transaction id", "reference no", "reference number", "reference", "bill number"],
};
const GENERIC_REFS = ["reference", "reference code", "reference no", "reference number", "transaction id", "txn id", "ref id", "prn", "pidx", "order id"];

/** Presets built from common column names in merchant exports. None has been checked against a real statement yet. */
export const PRESETS: StatementPreset[] = [...Object.keys(REFS), "*"].map((gateway) => ({
  gateway,
  unverified: true,
  columns: { ...COMMON, ref: REFS[gateway] ?? GENERIC_REFS },
}));

export const presetFor = (gateway: string) => PRESETS.find((p) => p.gateway === gateway) ?? PRESETS.find((p) => p.gateway === "*")!;

/** Header names compare without case, spaces or punctuation: "Txn. Amount (Rs)" == "txn amount rs". */
export const norm = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, "");

const REQUIRED = ["date", "ref", "amount"] as const;
const OPTIONAL = ["fee", "net", "status", "settled_at"] as const;

/** Column index per mapped field for a header row, or the list of required fields it cannot find. */
export function bindMapping(headers: string[], mapping: StatementMapping): { ok: true; cols: BoundColumns } | { ok: false; missing: string[] } {
  const idx = new Map<string, number>();
  headers.forEach((h, i) => {
    const k = norm(h);
    if (k && !idx.has(k)) idx.set(k, i);
  });
  const find = (name: string | undefined) => (name ? idx.get(norm(name)) : undefined);
  const missing: string[] = [];
  const col = (field: string, name: string | undefined, required: boolean) => {
    const i = find(name);
    if (i === undefined && (required || name)) missing.push(`${field} (${JSON.stringify(name ?? "")})`);
    return i;
  };
  const cols: BoundColumns = {
    date: col("date", mapping.date, true)!,
    ref: [col("ref", mapping.ref, true)!, ...(mapping.ref_alt ?? []).map((r) => col("ref_alt", r, true)!)],
    amount: col("amount", mapping.amount, true)!,
    fee: col("fee", mapping.fee, false),
    net: col("net", mapping.net, false),
    status: col("status", mapping.status, false),
    settled_at: col("settled_at", mapping.settled_at, false),
  };
  return missing.length ? { ok: false, missing } : { ok: true, cols };
}

export interface BoundColumns {
  date: number;
  ref: number[];
  amount: number;
  fee?: number;
  net?: number;
  status?: number;
  settled_at?: number;
}

/** The mapping a preset gives for a header row: the first candidate present per field, extra ref columns as ref_alt. */
export function presetMapping(preset: StatementPreset, headers: string[]): Partial<StatementMapping> {
  const have = new Map(headers.map((h) => [norm(h), h] as const));
  const pick = (cands: string[]) => cands.map((c) => have.get(norm(c))).filter((h): h is string => h !== undefined);
  const out: Partial<StatementMapping> = {};
  for (const f of ["date", "amount", ...OPTIONAL] as const) {
    const hit = pick(preset.columns[f])[0];
    if (hit) out[f] = hit;
  }
  const refs = [...new Set(pick(preset.columns.ref))];
  if (refs.length) {
    out.ref = refs[0];
    if (refs.length > 1) out.ref_alt = refs.slice(1);
  }
  return out;
}

const isComplete = (m: Partial<StatementMapping>): m is StatementMapping => REQUIRED.every((f) => typeof m[f] === "string" && m[f]);

const SCAN_ROWS = 30;

export type Resolved = { mapping: StatementMapping; source: "request" | "saved" | "preset"; headerRow: number; cols: BoundColumns };

/**
 * Picks the mapping and header row: the request's mapping, else the saved one for project+gateway, else the gateway's
 * preset, else the generic preset. Title rows above the header are skipped (the first 30 rows are scanned).
 */
export function resolveMapping(
  records: string[][],
  gateway: string,
  requested: StatementMapping | null,
  saved: StatementMapping | null,
): { ok: true; value: Resolved } | { ok: false; status: 422; body: StatementNeedsMapping } {
  const scan = Math.min(records.length, SCAN_ROWS);
  const rowsToTry = (m: StatementMapping | Partial<StatementMapping> | null) =>
    m && typeof m.header_row === "number" ? [m.header_row] : Array.from({ length: scan }, (_, i) => i);

  if (requested) {
    for (const r of rowsToTry(requested)) {
      const b = bindMapping(records[r] ?? [], requested);
      if (b.ok) return { ok: true, value: { mapping: { ...requested, header_row: r }, source: "request", headerRow: r, cols: b.cols } };
    }
    const headerRow = requested.header_row ?? guessHeaderRow(records);
    const b = bindMapping(records[headerRow] ?? [], requested);
    return needsMapping(records, headerRow, gateway, `mapping columns not found in the header: ${b.ok ? "" : b.missing.join(", ")}`);
  }
  if (saved) {
    for (const r of rowsToTry(saved)) {
      const b = bindMapping(records[r] ?? [], saved);
      if (b.ok) return { ok: true, value: { mapping: { ...saved, header_row: r }, source: "saved", headerRow: r, cols: b.cols } };
    }
  }
  for (const preset of [presetFor(gateway), presetFor("*")]) {
    for (let r = 0; r < scan; r++) {
      const m = presetMapping(preset, records[r]);
      if (!isComplete(m)) continue;
      const mapping: StatementMapping = { ...m, unit: "rupees", header_row: r };
      const b = bindMapping(records[r], mapping);
      if (b.ok) return { ok: true, value: { mapping, source: "preset", headerRow: r, cols: b.cols } };
    }
  }
  return needsMapping(records, guessHeaderRow(records), gateway, "no saved mapping or preset matches these columns; map them and upload again");
}

/** The first row (of the first 30) with at least 60% of the widest row's non-empty cells. */
export function guessHeaderRow(records: string[][]): number {
  const scan = records.slice(0, SCAN_ROWS);
  const counts = scan.map((r) => r.filter((c) => c !== "").length);
  const max = Math.max(0, ...counts);
  const i = counts.findIndex((c) => c >= 2 && c >= max * 0.6);
  return i < 0 ? 0 : i;
}

function needsMapping(records: string[][], headerRow: number, gateway: string, message: string) {
  const headers = records[headerRow] ?? [];
  const guess = presetMapping(presetFor(gateway), headers);
  const body: StatementNeedsMapping = {
    error: { code: "mapping_required", message },
    headers,
    header_row: headerRow,
    sample: records.slice(headerRow + 1, headerRow + 6),
    mapping: Object.keys(guess).length ? guess : null,
    missing: REQUIRED.filter((f) => !guess[f]),
  };
  return { ok: false as const, status: 422 as const, body };
}

// ------------------------------------------------------------------ rows

export interface ParsedRow {
  /** 1-based record number in the file (the header row counts). */
  row: number;
  kind: StatementRowKind;
  txn_at: number | null;
  /** Reference values from the ref columns, in mapping order (blank ones dropped). */
  refs: string[];
  amount_paisa: number | null;
  fee_paisa: number | null;
  net_paisa: number | null;
  status: string | null;
  settled_at: number | null;
  raw: string[];
  error: string | null;
}

const REFUND_STATUS = /refund|revers|chargeback|charge back|returned/i;
const VOID_STATUS = /fail|cancel|declin|reject|expire|pending|initiat|incomplete|not ?found|error|ambiguous|abandon/i;

/** Extracts typed rows below the header. Blank lines and footer rows (no date and no reference, or "Total") are skipped. */
export function extractRows(records: string[][], r: Resolved): ParsedRow[] {
  const { cols, mapping, headerRow } = r;
  const unit = mapping.unit ?? "rupees";
  const body = records.slice(headerRow + 1);
  const order: DateOrder =
    mapping.date_order === "mdy" || mapping.date_order === "dmy"
      ? mapping.date_order
      : detectDateOrder([...body.map((x) => x[cols.date] ?? ""), ...(cols.settled_at !== undefined ? body.map((x) => x[cols.settled_at!] ?? "") : [])]);
  const out: ParsedRow[] = [];
  body.forEach((cells, k) => {
    if (cells.every((c) => c === "")) return;
    const get = (i: number | undefined) => (i === undefined ? "" : (cells[i] ?? "").trim());
    const dateRaw = get(cols.date);
    const refs = cols.ref.map(get).filter(Boolean);
    if (!dateRaw && !refs.length) return;
    const date = parseDate(dateRaw, order);
    if ((!date.ok || date.value === null) && cells.some((c) => /^(grand |sub ?)?totals?:?$/i.test(c))) return;
    const errors: string[] = [];
    if (!date.ok) errors.push(date.error);
    else if (date.value === null) errors.push("date is empty");
    const amount = parseAmount(get(cols.amount), unit);
    if (!amount.ok) errors.push(amount.error);
    else if (amount.value === null) errors.push("amount is empty");
    const fee = parseAmount(get(cols.fee), unit);
    if (!fee.ok) errors.push(`fee: ${fee.error}`);
    const net = parseAmount(get(cols.net), unit);
    if (!net.ok) errors.push(`net: ${net.error}`);
    const settled = parseDate(get(cols.settled_at), order);
    const status = get(cols.status) || null;

    let amt = amount.ok ? amount.value : null;
    let kind: StatementRowKind = "payment";
    if (errors.length) kind = "error";
    else if ((amt ?? 0) < 0 || (status && REFUND_STATUS.test(status))) {
      kind = "refund";
      if (amt !== null && amt > 0) amt = -amt;
    } else if (status && VOID_STATUS.test(status)) kind = "void";

    let feeP = fee.ok ? fee.value : null;
    let netP = net.ok ? net.value : null;
    if (kind !== "error" && amt !== null) {
      if (feeP !== null && kind === "payment") feeP = Math.abs(feeP);
      if (netP === null) netP = amt - (kind === "payment" ? (feeP ?? 0) : 0);
      else if (feeP === null && kind === "payment" && netP <= amt) feeP = amt - netP;
    }
    out.push({
      row: headerRow + 2 + k,
      kind,
      txn_at: date.ok ? date.value : null,
      refs,
      amount_paisa: amt,
      fee_paisa: feeP,
      net_paisa: netP,
      status,
      settled_at: settled.ok ? settled.value : null,
      raw: cells,
      error: errors.length ? errors.join("; ") : null,
    });
  });
  return out;
}

// ------------------------------------------------------------------ matching

export const MATCH_WINDOW_MS = 10 * 60_000;

export interface PaymentCandidate {
  attempt_id: string;
  amount_paisa: number | null;
  status: string;
  /** finished_at, else started_at. */
  at: number;
}

export interface RefundCandidate {
  attempt_id: string;
  amount_paisa: number;
  at: number;
}

export interface Match {
  attempt_id: string | null;
  kind: MatchKind;
  /** The discerns amount the row was compared with (payment amount, or the refund amount). */
  paynp_amount_paisa: number | null;
  mismatch: boolean;
}

/**
 * Matches rows to payments: (1) a reference that resolves to exactly one payment (several: the one paid with the
 * same amount), then (2) amount and time within 10 minutes, only when the row and the payment are each other's single
 * candidate. Refund rows match a refund by ref (the original transaction's reference) or by amount and time against
 * discerns' refunds.
 */
export function matchRows(
  rows: ParsedRow[],
  refIndex: Map<string, string[]>,
  payments: Map<string, PaymentCandidate>,
  periodPayments: PaymentCandidate[],
  refunds: RefundCandidate[],
): Match[] {
  const none: Match = { attempt_id: null, kind: "none", paynp_amount_paisa: null, mismatch: false };
  const out: Match[] = rows.map(() => none);
  const refundsByAttempt = new Map<string, RefundCandidate[]>();
  for (const r of refunds) {
    if (!refundsByAttempt.has(r.attempt_id)) refundsByAttempt.set(r.attempt_id, []);
    refundsByAttempt.get(r.attempt_id)!.push(r);
  }
  const usedPayments = new Set<string>();
  const usedRefunds = new Set<RefundCandidate>();

  const refundFor = (row: ParsedRow, attempt: string): Match => {
    const abs = Math.abs(row.amount_paisa ?? 0);
    const list = refundsByAttempt.get(attempt) ?? [];
    const exact = list.find((r) => r.amount_paisa === abs && !usedRefunds.has(r));
    if (exact) {
      usedRefunds.add(exact);
      return { attempt_id: attempt, kind: "ref", paynp_amount_paisa: exact.amount_paisa, mismatch: false };
    }
    const total = list.reduce((s, r) => s + r.amount_paisa, 0);
    return { attempt_id: attempt, kind: "ref", paynp_amount_paisa: total, mismatch: total !== abs };
  };

  // (1) by reference
  rows.forEach((row, i) => {
    if (row.kind !== "payment" && row.kind !== "refund") return;
    for (const ref of row.refs) {
      let attempts = [...new Set(refIndex.get(ref) ?? [])].filter((a) => payments.has(a));
      if (attempts.length > 1) {
        const paid = attempts.filter((a) => {
          const p = payments.get(a)!;
          return (p.status === "paid" || p.status === "refunded") && (row.kind === "refund" || p.amount_paisa === row.amount_paisa);
        });
        attempts = paid;
      }
      if (attempts.length !== 1) continue;
      const a = attempts[0];
      const p = payments.get(a)!;
      if (row.kind === "refund") out[i] = refundFor(row, a);
      else {
        out[i] = { attempt_id: a, kind: "ref", paynp_amount_paisa: p.amount_paisa, mismatch: p.amount_paisa !== row.amount_paisa };
        usedPayments.add(a);
      }
      return;
    }
  });

  // (2) by amount and time, unique both ways
  const near = (at: number, t: number | null) => t !== null && Math.abs(at - t) <= MATCH_WINDOW_MS;
  const open = rows.map((row, i) => ({ row, i })).filter(({ row, i }) => out[i].kind === "none" && (row.kind === "payment" || row.kind === "refund"));
  const payCands = new Map<number, PaymentCandidate[]>();
  const refCands = new Map<number, RefundCandidate[]>();
  const payCount = new Map<string, number>();
  const refCount = new Map<RefundCandidate, number>();
  for (const { row, i } of open) {
    if (row.kind === "payment") {
      const c = periodPayments.filter((p) => !usedPayments.has(p.attempt_id) && p.amount_paisa === row.amount_paisa && near(p.at, row.txn_at));
      payCands.set(i, c);
      for (const p of c) payCount.set(p.attempt_id, (payCount.get(p.attempt_id) ?? 0) + 1);
    } else {
      const abs = Math.abs(row.amount_paisa ?? 0);
      const c = refunds.filter((r) => !usedRefunds.has(r) && r.amount_paisa === abs && near(r.at, row.txn_at));
      refCands.set(i, c);
      for (const r of c) refCount.set(r, (refCount.get(r) ?? 0) + 1);
    }
  }
  for (const [i, c] of payCands) {
    if (c.length === 1 && payCount.get(c[0].attempt_id) === 1) {
      out[i] = { attempt_id: c[0].attempt_id, kind: "amount_time", paynp_amount_paisa: c[0].amount_paisa, mismatch: false };
    }
  }
  for (const [i, c] of refCands) {
    if (c.length === 1 && refCount.get(c[0]) === 1) {
      out[i] = { attempt_id: c[0].attempt_id, kind: "amount_time", paynp_amount_paisa: c[0].amount_paisa, mismatch: false };
    }
  }
  return out;
}

/** Removes a project's finance rows; part of deleting a project. statement_rows hang off statements, so they go first. */
export function deleteFinanceStatements(env: Env, projectId: string): D1PreparedStatement[] {
  return [
    env.DB.prepare("DELETE FROM statement_rows WHERE statement_id IN (SELECT id FROM statements WHERE project_id = ?)").bind(projectId),
    ...["statements", "statement_mappings", "gateway_fees", "credit_notes"].map((t) => env.DB.prepare(`DELETE FROM ${t} WHERE project_id = ?`).bind(projectId)),
  ];
}

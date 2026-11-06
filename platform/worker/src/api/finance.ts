// Finance API (SPEC-v2 4.5 and 4.7): settlement statements, fee table, column mappings and accounting exports.
// All under /api/projects/:p with ?env= (default test, as in v1). Writes need admin, reads viewer.
import {
  newId,
  type GatewayFee,
  type MissingSettlement,
  type Statement,
  type StatementDay,
  type StatementMapping,
  type StatementRow,
  type StatementSummary,
} from "@paynp/shared";
import type { Context, Hono } from "hono";
import { captureProjectStatements } from "../finance/credit-notes.ts";
import { nptDate, parseCsv } from "../finance/csv.ts";
import {
  HAMROKHATA_NOTE,
  TALLY_NOTE,
  creditNotesCsv,
  hamrokhataCsv,
  loadCreditNotes,
  loadPayments,
  parseMonth,
  tallyCsv,
  transactionsCsv,
  yearSummary,
  yearSummaryCsv,
} from "../finance/exports.ts";
import {
  MATCH_WINDOW_MS,
  PRESETS,
  extractRows,
  matchRows,
  resolveMapping,
  type ParsedRow,
  type PaymentCandidate,
  type RefundCandidate,
} from "../finance/statements.ts";
import { requireProject } from "../lib/access.ts";
import { DAY, HttpError, badRequest, decodeCursor, notFound, now, page, parseEnv, parseJson, parseLimit, parseTime, readJson } from "../lib/util.ts";
import type { AppEnv } from "../types.ts";
import { NEPAL_OFFSET_MS } from "@paynp/shared";

export const MAX_STATEMENT_BYTES = 5 * 1024 * 1024;
export const MAX_STATEMENT_ROWS = 100_000;
const GATEWAY_RE = /^[a-z0-9_-]{2,32}$/;
const JSON_CHUNK = 800_000;
const REF_CHUNK = 5000;

interface StatementDbRow {
  id: string;
  project_id: string;
  env: string;
  gateway: string;
  filename: string;
  period_from: number | null;
  period_to: number | null;
  row_count: number;
  mapping: string;
  uploaded_at: number;
  uploaded_by: string | null;
  mapping_source: string;
  unverified: number;
}

const toStatement = (r: StatementDbRow): Statement => ({
  id: r.id,
  env: r.env as Statement["env"],
  gateway: r.gateway,
  filename: r.filename,
  period_from: r.period_from,
  period_to: r.period_to,
  row_count: r.row_count,
  uploaded_at: r.uploaded_at,
  uploaded_by: r.uploaded_by,
  mapping: parseJson<StatementMapping>(r.mapping, { date: "", ref: "", amount: "" }),
  mapping_source: r.mapping_source as Statement["mapping_source"],
  unverified_preset: r.unverified === 1,
});

/** Validates a mapping from JSON (object or string). */
export function parseMapping(raw: unknown): StatementMapping | null {
  if (raw === undefined || raw === null || raw === "") return null;
  let v = raw;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      throw badRequest("mapping must be JSON");
    }
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) throw badRequest("mapping must be an object");
  const o = v as Record<string, unknown>;
  const s = (k: string, required: boolean) => {
    const x = o[k];
    if (x === undefined || x === null || x === "") {
      if (required) throw badRequest(`mapping.${k} is required (a column name)`);
      return undefined;
    }
    if (typeof x !== "string" || x.length > 200) throw badRequest(`mapping.${k} must be a column name`);
    return x;
  };
  const m: StatementMapping = { date: s("date", true)!, ref: s("ref", true)!, amount: s("amount", true)! };
  for (const k of ["fee", "net", "status", "settled_at"] as const) {
    const x = s(k, false);
    if (x) m[k] = x;
  }
  if (o.ref_alt !== undefined) {
    if (!Array.isArray(o.ref_alt) || o.ref_alt.length > 5 || o.ref_alt.some((x) => typeof x !== "string" || !x || x.length > 200)) {
      throw badRequest("mapping.ref_alt must be up to 5 column names");
    }
    if (o.ref_alt.length) m.ref_alt = o.ref_alt as string[];
  }
  if (o.unit !== undefined) {
    if (o.unit !== "rupees" && o.unit !== "paisa") throw badRequest("mapping.unit must be rupees or paisa");
    m.unit = o.unit;
  }
  if (o.date_order !== undefined) {
    if (o.date_order !== "auto" && o.date_order !== "dmy" && o.date_order !== "mdy") throw badRequest("mapping.date_order must be auto, dmy or mdy");
    m.date_order = o.date_order;
  }
  if (o.header_row !== undefined && o.header_row !== null) {
    if (!Number.isInteger(o.header_row) || (o.header_row as number) < 0 || (o.header_row as number) > 1000) throw badRequest("mapping.header_row must be a row index");
    m.header_row = o.header_row as number;
  }
  return m;
}

const isCsvName = (name: string) => !/\.(xlsx|xls|xlsm|ods|numbers|pdf)$/i.test(name);

interface Upload {
  text: string;
  filename: string;
  gateway: string;
  mapping: StatementMapping | null;
  env: "test" | "live";
}

async function readUpload(c: Context<AppEnv>): Promise<Upload> {
  const ct = (c.req.header("content-type") ?? "").toLowerCase();
  const declared = Number(c.req.header("content-length") ?? "0");
  if (declared > MAX_STATEMENT_BYTES + 64 * 1024) throw new HttpError(413, "too_large", "statement files are limited to 5 MB");
  let text: string;
  let filename: string;
  let gateway: unknown;
  let mapping: unknown;
  let envRaw: unknown;
  if (ct.startsWith("multipart/form-data")) {
    let form: FormData;
    try {
      form = await c.req.raw.formData();
    } catch {
      throw badRequest("could not read the multipart body");
    }
    const file = form.get("file");
    if (!file || typeof file === "string") throw badRequest("file is required (a CSV export of the statement)");
    if (file.size > MAX_STATEMENT_BYTES) throw new HttpError(413, "too_large", "statement files are limited to 5 MB");
    filename = file.name || "statement.csv";
    if (!isCsvName(filename) || /spreadsheetml|ms-excel|pdf/.test(file.type)) {
      throw badRequest("only CSV statements are supported for now: export or save the statement as CSV and upload that", "unsupported_format");
    }
    text = await file.text();
    gateway = form.get("gateway") ?? c.req.query("gateway");
    mapping = form.get("mapping") ?? c.req.query("mapping");
    envRaw = form.get("env") ?? c.req.query("env");
  } else if (ct.startsWith("text/csv") || ct.startsWith("text/plain") || ct.startsWith("application/csv")) {
    const buf = await c.req.raw.arrayBuffer();
    if (buf.byteLength > MAX_STATEMENT_BYTES) throw new HttpError(413, "too_large", "statement files are limited to 5 MB");
    text = new TextDecoder().decode(buf);
    filename = c.req.query("filename") || "statement.csv";
    gateway = c.req.query("gateway");
    mapping = c.req.query("mapping");
    envRaw = c.req.query("env");
  } else {
    throw badRequest("send multipart/form-data with file, gateway and optional mapping, or a text/csv body with ?gateway=");
  }
  if (typeof gateway !== "string" || !GATEWAY_RE.test(gateway.trim().toLowerCase())) throw badRequest("gateway is required (esewa, khalti, fonepay, ...)");
  if (envRaw !== undefined && envRaw !== null && typeof envRaw !== "string") throw badRequest("env must be test or live");
  return { text, filename: filename.slice(0, 200), gateway: gateway.trim().toLowerCase(), mapping: parseMapping(mapping), env: parseEnv((envRaw as string | null) ?? undefined) };
}

function jsonChunks<T>(items: T[], max = JSON_CHUNK): string[] {
  const out: string[] = [];
  let cur: string[] = [];
  let size = 2;
  for (const it of items) {
    const s = JSON.stringify(it);
    if (cur.length && size + s.length + 1 > max) {
      out.push(`[${cur.join(",")}]`);
      cur = [];
      size = 2;
    }
    cur.push(s);
    size += s.length + 1;
  }
  if (cur.length) out.push(`[${cur.join(",")}]`);
  return out;
}

const REF_LOOKUP = `SELECT ref, attempt_id FROM payment_refs WHERE project_id = ?1 AND env = ?2 AND ref IN (SELECT value FROM json_each(?3))
UNION SELECT provider_ref, attempt_id FROM payments WHERE project_id = ?1 AND env = ?2 AND provider_ref IN (SELECT value FROM json_each(?3))
UNION SELECT order_id, attempt_id FROM payments WHERE project_id = ?1 AND env = ?2 AND order_id IN (SELECT value FROM json_each(?3))
UNION SELECT attempt_id, attempt_id FROM payments WHERE project_id = ?1 AND env = ?2 AND attempt_id IN (SELECT value FROM json_each(?3))`;

const INSERT_ROWS = `INSERT INTO statement_rows (statement_id, row, kind, txn_at, ref, amount_paisa, fee_paisa, net_paisa, status, settled_at, raw,
  match_attempt_id, match_kind, paynp_amount_paisa, mismatch, error)
SELECT ?1, ${Array.from({ length: 15 }, (_, i) => `json_extract(value, '$[${i}]')`).join(", ")} FROM json_each(?2)`;

/** Reads what matching needs, matches, and stores the statement. Returns the new statement id. */
async function storeStatement(env: Env, projectId: string, u: Upload, by: string, t: number) {
  const records = parseCsv(u.text);
  if (!records.length) throw badRequest("the file is empty");
  const saved = await env.DB.prepare("SELECT mapping FROM statement_mappings WHERE project_id = ? AND gateway = ?").bind(projectId, u.gateway).first<{ mapping: string }>();
  const resolved = resolveMapping(records, u.gateway, u.mapping, saved ? parseJson<StatementMapping | null>(saved.mapping, null) : null);
  if (!resolved.ok) return { needsMapping: resolved.body };
  const rows = extractRows(records, resolved.value);
  if (!rows.length) throw badRequest("no statement rows found below the header");
  if (rows.length > MAX_STATEMENT_ROWS) throw new HttpError(413, "too_large", `at most ${MAX_STATEMENT_ROWS} rows per statement`);

  const times = rows.filter((r) => r.kind !== "error" && r.txn_at !== null).map((r) => r.txn_at!);
  const periodFrom = times.length ? Math.min(...times) : null;
  const periodTo = times.length ? Math.max(...times) : null;

  // References: payment_refs (attempt ids, order ids, gateway references) plus the payments columns.
  const refs = [...new Set(rows.flatMap((r) => r.refs))];
  const refIndex = new Map<string, string[]>();
  const refStmts = [];
  for (let i = 0; i < refs.length; i += REF_CHUNK) {
    refStmts.push(env.DB.prepare(REF_LOOKUP).bind(projectId, u.env, JSON.stringify(refs.slice(i, i + REF_CHUNK))));
  }
  const refResults = refStmts.length ? await env.DB.batch(refStmts) : [];
  for (const r of refResults) {
    for (const { ref, attempt_id } of r.results as { ref: string; attempt_id: string }[]) {
      if (!refIndex.has(ref)) refIndex.set(ref, []);
      refIndex.get(ref)!.push(attempt_id);
    }
  }
  const refAttempts = [...new Set([...refIndex.values()].flat())];
  const lo = (periodFrom ?? t) - MATCH_WINDOW_MS;
  const hi = (periodTo ?? t) + MATCH_WINDOW_MS;
  const [, , pay, ref] = await env.DB.batch([
    // Number any refunds discerns has seen around this period first, so refund rows can match them.
    ...captureProjectStatements(env, projectId, u.env, lo - 40 * DAY, hi + DAY, t),
    env.DB.prepare(
      `SELECT attempt_id, amount_paisa, status, COALESCE(finished_at, started_at) AS at, gateway FROM payments
       WHERE project_id = ?1 AND env = ?2 AND (
         (gateway = ?3 AND status IN ('paid','refunded') AND started_at >= ?4 - ${7 * DAY} AND started_at <= ?5 AND COALESCE(finished_at, started_at) BETWEEN ?4 AND ?5)
         OR attempt_id IN (SELECT value FROM json_each(?6)))`,
    ).bind(projectId, u.env, u.gateway, lo, hi, JSON.stringify(refAttempts)),
    env.DB.prepare(
      `SELECT attempt_id, amount_paisa, refunded_at AS at FROM credit_notes
       WHERE project_id = ?1 AND env = ?2 AND ((gateway = ?3 AND refunded_at BETWEEN ?4 AND ?5) OR attempt_id IN (SELECT value FROM json_each(?6)))`,
    ).bind(projectId, u.env, u.gateway, lo, hi, JSON.stringify(refAttempts)),
  ]);
  const payRows = pay.results as (PaymentCandidate & { gateway: string })[];
  const payments = new Map(payRows.map((p) => [p.attempt_id, p]));
  const period = payRows.filter((p) => p.gateway === u.gateway && (p.status === "paid" || p.status === "refunded") && p.at >= lo && p.at <= hi);
  const matches = matchRows(rows, refIndex, payments, period, ref.results as RefundCandidate[]);

  const id = newId("stm");
  const m = resolved.value;
  const cells = rows.map((r: ParsedRow, i) => {
    const mt = matches[i];
    const refUsed = mt.kind === "ref" ? (r.refs.find((x) => (refIndex.get(x) ?? []).includes(mt.attempt_id!)) ?? r.refs[0]) : r.refs[0];
    return [
      r.row, r.kind, r.txn_at, refUsed ?? null, r.amount_paisa, r.fee_paisa, r.net_paisa, r.status, r.settled_at, JSON.stringify(r.raw),
      mt.attempt_id, mt.kind, mt.paynp_amount_paisa, mt.mismatch ? 1 : 0, r.error,
    ];
  });
  const stmts: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT INTO statements (id, project_id, env, gateway, filename, period_from, period_to, row_count, mapping, uploaded_at, uploaded_by, mapping_source, unverified)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(id, projectId, u.env, u.gateway, u.filename, periodFrom, periodTo, rows.length, JSON.stringify(m.mapping), t, by, m.source, m.source === "preset" ? 1 : 0),
    ...jsonChunks(cells).map((chunk) => env.DB.prepare(INSERT_ROWS).bind(id, chunk)),
  ];
  if (m.source === "request") {
    stmts.push(
      env.DB.prepare(
        "INSERT INTO statement_mappings (project_id, gateway, mapping, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (project_id, gateway) DO UPDATE SET mapping = excluded.mapping, updated_at = excluded.updated_at",
      ).bind(projectId, u.gateway, JSON.stringify(m.mapping), t),
    );
  }
  await env.DB.batch(stmts);
  return { id };
}

const MISSING_WHERE = `p.project_id = ?1 AND p.env = ?2 AND p.gateway = ?3 AND p.status IN ('paid','refunded')
  AND p.started_at >= ?4 - ${7 * DAY} AND p.started_at <= ?5 AND p.finished_at >= ?4 AND p.finished_at <= ?5
  AND NOT EXISTS (SELECT 1 FROM statement_rows r JOIN statements s ON s.id = r.statement_id
    WHERE r.match_attempt_id = p.attempt_id AND s.project_id = p.project_id AND s.env = p.env)`;

export async function statementSummary(env: Env, s: StatementDbRow): Promise<StatementSummary> {
  const D = `((txn_at + ${NEPAL_OFFSET_MS}) / ${DAY})`;
  const [groups, days, missing] = await env.DB.batch([
    env.DB.prepare(
      `SELECT kind, match_kind, mismatch, COUNT(*) AS n, SUM(COALESCE(amount_paisa, 0)) AS amt, SUM(COALESCE(fee_paisa, 0)) AS fee, SUM(COALESCE(net_paisa, 0)) AS net,
         SUM(CASE WHEN kind = 'refund' THEN -amount_paisa ELSE amount_paisa END - COALESCE(paynp_amount_paisa, 0)) AS diff
       FROM statement_rows WHERE statement_id = ? GROUP BY kind, match_kind, mismatch`,
    ).bind(s.id),
    env.DB.prepare(
      `SELECT ${D} AS d, SUM(CASE WHEN kind = 'payment' THEN amount_paisa ELSE 0 END) AS gross, SUM(CASE WHEN kind = 'refund' THEN -amount_paisa ELSE 0 END) AS refunds,
         SUM(COALESCE(fee_paisa, 0)) AS fee, SUM(COALESCE(net_paisa, 0)) AS net, SUM(match_kind != 'none') AS matched, SUM(match_kind = 'none') AS unmatched
       FROM statement_rows WHERE statement_id = ? AND kind IN ('payment','refund') AND txn_at IS NOT NULL GROUP BY d ORDER BY d`,
    ).bind(s.id),
    s.period_from === null
      ? env.DB.prepare("SELECT 0 AS n, 0 AS amt")
      : env.DB.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(p.amount_paisa), 0) AS amt FROM payments p WHERE ${MISSING_WHERE}`).bind(s.project_id, s.env, s.gateway, s.period_from, s.period_to),
  ]);
  type G = { kind: string; match_kind: string; mismatch: number; n: number; amt: number; fee: number; net: number; diff: number };
  const g = groups.results as G[];
  const sum = (f: (x: G) => boolean, k: "n" | "amt" | "fee" | "net" | "diff") => g.filter(f).reduce((a, x) => a + (x[k] ?? 0), 0);
  const counted = (x: G) => x.kind === "payment" || x.kind === "refund";
  const gross = sum((x) => x.kind === "payment", "amt");
  const fees = sum(counted, "fee");
  const miss = missing.results[0] as { n: number; amt: number };
  const per_day: StatementDay[] = (days.results as { d: number; gross: number; refunds: number; fee: number; net: number; matched: number; unmatched: number }[]).map((d) => ({
    day: d.d * DAY - NEPAL_OFFSET_MS,
    date: nptDate(d.d * DAY - NEPAL_OFFSET_MS),
    gross_paisa: d.gross,
    refunds_paisa: d.refunds,
    fees_paisa: d.fee,
    net_paisa: d.net,
    matched: d.matched,
    unmatched: d.unmatched,
  }));
  return {
    ...toStatement(s),
    payments: { count: sum((x) => x.kind === "payment", "n"), amount_paisa: gross },
    refunds: { count: sum((x) => x.kind === "refund", "n"), amount_paisa: -sum((x) => x.kind === "refund", "amt") },
    void: sum((x) => x.kind === "void", "n"),
    errors: sum((x) => x.kind === "error", "n"),
    matched: {
      count: sum((x) => counted(x) && x.match_kind !== "none", "n"),
      amount_paisa: sum((x) => counted(x) && x.match_kind !== "none", "amt"),
      by_ref: sum((x) => counted(x) && x.match_kind === "ref", "n"),
      by_amount_time: sum((x) => counted(x) && x.match_kind === "amount_time", "n"),
    },
    not_in_paynp: { count: sum((x) => counted(x) && x.match_kind === "none", "n"), amount_paisa: sum((x) => counted(x) && x.match_kind === "none", "amt") },
    missing_settlement: { count: miss.n, amount_paisa: miss.amt },
    mismatch: {
      count: sum((x) => counted(x) && x.mismatch === 1, "n"),
      amount_paisa: sum((x) => counted(x) && x.mismatch === 1, "amt"),
      diff_paisa: sum((x) => counted(x) && x.mismatch === 1, "diff"),
    },
    gross_paisa: gross,
    refunds_paisa: -sum((x) => x.kind === "refund", "amt"),
    fees_paisa: fees,
    net_paisa: sum(counted, "net"),
    effective_fee_rate: gross > 0 ? fees / gross : null,
    per_day,
  };
}

interface RowDb {
  row: number;
  kind: string;
  txn_at: number | null;
  ref: string | null;
  amount_paisa: number | null;
  fee_paisa: number | null;
  net_paisa: number | null;
  status: string | null;
  settled_at: number | null;
  raw: string;
  match_attempt_id: string | null;
  match_kind: string | null;
  paynp_amount_paisa: number | null;
  mismatch: number;
  error: string | null;
  order_id: string | null;
}

const toRow = (r: RowDb): StatementRow => ({
  row: r.row,
  kind: r.kind as StatementRow["kind"],
  txn_at: r.txn_at,
  ref: r.ref,
  amount_paisa: r.amount_paisa,
  fee_paisa: r.fee_paisa,
  net_paisa: r.net_paisa,
  status: r.status,
  settled_at: r.settled_at,
  match_attempt_id: r.match_attempt_id,
  match_kind: (r.match_kind ?? "none") as StatementRow["match_kind"],
  paynp_amount_paisa: r.paynp_amount_paisa,
  order_id: r.order_id,
  error: r.error,
  raw: parseJson<string[]>(r.raw, []),
});

const ROW_FILTERS: Record<string, string> = {
  all: "1 = 1",
  matched: "r.match_kind != 'none' AND r.kind IN ('payment','refund')",
  unmatched: "r.match_kind = 'none' AND r.kind IN ('payment','refund')",
  mismatch: "r.mismatch = 1",
  errors: "r.kind = 'error'",
};

async function loadStatement(c: Context<AppEnv>, min: "viewer" | "admin"): Promise<StatementDbRow> {
  const { project } = await requireProject(c, c.req.param("p")!, min);
  const s = await c.env.DB.prepare("SELECT * FROM statements WHERE id = ? AND project_id = ?").bind(c.req.param("id"), project.id).first<StatementDbRow>();
  if (!s) throw notFound("statement");
  return s;
}

function csvResponse(body: string, filename: string, unverified?: string): Response {
  const headers: Record<string, string> = {
    "content-type": "text/csv; charset=utf-8",
    "content-disposition": `attachment; filename="${filename}"`,
    "cache-control": "no-store",
  };
  if (unverified) headers["x-paynp-layout"] = "unverified";
  return new Response(body, { headers });
}

function monthParam(c: Context<AppEnv>) {
  const raw = c.req.query("month");
  const r = parseMonth(raw);
  if (!r) throw badRequest("month must be YYYY-MM (a Gregorian month, or a Bikram Sambat month from 2080-01, for example 2082-04 for Shrawan 2082)");
  return r;
}

export function registerFinance(api: Hono<AppEnv>) {
  // ------------------------------------------------------------ statements
  api.post("/projects/:p/statements", async (c) => {
    const { project } = await requireProject(c, c.req.param("p"), "admin");
    const u = await readUpload(c);
    const t = now();
    const r = await storeStatement(c.env, project.id, u, c.get("user").email, t);
    if ("needsMapping" in r) return c.json(r.needsMapping, 422);
    const s = await c.env.DB.prepare("SELECT * FROM statements WHERE id = ?").bind(r.id).first<StatementDbRow>();
    return c.json(await statementSummary(c.env, s!), 201);
  });

  api.get("/projects/:p/statements", async (c) => {
    const { project } = await requireProject(c, c.req.param("p"), "viewer");
    const q = c.req.query();
    const envName = parseEnv(q.env);
    const limit = parseLimit(q.limit);
    const cur = decodeCursor(q.cursor);
    const where = ["project_id = ?", "env = ?"];
    const args: (string | number)[] = [project.id, envName];
    if (q.gateway) where.push("gateway = ?"), args.push(q.gateway);
    if (cur) where.push("(uploaded_at, id) < (?, ?)"), args.push(...cur);
    const rows = await c.env.DB.prepare(`SELECT * FROM statements WHERE ${where.join(" AND ")} ORDER BY uploaded_at DESC, id DESC LIMIT ?`)
      .bind(...args, limit + 1)
      .all<StatementDbRow>();
    const p = page(rows.results, limit, (r) => [r.uploaded_at, r.id]);
    return c.json({ items: p.items.map(toStatement), next_cursor: p.next_cursor });
  });

  api.get("/projects/:p/statements/:id", async (c) => c.json(await statementSummary(c.env, await loadStatement(c, "viewer"))));

  api.get("/projects/:p/statements/:id/rows", async (c) => {
    const s = await loadStatement(c, "viewer");
    const filter = c.req.query("filter") || "all";
    const limit = parseLimit(c.req.query("limit"), 100, 500);
    const cur = decodeCursor(c.req.query("cursor"));
    if (filter === "missing") {
      if (s.period_from === null) return c.json({ items: [], next_cursor: null });
      const rows = await c.env.DB.prepare(
        `SELECT p.attempt_id, p.order_id, p.gateway, p.amount_paisa, p.status, p.finished_at, p.provider_ref FROM payments p WHERE ${MISSING_WHERE}
         ${cur ? "AND (p.finished_at, p.attempt_id) > (?6, ?7)" : ""} ORDER BY p.finished_at, p.attempt_id LIMIT ${limit + 1}`,
      )
        .bind(s.project_id, s.env, s.gateway, s.period_from, s.period_to, ...(cur ?? []))
        .all<MissingSettlement>();
      return c.json(page(rows.results, limit, (r) => [r.finished_at ?? 0, r.attempt_id]));
    }
    const where = ROW_FILTERS[filter];
    if (!where) throw badRequest("filter must be all, matched, unmatched, missing, mismatch or errors");
    const rows = await c.env.DB.prepare(
      `SELECT r.*, p.order_id FROM statement_rows r LEFT JOIN payments p ON p.project_id = ?1 AND p.env = ?2 AND p.attempt_id = r.match_attempt_id
       WHERE r.statement_id = ?3 AND ${where} AND r.row > ?4 ORDER BY r.row LIMIT ?5`,
    )
      .bind(s.project_id, s.env, s.id, cur ? Number(cur[0]) : 0, limit + 1)
      .all<RowDb>();
    const p = page(rows.results, limit, (r) => [r.row]);
    return c.json({ items: p.items.map(toRow), next_cursor: p.next_cursor });
  });

  api.delete("/projects/:p/statements/:id", async (c) => {
    const s = await loadStatement(c, "admin");
    await c.env.DB.batch([c.env.DB.prepare("DELETE FROM statement_rows WHERE statement_id = ?").bind(s.id), c.env.DB.prepare("DELETE FROM statements WHERE id = ?").bind(s.id)]);
    return c.body(null, 204);
  });

  // ------------------------------------------------------------ mappings and presets
  api.get("/projects/:p/statement-mappings", async (c) => {
    const { project } = await requireProject(c, c.req.param("p"), "viewer");
    const rows = await c.env.DB.prepare("SELECT gateway, mapping, updated_at FROM statement_mappings WHERE project_id = ? ORDER BY gateway")
      .bind(project.id)
      .all<{ gateway: string; mapping: string; updated_at: number }>();
    return c.json({ saved: rows.results.map((r) => ({ gateway: r.gateway, mapping: parseJson(r.mapping, null), updated_at: r.updated_at })), presets: PRESETS });
  });

  api.put("/projects/:p/statement-mappings/:gateway", async (c) => {
    const { project } = await requireProject(c, c.req.param("p"), "admin");
    const gw = c.req.param("gateway").toLowerCase();
    if (!GATEWAY_RE.test(gw)) throw badRequest("bad gateway");
    const body = await readJson(c.req.raw);
    const m = parseMapping(body.mapping ?? body);
    if (!m) throw badRequest("mapping is required");
    await c.env.DB.prepare(
      "INSERT INTO statement_mappings (project_id, gateway, mapping, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (project_id, gateway) DO UPDATE SET mapping = excluded.mapping, updated_at = excluded.updated_at",
    )
      .bind(project.id, gw, JSON.stringify(m), now())
      .run();
    return c.json({ gateway: gw, mapping: m });
  });

  api.delete("/projects/:p/statement-mappings/:gateway", async (c) => {
    const { project } = await requireProject(c, c.req.param("p"), "admin");
    await c.env.DB.prepare("DELETE FROM statement_mappings WHERE project_id = ? AND gateway = ?").bind(project.id, c.req.param("gateway").toLowerCase()).run();
    return c.body(null, 204);
  });

  // ------------------------------------------------------------ fees
  api.get("/projects/:p/fees", async (c) => {
    const { project } = await requireProject(c, c.req.param("p"), "viewer");
    const rows = await c.env.DB.prepare("SELECT gateway, pct_bp, fixed_paisa FROM gateway_fees WHERE project_id = ? ORDER BY gateway").bind(project.id).all<GatewayFee>();
    return c.json({ items: rows.results, next_cursor: null });
  });

  api.put("/projects/:p/fees", async (c) => {
    const { project } = await requireProject(c, c.req.param("p"), "admin");
    const body = await readJson(c.req.raw);
    const gw = typeof body.gateway === "string" ? body.gateway.trim().toLowerCase() : "";
    if (!GATEWAY_RE.test(gw)) throw badRequest("gateway is required");
    const pct = body.pct_bp;
    const fixed = body.fixed_paisa ?? 0;
    if (!Number.isInteger(pct) || (pct as number) < 0 || (pct as number) > 10_000) throw badRequest("pct_bp must be an integer from 0 to 10000 (basis points: 150 = 1.5%)");
    if (!Number.isInteger(fixed) || (fixed as number) < 0 || (fixed as number) > 10_000_000) throw badRequest("fixed_paisa must be a non-negative integer");
    await c.env.DB.prepare(
      "INSERT INTO gateway_fees (project_id, gateway, pct_bp, fixed_paisa) VALUES (?, ?, ?, ?) ON CONFLICT (project_id, gateway) DO UPDATE SET pct_bp = excluded.pct_bp, fixed_paisa = excluded.fixed_paisa",
    )
      .bind(project.id, gw, pct, fixed)
      .run();
    const fee: GatewayFee = { gateway: gw, pct_bp: pct as number, fixed_paisa: fixed as number };
    return c.json(fee);
  });

  api.delete("/projects/:p/fees/:gateway", async (c) => {
    const { project } = await requireProject(c, c.req.param("p"), "admin");
    await c.env.DB.prepare("DELETE FROM gateway_fees WHERE project_id = ? AND gateway = ?").bind(project.id, c.req.param("gateway").toLowerCase()).run();
    return c.body(null, 204);
  });

  // ------------------------------------------------------------ exports
  api.get("/projects/:p/exports/transactions.csv", async (c) => {
    const { project } = await requireProject(c, c.req.param("p"), "viewer");
    const envName = parseEnv(c.req.query("env"));
    const t = now();
    const to = parseTime(c.req.query("to"), "to") ?? t;
    const from = parseTime(c.req.query("from"), "from") ?? to - 30 * DAY;
    if (from >= to) throw badRequest("from must be before to");
    if (to - from > 400 * DAY) throw badRequest("at most 400 days per export");
    const pays = await loadPayments(c.env, project.id, envName, from, to);
    return csvResponse(transactionsCsv(pays), `${project.slug}-${envName}-transactions-${nptDate(from)}-to-${nptDate(to - 1)}.csv`);
  });

  api.get("/projects/:p/exports/tally.csv", async (c) => {
    const { project } = await requireProject(c, c.req.param("p"), "viewer");
    const envName = parseEnv(c.req.query("env"));
    const m = monthParam(c);
    const [pays, notes] = await Promise.all([loadPayments(c.env, project.id, envName, m.from, m.to, true), loadCreditNotes(c.env, project.id, envName, m.from, m.to, now())]);
    return csvResponse(tallyCsv(pays, notes), `${project.slug}-${envName}-tally-${m.label}.csv`, TALLY_NOTE);
  });

  api.get("/projects/:p/exports/hamrokhata.csv", async (c) => {
    const { project } = await requireProject(c, c.req.param("p"), "viewer");
    const envName = parseEnv(c.req.query("env"));
    const m = monthParam(c);
    const [pays, notes] = await Promise.all([loadPayments(c.env, project.id, envName, m.from, m.to, true), loadCreditNotes(c.env, project.id, envName, m.from, m.to, now())]);
    return csvResponse(hamrokhataCsv(pays, notes), `${project.slug}-${envName}-hamrokhata-${m.label}.csv`, HAMROKHATA_NOTE);
  });

  api.get("/projects/:p/exports/credit-notes.csv", async (c) => {
    const { project } = await requireProject(c, c.req.param("p"), "viewer");
    const envName = parseEnv(c.req.query("env"));
    const m = monthParam(c);
    const notes = await loadCreditNotes(c.env, project.id, envName, m.from, m.to, now());
    return csvResponse(creditNotesCsv(notes), `${project.slug}-${envName}-credit-notes-${m.label}.csv`);
  });

  const year = async (c: Context<AppEnv>, csv: boolean) => {
    const { project } = await requireProject(c, c.req.param("p")!, "viewer");
    const envName = parseEnv(c.req.query("env"));
    const fy = c.req.query("fy");
    if (!fy) throw badRequest("fy is required, for example fy=2082-83");
    const s = await yearSummary(c.env, project.id, envName, fy, now());
    if (!s) throw badRequest("fy must be a Nepal fiscal year from 2080-81 to 2084-85, for example 2082-83");
    return csv ? csvResponse(yearSummaryCsv(s), `${project.slug}-${envName}-fy-${s.fy}.csv`) : c.json(s);
  };
  api.get("/projects/:p/exports/year-summary", (c) => year(c, false));
  api.get("/projects/:p/exports/year-summary.csv", (c) => year(c, true));
}

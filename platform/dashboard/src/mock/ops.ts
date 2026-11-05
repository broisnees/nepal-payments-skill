// Mock answers for the merchant operations API (SPEC-v2 sections 3 and 4): refunds, lookup, status links, action
// endpoint, doctor, statements, fees and exports. Shapes follow @paynp/shared ops.ts and finance.ts; data is seeded
// from the payments already in the mock db.
import {
  DOCTOR_CHECKS,
  DOCTOR_CODES,
  fiscalYear,
  newId,
  type ActionEndpoint,
  type ChecklistStep,
  type DoctorCode,
  type DoctorFinding,
  type DoctorReport,
  type Env,
  type GatewayFee,
  type LookupMatch,
  type LookupResult,
  type MissingSettlement,
  type Payment,
  type PaymentOps,
  type PaymentSummary,
  type RefundCase,
  type Statement,
  type StatementMapping,
  type StatementNeedsMapping,
  type StatementRow,
  type StatementSummary,
  type StoredEvent,
  type Verdict,
  type YearMonth,
  type YearRow,
  type YearSummary,
} from "@paynp/shared";
import { parseCsv } from "../lib/csv.ts";
import { NPT_OFFSET_MS, formatClock, formatDate, gatewayName, nptDateValue, nptMonthValue, nptStartOfDay } from "../lib/format.ts";
import { addTrace, type Bucket, type Db, type ProjectData } from "./db.ts";
import { seeded, trace } from "./gen.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const ME = "Sita Gurung";

interface Cust {
  name: string;
  phone: string | null;
  email: string | null;
}
interface StoredStatement {
  meta: Statement;
  rows: StatementRow[];
  missing: MissingSettlement[];
}
interface EnvState {
  customers: Map<string, Cust>;
  refunds: RefundCase[];
  endpoint: ActionEndpoint | null;
  doctor: DoctorFinding[];
  statements: StoredStatement[];
}

export interface MockRes {
  status: number;
  body?: unknown;
  raw?: string;
  headers?: Record<string, string>;
}
const ok = (body: unknown, status = 200): MockRes => ({ status, body });
const fail = (status: number, code: string, message: string): MockRes => ({ status, body: { error: { code, message } } });

const NAMES = ["Sujata Tamang", "Aarav Shrestha", "Bikram Adhikari", "Priya Maharjan", "Nabin KC", "Asmita Poudel", "Rohan Bajracharya", "Srijana Gurung", "Kiran Thapa", "Manisha Rai", "Dipesh Karki", "Sabina Lama", "Prakash Bhandari", "Anjali Joshi", "Suman Ghimire", "Rita Magar", "Hari Dahal", "Pooja Shahi", "Sanjay Basnet", "Elina Pradhan"];
const CUSTOMERS: Cust[] = NAMES.map((name, i) => {
  const [f, l] = name.toLowerCase().split(" ");
  return {
    name,
    phone: i === 0 ? "9841234567" : i % 7 === 3 ? null : `98${String(10_000_000 + ((i * 7_919_113) % 89_999_999)).padStart(8, "0")}`,
    email: i % 2 === 0 || i % 7 === 3 ? `${f}.${l}@gmail.com` : null,
  };
});

const maskPhone = (p: string) => `${p.slice(0, 2)}${"X".repeat(Math.max(0, p.length - 5))}${p.slice(-3)}`;
const maskEmail = (e: string) => `${e[0]}***@${e.split("@")[1]}`;
/** Phone normalisation from SPEC-v2 section 1. */
const normalisePhone = (raw: string) => raw.replace(/[\s-]/g, "").replace(/^\+?977/, "").replace(/^0/, "").replace(/\D/g, "");
const REFUND_API = new Set(["khalti"]);

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Same step ids and wording as worker/src/ops/checklist.ts. */
function checklist(gateway: string, hasEndpoint: boolean): ChecklistStep[] {
  const record: [string, ChecklistStep["kind"], string] = ["record", "manual", "Record the refund reference here"];
  const steps: [string, ChecklistStep["kind"], string][] =
    gateway === "khalti"
      ? hasEndpoint
        ? [["send", "action", "Send refund via your server"], ["confirm", "manual", "Check the refund shows in the Khalti merchant dashboard"], record]
        : [["dashboard", "manual", "Open the Khalti merchant dashboard"], ["find", "manual", "Find the transaction by its Khalti reference"], ["refund", "manual", "Refund it (full, or partial with the amount)"], record]
      : gateway === "esewa"
        ? [
            ["portal", "manual", "Refund in the eSewa merchant portal against the transaction, or email eSewa merchant support with the transaction id"],
            ["confirm", "manual", "Confirm with the eSewa status API: status FULL_REFUND or PARTIAL_REFUND"],
            record,
          ]
        : gateway === "fonepay"
          ? [["support", "manual", "Refund from the Fonepay merchant panel, or ask your bank, with the reference"], record]
          : [["support", "manual", `Ask ${gatewayName(gateway)} merchant support to refund the payment`], record];
  return steps.map(([id, kind, text]) => ({ id, text, kind, done_at: null, by: null }));
}

export function createOps(db: Db) {
  const state = new Map<string, { env: Record<Env, EnvState>; fees: GatewayFee[] }>();
  const now = Date.now();
  const fresh = (): EnvState => ({ customers: new Map(), refunds: [], endpoint: null, doctor: [], statements: [] });
  const of = (pd: ProjectData) => {
    let s = state.get(pd.project.id);
    if (!s) state.set(pd.project.id, (s = { env: { live: fresh(), test: fresh() }, fees: [] }));
    return s;
  };

  function customerOf(st: EnvState, attempt: string): Cust | null {
    let c = st.customers.get(attempt);
    if (!c) {
      const h = hash(attempt);
      // One payment in eight is a guest checkout that never passed a phone or email.
      c = h % 8 === 0 ? { name: "", phone: null, email: null } : CUSTOMERS[1 + (h % (CUSTOMERS.length - 1))];
      st.customers.set(attempt, c);
    }
    return c.phone || c.email ? c : null;
  }

  /** Adds the v2 columns to a payment row. Mutates: the mock db keeps one object per payment. */
  function decorate(pd: ProjectData, env: Env, p: Payment): Payment {
    const c = customerOf(of(pd).env[env], p.attempt_id);
    p.customer_mask = c ? (c.phone ? maskPhone(c.phone) : maskEmail(c.email!)) : null;
    p.refunded_paisa ??= 0;
    p.gw_env ??= env === "live" ? "production" : "sandbox";
    if (p.fulfil_count > 0 && p.finished_at) p.fulfilled_at ??= p.finished_at + 900;
    return p;
  }

  const summaryOf = (p: Payment): PaymentSummary => ({
    attempt_id: p.attempt_id,
    order_id: p.order_id,
    gateway: p.gateway,
    amount_paisa: p.amount_paisa,
    status: p.status,
    started_at: p.started_at,
    finished_at: p.finished_at,
    provider_ref: p.provider_ref,
    customer_mask: p.customer_mask ?? null,
    refunded_paisa: p.refunded_paisa ?? 0,
    fulfilled: p.fulfil_count > 0,
  });

  // ---------------------------------------------------------------- seed
  function nearestPaid(b: Bucket, ago: number, gateway?: string): Payment | undefined {
    const target = now - ago;
    let best: Payment | undefined;
    for (const p of b.payments) {
      if (p.status !== "paid" || !p.finished_at || (gateway && p.gateway !== gateway)) continue;
      if (!best || Math.abs(p.started_at - target) < Math.abs(best.started_at - target)) best = p;
    }
    return best;
  }

  function refundEvent(b: Bucket, p: Payment, at: number, amount: number, ref: string, reason: string) {
    const ev: StoredEvent = {
      id: newId("evt", at),
      type: "payment.refunded",
      attempt_id: p.attempt_id,
      order_id: p.order_id ?? undefined,
      gateway: p.gateway,
      ts: new Date(at).toISOString(),
      received_at: at + 300,
      amount_paisa: amount,
      status: amount >= (p.amount_paisa ?? 0) ? "refunded" : undefined,
      data: { refund_ref: ref || undefined, refund_reason: reason },
    };
    b.events.get(p.attempt_id)?.push(ev);
    p.refunded_paisa = (p.refunded_paisa ?? 0) + amount;
    if (p.refunded_paisa >= (p.amount_paisa ?? 0)) p.status = "refunded";
    p.updated_at = at;
  }

  function seedProject(pd: ProjectData, env: Env, seed: number) {
    const b = pd.env[env];
    const st = of(pd).env[env];
    if (!b.payments.length) return;
    const r = seeded(seed);
    const live = env === "live" && pd.project.id === "prj_storefront";
    if (live) st.endpoint = { env, url: "https://himalayanthreads.com.np/api/paynp/actions", secret: "pas_****", created_at: now - 20 * DAY, last_ok_at: now - 12 * DAY, last_error: null };

    const dup = (ago: number, gw: string, gw2 = gw, cust?: Cust) => {
      const first = nearestPaid(b, ago, gw);
      if (!first?.finished_at) return null;
      const start = first.finished_at + Math.round((1.5 + r() * 3) * MIN);
      const ev = trace({ r, start, env, gateway: gw2, orderId: first.order_id ?? "HT-0", amountPaisa: first.amount_paisa ?? 150_000, scenario: "paid", buyerMs: 25_000 });
      const second = addTrace(b, env, ev);
      // Same buyer: a double tap on Pay, or a second try after a slow return.
      const c = cust ?? CUSTOMERS[1 + (hash(first.attempt_id) % (CUSTOMERS.length - 1))];
      st.customers.set(first.attempt_id, c);
      st.customers.set(second.attempt_id, c);
      second.fulfil_count = 0;
      return { first: decorate(pd, env, first), second: decorate(pd, env, second) };
    };
    const mk = (pair: { first: Payment; second: Payment }, extra: Partial<RefundCase> = {}): RefundCase => {
      const t = pair.second.finished_at ?? now;
      return {
        id: newId("rfc", t),
        env,
        kind: "duplicate",
        status: "open",
        attempt_id: pair.second.attempt_id,
        related_attempt_id: pair.first.attempt_id,
        gateway: pair.second.gateway,
        amount_paisa: pair.second.amount_paisa ?? 0,
        reason: "same_order",
        checklist: checklist(pair.second.gateway, Boolean(st.endpoint)),
        refund_ref: null,
        action_id: null,
        created_at: t,
        updated_at: t,
        resolved_at: null,
        resolved_by: null,
        note: null,
        payment: null,
        related: null,
        can_send: false,
        has_refund_api: REFUND_API.has(pair.second.gateway),
        ...extra,
      };
    };

    if (live) {
      const a = dup(2 * HOUR, "esewa", "khalti", CUSTOMERS[0]);
      if (a) st.refunds.push(mk(a));
      const b1 = dup(26 * HOUR, "esewa");
      if (b1) {
        const c = mk(b1);
        c.checklist[0].done_at = c.created_at + 3 * HOUR;
        c.checklist[0].by = "Ramesh Thapa";
        c.note = "Emailed eSewa merchant support with the transaction code.";
        c.updated_at = c.checklist[0].done_at;
        st.refunds.push(c);
      }
      const c1 = dup(3 * DAY + 4 * HOUR, "khalti");
      if (c1) {
        const at = (c1.second.finished_at ?? now) + 40 * MIN;
        st.refunds.push(mk(c1, { status: "failed", action_id: "act_01JD3KHF2", updated_at: at, note: 'Send failed: Khalti refund failed: HTTP 401 {"detail":"Invalid token."}' }));
      }
      const d = dup(6 * DAY, "esewa");
      if (d) {
        const at = (d.second.finished_at ?? now) + 20 * HOUR;
        const c = mk(d, { status: "refunded", refund_ref: "RF0Q8K21", resolved_at: at, resolved_by: ME, updated_at: at, note: "eSewa support refunded it the next morning." });
        c.checklist.forEach((s, i) => Object.assign(s, { done_at: (d.second.finished_at ?? now) + (i + 1) * 6 * HOUR, by: ME }));
        refundEvent(b, d.second, at, d.second.amount_paisa ?? 0, "RF0Q8K21", "Duplicate payment");
        st.refunds.push(c);
      }
      const e = dup(9 * DAY, "fonepay");
      if (e) {
        const at = (e.second.finished_at ?? now) + 2 * HOUR;
        st.refunds.push(mk(e, { status: "dismissed", reason: "same_customer_amount", resolved_at: at, resolved_by: "Ramesh Thapa", updated_at: at, note: "Not a duplicate: she ordered a second shawl on purpose." }));
      }
      const f = dup(12 * DAY, "khalti");
      if (f) {
        const at = (f.second.finished_at ?? now) + 15 * MIN;
        const c = mk(f, { status: "refunded", refund_ref: "KH-RF-7Q2M", action_id: "act_01JC9P", resolved_at: at + 2_100, resolved_by: ME, updated_at: at + 2_100 });
        c.checklist[0].done_at = at + 2_100;
        c.checklist[0].by = ME;
        refundEvent(b, f.second, at + 2_100, f.second.amount_paisa ?? 0, "KH-RF-7Q2M", "Duplicate payment");
        st.refunds.push(c);
      }
      const g = nearestPaid(b, 5 * HOUR, "fonepay");
      if (g) {
        st.customers.set(g.attempt_id, CUSTOMERS[7]);
        decorate(pd, env, g);
        const t = now - 50 * MIN;
        st.refunds.push(mk({ first: g, second: g }, { kind: "customer_request", related_attempt_id: null, amount_paisa: Math.round((g.amount_paisa ?? 0) / 2), reason: "Returned one of two kurtas, wrong size", created_at: t, updated_at: t, id: newId("rfc", t) }));
      }
      // The buyer from the newest duplicate had also tried once before and canceled.
      const canceled = b.payments.find((p) => p.status === "canceled" && now - p.started_at < 30 * HOUR);
      if (canceled) st.customers.set(canceled.attempt_id, CUSTOMERS[0]);

      const finding = (code: DoctorCode, gateway: string | null, count: number, first: number, last: number, example: string | null, resolved: number | null = null): DoctorFinding => {
        const c = DOCTOR_CHECKS[code];
        return { code, severity: c.severity, gateway, title: c.title, why: c.why, fix: c.fix, docs_url: c.docs_url, count, first_seen: first, last_seen: last, example_attempt: example, resolved_at: resolved };
      };
      st.doctor = [
        finding("no_status_check_after_return", "khalti", 4, now - 2 * DAY, now - 3 * HOUR, nearestPaid(b, 3 * HOUR, "khalti")?.attempt_id ?? null),
        finding("no_reconcile", null, 3, now - 90 * MIN, now - 10 * MIN, b.payments.find((p) => p.status === "pending")?.attempt_id ?? null),
        finding("http_return_url", "esewa", 12, now - 9 * DAY, now - 8 * DAY, null, now - 8 * DAY + 2 * HOUR),
      ];
      of(pd).fees = [
        { gateway: "esewa", pct_bp: 150, fixed_paisa: 0 },
        { gateway: "khalti", pct_bp: 150, fixed_paisa: 0 },
        { gateway: "fonepay", pct_bp: 100, fixed_paisa: 0 },
      ];
      st.statements.push(buildStatement(pd, env, "esewa", "esewa-settlement-week-44.csv", now - 26 * HOUR, "preset"));
    }
    if (env === "test" && pd.project.id === "prj_storefront") {
      const a = dup(5 * HOUR, "khalti");
      if (a) st.refunds.push(mk(a));
      const c = DOCTOR_CHECKS.signature_failures;
      st.doctor = [
        { code: "signature_failures", severity: c.severity, gateway: "esewa", title: c.title, why: c.why, fix: c.fix, docs_url: c.docs_url, count: 5, first_seen: now - 6 * HOUR, last_seen: now - 5 * HOUR, example_attempt: b.payments.find((p) => p.last_reason === "bad_signature")?.attempt_id ?? null, resolved_at: null },
      ];
    }
  }

  // ---------------------------------------------------------------- statements
  function feeFor(pd: ProjectData, gateway: string, amount: number): number {
    const f = of(pd).fees.find((x) => x.gateway === gateway) ?? { pct_bp: 150, fixed_paisa: 0 };
    return Math.round((Math.abs(amount) * f.pct_bp) / 10_000) + f.fixed_paisa;
  }

  const PRESET_MAPPING: StatementMapping = { date: "Transaction Date", ref: "Reference Code", amount: "Amount", fee: "Service Charge", net: "Net Amount", status: "Status", settled_at: "Settlement Date", unit: "rupees" };

  function buildStatement(pd: ProjectData, env: Env, gateway: string, filename: string, at: number, source: Statement["mapping_source"], mapping: StatementMapping = PRESET_MAPPING): StoredStatement {
    const to = nptStartOfDay(now) - 1;
    const from = nptStartOfDay(now - 7 * DAY);
    const paid = pd.env[env].payments.filter((p) => p.gateway === gateway && (p.status === "paid" || p.status === "refunded") && p.started_at >= from && p.started_at <= to).reverse();
    const rows: StatementRow[] = [];
    const missing: MissingSettlement[] = [];
    const r = seeded(hash(filename));
    const row = (o: Partial<StatementRow>): StatementRow => ({ row: 0, kind: "payment", txn_at: null, ref: null, amount_paisa: null, fee_paisa: null, net_paisa: null, status: "COMPLETE", settled_at: null, match_attempt_id: null, match_kind: "none", paynp_amount_paisa: null, order_id: null, error: null, raw: [], ...o });
    for (const p of paid) {
      const amount = p.amount_paisa ?? 0;
      const x = r();
      if (x < 0.025 && missing.length < 4) {
        missing.push({ attempt_id: p.attempt_id, order_id: p.order_id, gateway: p.gateway, amount_paisa: amount, status: p.status, finished_at: p.finished_at, provider_ref: p.provider_ref });
        continue;
      }
      const amt = x > 0.985 ? amount - 1000 : amount;
      const fee = feeFor(pd, gateway, amt);
      const settled = nptStartOfDay((p.finished_at ?? 0) + DAY) + 11 * HOUR;
      rows.push(row({ txn_at: p.finished_at, ref: p.provider_ref, amount_paisa: amt, fee_paisa: fee, net_paisa: amt - fee, settled_at: settled, match_attempt_id: p.attempt_id, match_kind: r() < 0.94 ? "ref" : "amount_time", paynp_amount_paisa: amount, order_id: p.order_id }));
    }
    for (let i = 0; i < 2; i++) {
      const t = from + Math.round(r() * (to - from));
      const amt = [149_900, 52_000][i];
      const fee = feeFor(pd, gateway, amt);
      rows.push(row({ txn_at: t, ref: `000${["9QX2", "7LMA"][i]}`, amount_paisa: amt, fee_paisa: fee, net_paisa: amt - fee }));
    }
    rows.sort((a, z) => (a.txn_at ?? 0) - (z.txn_at ?? 0));
    rows.forEach((x, i) => {
      x.row = i + 2;
      x.raw = [x.txn_at ? nptDateValue(x.txn_at) : "", x.ref ?? "", ((x.amount_paisa ?? 0) / 100).toFixed(2), ((x.fee_paisa ?? 0) / 100).toFixed(2), ((x.net_paisa ?? 0) / 100).toFixed(2), x.status ?? ""];
    });
    return {
      meta: { id: newId("stm", at), env, gateway, filename, period_from: from, period_to: to, row_count: rows.length, uploaded_at: at, uploaded_by: ME, mapping, mapping_source: source, unverified_preset: source === "preset" },
      rows,
      missing,
    };
  }

  function summary(s: StoredStatement): StatementSummary {
    const sum = (xs: { amount_paisa: number | null }[]) => ({ count: xs.length, amount_paisa: xs.reduce((a, x) => a + (x.amount_paisa ?? 0), 0) });
    const matched = s.rows.filter((x) => x.match_attempt_id);
    const mismatch = matched.filter((x) => x.paynp_amount_paisa !== null && x.paynp_amount_paisa !== x.amount_paisa);
    const gross = s.rows.reduce((a, x) => a + Math.max(0, x.amount_paisa ?? 0), 0);
    const fees = s.rows.reduce((a, x) => a + (x.fee_paisa ?? 0), 0);
    const days = new Map<number, StatementSummary["per_day"][number]>();
    for (const x of s.rows) {
      const day = nptStartOfDay(x.txn_at ?? 0);
      const d = days.get(day) ?? { day, date: nptDateValue(day), gross_paisa: 0, refunds_paisa: 0, fees_paisa: 0, net_paisa: 0, matched: 0, unmatched: 0 };
      days.set(day, d);
      d.gross_paisa += x.amount_paisa ?? 0;
      d.fees_paisa += x.fee_paisa ?? 0;
      d.net_paisa += x.net_paisa ?? 0;
      if (x.match_attempt_id) d.matched++;
      else d.unmatched++;
    }
    return {
      ...s.meta,
      payments: sum(s.rows),
      refunds: { count: 0, amount_paisa: 0 },
      void: 0,
      errors: 0,
      matched: { ...sum(matched), by_ref: matched.filter((x) => x.match_kind === "ref").length, by_amount_time: matched.filter((x) => x.match_kind === "amount_time").length },
      not_in_paynp: sum(s.rows.filter((x) => !x.match_attempt_id)),
      missing_settlement: sum(s.missing),
      mismatch: { ...sum(mismatch), diff_paisa: mismatch.reduce((a, x) => a + ((x.amount_paisa ?? 0) - (x.paynp_amount_paisa ?? 0)), 0) },
      gross_paisa: gross,
      refunds_paisa: 0,
      fees_paisa: fees,
      net_paisa: gross - fees,
      effective_fee_rate: gross ? fees / gross : null,
      per_day: [...days.values()].sort((a, z) => a.day - z.day),
    };
  }

  const FIELD_RE: Record<"date" | "ref" | "amount" | "fee" | "net" | "status" | "settled_at", RegExp> = {
    date: /^(transaction |txn )?date( ?time)?$/i,
    ref: /^(reference( code| no)?|transaction (code|id)|ref( no| id)?|pidx|prn)$/i,
    amount: /^(transaction )?amount( \(rs\))?$|^total$/i,
    fee: /charge|fee|commission/i,
    net: /^net|settled amount/i,
    status: /^status$/i,
    settled_at: /settle(ment|d) date/i,
  };
  function guess(headers: string[]): Partial<StatementMapping> {
    const out: Partial<StatementMapping> = {};
    for (const [k, re] of Object.entries(FIELD_RE)) {
      const h = headers.find((x) => re.test(x.trim()));
      if (h) (out as Record<string, string>)[k] = h;
    }
    return out;
  }

  // ---------------------------------------------------------------- lookup
  const sameDay = (t: number) => nptStartOfDay(t) === nptStartOfDay(Date.now());
  const when = (t: number) => (sameDay(t) ? `at ${formatClock(t)}` : `on ${formatDate(t)} at ${formatClock(t)}`);
  function textOf(p: Payment, v: Verdict): string {
    const gw = gatewayName(p.gateway);
    const ref = p.provider_ref ? `, ref ${p.provider_ref}` : "";
    switch (v) {
      case "paid":
        return `Paid ${when(p.finished_at ?? p.updated_at)} via ${gw}${ref}.`;
      case "paid_duplicate":
        return `Paid a second time ${when(p.finished_at ?? p.updated_at)} via ${gw}${ref}.`;
      case "pending":
        return `Started ${when(p.started_at)} but not finished: the buyer never came back from ${gw}.`;
      case "refunded":
        return `Refunded. It was paid via ${gw}${ref}.`;
      case "canceled":
        return `Not paid: the buyer canceled on ${gw} ${when(p.updated_at)}.`;
      case "expired":
        return `Not paid: the ${gw} session expired before the buyer paid.`;
      case "failed":
        return `Not paid: ${gw} did not confirm it.`;
      default:
        return `Not clear yet: ${gw} has not given a final answer.`;
    }
  }

  // ---------------------------------------------------------------- exports
  const csv = (rows: (string | number | null | undefined)[][]) => rows.map((r) => r.map((v) => (v === null || v === undefined ? "" : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v))).join(",")).join("\n") + "\n";
  const rs = (p: number | null | undefined) => (p === null || p === undefined ? "" : (p / 100).toFixed(2));
  const file = (name: string, body: string): MockRes => ({ status: 200, raw: body, headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${name}"` } });
  const monthRange = (month: string): [number, number] => {
    const [y, m] = month.split("-").map(Number);
    return [Date.UTC(y, m - 1, 1) - NPT_OFFSET_MS, Date.UTC(y, m, 1) - NPT_OFFSET_MS - 1];
  };

  for (const pd of db.projects.values()) {
    seedProject(pd, "live", 41);
    seedProject(pd, "test", 42);
  }

  // ---------------------------------------------------------------- routes
  function ops(pd: ProjectData, env: Env, p: Payment): PaymentOps {
    const st = of(pd).env[env];
    const c = customerOf(st, p.attempt_id);
    const cases = st.refunds.filter((x) => x.attempt_id === p.attempt_id || x.related_attempt_id === p.attempt_id).map((x) => withPayments(pd, env, x));
    return {
      customer: c ? { mask: p.customer_mask ?? null, name: c.name || null } : null,
      refunded_paisa: p.refunded_paisa ?? 0,
      gw_env: p.gw_env ?? null,
      fulfilled_at: p.fulfilled_at ?? null,
      refund_cases: cases,
      duplicate_of: st.refunds.find((x) => x.kind === "duplicate" && x.attempt_id === p.attempt_id)?.related_attempt_id ?? null,
      duplicates: st.refunds.filter((x) => x.kind === "duplicate" && x.related_attempt_id === p.attempt_id).map((x) => x.attempt_id),
    };
  }
  function withPayments(pd: ProjectData, env: Env, c: RefundCase): RefundCase {
    const b = pd.env[env];
    const st = of(pd).env[env];
    const pay = (id: string | null) => (id && b.byId.get(id) ? summaryOf(decorate(pd, env, b.byId.get(id)!)) : null);
    return { ...c, payment: pay(c.attempt_id), related: pay(c.related_attempt_id), can_send: Boolean(st.endpoint) && REFUND_API.has(c.gateway), has_refund_api: REFUND_API.has(c.gateway) };
  }

  return {
    decorate,
    ops,
    handle(pd: ProjectData, env: Env, method: string, seg: string[], q: URLSearchParams, body: Record<string, unknown> | FormData): MockRes | Promise<MockRes> | null {
      const proj = of(pd);
      const st = proj.env[env];
      const b = pd.env[env];
      const json = body instanceof FormData ? {} : body;
      const sub = seg[2];
      const byId = (id: string) => (b.byId.get(id) ? decorate(pd, env, b.byId.get(id)!) : null);

      if (sub === "refunds") {
        const c = seg[3] ? st.refunds.find((x) => x.id === seg[3]) : undefined;
        if (method === "GET" && !seg[3]) {
          const statuses = q.get("status")?.split(",").filter(Boolean);
          const kind = q.get("kind");
          const list = st.refunds.filter((x) => (!statuses || statuses.includes(x.status)) && (!kind || x.kind === kind)).sort((a, z) => z.created_at - a.created_at);
          return ok({ items: list.map((x) => withPayments(pd, env, x)), next_cursor: null, open_count: st.refunds.filter((x) => ["open", "requested", "failed"].includes(x.status)).length });
        }
        if (method === "POST" && !seg[3]) {
          const p = byId(String(json.attempt_id ?? ""));
          if (!p) return fail(404, "not_found", "No payment with that attempt id");
          if (p.status !== "paid") return fail(409, "not_paid", "Only paid payments can be refunded");
          if (st.refunds.some((x) => x.attempt_id === p.attempt_id && ["open", "requested", "failed"].includes(x.status))) return fail(409, "exists", "This payment already has an open refund case");
          const t = Date.now();
          const nc: RefundCase = {
            id: newId("rfc", t),
            env,
            kind: "manual",
            status: "open",
            attempt_id: p.attempt_id,
            related_attempt_id: null,
            gateway: p.gateway,
            amount_paisa: Number(json.amount_paisa) || p.amount_paisa || 0,
            reason: String(json.reason ?? "") || null,
            checklist: checklist(p.gateway, Boolean(st.endpoint)),
            refund_ref: null,
            action_id: null,
            created_at: t,
            updated_at: t,
            resolved_at: null,
            resolved_by: null,
            note: null,
            payment: null,
            related: null,
            can_send: false,
            has_refund_api: false,
          };
          st.refunds.unshift(nc);
          return ok(withPayments(pd, env, nc), 201);
        }
        if (!c) return fail(404, "not_found", "No such refund case");
        if (method === "PATCH") {
          const t = Date.now();
          const step = c.checklist.find((s) => s.id === json.checklist_step_done);
          if (step) Object.assign(step, { done_at: t, by: ME });
          if (typeof json.refund_ref === "string" && json.refund_ref.trim()) {
            c.refund_ref = json.refund_ref.trim();
            const rec = c.checklist.find((s) => s.id === "record");
            if (rec && !rec.done_at) Object.assign(rec, { done_at: t, by: ME });
          }
          if (typeof json.note === "string") c.note = json.note.trim() || null;
          if (typeof json.status === "string") {
            c.status = json.status as RefundCase["status"];
            if (c.status === "refunded" || c.status === "dismissed") Object.assign(c, { resolved_at: t, resolved_by: ME });
            else Object.assign(c, { resolved_at: null, resolved_by: null });
            const p = byId(c.attempt_id);
            if (c.status === "refunded" && p && p.status === "paid") refundEvent(b, p, t, c.amount_paisa, c.refund_ref ?? "", c.kind === "duplicate" ? "Duplicate payment" : (c.reason ?? "Refund"));
          }
          c.updated_at = t;
          return ok(withPayments(pd, env, c));
        }
        if (method === "POST" && seg[4] === "send") {
          if (!st.endpoint) return fail(409, "no_action_endpoint", "Add an action endpoint in Settings first");
          if (!REFUND_API.has(c.gateway)) return fail(409, "no_refund_api", `${gatewayName(c.gateway)} has no refund API`);
          const t = Date.now();
          Object.assign(c, { status: "requested", action_id: newId("act", t), updated_at: t });
          // The API waits for the merchant's server and answers with the case; the mock server takes 2.5 s.
          return new Promise<MockRes>((res) =>
            setTimeout(() => {
              const done = Date.now();
              const ref = `KH-RF-${c.action_id!.slice(-4).toUpperCase()}`;
              Object.assign(c, { status: "refunded", refund_ref: ref, resolved_at: done, resolved_by: ME, updated_at: done });
              const s = c.checklist.find((x) => x.kind === "action");
              if (s) Object.assign(s, { done_at: done, by: ME });
              const p = byId(c.attempt_id);
              if (p) refundEvent(b, p, done, c.amount_paisa, ref, "Duplicate payment");
              res(ok({ case: withPayments(pd, env, c), action: { id: c.action_id, status: "ok", created_at: t, finished_at: done, response: { ok: true, refund_ref: ref } } }));
            }, 2500),
          );
        }
      }

      if (sub === "lookup" && method === "GET") {
        const raw = (q.get("q") ?? "").trim();
        const amountRs = q.get("amount");
        const amountPaisa = q.get("amount_paisa") ? Number(q.get("amount_paisa")) : amountRs ? Math.round(Number(amountRs.replace(/,/g, "")) * 100) : null;
        const from = Number(q.get("from")) || null;
        const to = Number(q.get("to")) || null;
        let kind: LookupResult["query"]["kind"] = "none";
        let match: (p: Payment) => LookupMatch["matched_by"] = () => [];
        if (raw) {
          const digits = normalisePhone(raw);
          const lower = raw.toLowerCase();
          if (/^9\d{9}$/.test(digits) && /^[+\d\s-]+$/.test(raw)) {
            kind = "phone";
            match = (p) => (customerOf(st, p.attempt_id)?.phone === digits ? ["phone"] : []);
          } else if (raw.includes("@")) {
            kind = "email";
            match = (p) => (customerOf(st, p.attempt_id)?.email === lower ? ["email"] : []);
          } else {
            kind = "ref";
            const refundRefs = new Map(st.refunds.filter((c) => c.refund_ref).map((c) => [c.refund_ref!.toLowerCase(), c.attempt_id]));
            match = (p) => (p.attempt_id.toLowerCase() === lower ? ["attempt"] : (p.order_id ?? "").toLowerCase() === lower ? ["order"] : (p.provider_ref ?? "").toLowerCase() === lower || refundRefs.get(lower) === p.attempt_id ? ["ref"] : []);
          }
        } else if (amountPaisa === null) return fail(400, "invalid", "Search by phone, email, a reference, or an amount");
        const dupOf = new Map(st.refunds.filter((c) => c.kind === "duplicate").map((c) => [c.attempt_id, c.related_attempt_id]));
        const items: LookupMatch[] = [];
        for (const p of b.payments) {
          if (items.length >= 50) break;
          if ((from && p.started_at < from) || (to && p.started_at > to)) continue;
          if (amountPaisa !== null && p.amount_paisa !== amountPaisa) continue;
          const by = raw ? match(p) : [];
          if (raw && !by.length) continue;
          if (amountPaisa !== null) by.push("amount");
          const d = decorate(pd, env, p);
          const v: Verdict = p.status === "paid" ? (dupOf.has(p.attempt_id) ? "paid_duplicate" : "paid") : p.status === "initiated" || p.status === "pending" ? "pending" : p.status;
          items.push({ payment: summaryOf(d), verdict: v, text: textOf(d, v), fulfilled: d.fulfil_count > 0, matched_by: by, duplicate_of: dupOf.get(p.attempt_id) ?? null });
        }
        const result: LookupResult = { query: { q: raw || null, kind, amount_paisa: amountPaisa, from, to }, items };
        return ok(result);
      }

      if (sub === "payments" && seg[4] === "status-link" && method === "POST") {
        const p = byId(decodeURIComponent(seg[3] ?? ""));
        if (!p) return fail(404, "not_found", "No payment with that attempt id");
        const days = Number(json.expires_days) || 7;
        const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), (x) => "abcdefghijkmnpqrstuvwxyz23456789"[x % 32]).join("");
        return ok({ url: `${location.origin}/s/${token}`, expires_at: Date.now() + days * DAY }, 201);
      }
      if (sub === "payments" && seg[4] === "ops" && method === "GET") {
        const p = byId(decodeURIComponent(seg[3] ?? ""));
        return p ? ok(ops(pd, env, p)) : fail(404, "not_found", "No payment with that attempt id");
      }

      if (sub === "action-endpoint") {
        if (method === "GET") return st.endpoint ? ok({ ...st.endpoint, secret: "pas_****" }) : fail(404, "not_found", "No action endpoint");
        if (method === "PUT") {
          const url = String(json.url ?? "").trim();
          if (!/^https:\/\/[^\s/]+/.test(url) && !/^http:\/\/localhost/.test(url)) return fail(400, "invalid_url", "Use an https URL your server answers on");
          const keep = st.endpoint && json.rotate !== true;
          const secret = `pas_${Array.from(crypto.getRandomValues(new Uint8Array(28)), (x) => "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789"[x % 56]).join("")}`;
          const created = st.endpoint?.created_at ?? Date.now();
          st.endpoint = { env, url, secret: "pas_****", created_at: created, last_ok_at: st.endpoint?.last_ok_at ?? null, last_error: null };
          if (keep) return ok({ ...st.endpoint });
          for (const c of st.refunds) if (c.status === "open") c.checklist = checklist(c.gateway, true).map((s, i) => ({ ...s, done_at: c.checklist[i]?.done_at ?? null, by: c.checklist[i]?.by ?? null }));
          return ok({ ...st.endpoint, secret }, 201);
        }
        if (method === "DELETE") {
          st.endpoint = null;
          return { status: 204 };
        }
        if (method === "POST" && seg[3] === "test") {
          if (!st.endpoint) return fail(409, "no_action_endpoint", "Add an action endpoint first");
          return new Promise((res) =>
            setTimeout(() => {
              const ep = st.endpoint!;
              const t = Date.now();
              const rec = (good: boolean) => ({ id: newId("act", t), env, kind: "ping", attempt_id: "", status: good ? "ok" : "failed", payload: null, response: good ? { ok: true, http_status: 200 } : { ok: false, error: "fetch failed: connection refused" }, created_at: t - 214, finished_at: t, requested_by: ME });
              if (ep.url.includes("localhost")) {
                ep.last_error = "fetch failed: connection refused";
                res({ status: 502, body: rec(false) });
              } else {
                ep.last_ok_at = t;
                ep.last_error = null;
                res(ok(rec(true)));
              }
            }, 700),
          );
        }
      }

      if (sub === "doctor") {
        if (method === "GET") {
          const open = st.doctor.filter((f) => !f.resolved_at).sort((a, z) => (a.severity === z.severity ? z.last_seen - a.last_seen : a.severity === "critical" ? -1 : 1));
          const found = new Set(open.map((f) => f.code));
          const report: DoctorReport = {
            env,
            critical: open.filter((f) => f.severity === "critical").length,
            warnings: open.filter((f) => f.severity === "warning").length,
            findings: open,
            passed: DOCTOR_CODES.filter((c) => !found.has(c)).map((code) => {
              const c = DOCTOR_CHECKS[code];
              const skip = env === "test" && c.live_only;
              return { code, severity: c.severity, title: c.title, status: skip ? "not_checked" : "passed", line: skip ? "Runs on live traffic only." : c.passed };
            }),
          };
          return ok(report);
        }
        if (method === "POST" && seg[4] === "resolve") {
          const gw = typeof json.gateway === "string" ? json.gateway : null;
          for (const f of st.doctor) if (f.code === seg[3] && (!gw || f.gateway === gw)) f.resolved_at = Date.now();
          return { status: 204 };
        }
      }

      if (sub === "fees") {
        if (method === "GET") return ok({ items: proj.fees, next_cursor: null });
        if (method === "PUT") {
          const gateway = String(json.gateway ?? "");
          const fee = { gateway, pct_bp: Math.max(0, Math.round(Number(json.pct_bp) || 0)), fixed_paisa: Math.max(0, Math.round(Number(json.fixed_paisa) || 0)) };
          proj.fees = [...proj.fees.filter((f) => f.gateway !== gateway), fee];
          return ok(fee);
        }
      }

      if (sub === "statements") {
        const s = seg[3] ? st.statements.find((x) => x.meta.id === seg[3]) : undefined;
        if (method === "GET" && !seg[3]) return ok({ items: st.statements.map((x) => x.meta).sort((a, z) => z.uploaded_at - a.uploaded_at), next_cursor: null });
        if (method === "POST" && !seg[3]) {
          if (!(body instanceof FormData)) return fail(400, "invalid", "Send the statement as multipart form data");
          const f = body.get("file");
          const gateway = String(body.get("gateway") ?? "esewa");
          if (!(f instanceof File)) return fail(400, "invalid", "Attach a CSV file");
          if (!/\.csv$/i.test(f.name)) return fail(415, "unsupported", "Only CSV files for now. In Excel, save the statement as CSV first.");
          if (f.size > 5 * 1024 * 1024) return fail(413, "too_large", "The file is over 5 MB");
          return f.text().then((text) => {
            const rows = parseCsv(text, 8);
            const headers = rows[0] ?? [];
            const sent = body.get("mapping");
            const g = guess(headers);
            const missing = (["date", "ref", "amount"] as const).filter((k) => !g[k]);
            if (!sent && missing.length) {
              const need: StatementNeedsMapping = { error: { code: "mapping_required", message: "These columns did not match a known statement layout" }, headers, header_row: 0, sample: rows.slice(1, 6), mapping: g, missing };
              return { status: 422, body: need };
            }
            // The mock does not read the uploaded rows: it settles the last week of this gateway's payments.
            const stored = buildStatement(pd, env, gateway, f.name, Date.now(), sent ? "request" : "preset", sent ? (JSON.parse(String(sent)) as StatementMapping) : { ...PRESET_MAPPING, ...g } as StatementMapping);
            st.statements.unshift(stored);
            return ok(summary(stored), 201);
          });
        }
        if (!s) return fail(404, "not_found", "No such statement");
        if (method === "DELETE") {
          st.statements = st.statements.filter((x) => x !== s);
          return { status: 204 };
        }
        if (method === "GET" && seg[4] === "rows") {
          const filter = q.get("filter") ?? "all";
          if (filter === "missing") return ok({ items: s.missing, next_cursor: null });
          const list =
            filter === "unmatched"
              ? s.rows.filter((x) => !x.match_attempt_id)
              : filter === "mismatch"
                ? s.rows.filter((x) => x.match_attempt_id && x.paynp_amount_paisa !== x.amount_paisa)
                : filter === "matched"
                  ? s.rows.filter((x) => x.match_attempt_id)
                  : s.rows;
          return ok({ items: list, next_cursor: null });
        }
        if (method === "GET") return ok(summary(s));
      }

      if (sub === "exports" && method === "GET") {
        const name = seg[3] ?? "";
        const month = q.get("month") ?? nptMonthValue(Date.now());
        const [from, to] = q.get("from") ? [Number(q.get("from")), Number(q.get("to")) || Date.now()] : monthRange(month);
        const inRange = b.payments.filter((p) => p.started_at >= from && p.started_at <= to).map((p) => decorate(pd, env, p));
        const paid = inRange.filter((p) => p.status === "paid" || p.status === "refunded").reverse();
        const refunds = st.refunds.filter((c) => c.status === "refunded" && (c.resolved_at ?? 0) >= from && (c.resolved_at ?? 0) <= to);
        const day = (t: number) => nptDateValue(t);
        if (name === "transactions.csv") {
          const tag = q.get("from") ? `${day(from)}_${day(to)}` : month;
          return file(
            `paynp-transactions-${tag}.csv`,
            csv([
              ["date_npt", "attempt_id", "order_id", "gateway", "provider_ref", "status", "amount", "refunded", "fee", "net"],
              ...inRange.reverse().map((p) => {
                const fee = p.status === "paid" ? feeFor(pd, p.gateway, p.amount_paisa ?? 0) : null;
                return [day(p.started_at), p.attempt_id, p.order_id, gatewayName(p.gateway), p.provider_ref, p.status, rs(p.amount_paisa), rs(p.refunded_paisa ?? 0), rs(fee), fee === null ? "" : rs((p.amount_paisa ?? 0) - fee)];
              }),
            ]),
          );
        }
        if (name === "tally.csv")
          return file(
            `paynp-tally-${month}.csv`,
            csv([
              ["Date", "Voucher Type", "Ledger", "Debit", "Credit", "Narration"],
              ...paid.flatMap((p) => [
                [day(p.finished_at ?? p.started_at), "Receipt", `${gatewayName(p.gateway)} Receipts`, rs(p.amount_paisa), "", `Order ${p.order_id ?? ""} ref ${p.provider_ref ?? ""}`],
                [day(p.finished_at ?? p.started_at), "Journal", "Payment Gateway Charges", rs(feeFor(pd, p.gateway, p.amount_paisa ?? 0)), "", `${gatewayName(p.gateway)} fee on ${p.order_id ?? p.attempt_id}`],
              ]),
              ...refunds.map((c) => [day(c.resolved_at!), "Credit Note", "Sales Returns", "", rs(c.amount_paisa), `Refund ${c.refund_ref ?? ""}`]),
            ]),
          );
        if (name === "hamrokhata.csv") return file(`paynp-hamrokhata-${month}.csv`, csv([["date", "invoice_no", "payment_mode", "amount", "reference"], ...paid.map((p) => [day(p.finished_at ?? p.started_at), p.order_id, gatewayName(p.gateway), rs(p.amount_paisa), p.provider_ref])]));
        if (name === "credit-notes.csv")
          return file(
            `paynp-credit-notes-${month}.csv`,
            csv([["credit_note_no", "original_attempt", "original_order", "date", "amount", "reason", "refund_ref"], ...refunds.map((c, i) => [`CN-${month.replace("-", "")}-${String(i + 1).padStart(4, "0")}`, c.attempt_id, byId(c.attempt_id)?.order_id, day(c.resolved_at!), rs(c.amount_paisa), c.reason, c.refund_ref])]),
          );
        if (name === "year-summary" || name === "year-summary.csv") {
          const fy = fiscalYear(q.get("fy") ?? "2083-84");
          if (!fy) return fail(400, "invalid_fy", "Use a fiscal year like 2083-84");
          const zero = () => ({ count: 0, gross_paisa: 0, refunds_paisa: 0, fees_paisa: 0, fees_actual_paisa: 0, fees_estimated_paisa: 0, net_paisa: 0 });
          const gws = new Map<string, YearRow>();
          const months: YearMonth[] = fy.months.map((m) => ({ ...m, ...zero(), gateways: [] }));
          const settled = new Map<string, number>();
          for (const s of st.statements) for (const x of s.rows) if (x.match_attempt_id) settled.set(x.match_attempt_id, x.fee_paisa ?? 0);
          for (const p of b.payments) {
            if (p.started_at < fy.from || p.started_at >= fy.to || (p.status !== "paid" && p.status !== "refunded")) continue;
            const d = decorate(pd, env, p);
            const g = gws.get(p.gateway) ?? { gateway: p.gateway, ...zero() };
            gws.set(p.gateway, g);
            const m = months.find((x) => p.started_at >= x.from && p.started_at < x.to)!;
            let mg = m.gateways.find((x) => x.gateway === p.gateway);
            if (!mg) m.gateways.push((mg = { gateway: p.gateway, ...zero() }));
            const actual = settled.get(p.attempt_id);
            const fee = actual ?? feeFor(pd, p.gateway, p.amount_paisa ?? 0);
            for (const x of [g, m, mg]) {
              x.count++;
              x.gross_paisa += p.amount_paisa ?? 0;
              x.refunds_paisa += d.refunded_paisa ?? 0;
              x.fees_paisa += fee;
              if (actual === undefined) x.fees_estimated_paisa += fee;
              else x.fees_actual_paisa += fee;
              x.net_paisa += (p.amount_paisa ?? 0) - (d.refunded_paisa ?? 0) - fee;
            }
          }
          const gateways = [...gws.values()].sort((a, z) => z.gross_paisa - a.gross_paisa);
          const totals = gateways.reduce((t, x) => {
            const { gateway: _g, ...rest } = x;
            void _g;
            for (const k of Object.keys(rest) as (keyof typeof rest)[]) t[k] += rest[k];
            return t;
          }, zero());
          const out: YearSummary = { fy: fy.fy, env, from: fy.from, to: fy.to, from_date: day(fy.from), to_date: day(fy.to - 1), gateways, months, totals };
          if (name.endsWith(".csv")) return file(`paynp-year-summary-${fy.fy}.csv`, csv([["gateway", "payments", "gross", "refunds", "fees", "net"], ...gateways.map((g) => [gatewayName(g.gateway), g.count, rs(g.gross_paisa), rs(g.refunds_paisa), rs(g.fees_paisa), rs(g.net_paisa)])]));
          return ok(out);
        }
      }
      return null;
    },
  };
}

export type Ops = ReturnType<typeof createOps>;

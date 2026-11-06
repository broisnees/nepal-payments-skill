import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { newId, type PaymentEvent, type StatementSummary, type YearSummary } from "@paynp/shared";
import { beforeAll, describe, expect, it } from "vitest";
import worker from "../src/index.ts";
import { BASE, call, ingest, json, setup, type Setup } from "./helpers.ts";

const at = (iso: string) => new Date(`${iso}+05:45`).toISOString();
const e = (type: PaymentEvent["type"], attempt: string, iso: string, extra: Partial<PaymentEvent> = {}): PaymentEvent => ({
  id: newId("evt"),
  type,
  ts: at(iso),
  attempt_id: attempt,
  gateway: "esewa",
  ...extra,
});
const paid = (id: string, gateway: string, amount: number, order: string, start: string, end: string, ref?: string) => [
  e("payment.started", id, start, { gateway, amount_paisa: amount, order_id: order, status: "initiated" }),
  e("status.changed", id, end, { gateway, data: { to: "paid", ...(ref ? { provider_ref: ref } : {}) } }),
];

/** The fixture month: July 2025 (Shrawan 2082 starts 17 July). */
async function fixture(s: Setup) {
  const events = [
    ...paid("fx-p1", "esewa", 150000, "O-1", "2025-07-17T10:00:00", "2025-07-17T10:00:30", "0LD5CEH"),
    ...paid("fx-p2", "esewa", 250000, "O-2", "2025-07-18T09:00:00", "2025-07-18T09:01:00", "0LD5XYZ"),
    ...paid("fx-p3", "khalti", 100000, "O-3", "2025-07-18T12:00:00", "2025-07-18T12:00:20", "PIDX3"),
    e("payment.started", "fx-p4", "2025-07-19T08:00:00", { amount_paisa: 50000, order_id: "O-4", status: "initiated" }),
    e("status.changed", "fx-p4", "2025-07-19T08:00:40", { data: { to: "failed", reason: "canceled_by_user" } }),
    ...paid("fx-p6", "esewa", 30000, "O-6", "2025-07-19T10:00:00", "2025-07-19T10:00:10", "0LD6AAA"),
  ];
  expect((await ingest(s.key, events)).status).toBe(202);
  const more = [
    e("payment.refunded", "fx-p1", "2025-07-20T15:00:00", { amount_paisa: 50000, data: { refund_ref: "RF-1", refund_reason: "customer cancelled" } }),
    ...paid("fx-p5", "esewa", 70000, "O-5", "2025-07-21T08:00:00", "2025-07-21T08:02:00"),
  ];
  expect((await ingest(s.key, more)).status).toBe(202);
  expect((await call("PUT", `/api/projects/${s.projectId}/fees`, { cookie: s.cookie, body: { gateway: "khalti", pct_bp: 300, fixed_paisa: 0 } })).status).toBe(200);
}

const ESEWA_CSV = [
  "Transaction Date,Reference Code,Product ID,Amount,Service Charge,Net Amount,Status",
  '2025-07-17 10:00:31,0LD5CEH,O-1,"1,500.00",30.00,"1,470.00",COMPLETE',
  '2025-07-18 09:01:10,0LD5XYZ,O-2,"2,400.00",48.00,"2,352.00",COMPLETE',
  "2025-07-20 15:02:00,0LD5CEH,O-1,-500.00,,,PARTIAL_REFUND",
  "2025-07-21 08:03:00,,,700.00,14.00,686.00,COMPLETE",
  "2025-07-21 09:00:00,UNKNOWN1,,999.00,20.00,979.00,COMPLETE",
  "2025-07-21 10:00:00,FAILEDX,,100.00,,,FAILED",
].join("\r\n");

async function upload(s: Setup, fields: Record<string, string>, csv: string, name = "statement.csv", envName = "live") {
  const form = new FormData();
  form.set("file", new File([csv], name, { type: name.endsWith(".csv") ? "text/csv" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  const req = new Request(`${BASE}/api/projects/${s.projectId}/statements?env=${envName}`, {
    method: "POST",
    headers: { cookie: s.cookie, "x-paynp-csrf": "1" },
    body: form,
  });
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

const get = (s: Setup, path: string) => call("GET", `/api/projects/${s.projectId}${path}`, { cookie: s.cookie });

describe("settlement statements", () => {
  let s: Setup;
  let summary: StatementSummary;
  beforeAll(async () => {
    s = await setup("live");
    await fixture(s);
  });

  it("uploads an eSewa CSV with the unverified preset, matches by ref and by amount+time, and summarises", async () => {
    const res = await upload(s, { gateway: "esewa" }, ESEWA_CSV);
    expect(res.status).toBe(201);
    summary = await res.json();
    expect(summary).toMatchObject({
      gateway: "esewa",
      env: "live",
      row_count: 6,
      mapping_source: "preset",
      unverified_preset: true,
      payments: { count: 4, amount_paisa: 559900 },
      refunds: { count: 1, amount_paisa: 50000 },
      void: 1,
      errors: 0,
      matched: { count: 4, amount_paisa: 410000, by_ref: 3, by_amount_time: 1 },
      not_in_paynp: { count: 1, amount_paisa: 99900 },
      missing_settlement: { count: 1, amount_paisa: 30000 },
      mismatch: { count: 1, amount_paisa: 240000, diff_paisa: -10000 },
      gross_paisa: 559900,
      refunds_paisa: 50000,
      fees_paisa: 11200,
      net_paisa: 498700,
    });
    expect(summary.effective_fee_rate).toBeCloseTo(11200 / 559900, 10);
    expect(summary.period_from).toBe(Date.parse(at("2025-07-17T10:00:31")));
    expect(summary.per_day.map((d) => [d.date, d.gross_paisa, d.refunds_paisa, d.matched, d.unmatched])).toEqual([
      ["2025-07-17", 150000, 0, 1, 0],
      ["2025-07-18", 240000, 0, 1, 0],
      ["2025-07-20", 0, 50000, 1, 0],
      ["2025-07-21", 169900, 0, 1, 1],
    ]);
  });

  it("lists rows by filter: unmatched, mismatch, matched, missing", async () => {
    const un = await json(get(s, `/statements/${summary.id}/rows?filter=unmatched`));
    expect(un.items.map((r: any) => [r.row, r.ref, r.amount_paisa])).toEqual([[6, "UNKNOWN1", 99900]]);
    const mm = await json(get(s, `/statements/${summary.id}/rows?filter=mismatch`));
    expect(mm.items).toHaveLength(1);
    expect(mm.items[0]).toMatchObject({ row: 3, match_attempt_id: "fx-p2", match_kind: "ref", paynp_amount_paisa: 250000, order_id: "O-2" });
    const matched = await json(get(s, `/statements/${summary.id}/rows?filter=matched`));
    expect(matched.items.map((r: any) => [r.row, r.kind, r.match_attempt_id, r.match_kind])).toEqual([
      [2, "payment", "fx-p1", "ref"],
      [3, "payment", "fx-p2", "ref"],
      [4, "refund", "fx-p1", "ref"],
      [5, "payment", "fx-p5", "amount_time"],
    ]);
    expect(matched.items[0].raw).toEqual(["2025-07-17 10:00:31", "0LD5CEH", "O-1", "1,500.00", "30.00", "1,470.00", "COMPLETE"]);
    const missing = await json(get(s, `/statements/${summary.id}/rows?filter=missing`));
    expect(missing.items).toEqual([
      { attempt_id: "fx-p6", order_id: "O-6", gateway: "esewa", amount_paisa: 30000, status: "paid", finished_at: Date.parse(at("2025-07-19T10:00:10")), provider_ref: "0LD6AAA" },
    ]);
    const page1 = await json(get(s, `/statements/${summary.id}/rows?limit=4`));
    expect(page1.items).toHaveLength(4);
    const page2 = await json(get(s, `/statements/${summary.id}/rows?limit=4&cursor=${page1.next_cursor}`));
    expect(page2.items.map((r: any) => r.row)).toEqual([6, 7]);
    expect((await get(s, `/statements/${summary.id}/rows?filter=bogus`)).status).toBe(400);
  });

  it("lists and deletes statements; viewers can read but not upload", async () => {
    const list = await json(get(s, "/statements?env=live"));
    expect(list.items.map((x: any) => x.id)).toContain(summary.id);
    const other = await upload(s, { gateway: "esewa" }, ESEWA_CSV);
    const id = (await other.json<StatementSummary>()).id;
    expect((await call("DELETE", `/api/projects/${s.projectId}/statements/${id}`, { cookie: s.cookie })).status).toBe(204);
    expect((await get(s, `/statements/${id}`)).status).toBe(404);
    const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM statement_rows WHERE statement_id = ?").bind(id).first<{ n: number }>();
    expect(rows!.n).toBe(0);
  });

  it("deleting the project removes its statements, rows, mappings, fees and credit notes", async () => {
    const own = await setup();
    const up = await upload(own, { gateway: "esewa" }, ESEWA_CSV);
    const stmt = (await up.json<StatementSummary>()).id;
    await call("PUT", `/api/projects/${own.projectId}/fees`, { cookie: own.cookie, body: { gateway: "esewa", pct_bp: 150, fixed_paisa: 0 } });
    await env.DB.prepare("INSERT INTO statement_mappings (project_id, gateway, mapping, updated_at) VALUES (?, 'khalti', '{}', 0)").bind(own.projectId).run();
    await env.DB.prepare(
      "INSERT INTO credit_notes (project_id, env, refund_key, attempt_id, gateway, month, seq, refunded_at, amount_paisa, created_at) VALUES (?, 'live', 'k1', 'a1', 'esewa', '2025-07', 1, 0, 100, 0)",
    ).bind(own.projectId).run();
    expect((await call("DELETE", `/api/projects/${own.projectId}`, { cookie: own.cookie })).status).toBe(204);
    for (const t of ["statements", "statement_mappings", "gateway_fees", "credit_notes"]) {
      const r = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE project_id = ?`).bind(own.projectId).first<{ n: number }>();
      expect(r!.n, t).toBe(0);
    }
    const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM statement_rows WHERE statement_id = ?").bind(stmt).first<{ n: number }>();
    expect(rows!.n).toBe(0);
  });

  it("asks for a mapping (422) when no preset fits, then saves the mapping per project and gateway", async () => {
    const csv = "Khalti merchant export\nWhen,Txn Ref,Rupees,Cut\n2025-07-18 12:00:25,PIDX3,1000,30\n";
    const r1 = await upload(s, { gateway: "khalti" }, csv);
    expect(r1.status).toBe(422);
    const body = await r1.json<any>();
    expect(body).toMatchObject({ error: { code: "mapping_required" }, headers: ["When", "Txn Ref", "Rupees", "Cut"], header_row: 1, sample: [["2025-07-18 12:00:25", "PIDX3", "1000", "30"]] });
    const mapping = { date: "When", ref: "Txn Ref", amount: "Rupees", fee: "Cut" };
    const r2 = await upload(s, { gateway: "khalti", mapping: JSON.stringify(mapping) }, csv);
    expect(r2.status).toBe(201);
    expect(await r2.json()).toMatchObject({ mapping_source: "request", unverified_preset: false, matched: { count: 1, by_ref: 1 }, fees_paisa: 3000 });
    const saved = await json(get(s, "/statement-mappings"));
    expect(saved.saved).toEqual([{ gateway: "khalti", mapping: { ...mapping, header_row: 1 }, updated_at: expect.any(Number) }]);
    expect(saved.presets.map((p: any) => p.gateway)).toEqual(["esewa", "khalti", "fonepay", "*"]);
    const r3 = await upload(s, { gateway: "khalti" }, csv);
    expect(r3.status).toBe(201);
    expect(await r3.json()).toMatchObject({ mapping_source: "saved" });
    // A mapping naming a missing column is a 422 with the reason.
    const r4 = await upload(s, { gateway: "khalti", mapping: JSON.stringify({ ...mapping, fee: "Nope" }) }, csv);
    expect(r4.status).toBe(422);
    expect((await r4.json<any>()).error.message).toContain('fee ("Nope")');
    // Clean up the extra statements so the exports below see one khalti fee source.
    for (const st of (await json(get(s, "/statements?env=live&gateway=khalti"))).items) await call("DELETE", `/api/projects/${s.projectId}/statements/${st.id}`, { cookie: s.cookie });
  });

  it("refuses non-CSV files, bad mappings, oversized uploads and missing gateways", async () => {
    const x = await upload(s, { gateway: "esewa" }, "x", "statement.xlsx");
    expect(x.status).toBe(400);
    expect((await x.json<any>()).error.code).toBe("unsupported_format");
    expect((await upload(s, {}, ESEWA_CSV)).status).toBe(400);
    expect((await upload(s, { gateway: "esewa", mapping: "{not json" }, ESEWA_CSV)).status).toBe(400);
    expect((await upload(s, { gateway: "esewa", mapping: JSON.stringify({ date: "a", ref: "b", amount: "c", unit: "dollars" }) }, ESEWA_CSV)).status).toBe(400);
    expect((await upload(s, { gateway: "esewa" }, "a".repeat(5 * 1024 * 1024 + 10))).status).toBe(413);
    expect((await upload(s, { gateway: "esewa" }, "Transaction Date,Reference,Amount\n")).status).toBe(400);
  });

  it("accepts a raw text/csv body with ?gateway=", async () => {
    const r = await call("POST", `/api/projects/${s.projectId}/statements?env=live&gateway=esewa&filename=july.csv`, {
      cookie: s.cookie,
      raw: ESEWA_CSV,
      headers: { "content-type": "text/csv" },
    });
    expect(r.status).toBe(201);
    const b = await r.json<StatementSummary>();
    expect(b).toMatchObject({ filename: "july.csv", matched: { count: 4 } });
    await call("DELETE", `/api/projects/${s.projectId}/statements/${b.id}`, { cookie: s.cookie });
  });

  it("stores the fee table and validates it", async () => {
    const bad = await call("PUT", `/api/projects/${s.projectId}/fees`, { cookie: s.cookie, body: { gateway: "esewa", pct_bp: 1.5 } });
    expect(bad.status).toBe(400);
    const fees = await json(get(s, "/fees"));
    expect(fees.items).toEqual([{ gateway: "khalti", pct_bp: 300, fixed_paisa: 0 }]);
  });

  // ---------------------------------------------------------------- exports, exact bytes for the fixture month

  it("transactions.csv", async () => {
    const from = Date.parse(at("2025-07-01T00:00:00"));
    const to = Date.parse(at("2025-08-01T00:00:00"));
    const res = await get(s, `/exports/transactions.csv?env=live&from=${from}&to=${to}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename=".*-live-transactions-2025-07-01-to-2025-07-31\.csv"$/);
    expect(await res.text()).toBe(
      [
        "date,attempt_id,order_id,gateway,provider_ref,status,amount,refunded,fee,net,fee_source,date_bs",
        "2025-07-17 10:00:00,fx-p1,O-1,esewa,0LD5CEH,paid,1500.00,500.00,30.00,970.00,statement,2082-04-01",
        "2025-07-18 09:00:00,fx-p2,O-2,esewa,0LD5XYZ,paid,2500.00,0.00,48.00,2452.00,statement,2082-04-02",
        "2025-07-18 12:00:00,fx-p3,O-3,khalti,PIDX3,paid,1000.00,0.00,30.00,970.00,estimate,2082-04-02",
        "2025-07-19 08:00:00,fx-p4,O-4,esewa,,failed,500.00,0.00,,,,2082-04-03",
        "2025-07-19 10:00:00,fx-p6,O-6,esewa,0LD6AAA,paid,300.00,0.00,,300.00,,2082-04-03",
        "2025-07-21 08:00:00,fx-p5,O-5,esewa,,paid,700.00,0.00,14.00,686.00,statement,2082-04-05",
        "",
      ].join("\r\n"),
    );
  });

  it("tally.csv (unverified layout, balanced vouchers)", async () => {
    const res = await get(s, "/exports/tally.csv?env=live&month=2025-07");
    expect(res.headers.get("x-paynp-layout")).toBe("unverified");
    const n1 = '"Order O-1, attempt fx-p1, eSewa ref 0LD5CEH"';
    const n2 = '"Order O-2, attempt fx-p2, eSewa ref 0LD5XYZ"';
    const n3 = '"Order O-3, attempt fx-p3, Khalti ref PIDX3"';
    const n6 = '"Order O-6, attempt fx-p6, eSewa ref 0LD6AAA"';
    const cn = '"Order O-1, attempt fx-p1, CN-202507-0001, refund ref RF-1, reason: customer cancelled"';
    const n5 = '"Order O-5, attempt fx-p5"';
    expect(await res.text()).toBe(
      [
        "# Tally-style CSV; map ledgers on import. Layout unverified (not checked against a Tally import template). Columns: Date (DD-MM-YYYY, Nepal time), Voucher Type, Ledger, Debit, Credit, Narration. Each voucher is two lines that balance.",
        "Date,Voucher Type,Ledger,Debit,Credit,Narration",
        `17-07-2025,Receipt,eSewa Receipts,1500.00,,${n1}`,
        `17-07-2025,Receipt,Sales,,1500.00,${n1}`,
        "17-07-2025,Journal,Payment Gateway Charges,30.00,,eSewa charges for 2025-07-17 (1 from statement)",
        "17-07-2025,Journal,eSewa Receipts,,30.00,eSewa charges for 2025-07-17 (1 from statement)",
        `18-07-2025,Receipt,eSewa Receipts,2500.00,,${n2}`,
        `18-07-2025,Receipt,Sales,,2500.00,${n2}`,
        `18-07-2025,Receipt,Khalti Receipts,1000.00,,${n3}`,
        `18-07-2025,Receipt,Sales,,1000.00,${n3}`,
        "18-07-2025,Journal,Payment Gateway Charges,48.00,,eSewa charges for 2025-07-18 (1 from statement)",
        "18-07-2025,Journal,eSewa Receipts,,48.00,eSewa charges for 2025-07-18 (1 from statement)",
        "18-07-2025,Journal,Payment Gateway Charges,30.00,,Khalti charges for 2025-07-18 (1 estimated from the fee table)",
        "18-07-2025,Journal,Khalti Receipts,,30.00,Khalti charges for 2025-07-18 (1 estimated from the fee table)",
        `19-07-2025,Receipt,eSewa Receipts,300.00,,${n6}`,
        `19-07-2025,Receipt,Sales,,300.00,${n6}`,
        `20-07-2025,Credit Note,Sales Returns,500.00,,${cn}`,
        `20-07-2025,Credit Note,eSewa Receipts,,500.00,${cn}`,
        `21-07-2025,Receipt,eSewa Receipts,700.00,,${n5}`,
        `21-07-2025,Receipt,Sales,,700.00,${n5}`,
        "21-07-2025,Journal,Payment Gateway Charges,14.00,,eSewa charges for 2025-07-21 (1 from statement)",
        "21-07-2025,Journal,eSewa Receipts,,14.00,eSewa charges for 2025-07-21 (1 from statement)",
        "",
      ].join("\r\n"),
    );
  });

  it("hamrokhata.csv (unverified layout)", async () => {
    const res = await get(s, "/exports/hamrokhata.csv?env=live&month=2025-07");
    expect(res.headers.get("x-paynp-layout")).toBe("unverified");
    expect(await res.text()).toBe(
      [
        "# Hamrokhata-style sales and receipts CSV. Layout unverified (not checked against a Hamrokhata import template). Columns: Date, Miti, Voucher Type, Reference, Order ID, Particulars, Payment Method, Amount, Fee, Net Amount. Date is AD, Miti is BS, both Nepal time; refunds are Sales Return rows with negative amounts.",
        "Date,Miti,Voucher Type,Reference,Order ID,Particulars,Payment Method,Amount,Fee,Net Amount",
        "2025-07-17,2082-04-01,Sales Receipt,0LD5CEH,O-1,Online payment via eSewa,eSewa,1500.00,30.00,1470.00",
        "2025-07-18,2082-04-02,Sales Receipt,0LD5XYZ,O-2,Online payment via eSewa,eSewa,2500.00,48.00,2452.00",
        "2025-07-18,2082-04-02,Sales Receipt,PIDX3,O-3,Online payment via Khalti,Khalti,1000.00,30.00,970.00",
        "2025-07-19,2082-04-03,Sales Receipt,0LD6AAA,O-6,Online payment via eSewa,eSewa,300.00,,300.00",
        "2025-07-20,2082-04-04,Sales Return,CN-202507-0001,O-1,Refund of attempt fx-p1: customer cancelled,eSewa,-500.00,,-500.00",
        "2025-07-21,2082-04-05,Sales Receipt,fx-p5,O-5,Online payment via eSewa,eSewa,700.00,14.00,686.00",
        "",
      ].join("\r\n"),
    );
  });

  it("credit-notes.csv, with numbers that stay put on a second export", async () => {
    const expected = [
      "credit_note_no,date,date_bs,original_attempt,original_order,gateway,amount,reason,refund_ref",
      "CN-202507-0001,2025-07-20,2082-04-04,fx-p1,O-1,esewa,500.00,customer cancelled,RF-1",
      "",
    ].join("\r\n");
    expect(await (await get(s, "/exports/credit-notes.csv?env=live&month=2025-07")).text()).toBe(expected);
    // A second refund in the month gets the next number; the first keeps its own.
    await ingest(s.key, [e("payment.refunded", "fx-p2", "2025-07-25T09:00:00", { amount_paisa: 250000, data: { refund_ref: "RF-2" } })]);
    const again = await (await get(s, "/exports/credit-notes.csv?env=live&month=2025-07")).text();
    expect(again).toBe(expected.replace(/\r\n$/, "\r\nCN-202507-0002,2025-07-25,2082-04-09,fx-p2,O-2,esewa,2500.00,,RF-2\r\n"));
    // The same month asked for as Shrawan 2082 (BS) starts on 17 July.
    expect(await (await get(s, "/exports/credit-notes.csv?env=live&month=2082-04")).text()).toBe(again);
    expect((await get(s, "/exports/credit-notes.csv?env=live&month=July")).status).toBe(400);
  });

  it("numbers refunds marked by hand on a refund case once, and skips cases that have a refund event", async () => {
    const t = Date.parse(at("2025-07-26T11:00:00"));
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO refund_cases (id, project_id, env, kind, status, attempt_id, gateway, amount_paisa, reason, refund_ref, created_at, updated_at, resolved_at) VALUES ('rc_manual', ?, 'live', 'manual', 'refunded', 'fx-p6', 'esewa', 30000, 'duplicate order', 'ES-MANUAL', ?, ?, ?)",
      ).bind(s.projectId, t, t, t),
      env.DB.prepare(
        "INSERT INTO refund_cases (id, project_id, env, kind, status, attempt_id, gateway, amount_paisa, created_at, updated_at, resolved_at) VALUES ('rc_evt', ?, 'live', 'manual', 'refunded', 'fx-p2', 'esewa', 250000, ?, ?, ?)",
      ).bind(s.projectId, t, t, t),
    ]);
    const csv = await (await get(s, "/exports/credit-notes.csv?env=live&month=2025-07")).text();
    expect(csv.trim().split("\r\n").slice(1)).toEqual([
      "CN-202507-0001,2025-07-20,2082-04-04,fx-p1,O-1,esewa,500.00,customer cancelled,RF-1",
      "CN-202507-0002,2025-07-25,2082-04-09,fx-p2,O-2,esewa,2500.00,,RF-2",
      "CN-202507-0003,2025-07-26,2082-04-10,fx-p6,O-6,esewa,300.00,duplicate order,ES-MANUAL",
    ]);
  });

  it("year-summary for FY 2082-83 as JSON and CSV", async () => {
    const y = await json<YearSummary>(get(s, "/exports/year-summary?env=live&fy=2082-83"));
    expect(y).toMatchObject({ fy: "2082-83", env: "live", from_date: "2025-07-17", to_date: "2026-07-16" });
    // fx-p2 (2500) and fx-p6 (300) were refunded in later tests, so refunds are 500 + 2500 + 300.
    expect(y.gateways).toEqual([
      { gateway: "esewa", count: 4, gross_paisa: 500000, refunds_paisa: 330000, fees_paisa: 9200, fees_actual_paisa: 9200, fees_estimated_paisa: 0, net_paisa: 160800 },
      { gateway: "khalti", count: 1, gross_paisa: 100000, refunds_paisa: 0, fees_paisa: 3000, fees_actual_paisa: 0, fees_estimated_paisa: 3000, net_paisa: 97000 },
    ]);
    expect(y.totals).toEqual({ count: 5, gross_paisa: 600000, refunds_paisa: 330000, fees_paisa: 12200, fees_actual_paisa: 9200, fees_estimated_paisa: 3000, net_paisa: 257800 });
    expect(y.months).toHaveLength(12);
    expect(y.months[0]).toMatchObject({ month: "2082-04", label: "Shrawan 2082", count: 5, net_paisa: 257800 });
    expect(y.months.slice(1).every((m) => m.count === 0 && m.gateways.length === 0)).toBe(true);
    const csv = await (await get(s, "/exports/year-summary.csv?env=live&fy=2082/83")).text();
    const lines = csv.split("\r\n");
    expect(lines.slice(0, 5)).toEqual([
      "fiscal_year,month_bs,month,from,to,gateway,payments,gross,refunds,fees_actual,fees_estimated,fees,net",
      "2082-83,2082-04,Shrawan 2082,2025-07-17,2025-08-16,esewa,4,5000.00,3300.00,92.00,0.00,92.00,1608.00",
      "2082-83,2082-04,Shrawan 2082,2025-07-17,2025-08-16,khalti,1,1000.00,0.00,0.00,30.00,30.00,970.00",
      "2082-83,2082-04,Shrawan 2082,2025-07-17,2025-08-16,total,5,6000.00,3300.00,92.00,30.00,122.00,2578.00",
      "2082-83,2082-05,Bhadra 2082,2025-08-17,2025-09-16,total,0,0.00,0.00,0.00,0.00,0.00,0.00",
    ]);
    expect(lines.slice(-4)).toEqual([
      "2082-83,year,FY 2082-83,2025-07-17,2026-07-16,esewa,4,5000.00,3300.00,92.00,0.00,92.00,1608.00",
      "2082-83,year,FY 2082-83,2025-07-17,2026-07-16,khalti,1,1000.00,0.00,0.00,30.00,30.00,970.00",
      "2082-83,year,FY 2082-83,2025-07-17,2026-07-16,total,5,6000.00,3300.00,92.00,30.00,122.00,2578.00",
      "",
    ]);
    // The previous fiscal year (ends 16 July 2025) has none of this.
    const prev = await json<YearSummary>(get(s, "/exports/year-summary?env=live&fy=2081-82"));
    expect(prev.totals.count).toBe(0);
    expect((await get(s, "/exports/year-summary?env=live&fy=2079-80")).status).toBe(400);
    expect((await get(s, "/exports/year-summary?env=live")).status).toBe(400);
  });

  it("keeps other projects out", async () => {
    const other = await setup("live");
    expect((await call("GET", `/api/projects/${s.projectId}/statements/${summary.id}`, { cookie: other.cookie })).status).toBe(404);
    expect((await call("GET", `/api/projects/${s.projectId}/exports/tally.csv?month=2025-07`, { cookie: other.cookie })).status).toBe(404);
  });
});

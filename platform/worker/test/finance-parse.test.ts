import { describe, expect, it } from "vitest";
import { csvCell, detectDateOrder, parseAmount, parseCsv, parseDate, toCsv } from "../src/finance/csv.ts";
import { extractRows, matchRows, presetFor, resolveMapping, type PaymentCandidate, type RefundCandidate } from "../src/finance/statements.ts";

const NPT = (iso: string) => Date.parse(`${iso}+05:45`);

describe("CSV reading", () => {
  it("handles a BOM, quotes, escaped quotes, embedded newlines and CRLF", () => {
    expect(parseCsv('﻿a,b,c\r\n1,"x, y","he said ""hi"""\r\n2,"line\nbreak",\r\n')).toEqual([
      ["a", "b", "c"],
      ["1", "x, y", 'he said "hi"'],
      ["2", "line\nbreak", ""],
    ]);
  });

  it("detects semicolon and tab delimiters", () => {
    expect(parseCsv("a;b\n1;2")).toEqual([["a", "b"], ["1", "2"]]);
    expect(parseCsv("a\tb\n1,5\t2")).toEqual([["a", "b"], ["1,5", "2"]]);
  });
});

describe("amount parsing", () => {
  const ok = (s: string, unit: "rupees" | "paisa" = "rupees") => {
    const r = parseAmount(s, unit);
    if (!r.ok) throw new Error(r.error);
    return r.value;
  };
  it("reads Nepali formats: commas, Rs./NPR/रु prefixes, lakh grouping, Devanagari digits", () => {
    expect(ok("1,000.00")).toBe(100000);
    expect(ok("Rs. 1,000")).toBe(100000);
    expect(ok("Rs 1500.5")).toBe(150050);
    expect(ok("NPR 1,500")).toBe(150000);
    expect(ok("रु 1,500")).toBe(150000);
    expect(ok("1,00,000.50")).toBe(10000050);
    expect(ok("12,34,567")).toBe(123456700);
    expect(ok("१,२५०.००")).toBe(125000);
    expect(ok("0.5")).toBe(50);
    expect(ok(".75")).toBe(75);
    expect(ok("100.005")).toBe(10001);
    expect(ok("100.004")).toBe(10000);
    expect(ok("")).toBeNull();
  });
  it("reads negatives as -x, x- and (x)", () => {
    expect(ok("-500")).toBe(-50000);
    expect(ok("500-")).toBe(-50000);
    expect(ok("(1,250.00)")).toBe(-125000);
    expect(ok("Rs. -20")).toBe(-2000);
    expect(ok("-Rs. 20")).toBe(-2000);
  });
  it("takes paisa amounts as whole numbers when the mapping says paisa", () => {
    expect(ok("150000", "paisa")).toBe(150000);
    expect(ok("1,50,000", "paisa")).toBe(150000);
    expect(ok("150000.00", "paisa")).toBe(150000);
    expect(parseAmount("1500.50", "paisa").ok).toBe(false);
  });
  it("rejects text, two decimal points and broken grouping", () => {
    for (const bad of ["abc", "1.2.3", "12,3", "Rs", "1e5", "₹ 10x", "9".repeat(60)]) expect(parseAmount(bad).ok, bad).toBe(false);
  });
});

describe("date parsing", () => {
  const ok = (s: string, order: "dmy" | "mdy" = "dmy") => {
    const r = parseDate(s, order);
    if (!r.ok) throw new Error(r.error);
    return r.value;
  };
  it("reads ISO, d/m/y, d-Mon-y and Mon d, y as Nepal time unless a zone is given", () => {
    expect(ok("2025-07-17 14:03:22")).toBe(NPT("2025-07-17T14:03:22"));
    expect(ok("2025/07/17")).toBe(NPT("2025-07-17T00:00:00"));
    expect(ok("2025-07-17T08:18:22Z")).toBe(Date.parse("2025-07-17T08:18:22Z"));
    expect(ok("2025-07-17T14:03:22+05:45")).toBe(NPT("2025-07-17T14:03:22"));
    expect(ok("17/07/2025 2:03 PM")).toBe(NPT("2025-07-17T14:03:00"));
    expect(ok("17-07-2025 12:15 am")).toBe(NPT("2025-07-17T00:15:00"));
    expect(ok("17-Jul-2025 14:03")).toBe(NPT("2025-07-17T14:03:00"));
    expect(ok("Jul 17, 2025 14:03:05")).toBe(NPT("2025-07-17T14:03:05"));
    expect(ok("07/17/2025", "mdy")).toBe(NPT("2025-07-17T00:00:00"));
  });
  it("reads Bikram Sambat Y-M-D dates", () => {
    expect(ok("2082-04-01 10:00")).toBe(NPT("2025-07-17T10:00:00"));
    expect(parseDate("2079-01-01").ok).toBe(false);
  });
  it("rejects impossible dates and times", () => {
    for (const bad of ["2025-02-30", "32/01/2025", "2025-13-01", "17/07/2025 25:00", "13/07/2025 13:00 PM", "yesterday"]) expect(parseDate(bad).ok, bad).toBe(false);
  });
  it("detects month-first columns only when a value requires it", () => {
    expect(detectDateOrder(["03/04/2025", "13/04/2025"])).toBe("dmy");
    expect(detectDateOrder(["03/04/2025", "04/13/2025"])).toBe("mdy");
    expect(detectDateOrder(["03/04/2025"])).toBe("dmy");
  });
});

describe("CSV writing", () => {
  it("escapes quotes, commas and newlines, guards formulas in text cells, and ends lines with CRLF", () => {
    expect(csvCell('a "b", c')).toBe('"a ""b"", c"');
    expect(csvCell("=SUM(A1)")).toBe("'=SUM(A1)");
    expect(csvCell("-12", false)).toBe("-12");
    expect(toCsv(["x", "y"], [["1.00", "=1"]], { comment: "note", numeric: [0] })).toBe("# note\r\nx,y\r\n1.00,'=1\r\n");
  });
});

// ------------------------------------------------------------------ presets and mapping

const ESEWA = [
  "eSewa Merchant Statement",
  "Merchant: Demo Shop,,,,,",
  "",
  "Transaction Date,Reference Code,Product ID,Amount,Service Charge,Net Amount,Status",
  "2025-07-17 10:00:05,0LD5CEH,O-1,\"1,500.00\",30.00,\"1,470.00\",COMPLETE",
  "2025-07-17 11:00:00,0LD5XYZ,O-2,\"1,00,000.50\",2000.01,,COMPLETE",
  "2025-07-17 12:00:00,0LD5BAD,O-3,abc,,,COMPLETE",
  "2025-07-17 13:00:00,0LD5REF,O-1,-500.00,,,FULL_REFUND",
  "2025-07-17 14:00:00,0LD5FAIL,O-4,200,,,FAILED",
  ",,,,,,",
  "Total,,,\"1,01,500.50\",,,",
].join("\n");

describe("presets and mappings", () => {
  it("skips title rows, picks the eSewa preset (unverified) and every ref column", () => {
    const records = parseCsv(ESEWA);
    const r = resolveMapping(records, "esewa", null, null);
    if (!r.ok) throw new Error("expected a preset");
    expect(r.value.source).toBe("preset");
    expect(r.value.headerRow).toBe(3);
    expect(r.value.mapping).toMatchObject({ date: "Transaction Date", ref: "Reference Code", ref_alt: ["Product ID"], amount: "Amount", fee: "Service Charge", net: "Net Amount", status: "Status", unit: "rupees" });
    expect(presetFor("esewa").unverified).toBe(true);
    expect(presetFor("khalti").columns.ref).toContain("pidx");
    expect(presetFor("fonepay").columns.ref[0]).toBe("prn");
  });

  it("fits the Khalti and Fonepay presets (unverified) from their common column names", () => {
    const k = parseCsv("Date,Transaction ID,Product Identity,Amount (Rs),Fee,State\n2025-07-18 12:00,8xYz,O-3,1000,30,Completed\n");
    const kr = resolveMapping(k, "khalti", null, null);
    if (!kr.ok) throw new Error("khalti preset");
    expect(kr.value.mapping).toMatchObject({ date: "Date", ref: "Transaction ID", ref_alt: ["Product Identity"], amount: "Amount (Rs)", fee: "Fee", status: "State" });
    const f = parseCsv("S.N.,Txn Date,PRN,Fonepay Trace ID,Txn Amount,Commission,Net Amount,Settlement Date\n1,18/07/2025 12:00,PRN-9,TR1,1000,15,985,19/07/2025\n");
    const fr = resolveMapping(f, "fonepay", null, null);
    if (!fr.ok) throw new Error("fonepay preset");
    expect(fr.value.mapping).toMatchObject({ date: "Txn Date", ref: "PRN", ref_alt: ["Fonepay Trace ID"], amount: "Txn Amount", fee: "Commission", net: "Net Amount", settled_at: "Settlement Date" });
    expect(extractRows(f, fr.value)[0]).toMatchObject({ refs: ["PRN-9", "TR1"], amount_paisa: 100000, fee_paisa: 1500, net_paisa: 98500, settled_at: NPT("2025-07-19T00:00:00") });
  });

  it("extracts kinds: payments, refunds (negative), void (failed status), errors, and skips blank and total rows", () => {
    const records = parseCsv(ESEWA);
    const r = resolveMapping(records, "esewa", null, null);
    if (!r.ok) throw new Error();
    const rows = extractRows(records, r.value);
    expect(rows.map((x) => [x.row, x.kind])).toEqual([
      [5, "payment"],
      [6, "payment"],
      [7, "error"],
      [8, "refund"],
      [9, "void"],
    ]);
    expect(rows[0]).toMatchObject({ txn_at: NPT("2025-07-17T10:00:05"), refs: ["0LD5CEH", "O-1"], amount_paisa: 150000, fee_paisa: 3000, net_paisa: 147000 });
    // Net derived from amount - fee when the net cell is blank.
    expect(rows[1]).toMatchObject({ amount_paisa: 10000050, fee_paisa: 200001, net_paisa: 9800049 });
    expect(rows[2].error).toContain("not an amount");
    expect(rows[3]).toMatchObject({ amount_paisa: -50000, net_paisa: -50000 });
  });

  it("answers 422 with headers, sample rows and a partial guess when nothing fits", () => {
    const records = parseCsv("Report,,\nWhen,Txn,Rupees\n2025-07-17,A1,100\n");
    const r = resolveMapping(records, "khalti", null, null);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({ error: { code: "mapping_required" }, headers: ["When", "Txn", "Rupees"], header_row: 1, sample: [["2025-07-17", "A1", "100"]], missing: ["date", "ref", "amount"] });
  });

  it("uses a request mapping (matched case- and punctuation-insensitively), then a saved one", () => {
    const records = parseCsv("Report,,\nWhen,Txn,Rupees\n2025-07-17,A1,100\n");
    const mapping = { date: "when", ref: "TXN", amount: "rupees" };
    const r = resolveMapping(records, "khalti", mapping, null);
    if (!r.ok) throw new Error();
    expect(r.value).toMatchObject({ source: "request", headerRow: 1 });
    const s = resolveMapping(records, "khalti", null, { ...mapping, header_row: 1 });
    if (!s.ok) throw new Error();
    expect(s.value.source).toBe("saved");
    const bad = resolveMapping(records, "khalti", { date: "when", ref: "nope", amount: "rupees" }, null);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.body.error.message).toContain('ref ("nope")');
  });

  it("reads paisa columns and month-first dates when the mapping says so", () => {
    const records = parseCsv("date,pidx,amount\n07/17/2025 10:00,P1,150000\n");
    const r = resolveMapping(records, "khalti", { date: "date", ref: "pidx", amount: "amount", unit: "paisa", date_order: "mdy" }, null);
    if (!r.ok) throw new Error();
    expect(extractRows(records, r.value)[0]).toMatchObject({ amount_paisa: 150000, txn_at: NPT("2025-07-17T10:00:00") });
  });
});

// ------------------------------------------------------------------ matching

describe("matching", () => {
  const t0 = NPT("2025-07-17T10:00:00");
  const row = (n: number, kind: "payment" | "refund", amount: number, at: number, refs: string[] = []) => ({
    row: n, kind, txn_at: at, refs, amount_paisa: amount, fee_paisa: null, net_paisa: amount, status: null, settled_at: null, raw: [], error: null,
  });
  const pay = (id: string, amount: number, at: number, status = "paid"): PaymentCandidate => ({ attempt_id: id, amount_paisa: amount, status, at });

  it("matches by ref first, flags an amount mismatch, and never reuses a payment by amount+time", () => {
    const payments = new Map([["a1", pay("a1", 150000, t0)], ["a2", pay("a2", 150000, t0 + 60_000)]]);
    const refIndex = new Map([["REF1", ["a1"]], ["REF2", ["a2"]]]);
    const m = matchRows([row(1, "payment", 150000, t0, ["REF1"]), row(2, "payment", 140000, t0, ["REF2"])], refIndex, payments, [...payments.values()], []);
    expect(m[0]).toEqual({ attempt_id: "a1", kind: "ref", paynp_amount_paisa: 150000, mismatch: false });
    expect(m[1]).toEqual({ attempt_id: "a2", kind: "ref", paynp_amount_paisa: 150000, mismatch: true });
  });

  it("with a ref shared by several payments (an order id), picks the one paid with the same amount", () => {
    const payments = new Map([["a1", pay("a1", 150000, t0, "failed")], ["a2", pay("a2", 150000, t0)]]);
    const m = matchRows([row(1, "payment", 150000, t0, ["O-1"])], new Map([["O-1", ["a1", "a2"]]]), payments, [], []);
    expect(m[0]).toMatchObject({ attempt_id: "a2", kind: "ref" });
  });

  it("matches by amount within 10 minutes only when the candidate is unique both ways", () => {
    const p = [pay("u1", 50000, t0), pay("x1", 70000, t0), pay("x2", 70000, t0 + 120_000), pay("far", 90000, t0 + 11 * 60_000)];
    const rows = [
      row(1, "payment", 50000, t0 + 9 * 60_000), // unique: matches u1
      row(2, "payment", 70000, t0 + 60_000), // two payments within the window: ambiguous
      row(3, "payment", 90000, t0), // 11 minutes away: no match
    ];
    const m = matchRows(rows, new Map(), new Map(p.map((x) => [x.attempt_id, x])), p, []);
    expect(m.map((x) => [x.attempt_id, x.kind])).toEqual([["u1", "amount_time"], [null, "none"], [null, "none"]]);
    // Two rows competing for one payment: neither matches.
    const m2 = matchRows([row(1, "payment", 50000, t0), row(2, "payment", 50000, t0 + 1000)], new Map(), new Map(), [p[0]], []);
    expect(m2.every((x) => x.kind === "none")).toBe(true);
  });

  it("matches refund rows to paynp refunds by the original ref or by amount and time", () => {
    const payments = new Map([["a1", pay("a1", 150000, t0, "refunded")]]);
    const refunds: RefundCandidate[] = [{ attempt_id: "a1", amount_paisa: 50000, at: t0 + 3600_000 }, { attempt_id: "b9", amount_paisa: 20000, at: t0 + 7200_000 }];
    const m = matchRows(
      [row(1, "refund", -50000, t0 + 3600_000, ["REF1"]), row(2, "refund", -20000, t0 + 7200_000 + 60_000), row(3, "refund", -99900, t0 + 3600_000, ["REF1"])],
      new Map([["REF1", ["a1"]]]),
      payments,
      [],
      refunds,
    );
    expect(m[0]).toEqual({ attempt_id: "a1", kind: "ref", paynp_amount_paisa: 50000, mismatch: false });
    expect(m[1]).toMatchObject({ attempt_id: "b9", kind: "amount_time", mismatch: false });
    expect(m[2]).toMatchObject({ attempt_id: "a1", kind: "ref", mismatch: true });
  });
});

import { describe, expect, it } from "vitest";
import { parseCsv } from "./csv.ts";
import { adMonthLabel, formatClock, formatDate, formatFeePct, formatMoney, nptDateToMs, nptDateValue, nptMonthValue, parseStatementAmount, recentMonths } from "./format.ts";
import { bsLabelForAdMonth } from "./nepali.ts";

const npt = (iso: string) => Date.parse(`${iso}+05:45`);

describe("parseStatementAmount", () => {
  it("reads the ways statements print rupees", () => {
    expect(parseStatementAmount("1,000.00")).toBe(100_000);
    expect(parseStatementAmount("Rs. 1,000")).toBe(100_000);
    expect(parseStatementAmount("NPR 1,00,000.50")).toBe(10_000_050);
    expect(parseStatementAmount("100,000.5")).toBe(10_000_050);
    expect(parseStatementAmount("1249.5")).toBe(124_950);
    expect(parseStatementAmount("  250 ")).toBe(25_000);
  });
  it("treats minus signs and parentheses as refunds", () => {
    expect(parseStatementAmount("-250.00")).toBe(-25_000);
    expect(parseStatementAmount("(1,500.00)")).toBe(-150_000);
    expect(parseStatementAmount("Rs. -99")).toBe(-9_900);
    expect(parseStatementAmount("250-")).toBe(-25_000);
  });
  it("respects a paisa unit", () => {
    expect(parseStatementAmount("150000", "paisa")).toBe(150_000);
  });
  it("rejects what is not a number", () => {
    expect(parseStatementAmount("")).toBeNull();
    expect(parseStatementAmount(null)).toBeNull();
    expect(parseStatementAmount("abc")).toBeNull();
    expect(parseStatementAmount("1,2")).toBeNull();
    expect(parseStatementAmount("1.000,00")).toBeNull();
  });
  it("round-trips with lakh formatting", () => {
    expect(formatMoney(parseStatementAmount("1,24,999.50"))).toBe("Rs 1,24,999.50");
    expect(formatMoney(parseStatementAmount("(12,34,567)"))).toBe("-Rs 12,34,567.00");
  });
});

describe("Nepal time dates", () => {
  it("prints dates and clock times in NPT", () => {
    // 18:30 UTC on 4 Nov is 00:15 on 5 Nov in Kathmandu.
    expect(formatDate(Date.UTC(2026, 10, 4, 18, 30))).toBe("5 Nov 2026");
    expect(formatClock(npt("2026-11-05T12:59:00"))).toBe("12:59 PM");
    expect(formatClock(npt("2026-11-05T00:05:00"))).toBe("12:05 AM");
  });
  it("maps date inputs to NPT day bounds and back", () => {
    const start = nptDateToMs("2026-11-05")!;
    expect(start).toBe(npt("2026-11-05T00:00:00"));
    expect(nptDateToMs("2026-11-05", true)).toBe(npt("2026-11-06T00:00:00") - 1);
    expect(nptDateValue(start)).toBe("2026-11-05");
    expect(nptDateValue(start - 1)).toBe("2026-11-04");
    expect(nptDateToMs("5/11/2026")).toBeNull();
  });
  it("lists recent months across a year boundary", () => {
    expect(nptMonthValue(npt("2026-01-01T00:10:00"))).toBe("2026-01");
    expect(recentMonths(npt("2026-02-10T10:00:00"), 4)).toEqual(["2026-02", "2026-01", "2025-12", "2025-11"]);
    expect(adMonthLabel("2026-11")).toBe("November 2026");
  });
  it("formats fee rates with two decimals", () => {
    expect(formatFeePct(0.0184)).toBe("1.84%");
    expect(formatFeePct(null)).toBe("-");
  });
});

describe("Bikram Sambat labels", () => {
  it("labels AD months with the BS months they overlap", () => {
    expect(bsLabelForAdMonth("2026-11")).toBe("Kartik / Mangsir 2083");
    expect(bsLabelForAdMonth("2025-07")).toBe("Asar / Shrawan 2082");
    // Baisakh 1, 2083 is 14 April 2026.
    expect(bsLabelForAdMonth("2026-04")).toBe("Chaitra 2082 / Baisakh 2083");
    expect(bsLabelForAdMonth("2019-01")).toBe("");
    expect(bsLabelForAdMonth("nope")).toBe("");
  });
});

describe("parseCsv", () => {
  it("reads quotes, doubled quotes, CRLF and a BOM", () => {
    const text = '﻿Date,Reference,"Amount (Rs)"\r\n2026-11-01,"0LD5CEH","1,500.00"\r\n2026-11-02,"say ""hi""",250\r\n\r\n';
    expect(parseCsv(text)).toEqual([
      ["Date", "Reference", "Amount (Rs)"],
      ["2026-11-01", "0LD5CEH", "1,500.00"],
      ["2026-11-02", 'say "hi"', "250"],
    ]);
  });
  it("sniffs semicolons and tabs and stops at maxRows", () => {
    expect(parseCsv("a;b\n1;2\n3;4", 2)).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
    expect(parseCsv("a\tb\n1\t2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });
});

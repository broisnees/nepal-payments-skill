import { BS_MONTH_DAYS, FISCAL_YEARS, fiscalYear, fiscalYearOf, formatBs, fromBs, toBs } from "@paynp/shared";
import { describe, expect, it } from "vitest";
import { parseMonth } from "../src/finance/exports.ts";

const NPT = (iso: string) => Date.parse(`${iso}T00:00:00+05:45`);
const npt = (ms: number) => new Date(ms + (5 * 60 + 45) * 60_000).toISOString().slice(0, 10);

// Shrawan 1 for each fiscal year and the last day of Asar that ends it (AD), from the nepali-date-converter and
// bikram-sambat tables, checked against hamropatro.com/calendar.
const FY: [string, string, string][] = [
  ["2080-81", "2023-07-17", "2024-07-15"],
  ["2081-82", "2024-07-16", "2025-07-16"],
  ["2082-83", "2025-07-17", "2026-07-16"],
  ["2083-84", "2026-07-17", "2027-07-16"],
  ["2084-85", "2027-07-17", "2028-07-15"],
];

describe("Bikram Sambat table", () => {
  it("has years that start on the published Baisakh 1 dates", () => {
    expect(npt(fromBs(2080, 1)!)).toBe("2023-04-14");
    expect(npt(fromBs(2081, 1)!)).toBe("2024-04-13");
    expect(npt(fromBs(2082, 1)!)).toBe("2025-04-14");
    expect(npt(fromBs(2083, 1)!)).toBe("2026-04-14");
    expect(npt(fromBs(2084, 1)!)).toBe("2027-04-14");
    expect(npt(fromBs(2085, 1)!)).toBe("2028-04-13");
    for (let y = 2080; y <= 2084; y++) expect(BS_MONTH_DAYS[y].length).toBe(12);
  });

  it("matches spot checks from Hamro Patro", () => {
    expect(formatBs(NPT("2026-11-05"))).toBe("2083-07-19"); // 19 Kartik 2083
    expect(npt(fromBs(2083, 6)!)).toBe("2026-09-17"); // Asoj 1
    expect(npt(fromBs(2083, 8)!)).toBe("2026-11-17"); // Mangsir 1
    expect(npt(fromBs(2083, 10)!)).toBe("2027-01-15"); // Magh 1
    expect(npt(fromBs(2084, 5)!)).toBe("2027-08-17"); // Bhadra 1
    expect(npt(fromBs(2084, 9)!)).toBe("2027-12-16"); // Poush 1
    expect(npt(fromBs(2084, 12)!)).toBe("2028-03-14"); // Chaitra 1
    expect(npt(fromBs(2085, 3)!)).toBe("2028-06-15"); // Asar 1
  });

  it("round-trips every day of the table", () => {
    for (let y = 2080; y <= 2085; y++) {
      BS_MONTH_DAYS[y].forEach((days, m) => {
        for (let d = 1; d <= days; d++) expect(toBs(fromBs(y, m + 1, d)!)).toEqual({ year: y, month: m + 1, day: d });
      });
    }
    expect(fromBs(2083, 8, 30)).toBeNull(); // Mangsir 2083 has 29 days
    expect(fromBs(2079, 4)).toBeNull();
    expect(fromBs(2085, 4)).toBeNull(); // beyond the table
  });
});

describe("Nepal fiscal year boundaries", () => {
  it.each(FY)("%s runs from Shrawan 1 (%s) to the end of Asar (%s)", (fy, start, end) => {
    const y = fiscalYear(fy)!;
    expect(y.fy).toBe(fy);
    expect(npt(y.from)).toBe(start);
    expect(npt(y.to - 1)).toBe(end);
    expect(y.months.map((m) => m.label.split(" ")[0])).toEqual(["Shrawan", "Bhadra", "Asoj", "Kartik", "Mangsir", "Poush", "Magh", "Falgun", "Chaitra", "Baisakh", "Jestha", "Asar"]);
    expect(y.months[0].from).toBe(y.from);
    expect(y.months[11].to).toBe(y.to);
    for (let i = 1; i < 12; i++) expect(y.months[i].from).toBe(y.months[i - 1].to);
    // The instant before Shrawan 1 00:00 NPT is in the previous fiscal year; Shrawan 1 00:00 is in this one.
    expect(fiscalYearOf(y.from)).toBe(fy);
    expect(fiscalYearOf(y.to - 1)).toBe(fy);
    const prev = `${Number(fy.slice(0, 4)) - 1}-${fy.slice(2, 4)}`;
    expect(fiscalYearOf(y.from - 1)).toBe(fy === "2080-81" ? null : prev);
  });

  it("accepts 2082-83, 2082/83, 2082-2083 and 2082, rejects the rest", () => {
    for (const v of ["2082-83", "2082/83", "2082-2083", "2082"]) expect(fiscalYear(v)?.fy, v).toBe("2082-83");
    for (const v of ["2082-84", "2079-80", "2085-86", "82-83", "x"]) expect(fiscalYear(v), v).toBeNull();
    expect(FISCAL_YEARS.every((f) => fiscalYear(f) !== null)).toBe(true);
  });

  it("month=YYYY-MM is Gregorian in Nepal time, or BS from year 2070", () => {
    expect(parseMonth("2025-07")).toEqual({ from: NPT("2025-07-01"), to: NPT("2025-08-01"), label: "2025-07", bs: false });
    expect(parseMonth("2082-04")).toEqual({ from: NPT("2025-07-17"), to: NPT("2025-08-17"), label: "2082-04", bs: true });
    expect(parseMonth("2025-13")).toBeNull();
    expect(parseMonth("2079-04")).toBeNull();
  });
});

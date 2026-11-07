import { describe, expect, test } from "vitest";
import {
  formatCount,
  formatDateTime,
  formatDuration,
  formatFull,
  formatMoney,
  formatMoneyCompact,
  formatOffset,
  formatOtherCurrencies,
  formatPct,
  formatRelative,
  formatTime,
  formatTimeMs,
  moneyParts,
  nptStartOfDay,
  parseRupees,
  shortId,
} from "./format.ts";

describe("money", () => {
  test("prints rupees with paisa and Nepali grouping", () => {
    expect(formatMoney(0)).toBe("Rs 0.00");
    expect(formatMoney(5)).toBe("Rs 0.05");
    expect(formatMoney(124_950)).toBe("Rs 1,249.50");
    expect(formatMoney(12_499_950)).toBe("Rs 1,24,999.50");
    expect(formatMoney(1_000_000_000)).toBe("Rs 1,00,00,000.00");
    expect(formatMoney(-2500)).toBe("-Rs 25.00");
  });

  test("null and NaN print a hyphen", () => {
    expect(formatMoney(null)).toBe("-");
    expect(formatMoney(undefined)).toBe("-");
    expect(formatMoney(Number.NaN)).toBe("-");
  });

  test("splits parts for dimmed paisa", () => {
    expect(moneyParts(124_905)).toEqual({ sign: "", int: "1,249", frac: "05", cur: "Rs" });
  });

  test("other currencies use their own symbol, exponent and thousands grouping", () => {
    expect(formatMoney(2000, "USD")).toBe("$20.00");
    expect(formatMoney(12_499_950, "usd")).toBe("$124,999.50");
    expect(formatMoney(4999, "EUR")).toBe("€49.99");
    expect(formatMoney(500, "JPY")).toBe("¥500");
    expect(formatMoney(1500, "CAD")).toBe("CAD 15.00");
    expect(formatMoney(-2500, "USD")).toBe("-$25.00");
    expect(moneyParts(500, "JPY")).toEqual({ sign: "", int: "500", frac: "", cur: "¥" });
  });

  test("lists revenue in other currencies, NPR left out", () => {
    expect(formatOtherCurrencies({ NPR: 150000, USD: 2000, EUR: 4999 })).toBe("€49.99 + $20.00");
    expect(formatOtherCurrencies({ NPR: 150000 })).toBe("");
    expect(formatOtherCurrencies(undefined)).toBe("");
  });

  test("compact uses K, lakh and crore", () => {
    expect(formatMoneyCompact(95_000)).toBe("Rs 950");
    expect(formatMoneyCompact(1_250_000)).toBe("Rs 12.5K");
    expect(formatMoneyCompact(42_000_000)).toBe("Rs 4.2L");
    expect(formatMoneyCompact(1_300_000_000)).toBe("Rs 1.3Cr");
  });

  test("parses rupee input to paisa", () => {
    expect(parseRupees("1,249.50")).toBe(124_950);
    expect(parseRupees("1249.5")).toBe(124_950);
    expect(parseRupees("Rs 100")).toBe(10_000);
    expect(parseRupees("")).toBeNull();
    expect(parseRupees("12.345")).toBeNull();
    expect(parseRupees("abc")).toBeNull();
  });
});

describe("numbers", () => {
  test("counts and percentages", () => {
    expect(formatCount(1_284)).toBe("1,284");
    expect(formatCount(128_400)).toBe("1,28,400");
    expect(formatPct(0.9423)).toBe("94.2%");
    expect(formatPct(1)).toBe("100%");
    expect(formatPct(0)).toBe("0%");
    expect(formatPct(null)).toBe("-");
  });
});

describe("durations", () => {
  test("scales units with the size", () => {
    expect(formatDuration(0)).toBe("0 ms");
    expect(formatDuration(412.4)).toBe("412 ms");
    expect(formatDuration(2_412)).toBe("2.41 s");
    expect(formatDuration(3_000)).toBe("3 s");
    expect(formatDuration(16_000)).toBe("16 s");
    expect(formatDuration(42_100)).toBe("42.1 s");
    expect(formatDuration(252_000)).toBe("4m 12s");
    expect(formatDuration(7_500_000)).toBe("2h 05m");
    expect(formatDuration(3 * 86_400_000 + 4 * 3_600_000)).toBe("3d 4h");
    expect(formatDuration(null)).toBe("-");
  });

  test("offsets carry a plus sign", () => {
    expect(formatOffset(0)).toBe("+0 ms");
    expect(formatOffset(65_000)).toBe("+1m 05s");
  });
});

describe("Nepal time", () => {
  // 2026-11-05T08:47:05.123Z is 14:32:05.123 in Kathmandu (UTC+05:45).
  const t = Date.UTC(2026, 10, 5, 8, 47, 5, 123);

  test("prints wall clock in Asia/Kathmandu", () => {
    expect(formatTime(t)).toBe("14:32:05");
    expect(formatTimeMs(t)).toBe("14:32:05.123");
    expect(formatFull(t)).toBe("5 Nov 2026, 14:32:05 NPT");
    expect(formatDateTime(t, t)).toBe("5 Nov, 14:32");
    expect(formatDateTime(t, Date.UTC(2027, 0, 2))).toBe("5 Nov 2026, 14:32");
  });

  test("day boundaries follow Nepal midnight, not UTC", () => {
    // Kathmandu midnight on 5 Nov is 18:15 UTC on 4 Nov.
    const before = Date.UTC(2026, 10, 4, 18, 14);
    const after = Date.UTC(2026, 10, 4, 18, 16);
    expect(nptStartOfDay(after)).toBe(Date.UTC(2026, 10, 4, 18, 15));
    expect(nptStartOfDay(before)).toBe(Date.UTC(2026, 10, 3, 18, 15));
  });

  test("relative times", () => {
    const now = t;
    expect(formatRelative(now - 1_000, now)).toBe("just now");
    expect(formatRelative(now - 12_000, now)).toBe("12s ago");
    expect(formatRelative(now - 4 * 60_000, now)).toBe("4m ago");
    expect(formatRelative(now - 3 * 3_600_000, now)).toBe("3h ago");
    expect(formatRelative(now - 2 * 86_400_000, now)).toBe("2d ago");
    expect(formatRelative(now - 30 * 86_400_000, now)).toBe("6 Oct, 14:32");
  });
});

test("shortId keeps both ends", () => {
  expect(shortId("att_01JC8ZQ4M2T6Y9K3QF7H5RNB2D")).toBe("att_01JC8Z...5RNB2D");
  expect(shortId("att_short")).toBe("att_short");
});

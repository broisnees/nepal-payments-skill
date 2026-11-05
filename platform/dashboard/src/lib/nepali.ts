// Bikram Sambat labels for AD months. The calendar table and fiscal-year math live in @paynp/shared (finance.ts),
// the same ones the exports use.
import { BS_MONTHS, toBs, type BsDate } from "@paynp/shared";
import { NPT_OFFSET_MS } from "./format.ts";

/** "Kartik 2083" */
export function bsMonthName(d: BsDate): string {
  return `${BS_MONTHS[d.month - 1]} ${d.year}`;
}

/**
 * BS months an AD month ("2026-11") overlaps: "Kartik / Mangsir 2083", or "Chaitra 2082 / Baisakh 2083" across a
 * BS new year. Empty string outside the table.
 */
export function bsLabelForAdMonth(month: string): string {
  const [y, m] = month.split("-").map(Number);
  if (!y || !m) return "";
  const first = toBs(Date.UTC(y, m - 1, 1) - NPT_OFFSET_MS);
  const last = toBs(Date.UTC(y, m, 0) - NPT_OFFSET_MS);
  if (!first || !last) return "";
  if (first.year === last.year && first.month === last.month) return bsMonthName(first);
  if (first.year === last.year) return `${BS_MONTHS[first.month - 1]} / ${BS_MONTHS[last.month - 1]} ${first.year}`;
  return `${bsMonthName(first)} / ${bsMonthName(last)}`;
}

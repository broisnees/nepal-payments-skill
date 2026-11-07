// Amounts are integers in a currency's minor unit (paisa, cents; yen have none). Intl knows each exponent.
import { DEFAULT_CURRENCY } from "./events.ts";

/** Decimal places of a currency's minor unit: 2 for NPR and USD, 0 for JPY, 3 for KWD. */
export function minorDigits(currency: string): number {
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}

/** "Rs 1,200.00" for NPR (the dashboard's long-standing format), "$45.00" or "¥500" for others. */
export function formatMoney(minor: number, currency: string = DEFAULT_CURRENCY): string {
  const cur = currency.toUpperCase();
  const digits = minorDigits(cur);
  const major = minor / 10 ** digits;
  if (cur === DEFAULT_CURRENCY) return `Rs ${major.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency: cur, minimumFractionDigits: digits, maximumFractionDigits: digits }).format(major);
  } catch {
    return `${cur} ${major.toFixed(digits)}`;
  }
}

/** "Rs 1,200.00 + $45.00", NPR first; "Rs 0.00" when empty. */
export function formatMoneyMap(byCurrency: Record<string, number>): string {
  const parts = Object.entries(byCurrency)
    .filter(([, n]) => n !== 0)
    .sort(([a], [b]) => (a === DEFAULT_CURRENCY ? -1 : b === DEFAULT_CURRENCY ? 1 : a.localeCompare(b)))
    .map(([c, n]) => formatMoney(n, c));
  return parts.length ? parts.join(" + ") : formatMoney(0);
}

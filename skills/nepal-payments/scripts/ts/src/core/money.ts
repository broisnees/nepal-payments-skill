/**
 * Money. Keep money as integer paisa everywhere; convert only at the edge.
 */
import { PaymentError } from "./errors.ts";
import type { ProviderId } from "./types.ts";

export function assertPaisa(paisa: number, provider: ProviderId): void {
  if (!Number.isSafeInteger(paisa) || paisa <= 0) {
    throw new PaymentError(
      `amount must be a positive integer in paisa, got ${paisa}`,
      provider,
      "invalid_amount",
    );
  }
}

/** 12345 -> "123.45", 10000 -> "100". Never use floats for money. */
export function paisaToRupees(paisa: number): string {
  const sign = paisa < 0 ? "-" : ""; // Math.trunc(-5 / 100) is -0, which prints as "0"
  const absolute = Math.abs(paisa);
  const rupees = Math.trunc(absolute / 100);
  const remainder = absolute % 100;
  if (remainder === 0) return `${sign}${rupees}`;
  return `${sign}${rupees}.${String(remainder).padStart(2, "0")}`;
}

/** "123.45" | 123.45 | "100" -> paisa integer. Rounds half away from zero on the 3rd decimal. */
export function rupeesToPaisa(rupees: string | number): number {
  // String(1.005) = "1.005" (toFixed would round in binary)
  const text = typeof rupees === "number" ? String(rupees) : rupees.trim().replace(/,/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(text)) throw new Error(`not a rupee amount: ${rupees}`);
  const [whole, fraction = ""] = text.split(".");
  const negative = whole.startsWith("-");
  const wholeRupees = BigInt(whole.replace("-", ""));
  const threeDecimals = (fraction + "000").slice(0, 3);
  let paisa = wholeRupees * 100n + BigInt(threeDecimals.slice(0, 2));
  if (Number(threeDecimals[2]) >= 5) paisa += 1n;
  return Number(negative ? -paisa : paisa);
}

/** Small helpers for reading untyped provider JSON without `any`. */

/** A plain JSON object (not null, not an array). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Own-property lookup, so keys like "constructor" or "__proto__" never reach Object.prototype. */
export const lookup = <V>(table: Record<string, V>, key: string): V | undefined =>
  Object.hasOwn(table, key) ? table[key] : undefined;

/** `value` when it is a string, else undefined. */
export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** `value` when it is a non-empty string, else undefined. */
export function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** `String(value)` for anything present, null for null/undefined. */
export function stringOrNull(value: unknown): string | null {
  return value === undefined || value === null ? null : String(value);
}

/** A rupee amount as providers send it: a number or a numeric string. */
export function isRupeeAmount(value: unknown): value is number | string {
  return typeof value === "number" || typeof value === "string";
}

/**
 * Any non-null object, arrays included. Use only where the original adapters accepted any object
 * body (Hamro Pay, GetPay), so behaviour stays identical; prefer isRecord everywhere else.
 */
export function isObjectLike(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

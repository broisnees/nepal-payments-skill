// Customer data (SPEC-v2 section 1): phone and email are stored only as a per-project salted hash plus a masked form.
import type { EventCustomer } from "@paynp/shared";
import { sha256Hex, toHex } from "../lib/util.ts";

/**
 * Nepali mobile numbers normalise to 10 digits starting with 9: spaces, dashes, dots and brackets go, then a
 * leading +977, 977 or 0. Anything else is kept as its digits.
 */
export function normalisePhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (/^9\d{9}$/.test(digits)) return digits;
  const local = digits.replace(/^(?:00)?977/, "").replace(/^0+/, "");
  return /^9\d{9}$/.test(local) ? local : digits;
}

export const normaliseEmail = (raw: string) => raw.trim().toLowerCase();

/** `98XXXXX123`: first 2 and last 3 digits. Short numbers are fully masked. */
export function maskPhone(normalised: string): string {
  if (normalised.length < 6) return "X".repeat(normalised.length);
  return normalised.slice(0, 2) + "X".repeat(normalised.length - 5) + normalised.slice(-3);
}

/** `n***@gmail.com`. */
export function maskEmail(normalised: string): string {
  const at = normalised.lastIndexOf("@");
  if (at < 1) return "***";
  return `${normalised[0]}***${normalised.slice(at)}`;
}

/** hex SHA-256(salt + ":" + normalised). */
export const customerHash = (salt: string, normalised: string) => sha256Hex(`${salt}:${normalised}`);

export const looksLikePhone = (q: string) => /^[+\d][\d\s().-]{5,}$/.test(q.trim()) && q.replace(/\D/g, "").length >= 7;
export const looksLikeEmail = (q: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(q.trim());

export interface HashedCustomer {
  /** Phone hash, or the email hash when there is no phone. */
  hash: string | null;
  mask: string | null;
  name: string | null;
  /** Every hash (phone and email) so either one finds the payment. */
  hashes: string[];
}

export async function hashCustomer(salt: string, c: EventCustomer | undefined): Promise<HashedCustomer | null> {
  if (!c) return null;
  const phone = c.phone ? normalisePhone(c.phone) : "";
  const email = c.email ? normaliseEmail(c.email) : "";
  const [ph, eh] = await Promise.all([phone ? customerHash(salt, phone) : null, email ? customerHash(salt, email) : null]);
  const name = c.name ? c.name.trim().slice(0, 80) || null : null;
  if (!ph && !eh && !name) return null;
  return {
    hash: ph ?? eh,
    mask: phone ? maskPhone(phone) : email ? maskEmail(email) : null,
    name,
    hashes: [ph, eh].filter((h): h is string => !!h),
  };
}

export const newSalt = () => toHex(crypto.getRandomValues(new Uint8Array(16)));

/** The project's salt, created on first use. Two writers racing both end up with the first one's salt. */
export async function projectSalt(env: Env, projectId: string, known?: string | null): Promise<string> {
  if (known) return known;
  const row = await env.DB.prepare("UPDATE projects SET salt = COALESCE(salt, ?) WHERE id = ? RETURNING salt").bind(newSalt(), projectId).first<{ salt: string }>();
  if (!row?.salt) throw new Error(`project ${projectId} not found`);
  return row.salt;
}

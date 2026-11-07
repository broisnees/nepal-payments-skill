// Money, numbers, durations and Nepal time. Everything the UI prints goes through here.
import { minorDigits } from "@paynp/shared";

export const TZ = "Asia/Kathmandu";
/** Nepal has no daylight saving: UTC+05:45 all year. */
export const NPT_OFFSET_MS = (5 * 60 + 45) * 60 * 1000;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// en-IN groups the way Nepal writes money: 1,24,999.50 (lakh, crore).
const intFmt = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });
const oneDec = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 1 });
const intFmtIntl = new Intl.NumberFormat("en", { maximumFractionDigits: 0 });

export interface MoneyParts {
  sign: string;
  int: string;
  /** Minor-unit digits without the dot; empty for currencies without one (JPY). */
  frac: string;
  /** What to print before the number: "Rs" for NPR, "$" or "€" or the ISO code for others. */
  cur: string;
}

const curLabels = new Map<string, string>();
/** "Rs" for NPR (how Nepal writes it), the narrow symbol where Intl has one ($, €, £), else the ISO code. */
export function currencyLabel(currency = "NPR"): string {
  const c = currency.toUpperCase();
  if (c === "NPR") return "Rs";
  let l = curLabels.get(c);
  if (!l) {
    try {
      l = new Intl.NumberFormat("en", { style: "currency", currency: c, currencyDisplay: "narrowSymbol" }).formatToParts(0).find((p) => p.type === "currency")?.value ?? c;
    } catch {
      l = c;
    }
    // A bare "$" is ambiguous for CAD, AUD and friends; only USD keeps it.
    if (l === "$" && c !== "USD") l = c;
    curLabels.set(c, l);
  }
  return l;
}

/** Splits an amount in minor units into display parts so the UI can dim the currency and the fraction. NPR groups
 *  in lakh and crore (en-IN); other currencies group in thousands. */
export function moneyParts(minor: number, currency = "NPR"): MoneyParts {
  const c = currency.toUpperCase();
  const digits = minorDigits(c);
  const sign = minor < 0 ? "-" : "";
  const abs = Math.abs(Math.round(minor));
  const scale = 10 ** digits;
  const fmt = c === "NPR" ? intFmt : intFmtIntl;
  return { sign, int: fmt.format(Math.floor(abs / scale)), frac: digits ? String(abs % scale).padStart(digits, "0") : "", cur: currencyLabel(c) };
}

/** "Rs 1,24,999.50", "$20.00", "€49.99". Null amounts print as a hyphen. */
export function formatMoney(minor: number | null | undefined, currency = "NPR"): string {
  if (minor === null || minor === undefined || !Number.isFinite(minor)) return "-";
  const p = moneyParts(minor, currency);
  const num = `${p.int}${p.frac ? `.${p.frac}` : ""}`;
  return p.cur.length > 1 ? `${p.sign}${p.cur} ${num}` : `${p.sign}${p.cur}${num}`;
}

/** Non-NPR revenue from an analytics revenue_by_currency map, as "$45.00 + €12.00"; "" when there is none. */
export function formatOtherCurrencies(byCurrency: Record<string, number> | undefined): string {
  return Object.entries(byCurrency ?? {})
    .filter(([c, n]) => c !== "NPR" && n !== 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([c, n]) => formatMoney(n, c))
    .join(" + ");
}

/** Short form for axes and tight spots: Rs 950, Rs 12.5K, Rs 4.2L (lakh), Rs 1.3Cr (crore). */
export function formatMoneyCompact(paisa: number | null | undefined): string {
  if (paisa === null || paisa === undefined || !Number.isFinite(paisa)) return "-";
  const rs = paisa / 100;
  const abs = Math.abs(rs);
  const sign = rs < 0 ? "-" : "";
  if (abs >= 1e7) return `${sign}Rs ${oneDec.format(abs / 1e7)}Cr`;
  if (abs >= 1e5) return `${sign}Rs ${oneDec.format(abs / 1e5)}L`;
  if (abs >= 1e3) return `${sign}Rs ${oneDec.format(abs / 1e3)}K`;
  return `${sign}Rs ${intFmt.format(abs)}`;
}

/** Parses "1,249.50" or "1249.5" into paisa. Returns null for empty or invalid input. */
export function parseRupees(input: string): number | null {
  const s = input.replace(/[,\s]/g, "").replace(/^rs\.?/i, "");
  if (!s) return null;
  if (!/^\d+(\.\d{0,2})?$/.test(s)) return null;
  const [r, p = ""] = s.split(".");
  return Number(r) * 100 + Number(p.padEnd(2, "0"));
}

export function formatCount(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "-";
  return intFmt.format(n);
}

/** 1,284 / 12.9K / 1.2M for axis ticks. */
export function formatCountCompact(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e6) return `${oneDec.format(n / 1e6)}M`;
  if (abs >= 1e4) return `${oneDec.format(n / 1e3)}K`;
  return intFmt.format(n);
}

/** Rate in 0..1 to "94.2%". */
export function formatPct(rate: number | null | undefined, digits = 1): string {
  if (rate === null || rate === undefined || !Number.isFinite(rate)) return "-";
  const v = rate * 100;
  if (v === 100 || v === 0) return `${v}%`;
  return `${v.toFixed(digits)}%`;
}

/** 412 ms, 2.41 s, 4m 12s, 2h 05m, 3d 4h. */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "-";
  const a = Math.max(0, ms);
  if (a < 1000) return `${Math.round(a)} ms`;
  // Trailing zeros dropped: 3 s, 2.4 s, 2.41 s.
  if (a < 10_000) return `${Number((a / 1000).toFixed(2))} s`;
  if (a < MIN) return `${Number((a / 1000).toFixed(1))} s`;
  if (a < HOUR) {
    const m = Math.floor(a / MIN);
    const s = Math.floor((a % MIN) / 1000);
    return `${m}m ${String(s).padStart(2, "0")}s`;
  }
  if (a < DAY) {
    const h = Math.floor(a / HOUR);
    const m = Math.floor((a % HOUR) / MIN);
    return `${h}h ${String(m).padStart(2, "0")}m`;
  }
  const d = Math.floor(a / DAY);
  const h = Math.floor((a % DAY) / HOUR);
  return `${d}d ${h}h`;
}

/** Offset from the first event of a trace: +0 ms, +412 ms, +2.41 s, +1m 05s. */
export function formatOffset(ms: number): string {
  return `+${formatDuration(ms)}`;
}

const timeFmt = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
const hmFmt = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const dayFmt = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, day: "numeric", month: "short" });
const dayYearFmt = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, day: "numeric", month: "short", year: "numeric" });

const toMs = (t: number | string | Date) => (typeof t === "number" ? t : new Date(t).getTime());

/** 14:32:05 in Nepal time. */
export function formatTime(t: number | string | Date): string {
  return timeFmt.format(toMs(t));
}

/** 14:32:05.123 in Nepal time. */
export function formatTimeMs(t: number | string | Date): string {
  const ms = toMs(t);
  return `${timeFmt.format(ms)}.${String(((ms % 1000) + 1000) % 1000).padStart(3, "0")}`;
}

/** 14:32 in Nepal time. */
export function formatHM(t: number | string | Date): string {
  return hmFmt.format(toMs(t));
}

/** 5 Nov in Nepal time. */
export function formatDay(t: number | string | Date): string {
  return dayFmt.format(toMs(t));
}

/** "5 Nov, 14:32" (same year as now) or "5 Nov 2025, 14:32". */
export function formatDateTime(t: number | string | Date, now = Date.now()): string {
  const ms = toMs(t);
  const sameYear = nptYear(ms) === nptYear(now);
  return `${(sameYear ? dayFmt : dayYearFmt).format(ms)}, ${hmFmt.format(ms)}`;
}

/** "5 Nov 2026, 14:32:05 NPT" for titles and detail views. */
export function formatFull(t: number | string | Date): string {
  const ms = toMs(t);
  return `${dayYearFmt.format(ms)}, ${timeFmt.format(ms)} NPT`;
}

function nptYear(ms: number): number {
  return new Date(ms + NPT_OFFSET_MS).getUTCFullYear();
}

/** Start of the Nepal day that contains `ms`, as epoch ms. */
export function nptStartOfDay(ms: number): number {
  return Math.floor((ms + NPT_OFFSET_MS) / DAY) * DAY - NPT_OFFSET_MS;
}

/** just now, 12s ago, 4m ago, 3h ago, 2d ago; older than a week prints the date. */
export function formatRelative(t: number | string | Date, now = Date.now()): string {
  const diff = now - toMs(t);
  if (diff < 0) return "just now";
  if (diff < 5_000) return "just now";
  if (diff < MIN) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < HOUR) return `${Math.floor(diff / MIN)}m ago`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h ago`;
  if (diff < 7 * DAY) return `${Math.floor(diff / DAY)}d ago`;
  return formatDateTime(t, now);
}

/** "eSewa" from "esewa". Unknown gateways keep their id. */
export function gatewayName(id: string): string {
  return GATEWAY_NAMES[id] ?? id;
}

const GATEWAY_NAMES: Record<string, string> = {
  esewa: "eSewa",
  khalti: "Khalti",
  fonepay: "Fonepay",
  connectips: "connectIPS",
  cybersource: "CyberSource",
  nps: "NPS",
  imepay: "IME Pay",
  nepalpay: "NEPALPAY QR",
  hamropay: "Hamro Pay",
  getpay: "GetPay (cards)",
  stripe: "Stripe",
  dodo: "Dodo Payments",
};

export function statusLabel(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Middle-truncates long ids: att_01JC8Z...K3QF. */
export function shortId(id: string, keep = 6): string {
  if (id.length <= keep * 2 + 3) return id;
  return `${id.slice(0, keep + 4)}...${id.slice(-keep)}`;
}

/**
 * Amounts as gateway statements print them, to paisa: "1,000.00", "Rs. 1,000", "NPR 1,00,000.50", "-250",
 * "(250.00)" for a refund, "1500" with `unit: "paisa"`. Null for anything that is not a number.
 */
export function parseStatementAmount(input: string | null | undefined, unit: "rupees" | "paisa" = "rupees"): number | null {
  if (input === null || input === undefined) return null;
  let s = String(input).trim();
  if (!s) return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) {
    neg = true;
    s = s.slice(1, -1);
  }
  s = s.replace(/^(?:rs\.?|npr|inr)\s*/i, "").replace(/\s*(?:rs\.?|npr)$/i, "").trim();
  if (s.startsWith("-")) {
    neg = !neg;
    s = s.slice(1).trim();
  } else if (s.endsWith("-")) {
    neg = !neg;
    s = s.slice(0, -1).trim();
  }
  s = s.replace(/^(?:rs\.?|npr)\s*/i, "");
  // Grouping commas only: 1,00,000.50 (lakh) or 100,000.50 (thousands). A comma after the decimal point is not a number.
  if (!/^\d{1,3}(?:,\d{2,3})*(?:\.\d+)?$|^\d+(?:\.\d+)?$/.test(s)) return null;
  const n = Number(s.replace(/,/g, ""));
  if (!Number.isFinite(n)) return null;
  const paisa = unit === "paisa" ? Math.round(n) : Math.round(n * 100);
  return neg ? -paisa : paisa;
}

const dateFmt = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, day: "numeric", month: "short", year: "numeric" });
const timeOfDayFmt = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" });
const monthFmt = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", month: "long", year: "numeric" });

/** "5 Nov 2026" in Nepal time. */
export function formatDate(t: number | string | Date): string {
  return dateFmt.format(toMs(t));
}

/** "12:59 PM" in Nepal time, the way a shopkeeper says it to a customer. */
export function formatClock(t: number | string | Date): string {
  return timeOfDayFmt.format(toMs(t));
}

/** Nepal calendar date of an instant as "2026-11-05", the value of an <input type="date">. */
export function nptDateValue(t: number): string {
  return new Date(t + NPT_OFFSET_MS).toISOString().slice(0, 10);
}

/** Start of a Nepal day "2026-11-05" as epoch ms; `end` gives the last millisecond of that day. Null when invalid. */
export function nptDateToMs(value: string, end = false): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const utc = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(utc)) return null;
  return utc - NPT_OFFSET_MS + (end ? DAY - 1 : 0);
}

/** "2026-11" for the Nepal month containing `t`. */
export function nptMonthValue(t: number): string {
  return nptDateValue(t).slice(0, 7);
}

/** "November 2026" from "2026-11". */
export function adMonthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return monthFmt.format(Date.UTC(y, m - 1, 1));
}

/** The `count` months ending with the one that contains `now`, newest first: ["2026-11", "2026-10", ...]. */
export function recentMonths(now: number, count: number): string[] {
  const [y, m] = nptMonthValue(now).split("-").map(Number);
  return Array.from({ length: count }, (_, i) => {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  });
}

/** Rate 0..1 as "1.84%" with two decimals, for fees. */
export function formatFeePct(rate: number | null | undefined): string {
  if (rate === null || rate === undefined || !Number.isFinite(rate)) return "-";
  return `${(rate * 100).toFixed(2)}%`;
}

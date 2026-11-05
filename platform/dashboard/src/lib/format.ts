// Money, numbers, durations and Nepal time. Everything the UI prints goes through here.

export const TZ = "Asia/Kathmandu";
/** Nepal has no daylight saving: UTC+05:45 all year. */
export const NPT_OFFSET_MS = (5 * 60 + 45) * 60 * 1000;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// en-IN groups the way Nepal writes money: 1,24,999.50 (lakh, crore).
const intFmt = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });
const oneDec = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 1 });

export interface MoneyParts {
  sign: string;
  int: string;
  frac: string;
}

/** Splits paisa into display parts so the UI can dim the currency and the paisa. */
export function moneyParts(paisa: number): MoneyParts {
  const sign = paisa < 0 ? "-" : "";
  const abs = Math.abs(Math.round(paisa));
  return { sign, int: intFmt.format(Math.floor(abs / 100)), frac: String(abs % 100).padStart(2, "0") };
}

/** "Rs 1,24,999.50". Null amounts print as a hyphen. */
export function formatMoney(paisa: number | null | undefined): string {
  if (paisa === null || paisa === undefined || !Number.isFinite(paisa)) return "-";
  const p = moneyParts(paisa);
  return `${p.sign}Rs ${p.int}.${p.frac}`;
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
};

export function statusLabel(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Middle-truncates long ids: att_01JC8Z...K3QF. */
export function shortId(id: string, keep = 6): string {
  if (id.length <= keep * 2 + 3) return id;
  return `${id.slice(0, keep + 4)}...${id.slice(-keep)}`;
}

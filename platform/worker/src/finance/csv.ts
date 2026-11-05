// CSV reading and writing plus the amount and date formats found in Nepali merchant statements.
import { NEPAL_OFFSET_MS, fromBs } from "@paynp/shared";

/** Parses CSV text into records. Handles a BOM, quoted fields with "" escapes, CRLF/LF/CR and , ; or tab delimiters. */
export function parseCsv(text: string): string[][] {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const delim = detectDelimiter(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      cell += ch;
      i++;
      continue;
    }
    if (ch === '"' && cell.trim() === "") {
      quoted = true;
      cell = "";
      i++;
      continue;
    }
    if (ch === delim) {
      row.push(cell.trim());
      cell = "";
      i++;
      continue;
    }
    if (ch === "\r" || ch === "\n") {
      row.push(cell.trim());
      rows.push(row);
      row = [];
      cell = "";
      i += ch === "\r" && text[i + 1] === "\n" ? 2 : 1;
      continue;
    }
    cell += ch;
    i++;
  }
  if (cell !== "" || row.length) {
    row.push(cell.trim());
    rows.push(row);
  }
  return rows;
}

function detectDelimiter(text: string): string {
  const sample = text.slice(0, 8192).split(/\r\n|\n|\r/).slice(0, 30);
  let best = ",";
  let bestScore = 0;
  for (const d of [",", ";", "\t"]) {
    let score = 0;
    for (const line of sample) score += countOutsideQuotes(line, d);
    if (score > bestScore) {
      best = d;
      bestScore = score;
    }
  }
  return best;
}

function countOutsideQuotes(line: string, d: string): number {
  let q = false;
  let c = 0;
  for (const ch of line) {
    if (ch === '"') q = !q;
    else if (!q && ch === d) c++;
  }
  return c;
}

const DEVANAGARI_ZERO = 0x0966;
/** "१,२५०.००" to "1,250.00". */
export const westernDigits = (s: string) => s.replace(/[०-९]/g, (d) => String(d.charCodeAt(0) - DEVANAGARI_ZERO));

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Money to paisa. Accepts "1,000.00", "Rs. 1,000", "NPR 1500", "रु 1,500", lakh grouping "1,00,000.50",
 * Devanagari digits, negatives as "-500", "500-" or "(500)". Rupees are rounded half up to whole paisa.
 * Empty input is { ok: true, value: null }.
 */
export function parseAmount(input: string | undefined, unit: "rupees" | "paisa" = "rupees"): Parsed<number | null> {
  let s = westernDigits((input ?? "").trim());
  if (!s) return { ok: true, value: null };
  if (s.length > 40) return { ok: false, error: "amount too long" };
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1).trim();
  }
  s = s.replace(/^(?:rs\.?|npr\.?|nrs\.?|रु\.?|रू\.?)\s*/i, "").replace(/\s*(?:rs\.?|npr|nrs)$/i, "").trim();
  if (s.startsWith("-")) {
    negative = !negative;
    s = s.slice(1).trim();
  } else if (s.startsWith("+")) s = s.slice(1).trim();
  if (s.endsWith("-")) {
    negative = !negative;
    s = s.slice(0, -1).trim();
  }
  s = s.replace(/^(?:rs\.?|npr\.?|nrs\.?|रु\.?|रू\.?)\s*/i, "");
  // Thousands separators: commas (western or lakh grouping) and spaces between digit groups.
  if (!/^\d{1,3}(?:[, ]?\d{2,3})*(?:\.\d+)?$|^\d*\.\d+$/.test(s)) return { ok: false, error: `not an amount: ${JSON.stringify(input)}` };
  s = s.replace(/[, ]/g, "");
  const [whole, frac = ""] = s.split(".");
  let paisa: number;
  if (unit === "paisa") {
    if (/[1-9]/.test(frac)) return { ok: false, error: `paisa amounts must be whole numbers: ${JSON.stringify(input)}` };
    paisa = Number(whole || "0");
  } else {
    const f = (frac + "000").slice(0, 3);
    paisa = Number(whole || "0") * 100 + Number(f.slice(0, 2)) + (Number(f[2]) >= 5 ? 1 : 0);
  }
  if (!Number.isSafeInteger(paisa)) return { ok: false, error: `amount too large: ${JSON.stringify(input)}` };
  return { ok: true, value: negative && paisa !== 0 ? -paisa : paisa };
}

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const TIME = String.raw`(?:[ T,]+(\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?\s*([ap]\.?m\.?)?)?\s*(Z|[+-]\d{2}:?\d{2})?`;
const RE_YMD = new RegExp(String.raw`^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})${TIME}$`, "i");
const RE_NUM = new RegExp(String.raw`^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})${TIME}$`, "i");
const RE_DMONY = new RegExp(String.raw`^(\d{1,2})[-/ ]([a-z]{3,9})[-/ ,]+(\d{2}|\d{4})${TIME}$`, "i");
const RE_MONDY = new RegExp(String.raw`^([a-z]{3,9})[ .]+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})${TIME}$`, "i");

export type DateOrder = "dmy" | "mdy";

/** For a column of dates, which way round a numeric d/m/y is: "mdy" only when some value only works that way. */
export function detectDateOrder(values: string[]): DateOrder {
  for (const v of values) {
    const m = RE_NUM.exec(westernDigits(v.trim()));
    if (!m) continue;
    if (Number(m[1]) > 12) return "dmy";
    if (Number(m[2]) > 12) return "mdy";
  }
  return "dmy";
}

/**
 * A statement date to epoch ms. Times without a zone are Nepal time (UTC+05:45). Years from 2070 in Y-M-D form are
 * read as Bikram Sambat (within the calendar table). Empty input is { ok: true, value: null }.
 */
export function parseDate(input: string | undefined, order: DateOrder = "dmy"): Parsed<number | null> {
  const s = westernDigits((input ?? "").trim()).replace(/\s+/g, " ");
  if (!s) return { ok: true, value: null };
  let y: number, mo: number, d: number, rest: string[];
  let m = RE_YMD.exec(s);
  if (m) {
    [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    rest = m.slice(4);
  } else if ((m = RE_NUM.exec(s))) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    [d, mo] = order === "mdy" ? [b, a] : [a, b];
    y = Number(m[3]);
    rest = m.slice(4);
  } else if ((m = RE_DMONY.exec(s)) && MONTHS[m[2].toLowerCase().slice(0, 3)] !== undefined) {
    [d, mo, y] = [Number(m[1]), MONTHS[m[2].toLowerCase().slice(0, 3)], Number(m[3])];
    rest = m.slice(4);
  } else if ((m = RE_MONDY.exec(s)) && MONTHS[m[1].toLowerCase().slice(0, 3)] !== undefined) {
    [mo, d, y] = [MONTHS[m[1].toLowerCase().slice(0, 3)], Number(m[2]), Number(m[3])];
    rest = m.slice(4);
  } else {
    return { ok: false, error: `not a date: ${JSON.stringify(input)}` };
  }
  if (y < 100) y += 2000;
  let hh = rest[0] ? Number(rest[0]) : 0;
  const mm = rest[1] ? Number(rest[1]) : 0;
  const ss = rest[2] ? Number(rest[2]) : 0;
  const ms = rest[3] ? Number((rest[3] + "00").slice(0, 3)) : 0;
  const ampm = rest[4]?.toLowerCase().replace(/\./g, "");
  if (ampm) {
    if (hh < 1 || hh > 12) return { ok: false, error: `bad 12-hour time: ${JSON.stringify(input)}` };
    hh = (hh % 12) + (ampm === "pm" ? 12 : 0);
  }
  if (hh > 23 || mm > 59 || ss > 59) return { ok: false, error: `bad time: ${JSON.stringify(input)}` };
  const timeMs = ((hh * 60 + mm) * 60 + ss) * 1000 + ms;
  const zone = rest[5];
  let dayStartUtc: number;
  if (y >= 2070 && y <= 2099) {
    const bs = fromBs(y, mo, d);
    if (bs === null) return { ok: false, error: `Bikram Sambat date outside the supported range: ${JSON.stringify(input)}` };
    dayStartUtc = bs + NEPAL_OFFSET_MS;
  } else {
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return { ok: false, error: `not a date: ${JSON.stringify(input)}` };
    dayStartUtc = Date.UTC(y, mo - 1, d);
    if (new Date(dayStartUtc).getUTCDate() !== d) return { ok: false, error: `no such day: ${JSON.stringify(input)}` };
  }
  let offset = NEPAL_OFFSET_MS;
  if (zone) {
    if (zone.toUpperCase() === "Z") offset = 0;
    else {
      const z = /^([+-])(\d{2}):?(\d{2})$/.exec(zone)!;
      offset = (z[1] === "-" ? -1 : 1) * (Number(z[2]) * 60 + Number(z[3])) * 60_000;
    }
  }
  return { ok: true, value: dayStartUtc + timeMs - offset };
}

// ------------------------------------------------------------------ writing

/** One CSV cell. Text cells that a spreadsheet would run as a formula get a leading apostrophe. */
export function csvCell(v: string | number | null | undefined, text = true): string {
  if (v === null || v === undefined) return "";
  let s = String(v);
  if (text && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Rows to CSV text with CRLF line ends (RFC 4180). Columns listed in `numeric` (and number values) are written as-is;
 * other strings get the formula guard. `comment` becomes a leading "# ..." line.
 */
export function toCsv(header: string[], rows: (string | number | null | undefined)[][], opts: { comment?: string; numeric?: number[] } = {}): string {
  const num = new Set(opts.numeric ?? []);
  const lines: string[] = [];
  if (opts.comment) lines.push(`# ${opts.comment}`);
  lines.push(header.map((h) => csvCell(h)).join(","));
  for (const r of rows) lines.push(r.map((v, i) => csvCell(v, typeof v !== "number" && !num.has(i))).join(","));
  return lines.join("\r\n") + "\r\n";
}

/** Paisa to "1500.00" (no grouping, so spreadsheets read it as a number). */
export function rupees(paisa: number | null | undefined): string {
  if (paisa === null || paisa === undefined) return "";
  const neg = paisa < 0;
  const a = Math.abs(paisa);
  return `${neg ? "-" : ""}${Math.floor(a / 100)}.${String(a % 100).padStart(2, "0")}`;
}

/** "2025-07-17 14:03:22" in Nepal time. */
export function nptDateTime(ms: number): string {
  return new Date(ms + NEPAL_OFFSET_MS).toISOString().slice(0, 19).replace("T", " ");
}

/** "2025-07-17" in Nepal time. */
export const nptDate = (ms: number) => new Date(ms + NEPAL_OFFSET_MS).toISOString().slice(0, 10);

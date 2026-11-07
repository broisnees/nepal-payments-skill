// Public gateway status (SPEC-v2 4.6): turns status_minutes into states, sparklines, uptime bars, peak hours and
// incidents. Privacy: a gateway minute is used only when at least MIN_PROJECTS distinct projects sent traffic in it,
// and nothing here exposes request volumes, only rates and latency.
import { GATEWAYS, NEPAL_OFFSET_MS, type GatewayState, type GatewayStatus, type StatusIncident, type StatusPoint, type StatusReport } from "@paynp/shared";
import { DAY, HOUR, MINUTE } from "../lib/util.ts";
import { BUCKETS, H_COLS, addHist, emptyHist, p95 } from "./buckets.ts";

export const MIN_PROJECTS = 3;
/** A minute is unhealthy when more than 20% of requests failed or p95 latency is over 5 s. */
export const BAD_ERROR_RATE = 0.2;
export const BAD_P95_MS = 5000;
/** Incidents: unhealthy minutes for at least 5 minutes, allowing up to 2 minutes without data inside a run. */
export const INCIDENT_MIN_MINUTES = 5;
export const INCIDENT_MAX_GAP = 3;
export const STATE_WINDOW_MIN = 15;
export const UPTIME_DAYS = 90;

export const GATEWAY_NAMES: Record<string, string> = {
  esewa: "eSewa",
  khalti: "Khalti",
  fonepay: "Fonepay",
  connectips: "connectIPS",
  cybersource: "CyberSource (cards)",
  nps: "NPS",
  imepay: "IME Pay",
  nepalpay: "NEPALPAY QR",
  hamropay: "Hamro Pay",
  getpay: "GetPay (cards)",
};
export const STATUS_GATEWAYS: readonly string[] = GATEWAYS;

export interface MinuteRow {
  gateway: string;
  minute: number;
  requests: number;
  errors: number;
  samples: number;
  ms_total: number;
  ms_max: number;
  hist: number[];
}

/** SQL columns for MinuteRow, from status_minutes. */
export const MINUTE_COLS = `gateway, minute, requests, errors, samples, ms_total, ms_max, ${H_COLS.join(", ")}`;

export function toMinute(r: Record<string, unknown>): MinuteRow {
  return {
    gateway: String(r.gateway),
    minute: Number(r.minute),
    requests: Number(r.requests),
    errors: Number(r.errors),
    samples: Number(r.samples),
    ms_total: Number(r.ms_total),
    ms_max: Number(r.ms_max),
    hist: H_COLS.map((h) => Number(r[h] ?? 0)),
  };
}

export const nptDay = (ms: number) => Math.floor((ms + NEPAL_OFFSET_MS) / DAY);
export const nptHour = (ms: number) => Math.floor((ms + NEPAL_OFFSET_MS) / HOUR) % 24;
export const dayLabel = (day: number) => new Date(day * DAY).toISOString().slice(0, 10);

export const errorRate = (m: Pick<MinuteRow, "requests" | "errors">) => (m.requests ? m.errors / m.requests : 0);
export const minuteP95 = (m: Pick<MinuteRow, "hist" | "ms_max">) => p95(m.hist, m.ms_max);
export function isBad(m: MinuteRow): boolean {
  const p = minuteP95(m);
  return errorRate(m) > BAD_ERROR_RATE || (p !== null && p > BAD_P95_MS);
}

/** What merge needs: a minute row or an hour row. */
export type Counts = Pick<MinuteRow, "requests" | "errors" | "samples" | "ms_total" | "ms_max" | "hist">;

/** Merged rate and p95 over a set of minutes (or hours). */
export function merge(ms: readonly Counts[]): { error_rate: number | null; p95_ms: number | null; avg_ms: number | null } {
  if (!ms.length) return { error_rate: null, p95_ms: null, avg_ms: null };
  let req = 0;
  let err = 0;
  let samples = 0;
  let total = 0;
  let max = 0;
  const h = emptyHist();
  for (const m of ms) {
    req += m.requests;
    err += m.errors;
    samples += m.samples;
    total += m.ms_total;
    max = Math.max(max, m.ms_max);
    addHist(h, m.hist);
  }
  return { error_rate: req ? err / req : null, p95_ms: p95(h, max), avg_ms: samples ? Math.round(total / samples) : null };
}

export function stateOf(window: readonly MinuteRow[]): GatewayState {
  if (!window.length) return "no_data";
  const { error_rate, p95_ms } = merge(window);
  if ((error_rate ?? 0) >= 0.5) return "down";
  if ((error_rate ?? 0) >= 0.1 || (p95_ms ?? 0) > BAD_P95_MS) return "degraded";
  return "operational";
}

/** Hours JSON in status_days: per Nepal hour [samples, ms_total, max, h0..h8]. */
export type HourCell = number[];
export interface DayRollup {
  gateway: string;
  day: number;
  shown_minutes: number;
  ok_minutes: number;
  hours: HourCell[];
}

// ---- hours
// A report covers 48 h. Reading 48 h of minute rows per build (10 gateways x 2880 rows) was most of the account's
// D1 reads, so closed hours are summarised once into *_hours rows (rollupRecentHours, hourly from the cron) and a
// report reads 48 hour rows per gateway plus the minutes of the open hour. Hours are aligned to Nepal time (they
// start at :15 UTC), so days and peak hours split on whole hours. An hour row keeps each shown minute's health as a
// Mark, which is all incident detection needs, so reports from hours equal reports from minutes.

/** Nepal-aligned hour index of an epoch minute; nptDay = floor(hour / 24) and the Nepal hour of day = hour % 24. */
export const hourOf = (minute: number) => Math.floor((minute * MINUTE + NEPAL_OFFSET_MS) / HOUR);
export const hourStartMinute = (hour: number) => (hour * HOUR - NEPAL_OFFSET_MS) / MINUTE;
/** Marks an hour as rolled up even when no gateway had data in it, so it is not re-read every run. */
export const HOUR_SENTINEL = "*";

/** One shown minute, as much as incident detection needs. */
export interface Mark {
  gateway: string;
  minute: number;
  bad: boolean;
  err: number;
  p95: number | null;
}
export const markOf = (m: MinuteRow): Mark => ({ gateway: m.gateway, minute: m.minute, bad: isBad(m), err: errorRate(m), p95: minuteP95(m) });

export interface HourRow extends Counts {
  gateway: string;
  hour: number;
  shown_minutes: number;
  ok_minutes: number;
  /** Every shown minute of the hour, in time order. */
  marks: Mark[];
}

/** Groups minutes into hour rows (pure). Associative: rolling up hours then merging equals merging the minutes. */
export function rollupHours(minutes: readonly MinuteRow[]): HourRow[] {
  const m = new Map<string, HourRow>();
  for (const r of [...minutes].sort((a, b) => a.minute - b.minute)) {
    const hour = hourOf(r.minute);
    const k = `${r.gateway}|${hour}`;
    let h = m.get(k);
    if (!h) m.set(k, (h = { gateway: r.gateway, hour, requests: 0, errors: 0, samples: 0, ms_total: 0, ms_max: 0, hist: emptyHist(), shown_minutes: 0, ok_minutes: 0, marks: [] }));
    h.requests += r.requests;
    h.errors += r.errors;
    h.samples += r.samples;
    h.ms_total += r.ms_total;
    h.ms_max = Math.max(h.ms_max, r.ms_max);
    addHist(h.hist, r.hist);
    const mark = markOf(r);
    h.shown_minutes++;
    if (!mark.bad) h.ok_minutes++;
    h.marks.push(mark);
  }
  return [...m.values()];
}

/** marks column: { s: 60 chars, "." no data / "o" ok / "x" bad, b: [[minute offset, error rate, p95]] for bad minutes }. */
export function encodeMarks(hour: number, marks: readonly Mark[]): string {
  const start = hourStartMinute(hour);
  const s = new Array<string>(60).fill(".");
  const b: [number, number, number | null][] = [];
  for (const m of marks) {
    const off = m.minute - start;
    s[off] = m.bad ? "x" : "o";
    if (m.bad) b.push([off, Math.round(m.err * 1e6) / 1e6, m.p95]);
  }
  return JSON.stringify({ s: s.join(""), b });
}

export function decodeMarks(gateway: string, hour: number, text: string): Mark[] {
  let v: { s?: string; b?: [number, number, number | null][] } = {};
  try {
    v = JSON.parse(text);
  } catch {
    return [];
  }
  const start = hourStartMinute(hour);
  const bad = new Map((v.b ?? []).map(([off, err, p]) => [off, { err, p95: p }]));
  const out: Mark[] = [];
  [...(v.s ?? "")].forEach((c, off) => {
    if (c === "o") out.push({ gateway, minute: start + off, bad: false, err: 0, p95: null });
    else if (c === "x") out.push({ gateway, minute: start + off, bad: true, err: bad.get(off)?.err ?? 0, p95: bad.get(off)?.p95 ?? null });
  });
  return out;
}

/** SQL columns of *_hours, in insert order. */
const HOUR_COLS = ["gateway", "hour", "requests", "errors", "samples", "ms_total", "ms_max", ...H_COLS, "shown_minutes", "ok_minutes", "marks"];

export function toHour(r: Record<string, unknown>): HourRow {
  const gateway = String(r.gateway);
  const hour = Number(r.hour);
  return {
    gateway,
    hour,
    requests: Number(r.requests),
    errors: Number(r.errors),
    samples: Number(r.samples),
    ms_total: Number(r.ms_total),
    ms_max: Number(r.ms_max),
    hist: H_COLS.map((h) => Number(r[h] ?? 0)),
    shown_minutes: Number(r.shown_minutes),
    ok_minutes: Number(r.ok_minutes),
    marks: decodeMarks(gateway, hour, String(r.marks ?? "")),
  };
}

export function daysFromHours(hours: readonly HourRow[]): DayRollup[] {
  const m = new Map<string, DayRollup>();
  for (const h of hours) {
    const day = Math.floor(h.hour / 24);
    const k = `${h.gateway}|${day}`;
    let d = m.get(k);
    if (!d) m.set(k, (d = { gateway: h.gateway, day, shown_minutes: 0, ok_minutes: 0, hours: Array.from({ length: 24 }, () => new Array<number>(3 + BUCKETS).fill(0)) }));
    d.shown_minutes += h.shown_minutes;
    d.ok_minutes += h.ok_minutes;
    const cell = d.hours[((h.hour % 24) + 24) % 24];
    cell[0] += h.samples;
    cell[1] += h.ms_total;
    cell[2] = Math.max(cell[2], h.ms_max);
    for (let i = 0; i < BUCKETS; i++) cell[3 + i] += h.hist[i];
  }
  return [...m.values()];
}

export const rollupDays = (minutes: readonly MinuteRow[]): DayRollup[] => daysFromHours(rollupHours(minutes));

/** Runs of unhealthy minutes (gaps of up to 2 empty minutes allowed, a healthy minute ends a run) of >= 5 minutes. */
export function incidentsFromMarks(marks: readonly Mark[], nowMinute: number): (StatusIncident & { gateway: string })[] {
  const byGw = new Map<string, Mark[]>();
  for (const r of marks) {
    if (!byGw.has(r.gateway)) byGw.set(r.gateway, []);
    byGw.get(r.gateway)!.push(r);
  }
  const out: (StatusIncident & { gateway: string })[] = [];
  for (const [gateway, list] of byGw) {
    list.sort((a, b) => a.minute - b.minute);
    let run: Mark[] = [];
    const close = () => {
      if (!run.length) return;
      const first = run[0].minute;
      const last = run[run.length - 1].minute;
      if (last - first + 1 >= INCIDENT_MIN_MINUTES) {
        const errs = run.some((r) => r.err > BAD_ERROR_RATE);
        const slow = run.some((r) => (r.p95 ?? 0) > BAD_P95_MS);
        const p95s = run.map((r) => r.p95).filter((x): x is number => x !== null);
        out.push({
          gateway,
          started_at: first * MINUTE,
          ended_at: (last + 1) * MINUTE,
          minutes: last - first + 1,
          kind: errs && slow ? "errors_and_latency" : errs ? "errors" : "latency",
          peak_error_rate: Math.max(...run.map((r) => r.err)),
          peak_p95_ms: p95s.length ? Math.max(...p95s) : null,
          ongoing: nowMinute - last <= INCIDENT_MAX_GAP,
        });
      }
      run = [];
    };
    for (const r of list) {
      if (!r.bad) {
        close();
        continue;
      }
      if (run.length && r.minute - run[run.length - 1].minute > INCIDENT_MAX_GAP) close();
      run.push(r);
    }
    close();
  }
  return out.sort((a, b) => b.started_at - a.started_at);
}

export const detectIncidents = (minutes: readonly MinuteRow[], nowMinute: number) => incidentsFromMarks(minutes.map(markOf), nowMinute);

export interface StoredDay {
  gateway: string;
  day: number;
  shown_minutes: number;
  ok_minutes: number;
  hours: string;
}

export interface StoredIncident {
  gateway: string;
  started_minute: number;
  ended_minute: number;
  kind: string;
  peak_error_rate: number;
  peak_p95_ms: number | null;
}

/** First minute of the 48 h a report covers, rounded down to a whole Nepal hour. */
export const windowStart = (nowMinute: number) => hourStartMinute(hourOf(nowMinute - 48 * 60));

/**
 * Pure: the report from the last 48 h plus stored day rollups and incidents. The 48 h come from stored hour rows and
 * from minutes; a minute whose hour has a stored row is used only for the current state (last 15 minutes).
 */
export function buildReport(t: number, recent: readonly MinuteRow[], days: readonly StoredDay[], stored: readonly StoredIncident[], storedHours: readonly HourRow[] = []): StatusReport {
  const nowMinute = Math.floor(t / MINUTE);
  const today = nptDay(t);
  const recentStart = windowStart(nowMinute);
  const rolled = new Set(storedHours.map((h) => `${h.gateway}|${h.hour}`));
  const rolledHours = new Set(storedHours.map((h) => h.hour));
  const hourRows = [
    ...storedHours.filter((h) => h.gateway !== HOUR_SENTINEL && h.hour >= hourOf(recentStart)),
    ...rollupHours(recent.filter((m) => m.minute >= recentStart && !rolled.has(`${m.gateway}|${hourOf(m.minute)}`) && !rolledHours.has(hourOf(m.minute)))),
  ];
  // Days fully inside the window (yesterday and today) come from hours; older days from the daily rollup.
  const freshDays = new Map<string, DayRollup>();
  for (const d of daysFromHours(hourRows)) if (d.day * DAY - NEPAL_OFFSET_MS >= recentStart * MINUTE) freshDays.set(`${d.gateway}|${d.day}`, d);
  const firstFresh = Math.ceil((recentStart * MINUTE + NEPAL_OFFSET_MS) / DAY);
  const storedDays = new Map<string, DayRollup>();
  for (const d of days) {
    if (d.day >= firstFresh) continue;
    let hours: HourCell[] = [];
    try {
      hours = JSON.parse(d.hours) as HourCell[];
    } catch {
      hours = [];
    }
    storedDays.set(`${d.gateway}|${d.day}`, { gateway: d.gateway, day: d.day, shown_minutes: d.shown_minutes, ok_minutes: d.ok_minutes, hours });
  }
  const dayOf = (gw: string, day: number) => freshDays.get(`${gw}|${day}`) ?? storedDays.get(`${gw}|${day}`);

  const live = incidentsFromMarks(hourRows.flatMap((h) => h.marks), nowMinute);
  // 24 Nepal hours, the last one the hour in progress.
  const curHour = hourOf(nowMinute);

  const gateways: GatewayStatus[] = STATUS_GATEWAYS.map((gw) => {
    const window = recent.filter((r) => r.gateway === gw && r.minute > nowMinute - STATE_WINDOW_MIN && r.minute <= nowMinute);
    const now15 = merge(window);
    const byHour = new Map(hourRows.filter((h) => h.gateway === gw).map((h) => [h.hour, h]));
    const last_24h: StatusPoint[] = [];
    for (let i = 0; i < 24; i++) {
      const h = curHour - 23 + i;
      const row = byHour.get(h);
      const m = merge(row ? [row] : []);
      last_24h.push({ t: hourStartMinute(h) * MINUTE, error_rate: m.error_rate, p95_ms: m.p95_ms });
    }
    let shown = 0;
    let ok = 0;
    const uptime_90d = [];
    for (let d = today - UPTIME_DAYS + 1; d <= today; d++) {
      const r = dayOf(gw, d);
      if (r && r.shown_minutes) {
        shown += r.shown_minutes;
        ok += r.ok_minutes;
      }
      uptime_90d.push({ date: dayLabel(d), uptime: r && r.shown_minutes ? r.ok_minutes / r.shown_minutes : null });
    }
    const hours = Array.from({ length: 24 }, () => new Array<number>(3 + BUCKETS).fill(0));
    for (let d = today - 7; d < today; d++) {
      const r = dayOf(gw, d);
      if (!r) continue;
      r.hours.forEach((cell, h) => {
        if (!Array.isArray(cell)) return;
        hours[h][0] += cell[0] ?? 0;
        hours[h][1] += cell[1] ?? 0;
        hours[h][2] = Math.max(hours[h][2], cell[2] ?? 0);
        for (let i = 0; i < BUCKETS; i++) hours[h][3 + i] += cell[3 + i] ?? 0;
      });
    }
    const peak_hours = hours.map((c, hour) => ({ hour, avg_ms: c[0] ? Math.round(c[1] / c[0]) : null, p95_ms: p95(c.slice(3), c[2]) }));
    const liveInc = live.filter((i) => i.gateway === gw);
    const old = stored
      .filter((s) => s.gateway === gw && !liveInc.some((l) => s.started_minute * MINUTE < l.ended_at && s.ended_minute * MINUTE > l.started_at))
      .map(
        (s): StatusIncident => ({
          started_at: s.started_minute * MINUTE,
          ended_at: s.ended_minute * MINUTE,
          minutes: s.ended_minute - s.started_minute,
          kind: s.kind as StatusIncident["kind"],
          peak_error_rate: s.peak_error_rate,
          peak_p95_ms: s.peak_p95_ms,
          ongoing: false,
        }),
      );
    const incidents = [...liveInc.map(({ gateway: _g, ...i }) => i), ...old].sort((a, b) => b.started_at - a.started_at);
    return {
      gateway: gw,
      name: GATEWAY_NAMES[gw] ?? gw,
      state: stateOf(window),
      error_rate: now15.error_rate,
      p95_ms: now15.p95_ms,
      last_24h,
      uptime_90d,
      uptime_90d_pct: shown ? ok / shown : null,
      peak_hours,
      incidents,
    };
  });
  return { generated_at: t, min_projects: MIN_PROJECTS, gateways };
}

/**
 * Where a report's minutes, day rollups and incidents live, and how many sources a minute needs to count.
 * CROWD is merchant traffic through ingest (a minute counts with 3+ projects); PROBES is the status site's own
 * once-a-minute calls to each gateway's production API (platform/status).
 */
export interface StatusSource {
  minutes: string;
  /** Hour summaries of `minutes` (rollupRecentHours). */
  hours: string;
  days: string;
  incidents: string;
  minProjects: number;
}
export const CROWD: StatusSource = { minutes: "status_minutes", hours: "status_hours", days: "status_days", incidents: "status_incidents", minProjects: MIN_PROJECTS };
export const PROBES: StatusSource = { minutes: "probe_minutes", hours: "probe_hours", days: "probe_days", incidents: "probe_incidents", minProjects: 1 };

/**
 * Reads what buildReport needs in one batch: the window's hour rows (about 49 per gateway), the minutes after the last
 * rolled-up hour plus the last 15 (about 75 per gateway), and 90 days of day rollups and incidents.
 * test/read-budget.test.ts holds it to its row budget.
 */
export async function loadReport(env: Env, t: number, src: StatusSource = CROWD): Promise<StatusReport> {
  const nowMinute = Math.floor(t / MINUTE);
  const start = windowStart(nowMinute);
  const firstHour = hourOf(start);
  const offMin = NEPAL_OFFSET_MS / MINUTE;
  const [hours, recent, days, incidents] = await env.DB.batch([
    env.DB.prepare(`SELECT ${HOUR_COLS.join(", ")} FROM ${src.hours} WHERE hour >= ?`).bind(firstHour),
    env.DB.prepare(
      // One lower bound, so the minute index range starts at it (a second bound would only filter a full-window scan).
      `SELECT ${MINUTE_COLS} FROM ${src.minutes}
       WHERE minute >= MAX(?1, MIN(?4, COALESCE((SELECT (MAX(hour) + 1) * 60 - ${offMin} FROM ${src.hours} WHERE hour >= ?5), ?1)))
         AND minute <= ?2 AND projects >= ?3`,
    ).bind(start, nowMinute, src.minProjects, nowMinute - STATE_WINDOW_MIN + 1, firstHour),
    env.DB.prepare(`SELECT gateway, day, shown_minutes, ok_minutes, hours FROM ${src.days} WHERE day > ?`).bind(nptDay(t) - UPTIME_DAYS - 1),
    env.DB.prepare(`SELECT gateway, started_minute, ended_minute, kind, peak_error_rate, peak_p95_ms FROM ${src.incidents} WHERE ended_minute > ? ORDER BY started_minute DESC LIMIT 500`).bind(
      nowMinute - UPTIME_DAYS * 1440,
    ),
  ]);
  return buildReport(
    t,
    (recent.results as Record<string, unknown>[]).map(toMinute),
    days.results as StoredDay[],
    incidents.results as StoredIncident[],
    (hours.results as Record<string, unknown>[]).map(toHour),
  );
}

/**
 * Hourly (cron.ts): summarises every closed hour of the last 48 h that has no row yet, from its minutes, plus a
 * sentinel row so an hour without data is not looked at again. Steady state reads the hour index (about 530 rows)
 * and one hour of minutes. Keeps 4 days of hour rows.
 */
export async function rollupRecentHours(env: Env, t: number, src: StatusSource = CROWD): Promise<{ hours: number; rows: number }> {
  const nowMinute = Math.floor(t / MINUTE);
  const cur = hourOf(nowMinute);
  const first = hourOf(windowStart(nowMinute));
  const have = await env.DB.prepare(`SELECT DISTINCT hour FROM ${src.hours} WHERE hour >= ?`).bind(first).all<{ hour: number }>();
  const done = new Set(have.results.map((r) => r.hour));
  const missing: number[] = [];
  for (let h = first; h < cur; h++) if (!done.has(h)) missing.push(h);
  const stmts: D1PreparedStatement[] = [env.DB.prepare(`DELETE FROM ${src.hours} WHERE hour < ?`).bind(cur - 4 * 24)];
  let rows: HourRow[] = [];
  if (missing.length) {
    const want = new Set(missing);
    const minutes = await env.DB.prepare(`SELECT ${MINUTE_COLS} FROM ${src.minutes} WHERE minute >= ? AND minute < ? AND projects >= ?`)
      .bind(hourStartMinute(missing[0]), hourStartMinute(missing[missing.length - 1] + 1), src.minProjects)
      .all<Record<string, unknown>>();
    rows = rollupHours(minutes.results.map(toMinute)).filter((h) => want.has(h.hour));
    const sentinels = missing.map((hour): HourRow => ({ gateway: HOUR_SENTINEL, hour, requests: 0, errors: 0, samples: 0, ms_total: 0, ms_max: 0, hist: emptyHist(), shown_minutes: 0, ok_minutes: 0, marks: [] }));
    const all = [...rows, ...sentinels].map((h) => [h.gateway, h.hour, h.requests, h.errors, h.samples, h.ms_total, h.ms_max, ...h.hist, h.shown_minutes, h.ok_minutes, encodeMarks(h.hour, h.marks)]);
    // One statement per 500 rows keeps the bound JSON well under D1's limits.
    for (let i = 0; i < all.length; i += 500) {
      stmts.push(
        env.DB.prepare(
          `INSERT OR REPLACE INTO ${src.hours} (${HOUR_COLS.join(", ")}) SELECT ${HOUR_COLS.map((_, k) => `json_extract(value, '$[${k}]')`).join(", ")} FROM json_each(?)`,
        ).bind(JSON.stringify(all.slice(i, i + 500))),
      );
    }
  }
  await env.DB.batch(stmts);
  return { hours: missing.length, rows: rows.length };
}

/** Daily cron: roll up the last 3 complete Nepal days, store incidents from them, and keep 90 days of minutes. */
export async function rollupStatus(env: Env, t: number, src: StatusSource = CROWD): Promise<{ days: number; incidents: number; minutes_deleted: number }> {
  const today = nptDay(t);
  const from = (today - 3) * DAY - NEPAL_OFFSET_MS;
  const to = today * DAY - NEPAL_OFFSET_MS;
  const rows = await env.DB.prepare(`SELECT ${MINUTE_COLS} FROM ${src.minutes} WHERE minute >= ? AND minute < ? AND projects >= ?`)
    .bind(from / MINUTE, to / MINUTE, src.minProjects)
    .all<Record<string, unknown>>();
  const minutes = rows.results.map(toMinute);
  const days = rollupDays(minutes);
  const incidents = detectIncidents(minutes, Math.floor(t / MINUTE));
  const stmts: D1PreparedStatement[] = [];
  if (days.length) {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO ${src.days} (gateway, day, shown_minutes, ok_minutes, hours, computed_at)
         SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]'), json_extract(value, '$[3]'), json_extract(value, '$[4]'), ?2
         FROM json_each(?1) WHERE true
         ON CONFLICT (gateway, day) DO UPDATE SET shown_minutes = excluded.shown_minutes, ok_minutes = excluded.ok_minutes, hours = excluded.hours, computed_at = excluded.computed_at`,
      ).bind(JSON.stringify(days.map((d) => [d.gateway, d.day, d.shown_minutes, d.ok_minutes, JSON.stringify(d.hours)])), t),
    );
  }
  if (incidents.length) {
    stmts.push(
      env.DB.prepare(
        `INSERT OR REPLACE INTO ${src.incidents} (gateway, started_minute, ended_minute, kind, peak_error_rate, peak_p95_ms)
         SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]'), json_extract(value, '$[3]'), json_extract(value, '$[4]'), json_extract(value, '$[5]')
         FROM json_each(?1)`,
      ).bind(JSON.stringify(incidents.map((i) => [i.gateway, i.started_at / MINUTE, i.ended_at / MINUTE, i.kind, i.peak_error_rate, i.peak_p95_ms]))),
    );
  }
  const cutoff = Math.floor((t - UPTIME_DAYS * DAY) / MINUTE);
  stmts.push(
    env.DB.prepare(`DELETE FROM ${src.minutes} WHERE minute < ?`).bind(cutoff),
    env.DB.prepare(`DELETE FROM ${src.days} WHERE day < ?`).bind(today - UPTIME_DAYS - 7),
    env.DB.prepare(`DELETE FROM ${src.incidents} WHERE ended_minute < ?`).bind(cutoff),
  );
  const res = await env.DB.batch(stmts);
  return { days: days.length, incidents: incidents.length, minutes_deleted: res[res.length - 3].meta.changes ?? 0 };
}

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

/** Merged rate and p95 over a set of minutes. */
export function merge(ms: readonly MinuteRow[]): { error_rate: number | null; p95_ms: number | null; avg_ms: number | null } {
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

export function rollupDays(minutes: readonly MinuteRow[]): DayRollup[] {
  const m = new Map<string, DayRollup>();
  for (const r of minutes) {
    const day = nptDay(r.minute * MINUTE);
    const k = `${r.gateway}|${day}`;
    let d = m.get(k);
    if (!d) m.set(k, (d = { gateway: r.gateway, day, shown_minutes: 0, ok_minutes: 0, hours: Array.from({ length: 24 }, () => new Array<number>(3 + BUCKETS).fill(0)) }));
    d.shown_minutes++;
    if (!isBad(r)) d.ok_minutes++;
    const cell = d.hours[nptHour(r.minute * MINUTE)];
    cell[0] += r.samples;
    cell[1] += r.ms_total;
    cell[2] = Math.max(cell[2], r.ms_max);
    for (let i = 0; i < BUCKETS; i++) cell[3 + i] += r.hist[i];
  }
  return [...m.values()];
}

/** Runs of unhealthy minutes (gaps of up to 2 empty minutes allowed, a healthy minute ends a run) of >= 5 minutes. */
export function detectIncidents(minutes: readonly MinuteRow[], nowMinute: number): (StatusIncident & { gateway: string })[] {
  const byGw = new Map<string, MinuteRow[]>();
  for (const r of minutes) {
    if (!byGw.has(r.gateway)) byGw.set(r.gateway, []);
    byGw.get(r.gateway)!.push(r);
  }
  const out: (StatusIncident & { gateway: string })[] = [];
  for (const [gateway, list] of byGw) {
    list.sort((a, b) => a.minute - b.minute);
    let run: MinuteRow[] = [];
    const close = () => {
      if (!run.length) return;
      const first = run[0].minute;
      const last = run[run.length - 1].minute;
      if (last - first + 1 >= INCIDENT_MIN_MINUTES) {
        const errs = run.some((r) => errorRate(r) > BAD_ERROR_RATE);
        const slow = run.some((r) => (minuteP95(r) ?? 0) > BAD_P95_MS);
        const p95s = run.map(minuteP95).filter((x): x is number => x !== null);
        out.push({
          gateway,
          started_at: first * MINUTE,
          ended_at: (last + 1) * MINUTE,
          minutes: last - first + 1,
          kind: errs && slow ? "errors_and_latency" : errs ? "errors" : "latency",
          peak_error_rate: Math.max(...run.map(errorRate)),
          peak_p95_ms: p95s.length ? Math.max(...p95s) : null,
          ongoing: nowMinute - last <= INCIDENT_MAX_GAP,
        });
      }
      run = [];
    };
    for (const r of list) {
      if (!isBad(r)) {
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

/** Pure: the report from the last 48 h of shown minutes plus stored day rollups and incidents. */
export function buildReport(t: number, recent: readonly MinuteRow[], days: readonly StoredDay[], stored: readonly StoredIncident[]): StatusReport {
  const nowMinute = Math.floor(t / MINUTE);
  const today = nptDay(t);
  const recentStart = nowMinute - 48 * 60;
  // Days fully inside the 48 h window (yesterday and today) come from minutes; older days from the daily rollup.
  const freshDays = new Map<string, DayRollup>();
  for (const d of rollupDays(recent)) if (d.day * DAY - NEPAL_OFFSET_MS >= recentStart * MINUTE) freshDays.set(`${d.gateway}|${d.day}`, d);
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

  const live = detectIncidents(recent, nowMinute);
  // Rolling hours ending now, so the last point always holds the most recent minutes.
  const hourStart = (nowMinute + 1) * MINUTE - 24 * HOUR;

  const gateways: GatewayStatus[] = STATUS_GATEWAYS.map((gw) => {
    const mine = recent.filter((r) => r.gateway === gw);
    const window = mine.filter((r) => r.minute > nowMinute - STATE_WINDOW_MIN);
    const now15 = merge(window);
    const last_24h: StatusPoint[] = [];
    for (let i = 0; i < 24; i++) {
      const from = hourStart + i * HOUR;
      const m = merge(mine.filter((r) => r.minute * MINUTE >= from && r.minute * MINUTE < from + HOUR));
      last_24h.push({ t: from, error_rate: m.error_rate, p95_ms: m.p95_ms });
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

/** Reads what buildReport needs: 3 queries, bounded by 48 h of minutes per gateway and 90 days of rollups. */
export async function loadReport(env: Env, t: number): Promise<StatusReport> {
  const nowMinute = Math.floor(t / MINUTE);
  const [recent, days, incidents] = await env.DB.batch([
    env.DB.prepare(`SELECT ${MINUTE_COLS} FROM status_minutes WHERE minute > ? AND minute <= ? AND projects >= ?`).bind(nowMinute - 48 * 60, nowMinute, MIN_PROJECTS),
    env.DB.prepare("SELECT gateway, day, shown_minutes, ok_minutes, hours FROM status_days WHERE day > ?").bind(nptDay(t) - UPTIME_DAYS - 1),
    env.DB.prepare("SELECT gateway, started_minute, ended_minute, kind, peak_error_rate, peak_p95_ms FROM status_incidents WHERE ended_minute > ? ORDER BY started_minute DESC LIMIT 500").bind(
      nowMinute - UPTIME_DAYS * 1440,
    ),
  ]);
  return buildReport(t, (recent.results as Record<string, unknown>[]).map(toMinute), days.results as StoredDay[], incidents.results as StoredIncident[]);
}

/** Daily cron: roll up the last 3 complete Nepal days, store incidents from them, and keep 90 days of minutes. */
export async function rollupStatus(env: Env, t: number): Promise<{ days: number; incidents: number; minutes_deleted: number }> {
  const today = nptDay(t);
  const from = (today - 3) * DAY - NEPAL_OFFSET_MS;
  const to = today * DAY - NEPAL_OFFSET_MS;
  const rows = await env.DB.prepare(`SELECT ${MINUTE_COLS} FROM status_minutes WHERE minute >= ? AND minute < ? AND projects >= ?`)
    .bind(from / MINUTE, to / MINUTE, MIN_PROJECTS)
    .all<Record<string, unknown>>();
  const minutes = rows.results.map(toMinute);
  const days = rollupDays(minutes);
  const incidents = detectIncidents(minutes, Math.floor(t / MINUTE));
  const stmts: D1PreparedStatement[] = [];
  if (days.length) {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO status_days (gateway, day, shown_minutes, ok_minutes, hours, computed_at)
         SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]'), json_extract(value, '$[3]'), json_extract(value, '$[4]'), ?2
         FROM json_each(?1) WHERE true
         ON CONFLICT (gateway, day) DO UPDATE SET shown_minutes = excluded.shown_minutes, ok_minutes = excluded.ok_minutes, hours = excluded.hours, computed_at = excluded.computed_at`,
      ).bind(JSON.stringify(days.map((d) => [d.gateway, d.day, d.shown_minutes, d.ok_minutes, JSON.stringify(d.hours)])), t),
    );
  }
  if (incidents.length) {
    stmts.push(
      env.DB.prepare(
        `INSERT OR REPLACE INTO status_incidents (gateway, started_minute, ended_minute, kind, peak_error_rate, peak_p95_ms)
         SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]'), json_extract(value, '$[3]'), json_extract(value, '$[4]'), json_extract(value, '$[5]')
         FROM json_each(?1)`,
      ).bind(JSON.stringify(incidents.map((i) => [i.gateway, i.started_at / MINUTE, i.ended_at / MINUTE, i.kind, i.peak_error_rate, i.peak_p95_ms]))),
    );
  }
  const cutoff = Math.floor((t - UPTIME_DAYS * DAY) / MINUTE);
  stmts.push(
    env.DB.prepare("DELETE FROM status_minutes WHERE minute < ?").bind(cutoff),
    env.DB.prepare("DELETE FROM status_days WHERE day < ?").bind(today - UPTIME_DAYS - 7),
    env.DB.prepare("DELETE FROM status_incidents WHERE ended_minute < ?").bind(cutoff),
  );
  const res = await env.DB.batch(stmts);
  return { days: days.length, incidents: incidents.length, minutes_deleted: res[res.length - 3].meta.changes ?? 0 };
}

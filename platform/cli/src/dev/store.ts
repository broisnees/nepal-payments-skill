// Storage for `paynp dev`: the worker's three ingest tables (payments, events, minute_stats) held in memory,
// with the same rollup rules as worker/src/ingest.ts (SPEC section 4). With node:sqlite (Node 22.5+) every
// accepted event is also appended to .paynp/dev/events.db and replayed on start, so data survives a restart.
// Replaying the log in the order it was written rebuilds exactly the same rows, so there is one rollup and
// one set of queries for both modes.
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FINAL_STATUSES, impliedStatus, type PaymentEvent, type PaymentStatus } from "../../../shared/src/events.ts";

export const MINUTE = 60_000;
export type EnvName = "test" | "live";

/** Same columns as the worker's payments table. */
export interface PaymentRow {
  project_id: string;
  env: string;
  attempt_id: string;
  order_id: string | null;
  gateway: string;
  amount_paisa: number | null;
  status: string;
  started_at: number;
  updated_at: number;
  finished_at: number | null;
  provider_ref: string | null;
  last_reason: string | null;
  last_message: string | null;
  event_count: number;
  error_count: number;
  fulfil_count: number;
  status_at: number;
  reason_at: number;
}

/** Same columns as the worker's events table. */
export interface EventRow {
  project_id: string;
  env: string;
  id: string;
  attempt_id: string;
  type: string;
  ts: number;
  received_at: number;
  gateway: string;
  status: string | null;
  duration_ms: number | null;
  data: string | null;
  order_id: string | null;
  amount_paisa: number | null;
  sdk: string | null;
}

export interface MinuteRow {
  project_id: string;
  env: string;
  gateway: string;
  minute: number;
  started: number;
  paid: number;
  failed: number;
  paid_amount_paisa: number;
  gw_requests: number;
  gw_errors: number;
  gw_ms_total: number;
  gw_ms_max: number;
}

export interface IngestOutcome {
  accepted: number;
  duplicates: number;
  /** Accepted events in processing order, each with its payment row as it stood right after the event. */
  stored: { event: EventRow; payment: PaymentRow }[];
}

const isFinal = (s: string | null | undefined) => s != null && (FINAL_STATUSES as readonly string[]).includes(s);

/** A gateway call counts as an error on a 5xx, a status of 0, or no HTTP status at all with a reason. Same as the worker. */
export function isGatewayError(e: PaymentEvent): boolean {
  const s = e.data?.http_status;
  if (typeof s === "number") return s >= 500 || s === 0;
  return e.data?.reason !== undefined;
}

/**
 * One event applied to a payment row: the worker's UPSERT_PAYMENT in plain code. Every SET expression there
 * reads the row as it was before the event, and so does this.
 */
export function applyEvent(old: PaymentRow | undefined, e: PaymentEvent, ts: number, projectId: string, env: string): PaymentRow {
  const s: PaymentStatus | null = impliedStatus(e) ?? null;
  const err = e.type === "error" || (e.type === "signature.checked" && e.data?.valid === false) ? 1 : 0;
  const ful = e.type === "payment.fulfilled" ? 1 : 0;
  const hasReason = e.data?.reason !== undefined || e.data?.message !== undefined;
  const reason = e.data?.reason ?? null;
  const message = e.data?.message ?? null;
  const ref = e.data?.provider_ref ?? null;
  if (!old) {
    return {
      project_id: projectId, env, attempt_id: e.attempt_id, order_id: e.order_id ?? null, gateway: e.gateway, amount_paisa: e.amount_paisa ?? null,
      status: s ?? "initiated", started_at: ts, updated_at: ts, finished_at: isFinal(s) ? ts : null,
      provider_ref: ref, last_reason: reason, last_message: message, event_count: 1, error_count: err, fulfil_count: ful,
      status_at: s === null ? 0 : ts, reason_at: hasReason ? ts : 0,
    };
  }
  // (a) an open payment takes any final status, even an older one; (b) a status not older than the current one
  // lands unless it would turn a final status back into an open one.
  const apply = s !== null && ((!isFinal(old.status) && isFinal(s)) || (ts >= old.status_at && !(isFinal(old.status) && !isFinal(s))));
  const newReason = hasReason && ts >= old.reason_at;
  let finished = old.finished_at;
  if (apply && isFinal(s) && !(s === "refunded" && old.finished_at !== null)) finished = ts;
  else if (apply && !isFinal(s)) finished = null;
  return {
    ...old,
    order_id: old.order_id ?? e.order_id ?? null,
    amount_paisa: old.amount_paisa ?? e.amount_paisa ?? null,
    status: apply ? s! : old.status,
    status_at: apply ? ts : old.status_at,
    finished_at: finished,
    started_at: Math.min(old.started_at, ts),
    updated_at: Math.max(old.updated_at, ts),
    provider_ref: ref ?? old.provider_ref,
    last_reason: newReason ? reason : old.last_reason,
    last_message: newReason ? message : old.last_message,
    reason_at: newReason ? ts : old.reason_at,
    event_count: old.event_count + 1,
    error_count: old.error_count + err,
    fulfil_count: old.fulfil_count + ful,
  };
}

interface Log {
  append(env: string, receivedAt: number, events: PaymentEvent[]): void;
  replay(fn: (env: string, receivedAt: number, e: PaymentEvent) => void): void;
  close(): void;
}

export interface StoreOptions {
  /** Directory for events.db. Leave out for memory only. */
  dir?: string;
  /** Delete what is in `dir` first. */
  fresh?: boolean;
  /** Force memory only, even when node:sqlite is there. */
  memory?: boolean;
}

export const LOCAL_PROJECT = "local";

export class DevStore {
  readonly payments = new Map<string, PaymentRow>();
  readonly events = new Map<string, EventRow>();
  readonly minutes = new Map<string, MinuteRow>();
  /** "sqlite" when events persist to disk, else "memory". */
  kind: "sqlite" | "memory" = "memory";
  file: string | null = null;
  private log: Log | null = null;

  static async open(opts: StoreOptions = {}): Promise<DevStore> {
    const s = new DevStore();
    if (opts.dir && opts.fresh) rmSync(opts.dir, { recursive: true, force: true });
    if (opts.dir && !opts.memory) {
      const log = await openSqliteLog(join(opts.dir, "events.db"));
      if (log) {
        s.log = log;
        s.kind = "sqlite";
        s.file = join(opts.dir, "events.db");
        log.replay((env, at, e) => s.apply(env, [e], at));
      }
    }
    return s;
  }

  /** Writes validated events for one environment. Same results as the worker's ingestEvents. */
  ingest(env: EnvName, events: PaymentEvent[], receivedAt = Date.now()): IngestOutcome {
    const out = this.apply(env, events, receivedAt);
    if (this.log && out.stored.length) {
      const accepted = out.stored.map((s) => s.event.id);
      const byId = new Map(events.map((e) => [e.id, e]));
      this.log.append(env, receivedAt, accepted.map((id) => byId.get(id)!));
    }
    return out;
  }

  private apply(env: string, events: PaymentEvent[], receivedAt: number): IngestOutcome {
    const project = LOCAL_PROJECT;
    // Client time order, like the worker. The rollup itself does not depend on it.
    const sorted = events.map((e, i) => ({ e, i, ts: Date.parse(e.ts) })).sort((a, b) => a.ts - b.ts || a.i - b.i);
    const out: IngestOutcome = { accepted: 0, duplicates: 0, stored: [] };
    for (const { e, ts } of sorted) {
      const ek = `${env}|${e.id}`;
      if (this.events.has(ek)) {
        out.duplicates++;
        continue;
      }
      const pk = `${env}|${e.attempt_id}`;
      const old = this.payments.get(pk);
      const payment = applyEvent(old, e, ts, project, env);
      this.payments.set(pk, payment);
      const row: EventRow = {
        project_id: project, env, id: e.id, attempt_id: e.attempt_id, type: e.type, ts, received_at: receivedAt, gateway: e.gateway,
        status: e.status ?? null, duration_ms: e.duration_ms ?? null, data: e.data ? JSON.stringify(e.data) : null,
        order_id: e.order_id ?? null, amount_paisa: e.amount_paisa ?? null, sdk: e.sdk ? JSON.stringify(e.sdk) : null,
      };
      this.events.set(ek, row);
      out.accepted++;
      out.stored.push({ event: row, payment });
      this.stats(env, e, ts, old, payment);
    }
    return out;
  }

  // minute_stats, the same deltas as the worker: started and gateway requests by event, paid and failed by
  // the payment's status transition so a late or repeated status event never double counts.
  private stats(env: string, e: PaymentEvent, ts: number, old: PaymentRow | undefined, payment: PaymentRow): void {
    const row = (gateway: string, t: number): MinuteRow => {
      const minute = Math.floor(t / MINUTE);
      const k = `${env}|${gateway}|${minute}`;
      let r = this.minutes.get(k);
      if (!r) {
        r = { project_id: LOCAL_PROJECT, env, gateway, minute, started: 0, paid: 0, failed: 0, paid_amount_paisa: 0, gw_requests: 0, gw_errors: 0, gw_ms_total: 0, gw_ms_max: 0 };
        this.minutes.set(k, r);
      }
      return r;
    };
    if (e.type === "payment.started") row(e.gateway, ts).started++;
    if (e.type === "gateway.request") {
      const d = row(e.gateway, ts);
      d.gw_requests++;
      if (isGatewayError(e)) d.gw_errors++;
      d.gw_ms_total += e.duration_ms ?? 0;
      d.gw_ms_max = Math.max(d.gw_ms_max, e.duration_ms ?? 0);
    }
    const was = old?.status;
    const is = payment.status;
    if (is === "paid" && was !== "paid") {
      const d = row(payment.gateway, payment.finished_at ?? ts);
      d.paid++;
      d.paid_amount_paisa += payment.amount_paisa ?? 0;
    }
    if (is === "failed" && was !== "failed") row(payment.gateway, payment.finished_at ?? ts).failed++;
    if (old && was === "paid" && is !== "paid") {
      const d = row(old.gateway, old.finished_at ?? ts);
      d.paid--;
      d.paid_amount_paisa -= old.amount_paisa ?? 0;
    }
    if (old && was === "failed" && is !== "failed") row(old.gateway, old.finished_at ?? ts).failed--;
  }

  paymentsOf(env: string): PaymentRow[] {
    return [...this.payments.values()].filter((p) => p.env === env);
  }
  eventsOf(env: string): EventRow[] {
    return [...this.events.values()].filter((e) => e.env === env);
  }
  minutesOf(env: string): MinuteRow[] {
    return [...this.minutes.values()].filter((m) => m.env === env);
  }

  close(): void {
    this.log?.close();
    this.log = null;
  }
}

type SqliteModule = { DatabaseSync: new (path: string) => SqliteDb };
interface SqliteDb {
  exec(sql: string): void;
  prepare(sql: string): { run(...a: unknown[]): unknown; all(...a: unknown[]): Record<string, unknown>[] };
  close(): void;
}

/** node:sqlite when this Node has it (22.5+; before 22.13 only with --experimental-sqlite). Null otherwise. */
export async function loadSqlite(): Promise<SqliteModule | null> {
  const emit = process.emitWarning;
  // Importing it prints an ExperimentalWarning on some versions; this CLI's own output is the place for status.
  process.emitWarning = ((w: string | Error, ...rest: unknown[]) => {
    if (/sqlite/i.test(String(w))) return;
    (emit as (...a: unknown[]) => void).call(process, w, ...rest);
  }) as typeof process.emitWarning;
  try {
    const name = "node:sqlite";
    return (await import(/* @vite-ignore */ name)) as SqliteModule;
  } catch {
    return null;
  } finally {
    process.emitWarning = emit;
  }
}

async function openSqliteLog(file: string): Promise<Log | null> {
  const sqlite = await loadSqlite();
  if (!sqlite) return null;
  const dir = join(file, "..");
  mkdirSync(dir, { recursive: true });
  // Local data, never committed. (.paynp/project.json next to it is meant to be committed.)
  if (!existsSync(join(dir, ".gitignore"))) writeFileSync(join(dir, ".gitignore"), "*\n");
  let db: SqliteDb;
  try {
    db = new sqlite.DatabaseSync(file);
    db.exec("PRAGMA journal_mode = WAL; CREATE TABLE IF NOT EXISTS log (seq INTEGER PRIMARY KEY, env TEXT NOT NULL, received_at INTEGER NOT NULL, event TEXT NOT NULL)");
  } catch {
    return null;
  }
  const insert = db.prepare("INSERT INTO log (env, received_at, event) VALUES (?, ?, ?)");
  return {
    append(env, at, events) {
      db.exec("BEGIN");
      try {
        for (const e of events) insert.run(env, at, JSON.stringify(e));
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
    replay(fn) {
      for (const r of db.prepare("SELECT env, received_at, event FROM log ORDER BY seq").all()) {
        fn(String(r.env), Number(r.received_at), JSON.parse(String(r.event)) as PaymentEvent);
      }
    },
    close: () => db.close(),
  };
}

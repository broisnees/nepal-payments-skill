// Event schema v1 (platform/SPEC.md section 3). No dependencies, so the SDK can import it as-is.

export const EVENT_TYPES = [
  "payment.started",
  "payment.redirected",
  "callback.received",
  "signature.checked",
  "gateway.request",
  "status.changed",
  "payment.fulfilled",
  "reconcile.checked",
  "error",
  "payment.annotated", // attaches order or customer data, no status change
  "payment.refunded", // amount_paisa is the refunded amount
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const STATUSES = ["initiated", "pending", "paid", "failed", "canceled", "expired", "refunded", "unknown"] as const;
export type PaymentStatus = (typeof STATUSES)[number];
export const FINAL_STATUSES: readonly PaymentStatus[] = ["paid", "failed", "canceled", "expired", "refunded"];
export const OPEN_STATUSES: readonly PaymentStatus[] = ["initiated", "pending", "unknown"];

export const GATEWAYS = ["esewa", "khalti", "fonepay", "connectips", "cybersource", "nps", "imepay"] as const;
export type KnownGateway = (typeof GATEWAYS)[number];

export interface EventData {
  from?: PaymentStatus;
  to?: PaymentStatus;
  op?: string;
  method?: string;
  endpoint?: string;
  http_status?: number;
  provider_status?: string;
  provider_code?: string;
  provider_ref?: string;
  valid?: boolean;
  reason?: string;
  message?: string;
  source?: "return" | "reconcile" | "notify" | "manual";
  attempt?: number;
  /** Which gateway environment the SDK saw, from the host it called. */
  gw_env?: "sandbox" | "production";
  /** payment.started: whether the return URL is https. */
  return_https?: boolean;
  refund_ref?: string;
  refund_reason?: string;
  /** Set on events emitted while handling a paynp action (refund, recheck). */
  action_id?: string;
}

/** Raw customer details from the SDK. The server stores phone and email only as a salted hash plus a masked form. */
export interface EventCustomer {
  phone?: string;
  email?: string;
  name?: string;
}

export interface PaymentEvent {
  id: string;
  type: EventType;
  ts: string;
  attempt_id: string;
  order_id?: string;
  gateway: string;
  amount_paisa?: number;
  status?: PaymentStatus;
  duration_ms?: number;
  data?: EventData;
  customer?: EventCustomer;
  sdk?: { name: string; version: string; lang: string };
}

export const MAX_BATCH_EVENTS = 100;
export const MAX_BATCH_BYTES = 256 * 1024;
const MAX_STRING = 500;

const DATA_KEYS: Record<keyof EventData, "string" | "number" | "boolean" | "status"> = {
  from: "status",
  to: "status",
  op: "string",
  method: "string",
  endpoint: "string",
  http_status: "number",
  provider_status: "string",
  provider_code: "string",
  provider_ref: "string",
  valid: "boolean",
  reason: "string",
  message: "string",
  source: "string",
  attempt: "number",
  gw_env: "string",
  return_https: "boolean",
  refund_ref: "string",
  refund_reason: "string",
  action_id: "string",
};

// Card numbers (13 to 19 digits, spaces or dashes allowed) and PEM blocks never belong in an event.
const SENSITIVE = [/\b(?:\d[ -]?){13,19}\b/, /-----BEGIN [A-Z ]+-----/];

/** Cuts long strings and blanks anything that looks like a card number or a key. */
export function cleanString(s: string): string | undefined {
  if (SENSITIVE.some((re) => re.test(s))) return undefined;
  return s.length > MAX_STRING ? s.slice(0, MAX_STRING) : s;
}

/** Keeps only allowlisted data keys with the right types. Unknown keys are dropped, never an error. */
export function redactData(data: unknown): EventData | undefined {
  if (!data || typeof data !== "object") return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, kind] of Object.entries(DATA_KEYS)) {
    const v = (data as Record<string, unknown>)[k];
    if (v === undefined || v === null) continue;
    if (kind === "status" && typeof v === "string" && (STATUSES as readonly string[]).includes(v)) out[k] = v;
    else if (kind === "string" && typeof v === "string") {
      const s = cleanString(k === "endpoint" ? v.split("?")[0] : v);
      if (s !== undefined) out[k] = s;
    } else if (kind === "number" && typeof v === "number" && Number.isFinite(v)) out[k] = v;
    else if (kind === "boolean" && typeof v === "boolean") out[k] = v;
  }
  return Object.keys(out).length ? (out as EventData) : undefined;
}

export type ValidationResult = { ok: true; event: PaymentEvent } | { ok: false; error: string };

/** Validates and normalizes one event. Returns a cleaned copy; the input is not modified. */
export function validateEvent(input: unknown): ValidationResult {
  if (!input || typeof input !== "object") return { ok: false, error: "event must be an object" };
  const e = input as Record<string, unknown>;
  const str = (k: string, max = 200) => (typeof e[k] === "string" && e[k] !== "" && (e[k] as string).length <= max ? (e[k] as string) : undefined);

  const id = str("id", 64);
  if (!id) return { ok: false, error: "id is required (string, at most 64 chars)" };
  if (!(EVENT_TYPES as readonly string[]).includes(e.type as string)) return { ok: false, error: `unknown type: ${String(e.type)}` };
  const ts = str("ts", 40);
  if (!ts || Number.isNaN(Date.parse(ts))) return { ok: false, error: "ts must be an ISO 8601 timestamp" };
  const attempt_id = str("attempt_id", 128);
  if (!attempt_id) return { ok: false, error: "attempt_id is required" };
  const gateway = str("gateway", 32);
  if (!gateway || !/^[a-z0-9_-]+$/.test(gateway)) return { ok: false, error: "gateway must be a lowercase id" };

  const event: PaymentEvent = { id, type: e.type as EventType, ts: new Date(ts).toISOString(), attempt_id, gateway };
  const order_id = str("order_id", 128);
  if (order_id) event.order_id = cleanString(order_id);
  if (e.amount_paisa !== undefined) {
    if (!Number.isSafeInteger(e.amount_paisa) || (e.amount_paisa as number) < 0) return { ok: false, error: "amount_paisa must be a non-negative integer" };
    event.amount_paisa = e.amount_paisa as number;
  }
  if (e.status !== undefined) {
    if (!(STATUSES as readonly string[]).includes(e.status as string)) return { ok: false, error: `unknown status: ${String(e.status)}` };
    event.status = e.status as PaymentStatus;
  }
  if (e.duration_ms !== undefined) {
    if (typeof e.duration_ms !== "number" || !Number.isFinite(e.duration_ms) || e.duration_ms < 0) return { ok: false, error: "duration_ms must be a non-negative number" };
    event.duration_ms = Math.round(e.duration_ms);
  }
  const data = redactData(e.data);
  if (data) {
    if (data.gw_env !== undefined && data.gw_env !== "sandbox" && data.gw_env !== "production") delete data.gw_env;
    event.data = data;
  }
  if (e.customer && typeof e.customer === "object") {
    const c = e.customer as Record<string, unknown>;
    const customer: EventCustomer = {};
    if (typeof c.phone === "string" && c.phone.length <= 32) customer.phone = c.phone;
    if (typeof c.email === "string" && c.email.length <= 254 && c.email.includes("@")) customer.email = c.email;
    if (typeof c.name === "string") customer.name = cleanString(c.name.slice(0, 80));
    if (customer.phone || customer.email || customer.name) event.customer = customer;
  }
  if (e.sdk && typeof e.sdk === "object") {
    const s = e.sdk as Record<string, unknown>;
    if (typeof s.name === "string" && typeof s.version === "string" && typeof s.lang === "string") {
      event.sdk = { name: s.name.slice(0, 40), version: s.version.slice(0, 20), lang: s.lang.slice(0, 20) };
    }
  }
  return { ok: true, event };
}

/** Status an event implies for its payment, if any. */
export const impliedStatus = (e: PaymentEvent): PaymentStatus | undefined => e.status ?? e.data?.to;

/** ULID-style sortable id with a prefix: time-ordered, 26 chars of Crockford base32 after the prefix. */
export function newId(prefix: string, now = Date.now()): string {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let time = "";
  for (let t = now, i = 0; i < 10; i++, t = Math.floor(t / 32)) time = alphabet[t % 32] + time;
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let rand = "";
  for (const b of bytes) rand += alphabet[b % 32];
  return `${prefix}_${time}${rand}`;
}

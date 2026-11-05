// One colored line per event for `paynp tail`.
import type { PaymentEvent, PaymentStatus } from "../../shared/src/events.ts";
import { paint, type Color } from "./ui.ts";

const STATUS_COLOR: Record<PaymentStatus, Color> = {
  paid: "green",
  initiated: "cyan",
  pending: "yellow",
  failed: "red",
  canceled: "red",
  expired: "red",
  refunded: "magenta",
  unknown: "gray",
};

const pad2 = (n: number) => String(n).padStart(2, "0");

/** Local wall-clock time with milliseconds, e.g. 14:03:22.120. */
export function clock(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, "0")}`;
}

export function rupees(paisa: number): string {
  const whole = Math.floor(paisa / 100).toLocaleString("en-IN");
  const rest = paisa % 100;
  return `Rs ${whole}${rest ? `.${String(rest).padStart(2, "0")}` : ""}`;
}

function detail(e: PaymentEvent): string {
  const d = e.data ?? {};
  const parts: string[] = [];
  switch (e.type) {
    case "gateway.request":
      parts.push([d.op, d.method, d.endpoint].filter(Boolean).join(" "));
      if (d.http_status !== undefined) parts.push(String(d.http_status));
      if (d.attempt) parts.push(`try ${d.attempt}`);
      break;
    case "signature.checked":
      parts.push(d.valid === false ? "INVALID" : "valid");
      break;
    case "status.changed":
      parts.push(`${d.from ?? "?"} -> ${d.to ?? e.status ?? "?"}`);
      break;
    case "callback.received":
      parts.push([d.method, d.source].filter(Boolean).join(" "));
      break;
    case "payment.redirected":
      if (d.endpoint) parts.push(`${d.method ?? ""} ${d.endpoint}`.trim());
      break;
  }
  if (d.provider_status) parts.push(d.provider_status);
  if (d.provider_code) parts.push(d.provider_code);
  if (e.duration_ms !== undefined) parts.push(`${e.duration_ms}ms`);
  if (d.reason) parts.push(d.reason + (d.message ? `: ${d.message}` : ""));
  else if (d.message) parts.push(d.message);
  return parts.filter(Boolean).join("  ");
}

const isBad = (e: PaymentEvent) =>
  e.type === "error" || (e.type === "signature.checked" && e.data?.valid === false) || (e.data?.http_status ?? 0) >= 400 || !!e.data?.reason;

export function formatEvent(e: PaymentEvent, color: boolean): string {
  const status = e.status ?? "";
  const statusText = status ? paint(color, STATUS_COLOR[status] ?? "gray", status.padEnd(9)) : " ".repeat(9);
  const type = paint(color, isBad(e) ? "red" : e.type === "payment.fulfilled" ? "green" : "bold", e.type.padEnd(19));
  const amount = (e.amount_paisa !== undefined ? rupees(e.amount_paisa) : "").padEnd(11);
  const det = detail(e);
  return [
    paint(color, "gray", clock(e.ts)),
    e.gateway.padEnd(11),
    type,
    paint(color, "dim", e.attempt_id),
    amount,
    statusText,
    isBad(e) ? paint(color, "red", det) : det,
  ]
    .join("  ")
    .trimEnd();
}

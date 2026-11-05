// Payment timeline: where the time went (phase bar), then each step in plain words. Raw events open on click.
import { OPEN_STATUSES, type Payment, type StoredEvent } from "@paynp/shared";
import { Fragment, useMemo, useState } from "react";
import { describe, tone } from "../lib/describe.ts";
import { formatDuration, formatOffset, formatTimeMs, gatewayName, moneyParts } from "../lib/format.ts";
import { reasonLabel } from "../lib/labels.ts";
import { EmptySmall, JsonView, useNow } from "./ui.tsx";
import "../styles/timeline.css";

type PhaseKind = "checkout" | "buyer" | "wait" | "verify";
interface Phase {
  kind: PhaseKind;
  label: string;
  ms: number;
}

/** A gap longer than this between two steps gets its own divider and its own phase. */
const LONG_GAP = 3_000;

const BUYER_ENDS = new Set(["callback.received", "signature.checked", "gateway.request", "status.changed", "reconcile.checked", "error"]);

function phaseOf(e: StoredEvent): PhaseKind {
  return e.type === "payment.started" || e.type === "payment.redirected" ? "checkout" : "verify";
}

/** Splits the payment's life into phases: time between steps goes to the phase it belongs to. */
function phases(events: StoredEvent[], gateway: string, endAt: number): Phase[] {
  const gw = gatewayName(gateway);
  const out: Phase[] = [];
  const push = (kind: PhaseKind, label: string, ms: number) => {
    if (ms <= 0) return;
    const last = out[out.length - 1];
    if (last && last.kind === kind && last.label === label) last.ms += ms;
    else out.push({ kind, label, ms });
  };
  for (let i = 1; i < events.length; i++) {
    const prev = events[i - 1];
    const next = events[i];
    const gap = Date.parse(next.ts) - Date.parse(prev.ts);
    if (prev.type === "payment.redirected" && BUYER_ENDS.has(next.type)) push("buyer", `On ${gw}`, gap);
    else if (gap > LONG_GAP) push("wait", next.type === "reconcile.checked" || next.data?.source === "reconcile" ? "Waiting for reconcile" : "Waiting", gap);
    else push(phaseOf(next) === "checkout" ? "checkout" : "verify", phaseOf(next) === "checkout" ? "Checkout" : "Verification", gap);
  }
  // A gateway call that ends after the last step still counts toward verification.
  const last = events[events.length - 1];
  push(phaseOf(last) === "checkout" ? "checkout" : "verify", phaseOf(last) === "checkout" ? "Checkout" : "Verification", endAt - Date.parse(last.ts));
  return out;
}

function title(e: StoredEvent, gateway: string): string {
  const gw = gatewayName(gateway);
  const d = e.data ?? {};
  switch (e.type) {
    case "payment.started":
      return "Payment started";
    case "payment.redirected":
      return `Sent to ${gw}`;
    case "callback.received":
      return d.source === "notify" ? `${gw} notified the server` : "Buyer came back";
    case "signature.checked":
      return d.valid === false ? "Signature rejected" : "Signature valid";
    case "gateway.request": {
      const op = d.op === "status" || d.op === "lookup" ? "status check" : d.op === "initiate" ? "payment created" : d.op === "token" ? "token issued" : (d.op ?? "request");
      return `${gw} ${op}`;
    }
    case "status.changed": {
      const to = d.to ?? e.status;
      return to ? `Marked ${to}` : "Status changed";
    }
    case "payment.fulfilled":
      return "Order fulfilled";
    case "reconcile.checked":
      return "Checked by the reconcile job";
    case "error":
      return d.reason ? reasonLabel(d.reason) : "Error";
    default:
      return e.type;
  }
}

function detail(e: StoredEvent): string {
  const d = e.data ?? {};
  switch (e.type) {
    case "payment.started": {
      const amount = e.amount_paisa !== undefined ? `Rs ${moneyParts(e.amount_paisa).int}.${moneyParts(e.amount_paisa).frac}` : null;
      return [amount, e.order_id && `order ${e.order_id}`].filter(Boolean).join(" · ");
    }
    case "payment.redirected":
      return [d.method, d.endpoint].filter(Boolean).join(" ");
    case "callback.received":
      return [d.method, d.provider_status, d.provider_code].filter(Boolean).join(" · ");
    case "signature.checked":
      return d.valid === false && d.reason ? reasonLabel(d.reason) : "";
    case "gateway.request":
      return [d.http_status && `HTTP ${d.http_status}`, d.provider_status, d.provider_code, d.attempt && d.attempt > 1 ? `retry ${d.attempt - 1}` : null].filter(Boolean).join(" · ");
    case "status.changed":
      return [d.from && `from ${d.from}`, d.provider_status && `gateway said ${d.provider_status}`, d.reason && reasonLabel(d.reason)].filter(Boolean).join(" · ");
    case "error":
      return d.message ?? "";
    case "payment.fulfilled":
      return "";
    default:
      return describe(e);
  }
}

/** The phase's bar colour, reused for the legend swatch on phones. */
function swatch(kind: PhaseKind, gateway: string, outcome: "ok" | "bad" | "warn"): string {
  if (kind === "checkout") return "var(--subtle)";
  if (kind === "wait") return "var(--line-strong)";
  if (kind === "buyer") return `var(--gw-${gateway}, var(--gw-other))`;
  return outcome === "ok" ? "var(--st-paid)" : outcome === "bad" ? "var(--st-failed)" : "var(--st-open)";
}

function gapLabel(prev: StoredEvent, next: StoredEvent, gateway: string, ms: number) {
  if (prev.type === "payment.redirected") return `Buyer on ${gatewayName(gateway)} for ${formatDuration(ms)}`;
  if (next.type === "reconcile.checked" || next.data?.source === "reconcile") return `No callback, reconcile ran ${formatDuration(ms)} later`;
  return `${formatDuration(ms)} later`;
}

export function Timeline({ p, events }: { p: Payment; events: StoredEvent[] }) {
  const [openRow, setOpenRow] = useState<string | null>(null);
  const now = useNow(1000);
  const isOpen = OPEN_STATUSES.includes(p.status);
  const { t0, total, parts } = useMemo(() => {
    if (!events.length) return { t0: p.started_at, total: 0, parts: [] as Phase[] };
    const start = Date.parse(events[0].ts);
    const end = Math.max(...events.map((e) => Date.parse(e.ts) + (e.duration_ms ?? 0)));
    return { t0: start, total: end - start, parts: phases(events, p.gateway, end) };
  }, [events, p.started_at, p.gateway]);

  if (!events.length) return <EmptySmall title="No events yet" />;
  const outcome = p.status === "paid" ? "ok" : p.status === "failed" || p.status === "expired" || p.status === "canceled" ? "bad" : "warn";

  return (
    <section className="tl" aria-labelledby="tl-title">
      <div className="tl-head">
        <h2 id="tl-title">Timeline</h2>
        <span className="hint">
          {events.length} steps · {isOpen ? `open for ${formatDuration(now - t0)}` : `${formatDuration(total)} end to end`}
        </span>
      </div>

      {parts.length > 0 && (
        <div className="tl-phases" aria-label="Where the time went">
          <div className="tl-bar" aria-hidden="true">
            {parts.map((ph, i) => (
              // Every phase keeps a readable minimum width, so 150 ms next to 38 s stays visible.
              <span key={i} className="tl-seg" data-kind={ph.kind} data-outcome={ph.kind === "verify" ? outcome : undefined} data-gw={p.gateway} style={{ flexGrow: Math.max(ph.ms, total * 0.12) }} />
            ))}
          </div>
          <ul className="tl-legend">
            {parts.map((ph, i) => (
              <li key={i} style={{ flexGrow: Math.max(ph.ms, total * 0.12), ["--swatch" as string]: swatch(ph.kind, p.gateway, outcome) }}>
                <span className="tl-legend-label">{ph.label}</span>
                <span className="tl-legend-ms">{formatDuration(ph.ms)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <ol className="tl-steps">
        {events.map((e, i) => {
          const prev = events[i - 1];
          const gap = prev ? Date.parse(e.ts) - (Date.parse(prev.ts) + (prev.duration_ms ?? 0)) : 0;
          const tn = tone(e);
          const open = openRow === e.id;
          const sub = detail(e);
          return (
            <Fragment key={e.id}>
              {prev && gap > LONG_GAP && (
                <li className="tl-gap" aria-hidden="true">
                  <span>{gapLabel(prev, e, p.gateway, gap)}</span>
                </li>
              )}
              <li className="tl-step" data-tone={tn} data-open={open || undefined}>
                <button type="button" className="tl-row" aria-expanded={open} onClick={() => setOpenRow(open ? null : e.id)}>
                  <span className="tl-dot" aria-hidden="true" />
                  <span className="tl-text">
                    <span className="tl-title">{title(e, p.gateway)}</span>
                    {sub && <span className="tl-sub">{sub}</span>}
                  </span>
                  {e.duration_ms !== undefined && <span className="tl-dur">{formatDuration(e.duration_ms)}</span>}
                  <span className="tl-at" title={`${formatTimeMs(e.ts)} NPT`}>
                    {formatOffset(Date.parse(e.ts) - t0)}
                  </span>
                </button>
                {open && (
                  <div className="tl-raw fade-in">
                    <div className="tl-raw-meta">
                      <code>{e.type}</code>
                      <span>
                        {formatTimeMs(e.ts)} NPT · received {formatDuration(Math.max(0, e.received_at - Date.parse(e.ts)))} later
                      </span>
                    </div>
                    <JsonView value={e} />
                  </div>
                )}
              </li>
            </Fragment>
          );
        })}
        {isOpen && (
          <li className="tl-step tl-waiting" aria-live="polite">
            <div className="tl-row">
              <span className="tl-dot live-dot" aria-hidden="true" />
              <span className="tl-text">
                <span className="tl-title">Waiting for the next step</span>
              </span>
              <span className="tl-at">{formatOffset(now - t0)}</span>
            </div>
          </li>
        )}
      </ol>
    </section>
  );
}

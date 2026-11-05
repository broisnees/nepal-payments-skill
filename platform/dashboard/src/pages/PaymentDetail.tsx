import { OPEN_STATUSES, type Explanation, type LiveMessage, type Payment, type PaymentOps, type StoredEvent } from "@paynp/shared";
import { useState } from "react";
import { Link, useParams } from "react-router";
import { Icon } from "../components/Icon.tsx";
import { MarkRefundDialog, RefundPill, StatusLinkDialog, kindLabel } from "../components/Ops.tsx";
import { Timeline } from "../components/Timeline.tsx";
import { useProject } from "../components/Shell.tsx";
import { CopyButton, EmptySmall, Gateway, Money, Skeleton, StatusPill, Time, useNow } from "../components/ui.tsx";
import { ApiFailure, errorMessage, qs } from "../lib/api.ts";
import { formatDateTime, formatDuration, formatFull, formatMoney, formatRelative, gatewayName, moneyParts, shortId } from "../lib/format.ts";
import { useLive } from "../lib/live.ts";
import { useQuery } from "../lib/query.ts";
import type { PaymentDetailV2 as Detail } from "../lib/v2.ts";

export default function PaymentDetail() {
  const { project, env, base } = useProject();
  const { attempt = "" } = useParams();
  const key = `/api/projects/${project.id}/payments/${encodeURIComponent(attempt)}${qs({ env })}`;
  const d = useQuery<Detail>(key, { staleMs: 2_000 });
  // The ops view (customer, refunds, duplicates) rides on the detail response, or comes from its own endpoint.
  const opsQ = useQuery<PaymentOps>(d.data && !d.data.ops ? `/api/projects/${project.id}/payments/${encodeURIComponent(attempt)}/ops${qs({ env })}` : null, { staleMs: 5_000 });
  const ops = d.data?.ops ?? opsQ.data ?? null;
  const open = d.data ? OPEN_STATUSES.includes(d.data.payment.status) || !d.data.payment.fulfil_count : true;

  // While a payment is in flight, its events arrive on the live stream: refetch when one is ours.
  useLive(
    project.id,
    env,
    (m: LiveMessage) => {
      if (m.kind === "event" && m.event.attempt_id === attempt) void d.refresh();
    },
    open,
  );

  if (d.error instanceof ApiFailure && d.error.status === 404 && !d.data) {
    return (
      <>
        <BackLink base={base} />
        <div className="card" style={{ marginBlockStart: 16 }}>
          <EmptySmall icon="search" title="No payment with this attempt id">
            It may belong to the other environment, or its first event has not arrived yet.{" "}
            <button className="btn btn-ghost btn-sm" onClick={() => void d.refresh()}>
              Check again
            </button>
          </EmptySmall>
        </div>
      </>
    );
  }
  if (d.error && !d.data) {
    return (
      <>
        <BackLink base={base} />
        <div className="card" style={{ marginBlockStart: 16 }}>
          <EmptySmall icon="alert" title="Could not load this payment">
            {errorMessage(d.error)}
          </EmptySmall>
        </div>
      </>
    );
  }
  if (!d.data) return <DetailSkeleton base={base} />;

  const { payment: p, events, explain } = d.data;
  return (
    <>
      <Header p={p} base={base} ops={ops} />
      <div className="stack-lg">
        {ops && <DuplicateBanner ops={ops} base={base} />}
        {explain && <ExplainCard ex={explain} p={p} />}
        <RefundsCard p={p} ops={ops} events={events} base={base} />
        <Timeline p={p} events={events} />
      </div>
    </>
  );
}

function BackLink({ base }: { base: string }) {
  return (
    <Link to={`${base}/payments`} className="back">
      <Icon name="arrowLeft" size={14} />
      Payments
    </Link>
  );
}

function DetailSkeleton({ base }: { base: string }) {
  return (
    <div className="pd-head">
      <BackLink base={base} />
      <Skeleton w={220} h={36} />
      <Skeleton w="60%" h={14} />
      <div className="tl-steps" style={{ height: 320 }} />
    </div>
  );
}

function Header({ p, base, ops }: { p: Payment; base: string; ops: PaymentOps | null }) {
  const now = useNow(1000);
  const { project, env, canAdmin } = useProject();
  const [dialog, setDialog] = useState<"link" | "refund" | null>(null);
  const hasOpenCase = ops?.refund_cases?.some((c) => c.attempt_id === p.attempt_id && (c.status === "open" || c.status === "requested" || c.status === "failed"));
  const customer = ops?.customer ?? (p.customer_mask ? { mask: p.customer_mask, name: null } : null);
  const open = OPEN_STATUSES.includes(p.status);
  const m = p.amount_paisa !== null ? moneyParts(p.amount_paisa) : null;
  return (
    <section className="pd-head">
      <BackLink base={base} />
      <div className="row wrap" style={{ gap: 12, alignItems: "center" }}>
        <div className="pd-amount" aria-label={m ? `Rs ${m.int}.${m.frac}` : "No amount"}>
          {m ? (
            <>
              <span className="cur">Rs</span>
              {m.int}
              <span className="frac">.{m.frac}</span>
            </>
          ) : (
            <span className="muted">No amount</span>
          )}
        </div>
        <StatusPill status={p.status} pulse={open} />
        {p.fulfil_count > 1 && <span className="pill" data-s="failed">Fulfilled {p.fulfil_count} times</span>}
        {(p.refunded_paisa ?? 0) > 0 && p.status !== "refunded" && <span className="pill" data-s="refunded">Partly refunded</span>}
        {p.gw_env === "sandbox" && p.env === "live" && <span className="pill" data-s="failed">Sandbox gateway</span>}
        <div className="actions pd-actions">
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setDialog("link")}>
            <Icon name="link" size={14} />
            Send status link
          </button>
          {canAdmin && p.status === "paid" && !hasOpenCase && (
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setDialog("refund")}>
              <Icon name="undo" size={14} />
              Mark for refund
            </button>
          )}
        </div>
      </div>
      {dialog === "link" && <StatusLinkDialog projectId={project.id} attemptId={p.attempt_id} onClose={() => setDialog(null)} />}
      {dialog === "refund" && <MarkRefundDialog projectId={project.id} env={env} payment={p} onClose={() => setDialog(null)} />}
      <dl className="facts">
        <div className="fact">
          <dt>Gateway</dt>
          <dd>
            <Gateway id={p.gateway} />
          </dd>
        </div>
        <div className="fact">
          <dt>Order</dt>
          <dd className="row" style={{ gap: 2 }}>
            <span className="truncate">{p.order_id ?? "-"}</span>
            {p.order_id && <CopyButton text={p.order_id} label="Copy order id" />}
          </dd>
        </div>
        <div className="fact">
          <dt>Customer</dt>
          <dd title={customer?.name ?? undefined}>
            {customer ? (
              <>
                {customer.name && <span>{customer.name} </span>}
                <span className={customer.name ? "mono muted" : "mono"} style={{ fontSize: 12 }}>
                  {customer.mask}
                </span>
              </>
            ) : (
              <span className="subtle">Not sent</span>
            )}
          </dd>
        </div>
        <div className="fact">
          <dt>Attempt</dt>
          <dd className="row" style={{ gap: 2 }}>
            <span className="mono truncate" style={{ fontSize: 12 }}>
              {p.attempt_id}
            </span>
            <CopyButton text={p.attempt_id} label="Copy attempt id" />
          </dd>
        </div>
        <div className="fact">
          <dt>{gatewayName(p.gateway)} reference</dt>
          <dd className="row" style={{ gap: 2 }}>
            <span className="mono truncate" style={{ fontSize: 12 }}>
              {p.provider_ref ?? "-"}
            </span>
            {p.provider_ref && <CopyButton text={p.provider_ref} label="Copy reference" />}
          </dd>
        </div>
        <div className="fact">
          <dt>Started</dt>
          <dd>
            <Time t={p.started_at}>{formatFull(p.started_at)}</Time>
          </dd>
        </div>
        <div className="fact">
          <dt>{open ? "Open for" : "Took"}</dt>
          <dd className="num">{formatDuration((p.finished_at ?? (open ? now : p.updated_at)) - p.started_at)}</dd>
        </div>
      </dl>
    </section>
  );
}

function ExplainCard({ ex, p }: { ex: Explanation; p: Payment }) {
  const bad = p.status === "failed" || p.status === "expired" || p.error_count > 0;
  return (
    <section className={`card ${p.status === "paid" ? "tone-cream" : bad ? "tone-rose" : "tone-cream"}`} aria-labelledby="ex-title">
      <div className="explain">
        <div className="ex-title" id="ex-title">
          <Icon name={p.status === "paid" ? "info" : "alert"} />
          {ex.title}
        </div>
        <dl>
          <div>
            <dt>Cause</dt>
            <dd>{ex.cause}</dd>
          </div>
          <div>
            <dt>Fix</dt>
            <dd>{ex.fix}</dd>
          </div>
        </dl>
        {ex.docs_url && (
          <a className="inline-link" href={ex.docs_url} target="_blank" rel="noreferrer" style={{ width: "fit-content", fontSize: 13 }}>
            Read the {gatewayName(p.gateway)} notes
            <Icon name="arrowUpRight" size={12} />
          </a>
        )}
      </div>
    </section>
  );
}

function DuplicateBanner({ ops, base }: { ops: PaymentOps; base: string }) {
  const own = ops.refund_cases?.find((c) => c.kind === "duplicate" && c.related_attempt_id === ops.duplicate_of);
  if (ops.duplicate_of) {
    return (
      <div className="banner" role="note">
        <Icon name="alert" />
        <div className="grow">
          <span>
            <strong style={{ fontWeight: 500 }}>This is a second payment for the same order.</strong> The first one is kept; this one {own?.status === "refunded" ? "was refunded" : own?.status === "dismissed" ? "was reviewed and kept" : "should be refunded"}.
          </span>
          <div className="row wrap">
            <Link className="btn btn-secondary btn-sm" to={`${base}/payments/${encodeURIComponent(ops.duplicate_of)}`}>
              Open the first payment
            </Link>
            {own && (
              <Link className="btn btn-ghost btn-sm" to={`${base}/refunds?case=${own.id}`}>
                Refund case
                <RefundPill status={own.status} />
              </Link>
            )}
          </div>
        </div>
      </div>
    );
  }
  if (!ops.duplicates?.length) return null;
  return (
    <div className="banner" role="note">
      <Icon name="alert" />
      <div className="grow">
        <span>
          <strong style={{ fontWeight: 500 }}>The buyer paid again after this.</strong> This payment is the one to keep; the later {ops.duplicates.length === 1 ? "one is" : "ones are"} in Refunds.
        </span>
        <div className="row wrap">
          {ops.duplicates.map((a) => (
            <Link key={a} className="btn btn-secondary btn-sm" to={`${base}/payments/${encodeURIComponent(a)}`}>
              Open {ops.duplicates.length > 1 ? shortId(a, 4) : "the second payment"}
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}

function RefundsCard({ p, ops, events, base }: { p: Payment; ops: PaymentOps | null; events: StoredEvent[]; base: string }) {
  const now = useNow(30_000);
  const refunds = events.filter((e) => e.type === "payment.refunded");
  const cases = (ops?.refund_cases ?? []).filter((c) => c.attempt_id === p.attempt_id);
  const refunded = ops?.refunded_paisa ?? p.refunded_paisa ?? refunds.reduce((s, e) => s + (e.amount_paisa ?? 0), 0);
  if (!refunds.length && !cases.length) return null;
  return (
    <section className="card" aria-labelledby="refunds-title">
      <div className="card-head">
        <h2 id="refunds-title">Refunds</h2>
        {refunded > 0 && (
          <span className="hint">
            {formatMoney(refunded)} of {formatMoney(p.amount_paisa)} refunded
          </span>
        )}
      </div>
      <div className="list">
        {refunds.map((e) => (
          <div key={e.id} className="list-row">
            <Icon name="undo" className="subtle" />
            <div className="grow">
              <div className="ink">
                <Money paisa={e.amount_paisa ?? null} /> refunded{e.data?.refund_ref ? <span className="muted">, ref <span className="mono">{e.data.refund_ref}</span></span> : null}
              </div>
              {e.data?.refund_reason && <div className="meta">{e.data.refund_reason}</div>}
            </div>
            <Time t={e.ts}>
              <span className="meta">{formatDateTime(e.ts, now)}</span>
            </Time>
          </div>
        ))}
        {cases.map((c) => (
          <Link key={c.id} to={`${base}/refunds?case=${c.id}`} className="list-row">
            <Icon name="inbox" className="subtle" />
            <div className="grow">
              <div className="ink">
                {kindLabel(c)}, <Money paisa={c.amount_paisa} />
              </div>
              <div className="meta">Opened {formatRelative(c.created_at, now)}</div>
            </div>
            <RefundPill status={c.status} />
            <Icon name="chevronRight" className="subtle" />
          </Link>
        ))}
      </div>
    </section>
  );
}

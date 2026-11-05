import { OPEN_STATUSES, type Explanation, type LiveMessage, type Payment, type PaymentDetail as Detail } from "@paynp/shared";
import { Link, useParams } from "react-router";
import { Icon } from "../components/Icon.tsx";
import { Timeline } from "../components/Timeline.tsx";
import { useProject } from "../components/Shell.tsx";
import { CopyButton, EmptySmall, Gateway, Skeleton, StatusPill, Time, useNow } from "../components/ui.tsx";
import { ApiFailure, errorMessage, qs } from "../lib/api.ts";
import { formatDuration, formatFull, gatewayName, moneyParts } from "../lib/format.ts";
import { useLive } from "../lib/live.ts";
import { useQuery } from "../lib/query.ts";

export default function PaymentDetail() {
  const { project, env, base } = useProject();
  const { attempt = "" } = useParams();
  const key = `/api/projects/${project.id}/payments/${encodeURIComponent(attempt)}${qs({ env })}`;
  const d = useQuery<Detail>(key, { staleMs: 2_000 });
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
      <Header p={p} base={base} />
      <div className="stack-lg">
        {explain && <ExplainCard ex={explain} p={p} />}
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

function Header({ p, base }: { p: Payment; base: string }) {
  const now = useNow(1000);
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
      </div>
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

import type { Analytics, GatewayHealth, Incident, Page, Payment } from "@paynp/shared";
import { useMemo, useState } from "react";
import { Link } from "react-router";
import { Chart, type ChartSeries } from "../components/Chart.tsx";
import { Icon } from "../components/Icon.tsx";
import { SetupEmpty, TestPaymentButton } from "../components/Setup.tsx";
import { useProject } from "../components/Shell.tsx";
import { EmptySmall, Gateway, Money, Seg, Skeleton, Spark, StatusPill, Time, useNow } from "../components/ui.tsx";
import { items, qs } from "../lib/api.ts";
import { formatCount, formatCountCompact, formatDuration, formatMoney, formatOtherCurrencies, formatPct, formatRelative, moneyParts } from "../lib/format.ts";
import { reasonLabel } from "../lib/labels.ts";
import { useQuery } from "../lib/query.ts";
import { RANGES, useMinute, type RangeKey } from "../lib/range.ts";

export default function Overview() {
  const { project, env, base, local } = useProject();
  const [range, setRange] = useState<RangeKey>("24h");
  const r = RANGES[range];
  const now = useMinute();
  const p = `/api/projects/${project.id}`;
  const cur = useQuery<Analytics>(`${p}/analytics${qs({ env, from: now - r.ms, to: now, bucket: r.bucket })}`, { refreshMs: 60_000 });
  const prev = useQuery<Analytics>(`${p}/analytics${qs({ env, from: now - 2 * r.ms, to: now - r.ms, bucket: r.bucket })}`);
  const any = useQuery<Page<Payment>>(`${p}/payments${qs({ env, limit: 1 })}`);

  if (any.data && !items(any.data).length) {
    return (
      <>
        <Head range={range} setRange={setRange} showRange={false} />
        <div style={{ height: 20 }} />
        <SetupEmpty />
      </>
    );
  }

  const a = cur.data;
  return (
    <div className="stack-lg">
      <Head range={range} setRange={setRange} />
      <Kpis a={a} prev={prev.data} prevLabel={r.prev} />
      <div className="grid-2 grid-2-1">
        <VolumeCard a={a} bucket={r.bucket} label={r.label} />
        <div className="stack">
          <HealthCard />
          {!local && <IncidentsCard base={base} />}
        </div>
      </div>
      <div className="grid-2">
        <RecentFailures />
        <ReasonsCard a={a} base={base} />
      </div>
    </div>
  );
}

function Head({ range, setRange, showRange = true }: { range: RangeKey; setRange: (r: RangeKey) => void; showRange?: boolean }) {
  return (
    <div className="page-head" style={{ marginBlockEnd: 0 }}>
      <div>
        <h1>Overview</h1>
        <p>{showRange ? `${RANGES[range].label}, Nepal time` : "Nothing received yet"}</p>
      </div>
      {showRange && (
        <Seg
          label="Range"
          value={range}
          onChange={setRange}
          options={[
            { value: "24h", label: "24h" },
            { value: "7d", label: "7d" },
            { value: "30d", label: "30d" },
          ]}
        />
      )}
    </div>
  );
}

function delta(cur: number | null | undefined, prev: number | null | undefined, kind: "ratio" | "points" = "ratio") {
  if (cur === null || cur === undefined || prev === null || prev === undefined) return null;
  if (kind === "points") {
    const pts = Math.round((cur - prev) * 1000) / 10;
    return { v: pts, text: pts === 0 ? "No change" : `${pts > 0 ? "+" : ""}${pts.toFixed(1)} pts` };
  }
  if (!prev) return null;
  const d = (cur - prev) / prev;
  const pct = Math.round(d * 1000) / 10;
  return { v: pct, text: pct === 0 ? "No change" : `${pct > 0 ? "+" : ""}${pct.toFixed(1)}%` };
}

function Delta({ d, goodUp = true, label }: { d: ReturnType<typeof delta>; goodUp?: boolean; label: string }) {
  if (!d) return <span className="subtle">No earlier data</span>;
  const good = d.v === 0 ? null : d.v > 0 === goodUp;
  return (
    <span>
      <span className="num" style={{ color: good === null ? "var(--muted)" : good ? "var(--ok-ink)" : "var(--crit-ink)" }}>
        {d.text}
      </span>
      <span className="hide-sm"> vs {label}</span>
    </span>
  );
}

function Kpis({ a, prev, prevLabel }: { a?: Analytics; prev?: Analytics; prevLabel: string }) {
  const t = a?.totals;
  const pt = prev?.totals;
  const money = t ? moneyParts(t.revenue_paisa) : null;
  return (
    <section className="cells kpis" aria-label="Key numbers">
      <div className="tile">
        <span className="tile-label">Payments</span>
        <span className="tile-value">{t ? formatCount(t.started) : <Skeleton w={80} h={24} />}</span>
        <div className="tile-foot">
          <Delta d={delta(t?.started, pt?.started)} label={prevLabel} />
          {a && <Spark values={a.series.map((s) => s.started)} />}
        </div>
      </div>
      <div className="tile">
        <span className="tile-label">Success rate</span>
        <span className="tile-value">{t ? formatPct(t.success_rate) : <Skeleton w={80} h={24} />}</span>
        <div className="tile-foot">
          <Delta d={delta(t?.success_rate, pt?.success_rate, "points")} label={prevLabel} />
          {a && <Spark values={a.series.map((s) => s.success_rate)} color="var(--st-paid)" />}
        </div>
      </div>
      <div className="tile">
        <span className="tile-label">Revenue</span>
        <span className="tile-value" title={t ? formatMoney(t.revenue_paisa) : undefined}>
          {money ? (
            <>
              <span className="unit">Rs</span>
              {money.int}
              <span className="frac">.{money.frac}</span>
            </>
          ) : (
            <Skeleton w={120} h={24} />
          )}
        </span>
        {formatOtherCurrencies(t?.revenue_by_currency) && <span className="tile-other">+ {formatOtherCurrencies(t?.revenue_by_currency)}</span>}
        <div className="tile-foot">
          <Delta d={delta(t?.revenue_paisa, pt?.revenue_paisa)} label={prevLabel} />
          {a && <Spark values={a.series.map((s) => s.revenue_paisa)} />}
        </div>
      </div>
      <div className="tile">
        <span className="tile-label">Time to pay, median</span>
        <span className="tile-value">{a ? formatDuration(a.time_to_pay_ms.p50) : <Skeleton w={80} h={24} />}</span>
        <div className="tile-foot">
          <span>{a ? <>p95 {formatDuration(a.time_to_pay_ms.p95)}</> : null}</span>
        </div>
      </div>
    </section>
  );
}

function VolumeCard({ a, bucket, label }: { a?: Analytics; bucket: "hour" | "day"; label: string }) {
  const { t, series } = useMemo(() => {
    const s = a?.series ?? [];
    const series: ChartSeries[] = [
      { label: "Paid", values: s.map((x) => x.paid), color: "--series-1", kind: "bar", stack: true },
      { label: "Not paid", values: s.map((x) => x.failed), color: "--st-failed", kind: "bar", stack: true },
    ];
    return { t: s.map((x) => x.t), series };
  }, [a]);
  return (
    <section className="card">
      <div className="card-head">
        <div>
          <h2>Payments</h2>
          <span className="hint">
            {label}, per {bucket}
          </span>
        </div>
        <div className="legend" aria-hidden="true">
          <span>
            <i style={{ background: "var(--series-1)" }} />
            Paid
          </span>
          <span>
            <i style={{ background: "var(--st-failed)" }} />
            Failed, canceled or expired
          </span>
        </div>
      </div>
      <div className="card-body" style={{ paddingInline: 8, paddingBlockEnd: 8 }}>
        {a ? <Chart t={t} series={series} bucket={bucket} height={280} yFormat={formatCountCompact} integer ariaLabel={`Paid and unpaid payments per ${bucket}`} /> : <div style={{ height: 280 }} />}
      </div>
    </section>
  );
}

function HealthCard() {
  const { project, env } = useProject();
  const h = useQuery<GatewayHealth[] | Page<GatewayHealth>>(`/api/projects/${project.id}/health${qs({ env })}`, { refreshMs: 30_000 });
  const list = items(h.data as Page<GatewayHealth> | GatewayHealth[] | undefined);
  return (
    <section className="card">
      <div className="card-head">
        <h2>Gateway health</h2>
        <span className="hint">Last 15 minutes</span>
      </div>
      {list.length ? (
        <div className="list">
          {list.map((g) => (
            <div key={g.gateway} className="list-row" style={g.state === "degraded" ? { background: "var(--tone-cream)" } : g.state === "down" ? { background: "var(--tone-rose)" } : undefined}>
              <div className="grow">
                <Gateway id={g.gateway} />
              </div>
              <span className="meta num" title="Average response time">
                {g.latency_avg === null ? "-" : formatDuration(g.latency_avg)}
              </span>
              <span className="meta num" title="Error rate" style={{ minWidth: 44, textAlign: "right" }}>
                {formatPct(g.error_rate, 0)}
              </span>
              <span className="pill pill-plain" data-s={g.state === "idle" ? "neutral" : g.state} style={{ minWidth: 76, justifyContent: "flex-end" }}>
                {g.state === "ok" ? "Healthy" : g.state === "idle" ? "Idle" : g.state === "degraded" ? "Degraded" : "Down"}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <div className="card-body">
          <Skeleton h={80} />
        </div>
      )}
    </section>
  );
}

function IncidentsCard({ base }: { base: string }) {
  const { project } = useProject();
  const inc = useQuery<Page<Incident>>(`/api/projects/${project.id}/incidents?state=firing`, { refreshMs: 60_000 });
  const list = items(inc.data);
  const now = useNow();
  return (
    <section className="card">
      <div className="card-head">
        <h2>Open incidents</h2>
        <Link to={`${base}/alerts/incidents`} className="btn btn-ghost btn-sm">
          All
          <Icon name="chevronRight" size={14} />
        </Link>
      </div>
      {inc.data && !list.length ? (
        <EmptySmall icon="check" title="All clear">
          No alert is firing.
        </EmptySmall>
      ) : (
        <div className="list">
          {list.slice(0, 4).map((i) => (
            <Link key={i.id} to={`${base}/alerts/incidents`} className="list-row">
              <StatusPill status="firing" />
              <div className="grow">
                <div className="truncate ink" style={{ fontSize: 13 }}>
                  {i.summary}
                </div>
                <div className="meta">
                  Opened <Time t={i.opened_at}>{formatRelative(i.opened_at, now)}</Time>
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}

function RecentFailures() {
  const { project, env, base } = useProject();
  const q = useQuery<Page<Payment>>(`/api/projects/${project.id}/payments${qs({ env, status: "failed", limit: 6 })}`, { refreshMs: 30_000 });
  const list = items(q.data);
  const now = useNow();
  return (
    <section className="card">
      <div className="card-head">
        <h2>Recent failures</h2>
        <Link to={`${base}/payments?status=failed`} className="btn btn-ghost btn-sm">
          View all
          <Icon name="chevronRight" size={14} />
        </Link>
      </div>
      {q.data && !list.length ? (
        <EmptySmall icon="check" title="No failed payments">
          <TestPaymentButton className="btn btn-secondary btn-sm" />
        </EmptySmall>
      ) : (
        <div className="list">
          {list.map((p) => (
            <Link key={p.attempt_id} to={`${base}/payments/${encodeURIComponent(p.attempt_id)}`} className="list-row">
              <span className="gw-col">
                <Gateway id={p.gateway} />
              </span>
              <div className="grow">
                <div className="truncate ink" style={{ fontSize: 13 }}>
                  {p.last_reason ? reasonLabel(p.last_reason) : "Failed"}
                </div>
                <div className="meta truncate">
                  {p.order_id ?? p.attempt_id} · <Time t={p.started_at}>{formatRelative(p.started_at, now)}</Time>
                </div>
              </div>
              <Money paisa={p.amount_paisa} currency={p.currency} />
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}

function ReasonsCard({ a, base }: { a?: Analytics; base: string }) {
  const reasons = a?.failure_reasons.slice(0, 6) ?? [];
  const max = Math.max(1, ...reasons.map((r) => r.count));
  return (
    <section className="card">
      <div className="card-head">
        <h2>Why payments did not complete</h2>
        <Link to={`${base}/analytics`} className="btn btn-ghost btn-sm">
          Analytics
          <Icon name="chevronRight" size={14} />
        </Link>
      </div>
      <div className="card-body" style={{ paddingBlock: 4 }}>
        {!a ? (
          <Skeleton h={120} />
        ) : !reasons.length ? (
          <EmptySmall icon="check" title="Nothing to explain" />
        ) : (
          <div className="bars">
            {reasons.map((r) => (
              <div key={r.reason} className="bar-row">
                <span className="truncate">{reasonLabel(r.reason)}</span>
                <span className="num muted">{formatCount(r.count)}</span>
                <div className="bar-track">
                  <div className="bar-fill" style={{ width: `${(r.count / max) * 100}%`, ["--c" as string]: "var(--ink)" }} />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

import type { Analytics as Data } from "@paynp/shared";
import { useMemo } from "react";
import { useSearchParams } from "react-router";
import { Chart, type ChartSeries } from "../components/Chart.tsx";
import { useProject } from "../components/Shell.tsx";
import { EmptySmall, Gateway, Money, Seg, Skeleton } from "../components/ui.tsx";
import { qs } from "../lib/api.ts";
import { formatCount, formatCountCompact, formatDuration, formatMoney, formatMoneyCompact, formatPct, moneyParts } from "../lib/format.ts";
import { reasonLabel } from "../lib/labels.ts";
import { useQuery } from "../lib/query.ts";
import { RANGES, isRange, useMinute } from "../lib/range.ts";

export default function Analytics() {
  const { project, env } = useProject();
  const [params, setParams] = useSearchParams();
  const range = isRange(params.get("range")) ? (params.get("range") as keyof typeof RANGES) : "7d";
  const r = RANGES[range];
  const bucket = params.get("bucket") === "hour" || params.get("bucket") === "day" ? (params.get("bucket") as "hour" | "day") : r.bucket;
  const gateway = params.get("gateway") ?? "";
  const now = useMinute();
  const a = useQuery<Data>(`/api/projects/${project.id}/analytics${qs({ env, from: now - r.ms, to: now, bucket, gateway })}`, { refreshMs: 60_000 });
  const set = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    if (k === "range") next.delete("bucket");
    setParams(next, { replace: true });
  };
  const d = a.data;

  const charts = useMemo(() => {
    const s = d?.series ?? [];
    const t = s.map((x) => x.t);
    const volume: ChartSeries[] = [
      { label: "Paid", values: s.map((x) => x.paid), color: "--series-1", kind: "bar", stack: true },
      { label: "Not paid", values: s.map((x) => x.failed), color: "--st-failed", kind: "bar", stack: true },
    ];
    const revenue: ChartSeries[] = [{ label: "Revenue", values: s.map((x) => x.revenue_paisa), color: "--series-1", kind: "bar", format: (v) => formatMoney(v) }];
    const rate: ChartSeries[] = [{ label: "Success rate", values: s.map((x) => x.success_rate), color: "--st-paid", kind: "line", format: (v) => formatPct(v) }];
    const latency: ChartSeries[] = [{ label: "Average response", values: s.map((x) => x.gw_latency_avg), color: "--series-1", kind: "line", format: (v) => (v === null ? "-" : formatDuration(v)) }];
    return { t, volume, revenue, rate, latency };
  }, [d]);

  const tot = d?.totals;
  const money = tot ? moneyParts(tot.revenue_paisa) : null;
  const empty = d && !d.totals.started;

  return (
    <div className="stack-lg">
      <div className="page-head" style={{ marginBlockEnd: 0 }}>
        <div>
          <h1>Analytics</h1>
          <p>
            {r.label}, per {bucket}, Nepal time
          </p>
        </div>
        <div className="actions">
          <select className="select" style={{ width: "auto", height: 32 }} aria-label="Gateway" value={gateway} onChange={(e) => set("gateway", e.target.value)}>
            <option value="">All gateways</option>
            <option value="esewa">eSewa</option>
            <option value="khalti">Khalti</option>
            <option value="fonepay">Fonepay</option>
          </select>
          <Seg label="Bucket" value={bucket} onChange={(v) => set("bucket", v)} options={[{ value: "hour", label: "Hour" }, { value: "day", label: "Day" }]} />
          <Seg label="Range" value={range} onChange={(v) => set("range", v)} options={[{ value: "24h", label: "24h" }, { value: "7d", label: "7d" }, { value: "30d", label: "30d" }]} />
        </div>
      </div>

      <section className="cells kpis" aria-label="Totals">
        <div className="tile">
          <span className="tile-label">Payments started</span>
          <span className="tile-value">{tot ? formatCount(tot.started) : <Skeleton w={80} h={24} />}</span>
          <span className="tile-foot">{tot && <span>{formatCount(tot.paid)} paid, {formatCount(tot.failed)} not paid</span>}</span>
        </div>
        <div className="tile">
          <span className="tile-label">Success rate</span>
          <span className="tile-value">{tot ? formatPct(tot.success_rate) : <Skeleton w={80} h={24} />}</span>
          <span className="tile-foot">Paid out of finished payments</span>
        </div>
        <div className="tile">
          <span className="tile-label">Revenue</span>
          <span className="tile-value">
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
          <span className="tile-foot">{tot && tot.paid ? <span>Average {formatMoney(Math.round(tot.revenue_paisa / tot.paid))}</span> : null}</span>
        </div>
        <div className="tile">
          <span className="tile-label">Time to pay</span>
          <span className="tile-value">{d ? formatDuration(d.time_to_pay_ms.p50) : <Skeleton w={80} h={24} />}</span>
          <span className="tile-foot">{d && <span>Median, p95 {formatDuration(d.time_to_pay_ms.p95)}</span>}</span>
        </div>
      </section>

      {empty ? (
        <div className="card">
          <EmptySmall icon="chart" title="No payments in this range">
            Pick a longer range, or send a test payment from the Overview.
          </EmptySmall>
        </div>
      ) : (
        <>
          <div className="grid-2">
            <ChartCard title="Payments" hint="Paid, and failed, canceled or expired" legend={[["Paid", "--series-1"], ["Not paid", "--st-failed"]]}>
              {d && <Chart t={charts.t} series={charts.volume} bucket={bucket} yFormat={formatCountCompact} integer ariaLabel="Payments per bucket" />}
            </ChartCard>
            <ChartCard title="Revenue" hint="Paid amount">
              {d && <Chart t={charts.t} series={charts.revenue} bucket={bucket} yFormat={(v) => formatMoneyCompact(v)} ariaLabel="Revenue per bucket" />}
            </ChartCard>
            <ChartCard title="Success rate" hint="Paid out of finished, per bucket">
              {d && <Chart t={charts.t} series={charts.rate} bucket={bucket} yMax={1} yFormat={(v) => `${Math.round(v * 100)}%`} ariaLabel="Success rate per bucket" />}
            </ChartCard>
            <ChartCard title="Gateway latency" hint="Average response time of gateway calls">
              {d && <Chart t={charts.t} series={charts.latency} bucket={bucket} yFormat={(v) => (v >= 1000 ? `${(v / 1000).toFixed(v >= 10_000 ? 0 : 1)} s` : `${Math.round(v)} ms`)} ariaLabel="Average gateway latency per bucket" />}
            </ChartCard>
          </div>

          <GatewayTable d={d} />

          <div className="grid-2">
            <Funnel d={d} />
            <Reasons d={d} />
          </div>
        </>
      )}
    </div>
  );
}

function ChartCard({ title, hint, legend, children }: { title: string; hint: string; legend?: [string, string][]; children: React.ReactNode }) {
  return (
    <section className="card">
      <div className="card-head">
        <div>
          <h2>{title}</h2>
          <span className="hint">{hint}</span>
        </div>
        {legend && (
          <div className="legend" aria-hidden="true">
            {legend.map(([l, c]) => (
              <span key={l}>
                <i style={{ background: `var(${c})` }} />
                {l}
              </span>
            ))}
          </div>
        )}
      </div>
      <div className="card-body" style={{ paddingInline: 8, paddingBlockEnd: 8, minHeight: 236 }}>
        {children}
      </div>
    </section>
  );
}

function GatewayTable({ d }: { d?: Data }) {
  const rows = d?.by_gateway ?? [];
  const total = rows.reduce((s, r) => s + r.started, 0) || 1;
  return (
    <section className="card">
      <div className="card-head">
        <div>
          <h2>By gateway</h2>
          <span className="hint">Share of payments started, and how each one converts</span>
        </div>
      </div>
      <div style={{ overflowX: "auto" }}>
        <table className="t">
          <thead>
            <tr>
              <th>Gateway</th>
              <th style={{ width: "28%" }} className="hide-sm">
                Share
              </th>
              <th className="r">Payments</th>
              <th className="r hide-sm">Paid</th>
              <th className="r hide-sm">Not paid</th>
              <th className="r">Success</th>
              <th className="r">Revenue</th>
            </tr>
          </thead>
          <tbody>
            {!d
              ? [0, 1, 2].map((i) => (
                  <tr key={i}>
                    <td colSpan={7}>
                      <Skeleton />
                    </td>
                  </tr>
                ))
              : rows.map((g) => (
                  <tr key={g.gateway}>
                    <td>
                      <Gateway id={g.gateway} />
                    </td>
                    <td className="hide-sm">
                      <div className="row" style={{ gap: 10 }}>
                        <div className="bar-track" style={{ flex: 1 }}>
                          <div className="bar-fill" style={{ width: `${(g.started / total) * 100}%`, ["--c" as string]: `var(--gw-${["esewa", "khalti", "fonepay", "connectips"].includes(g.gateway) ? g.gateway : "other"})` }} />
                        </div>
                        <span className="num muted" style={{ width: 44, textAlign: "right" }}>
                          {formatPct(g.started / total, 0)}
                        </span>
                      </div>
                    </td>
                    <td className="r">{formatCount(g.started)}</td>
                    <td className="r hide-sm">{formatCount(g.paid)}</td>
                    <td className="r hide-sm">{formatCount(g.failed)}</td>
                    <td className="r">{formatPct(g.success_rate)}</td>
                    <td className="r">
                      <Money paisa={g.revenue_paisa} />
                    </td>
                  </tr>
                ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Funnel({ d }: { d?: Data }) {
  const f = d?.funnel;
  const steps = f
    ? [
        { label: "Started", v: f.started },
        { label: "Sent to gateway", v: f.redirected },
        { label: "Came back", v: f.callback },
        { label: "Paid", v: f.paid },
      ]
    : [];
  const top = steps[0]?.v || 1;
  return (
    <section className="card">
      <div className="card-head">
        <div>
          <h2>Funnel</h2>
          <span className="hint">Where buyers drop between start and paid</span>
        </div>
      </div>
      <div className="card-body">
        {!f ? (
          <Skeleton h={160} />
        ) : (
          <div className="funnel">
            {steps.map((s, i) => {
              const prev = steps[i - 1]?.v;
              return (
                <div key={s.label} className="funnel-step">
                  <span className="truncate">{s.label}</span>
                  <div className="bar-track">
                    <div className="bar-fill" style={{ width: `${(s.v / top) * 100}%`, ["--i" as string]: i }} />
                  </div>
                  <span className="num" style={{ textAlign: "right" }}>
                    <span className="ink">{formatPct(s.v / top, 0)}</span>
                    <span className="drop" style={{ display: "block" }}>
                      {i === 0 ? formatCount(s.v) : prev ? `-${formatCount(prev - s.v)}` : ""}
                    </span>
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}

function Reasons({ d }: { d?: Data }) {
  const list = d?.failure_reasons ?? [];
  const total = list.reduce((s, r) => s + r.count, 0) || 1;
  const max = Math.max(1, ...list.map((r) => r.count));
  return (
    <section className="card">
      <div className="card-head">
        <div>
          <h2>Failure reasons</h2>
          <span className="hint">Why finished payments were not paid</span>
        </div>
      </div>
      <div className="card-body" style={{ paddingBlock: 4 }}>
        {!d ? (
          <Skeleton h={160} />
        ) : !list.length ? (
          <EmptySmall icon="check" title="No failures in this range" />
        ) : (
          <div className="bars">
            {list.slice(0, 8).map((r) => (
              <div key={r.reason} className="bar-row">
                <span className="truncate">{reasonLabel(r.reason)}</span>
                <span className="num muted">
                  {formatCount(r.count)} <span className="subtle">({formatPct(r.count / total, 0)})</span>
                </span>
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

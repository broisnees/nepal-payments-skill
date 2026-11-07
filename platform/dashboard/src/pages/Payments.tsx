import { OPEN_STATUSES, type LiveMessage, type Page, type Payment } from "@paynp/shared";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { Icon } from "../components/Icon.tsx";
import { SetupEmpty } from "../components/Setup.tsx";
import { useProject } from "../components/Shell.tsx";
import { EmptySmall, Gateway, Money, Skeleton, StatusPill, Time, useNow, Select } from "../components/ui.tsx";
import { api, errorMessage, items, qs } from "../lib/api.ts";
import { formatDuration, formatRelative, formatTime, parseRupees } from "../lib/format.ts";
import { reasonLabel } from "../lib/labels.ts";
import { useLive } from "../lib/live.ts";
import { useQuery } from "../lib/query.ts";

const STATUS_OPTIONS = [
  { value: "", label: "Any status" },
  { value: "paid", label: "Paid" },
  { value: "failed", label: "Failed" },
  { value: "open", label: "Open" },
  { value: "canceled", label: "Canceled" },
  { value: "expired", label: "Expired" },
  { value: "refunded", label: "Refunded" },
];
const GATEWAY_OPTIONS = [
  { value: "", label: "Any gateway" },
  { value: "esewa", label: "eSewa" },
  { value: "khalti", label: "Khalti" },
  { value: "fonepay", label: "Fonepay" },
  { value: "connectips", label: "connectIPS" },
];
const TIME_OPTIONS = [
  { value: "", label: "Any time" },
  { value: "1h", label: "Last hour" },
  { value: "24h", label: "Last 24 hours" },
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
];
const SPANS: Record<string, number> = { "1h": 3_600_000, "24h": 86_400_000, "7d": 7 * 86_400_000, "30d": 30 * 86_400_000 };

export default function Payments() {
  const { project, env, base } = useProject();
  const [params, setParams] = useSearchParams();
  const nav = useNavigate();
  const status = params.get("status") ?? "";
  const gateway = params.get("gateway") ?? "";
  const time = params.get("time") ?? "";
  const q = params.get("q") ?? "";
  const min = params.get("min") ?? "";
  const max = params.get("max") ?? "";
  const [search, setSearch] = useState(q);
  const searchRef = useRef<HTMLInputElement>(null);
  const now = useNow(10_000);
  // Recomputed only when the time filter changes, so the query key is stable.
  const from = useMemo(() => (time && SPANS[time] ? Math.floor((Date.now() - SPANS[time]) / 60_000) * 60_000 : null), [time]);

  const set = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next, { replace: true });
  };

  useEffect(() => {
    const id = setTimeout(() => {
      if (search.trim() !== q) set("q", search.trim());
    }, 250);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  // "/" focuses search, like most tools that have one.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey) return;
      const t = e.target as HTMLElement;
      if (t.closest("input, textarea, select, [contenteditable]")) return;
      e.preventDefault();
      searchRef.current?.focus();
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);

  const minPaisa = min ? parseRupees(min) : null;
  const maxPaisa = max ? parseRupees(max) : null;
  const key = `/api/projects/${project.id}/payments${qs({ env, status, gateway, q, from, min: minPaisa, max: maxPaisa, limit: 50 })}`;
  const first = useQuery<Page<Payment>>(key, { staleMs: 5_000 });

  // Rows = first page, plus pages loaded with "Load more", plus live upserts.
  const [rows, setRows] = useState<Payment[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const [moreErr, setMoreErr] = useState("");
  const [flash, setFlash] = useState<Record<string, number>>({});
  useEffect(() => {
    if (!first.data) return;
    setRows(items(first.data));
    setCursor(first.data.next_cursor);
  }, [first.data]);

  const filtered = Boolean(status || gateway || q || time || min || max);
  const matches = (p: Payment) =>
    (!status || (status === "open" ? OPEN_STATUSES.includes(p.status) : p.status === status)) &&
    (!gateway || p.gateway === gateway) &&
    (!q || [p.attempt_id, p.order_id, p.provider_ref].some((v) => v?.toLowerCase().startsWith(q.toLowerCase()))) &&
    (minPaisa === null || (p.amount_paisa ?? 0) >= minPaisa) &&
    (maxPaisa === null || (p.amount_paisa ?? 0) <= maxPaisa);

  const [paused, setPaused] = useState(false);
  const live = useLive(
    project.id,
    env,
    (m: LiveMessage) => {
      if (m.kind !== "event" || paused) return;
      const p = m.payment;
      setRows((prev) => {
        const i = prev.findIndex((x) => x.attempt_id === p.attempt_id);
        if (i >= 0) {
          if (!matches(p)) return prev.filter((_, j) => j !== i);
          const next = prev.slice();
          next[i] = p;
          return next;
        }
        return matches(p) ? [p, ...prev] : prev;
      });
      setFlash((f) => ({ ...f, [p.attempt_id]: (f[p.attempt_id] ?? 0) + 1 }));
    },
    Boolean(first.data),
  );

  const loadMore = async () => {
    if (!cursor) return;
    setMore(true);
    setMoreErr("");
    try {
      const page = await api<Page<Payment>>(`${key}&cursor=${encodeURIComponent(cursor)}`);
      setRows((prev) => {
        const seen = new Set(prev.map((p) => p.attempt_id));
        return prev.concat(page.items.filter((p) => !seen.has(p.attempt_id)));
      });
      setCursor(page.next_cursor);
    } catch (e) {
      setMoreErr(errorMessage(e));
    } finally {
      setMore(false);
    }
  };

  if (first.data && !filtered && !rows.length) {
    return (
      <>
        <div className="page-head">
          <div>
            <h1>Payments</h1>
            <p>Every attempt across gateways, newest first</p>
          </div>
        </div>
        <SetupEmpty />
      </>
    );
  }

  const chips = [
    status && { k: "status", label: STATUS_OPTIONS.find((o) => o.value === status)?.label ?? status },
    gateway && { k: "gateway", label: GATEWAY_OPTIONS.find((o) => o.value === gateway)?.label ?? gateway },
    time && { k: "time", label: TIME_OPTIONS.find((o) => o.value === time)?.label ?? time },
    min && { k: "min", label: `From Rs ${min}` },
    max && { k: "max", label: `Up to Rs ${max}` },
  ].filter(Boolean) as { k: string; label: string }[];

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Payments</h1>
          <p>Every attempt across gateways, newest first. Times in Nepal time.</p>
        </div>
        <div className="actions">
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setPaused((v) => !v)} aria-pressed={paused}>
            <span className="live-dot" data-state={paused ? "paused" : live === "open" ? "on" : "off"} aria-hidden="true" />
            {paused ? "Paused" : live === "open" ? "Live" : "Connecting"}
          </button>
        </div>
      </div>

      <div className="filters" role="search">
        <label className="input-icon grow">
          <span className="sr-only">Search</span>
          <Icon name="search" />
          <input
            ref={searchRef}
            className="input"
            placeholder="Order id, attempt id or gateway reference"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            spellCheck={false}
          />
          {!search && <span className="kbd hide-sm">/</span>}
        </label>
        <Select aria-label="Status" value={status} onChange={(v) => set("status", v)} options={STATUS_OPTIONS} />
        <Select aria-label="Gateway" value={gateway} onChange={(v) => set("gateway", v)} options={GATEWAY_OPTIONS} />
        <Select aria-label="Time" value={time} onChange={(v) => set("time", v)} options={TIME_OPTIONS} />
        <AmountFilter min={min} max={max} onApply={(a, b) => {
          const next = new URLSearchParams(params);
          a ? next.set("min", a) : next.delete("min");
          b ? next.set("max", b) : next.delete("max");
          setParams(next, { replace: true });
        }} />
      </div>
      {chips.length > 0 && (
        <div className="filters" style={{ marginBlockStart: -4 }}>
          {chips.map((c) => (
            <span key={c.k} className="chip-x">
              {c.label}
              <button type="button" aria-label={`Remove ${c.label}`} onClick={() => set(c.k, "")}>
                <Icon name="x" size={12} />
              </button>
            </span>
          ))}
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => (setSearch(""), setParams({}, { replace: true }))}>
            Clear all
          </button>
        </div>
      )}

      <div className="table-wrap">
        <table className="t">
          <thead>
            <tr>
              <th style={{ width: 120 }}>Status</th>
              <th className="r" style={{ width: 150 }}>
                Amount
              </th>
              <th style={{ width: 120 }}>Gateway</th>
              <th>Order</th>
              <th className="hide-md">Reference</th>
              <th className="hide-sm">Started</th>
              <th className="r hide-md">Duration</th>
            </tr>
          </thead>
          <tbody>
            {!first.data && !first.error
              ? Array.from({ length: 8 }, (_, i) => (
                  <tr key={i}>
                    {Array.from({ length: 7 }, (_, j) => (
                      <td key={j} className={j === 4 || j === 6 ? "hide-md" : j === 5 ? "hide-sm" : undefined}>
                        <Skeleton w={j === 3 ? 160 : 72} />
                      </td>
                    ))}
                  </tr>
                ))
              : rows.map((p) => {
                  const href = `${base}/payments/${encodeURIComponent(p.attempt_id)}`;
                  const open = OPEN_STATUSES.includes(p.status);
                  return (
                    <tr key={p.attempt_id} className="clickable" data-flash={flash[p.attempt_id] ? (flash[p.attempt_id] % 2 ? "a" : "b") : undefined} onClick={(e) => (e.target as HTMLElement).closest("a") || nav(href)}>
                      <td>
                        <StatusPill status={p.status} />
                      </td>
                      <td className="r">
                        <Money paisa={p.amount_paisa} currency={p.currency} />
                      </td>
                      <td>
                        <Gateway id={p.gateway} />
                      </td>
                      <td>
                        <div className="ids">
                          <Link className="cell-link" to={href}>
                            {p.order_id ?? <span className="muted">No order id</span>}
                          </Link>
                          <span className="mono">{p.attempt_id}</span>
                        </div>
                      </td>
                      <td className="hide-md">
                        {p.provider_ref ? (
                          <span className="mono" style={{ fontSize: 12 }}>
                            {p.provider_ref}
                          </span>
                        ) : p.last_reason && !open && p.status !== "paid" ? (
                          <span className="muted" style={{ fontSize: 12.5 }}>
                            {reasonLabel(p.last_reason)}
                          </span>
                        ) : (
                          <span className="subtle">-</span>
                        )}
                      </td>
                      <td className="hide-sm">
                        <Time t={p.started_at}>
                          <span className="ink">{formatRelative(p.started_at, now)}</span> <span className="subtle num">{formatTime(p.started_at)}</span>
                        </Time>
                      </td>
                      <td className="r hide-md muted num">{p.finished_at ? formatDuration(p.finished_at - p.started_at) : open ? <span title="Still open">open {formatDuration(now - p.started_at)}</span> : "-"}</td>
                    </tr>
                  );
                })}
          </tbody>
        </table>
        {first.error && !first.data ? (
          <EmptySmall icon="alert" title="Could not load payments">
            {errorMessage(first.error)}{" "}
            <button className="btn btn-ghost btn-sm" onClick={() => void first.refresh()}>
              Retry
            </button>
          </EmptySmall>
        ) : null}
        {first.data && !rows.length && (
          <EmptySmall icon="search" title="No payments match">
            Try a shorter search, or{" "}
            <button className="btn btn-ghost btn-sm" onClick={() => (setSearch(""), setParams({}, { replace: true }))}>
              clear the filters
            </button>
          </EmptySmall>
        )}
      </div>
      {cursor && rows.length > 0 && (
        <div className="row" style={{ justifyContent: "center", marginBlockStart: 12 }}>
          <button className="btn btn-secondary" onClick={loadMore} disabled={more}>
            {more && <span className="spinner" />}
            Load more
          </button>
          {moreErr && <span className="err">{moreErr}</span>}
        </div>
      )}
    </>
  );
}

function AmountFilter({ min, max, onApply }: { min: string; max: string; onApply: (min: string, max: string) => void }) {
  const [a, setA] = useState(min);
  const [b, setB] = useState(max);
  useEffect(() => {
    setA(min);
    setB(max);
  }, [min, max]);
  const apply = () => {
    const ok = (v: string) => !v || parseRupees(v) !== null;
    if (ok(a) && ok(b) && (a !== min || b !== max)) onApply(a, b);
  };
  return (
    <div className="row" style={{ gap: 4 }}>
      <input className="input num" style={{ width: 96 }} aria-label="Minimum amount in rupees" placeholder="Min Rs" inputMode="decimal" value={a} onChange={(e) => setA(e.target.value)} onBlur={apply} onKeyDown={(e) => e.key === "Enter" && apply()} />
      <span className="subtle" aria-hidden="true">
        to
      </span>
      <input className="input num" style={{ width: 96 }} aria-label="Maximum amount in rupees" placeholder="Max Rs" inputMode="decimal" value={b} onChange={(e) => setB(e.target.value)} onBlur={apply} onKeyDown={(e) => e.key === "Enter" && apply()} />
    </div>
  );
}

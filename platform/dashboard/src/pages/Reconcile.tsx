import type { GatewayFee, MissingSettlement, Page, RowFilter, Statement, StatementMapping, StatementNeedsMapping, StatementRow, StatementSummary } from "@paynp/shared";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router";
import { Chart, type ChartSeries } from "../components/Chart.tsx";
import { Icon } from "../components/Icon.tsx";
import { useProject } from "../components/Shell.tsx";
import { EmptySmall, Gateway, Money, Seg, Skeleton, confirmAction, toast, Select, type SelectOption } from "../components/ui.tsx";
import { ApiFailure, api, errorMessage, items, qs, upload } from "../lib/api.ts";
import { parseCsv } from "../lib/csv.ts";
import { formatCount, formatDate, formatDateTime, formatFeePct, formatMoney, formatMoneyCompact, gatewayName, parseStatementAmount } from "../lib/format.ts";
import { invalidate, setData, useQuery } from "../lib/query.ts";
import "../styles/ops.css";

const GATEWAYS = ["esewa", "khalti", "fonepay", "connectips", "nps", "imepay", "nepalpay", "hamropay", "getpay"];
type Field = "date" | "ref" | "amount" | "fee" | "net" | "status" | "settled_at";
const FIELDS: { key: Field; label: string; required?: boolean; hint: string }[] = [
  { key: "date", label: "Date", required: true, hint: "When the payment happened" },
  { key: "ref", label: "Reference", required: true, hint: "Transaction code, pidx, PRN or ref id" },
  { key: "amount", label: "Amount", required: true, hint: "What the buyer paid" },
  { key: "fee", label: "Fee", hint: "Charge, commission or MDR" },
  { key: "net", label: "Net", hint: "What reaches your bank" },
  { key: "status", label: "Status", hint: "Rows saying failed are skipped" },
  { key: "settled_at", label: "Settlement date", hint: "When it reached your bank" },
];

type Tab = Exclude<RowFilter, "all" | "errors">;

interface Pending {
  file: File;
  gateway: string;
  need: StatementNeedsMapping;
  rows: string[][];
}

export default function Reconcile() {
  const { project, env, canAdmin } = useProject();
  const [params, setParams] = useSearchParams();
  const listKey = `/api/projects/${project.id}/statements${qs({ env })}`;
  const list = useQuery<Page<Statement>>(listKey);
  const statements = items(list.data);
  const id = params.get("statement") ?? statements[0]?.id ?? null;
  const [pending, setPending] = useState<Pending | null>(null);
  const [uploading, setUploading] = useState(false);
  const [gateway, setGateway] = useState("esewa");

  const pick = (sid: string | null) => {
    const next = new URLSearchParams(params);
    if (sid) next.set("statement", sid);
    else next.delete("statement");
    next.delete("tab");
    setParams(next, { replace: true });
  };

  const send = async (file: File, gw: string, mapping?: StatementMapping) => {
    if (file.size > 5 * 1024 * 1024) return toast("That file is over 5 MB", { kind: "error", sub: "Split the statement by week or month and upload each part." });
    const form = new FormData();
    form.set("file", file);
    form.set("gateway", gw);
    if (mapping) form.set("mapping", JSON.stringify(mapping));
    setUploading(true);
    try {
      const s = await upload<StatementSummary>(`/api/projects/${project.id}/statements${qs({ env })}`, form);
      setData(`/api/projects/${project.id}/statements/${s.id}${qs({ env })}`, () => s);
      invalidate(listKey);
      setPending(null);
      pick(s.id);
      toast("Statement matched", { sub: `${formatCount(s.matched.count)} of ${formatCount(s.row_count)} rows matched a payment` });
    } catch (e) {
      if (e instanceof ApiFailure && e.status === 422 && (e.body as StatementNeedsMapping | undefined)?.headers) {
        const need = e.body as StatementNeedsMapping;
        const rows = parseCsv(await file.text(), (need.header_row ?? 0) + 8);
        setPending({ file, gateway: gw, need, rows });
      } else toast("Upload failed", { kind: "error", sub: errorMessage(e) });
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="stack-lg">
      <div className="page-head" style={{ marginBlockEnd: 0 }}>
        <div>
          <h1>Reconcile</h1>
          <p>Upload a gateway's settlement statement. paynp matches every row to a payment and shows what is missing.</p>
        </div>
        {statements.length > 0 && !pending && (
          <div className="stmt-pick">
            <Select aria-label="Statement" value={id ?? ""} onChange={pick} options={statements.map((s) => ({ value: s.id, label: `${gatewayName(s.gateway)}: ${period(s)}` }))} />
          </div>
        )}
      </div>

      {pending ? (
        <Mapping pending={pending} busy={uploading} onCancel={() => setPending(null)} onSubmit={(m) => void send(pending.file, pending.gateway, m)} />
      ) : (
        canAdmin && <Upload gateway={gateway} setGateway={setGateway} busy={uploading} onFile={(f) => void send(f, gateway)} compact={statements.length > 0} />
      )}

      {!pending && (list.data && !statements.length ? null : id ? <Results id={id} onDeleted={() => pick(null)} /> : !list.data ? <Skeleton h={200} /> : null)}

      {!pending && <Fees />}
    </div>
  );
}

function period(s: Statement): string {
  if (s.period_from && s.period_to) return `${formatDate(s.period_from)} to ${formatDate(s.period_to)}`;
  return s.filename;
}

// ------------------------------------------------------------------ upload
function Upload({ gateway, setGateway, busy, onFile, compact }: { gateway: string; setGateway: (g: string) => void; busy: boolean; onFile: (f: File) => void; compact: boolean }) {
  const [over, setOver] = useState(false);
  return (
    <section className="card">
      <div className="card-head">
        <h2>{compact ? "Upload another statement" : "Upload a statement"}</h2>
        <label className="row">
          <span className="hint">Gateway</span>
          <Select style={{ width: "auto" }} aria-label="Gateway" value={gateway} onChange={setGateway} options={GATEWAYS.map((g) => ({ value: g, label: gatewayName(g) }))} />
        </label>
      </div>
      <div className="card-body stack" style={{ gap: 12 }}>
        <label
          className="dropzone"
          data-over={over || undefined}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setOver(false);
            const f = e.dataTransfer.files[0];
            if (f) onFile(f);
          }}
          style={compact ? { paddingBlock: 18 } : undefined}
        >
          <input
            type="file"
            accept=".csv,text/csv"
            disabled={busy}
            aria-label={`${gatewayName(gateway)} statement CSV`}
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) onFile(f);
            }}
          />
          {busy ? <span className="spinner" /> : <Icon name="upload" size={20} />}
          <span>
            <strong>{busy ? "Matching rows" : `Drop the ${gatewayName(gateway)} statement here`}</strong>
            {!busy && " or choose a file"}
          </span>
          <span className="hint">CSV up to 5 MB. From Excel, use Save As, CSV.</span>
        </label>
        {!compact && (
          <div className="note">
            <Icon name="info" />
            <span>
              eSewa, Khalti and Fonepay presets read common column names. They are <span className="unverified">unverified</span> against real merchant exports, so the first upload may ask which column is which. paynp remembers the answer per gateway.
            </span>
          </div>
        )}
      </div>
    </section>
  );
}

// ------------------------------------------------------------------ column mapping
function Mapping({ pending, busy, onCancel, onSubmit }: { pending: Pending; busy: boolean; onCancel: () => void; onSubmit: (m: StatementMapping) => void }) {
  const { need, rows } = pending;
  const headerRow = need.header_row ?? 0;
  const headers = need.headers.length ? need.headers : (rows[headerRow] ?? []);
  const [map, setMap] = useState<Partial<StatementMapping>>(() => ({ unit: "rupees", ...(need.mapping ?? {}) }));
  const [err, setErr] = useState("");
  const body = (need.sample?.length ? need.sample : rows.slice(headerRow + 1)).slice(0, 5);
  const col = (f: Field) => (map[f] ? headers.indexOf(map[f] as string) : -1);
  const missing = FIELDS.filter((f) => f.required && !map[f.key]);
  const unit = map.unit ?? "rupees";

  const preview = body.map((r) => {
    const cell = (f: Field) => (col(f) >= 0 ? (r[col(f)] ?? "") : null);
    const amount = cell("amount");
    return {
      date: cell("date"),
      ref: cell("ref"),
      amountRaw: amount,
      amount: amount === null ? null : parseStatementAmount(amount, unit),
      fee: cell("fee") === null ? undefined : parseStatementAmount(cell("fee"), unit),
      net: cell("net") === null ? undefined : parseStatementAmount(cell("net"), unit),
    };
  });
  const badAmounts = preview.filter((p) => p.amountRaw !== null && p.amount === null).length;

  return (
    <section className="card" aria-labelledby="map-title">
      <div className="card-head">
        <div>
          <h2 id="map-title">Which column is which?</h2>
          <span className="hint">
            {pending.file.name}, {gatewayName(pending.gateway)}. paynp did not recognise these columns. Pick them once; the next {gatewayName(pending.gateway)} statement uses the same choice.
          </span>
        </div>
      </div>
      <div className="card-body stack">
        <div className="map-grid">
          {FIELDS.map((f) => (
            <label key={f.key} className="field">
              <span className="label">
                {f.label}
                {!f.required && <span className="subtle" style={{ fontWeight: 400 }}> (optional)</span>}
              </span>
              <Select
                aria-label={f.label}
                value={(map[f.key] as string) ?? ""}
                onChange={(v) => setMap({ ...map, [f.key]: v || undefined })}
                invalid={Boolean(f.required && err && !map[f.key])}
                options={[
                  { value: "", label: f.required ? "Choose a column" : "Not in this file" },
                  ...headers.map((h, i) => {
                    // A sample value next to each column name makes the choice obvious without a second table.
                    const ex = body.find((r) => (r[i] ?? "").trim())?.[i]?.trim();
                    return { value: h, label: h || `Column ${i + 1}`, hint: ex ? (ex.length > 24 ? `${ex.slice(0, 24)}...` : ex) : undefined };
                  }),
                ]}
              />
              <span className="hint">{f.hint}</span>
            </label>
          ))}
          <div className="field">
            <span className="label">Amounts are in</span>
            <Seg label="Amount unit" value={unit} onChange={(v) => setMap({ ...map, unit: v })} options={[{ value: "rupees", label: "Rupees" }, { value: "paisa", label: "Paisa" }]} />
            <span className="hint">{unit === "rupees" ? "1,500.00 means Rs 1,500" : "150000 means Rs 1,500"}</span>
          </div>
          <label className="field">
            <span className="label">Dates like 03/04/2026 are</span>
            <Select
              aria-label="Date order"
              value={map.date_order ?? "auto"}
              onChange={(v) => setMap({ ...map, date_order: v })}
              options={[
                { value: "auto", label: "Work it out from the file" },
                { value: "dmy", label: "Day first (3 April)" },
                { value: "mdy", label: "Month first (4 March)" },
              ] as SelectOption<NonNullable<StatementMapping["date_order"]>>[]}
            />
          </label>
        </div>

        <div>
          <div className="section-title" style={{ marginBlockEnd: 8 }}>
            <span>Preview</span>
            <span className="hint">{badAmounts ? `${badAmounts} of ${preview.length} amounts are not numbers: check the Amount column` : `First ${preview.length} rows as paynp will read them`}</span>
          </div>
          <div className="table-wrap preview">
            <table className="t t-stack">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Reference</th>
                  <th className="r">Amount</th>
                  <th className="r">Fee</th>
                  <th className="r">Net</th>
                </tr>
              </thead>
              <tbody>
                {preview.map((p, i) => (
                  <tr key={i}>
                    <td className="t-lead">{p.date ?? <span className="subtle">-</span>}</td>
                    <td className="mono" data-label="Reference">
                      {p.ref ?? <span className="subtle">-</span>}
                    </td>
                    <td className={`r${p.amountRaw !== null && p.amount === null ? " bad" : ""}`} data-label="Amount">
                      {p.amountRaw === null ? <span className="subtle">-</span> : p.amount === null ? `Not a number: ${p.amountRaw}` : <Money paisa={p.amount} />}
                    </td>
                    <td className="r" data-label="Fee">
                      {p.fee === undefined || p.fee === null ? <span className="subtle">-</span> : <Money paisa={p.fee} />}
                    </td>
                    <td className="r" data-label="Net">
                      {p.net === undefined || p.net === null ? <span className="subtle">-</span> : <Money paisa={p.net} />}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        {err && <p className="err">{err}</p>}
        <div className="actions" style={{ justifyContent: "flex-end" }}>
          <button className="btn btn-secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            disabled={busy}
            onClick={() => {
              if (missing.length) return setErr(`Choose a column for ${missing.map((f) => f.label.toLowerCase()).join(", ")}`);
              setErr("");
              onSubmit(map as StatementMapping);
            }}
          >
            {busy && <span className="spinner" />}
            Use these columns
          </button>
        </div>
      </div>
    </section>
  );
}

// ------------------------------------------------------------------ results
const TABS: { key: Tab; label: string; problem: boolean; help: string }[] = [
  { key: "matched", label: "Matched", problem: false, help: "Each row tied to a paynp payment, by reference or by amount within 10 minutes." },
  { key: "missing", label: "Missing settlement", problem: true, help: "paynp saw these paid in the statement period, but the statement has no row for them. Ask the gateway, or check the next statement." },
  { key: "unmatched", label: "Not in paynp", problem: true, help: "In the statement but not in paynp: payments from before the SDK was added, from another app, or with a reference paynp never saw." },
  { key: "mismatch", label: "Mismatch", problem: true, help: "Matched, but the statement amount differs from what paynp recorded." },
];

function Results({ id, onDeleted }: { id: string; onDeleted: () => void }) {
  const { project, env, canAdmin } = useProject();
  const [params, setParams] = useSearchParams();
  const key = `/api/projects/${project.id}/statements/${id}${qs({ env })}`;
  const s = useQuery<StatementSummary>(key);
  const d = s.data;
  const count = (t: Tab) => (!d ? 0 : t === "matched" ? d.matched.count : t === "missing" ? d.missing_settlement.count : t === "unmatched" ? d.not_in_paynp.count : d.mismatch.count);
  const fromUrl = params.get("tab") as Tab | null;
  const tab: Tab = fromUrl && TABS.some((t) => t.key === fromUrl) ? fromUrl : (TABS.find((t) => t.problem && count(t.key) > 0)?.key ?? "matched");

  const chart = useMemo(() => {
    const days = d?.per_day ?? [];
    const series: ChartSeries[] = [
      { label: "Net", values: days.map((x) => x.net_paisa), color: "--series-1", kind: "bar", stack: true, format: (v) => formatMoney(v) },
      { label: "Fees", values: days.map((x) => x.fees_paisa), color: "--gw-fonepay", kind: "bar", stack: true, format: (v) => formatMoney(v) },
    ];
    return { t: days.map((x) => x.day), series };
  }, [d]);

  if (s.error && !d)
    return (
      <div className="card">
        <EmptySmall icon="alert" title="Could not load this statement">
          {errorMessage(s.error)}
        </EmptySmall>
      </div>
    );
  if (!d) return <Skeleton h={240} />;

  const remove = async () => {
    if (!(await confirmAction({ title: `Delete ${d.filename}?`, body: "Its rows and matches go. Payments are not touched. Upload it again any time.", action: "Delete statement", danger: true }))) return;
    try {
      await api(key, { method: "DELETE" });
      invalidate(`/api/projects/${project.id}/statements`);
      toast("Statement deleted");
      onDeleted();
    } catch (e) {
      toast("Could not delete", { kind: "error", sub: errorMessage(e) });
    }
  };

  return (
    <div className="stack-lg">
      <div className="row between wrap">
        <div className="row wrap" style={{ gap: 10 }}>
          <Gateway id={d.gateway} />
          <span className="muted">
            {d.filename}, {formatCount(d.row_count)} rows, uploaded {formatDateTime(d.uploaded_at)}
            {d.uploaded_by ? ` by ${d.uploaded_by}` : ""}
          </span>
        </div>
        {canAdmin && (
          <button className="btn btn-ghost btn-sm" onClick={() => void remove()}>
            <Icon name="trash" size={14} />
            Delete
          </button>
        )}
      </div>

      {d.unverified_preset && (
        <div className="banner">
          <Icon name="info" />
          <div className="grow">
            <span>
              Columns were picked by the {gatewayName(d.gateway)} preset, which is <strong style={{ fontWeight: 500 }}>unverified</strong>. Check a few matched rows look right.
            </span>
          </div>
        </div>
      )}

      <section className="cells kpis" aria-label="Totals">
        <Tile label="Gross" value={<Money paisa={d.gross_paisa} />} foot={`${formatCount(d.payments.count)} payments${d.refunds.count ? `, ${formatCount(d.refunds.count)} refunds` : ""}`} />
        <Tile label="Fees" value={<Money paisa={d.fees_paisa} />} foot={`Effective rate ${formatFeePct(d.effective_fee_rate)}`} />
        <Tile label="Net to your bank" value={<Money paisa={d.net_paisa} />} foot={d.period_from && d.period_to ? `${formatDate(d.period_from)} to ${formatDate(d.period_to)}` : ""} />
        <Tile
          label="Matched"
          value={
            <span className="num">
              {formatCount(d.matched.count)}
              <span className="unit"> / {formatCount(d.row_count)}</span>
            </span>
          }
          foot={`${formatCount(d.matched.by_ref)} by reference, ${formatCount(d.matched.by_amount_time)} by amount and time`}
        />
      </section>

      {chart.t.length > 1 && (
        <section className="card">
          <div className="card-head">
            <h2>Settled per day</h2>
            <div className="legend">
              <span>
                <i style={{ background: "var(--series-1)" }} />
                Net
              </span>
              <span>
                <i style={{ background: "var(--gw-fonepay)" }} />
                Fees
              </span>
            </div>
          </div>
          <div className="card-body">
            <Chart t={chart.t} series={chart.series} bucket="day" height={200} yFormat={(v) => formatMoneyCompact(v)} ariaLabel="Net and fees per day" />
          </div>
        </section>
      )}

      <section>
        <div className="result-tabs" role="tablist" aria-label="Rows">
          {TABS.map((t) => (
            <button
              key={t.key}
              role="tab"
              aria-selected={tab === t.key}
              onClick={() => {
                const next = new URLSearchParams(params);
                next.set("tab", t.key);
                setParams(next, { replace: true });
              }}
            >
              {t.label}
              <span className="tab-count" data-tone={t.problem && count(t.key) ? "bad" : undefined}>
                {formatCount(count(t.key))}
              </span>
            </button>
          ))}
        </div>
        <p className="hint" style={{ marginBlockEnd: 12 }}>
          {TABS.find((t) => t.key === tab)!.help}
          {tab === "mismatch" && d.mismatch.count > 0 && ` Statement total differs by ${formatMoney(d.mismatch.diff_paisa)}.`}
          {tab === "missing" && d.missing_settlement.count > 0 && ` ${formatMoney(d.missing_settlement.amount_paisa)} in total.`}
        </p>
        <Rows id={id} tab={tab} />
      </section>
    </div>
  );
}

function Tile({ label, value, foot }: { label: string; value: ReactNode; foot: string }) {
  return (
    <div className="tile">
      <span className="tile-label">{label}</span>
      <span className="tile-value">{value}</span>
      <span className="tile-foot">{foot}</span>
    </div>
  );
}

function Rows({ id, tab }: { id: string; tab: Tab }) {
  const { project, env, base } = useProject();
  const r = useQuery<Page<StatementRow | MissingSettlement>>(`/api/projects/${project.id}/statements/${id}/rows${qs({ env, filter: tab, limit: 200 })}`);
  const rows = items(r.data);
  const [limit, setLimit] = useState(50);
  useEffect(() => setLimit(50), [tab, id]);
  if (!r.data) return r.error ? <p className="err">{errorMessage(r.error)}</p> : <Skeleton h={120} />;
  if (!rows.length)
    return (
      <div className="card">
        <EmptySmall icon="checkCircle" title={tab === "matched" ? "No rows matched" : "Nothing here"}>
          {tab === "matched" ? "Check the column choices, or that this statement is for this environment." : "Every row lines up."}
        </EmptySmall>
      </div>
    );
  const pay = (attempt: string | null, label: ReactNode) => (attempt ? <Link className="cell-link" to={`${base}/payments/${encodeURIComponent(attempt)}`}>{label}</Link> : label);
  const shown = rows.slice(0, limit);

  return (
    <>
      <div className="table-wrap">
        <table className="t t-stack">
          <thead>
            {tab === "missing" ? (
              <tr>
                <th>Paid at</th>
                <th>Order</th>
                <th>Reference</th>
                <th className="r">Amount</th>
              </tr>
            ) : tab === "mismatch" ? (
              <tr>
                <th>Date</th>
                <th>Order</th>
                <th>Reference</th>
                <th className="r">Statement</th>
                <th className="r">paynp</th>
                <th className="r">Difference</th>
              </tr>
            ) : (
              <tr>
                <th>Date</th>
                {tab === "matched" && <th>Order</th>}
                <th>Reference</th>
                <th className="r">Amount</th>
                <th className="r">Fee</th>
                <th className="r">Net</th>
                {tab === "matched" && <th>Matched by</th>}
              </tr>
            )}
          </thead>
          <tbody>
            {tab === "missing"
              ? (shown as MissingSettlement[]).map((m) => (
                  <tr key={m.attempt_id}>
                    <td className="t-lead">{m.finished_at ? formatDateTime(m.finished_at) : "-"}</td>
                    <td data-label="Order">{pay(m.attempt_id, m.order_id ?? "Open payment")}</td>
                    <td className="mono" data-label="Reference">
                      {m.provider_ref ?? "-"}
                    </td>
                    <td className="r" data-label="Amount">
                      <Money paisa={m.amount_paisa} />
                    </td>
                  </tr>
                ))
              : (shown as StatementRow[]).map((x, i) =>
                  tab === "mismatch" ? (
                    <tr key={x.row ?? i}>
                      <td className="t-lead">{x.txn_at ? formatDateTime(x.txn_at) : "-"}</td>
                      <td data-label="Order">{pay(x.match_attempt_id, x.order_id ?? "Open payment")}</td>
                      <td className="mono" data-label="Reference">
                        {x.ref ?? "-"}
                      </td>
                      <td className="r" data-label="Statement">
                        <Money paisa={x.amount_paisa} />
                      </td>
                      <td className="r" data-label="paynp">
                        <Money paisa={x.paynp_amount_paisa} />
                      </td>
                      <td className="r" data-label="Difference" style={{ color: "var(--crit-ink)" }}>
                        <Money paisa={(x.amount_paisa ?? 0) - (x.paynp_amount_paisa ?? 0)} className="amount" />
                      </td>
                    </tr>
                  ) : (
                    <tr key={x.row ?? i}>
                      <td className="t-lead">{x.txn_at ? formatDateTime(x.txn_at) : "-"}</td>
                      {tab === "matched" && <td data-label="Order">{pay(x.match_attempt_id, x.order_id ?? "Open payment")}</td>}
                      <td className="mono" data-label="Reference">
                        {x.ref ?? "-"}
                      </td>
                      <td className="r" data-label="Amount">
                        <Money paisa={x.amount_paisa} />
                      </td>
                      <td className="r" data-label="Fee">
                        <Money paisa={x.fee_paisa} />
                      </td>
                      <td className="r" data-label="Net">
                        <Money paisa={x.net_paisa} />
                      </td>
                      {tab === "matched" && (
                        <td data-label="Matched by" className="muted">
                          {x.match_kind === "ref" ? "Reference" : "Amount and time"}
                        </td>
                      )}
                    </tr>
                  ),
                )}
          </tbody>
        </table>
      </div>
      {rows.length > limit && (
        <button className="btn btn-ghost btn-sm" style={{ marginBlockStart: 8 }} onClick={() => setLimit(limit + 100)}>
          Show more ({formatCount(rows.length - limit)} left)
        </button>
      )}
    </>
  );
}

// ------------------------------------------------------------------ fees
function Fees() {
  const { project, canAdmin } = useProject();
  const key = `/api/projects/${project.id}/fees`;
  const q = useQuery<Page<GatewayFee>>(key);
  const fees = items(q.data);
  const shown = ["esewa", "khalti", "fonepay", ...fees.map((f) => f.gateway)].filter((g, i, a) => a.indexOf(g) === i);
  return (
    <section className="card">
      <div className="card-head">
        <div>
          <h2>Fee rates</h2>
          <span className="hint">The rate in your gateway contract. Used to estimate fees in exports for payments no statement covers yet.</span>
        </div>
      </div>
      <div className="fees">
        {shown.map((g) => (
          <FeeRow key={`${g}-${q.data ? "1" : "0"}`} gateway={g} fee={fees.find((f) => f.gateway === g)} disabled={!canAdmin} onSaved={() => invalidate(key)} />
        ))}
      </div>
    </section>
  );
}

function FeeRow({ gateway, fee, disabled, onSaved }: { gateway: string; fee?: GatewayFee; disabled: boolean; onSaved: () => void }) {
  const { project } = useProject();
  const [pct, setPct] = useState(fee ? String(fee.pct_bp / 100) : "");
  const [fixed, setFixed] = useState(fee?.fixed_paisa ? String(fee.fixed_paisa / 100) : "");
  const [busy, setBusy] = useState(false);
  const dirty = pct !== (fee ? String(fee.pct_bp / 100) : "") || fixed !== (fee?.fixed_paisa ? String(fee.fixed_paisa / 100) : "");
  const save = async () => {
    const p = Number(pct || 0);
    const f = Number(fixed || 0);
    if (!Number.isFinite(p) || p < 0 || p > 20 || !Number.isFinite(f) || f < 0) return toast("Check the numbers", { kind: "error", sub: "A percent between 0 and 20, and a fixed fee in rupees." });
    setBusy(true);
    try {
      await api(`/api/projects/${project.id}/fees`, { method: "PUT", body: { gateway, pct_bp: Math.round(p * 100), fixed_paisa: Math.round(f * 100) } });
      toast(`${gatewayName(gateway)} fee saved`, { sub: `${p}%${f ? ` + Rs ${f}` : ""} per payment` });
      onSaved();
    } catch (e) {
      toast("Could not save", { kind: "error", sub: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="fee-row"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <Gateway id={gateway} />
      <div className="row" style={{ gap: 8 }}>
        <label className="prefix-input">
          <input className="input num" inputMode="decimal" value={pct} placeholder="0" onChange={(e) => setPct(e.target.value)} disabled={disabled} aria-label={`${gatewayName(gateway)} percent fee`} />
          <span>%</span>
        </label>
        <span className="subtle hide-sm">+</span>
        <label className="prefix-input hide-sm">
          <span style={{ paddingInline: "10px 0" }}>Rs</span>
          <input className="input num" inputMode="decimal" value={fixed} placeholder="0" onChange={(e) => setFixed(e.target.value)} disabled={disabled} aria-label={`${gatewayName(gateway)} fixed fee in rupees`} />
        </label>
      </div>
      <button className="btn btn-secondary btn-sm" disabled={disabled || busy || !dirty} style={{ visibility: dirty ? "visible" : "hidden" }}>
        {busy && <span className="spinner" />}
        Save
      </button>
    </form>
  );
}

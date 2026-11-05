import { FISCAL_YEARS, fiscalYearOf, type YearRow, type YearSummary } from "@paynp/shared";
import { useState } from "react";
import { Icon, type IconName } from "../components/Icon.tsx";
import { useProject } from "../components/Shell.tsx";
import { EmptySmall, Gateway, Money, Skeleton, toast, Select } from "../components/ui.tsx";
import { download, errorMessage, qs } from "../lib/api.ts";
import { adMonthLabel, formatCount, formatDate, formatMoney, nptDateToMs, recentMonths } from "../lib/format.ts";
import { bsLabelForAdMonth } from "../lib/nepali.ts";
import { useQuery } from "../lib/query.ts";
import "../styles/ops.css";

interface FileSpec {
  file: string;
  title: string;
  icon: IconName;
  desc: string;
  unverified?: string;
}

const FILES: FileSpec[] = [
  { file: "transactions.csv", title: "All transactions", icon: "list", desc: "Every payment that month: Nepal date, attempt, order, gateway, reference, status, amount, refunded, fee and net. Fees come from a matched statement, else your fee settings, else blank." },
  {
    file: "tally.csv",
    title: "Tally-style vouchers",
    icon: "file",
    desc: "Date, Voucher Type, Ledger, Debit, Credit, Narration. Receipts go to “<Gateway> Receipts”, refunds to “Sales Returns” as credit notes, fees to “Payment Gateway Charges”. Map the ledgers to yours on import.",
    unverified: "Not checked against a Tally import yet",
  },
  {
    file: "hamrokhata.csv",
    title: "Sales and receipts for Hamrokhata",
    icon: "file",
    desc: "A plain sales and receipts sheet: date, invoice (order id), payment mode, amount, reference. Adjust the columns in Hamrokhata's import screen.",
    unverified: "Not checked against a Hamrokhata import yet",
  },
  { file: "credit-notes.csv", title: "VAT credit notes", icon: "undo", desc: "One row per refund that month, numbered CN-YYYYMM-0001, with the original attempt and order, date, amount, reason and refund reference." },
];

export default function Exports() {
  const { project, env } = useProject();
  const [now] = useState(() => Date.now());
  const months = recentMonths(now, 13);
  const [month, setMonth] = useState(months[0]);
  const [fy, setFy] = useState(() => fiscalYearOf(now) ?? FISCAL_YEARS[FISCAL_YEARS.length - 1]);
  const [busy, setBusy] = useState<string | null>(null);
  const summary = useQuery<YearSummary>(`/api/projects/${project.id}/exports/year-summary${qs({ env, fy })}`);
  const base = `/api/projects/${project.id}/exports`;

  const get = async (path: string, name: string) => {
    setBusy(name);
    try {
      await download(path, name);
    } catch (e) {
      toast("Download failed", { kind: "error", sub: errorMessage(e) });
    } finally {
      setBusy(null);
    }
  };
  const monthQuery = (file: string) => {
    if (file !== "transactions.csv") return qs({ env, month });
    const [y, m] = month.split("-").map(Number);
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return qs({ env, month, from: nptDateToMs(`${month}-01`), to: nptDateToMs(`${month}-${String(last).padStart(2, "0")}`, true) });
  };
  const fys = [...FISCAL_YEARS].reverse().filter((x) => x <= (fiscalYearOf(now) ?? x));
  const s = summary.data;

  return (
    <div className="stack-lg">
      <div className="page-head" style={{ marginBlockEnd: 0 }}>
        <div>
          <h1>Exports</h1>
          <p>CSV files for your accountant. Amounts in rupees, dates in Nepal time{env === "test" ? ", test payments only" : ""}.</p>
        </div>
      </div>

      <section className="stack" style={{ gap: 12 }}>
        <div className="row between wrap">
          <h2>Monthly files</h2>
          <div className="month-pick">
            <Icon name="calendar" className="subtle" />
            <Select aria-label="Month" value={month} onChange={setMonth} options={months.map((m) => ({ value: m, label: adMonthLabel(m), hint: bsLabelForAdMonth(m) || undefined }))} />
          </div>
        </div>
        <p className="hint">
          {adMonthLabel(month)}
          {bsLabelForAdMonth(month) && <span className="bs"> is {bsLabelForAdMonth(month)} in the Nepali calendar.</span>}
        </p>
        <div className="exports">
          {FILES.map((f) => (
            <div key={f.file} className="export-row">
              <Icon name={f.icon} />
              <span className="x-title">
                {f.title}
                {f.unverified && (
                  <span className="unverified" title={f.unverified}>
                    Unverified layout
                  </span>
                )}
              </span>
              <span className="x-desc">{f.desc}</span>
              <div className="x-action">
                <button className="btn btn-secondary btn-sm" disabled={busy === f.file} onClick={() => void get(`${base}/${f.file}${monthQuery(f.file)}`, `paynp-${f.file.replace(".csv", "")}-${month}.csv`)}>
                  {busy === f.file ? <span className="spinner" /> : <Icon name="download" size={14} />}
                  Download CSV
                </button>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="stack" style={{ gap: 12 }}>
        <div className="row between wrap">
          <div>
            <h2>Fiscal year summary</h2>
            <p className="hint">Shrawan 1 to the end of Asar.{s ? ` ${formatDate(s.from)} to ${formatDate(s.to - 1)}.` : ""}</p>
          </div>
          <div className="row wrap">
            <Select style={{ width: "auto" }} aria-label="Fiscal year" value={fy} onChange={setFy} options={fys.map((x) => ({ value: x, label: `FY ${x.replace("-", "/")}` }))} />
            <button className="btn btn-secondary" disabled={busy === "year"} onClick={() => void get(`${base}/year-summary.csv${qs({ env, fy })}`, `paynp-year-summary-${fy}.csv`)}>
              {busy === "year" ? <span className="spinner" /> : <Icon name="download" size={14} />}
              CSV
            </button>
          </div>
        </div>
        {summary.error && !s ? (
          <div className="card">
            <EmptySmall icon="alert" title="Could not load the summary">
              {errorMessage(summary.error)}
            </EmptySmall>
          </div>
        ) : (
          <YearTable rows={s?.gateways} totals={s?.totals} loading={!s} label="Gateway" />
        )}
        {s && s.totals.fees_estimated_paisa > 0 && (
          <div className="note">
            <Icon name="info" />
            <span>
              * {formatMoney(s.totals.fees_estimated_paisa)} of the fees are estimates from your fee settings in Reconcile, for payments no uploaded statement covers yet.
            </span>
          </div>
        )}
        {s && s.months.some((m) => m.count > 0) && (
          <details className="card month-details">
            <summary className="card-head" style={{ cursor: "pointer", borderBlockEnd: 0 }}>
              <h2>By Nepali month</h2>
              <span className="row hint">
                {s.months.filter((m) => m.count > 0).length} months with payments
                <Icon name="chevronDown" className="chev" />
              </span>
            </summary>
            <div style={{ padding: "0 16px 16px" }}>
              <YearTable
                rows={s.months.filter((m) => m.count > 0).map((m) => ({ ...m, gateway: m.label }))}
                label="Month"
                plain
              />
            </div>
          </details>
        )}
      </section>
    </div>
  );
}

function YearTable({ rows, totals, loading, label, plain }: { rows?: YearRow[]; totals?: Omit<YearRow, "gateway">; loading?: boolean; label: string; plain?: boolean }) {
  return (
    <div className="table-wrap">
      <table className="t t-stack">
        <thead>
          <tr>
            <th>{label}</th>
            <th className="r">Payments</th>
            <th className="r">Gross</th>
            <th className="r">Refunds</th>
            <th className="r">Fees</th>
            <th className="r">Net</th>
          </tr>
        </thead>
        <tbody>
          {loading ? (
            <tr>
              <td colSpan={6}>
                <Skeleton />
              </td>
            </tr>
          ) : !rows?.length ? (
            <tr>
              <td colSpan={6} data-label="">
                <span className="muted">No paid payments in this fiscal year.</span>
              </td>
            </tr>
          ) : (
            rows.map((g) => (
              <tr key={g.gateway}>
                <td className="t-lead">{plain ? g.gateway : <Gateway id={g.gateway} />}</td>
                <td className="r num" data-label="Payments">
                  {formatCount(g.count)}
                </td>
                <td className="r" data-label="Gross">
                  <Money paisa={g.gross_paisa} />
                </td>
                <td className="r" data-label="Refunds">
                  {g.refunds_paisa ? <Money paisa={g.refunds_paisa} /> : <span className="subtle">-</span>}
                </td>
                <td className="r" data-label="Fees" title={g.fees_estimated_paisa ? `${formatMoney(g.fees_estimated_paisa)} estimated` : undefined}>
                  <span>
                    <Money paisa={g.fees_paisa} />
                    {g.fees_estimated_paisa > 0 && (
                      <span className="subtle" aria-label="includes estimates">
                        {" "}*
                      </span>
                    )}
                  </span>
                </td>
                <td className="r" data-label="Net">
                  <Money paisa={g.net_paisa} />
                </td>
              </tr>
            ))
          )}
        </tbody>
        {totals && rows && rows.length > 1 && (
          <tfoot>
            <tr>
              <td className="t-lead">Total</td>
              <td className="r num" data-label="Payments">
                {formatCount(totals.count)}
              </td>
              <td className="r" data-label="Gross">
                <Money paisa={totals.gross_paisa} />
              </td>
              <td className="r" data-label="Refunds">
                <Money paisa={totals.refunds_paisa} />
              </td>
              <td className="r" data-label="Fees">
                <Money paisa={totals.fees_paisa} />
              </td>
              <td className="r" data-label="Net">
                <Money paisa={totals.net_paisa} />
              </td>
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

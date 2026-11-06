import { DOCTOR_CHECKS, type DoctorFinding, type DoctorReport } from "@paynp/shared";
import { useState } from "react";
import { Link } from "react-router";
import { Icon } from "../components/Icon.tsx";
import { useProject } from "../components/Shell.tsx";
import { Command, EmptySmall, Gateway, Skeleton, Time, toast, useNow } from "../components/ui.tsx";
import { api, errorMessage, qs } from "../lib/api.ts";
import { formatCount, formatFull, formatRelative, shortId } from "../lib/format.ts";
import { optimistic, useQuery } from "../lib/query.ts";
import "../styles/ops.css";

export default function GoLive() {
  const { project, env, base, canAdmin } = useProject();
  const key = `/api/projects/${project.id}/doctor${qs({ env })}`;
  const d = useQuery<DoctorReport>(key, { refreshMs: 60_000 });
  const now = useNow(30_000);
  const r = d.data;
  const critical = r?.findings.filter((f) => f.severity === "critical") ?? [];
  const warnings = r?.findings.filter((f) => f.severity === "warning") ?? [];
  const passed = r?.passed.filter((c) => c.status === "passed") ?? [];
  const state = !r ? undefined : critical.length ? "critical" : warnings.length ? "warning" : "ok";

  const resolve = async (f: DoctorFinding) => {
    try {
      await optimistic<DoctorReport>(
        key,
        (x) => x && { ...x, findings: x.findings.filter((y) => !(y.code === f.code && y.gateway === f.gateway)) },
        () => api(`/api/projects/${project.id}/doctor/${f.code}/resolve${qs({ env })}`, { method: "POST", body: { env, gateway: f.gateway } }),
      );
      toast("Marked as fixed", { sub: "It comes back if the problem shows up again in new traffic." });
    } catch (e) {
      toast("Could not resolve", { kind: "error", sub: errorMessage(e) });
    }
  };

  return (
    <div className="stack-lg">
      <div className="page-head" style={{ marginBlockEnd: 0 }}>
        <div>
          <h1>Go-live check</h1>
          <p>What discerns sees in {env === "live" ? "live" : "test"} traffic that would cost money or orders in production.</p>
        </div>
      </div>

      {d.error && !r ? (
        <div className="card">
          <EmptySmall icon="alert" title="Could not run the checks">
            {errorMessage(d.error)}
          </EmptySmall>
        </div>
      ) : (
        <section className="doctor-summary" data-state={state} aria-busy={!r || undefined}>
          <div>
            {r ? (
              <h2>{critical.length ? `${critical.length} ${critical.length === 1 ? "problem" : "problems"} to fix before going live` : warnings.length ? "Ready, with something to look at" : "Ready to take real payments"}</h2>
            ) : (
              <Skeleton w={260} h={22} />
            )}
            <div className="counts">
              <span>
                <b>{r ? critical.length : "-"}</b> critical
              </span>
              <span>
                <b>{r ? warnings.length : "-"}</b> {warnings.length === 1 ? "warning" : "warnings"}
              </span>
              <span>
                <b>{r ? passed.length : "-"}</b> passed
              </span>
            </div>
          </div>
          <div className="field">
            <span className="hint">Check the code and config too, before deploying:</span>
            <Command cmd="npx paynp doctor" />
          </div>
        </section>
      )}

      {r && r.findings.length > 0 && (
        <section>
          <div className="section-title">To fix</div>
          <div className="findings">
            {[...critical, ...warnings].map((f, i) => (
              <Finding key={`${f.code}-${f.gateway}`} f={f} open={i === 0} base={base} now={now} canAdmin={canAdmin} onResolve={() => void resolve(f)} />
            ))}
          </div>
        </section>
      )}

      {r && r.passed.length > 0 && (
        <section>
          <div className="section-title">
            <span>Passed</span>
            <span className="hint">Checked continuously as events arrive</span>
          </div>
          <ul className="passed">
            {r.passed.map((c) => (
              <li key={c.code} data-status={c.status}>
                <Icon name={c.status === "passed" ? "checkCircle" : "minusCircle"} />
                <span className={c.status === "passed" ? "ink" : "muted"}>{c.line || DOCTOR_CHECKS[c.code]?.passed}</span>
                {c.status === "not_checked" && <span className="p-line">{DOCTOR_CHECKS[c.code]?.title}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function Finding({ f, open, base, now, canAdmin, onResolve }: { f: DoctorFinding; open: boolean; base: string; now: number; canAdmin: boolean; onResolve: () => void }) {
  const [busy, setBusy] = useState(false);
  const info = DOCTOR_CHECKS[f.code];
  return (
    <details className="finding" data-sev={f.severity} open={open}>
      <summary>
        <span className="sev">
          <Icon name={f.severity === "critical" ? "xCircle" : "alert"} />
        </span>
        <span className="f-title">{f.title || info?.title}</span>
        <Icon name="chevronDown" className="chev" />
        <span className="f-meta">
          <span>{f.severity === "critical" ? "Critical" : "Warning"}</span>
          {f.gateway && <Gateway id={f.gateway} />}
          <span>
            Seen {formatCount(f.count)} {f.count === 1 ? "time" : "times"}, last{" "}
            <Time t={f.last_seen}>{formatRelative(f.last_seen, now)}</Time>
          </span>
        </span>
      </summary>
      <div className="finding-body">
        <dl>
          <div>
            <dt>Why it matters</dt>
            <dd>{f.why || info?.why}</dd>
          </div>
          <div>
            <dt>How to fix</dt>
            <dd>{f.fix || info?.fix}</dd>
          </div>
          {f.example_attempt && (
            <div>
              <dt>Example payment</dt>
              <dd>
                <Link className="inline-link mono" to={`${base}/payments/${encodeURIComponent(f.example_attempt)}`} style={{ fontSize: 12.5 }}>
                  {shortId(f.example_attempt)}
                </Link>
              </dd>
            </div>
          )}
          <div>
            <dt>First seen</dt>
            <dd className="muted">{formatFull(f.first_seen)}</dd>
          </div>
        </dl>
        <div className="row wrap">
          {canAdmin && (
            <button
              className="btn btn-secondary btn-sm"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                onResolve();
              }}
            >
              <Icon name="check" size={14} />
              Mark as fixed
            </button>
          )}
          {(f.docs_url || info?.docs_url) && (
            <a className="btn btn-ghost btn-sm" href={f.docs_url || info.docs_url} target="_blank" rel="noreferrer">
              Gateway notes
              <Icon name="arrowUpRight" size={12} />
            </a>
          )}
        </div>
      </div>
    </details>
  );
}

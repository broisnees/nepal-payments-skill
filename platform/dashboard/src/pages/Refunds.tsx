import type { ChecklistStep, Page, PaymentSummary, RefundCase, RefundStatus } from "@paynp/shared";
import { useEffect, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router";
import { Icon } from "../components/Icon.tsx";
import { RefundPill, kindLabel } from "../components/Ops.tsx";
import { useProject } from "../components/Shell.tsx";
import { CodeBlock, CopyButton, EmptySmall, Gateway, Money, Skeleton, StatusPill, Time, confirmAction, toast, useNow } from "../components/ui.tsx";
import { ApiFailure, api, errorMessage, items, qs } from "../lib/api.ts";
import { formatDateTime, formatDuration, formatFull, formatMoney, formatRelative, gatewayName, moneyParts } from "../lib/format.ts";
import { setData, useQuery } from "../lib/query.ts";
import "../styles/ops.css";

const GROUPS: { title: string; statuses: RefundStatus[] }[] = [
  { title: "Needs action", statuses: ["open", "failed"] },
  { title: "Waiting on your server", statuses: ["requested"] },
  { title: "Done", statuses: ["refunded", "dismissed"] },
];
const DONE_SHOWN = 8;

const SNIPPET = `// app/api/paynp/actions/route.ts (any Fetch API handler works: Hono, Workers, Next.js)
import { paynp } from "@/lib/paynp";

export const POST = paynp.actionHandler({
  async refund(a) {
    // a.gateway, a.providerRef, a.refund?.amountPaisa (none = full refund)
    // Call the gateway's refund API here with your own keys.
    return { refundRef: "..." };
  },
});`;

/** Shared with the nav badge, so both read one cached list. */
export function refundsKey(project: string, env: string) {
  return `/api/projects/${project}/refunds${qs({ env, limit: 200 })}`;
}

export default function Refunds() {
  const { project, env, local } = useProject();
  const [params, setParams] = useSearchParams();
  const selectedId = params.get("case");
  const [showAllDone, setShowAllDone] = useState(false);
  const key = refundsKey(project.id, env);
  const list = useQuery<Page<RefundCase> & { open_count?: number }>(key, { staleMs: 5_000 });
  const cases = items(list.data);
  const waiting = cases.some((c) => c.status === "requested");
  // While a refund is with the merchant's server, poll until it answers.
  useEffect(() => {
    if (!waiting) return;
    const id = setInterval(() => void list.refresh(), 2_000);
    return () => clearInterval(id);
  }, [waiting, list.refresh]);

  const explicit = selectedId ? cases.find((c) => c.id === selectedId) : undefined;
  const firstOpen = cases.find((c) => c.status === "open" || c.status === "failed") ?? cases[0];
  const selected = explicit ?? firstOpen;
  const select = (id: string | null) => {
    const next = new URLSearchParams(params);
    if (id) next.set("case", id);
    else next.delete("case");
    setParams(next);
  };
  const update = (c: RefundCase) => setData<Page<RefundCase>>(key, (pg) => pg && { ...pg, items: pg.items.map((x) => (x.id === c.id ? c : x)) });
  const openCount = list.data?.open_count ?? cases.filter((c) => c.status === "open" || c.status === "requested" || c.status === "failed").length;

  return (
    <div className="stack-lg">
      <div className="page-head" style={{ marginBlockEnd: 0 }}>
        <div>
          <h1>Refunds</h1>
          <p>{openCount ? `${openCount} open ${openCount === 1 ? "case" : "cases"}.` : "Duplicate payments and refund requests."} discerns never holds gateway keys: refunds run on your server or in the gateway's portal.</p>
        </div>
      </div>

      {!list.data && !list.error ? (
        <div className="split">
          <div className="case-list">
            {[0, 1, 2].map((i) => (
              <div key={i} className="case-row">
                <Skeleton w="60%" />
                <Skeleton w={60} />
              </div>
            ))}
          </div>
        </div>
      ) : list.error && !list.data ? (
        <div className="card">
          <EmptySmall icon="alert" title="Could not load refunds">
            {errorMessage(list.error)}
          </EmptySmall>
        </div>
      ) : !cases.length ? (
        <div className="card">
          <EmptySmall icon="undo" title="Nothing to refund">
            When a buyer pays twice for the same order, the second payment lands here with the steps to refund it. To catch repeat payments without an order id too, add <code>customer: (i) =&gt; ({"{ phone: i.phone }"})</code> to <code>wrapGateway</code>. Any paid payment can also be marked for refund from its page.
          </EmptySmall>
        </div>
      ) : (
        <div className="split" data-has-detail={explicit ? "" : undefined}>
          <div className="split-list">
            {GROUPS.map((g) => {
              let rows = cases.filter((c) => g.statuses.includes(c.status));
              if (!rows.length) return null;
              const done = g.title === "Done";
              const total = rows.length;
              if (done && !showAllDone) rows = rows.slice(0, DONE_SHOWN);
              return (
                <section key={g.title}>
                  <div className="group-label">
                    <span>{g.title}</span>
                    <span className="num">{total}</span>
                  </div>
                  <div className="case-list">
                    {rows.map((c) => (
                      <CaseRow key={c.id} c={c} current={c.id === selected?.id} onSelect={() => select(c.id)} />
                    ))}
                  </div>
                  {done && total > DONE_SHOWN && !showAllDone && (
                    <button className="btn btn-ghost btn-sm" style={{ marginBlockStart: 6 }} onClick={() => setShowAllDone(true)}>
                      Show {total - DONE_SHOWN} more
                    </button>
                  )}
                </section>
              );
            })}
          </div>
          {selected && (
            <div className={explicit ? undefined : "auto-detail"}>
              <button className="back back-sm" style={{ border: 0, background: "none", padding: 0, marginBlockEnd: 16, cursor: "pointer" }} onClick={() => select(null)}>
                <Icon name="arrowLeft" size={14} />
                All cases
              </button>
              <CaseDetail key={selected.id} c={selected} onChange={update} local={local} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function CaseRow({ c, current, onSelect }: { c: RefundCase; current: boolean; onSelect: () => void }) {
  const now = useNow(30_000);
  return (
    <a
      href={`?case=${c.id}`}
      className="case-row"
      aria-current={current || undefined}
      onClick={(e) => {
        e.preventDefault();
        onSelect();
      }}
    >
      <span className="case-title truncate">
        {kindLabel(c)}
        {c.payment?.order_id && <span className="muted"> · {c.payment.order_id}</span>}
      </span>
      <Money paisa={c.amount_paisa} currency={c.payment?.currency} />
      <span className="meta">
        <Gateway id={c.gateway} />
        <RefundPill status={c.status} />
        <Time t={c.created_at}>{formatRelative(c.created_at, now)}</Time>
      </span>
    </a>
  );
}

function CaseDetail({ c, onChange, local }: { c: RefundCase; onChange: (c: RefundCase) => void; local: boolean }) {
  const { project, env, base, canAdmin } = useProject();
  const path = `/api/projects/${project.id}/refunds/${c.id}${qs({ env })}`;
  const [ref, setRef] = useState(c.refund_ref ?? "");
  // A failed case carries the server's error in its note; start a fresh note instead of editing the error.
  const [note, setNote] = useState(c.status === "failed" ? "" : (c.note ?? ""));
  const [busy, setBusy] = useState<string | null>(null);
  const live = c.status === "open" || c.status === "failed";
  const m = moneyParts(c.amount_paisa, c.payment?.currency);
  const partial = c.payment?.amount_paisa && c.amount_paisa < c.payment.amount_paisa;

  const patch = async (body: Record<string, unknown>, label: string, optimistic?: RefundCase) => {
    if (optimistic) onChange(optimistic);
    setBusy(label);
    try {
      const next = await api<RefundCase>(path, { method: "PATCH", body });
      onChange(next);
      return next;
    } catch (e) {
      if (optimistic) onChange(c);
      toast("Could not save", { kind: "error", sub: errorMessage(e) });
      return null;
    } finally {
      setBusy(null);
    }
  };

  // Steps only move forward: the API records who did each one and when.
  const tick = (s: ChecklistStep) => void patch({ checklist_step_done: s.id }, `step-${s.id}`, { ...c, checklist: c.checklist.map((x) => (x.id === s.id ? { ...x, done_at: Date.now(), by: "You" } : x)) });

  const send = async () => {
    const ok = await confirmAction({
      title: `Refund ${formatMoney(c.amount_paisa, c.payment?.currency)} on ${gatewayName(c.gateway)}?`,
      body: "discerns sends a signed request to your action endpoint. Your server calls the gateway with its own keys and reports back. This cannot be undone from here.",
      action: "Send refund",
    });
    if (!ok) return;
    setBusy("send");
    try {
      // The API waits for the merchant's server (up to 20 s) and answers with the updated case.
      const r = await api<{ case: RefundCase }>(`/api/projects/${project.id}/refunds/${c.id}/send${qs({ env })}`, { method: "POST" });
      onChange(r.case);
      toast(r.case.status === "refunded" ? "Refunded" : "Sent to your server", { sub: r.case.refund_ref ? `Refund ref ${r.case.refund_ref}` : undefined });
    } catch (e) {
      // 502: the server answered but the refund failed; the body still carries the case with the reason.
      const failed = e instanceof ApiFailure ? (e.body as { case?: RefundCase } | undefined)?.case : undefined;
      if (failed) onChange(failed);
      toast("Your server could not refund it", { kind: "error", sub: failed?.note ?? errorMessage(e) });
    } finally {
      setBusy(null);
    }
  };

  const resolve = async (status: "refunded" | "dismissed") => {
    if (status === "dismissed" && !note.trim()) {
      toast("Add a note first", { kind: "info", sub: "Say why it does not need a refund, for whoever looks next." });
      return;
    }
    const next = await patch({ status, refund_ref: ref.trim(), note: note.trim() }, status);
    if (next) toast(status === "refunded" ? "Marked refunded" : "Dismissed", { sub: status === "refunded" && ref.trim() ? `Refund ref ${ref.trim()}` : undefined });
  };

  const actionSteps = c.checklist.filter((s) => s.kind === "action");
  const manualSteps = c.checklist.filter((s) => s.kind !== "action");
  const showSend = !local && c.can_send && live && canAdmin;
  const showExplainer = !local && c.has_refund_api && !c.can_send && live;

  return (
    <article className="case" aria-labelledby="case-title">
      <header className="case-head">
        <div className="row wrap" style={{ gap: 8 }}>
          <span className="eyebrow" id="case-title">
            {kindLabel(c)}
          </span>
          <RefundPill status={c.status} />
        </div>
        <div className="row wrap" style={{ gap: 12, alignItems: "baseline" }}>
          <span className="case-amount">
            <span className="cur">Rs</span>
            {m.int}
            <span className="frac">.{m.frac}</span>
          </span>
          <span className="muted">
            to refund on <Gateway id={c.gateway} />
            {partial ? <> (part of {formatMoney(c.payment!.amount_paisa, c.payment!.currency)})</> : null}
          </span>
        </div>
        <p className="muted" style={{ maxWidth: "70ch" }}>
          {explain(c)}
        </p>
      </header>

      <div className="pay-pair">
        {c.related && <PayCard p={c.related} role="keep" base={base} />}
        {c.payment && <PayCard p={c.payment} role="refund" base={base} />}
      </div>

      {c.status === "failed" && (
        <div className="banner tone-rose">
          <Icon name="alert" />
          <div className="grow">
            <strong className="ink" style={{ fontWeight: 500 }}>
              Your server could not refund it
            </strong>
            {c.note && <span>{c.note}</span>}
            <span className="hint">Fix the cause and send again, or refund it by hand with the steps below.</span>
          </div>
        </div>
      )}
      {c.status === "requested" && (
        <div className="banner tone-sky">
          <span className="spinner" style={{ color: "var(--st-refunded)", marginBlockStart: 3 }} />
          <div className="grow">
            <strong className="ink" style={{ fontWeight: 500 }}>
              Waiting for your server
            </strong>
            <span className="hint">It has up to 20 seconds to call {gatewayName(c.gateway)} and answer. This page updates on its own.</span>
          </div>
        </div>
      )}

      <section>
        <div className="section-title">
          <span>How to refund on {gatewayName(c.gateway)}</span>
          {!c.has_refund_api && <span className="hint">No refund API: done by hand</span>}
        </div>
        <div className="checklist">
          {showSend &&
            (actionSteps.length ? actionSteps : [null]).map((s, i) => (
              <div key={s?.id ?? "send"} className="step">
                <span className="step-n-box">{i + 1}</span>
                <span className="step-text">{s?.text ?? "Send the refund through your server"}</span>
                <div className="step-body">
                  <div>
                    <button className="btn btn-primary" disabled={busy === "send"} onClick={() => void send()}>
                      {busy === "send" ? <span className="spinner" /> : <Icon name="send" />}
                      Send via your server
                    </button>
                  </div>
                  <span className="hint">Or do it by hand with the next steps.</span>
                </div>
              </div>
            ))}
          {(showSend ? manualSteps : c.checklist).map((s) => (
            <label key={s.id} className="step" data-done={s.done_at ? "" : undefined}>
              <span className="check">
                <input type="checkbox" checked={Boolean(s.done_at)} disabled={!canAdmin || !live || Boolean(s.done_at) || busy === `step-${s.id}`} onChange={() => tick(s)} />
              </span>
              <span className="step-text">{s.text}</span>
              {s.done_at && (
                <span className="step-by">
                  Done {formatRelative(s.done_at)}
                  {s.by ? ` by ${s.by}` : ""}
                </span>
              )}
            </label>
          ))}
        </div>
      </section>

      {showExplainer && (
        <section className="card tone-slate">
          <div className="card-body stack" style={{ gap: 12 }}>
            <div>
              <h3>Refund {gatewayName(c.gateway)} payments with one button</h3>
              <p className="muted" style={{ marginBlockStart: 4 }}>
                Add an action endpoint: a route on your server that discerns calls, signed, when someone presses Send. Your server refunds with its own keys; discerns never sees them.
              </p>
            </div>
            <CodeBlock code={SNIPPET} />
            <div className="row wrap">
              <Link className="btn btn-secondary btn-sm" to={`${base}/settings/actions`}>
                Set up the action endpoint
              </Link>
              <span className="hint">The SDK README has a working Khalti refund callback.</span>
            </div>
          </div>
        </section>
      )}

      {canAdmin && (
        <section className="resolve" aria-label="Resolve">
          <div className="map-grid">
            <label className="field">
              <span className="label">Refund reference</span>
              <input className="input mono" value={ref} onChange={(e) => setRef(e.target.value)} placeholder="RF0Q8K21" disabled={!live && c.status !== "requested"} />
            </label>
            <label className="field">
              <span className="label">Note</span>
              <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder={`Emailed ${gatewayName(c.gateway)} support`} disabled={!live && c.status !== "requested"} />
            </label>
          </div>
          {live ? (
            <div className="row wrap" style={{ justifyContent: "space-between" }}>
              <div className="row wrap">
                <button className="btn btn-primary" disabled={Boolean(busy)} onClick={() => void resolve("refunded")}>
                  {busy === "refunded" ? <span className="spinner" /> : <Icon name="check" />}
                  Mark refunded
                </button>
                <button className="btn btn-ghost" disabled={Boolean(busy)} onClick={() => void resolve("dismissed")}>
                  Not a refund, dismiss
                </button>
              </div>
              {(ref !== (c.refund_ref ?? "") || (c.status !== "failed" && note !== (c.note ?? ""))) && (
                <button className="btn btn-secondary btn-sm" disabled={Boolean(busy)} onClick={() => void patch({ refund_ref: ref.trim(), note: note.trim() }, "save").then((x) => x && toast("Saved"))}>
                  Save without resolving
                </button>
              )}
            </div>
          ) : c.status !== "requested" ? (
            <div className="row wrap between">
              <span className="hint">
                {c.status === "refunded" ? "Refunded" : "Dismissed"}
                {c.resolved_at ? ` ${formatDateTime(c.resolved_at)}` : ""}
                {c.resolved_by ? ` by ${c.resolved_by}` : ""}.
              </span>
              <button className="btn btn-ghost btn-sm" disabled={Boolean(busy)} onClick={() => void patch({ status: "open" }, "reopen")}>
                Reopen
              </button>
            </div>
          ) : null}
        </section>
      )}

      <section>
        <div className="section-title">History</div>
        <History c={c} />
      </section>
    </article>
  );
}

function explain(c: RefundCase): ReactNode {
  const order = c.payment?.order_id ?? c.related?.order_id;
  if (c.kind === "duplicate" && c.related && c.payment) {
    const gap = (c.payment.finished_at ?? c.payment.started_at) - (c.related.finished_at ?? c.related.started_at);
    const how = c.reason === "same_customer_amount" ? "The same buyer paid the same amount twice" : `Order ${order ?? ""} was paid twice`;
    return `${how}, ${formatDuration(gap)} apart. Keep the first payment and refund the second.`;
  }
  if (c.kind === "duplicate") return "A second payment for the same order. Refund it and keep the first.";
  return c.reason ? `Reason: ${c.reason}` : "Marked for refund by hand.";
}

function PayCard({ p, role, base }: { p: PaymentSummary; role: "keep" | "refund"; base: string }) {
  return (
    <Link className="pay-card" data-role={role} to={`${base}/payments/${encodeURIComponent(p.attempt_id)}`}>
      <span className="role">
        <span>{role === "keep" ? "First payment: keep" : "Refund this one"}</span>
        <StatusPill status={p.status} />
      </span>
      <dl className="kv">
        <dt>Amount</dt>
        <dd>
          <Money paisa={p.amount_paisa} currency={p.currency} />
        </dd>
        <dt>Gateway</dt>
        <dd>
          <Gateway id={p.gateway} />
        </dd>
        <dt>Paid</dt>
        <dd>{p.finished_at ? <Time t={p.finished_at}>{formatDateTime(p.finished_at)}</Time> : "-"}</dd>
        <dt>Reference</dt>
        <dd className="row" style={{ gap: 2 }}>
          <span className="mono truncate">{p.provider_ref ?? "-"}</span>
          {p.provider_ref && <CopyButton text={p.provider_ref} label="Copy reference" />}
        </dd>
        {p.customer_mask && (
          <>
            <dt>Customer</dt>
            <dd className="mono">{p.customer_mask}</dd>
          </>
        )}
        <dt>Order</dt>
        <dd>
          {p.order_id ?? "-"}
          {role === "keep" && p.fulfilled && <span className="muted"> · fulfilled</span>}
        </dd>
      </dl>
    </Link>
  );
}

interface Entry {
  at: number;
  title: string;
  sub?: string | null;
  tone?: "ok" | "bad" | "warn";
}

function History({ c }: { c: RefundCase }) {
  const now = useNow(30_000);
  const list: Entry[] = [{ at: c.created_at, title: c.kind === "duplicate" ? "Found a second payment for the same order" : "Marked for refund", sub: c.kind === "duplicate" ? null : c.reason }];
  for (const s of c.checklist) if (s.done_at) list.push({ at: s.done_at, title: s.text, sub: s.by ? `Done by ${s.by}` : null, tone: "ok" });
  if (c.action_id && (c.status === "requested" || c.status === "failed" || c.status === "refunded")) {
    const sentAt = c.status === "requested" ? c.updated_at : null;
    if (sentAt) list.push({ at: sentAt, title: "Sent to your server", tone: "warn" });
  }
  if (c.status === "failed") list.push({ at: c.updated_at, title: "Your server could not refund it", sub: c.note, tone: "bad" });
  if (c.resolved_at) list.push({ at: c.resolved_at, title: c.status === "refunded" ? `Refunded${c.refund_ref ? `, ref ${c.refund_ref}` : ""}` : "Dismissed", sub: [c.resolved_by && `by ${c.resolved_by}`, c.status !== "failed" && c.note].filter(Boolean).join(". ") || null, tone: c.status === "refunded" ? "ok" : undefined });
  else if (c.note && c.status !== "failed") list.push({ at: c.updated_at, title: "Note", sub: c.note });
  list.sort((a, z) => a.at - z.at);
  return (
    <ol className="history">
      {list.map((e, i) => (
        <li key={i}>
          <span className="dot" data-tone={e.tone} aria-hidden="true" />
          <span>
            <span className="ink">{e.title}</span>
            {e.sub && <span className="sub">{e.sub}</span>}
          </span>
          <time className="when" dateTime={new Date(e.at).toISOString()} title={formatFull(e.at)}>
            {formatRelative(e.at, now)}
          </time>
        </li>
      ))}
    </ol>
  );
}

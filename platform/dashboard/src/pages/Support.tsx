import type { LookupMatch, LookupResult } from "@paynp/shared";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router";
import { Icon } from "../components/Icon.tsx";
import { StatusLinkDialog } from "../components/Ops.tsx";
import { useProject } from "../components/Shell.tsx";
import { CopyButton, EmptySmall, Gateway, Money, Skeleton } from "../components/ui.tsx";
import { ApiFailure, errorMessage, qs } from "../lib/api.ts";
import { formatDateTime, nptDateToMs, parseRupees, shortId } from "../lib/format.ts";
import { useQuery } from "../lib/query.ts";
import { replyText } from "../lib/reply.ts";
import "../styles/ops.css";

const EXAMPLES: [string, string, string][] = [
  ["Phone or email", "9841234567", "What the buyer typed at checkout"],
  ["Any reference", "0LD5CEH", "Order id, attempt id, or the gateway's code from their SMS"],
  ["Amount and day", "", "When all they remember is how much and when"],
];

export default function Support() {
  const { project, env } = useProject();
  const [params, setParams] = useSearchParams();
  const q = params.get("q") ?? "";
  const amount = params.get("amount") ?? "";
  const from = params.get("from") ?? "";
  const to = params.get("to") ?? "";
  const [draft, setDraft] = useState({ q, amount, from, to });
  const [err, setErr] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const amountRef = useRef<HTMLInputElement>(null);
  useEffect(() => setDraft({ q, amount, from, to }), [q, amount, from, to]);

  const amountPaisa = amount ? parseRupees(amount) : null;
  const searching = Boolean(q || amountPaisa);
  const key = searching
    ? `/api/projects/${project.id}/lookup${qs({ env, q, amount_paisa: amountPaisa, from: from ? nptDateToMs(from) : null, to: to ? nptDateToMs(to, true) : null })}`
    : null;
  const r = useQuery<LookupResult>(key, { staleMs: 10_000 });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const a = draft.amount.trim();
    if (a && parseRupees(a) === null) return setErr("Amount should be a number, like 1,500 or 1500.50");
    if (!draft.q.trim() && !a) return setErr("Type a phone, email or reference, or an amount");
    setErr("");
    const next = new URLSearchParams();
    for (const [k, v] of Object.entries(draft)) if (v.trim()) next.set(k, v.trim());
    setParams(next, { replace: false });
  };

  const items = r.data?.items ?? [];
  const noCustomers = r.data && !items.length && (r.data.query.kind === "phone" || r.data.query.kind === "email");

  return (
    <div className="stack-lg">
      <div className="page-head" style={{ marginBlockEnd: 0 }}>
        <div>
          <h1>Support</h1>
          <p>A customer says they paid. Find the payment from whatever they can tell you.</p>
        </div>
      </div>

      <form className="search-panel" onSubmit={submit} role="search">
        <label className="input-icon">
          <Icon name="search" />
          <span className="sr-only">Phone, email or reference</span>
          <input
            ref={input}
            className="input input-lg"
            value={draft.q}
            onChange={(e) => setDraft({ ...draft, q: e.target.value })}
            placeholder="Phone, email, order id, or gateway reference"
            autoComplete="off"
            spellCheck={false}
            autoFocus={!q}
          />
        </label>
        <div className="search-extra">
          <label className="field amount-field">
            <span className="label">Amount (optional)</span>
            <div className="prefix-input">
              <span>Rs</span>
              <input ref={amountRef} className="input num" inputMode="decimal" placeholder="1,500" value={draft.amount} onChange={(e) => setDraft({ ...draft, amount: e.target.value })} />
            </div>
          </label>
          <label className="field">
            <span className="label">From</span>
            <input className="input" type="date" value={draft.from} max={draft.to || undefined} onChange={(e) => setDraft({ ...draft, from: e.target.value })} />
          </label>
          <label className="field">
            <span className="label">To</span>
            <input className="input" type="date" value={draft.to} min={draft.from || undefined} onChange={(e) => setDraft({ ...draft, to: e.target.value })} />
          </label>
          <button className="btn btn-primary submit">
            Find payment
          </button>
        </div>
        {err && <p className="err">{err}</p>}
      </form>

      {!searching ? (
        <section className="stack">
          <div className="examples">
            {EXAMPLES.map(([title, value, hint]) => (
              <button
                key={title}
                type="button"
                className="example"
                onClick={() => {
                  if (value) {
                    setDraft({ ...draft, q: value });
                    input.current?.focus();
                  } else amountRef.current?.focus();
                }}
              >
                <span className="eyebrow">{title}</span>
                <span className="mono">{value || "Rs 1,500 on 3 Nov"}</span>
                <span className="hint">{hint}</span>
              </button>
            ))}
          </div>
          <div className="note">
            <Icon name="info" />
            <span>
              Phone and email search works for payments that carried a customer. Add <code>customer: (i) =&gt; ({"{ phone: i.phone }"})</code> to <code>wrapGateway</code>. discerns keeps only a salted hash and a masked form.
            </span>
          </div>
        </section>
      ) : r.error && !r.data ? (
        <div className="card">
          <EmptySmall icon="alert" title="Search did not work">
            {r.error instanceof ApiFailure && r.error.status === 400 ? r.error.message : errorMessage(r.error)}
          </EmptySmall>
        </div>
      ) : !r.data ? (
        <div className="verdicts" aria-busy="true">
          {[0, 1].map((i) => (
            <div key={i} className="verdict">
              <div className="verdict-main">
                <Skeleton w="70%" h={16} />
                <Skeleton w="45%" />
              </div>
            </div>
          ))}
        </div>
      ) : (
        <section className="stack" aria-live="polite">
          <div className="row between wrap">
            <h2 style={{ fontSize: 14 }}>{summaryLine(r.data)}</h2>
            {items.some((m) => m.verdict === "paid_duplicate") && (
              <span className="chip" data-tone="warn">
                <Icon name="alert" size={12} />
                Paid more than once
              </span>
            )}
          </div>
          {items.length ? (
            <div className="verdicts">
              {items.map((m) => (
                <VerdictCard key={m.payment.attempt_id} m={m} />
              ))}
            </div>
          ) : (
            <div className="card">
              <EmptySmall icon="search" title="No payment matches">
                {noCustomers ? (
                  <>
                    Nothing with that {r.data.query.kind}. If the app does not send <code>customer</code> to discerns yet, phone and email cannot match; try the order id or the gateway reference from their SMS.
                  </>
                ) : (
                  <>Check the other environment, widen the dates, or try the reference from the customer's {"SMS"} or screenshot.</>
                )}
              </EmptySmall>
            </div>
          )}
        </section>
      )}
    </div>
  );
}

function summaryLine(r: LookupResult): string {
  const n = r.items.length;
  const what = r.query.q ? (r.query.kind === "phone" ? `phone ${r.query.q}` : r.query.kind === "email" ? r.query.q : `"${r.query.q}"`) : "that amount";
  if (!n) return `Nothing found for ${what}`;
  return `${n === 50 ? "50 or more" : n} ${n === 1 ? "payment" : "payments"} for ${what}`;
}

function VerdictCard({ m }: { m: LookupMatch }) {
  const { project, base } = useProject();
  const p = m.payment;
  const [link, setLink] = useState<string | null>(null);
  const [linking, setLinking] = useState(false);
  const reply = replyText(p, m.verdict, link);
  const paidish = m.verdict === "paid" || m.verdict === "paid_duplicate";
  return (
    <article className="verdict" data-v={m.verdict}>
      <div className="verdict-main">
        <p className="verdict-line">
          {m.text}
          {paidish && <span className="muted"> {m.fulfilled ? "Fulfilled." : "Not fulfilled yet."}</span>}
        </p>
        <div className="verdict-facts">
          <span>
            <Money paisa={p.amount_paisa} currency={p.currency} />
          </span>
          <Gateway id={p.gateway} />
          {p.order_id && <span>Order {p.order_id}</span>}
          {p.customer_mask && (
            <span>
              <Icon name="user" size={13} />
              {p.customer_mask}
            </span>
          )}
          <span>Started {formatDateTime(p.started_at)}</span>
          {m.duplicate_of && (
            <Link className="inline-link" to={`${base}/payments/${encodeURIComponent(m.duplicate_of)}`}>
              First payment
            </Link>
          )}
        </div>
        <div className="actions">
          <Link className="btn btn-secondary btn-sm" to={`${base}/payments/${encodeURIComponent(p.attempt_id)}`} title={p.attempt_id}>
            Open payment <span className="mono subtle hide-sm">{shortId(p.attempt_id, 4)}</span>
          </Link>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setLinking(true)}>
            <Icon name="link" size={14} />
            {link ? "New status link" : "Send status link"}
          </button>
          {m.verdict === "paid_duplicate" && (
            <Link className="btn btn-ghost btn-sm" to={`${base}/refunds`}>
              See refund case
            </Link>
          )}
        </div>
      </div>
      <div className="reply">
        <span className="eyebrow">Reply to the customer</span>
        <div className="reply-text">
          {reply}
          <CopyButton text={reply} label="Copy reply" />
        </div>
      </div>
      {linking && <StatusLinkDialog projectId={project.id} attemptId={p.attempt_id} onClose={() => setLinking(false)} onCreated={setLink} />}
    </article>
  );
}

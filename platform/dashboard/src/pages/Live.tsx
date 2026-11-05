import { EVENT_TYPES, type LiveMessage, type Payment, type StoredEvent } from "@paynp/shared";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { Icon } from "../components/Icon.tsx";
import { TestPaymentButton } from "../components/Setup.tsx";
import { useProject } from "../components/Shell.tsx";
import { Command, Gateway, Money, StatusPill, Select } from "../components/ui.tsx";
import { describe, tone } from "../lib/describe.ts";
import { formatCount, formatTimeMs } from "../lib/format.ts";
import { useLive } from "../lib/live.ts";

const MAX = 500;

interface Row {
  e: StoredEvent;
  p?: Payment;
  fresh?: boolean;
}

const problem = (e: StoredEvent, p?: Payment) =>
  e.type === "error" ||
  (e.type === "signature.checked" && e.data?.valid === false) ||
  (e.data?.http_status ?? 0) >= 400 ||
  ["failed", "expired"].includes(e.status ?? e.data?.to ?? "") ||
  (p?.status === "failed" && e.type === "status.changed");

export default function Live() {
  const { project, env, base } = useProject();
  const [rows, setRows] = useState<Row[]>([]);
  const [held, setHeld] = useState<Row[]>([]);
  const [paused, setPaused] = useState(false);
  const [type, setType] = useState("");
  const [gateway, setGateway] = useState("");
  const [onlyProblems, setOnlyProblems] = useState(false);
  const [got, setGot] = useState(false);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  const state = useLive(project.id, env, (m: LiveMessage) => {
    if (m.kind === "backlog") {
      setGot(true);
      setRows(m.events.slice(-MAX).reverse().map((e) => ({ e })));
      return;
    }
    if (m.kind !== "event") return;
    setGot(true);
    const row: Row = { e: m.event, p: m.payment, fresh: true };
    if (pausedRef.current) setHeld((h) => [row, ...h].slice(0, MAX));
    else setRows((r) => [row, ...r.map((x) => (x.fresh ? { ...x, fresh: false } : x))].slice(0, MAX));
  });

  // Space pauses and resumes, unless typing somewhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "Space" || (e.target as HTMLElement).closest("input, textarea, select, button, a, [contenteditable]")) return;
      e.preventDefault();
      toggle();
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  });

  const toggle = () => {
    if (paused) {
      setRows((r) => [...held, ...r].slice(0, MAX));
      setHeld([]);
    }
    setPaused(!paused);
  };

  const shown = rows.filter((r) => (!type || r.e.type === type) && (!gateway || r.e.gateway === gateway) && (!onlyProblems || problem(r.e, r.p)));
  const status = state === "open" ? (paused ? "Paused" : "Connected") : state === "connecting" ? "Connecting" : "Reconnecting";

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Live</h1>
          <p>Events as they reach paynp, newest on top. Nepal time.</p>
        </div>
        <div className="actions">
          <button type="button" className="btn btn-secondary" onClick={toggle} aria-pressed={paused}>
            <Icon name={paused ? "play" : "pause"} />
            {paused ? "Resume" : "Pause"}
            <span className="kbd hide-sm">Space</span>
          </button>
          <button type="button" className="btn btn-ghost" onClick={() => (setRows([]), setHeld([]))} disabled={!rows.length}>
            Clear
          </button>
        </div>
      </div>

      <div className="filters">
        <Select aria-label="Event type" value={type} onChange={setType} options={[{ value: "", label: "Every event type" }, ...EVENT_TYPES.map((t) => ({ value: t, label: t }))]} />
        <Select aria-label="Gateway" value={gateway} onChange={setGateway} options={[{ value: "", label: "Any gateway" }, { value: "esewa", label: "eSewa" }, { value: "khalti", label: "Khalti" }, { value: "fonepay", label: "Fonepay" }]} />
        <label className="check">
          <input type="checkbox" checked={onlyProblems} onChange={(e) => setOnlyProblems(e.target.checked)} />
          Only problems
        </label>
      </div>

      <div className="tail">
        <div className="tail-status" aria-live="polite">
          <span className="row" style={{ gap: 8 }}>
            <span className="live-dot" data-state={state !== "open" ? "off" : paused ? "paused" : "on"} aria-hidden="true" />
            {status}
          </span>
          <span className="num">
            {formatCount(shown.length)} {shown.length === 1 ? "event" : "events"}
            {shown.length !== rows.length && ` of ${formatCount(rows.length)}`}
          </span>
        </div>
        {paused && held.length > 0 && (
          <div className="resume-bar">
            <button type="button" className="btn btn-secondary btn-sm" onClick={toggle}>
              Show {formatCount(held.length)} new {held.length === 1 ? "event" : "events"}
            </button>
          </div>
        )}
        {got && !rows.length ? (
          <div className="empty-small" style={{ paddingBlock: 48 }}>
            <span className="live-dot" style={{ marginBlockEnd: 8 }} />
            <h3>Waiting for events</h3>
            <p className="hint" style={{ maxWidth: 380 }}>
              Anything the SDK sends shows up here within a second. Try a synthetic payment:
            </p>
            <div className="row wrap" style={{ justifyContent: "center", marginBlockStart: 8 }}>
              <div style={{ width: 240 }}>
                <Command cmd="npx paynp test" />
              </div>
              <TestPaymentButton className="btn btn-secondary btn-lg" />
            </div>
          </div>
        ) : !got ? (
          <div className="empty-small">
            <span className="spinner" />
          </div>
        ) : !shown.length ? (
          <div className="empty-small">
            <h3>Nothing matches these filters</h3>
            <p className="hint">{formatCount(rows.length)} events are hidden.</p>
          </div>
        ) : (
          shown.map(({ e, p, fresh }) => {
            const tn = tone(e);
            return (
              <Link key={e.id} to={`${base}/payments/${encodeURIComponent(e.attempt_id)}`} className="tail-row" data-new={fresh || undefined}>
                <span className="ts">{formatTimeMs(e.ts)}</span>
                <span className="gw-cell">
                  <Gateway id={e.gateway} />
                </span>
                <span className="ty" data-tone={tn === "bad" ? "bad" : undefined}>
                  {e.type}
                </span>
                <span className="detail">
                  <span className="mono">{e.order_id ?? e.attempt_id}</span> {describe(e)}
                </span>
                <span className="row tail-right" style={{ gap: 10, justifyContent: "flex-end" }}>
                  {e.type === "payment.started" && <Money paisa={e.amount_paisa ?? null} />}
                  {(e.type === "status.changed" || e.type === "payment.fulfilled") && p && <StatusPill status={p.status} />}
                </span>
              </Link>
            );
          })
        )}
      </div>
    </>
  );
}

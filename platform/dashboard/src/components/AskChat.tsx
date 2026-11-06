import { Fragment, useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { Link } from "react-router";
import { api, errorMessage } from "../lib/api.ts";
import { useQuery } from "../lib/query.ts";
import { Icon } from "./Icon.tsx";

export interface Turn {
  role: "user" | "assistant";
  content: string;
  calls?: { name: string; ok: boolean }[];
}
interface AskReply {
  answer: string;
  tool_calls: { name: string; ok: boolean }[];
  provider: string;
  model: string;
}

const SUGGESTIONS: [string, string][] = [
  ["Why did payments fail in the last 24 hours?", "alert"],
  ["Which gateway is slowest this week?", "clock"],
  ["How much did we collect today, by gateway?", "chart"],
  ["Show payments stuck in pending for over an hour.", "inbox"],
];

const TOOL_LABEL: Record<string, string> = {
  search_payments: "Searched payments",
  get_payment: "Read a timeline",
  payment_analytics: "Read analytics",
  gateway_health: "Checked gateway health",
  list_incidents: "Read incidents",
  integration_doctor: "Checked the integration",
  recheck_payment: "Asked for a recheck",
};

const storeKey = (project: string, env: string) => `paynp.ask.${project}.${env}`;

function load(key: string): Turn[] {
  try {
    return JSON.parse(sessionStorage.getItem(key) ?? "[]") as Turn[];
  } catch {
    return [];
  }
}

/** Short paragraphs, "- " lists, **bold** and `code`; code that looks like an attempt id links to its timeline. */
function Answer({ text, base, onLink }: { text: string; base: string; onLink?: () => void }) {
  const inline = (s: string): ReactNode[] =>
    s.split(/(`[^`]+`|\*\*[^*]+\*\*)/).map((part, i) => {
      if (part.startsWith("**") && part.endsWith("**")) return <strong key={i}>{part.slice(2, -2)}</strong>;
      if (!part.startsWith("`") || !part.endsWith("`")) return <Fragment key={i}>{part}</Fragment>;
      const code = part.slice(1, -1);
      return /^[A-Za-z0-9_.:-]{4,80}$/.test(code) && !/^(prj|org|usr)_/.test(code) ? (
        <Link key={i} className="ask-ref" to={`${base}/payments/${encodeURIComponent(code)}`} onClick={onLink}>
          {code}
        </Link>
      ) : (
        <code key={i}>{code}</code>
      );
    });
  return (
    <div className="ask-md">
      {text.split(/\n{2,}/).map((block, i) => {
        const lines = block.split("\n");
        if (lines.every((l) => /^\s*([-*]|\d+\.) /.test(l)))
          return (
            <ul key={i}>
              {lines.map((l, j) => (
                <li key={j}>{inline(l.replace(/^\s*([-*]|\d+\.) /, ""))}</li>
              ))}
            </ul>
          );
        if (/^#+\s/.test(block)) return <h4 key={i}>{inline(block.replace(/^#+\s*/, ""))}</h4>;
        return <p key={i}>{inline(block)}</p>;
      })}
    </div>
  );
}

/** The Ask conversation: used full page at /ask and in the slide-over panel. */
export function AskChat({ projectId, projectName, env, base, compact, onLink }: { projectId: string; projectName: string; env: string; base: string; compact?: boolean; onLink?: () => void }) {
  const status = useQuery<{ enabled: boolean; provider: string | null; model: string | null }>("/api/ai");
  const key = storeKey(projectId, env);
  const [turns, setTurns] = useState<Turn[]>(() => load(key));
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const scroller = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);

  useEffect(() => setTurns(load(key)), [key]);
  useEffect(() => {
    try {
      sessionStorage.setItem(key, JSON.stringify(turns));
    } catch {
      /* private mode: the conversation just isn't remembered */
    }
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
  }, [turns, busy, key]);
  useEffect(() => box.current?.focus(), []);

  // The composer grows with the text, up to a limit.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [draft]);

  const ask = async (question: string) => {
    const q = question.trim();
    if (!q || busy) return;
    const next: Turn[] = [...turns, { role: "user", content: q }];
    // Optimistic: the question shows at once; a failure puts it back in the box.
    setTurns(next);
    setDraft("");
    setErr("");
    setBusy(true);
    try {
      const r = await api<AskReply>(`/api/projects/${projectId}/ask`, {
        method: "POST",
        body: { env, messages: next.slice(-20).map(({ role, content }) => ({ role, content })) },
      });
      setTurns([...next, { role: "assistant", content: r.answer || "I have no answer for that.", calls: r.tool_calls }]);
    } catch (e) {
      setTurns(turns);
      setDraft(q);
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
      box.current?.focus();
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void ask(draft);
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void ask(draft);
    }
  };

  if (status.data && !status.data.enabled) {
    return (
      <div className="ask-off">
        <span className="ask-orb" aria-hidden="true">
          <Icon name="sparkles" size={18} />
        </span>
        <p>Ask needs a model. Set the ANTHROPIC_API_KEY secret on the Worker, or bind Workers AI as AI.</p>
      </div>
    );
  }

  return (
    <div className={`ask-chat${compact ? " ask-compact" : ""}`}>
      <div className="ask-scroll" ref={scroller} aria-live="polite">
        {turns.length === 0 ? (
          <div className="ask-welcome">
            <span className="ask-orb" aria-hidden="true">
              <Icon name="sparkles" size={20} />
            </span>
            <h3>What do you want to know?</h3>
            <p>
              I read {projectName}'s {env} payments, timelines and alerts, and link every answer back to them.
            </p>
            <div className="ask-suggest">
              {SUGGESTIONS.map(([s, icon]) => (
                <button key={s} type="button" onClick={() => void ask(s)}>
                  <Icon name={icon as "alert"} size={16} />
                  <span>{s}</span>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="ask-thread">
            {turns.map((t, i) =>
              t.role === "user" ? (
                <div key={i} className="ask-q">
                  {t.content}
                </div>
              ) : (
                <div key={i} className="ask-a">
                  <span className="ask-orb ask-orb-sm" aria-hidden="true">
                    <Icon name="sparkles" size={14} />
                  </span>
                  <div className="ask-a-body">
                    {t.calls && t.calls.length > 0 && (
                      <div className="ask-calls">
                        {t.calls.map((c, j) => (
                          <span key={j} className={`ask-call${c.ok ? "" : " ask-call-err"}`}>
                            <Icon name={c.ok ? "check" : "x"} size={12} />
                            {TOOL_LABEL[c.name] ?? c.name}
                          </span>
                        ))}
                      </div>
                    )}
                    <Answer text={t.content} base={base} onLink={onLink} />
                  </div>
                </div>
              ),
            )}
            {busy && (
              <div className="ask-a">
                <span className="ask-orb ask-orb-sm ask-orb-busy" aria-hidden="true">
                  <Icon name="sparkles" size={14} />
                </span>
                <div className="ask-a-body ask-thinking">
                  <span className="ask-shimmer">Looking through the payments</span>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      <form className="ask-composer" onSubmit={submit}>
        {err && (
          <div className="ask-err" role="alert">
            <Icon name="alert" size={14} />
            {err}
          </div>
        )}
        <div className="ask-input">
          <textarea
            ref={box}
            rows={1}
            maxLength={4000}
            placeholder="Ask about payments, failures, gateways or revenue"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKey}
            aria-label="Question"
          />
          <div className="ask-input-bar">
            {turns.length > 0 ? (
              <button type="button" className="ask-ghost" onClick={() => setTurns([])} disabled={busy}>
                <Icon name="refresh" size={14} />
                New chat
              </button>
            ) : (
              <span className="ask-hint">
                <kbd>Enter</kbd> to send
              </span>
            )}
            <button className="ask-send" disabled={busy || !draft.trim()} aria-label="Send">
              <Icon name="arrowUp" size={16} strokeWidth={2} />
            </button>
          </div>
        </div>
        {status.data?.model && <p className="ask-model">Answers come from {status.data.provider === "claude" ? "Claude" : "Workers AI"} reading this project. Check numbers that matter.</p>}
      </form>
    </div>
  );
}

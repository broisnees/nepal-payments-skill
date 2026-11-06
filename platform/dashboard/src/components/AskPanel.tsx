import { Suspense, lazy, useEffect, useState } from "react";
import { Link } from "react-router";
import { Icon } from "./Icon.tsx";
import type { ProjectCtx } from "./Shell.tsx";
import "../styles/ask.css";

// The chat code loads the first time the panel opens, not with the dashboard.
const AskChat = lazy(() => import("./AskChat.tsx").then((m) => ({ default: m.AskChat })));

/** Ask AI as a slide-over on the right of every project page. Escape or the close button hides it. */
export function AskPanel({ ctx, open, onClose }: { ctx: ProjectCtx; open: boolean; onClose: () => void }) {
  // Mounted on first open and kept, so a conversation survives closing the panel.
  const [mounted, setMounted] = useState(open);
  useEffect(() => {
    if (open) setMounted(true);
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  return (
    <aside id="ask-panel" className={`ask-panel${open ? " is-open" : ""}`} aria-label="Ask AI" aria-hidden={!open} inert={!open}>
      <header className="ask-panel-head">
        <span className="ask-orb ask-orb-sm" aria-hidden="true">
          <Icon name="sparkles" size={14} />
        </span>
        <div className="ask-panel-title">
          <strong>Ask AI</strong>
          <span>
            {ctx.project.name} · {ctx.env}
          </span>
        </div>
        <Link className="btn btn-icon btn-sm" to={`${ctx.base}/ask`} onClick={onClose} aria-label="Open full page" title="Open full page">
          <Icon name="external" size={15} />
        </Link>
        <button type="button" className="btn btn-icon btn-sm" onClick={onClose} aria-label="Close" title="Close (Esc)">
          <Icon name="x" size={16} />
        </button>
      </header>
      {mounted && (
        <Suspense fallback={<div className="ask-loading"><span className="spinner" /></div>}>
          <AskChat projectId={ctx.project.id} projectName={ctx.project.name} env={ctx.env} base={ctx.base} compact onLink={onClose} />
        </Suspense>
      )}
    </aside>
  );
}

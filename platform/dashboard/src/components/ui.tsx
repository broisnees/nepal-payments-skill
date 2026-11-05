import type { PaymentStatus } from "@paynp/shared";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { formatFull, gatewayName, moneyParts, statusLabel } from "../lib/format.ts";
import { Icon, type IconName } from "./Icon.tsx";

// ------------------------------------------------------------------ copy
export function CopyButton({ text, className = "btn btn-icon btn-sm hit", label = "Copy" }: { text: string; className?: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(false), 1400);
    return () => clearTimeout(id);
  }, [copied]);
  return (
    <button
      type="button"
      className={className}
      aria-label={copied ? "Copied" : label}
      title={copied ? "Copied" : label}
      data-copied={copied || undefined}
      onClick={(e) => {
        e.stopPropagation();
        void navigator.clipboard?.writeText(text).then(() => setCopied(true), () => setCopied(true));
      }}
    >
      <span className="copy-icons">
        <Icon name="copy" className="i-copy" />
        <Icon name="check" className="i-check" />
      </span>
    </button>
  );
}

export function Command({ cmd }: { cmd: string }) {
  return (
    <div className="code code-inline">
      <span className="prompt">$</span>
      <span className="truncate">{cmd}</span>
      <CopyButton text={cmd} className="btn btn-icon btn-sm copy hit" label="Copy command" />
    </div>
  );
}

export function CodeBlock({ code, copy = true, children }: { code: string; copy?: boolean; children?: ReactNode }) {
  return (
    <div className="code">
      <pre>{children ?? code}</pre>
      {copy && <CopyButton text={code} className="btn btn-icon btn-sm copy hit" />}
    </div>
  );
}

/** JSON with quiet syntax color: keys, strings, numbers. */
export function JsonView({ value }: { value: unknown }) {
  const text = JSON.stringify(value, null, 2);
  const parts: ReactNode[] = [];
  const re = /("(?:\\.|[^"\\])*")(\s*:)?|\b(-?\d+(?:\.\d+)?)\b|\b(true|false|null)\b/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    if (m[1] && m[2]) parts.push(<span key={i++} className="c-key">{m[1]}</span>, m[2]);
    else if (m[1]) parts.push(<span key={i++} className="c-str">{m[1]}</span>);
    else parts.push(<span key={i++} className="c-num">{m[0]}</span>);
    last = re.lastIndex;
  }
  parts.push(text.slice(last));
  return <CodeBlock code={text}>{parts}</CodeBlock>;
}

// ------------------------------------------------------------------ data atoms
export function StatusPill({ status, pulse }: { status: PaymentStatus | string; pulse?: boolean }) {
  return (
    <span className="pill" data-s={status} data-pulse={pulse || undefined}>
      {statusLabel(status)}
    </span>
  );
}

export function Gateway({ id }: { id: string }) {
  return (
    <span className="gw" data-gw={id}>
      {gatewayName(id)}
    </span>
  );
}

export function Money({ paisa, className = "amount" }: { paisa: number | null | undefined; className?: string }) {
  if (paisa === null || paisa === undefined) return <span className="subtle">-</span>;
  const p = moneyParts(paisa);
  return (
    <span className={className}>
      <span className="cur">Rs</span>
      {p.sign}
      {p.int}
      <span className="frac">.{p.frac}</span>
    </span>
  );
}

export function Time({ t, children }: { t: number | string; children: ReactNode }) {
  const ms = typeof t === "number" ? t : Date.parse(t);
  return (
    <time dateTime={new Date(ms).toISOString()} title={formatFull(ms)}>
      {children}
    </time>
  );
}

/** Re-renders every `ms` so relative times stay true. */
export function useNow(ms = 15_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

export function Skeleton({ w = "100%", h = 12 }: { w?: number | string; h?: number }) {
  return <span className="skel" style={{ width: w, height: h }} />;
}

export function Spark({ values, width = 96, height = 28, color = "var(--ink)" }: { values: (number | null)[]; width?: number; height?: number; color?: string }) {
  const nums = values.map((v) => v ?? 0);
  if (nums.length < 2 || nums.every((v) => v === 0)) return null;
  const max = Math.max(...nums, 1);
  const min = Math.min(...nums, 0);
  const x = (i: number) => (i / (nums.length - 1)) * width;
  const y = (v: number) => height - 2 - ((v - min) / (max - min || 1)) * (height - 4);
  const d = nums.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join("");
  const area = `${d}L${width} ${height}L0 ${height}Z`;
  const last = nums[nums.length - 1];
  return (
    <svg className="spark" width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      <path d={area} fill={color} opacity="0.08" />
      <path d={d} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" opacity="0.55" />
      <circle cx={width} cy={y(last)} r="2.5" fill={color} />
    </svg>
  );
}

export function EmptySmall({ icon = "inbox", title, children }: { icon?: IconName; title: string; children?: ReactNode }) {
  return (
    <div className="empty-small">
      <Icon name={icon} size={20} />
      <h3>{title}</h3>
      {children && <div className="hint">{children}</div>}
    </div>
  );
}

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return <button type="button" role="switch" className="switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => onChange(!checked)} />;
}

export function Seg<T extends string>({ value, options, onChange, small, label, className = "" }: { value: T; options: { value: T; label: ReactNode }[]; onChange: (v: T) => void; small?: boolean; label: string; className?: string }) {
  return (
    <div className={`seg ${small ? "seg-sm" : ""} ${className}`} role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" data-env={o.value} aria-pressed={value === o.value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ menu
export function Menu({ trigger, children, align = "start", className = "" }: { trigger: (p: { open: boolean; toggle: () => void; id: string }) => ReactNode; children: (close: () => void) => ReactNode; align?: "start" | "end"; className?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const id = useId();
  const close = useCallback(() => setOpen(false), []);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div className={`menu-anchor ${className}`} ref={ref}>
      {trigger({ open, toggle: () => setOpen((v) => !v), id })}
      {open && (
        <div className="menu" id={id} role="menu" data-align={align}>
          {children(close)}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ dialog
export function Dialog({ open, onClose, title, description, children, footer, wide }: { open: boolean; onClose: () => void; title: string; description?: ReactNode; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      d.showModal();
      // Land on the first field if there is one; otherwise on the dialog itself, not on the close button.
      const field = d.querySelector<HTMLElement>("input:not([type=checkbox]):not([disabled]), textarea, select");
      (field ?? d).focus();
    }
    if (!open && d.open) d.close();
  }, [open]);
  if (!open) return null;
  return createPortal(
    <dialog
      ref={ref}
      tabIndex={-1}
      className="dlg"
      style={wide ? { width: "min(680px, calc(100vw - 24px))" } : undefined}
      onClose={onClose}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="dlg-head">
        <div>
          <h2>{title}</h2>
          {description && <p>{description}</p>}
        </div>
        <button type="button" className="btn btn-icon btn-sm hit" aria-label="Close" onClick={onClose}>
          <Icon name="x" />
        </button>
      </div>
      {children ? <div className="dlg-body">{children}</div> : <div style={{ height: 16 }} />}
      {footer && <div className="dlg-foot">{footer}</div>}
    </dialog>,
    document.body,
  );
}

// ------------------------------------------------------------------ toasts
interface ToastItem {
  id: number;
  title: string;
  sub?: string;
  kind: "ok" | "error" | "info";
}
let toasts: ToastItem[] = [];
const toastSubs = new Set<() => void>();
let seq = 0;

export function toast(title: string, opts: { sub?: string; kind?: ToastItem["kind"] } = {}) {
  const t: ToastItem = { id: ++seq, title, sub: opts.sub, kind: opts.kind ?? "ok" };
  toasts = [...toasts.slice(-2), t];
  for (const fn of toastSubs) fn();
  setTimeout(() => {
    toasts = toasts.filter((x) => x.id !== t.id);
    for (const fn of toastSubs) fn();
  }, 4200);
}

export function Toaster() {
  const list = useSyncExternalStore(
    (fn) => {
      toastSubs.add(fn);
      return () => toastSubs.delete(fn);
    },
    () => toasts,
  );
  return (
    <div className="toasts" role="status" aria-live="polite">
      {list.map((t) => (
        <div key={t.id} className="toast" data-kind={t.kind}>
          <Icon className="t-icon" name={t.kind === "error" ? "alert" : t.kind === "info" ? "info" : "check"} />
          <div>
            <div>{t.title}</div>
            {t.sub && <div className="t-sub">{t.sub}</div>}
          </div>
        </div>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ confirm
interface Ask {
  title: string;
  body?: string;
  action: string;
  danger?: boolean;
  resolve: (ok: boolean) => void;
}
let ask: Ask | null = null;
const askSubs = new Set<() => void>();

/** A styled replacement for window.confirm. Resolves true when the action button is pressed. */
export function confirmAction(o: Omit<Ask, "resolve">): Promise<boolean> {
  return new Promise((resolve) => {
    ask = { ...o, resolve };
    for (const fn of askSubs) fn();
  });
}

export function ConfirmHost() {
  const a = useSyncExternalStore(
    (fn) => {
      askSubs.add(fn);
      return () => askSubs.delete(fn);
    },
    () => ask,
  );
  const done = (ok: boolean) => {
    a?.resolve(ok);
    ask = null;
    for (const fn of askSubs) fn();
  };
  if (!a) return null;
  return (
    <Dialog
      open
      onClose={() => done(false)}
      title={a.title}
      description={a.body}
      footer={
        <>
          <button type="button" className="btn btn-secondary" onClick={() => done(false)}>
            Cancel
          </button>
          <button type="button" autoFocus className={a.danger ? "btn btn-danger-solid" : "btn btn-primary"} onClick={() => done(true)}>
            {a.action}
          </button>
        </>
      }
    >
      {null}
    </Dialog>
  );
}

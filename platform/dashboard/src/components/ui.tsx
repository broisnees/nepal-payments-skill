import { GATEWAY_LOGOS, type PaymentStatus } from "@paynp/shared";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
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

/**
 * A gateway as its official icon on a small light tile, then its name. `logo` shows the full wordmark instead,
 * for roomy places. Unknown gateways fall back to a coloured dot and the name.
 */
export function Gateway({ id, logo = false, size = 16 }: { id: string; logo?: boolean; size?: number }) {
  const l = GATEWAY_LOGOS[id];
  const name = gatewayName(id);
  if (!l) {
    return (
      <span className="gw" data-gw={id}>
        {name}
      </span>
    );
  }
  if (!logo) {
    return (
      <span className="gw-icon">
        <span className="gw-tile" style={{ width: size + 4, height: size + 4 }}>
          <img src={l.icon} alt="" width={size} height={size} decoding="async" />
        </span>
        {name}
      </span>
    );
  }
  const h = Math.round(size * (l.scale ?? 1));
  const w = Math.round(h * l.ratio);
  return (
    <span className={l.chip ? "gw-logo gw-logo-chip" : "gw-logo"} title={name} style={{ height: h }}>
      <img className={l.dark ? "gw-logo-light" : undefined} src={l.light} alt={name} width={w} height={h} decoding="async" />
      {l.dark && <img className="gw-logo-dark" src={l.dark} alt="" aria-hidden="true" width={w} height={h} decoding="async" />}
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

// ------------------------------------------------------------------ select
export type SelectOption<T extends string = string> = { value: T; label: string; hint?: string; disabled?: boolean };

/** Listbox in place of a native <select>. The OS popup ignored the theme (a light,
 * blue-highlighted list in dark mode) and the sharp, menu-styled language of every other
 * popover. Keeps native behaviour: focus stays on the trigger, arrows/Home/End move,
 * Enter/Space pick, Escape closes, typing jumps to a label. The list is portalled with
 * fixed positioning so tables and dialogs can't clip it, and it flips up near the bottom.
 * Every label sits stacked in the trigger, so it is as wide as the longest option and a
 * filter bar doesn't shift when the value changes. */
export function Select<T extends string>({
  value,
  options,
  onChange,
  className = "",
  style,
  disabled,
  invalid,
  "aria-label": ariaLabel,
}: {
  value: T;
  options: SelectOption<T>[];
  onChange: (v: T) => void;
  className?: string;
  style?: CSSProperties;
  disabled?: boolean;
  invalid?: boolean;
  "aria-label"?: string;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [pos, setPos] = useState<{ top?: number; bottom?: number; left: number; width: number; maxHeight: number; up: boolean } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const typed = useRef({ text: "", at: 0 });
  const id = useId();
  const selected = options.findIndex((o) => o.value === value);

  const place = useCallback(() => {
    const r = trigger.current?.getBoundingClientRect();
    if (!r) return;
    const below = window.innerHeight - r.bottom - 8;
    const above = r.top - 8;
    const up = below < 200 && above > below;
    const maxHeight = Math.min(320, up ? above : below) - 4;
    setPos(up ? { bottom: window.innerHeight - r.top + 4, left: r.left, width: r.width, maxHeight, up } : { top: r.bottom + 4, left: r.left, width: r.width, maxHeight, up });
  }, []);

  const show = (at = selected) => {
    if (disabled) return;
    place();
    setActive(at >= 0 ? at : options.findIndex((o) => !o.disabled));
    setOpen(true);
  };
  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };
  const pick = (i: number) => {
    const o = options[i];
    if (!o || o.disabled) return;
    if (o.value !== value) onChange(o.value);
    close();
  };
  const step = (from: number, dir: 1 | -1) => {
    for (let i = from + dir; i >= 0 && i < options.length; i += dir) if (!options[i]!.disabled) return i;
    return from;
  };

  useLayoutEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!trigger.current?.contains(t) && !list.current?.contains(t)) setOpen(false);
    };
    // Follow the trigger instead of closing: filter bars sit in scrolling pages.
    document.addEventListener("pointerdown", onDown);
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open, place]);

  useLayoutEffect(() => {
    if (open && active >= 0) list.current?.querySelector<HTMLElement>(`[data-i="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [open, active]);

  const onKey = (e: React.KeyboardEvent) => {
    if (!open) {
      if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) {
        e.preventDefault();
        show();
      }
      return;
    }
    if (e.key === "ArrowDown") setActive((a) => step(a, 1));
    else if (e.key === "ArrowUp") setActive((a) => step(a, -1));
    else if (e.key === "Home") setActive(step(-1, 1));
    else if (e.key === "End") setActive(step(options.length, -1));
    else if (e.key === "Enter" || e.key === " ") pick(active);
    else if (e.key === "Escape") close();
    else if (e.key === "Tab") setOpen(false);
    else if (e.key.length === 1) {
      const now = Date.now();
      const t = (typed.current = { text: (now - typed.current.at < 600 ? typed.current.text : "") + e.key.toLowerCase(), at: now });
      const hit = options.findIndex((o) => !o.disabled && o.label.toLowerCase().startsWith(t.text));
      if (hit >= 0) setActive(hit);
      return;
    } else return;
    if (e.key !== "Tab") e.preventDefault();
  };

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={`select select-btn ${className}`}
        style={style}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-activedescendant={open && active >= 0 ? `${id}-${active}` : undefined}
        aria-label={ariaLabel}
        aria-invalid={invalid || undefined}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={onKey}
      >
        <span className="select-value">
          {options.map((o, i) => (
            <span key={o.value} aria-hidden={i !== selected || undefined} data-hidden={i !== selected || undefined}>
              {o.label}
            </span>
          ))}
          {selected < 0 && <span className="subtle">Choose</span>}
        </span>
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={list}
            id={id}
            role="listbox"
            aria-label={ariaLabel}
            className="menu select-list"
            data-up={pos.up || undefined}
            style={{ top: pos.top, bottom: pos.bottom, left: pos.left, minWidth: pos.width, maxHeight: pos.maxHeight }}
            onMouseDown={(e) => e.preventDefault()}
          >
            {options.map((o, i) => (
              <div
                key={o.value}
                id={`${id}-${i}`}
                data-i={i}
                role="option"
                className="menu-item"
                aria-selected={i === selected}
                aria-disabled={o.disabled || undefined}
                data-active={i === active || undefined}
                onPointerMove={() => !o.disabled && active !== i && setActive(i)}
                onClick={() => pick(i)}
              >
                <span className="select-label">{o.label}</span>
                {o.hint && <span className="select-hint">{o.hint}</span>}
                {i === selected && <Icon name="check" size={14} className="check-mark" />}
              </div>
            ))}
          </div>,
          document.body,
        )}
    </>
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

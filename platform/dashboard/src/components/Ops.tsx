// Pieces the merchant operations pages share: refund status, status links, marking a payment for refund.
import "../styles/ops.css";
import type { PaymentSummary, RefundCase, RefundStatus, StatusLink } from "@paynp/shared";
import { useState, type FormEvent } from "react";
import { api, errorMessage } from "../lib/api.ts";
import { formatDate, formatMoney, parseRupees } from "../lib/format.ts";
import { invalidate } from "../lib/query.ts";
import { Icon } from "./Icon.tsx";
import { CopyButton, Dialog, Select, toast } from "./ui.tsx";

const REFUND_LABEL: Record<RefundStatus, string> = {
  open: "Needs action",
  requested: "Sent to your server",
  failed: "Failed",
  refunded: "Refunded",
  dismissed: "Dismissed",
};

export function RefundPill({ status }: { status: RefundStatus }) {
  return (
    <span className="pill" data-s={status}>
      {REFUND_LABEL[status]}
    </span>
  );
}

export function kindLabel(c: Pick<RefundCase, "kind" | "reason">): string {
  if (c.kind === "duplicate") return c.reason === "same_customer_amount" ? "Same buyer, same amount" : "Paid twice";
  return "Refund request";
}

/** Creates a customer status link for one payment and shows it with a copy button. */
export function StatusLinkDialog({ projectId, attemptId, onClose, onCreated }: { projectId: string; attemptId: string; onClose: () => void; onCreated?: (url: string) => void }) {
  const [link, setLink] = useState<StatusLink | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [days, setDays] = useState(7);
  const create = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr("");
    try {
      const l = await api<StatusLink>(`/api/projects/${projectId}/payments/${encodeURIComponent(attemptId)}/status-link`, { method: "POST", body: { expires_days: days } });
      setLink(l);
      onCreated?.(l.url);
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={link ? "Status link ready" : "Send a status link"}
      description={link ? "Send it to the customer by SMS, Viber or email." : "A page the customer can open without signing in: amount, gateway, status and reference. It shows no phone number or email."}
      footer={
        link ? (
          <button className="btn btn-primary" onClick={onClose}>
            Done
          </button>
        ) : undefined
      }
    >
      {link ? (
        <div className="reveal">
          <div className="secret" style={{ background: "var(--surface-2)", borderColor: "var(--line)" }}>
            <span style={{ flex: 1, minWidth: 0 }}>{link.url}</span>
            <CopyButton text={link.url} label="Copy link" />
          </div>
          {link.expires_at && (
            <p className="hint">
              Works until {formatDate(link.expires_at)}. Anyone with the link can see this one payment.
            </p>
          )}
        </div>
      ) : (
        <form className="stack" onSubmit={create}>
          <label className="field">
            <span className="label">Link works for</span>
            <Select style={{ width: 160 }} aria-label="Link works for" value={String(days)} onChange={(v) => setDays(Number(v))} options={[{ value: "1", label: "1 day" }, { value: "7", label: "7 days" }, { value: "30", label: "30 days" }]} />
          </label>
          {err && <p className="err">{err}</p>}
          <div className="actions" style={{ justifyContent: "flex-end" }}>
            <button type="button" className="btn btn-secondary" onClick={onClose}>
              Cancel
            </button>
            <button className="btn btn-primary" disabled={busy}>
              {busy ? <span className="spinner" /> : <Icon name="link" />}
              Create link
            </button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

/** Opens a refund case for a paid payment (POST /refunds). */
export function MarkRefundDialog({ projectId, env, payment, onClose, onDone }: { projectId: string; env: string; payment: Pick<PaymentSummary, "attempt_id" | "amount_paisa" | "gateway">; onClose: () => void; onDone?: (c: RefundCase) => void }) {
  const full = payment.amount_paisa ?? 0;
  const [amount, setAmount] = useState(full ? String(full / 100) : "");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const paisa = parseRupees(amount);
  const tooMuch = paisa !== null && full > 0 && paisa > full;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!paisa || tooMuch) return setErr(tooMuch ? `At most ${formatMoney(full)}` : "Enter the amount to refund");
    if (!reason.trim()) return setErr("Say why, for the record and the credit note");
    setBusy(true);
    setErr("");
    try {
      const c = await api<RefundCase>(`/api/projects/${projectId}/refunds?env=${env}`, { method: "POST", body: { attempt_id: payment.attempt_id, amount_paisa: paisa, reason: reason.trim() } });
      invalidate(`/api/projects/${projectId}/refunds`);
      invalidate(`/api/projects/${projectId}/payments/${encodeURIComponent(payment.attempt_id)}`);
      toast("Added to Refunds", { sub: `${formatMoney(paisa)}, ${paisa === full ? "full" : "partial"} refund` });
      onDone?.(c);
      onClose();
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onClose={onClose} title="Mark for refund" description="Opens a case in Refunds with the steps for this gateway. Nothing is sent to the gateway yet.">
      <form className="stack" onSubmit={submit}>
        <label className="field">
          <span className="label">Amount</span>
          <div className="prefix-input" style={{ width: 200 }}>
            <span>Rs</span>
            <input className="input num" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} aria-invalid={tooMuch || undefined} />
          </div>
          <span className="hint">Full amount is {formatMoney(full)}. A smaller amount is a partial refund.</span>
        </label>
        <label className="field">
          <span className="label">Reason</span>
          <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Returned the item, wrong size" maxLength={200} />
        </label>
        {err && <p className="err">{err}</p>}
        <div className="actions" style={{ justifyContent: "flex-end" }}>
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={busy}>
            {busy && <span className="spinner" />}
            Add to Refunds
          </button>
        </div>
      </form>
    </Dialog>
  );
}

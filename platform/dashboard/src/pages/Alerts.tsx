import type { AlertChannel, AlertRule, ChannelType, Env, Incident, Page, RuleType } from "@paynp/shared";
import { useState, type FormEvent, type ReactNode } from "react";
import { Link, NavLink, useParams, useSearchParams } from "react-router";
import { Icon, type IconName } from "../components/Icon.tsx";
import { useProject } from "../components/Shell.tsx";
import { Dialog, EmptySmall, Menu, confirmAction, Seg, Skeleton, StatusPill, Switch, Time, toast, useNow, Select } from "../components/ui.tsx";
import { api, errorMessage, items, qs } from "../lib/api.ts";
import { formatDuration, formatMoney, formatRelative, gatewayName, parseRupees } from "../lib/format.ts";
import { RULES } from "../lib/labels.ts";
import type { IncidentExtra } from "../lib/types.ts";
import { invalidate, setData, useQuery } from "../lib/query.ts";

export default function Alerts() {
  const { tab = "rules" } = useParams();
  const { base } = useProject();
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Alerts</h1>
          <p>Rules watch the event stream; channels deliver; incidents are the history.</p>
        </div>
      </div>
      <nav className="tabs" aria-label="Alerts" style={{ padding: 0, marginBlockEnd: 20, borderBlockEnd: "1px solid var(--line)" }}>
        {[
          ["rules", "Rules"],
          ["channels", "Channels"],
          ["incidents", "Incidents"],
        ].map(([k, l]) => (
          <NavLink key={k} to={`${base}/alerts/${k}`} className="tab" style={{ paddingInline: 0, marginInlineEnd: 20 }}>
            {l}
          </NavLink>
        ))}
      </nav>
      {tab === "channels" ? <Channels /> : tab === "incidents" ? <Incidents /> : <Rules />}
    </>
  );
}

// ------------------------------------------------------------------ rules
type Field = { key: string; label: string; kind: "number" | "rupees" | "gateway" | "gateways"; unit?: string; hint?: string; min?: number };
const PARAMS: Record<RuleType, { defaults: Record<string, unknown>; fields: Field[] }> = {
  payment_failed: {
    defaults: {},
    fields: [
      { key: "min_amount_paisa", label: "Only payments of at least", kind: "rupees", hint: "Leave empty for every failed payment" },
      { key: "gateways", label: "Gateways", kind: "gateways", hint: "None selected means all" },
    ],
  },
  failure_rate: {
    defaults: { threshold_pct: 20, window_min: 15, min_payments: 5 },
    fields: [
      { key: "threshold_pct", label: "Failure rate above", kind: "number", unit: "%", min: 1 },
      { key: "window_min", label: "Over the last", kind: "number", unit: "min", min: 1 },
      { key: "min_payments", label: "With at least", kind: "number", unit: "payments", min: 1, hint: "Avoids alerts from one failure out of two" },
      { key: "gateway", label: "Gateway", kind: "gateway" },
    ],
  },
  stuck_pending: { defaults: { older_than_min: 30 }, fields: [{ key: "older_than_min", label: "Open for longer than", kind: "number", unit: "min", min: 1 }] },
  amount_mismatch: { defaults: {}, fields: [] },
  signature_failure: {
    defaults: { threshold: 1, window_min: 10 },
    fields: [
      { key: "threshold", label: "At least", kind: "number", unit: "failures", min: 1 },
      { key: "window_min", label: "Within", kind: "number", unit: "min", min: 1 },
    ],
  },
  gateway_errors: {
    defaults: { error_rate_pct: 20, window_min: 10, min_requests: 5 },
    fields: [
      { key: "error_rate_pct", label: "Error rate above", kind: "number", unit: "%", min: 1 },
      { key: "window_min", label: "Over the last", kind: "number", unit: "min", min: 1 },
      { key: "min_requests", label: "With at least", kind: "number", unit: "requests", min: 1 },
      { key: "gateway", label: "Gateway", kind: "gateway" },
    ],
  },
  gateway_slow: {
    defaults: { avg_ms: 5000, window_min: 10 },
    fields: [
      { key: "avg_ms", label: "Average response above", kind: "number", unit: "ms", min: 100 },
      { key: "window_min", label: "Over the last", kind: "number", unit: "min", min: 1 },
      { key: "gateway", label: "Gateway", kind: "gateway" },
    ],
  },
  double_fulfilment: { defaults: {}, fields: [] },
  no_traffic: { defaults: { window_min: 60 }, fields: [{ key: "window_min", label: "No payment started for", kind: "number", unit: "min", min: 5 }] },
  double_payment: { defaults: {}, fields: [] },
  paid_not_fulfilled: {
    defaults: { after_min: 15 },
    fields: [{ key: "after_min", label: "Not fulfilled after", kind: "number", unit: "min", min: 1, hint: "Checks payments paid in the last 24 hours" }],
  },
};
const PER_EVENT: RuleType[] = ["payment_failed", "amount_mismatch", "double_fulfilment", "double_payment", "paid_not_fulfilled"];

/** What a rule needs from the app before it can fire, said once in the editor. */
const RULE_NOTES: Partial<Record<RuleType, ReactNode>> = {
  double_payment: (
    <>
      Matches a second paid payment for the same order id, or the same customer paying the same amount within 30 minutes. The second one lands in Refunds. Customer matching needs <code>customer: (i) =&gt; ({"{ phone }"})</code> in <code>wrapGateway</code>.
    </>
  ),
  paid_not_fulfilled: (
    <>
      Stays quiet until the app reports fulfilment: call <code>paynp.fulfilled()</code> when an order ships. Projects that never sent a fulfilment in the last 30 days are skipped, so this rule cannot fire for them.
    </>
  ),
};

function summary(r: Pick<AlertRule, "type" | "params">): string {
  const p = r.params as Record<string, number | string | string[] | undefined>;
  const gw = p.gateway ? ` on ${gatewayName(String(p.gateway))}` : "";
  switch (r.type) {
    case "payment_failed": {
      const parts = [p.min_amount_paisa ? `${formatMoney(Number(p.min_amount_paisa))} or more` : "Any amount"];
      if (Array.isArray(p.gateways) && p.gateways.length) parts.push(p.gateways.map(gatewayName).join(", "));
      return parts.join(", ");
    }
    case "failure_rate":
      return `Above ${p.threshold_pct}% over ${p.window_min} min, at least ${p.min_payments} payments${gw}`;
    case "stuck_pending":
      return `Open longer than ${p.older_than_min} min`;
    case "signature_failure":
      return `${p.threshold} or more within ${p.window_min} min`;
    case "gateway_errors":
      return `Above ${p.error_rate_pct}% over ${p.window_min} min, at least ${p.min_requests} requests${gw}`;
    case "gateway_slow":
      return `Average above ${formatDuration(Number(p.avg_ms))} over ${p.window_min} min${gw}`;
    case "no_traffic":
      return `Nothing for ${p.window_min} min`;
    case "paid_not_fulfilled":
      return `Paid, not fulfilled after ${p.after_min} min`;
    default:
      return "Every occurrence";
  }
}

const CH_ICON: Record<ChannelType, IconName> = { email: "mail", slack: "hash", discord: "message", webhook: "webhook" };

function Rules() {
  const { project, canAdmin } = useProject();
  const key = `/api/projects/${project.id}/rules`;
  const rules = useQuery<Page<AlertRule>>(key);
  const channels = useQuery<Page<AlertChannel>>(`/api/projects/${project.id}/channels`);
  const [editing, setEditing] = useState<AlertRule | "new" | null>(null);
  const list = items(rules.data);
  const chs = items(channels.data);

  const toggle = async (r: AlertRule, enabled: boolean) => {
    setData<Page<AlertRule>>(key, (pg) => pg && { ...pg, items: pg.items.map((x) => (x.id === r.id ? { ...x, enabled } : x)) });
    try {
      await api(`${key}/${r.id}`, { method: "PATCH", body: { enabled } });
    } catch (e) {
      toast("Could not update the rule", { kind: "error", sub: errorMessage(e) });
      invalidate(key);
    }
  };
  const remove = async (r: AlertRule) => {
    if (!(await confirmAction({ title: `Delete the ${RULES[r.type].title} rule?`, body: "Open incidents from it stay in the history.", action: "Delete rule", danger: true }))) return;
    try {
      await api(`${key}/${r.id}`, { method: "DELETE" });
      invalidate(key);
      toast("Rule deleted");
    } catch (e) {
      toast("Could not delete the rule", { kind: "error", sub: errorMessage(e) });
    }
  };

  return (
    <div className="stack">
      <div className="row between wrap">
        <p className="muted">{list.length ? `${list.filter((r) => r.enabled).length} of ${list.length} rules on` : " "}</p>
        {canAdmin && (
          <button className="btn btn-primary" onClick={() => setEditing("new")}>
            <Icon name="plus" />
            New rule
          </button>
        )}
      </div>
      <div className="card">
        {!rules.data ? (
          <div className="card-body stack">
            <Skeleton />
            <Skeleton />
            <Skeleton />
          </div>
        ) : !list.length ? (
          <EmptySmall icon="bell" title="No alert rules yet">
            Start with Failure rate and Stuck pending. They catch most real problems.
          </EmptySmall>
        ) : (
          <div className="list">
            {list.map((r) => (
              <div key={r.id} className="list-row" style={{ minHeight: 60, opacity: r.enabled ? 1 : 0.6 }}>
                <Switch checked={r.enabled} onChange={(v) => void toggle(r, v)} label={`${RULES[r.type].title} enabled`} disabled={!canAdmin} />
                <div className="grow">
                  <div className="row" style={{ gap: 8 }}>
                    <span className="ink" style={{ fontWeight: 450 }}>
                      {RULES[r.type].title}
                    </span>
                    <span className={`tag ${r.env === "live" ? "tag-live" : "tag-test"}`}>{r.env}</span>
                  </div>
                  <div className="meta truncate">{summary(r)}</div>
                </div>
                <div className="row hide-sm" style={{ gap: 4 }}>
                  {r.channel_ids.map((id) => {
                    const c = chs.find((x) => x.id === id);
                    return c ? (
                      <span key={id} className="tag" title={c.name} style={{ gap: 4 }}>
                        <Icon name={CH_ICON[c.type]} size={12} />
                        {c.name}
                      </span>
                    ) : null;
                  })}
                  {!r.channel_ids.length && <span className="meta">No channel</span>}
                </div>
                <span className="meta hide-md" style={{ width: 120, textAlign: "right" }}>
                  {PER_EVENT.includes(r.type) ? RULES[r.type].when : `Cooldown ${r.cooldown_min} min`}
                </span>
                {canAdmin && (
                  <Menu
                    align="end"
                    trigger={({ toggle, open, id }) => (
                      <button className="btn btn-icon btn-sm hit" aria-label="Rule actions" aria-expanded={open} aria-controls={id} onClick={toggle}>
                        <Icon name="more" />
                      </button>
                    )}
                  >
                    {(close) => (
                      <>
                        <button className="menu-item" onClick={() => (close(), setEditing(r))}>
                          Edit
                        </button>
                        <button className="menu-item" style={{ color: "var(--crit-ink)" }} onClick={() => (close(), void remove(r))}>
                          Delete
                        </button>
                      </>
                    )}
                  </Menu>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
      {editing && <RuleDialog rule={editing === "new" ? null : editing} channels={chs} onClose={() => setEditing(null)} />}
    </div>
  );
}

function RuleDialog({ rule, channels, onClose }: { rule: AlertRule | null; channels: AlertChannel[]; onClose: () => void }) {
  const { project, env: curEnv } = useProject();
  const [type, setType] = useState<RuleType | null>(rule?.type ?? null);
  const [params, setParams] = useState<Record<string, unknown>>(rule?.params ?? {});
  const [env, setEnv] = useState<Env>(rule?.env ?? curEnv);
  const [chIds, setChIds] = useState<string[]>(rule?.channel_ids ?? channels.slice(0, 1).map((c) => c.id));
  const [cooldown, setCooldown] = useState(rule?.cooldown_min ?? 30);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const choose = (t: RuleType) => {
    setType(t);
    setParams({ ...PARAMS[t].defaults });
    if (t === "no_traffic") setEnv("live");
  };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!type) return;
    const clean: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(params)) if (v !== "" && v !== undefined && v !== null && !(Array.isArray(v) && !v.length)) clean[k] = v;
    setBusy(true);
    setErr("");
    const body = { type, env, params: clean, channel_ids: chIds, cooldown_min: cooldown, enabled: rule?.enabled ?? true };
    try {
      if (rule) await api(`/api/projects/${project.id}/rules/${rule.id}`, { method: "PATCH", body });
      else await api(`/api/projects/${project.id}/rules`, { method: "POST", body });
      invalidate(`/api/projects/${project.id}/rules`);
      toast(rule ? "Rule saved" : "Rule created", { sub: `${RULES[type].title}: ${summary({ type, params: clean })}` });
      onClose();
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  if (!type)
    return (
      <Dialog open onClose={onClose} title="New alert rule" description="Pick what to watch. Every rule comes with defaults that work for most shops." wide>
        <div className="cells" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))" }}>
          {(Object.keys(RULES) as RuleType[]).map((t) => (
            <button key={t} type="button" className="tile" style={{ textAlign: "left", border: 0, borderInlineEnd: "1px solid var(--line)", borderBlockEnd: "1px solid var(--line)", background: "transparent", cursor: "pointer" }} onClick={() => choose(t)}>
              <span className="ink" style={{ fontWeight: 450 }}>
                {RULES[t].title}
              </span>
              <span className="hint">{RULES[t].blurb}</span>
            </button>
          ))}
        </div>
      </Dialog>
    );

  const spec = PARAMS[type];
  const num = (k: string) => (params[k] === undefined || params[k] === null ? "" : String(params[k]));
  return (
    <Dialog open onClose={onClose} title={rule ? `Edit ${RULES[type].title}` : RULES[type].title} description={RULES[type].blurb}>
      <form className="stack" onSubmit={save}>
        {spec.fields.map((f) => (
          <div key={f.key} className="field">
            <span className="label">{f.label}</span>
            {f.kind === "number" && (
              <div className="row">
                <input className="input num" style={{ width: 120 }} type="number" min={f.min} required value={num(f.key)} onChange={(e) => setParams({ ...params, [f.key]: e.target.value === "" ? "" : Number(e.target.value) })} aria-label={f.label} />
                {f.unit && <span className="muted">{f.unit}</span>}
              </div>
            )}
            {f.kind === "rupees" && (
              <div className="row">
                <span className="muted">Rs</span>
                <input
                  className="input num"
                  style={{ width: 160 }}
                  inputMode="decimal"
                  placeholder="5,000"
                  defaultValue={params[f.key] ? String(Number(params[f.key]) / 100) : ""}
                  onChange={(e) => setParams({ ...params, [f.key]: parseRupees(e.target.value) ?? "" })}
                  aria-label={f.label}
                />
              </div>
            )}
            {f.kind === "gateway" && (
              <Select style={{ width: 200 }} value={String(params[f.key] ?? "")} onChange={(v) => setParams({ ...params, [f.key]: v || undefined })} aria-label={f.label} options={[{ value: "", label: "Any gateway" }, { value: "esewa", label: "eSewa" }, { value: "khalti", label: "Khalti" }, { value: "fonepay", label: "Fonepay" }]} />
            )}
            {f.kind === "gateways" && (
              <div className="row wrap" style={{ gap: 16 }}>
                {["esewa", "khalti", "fonepay"].map((g) => {
                  const cur = (params[f.key] as string[] | undefined) ?? [];
                  return (
                    <label key={g} className="check">
                      <input type="checkbox" checked={cur.includes(g)} onChange={(e) => setParams({ ...params, [f.key]: e.target.checked ? [...cur, g] : cur.filter((x) => x !== g) })} />
                      {gatewayName(g)}
                    </label>
                  );
                })}
              </div>
            )}
            {f.hint && <span className="hint">{f.hint}</span>}
          </div>
        ))}
        {RULE_NOTES[type] && (
          <div className="note">
            <Icon name="info" />
            <span>{RULE_NOTES[type]}</span>
          </div>
        )}
        {!spec.fields.length && (
          <div className="note">
            <Icon name="info" />
            <span>No settings. It fires for every occurrence, one incident per payment, at most one message per channel per minute.</span>
          </div>
        )}
        <hr className="divider" />
        <div className="field">
          <span className="label">Environment</span>
          <Seg label="Environment" value={env} onChange={(v) => type !== "no_traffic" && setEnv(v)} options={[{ value: "test", label: "Test" }, { value: "live", label: "Live" }]} />
          {type === "no_traffic" && <span className="hint">No traffic only runs on live.</span>}
        </div>
        <div className="field">
          <span className="label">Send to</span>
          {channels.length ? (
            <div className="row wrap" style={{ gap: 16 }}>
              {channels.map((c) => (
                <label key={c.id} className="check">
                  <input type="checkbox" checked={chIds.includes(c.id)} onChange={(e) => setChIds(e.target.checked ? [...chIds, c.id] : chIds.filter((x) => x !== c.id))} />
                  <Icon name={CH_ICON[c.type]} size={14} />
                  {c.name}
                </label>
              ))}
            </div>
          ) : (
            <span className="hint">No channels yet. Add one under Channels; the rule still records incidents without one.</span>
          )}
        </div>
        {!PER_EVENT.includes(type) && (
          <div className="field">
            <span className="label">Notify again after</span>
            <div className="row">
              <input className="input num" style={{ width: 120 }} type="number" min={0} value={cooldown} onChange={(e) => setCooldown(Number(e.target.value))} aria-label="Cooldown in minutes" />
              <span className="muted">min, if the summary changed</span>
            </div>
          </div>
        )}
        {err && <p className="err">{err}</p>}
        <div className="actions" style={{ justifyContent: "space-between" }}>
          {!rule ? (
            <button type="button" className="btn btn-ghost" onClick={() => setType(null)}>
              <Icon name="chevronLeft" size={14} />
              Other rule types
            </button>
          ) : (
            <span />
          )}
          <div className="actions">
            <button type="button" className="btn btn-secondary" onClick={onClose}>
              Cancel
            </button>
            <button className="btn btn-primary" disabled={busy}>
              {busy && <span className="spinner" />}
              {rule ? "Save rule" : "Create rule"}
            </button>
          </div>
        </div>
      </form>
    </Dialog>
  );
}

// ------------------------------------------------------------------ channels
function channelDetail(c: AlertChannel): string {
  const cfg = c.config as Record<string, unknown>;
  if (c.type === "email") return ((cfg.to as string[]) ?? []).join(", ");
  return String(cfg.webhook_url ?? cfg.url ?? "");
}

function Channels() {
  const { project, canAdmin } = useProject();
  const key = `/api/projects/${project.id}/channels`;
  const q = useQuery<Page<AlertChannel>>(key);
  const [adding, setAdding] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const list = items(q.data);

  const test = async (c: AlertChannel) => {
    setTesting(c.id);
    try {
      await api(`${key}/${c.id}/test`, { method: "POST" });
      toast(`Test sent to ${c.name}`, { sub: c.type === "email" ? "Check the inbox in a minute." : "It should be there now." });
    } catch (e) {
      toast(`Could not reach ${c.name}`, { kind: "error", sub: errorMessage(e) });
    } finally {
      setTesting(null);
    }
  };
  const remove = async (c: AlertChannel) => {
    if (!(await confirmAction({ title: `Delete ${c.name}?`, body: "Rules that send to it stop sending there.", action: "Delete channel", danger: true }))) return;
    await api(`${key}/${c.id}`, { method: "DELETE" }).catch((e) => toast("Could not delete", { kind: "error", sub: errorMessage(e) }));
    invalidate(key);
    invalidate(`/api/projects/${project.id}/rules`);
  };

  return (
    <div className="stack">
      <div className="row between wrap">
        <p className="muted">Email, Slack, Discord, or a signed webhook to anything else.</p>
        {canAdmin && (
          <button className="btn btn-primary" onClick={() => setAdding(true)}>
            <Icon name="plus" />
            Add channel
          </button>
        )}
      </div>
      <div className="card">
        {!q.data ? (
          <div className="card-body">
            <Skeleton />
          </div>
        ) : !list.length ? (
          <EmptySmall icon="send" title="No channels">
            Incidents are still recorded. Add a channel to hear about them.
          </EmptySmall>
        ) : (
          <div className="list">
            {list.map((c) => (
              <div key={c.id} className="list-row" style={{ minHeight: 60 }}>
                <span className="avatar sq-tone" aria-hidden="true">
                  <Icon name={CH_ICON[c.type]} size={14} />
                </span>
                <div className="grow">
                  <div className="row" style={{ gap: 8 }}>
                    <span className="ink" style={{ fontWeight: 450 }}>
                      {c.name}
                    </span>
                    <span className="tag">{c.type}</span>
                  </div>
                  <div className="meta truncate mono" style={{ fontSize: 11.5 }}>
                    {channelDetail(c)}
                  </div>
                </div>
                <button className="btn btn-secondary btn-sm" onClick={() => void test(c)} disabled={testing === c.id}>
                  {testing === c.id ? <span className="spinner" /> : <Icon name="send" size={14} />}
                  Send test
                </button>
                {canAdmin && (
                  <button className="btn btn-icon btn-sm hit" aria-label={`Delete ${c.name}`} onClick={() => void remove(c)}>
                    <Icon name="trash" />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
      {adding && <ChannelDialog onClose={() => setAdding(false)} />}
    </div>
  );
}

function ChannelDialog({ onClose }: { onClose: () => void }) {
  const { project } = useProject();
  const [type, setType] = useState<ChannelType>("email");
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [secret] = useState(() => `whsec_${Array.from(crypto.getRandomValues(new Uint8Array(18)), (b) => b.toString(16).padStart(2, "0")).join("")}`);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const placeholder: Record<ChannelType, string> = {
    email: "owner@shop.com.np, ops@shop.com.np",
    slack: "https://hooks.slack.com/services/...",
    discord: "https://discord.com/api/webhooks/...",
    webhook: "https://example.com/hooks/paynp",
  };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    let config: Record<string, unknown>;
    if (type === "email") {
      const to = value.split(/[,\s]+/).filter(Boolean);
      if (!to.length || to.some((x) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x))) return setErr("Enter one or more email addresses, separated by commas");
      config = { to };
    } else {
      if (!/^https:\/\//.test(value.trim())) return setErr("The URL must start with https://");
      config = type === "webhook" ? { url: value.trim(), secret } : { webhook_url: value.trim() };
    }
    setBusy(true);
    try {
      await api(`/api/projects/${project.id}/channels`, { method: "POST", body: { type, name: name.trim() || defaultName(type, value), config } });
      invalidate(`/api/projects/${project.id}/channels`);
      toast("Channel added", { sub: "Send a test to check it." });
      onClose();
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onClose={onClose} title="Add channel" description="Where incidents and resolutions are sent.">
      <form className="stack" onSubmit={save}>
        <Seg
          label="Channel type"
          value={type}
          onChange={(t) => (setType(t), setErr(""))}
          options={[
            { value: "email", label: "Email" },
            { value: "slack", label: "Slack" },
            { value: "discord", label: "Discord" },
            { value: "webhook", label: "Webhook" },
          ]}
        />
        <label className="field">
          <span className="label">{type === "email" ? "Recipients" : type === "webhook" ? "Endpoint URL" : "Incoming webhook URL"}</span>
          <input className="input" autoFocus value={value} onChange={(e) => setValue(e.target.value)} placeholder={placeholder[type]} spellCheck={false} />
        </label>
        <label className="field">
          <span className="label">Name</span>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={type === "email" ? "Owners" : type === "webhook" ? "Ops pager" : "#payments"} />
        </label>
        {type === "webhook" && (
          <Field label="Signing secret" hint={<>Requests carry X-Paynp-Signature: sha256=HMAC of the body with this secret. Copy it now; it is shown once.</>}>
            <div className="secret">
              <span style={{ flex: 1 }}>{secret}</span>
            </div>
          </Field>
        )}
        {err && <p className="err">{err}</p>}
        <div className="actions" style={{ justifyContent: "flex-end" }}>
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={busy}>
            {busy && <span className="spinner" />}
            Add channel
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function defaultName(t: ChannelType, v: string) {
  if (t === "email") return v.split(/[,\s]+/)[0] ?? "Email";
  return t === "slack" ? "Slack" : t === "discord" ? "Discord" : "Webhook";
}

function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="field">
      <span className="label">{label}</span>
      {children}
      {hint && <span className="hint">{hint}</span>}
    </div>
  );
}

// ------------------------------------------------------------------ incidents
function Incidents() {
  const { project } = useProject();
  const [state, setState] = useState<"" | "firing" | "resolved">("");
  const q = useQuery<Page<Incident>>(`/api/projects/${project.id}/incidents${qs({ state })}`, { refreshMs: 60_000 });
  const rules = useQuery<Page<AlertRule>>(`/api/projects/${project.id}/rules`);
  const now = useNow();
  const list = items(q.data);
  const rule = (id: string) => items(rules.data).find((r) => r.id === id);
  const [params] = useSearchParams();
  const focus = params.get("incident");
  return (
    <div className="stack">
      <div className="row between wrap">
        <Seg label="State" value={state} onChange={setState} options={[{ value: "", label: "All" }, { value: "firing", label: "Firing" }, { value: "resolved", label: "Resolved" }]} />
      </div>
      <div className="table-wrap">
        <table className="t">
          <thead>
            <tr>
              <th style={{ width: 110 }}>State</th>
              <th>Summary</th>
              <th className="hide-md">Rule</th>
              <th className="hide-sm">Opened</th>
              <th className="r hide-sm">Lasted</th>
            </tr>
          </thead>
          <tbody>
            {list.map((i) => {
              const r = rule(i.rule_id);
              const x = i as Incident & IncidentExtra;
              const type = (x.rule_type ?? r?.type) as RuleType | undefined;
              return (
                <tr key={i.id} style={focus === i.id ? { background: "var(--tone-sky)" } : undefined} ref={focus === i.id ? (el) => el?.scrollIntoView({ block: "center" }) : undefined}>
                  <td>
                    <StatusPill status={i.state} />
                  </td>
                  <td style={{ whiteSpace: "normal", paddingBlock: 10, minWidth: 260 }}>
                    <div className="ink">{i.summary}</div>
                    {x.attempt_id && (
                      <Link className="inline-link" style={{ fontSize: 12.5 }} to={`/p/${project.id}/${x.env ?? "live"}/payments/${encodeURIComponent(x.attempt_id)}`}>
                        Open the payment
                      </Link>
                    )}
                    <div className="hint show-sm">
                      <Time t={i.opened_at}>{formatRelative(i.opened_at, now)}</Time>
                    </div>
                  </td>
                  <td className="hide-md muted">{type && RULES[type] ? RULES[type].title : i.rule_id}</td>
                  <td className="hide-sm">
                    <Time t={i.opened_at}>{formatRelative(i.opened_at, now)}</Time>
                  </td>
                  <td className="r hide-sm num muted">{i.resolved_at ? formatDuration(i.resolved_at - i.opened_at) : <span className="ink">{formatDuration(now - i.opened_at)}, ongoing</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {q.data && !list.length && (
          <EmptySmall icon="check" title={state === "firing" ? "Nothing is firing" : "No incidents yet"}>
            When a rule triggers, its incident shows up here with when it opened and resolved.
          </EmptySmall>
        )}
        {!q.data && (
          <div className="card-body">
            <Skeleton />
          </div>
        )}
      </div>
    </div>
  );
}

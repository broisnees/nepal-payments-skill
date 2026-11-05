import type { ApiKey, CreatedKey, Env, Page, Project, Role, Session } from "@paynp/shared";
import { useState, type FormEvent } from "react";
import { NavLink, useNavigate, useParams } from "react-router";
import { Icon, type IconName } from "../components/Icon.tsx";
import { useMe, useProject } from "../components/Shell.tsx";
import { CodeBlock, Command, CopyButton, Dialog, EmptySmall, Seg, Skeleton, Switch, Time, confirmAction, toast, useNow } from "../components/ui.tsx";
import { api, errorMessage, items } from "../lib/api.ts";
import { formatDateTime, formatFull, formatRelative } from "../lib/format.ts";
import { invalidate, setData, useQuery } from "../lib/query.ts";
import type { Invite, Member, MeUser, Pat } from "../lib/types.ts";
import { deviceName } from "../lib/ua.ts";

const SECTIONS: [string, string, IconName][] = [
  ["general", "Project", "settings"],
  ["account", "Account", "mail"],
  ["keys", "API keys", "key"],
  ["members", "Members", "users"],
  ["sessions", "Sessions", "laptop"],
  ["tokens", "CLI tokens", "terminal"],
];

export default function Settings() {
  const { section = "general" } = useParams();
  const { base } = useProject();
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Settings</h1>
        </div>
      </div>
      <div className="settings">
        <nav className="subnav" aria-label="Settings">
          {SECTIONS.map(([k, l, i]) => (
            <NavLink key={k} to={`${base}/settings/${k}`}>
              <Icon name={i} />
              {l}
            </NavLink>
          ))}
        </nav>
        <div>
          {section === "keys" ? <Keys /> : section === "members" ? <Members /> : section === "sessions" ? <Sessions /> : section === "tokens" ? <Tokens /> : section === "account" ? <Account /> : <General />}
        </div>
      </div>
    </>
  );
}

function Head({ title, children, action }: { title: string; children?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="set-head">
      <div>
        <h2 style={{ fontSize: 16 }}>{title}</h2>
        {children && <p>{children}</p>}
      </div>
      {action}
    </div>
  );
}

// ------------------------------------------------------------------ general
function General() {
  const { project, org, canAdmin } = useProject();
  const nav = useNavigate();
  const [name, setName] = useState(project.name);
  const [busy, setBusy] = useState(false);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim() || name.trim() === project.name) return;
    setBusy(true);
    try {
      const p = await api<Project>(`/api/projects/${project.id}`, { method: "PATCH", body: { name: name.trim() } });
      setData<Project>(`/api/projects/${project.id}`, () => p);
      invalidate(`/api/orgs/${org.id}/projects`);
      toast("Project renamed");
    } catch (e) {
      toast("Could not rename", { kind: "error", sub: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };
  const del = async () => {
    const ok = await confirmAction({
      title: `Delete ${project.name}?`,
      body: "Its keys stop working at once, and every payment, event, rule and incident in both environments is deleted. This cannot be undone.",
      action: "Delete project",
      danger: true,
    });
    if (!ok) return;
    try {
      await api(`/api/projects/${project.id}`, { method: "DELETE" });
      try {
        localStorage.removeItem("paynp-last");
      } catch {
        /* ignore */
      }
      invalidate(`/api/orgs/${org.id}/projects`);
      nav("/");
    } catch (e) {
      toast("Could not delete the project", { kind: "error", sub: errorMessage(e) });
    }
  };
  return (
    <>
      <section className="set-section">
        <Head title="Project">One app or site. Test and live data stay separate.</Head>
        <form className="card" onSubmit={save}>
          <div className="card-body stack">
            <label className="field" style={{ maxWidth: 420 }}>
              <span className="label">Name</span>
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} disabled={!canAdmin} maxLength={60} />
            </label>
            <div className="field">
              <span className="label">Project id</span>
              <div className="row" style={{ gap: 4 }}>
                <code>{project.id}</code>
                <CopyButton text={project.id} label="Copy project id" />
              </div>
              <span className="hint">
                Created {formatDateTime(project.created_at)} in {org.name}. The CLI stores it in .paynp/project.json.
              </span>
            </div>
          </div>
          {canAdmin && (
            <div className="card-foot row between">
              <span className="hint">Shown in the switcher and in alert messages.</span>
              <button className="btn btn-primary btn-sm" disabled={busy || !name.trim() || name.trim() === project.name}>
                Save
              </button>
            </div>
          )}
        </form>
      </section>
      {org.role === "owner" && (
        <section className="set-section">
          <Head title="Delete project" />
          <div className="card tone-rose">
            <div className="card-body row between wrap" style={{ gap: 16 }}>
              <p style={{ maxWidth: 520 }}>Deletes the project, both environments, all keys and all history. Payments themselves are untouched; they never went through paynp.</p>
              <button className="btn btn-danger" onClick={del}>
                Delete project
              </button>
            </div>
          </div>
        </section>
      )}
    </>
  );
}

// ------------------------------------------------------------------ account
function Account() {
  const me = useMe();
  const user = me.user as MeUser;
  const [name, setName] = useState(user.name ?? "");
  const [digest, setDigest] = useState(user.digest ?? true);
  const patch = async (body: { name?: string; digest?: boolean }, done: string) => {
    try {
      await api("/api/me", { method: "PATCH", body });
      invalidate("/api/me");
      toast(done);
    } catch (e) {
      toast("Could not save", { kind: "error", sub: errorMessage(e) });
    }
  };
  return (
    <>
      <section className="set-section">
        <Head title="Account">Signed in as {user.email}.</Head>
        <form
          className="card"
          onSubmit={(e) => {
            e.preventDefault();
            void patch({ name: name.trim() }, "Name saved");
          }}
        >
          <div className="card-body">
            <label className="field" style={{ maxWidth: 420 }}>
              <span className="label">Name</span>
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} placeholder="Shown to the rest of the organization" />
            </label>
          </div>
          <div className="card-foot row between">
            <span className="hint">Email is the sign-in identity and cannot be changed here.</span>
            <button className="btn btn-primary btn-sm" disabled={name.trim() === (user.name ?? "")}>
              Save
            </button>
          </div>
        </form>
      </section>
      <section className="set-section">
        <Head title="Daily digest" />
        <div className="card">
          <div className="card-body row between" style={{ gap: 16 }}>
            <div>
              <div className="ink">Email me a summary at 09:00 Nepal time</div>
              <p className="hint">Yesterday's volume, success rate, revenue, top failure reasons and open incidents. Sent to owners and admins.</p>
            </div>
            <Switch
              checked={digest}
              label="Daily digest"
              onChange={(v) => {
                setDigest(v);
                void patch({ digest: v }, v ? "Digest on" : "Digest off");
              }}
            />
          </div>
        </div>
      </section>
    </>
  );
}

// ------------------------------------------------------------------ keys
function Keys() {
  const { project, env, canAdmin } = useProject();
  const key = `/api/projects/${project.id}/keys`;
  const q = useQuery<Page<ApiKey>>(key);
  const [creating, setCreating] = useState(false);
  const now = useNow();
  const list = items(q.data);
  const active = list.filter((k) => !k.revoked_at);
  const revoked = list.filter((k) => k.revoked_at);

  const revoke = async (k: ApiKey) => {
    const ok = await confirmAction({
      title: `Revoke ${k.name ?? k.prefix}?`,
      body: "Servers using it get 401 on their next batch and their events are dropped. Payments keep working; the SDK never blocks a checkout.",
      action: "Revoke key",
      danger: true,
    });
    if (!ok) return;
    try {
      await api(`${key}/${k.id}`, { method: "DELETE" });
      invalidate(key);
      toast("Key revoked", { sub: k.prefix });
    } catch (e) {
      toast("Could not revoke", { kind: "error", sub: errorMessage(e) });
    }
  };

  return (
    <section className="set-section">
      <Head
        title="API keys"
        action={
          canAdmin && (
            <button className="btn btn-primary" onClick={() => setCreating(true)}>
              <Icon name="plus" />
              Create key
            </button>
          )
        }
      >
        Server-side only. The prefix sets the environment: pnp_test_ or pnp_live_.
      </Head>
      <div className="table-wrap">
        <table className="t">
          <thead>
            <tr>
              <th>Name</th>
              <th>Key</th>
              <th className="hide-sm">Created</th>
              <th className="hide-sm">Last used</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {!q.data ? (
              <tr>
                <td colSpan={5}>
                  <Skeleton />
                </td>
              </tr>
            ) : (
              [...active, ...revoked].map((k) => (
                <tr key={k.id} style={k.revoked_at ? { opacity: 0.55 } : undefined}>
                  <td>
                    <div className="row" style={{ gap: 8 }}>
                      <span className="ink">{k.name ?? "Unnamed"}</span>
                      <span className={`tag ${k.env === "live" ? "tag-live" : "tag-test"}`}>{k.env}</span>
                    </div>
                  </td>
                  <td>
                    <code>{k.prefix}</code>
                    <span className="subtle mono">****</span>
                  </td>
                  <td className="hide-sm muted">
                    <Time t={k.created_at}>{formatDateTime(k.created_at, now)}</Time>
                  </td>
                  <td className="hide-sm muted">{k.revoked_at ? <span>Revoked {formatRelative(k.revoked_at, now)}</span> : k.last_used_at ? <Time t={k.last_used_at}>{formatRelative(k.last_used_at, now)}</Time> : "Never"}</td>
                  <td className="r">
                    {!k.revoked_at && canAdmin && (
                      <button className="btn btn-danger btn-sm" onClick={() => void revoke(k)}>
                        Revoke
                      </button>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
        {q.data && !list.length && (
          <EmptySmall icon="key" title="No keys yet">
            Create one here, or run <code>npx paynp init</code> in the app and the CLI creates a test key.
          </EmptySmall>
        )}
      </div>
      <div className="note">
        <Icon name="lock" />
        <span>Keys are stored as SHA-256 hashes. A key is shown in full once, when created; a lost key is revoked and replaced.</span>
      </div>
      {creating && <CreateKeyDialog defaultEnv={env} onClose={() => setCreating(false)} />}
    </section>
  );
}

function CreateKeyDialog({ defaultEnv, onClose }: { defaultEnv: Env; onClose: () => void }) {
  const { project } = useProject();
  const [env, setEnv] = useState<Env>(defaultEnv);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [created, setCreated] = useState<CreatedKey | null>(null);
  const endpoint = location.origin.includes("localhost") ? "http://localhost:8787" : null;

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr("");
    try {
      const k = await api<CreatedKey>(`/api/projects/${project.id}/keys`, { method: "POST", body: { env, name: name.trim() || null } });
      setCreated(k);
      invalidate(`/api/projects/${project.id}/keys`);
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  if (created) {
    const dotenv = `PAYNP_KEY=${created.key}${endpoint ? `\nPAYNP_ENDPOINT=${endpoint}` : ""}`;
    return (
      <Dialog
        open
        onClose={onClose}
        title="Copy the key now"
        description="This is the only time the full key is shown."
        wide
        footer={
          <button className="btn btn-primary" onClick={onClose}>
            I have stored it
          </button>
        }
      >
        <div className="reveal">
          <div className="secret">
            <span style={{ flex: 1 }}>{created.key}</span>
            <CopyButton text={created.key} label="Copy key" />
          </div>
          <div className="field">
            <span className="label">1. Add it to the server's .env</span>
            <CodeBlock code={dotenv} />
          </div>
          <div className="field">
            <span className="label">2. Wrap the gateway module</span>
            <CodeBlock
              code={`import { createPaynp } from "@paynp/sdk";\n\nconst paynp = createPaynp({ key: process.env.PAYNP_KEY });\nconst esewa = paynp.wrapGateway("esewa", esewaModule);`}
            />
          </div>
          <div className="field">
            <span className="label">Or let the CLI do both</span>
            <Command cmd="npx paynp init" />
          </div>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog open onClose={onClose} title="Create API key" description="For one server or deployment. Name it after where it runs.">
      <form className="stack" onSubmit={create}>
        <div className="field">
          <span className="label">Environment</span>
          <Seg label="Environment" value={env} onChange={setEnv} options={[{ value: "test", label: "Test" }, { value: "live", label: "Live" }]} />
          <span className="hint">{env === "live" ? "Live keys send real payments to the live view and to live alert rules." : "Test keys keep sandbox payments out of live numbers."}</span>
        </div>
        <label className="field">
          <span className="label">Name</span>
          <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={env === "live" ? "Production server" : "Local dev"} maxLength={60} />
        </label>
        {err && <p className="err">{err}</p>}
        <div className="actions" style={{ justifyContent: "flex-end" }}>
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={busy}>
            {busy && <span className="spinner" />}
            Create {env} key
          </button>
        </div>
      </form>
    </Dialog>
  );
}

// ------------------------------------------------------------------ members
function Members() {
  const { org } = useProject();
  const me = useMe();
  const admin = org.role !== "viewer";
  // Both lists need admin; viewers see who they are and a note.
  const key = `/api/orgs/${org.id}/members`;
  const q = useQuery<Page<Member>>(admin ? key : null);
  const inv = useQuery<Page<Invite>>(admin ? `/api/orgs/${org.id}/invites` : null);
  const refresh = () => {
    invalidate(key);
    invalidate(`/api/orgs/${org.id}/invites`);
  };
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("viewer");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const now = useNow();

  const invite = async (e: FormEvent) => {
    e.preventDefault();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) return setErr("Enter a valid email address");
    setBusy(true);
    setErr("");
    try {
      await api(`/api/orgs/${org.id}/invites`, { method: "POST", body: { email: email.trim(), role } });
      toast("Invite sent", { sub: email.trim() });
      setEmail("");
      refresh();
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const changeRole = async (userId: string, r: Role) => {
    try {
      await api(`${key}/${userId}`, { method: "PATCH", body: { role: r } });
      refresh();
      toast("Role updated");
    } catch (e) {
      toast("Could not change the role", { kind: "error", sub: errorMessage(e) });
      refresh();
    }
  };
  const remove = async (userId: string, label: string) => {
    const self = userId === me.user.id;
    const ok = await confirmAction({ title: self ? `Leave ${org.name}?` : `Remove ${label}?`, body: self ? "You lose access to its projects." : "They lose access to every project in the organization.", action: self ? "Leave" : "Remove", danger: true });
    if (!ok) return;
    try {
      await api(`${key}/${userId}`, { method: "DELETE" });
      refresh();
    } catch (e) {
      toast("Could not remove", { kind: "error", sub: errorMessage(e) });
    }
  };
  const revokeInvite = async (id: string) => {
    try {
      await api(`/api/orgs/${org.id}/invites/${id}`, { method: "DELETE" });
      refresh();
    } catch (e) {
      toast("Could not revoke the invite", { kind: "error", sub: errorMessage(e) });
    }
  };

  const members = items(q.data);
  const invites = items(inv.data);
  if (!admin)
    return (
      <section className="set-section">
        <Head title="Members">Everyone in {org.name}.</Head>
        <div className="card">
          <EmptySmall icon="users" title="Only admins see the member list">
            You are a viewer in {org.name}. Ask an owner or admin to change roles or invite people.
          </EmptySmall>
        </div>
      </section>
    );
  return (
    <section className="set-section">
      <Head title="Members">Everyone in {org.name}. Owners manage billing and can delete the organization; admins manage everything else; viewers read.</Head>
      {admin && (
        <form className="card" onSubmit={invite}>
          <div className="card-body row wrap" style={{ alignItems: "flex-end", gap: 8 }}>
            <label className="field" style={{ flex: "1 1 240px" }}>
              <span className="label">Invite by email</span>
              <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="colleague@company.com.np" />
            </label>
            <select className="select" style={{ width: 120 }} value={role} onChange={(e) => setRole(e.target.value as Role)} aria-label="Role">
              <option value="viewer">Viewer</option>
              <option value="admin">Admin</option>
              {org.role === "owner" && <option value="owner">Owner</option>}
            </select>
            <button className="btn btn-primary" disabled={busy}>
              {busy && <span className="spinner" />}
              Send invite
            </button>
          </div>
          {err && (
            <div className="card-foot">
              <span className="err">{err}</span>
            </div>
          )}
        </form>
      )}
      <div className="table-wrap">
        <table className="t">
          <thead>
            <tr>
              <th>Member</th>
              <th style={{ width: 140 }}>Role</th>
              <th className="hide-sm">Joined</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {q.initial && (
              <tr>
                <td colSpan={4}>
                  <Skeleton />
                </td>
              </tr>
            )}
            {members.map((m) => (
              <tr key={m.user_id}>
                <td>
                  <div className="row" style={{ gap: 10 }}>
                    <span className="avatar sq-tone" aria-hidden="true">
                      {(m.name ?? m.email).slice(0, 1)}
                    </span>
                    <div className="ids">
                      <span className="ink">
                        {m.name ?? m.email}
                        {m.user_id === me.user.id && <span className="subtle"> (you)</span>}
                      </span>
                      {m.name && (
                        <span className="muted" style={{ fontSize: 12 }}>
                          {m.email}
                        </span>
                      )}
                    </div>
                  </div>
                </td>
                <td>
                  {admin && m.user_id !== me.user.id && (org.role === "owner" || m.role !== "owner") ? (
                    <select className="select" style={{ height: 28, width: 112 }} value={m.role} onChange={(e) => void changeRole(m.user_id, e.target.value as Role)} aria-label={`Role of ${m.email}`}>
                      <option value="viewer">Viewer</option>
                      <option value="admin">Admin</option>
                      {org.role === "owner" && <option value="owner">Owner</option>}
                    </select>
                  ) : (
                    <span className="tag">{m.role}</span>
                  )}
                </td>
                <td className="hide-sm muted">
                  <Time t={m.created_at}>{formatDateTime(m.created_at, now)}</Time>
                </td>
                <td className="r">
                  {(admin || m.user_id === me.user.id) && m.role !== "owner" && (
                    <button className="btn btn-ghost btn-sm" onClick={() => void remove(m.user_id, m.name ?? m.email)}>
                      {m.user_id === me.user.id ? "Leave" : "Remove"}
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {invites.map((i) => (
              <tr key={i.id}>
                <td>
                  <div className="row" style={{ gap: 10 }}>
                    <span className="avatar" aria-hidden="true" style={{ background: "transparent", color: "var(--subtle)", outline: "1px dashed var(--line-strong)", outlineOffset: -1 }}>
                      <Icon name="mail" size={12} />
                    </span>
                    <div className="ids">
                      <span className="ink">{i.email}</span>
                      <span className="muted" style={{ fontSize: 12 }}>
                        Invited, expires {formatDateTime(i.expires_at, now)}
                      </span>
                    </div>
                  </div>
                </td>
                <td>
                  <span className="tag">{i.role}</span>
                </td>
                <td className="hide-sm muted">Pending</td>
                <td className="r">
                  {admin && (
                    <button className="btn btn-ghost btn-sm" onClick={() => void revokeInvite(i.id)}>
                      Revoke
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ------------------------------------------------------------------ sessions
function Sessions() {
  const q = useQuery<Page<Session>>("/api/sessions");
  const now = useNow();
  const list = items(q.data);
  const revoke = async (s: Session) => {
    if (s.current) {
      const ok = await confirmAction({ title: "Sign out of this browser?", action: "Sign out", danger: true });
      if (!ok) return;
    }
    try {
      await api(`/api/sessions/${s.id}`, { method: "DELETE" });
      if (s.current) location.href = "/signin";
      else {
        invalidate("/api/sessions");
        toast("Session revoked", { sub: "That device is signed out." });
      }
    } catch (e) {
      toast("Could not revoke", { kind: "error", sub: errorMessage(e) });
    }
  };
  return (
    <section className="set-section">
      <Head title="Sessions">Browsers signed in as you. Sessions last 30 days from the last visit.</Head>
      <div className="card">
        {!q.data ? (
          <div className="card-body">
            <Skeleton />
          </div>
        ) : (
          <div className="list">
            {list.map((s) => {
              const d = deviceName(s.user_agent);
              return (
                <div key={s.id} className="list-row" style={{ minHeight: 60 }}>
                  <span className="avatar sq-tone" aria-hidden="true">
                    <Icon name={d.mobile ? "phone" : "laptop"} size={14} />
                  </span>
                  <div className="grow">
                    <div className="row" style={{ gap: 8 }}>
                      <span className="ink">{d.label}</span>
                      {s.current && <span className="tag tag-live">This browser</span>}
                    </div>
                    <div className="meta">
                      {s.ip ?? "Unknown IP"}, signed in <Time t={s.created_at}>{formatDateTime(s.created_at, now)}</Time>
                    </div>
                  </div>
                  <span className="meta hide-sm" title={formatFull(s.last_seen_at)}>
                    {s.current ? "Active now" : `Active ${formatRelative(s.last_seen_at, now)}`}
                  </span>
                  <button className="btn btn-danger btn-sm" onClick={() => void revoke(s)}>
                    {s.current ? "Sign out" : "Revoke"}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}

// ------------------------------------------------------------------ CLI tokens
function Tokens() {
  const q = useQuery<Page<Pat>>("/api/pats");
  const now = useNow();
  const list = items(q.data);
  const revoke = async (p: Pat) => {
    const ok = await confirmAction({ title: `Revoke ${p.name ?? "this token"}?`, body: "The CLI on that machine is signed out and needs paynp login again.", action: "Revoke token", danger: true });
    if (!ok) return;
    try {
      await api(`/api/pats/${p.id}`, { method: "DELETE" });
      invalidate("/api/pats");
      toast("Token revoked");
    } catch (e) {
      toast("Could not revoke", { kind: "error", sub: errorMessage(e) });
    }
  };
  return (
    <section className="set-section">
      <Head title="CLI tokens">Created when the CLI signs in through this browser. Each machine gets its own.</Head>
      <div className="card">
        {!q.data ? (
          <div className="card-body">
            <Skeleton />
          </div>
        ) : !list.length ? (
          <EmptySmall icon="terminal" title="No CLI signed in">
            Run the command below; it opens this browser to approve.
          </EmptySmall>
        ) : (
          <div className="list">
            {list.map((p) => (
              <div key={p.id} className="list-row" style={{ minHeight: 60 }}>
                <span className="avatar sq-tone" aria-hidden="true">
                  <Icon name="terminal" size={14} />
                </span>
                <div className="grow">
                  <div className="ink truncate">{p.name ?? "paynp CLI"}</div>
                  <div className="meta">
                    Created <Time t={p.created_at}>{formatDateTime(p.created_at, now)}</Time>, last used {p.last_used_at ? formatRelative(p.last_used_at, now) : "never"}
                  </div>
                </div>
                <button className="btn btn-danger btn-sm" onClick={() => void revoke(p)}>
                  Revoke
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
      <div style={{ maxWidth: 360 }}>
        <Command cmd="npx paynp login" />
      </div>
    </section>
  );
}

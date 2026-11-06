import type { Env, Incident, Me, Page, Project, RefundCase } from "@paynp/shared";
import { createContext, useContext, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link, Navigate, NavLink, Outlet, useLocation, useNavigate, useParams } from "react-router";
import { ApiFailure, api, errorMessage, items, onUnauthorized } from "../lib/api.ts";
import { invalidate, useQuery } from "../lib/query.ts";
import { setChoice, useTheme } from "../lib/theme.ts";
import { AskPanel } from "./AskPanel.tsx";
import { Icon, Logo } from "./Icon.tsx";
import { Dialog, Menu, Seg, toast } from "./ui.tsx";

// ------------------------------------------------------------------ auth
const MeCtx = createContext<Me | null>(null);
export const useMe = () => useContext(MeCtx)!;
/** True on the `paynp dev` server: no accounts, one project, no alerts, keys, members or sessions. */
export const useLocal = () => useContext(MeCtx)?.mode === "local";
/** The project `paynp dev` serves. */
export const LOCAL_PROJECT = "local";

/**
 * Gate for signed-in pages. With `fallback`, a signed-out visitor sees it in place of being sent to /signin
 * (the landing page at "/").
 */
export function RequireAuth({ fallback }: { fallback?: ReactNode } = {}) {
  const loc = useLocation();
  const nav = useNavigate();
  const me = useQuery<Me>("/api/me", { staleMs: 5 * 60_000 });
  const next = loc.pathname + loc.search;

  // Read in render (pure), cleared once the browser has left "/".
  useEffect(() => {
    if (loc.pathname !== "/") clearNext();
  }, [loc.pathname]);
  useEffect(() => (fallback ? undefined : onUnauthorized(() => nav(`/signin?next=${encodeURIComponent(location.pathname + location.search)}`, { replace: true }))), [nav, fallback]);

  if (me.error instanceof ApiFailure && me.error.status === 401) return fallback ? <>{fallback}</> : <Navigate to={`/signin?next=${encodeURIComponent(next)}`} replace />;
  // The magic link always lands on "/"; the page the visitor wanted was saved before signing in.
  const saved = loc.pathname === "/" && me.data ? peekNext() : null;
  if (saved) return <Navigate to={saved} replace />;
  // The landing page does not need the API, so a public "/" still renders when it cannot be reached.
  if (me.error && !me.data && fallback) return <>{fallback}</>;
  if (me.error && !me.data) return <BootError onRetry={me.refresh} />;
  if (!me.data) return <Boot />;
  return (
    <MeCtx.Provider value={me.data}>
      <Outlet />
    </MeCtx.Provider>
  );
}

export function Boot() {
  return (
    <div className="boot" aria-busy="true">
      <Logo size={24} />
    </div>
  );
}

function BootError({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="boot">
      <div className="stack" style={{ justifyItems: "center", textAlign: "center" }}>
        <Logo size={24} />
        <p className="muted">Could not reach the API.</p>
        <button className="btn btn-secondary" onClick={onRetry}>
          Try again
        </button>
      </div>
    </div>
  );
}

const NEXT = "paynp-next";
/** Remember where to go after the magic link, which always redirects to "/". */
export function saveNext(path: string | null) {
  try {
    if (path && path.startsWith("/") && !path.startsWith("//") && path !== "/") sessionStorage.setItem(NEXT, path);
  } catch {
    /* fine without it */
  }
}
function peekNext(): string | null {
  try {
    return sessionStorage.getItem(NEXT);
  } catch {
    return null;
  }
}
function clearNext() {
  try {
    sessionStorage.removeItem(NEXT);
  } catch {
    /* ignore */
  }
}

/** Links in alert emails: /projects/:id/alerts?incident=, /projects/:id/payments/:attempt?env= */
export function ProjectLink() {
  const { project = "", "*": rest = "" } = useParams();
  const loc = useLocation();
  const q = new URLSearchParams(loc.search);
  const env: Env = q.get("env") === "test" ? "test" : q.get("env") === "live" ? "live" : (lastProject()?.project === project ? lastProject()!.env : "live");
  const parts = rest.split("/").filter(Boolean);
  let to = `/p/${project}/${env}/overview`;
  if (parts[0] === "payments" && parts[1]) to = `/p/${project}/${env}/payments/${encodeURIComponent(parts[1])}`;
  else if (parts[0] === "payments") to = `/p/${project}/${env}/payments`;
  else if (parts[0] === "alerts") to = `/p/${project}/${env}/alerts/incidents${q.get("incident") ? `?incident=${encodeURIComponent(q.get("incident")!)}` : ""}`;
  else if (parts[0]) to = `/p/${project}/${env}/${parts.join("/")}`;
  return <Navigate to={to} replace />;
}

const LAST = "paynp-last";
export function rememberProject(project: string, env: Env) {
  try {
    localStorage.setItem(LAST, JSON.stringify({ project, env }));
  } catch {
    /* not important */
  }
}
export function lastProject(): { project: string; env: Env } | null {
  try {
    return JSON.parse(localStorage.getItem(LAST) ?? "null");
  } catch {
    return null;
  }
}

/** "/" sends the browser to the last project it looked at, else the first project of the first org. */
export function Home() {
  const me = useMe();
  const last = lastProject();
  const org = me.orgs[0];
  const local = me.mode === "local";
  const projects = useQuery<Page<Project>>(org && !local ? `/api/orgs/${org.id}/projects` : null);
  if (local) return <Navigate to={`/p/${LOCAL_PROJECT}/${last?.project === LOCAL_PROJECT ? last.env : "test"}/overview`} replace />;
  if (last) return <Navigate to={`/p/${last.project}/${last.env}/overview`} replace />;
  if (!org) return <NoOrg />;
  const first = items(projects.data)[0];
  if (projects.data && !first) return <NoOrg />;
  if (!first) return <Boot />;
  return <Navigate to={`/p/${first.id}/test/overview`} replace />;
}

function NoOrg() {
  return (
    <div className="boot">
      <div className="stack" style={{ justifyItems: "center", textAlign: "center", maxWidth: 360 }}>
        <Logo size={24} />
        <h1>No projects yet</h1>
        <p className="muted">Run the CLI in your app to create one.</p>
        <code>npx paynp init</code>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ project context
export interface ProjectCtx {
  project: Project;
  env: Env;
  /** `/p/:project/:env` */
  base: string;
  org: Me["orgs"][number];
  projects: Project[];
  canAdmin: boolean;
  /** Served by `paynp dev`. */
  local: boolean;
}
const PCtx = createContext<ProjectCtx | null>(null);
export const useProject = () => useContext(PCtx)!;

export function ProjectShell() {
  const { project: pid = "", env: envParam } = useParams();
  const env: Env = envParam === "live" ? "live" : "test";
  const me = useMe();
  const local = me.mode === "local";
  const loc = useLocation();
  const p = useQuery<Project>(`/api/projects/${pid}`, { staleMs: 60_000 });
  const orgId = p.data?.org_id;
  const list = useQuery<Page<Project>>(orgId && !local ? `/api/orgs/${orgId}/projects` : null, { staleMs: 60_000 });

  useEffect(() => {
    if (p.data) rememberProject(p.data.id, env);
  }, [p.data, env]);

  if (envParam !== "test" && envParam !== "live") return <Navigate to={`/p/${pid}/test/overview`} replace />;
  // The dev server has no alerts, keys, members or sessions, and statements and exports need the cloud.
  if (local && /^\/p\/[^/]+\/[^/]+\/(alerts|settings|reconcile|exports)(\/|$)/.test(loc.pathname)) return <Navigate to={`/p/${pid}/${env}/overview`} replace />;
  if (p.error instanceof ApiFailure && p.error.status === 404) return <ProjectGone />;
  if (!p.data) return <ShellFrame env={env} />;
  const org = me.orgs.find((o) => o.id === p.data!.org_id) ?? { id: p.data.org_id, name: "Organization", role: "viewer" as const };
  const ctx: ProjectCtx = {
    project: p.data,
    env,
    base: `/p/${p.data.id}/${env}`,
    org,
    projects: items(list.data),
    canAdmin: org.role !== "viewer",
    local,
  };
  return (
    <PCtx.Provider value={ctx}>
      <ShellFrame env={env} ctx={ctx}>
        <Outlet />
      </ShellFrame>
    </PCtx.Provider>
  );
}

function ProjectGone() {
  try {
    localStorage.removeItem(LAST);
  } catch {
    /* ignore */
  }
  return (
    <div className="boot">
      <div className="stack" style={{ justifyItems: "center", textAlign: "center" }}>
        <h1>Project not found</h1>
        <p className="muted">It may have been deleted, or you are not a member of its organization.</p>
        <Link className="btn btn-secondary" to="/">
          Go to my projects
        </Link>
      </div>
    </div>
  );
}

function ShellFrame({ env, ctx, children }: { env: Env; ctx?: ProjectCtx; children?: ReactNode }) {
  const local = useLocal();
  const [askOpen, setAskOpen] = useState(false);
  // Ctrl+I / Cmd+I opens and closes Ask from any page.
  useEffect(() => {
    if (!ctx || local) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "i") {
        e.preventDefault();
        setAskOpen((o) => !o);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [ctx, local]);
  return (
    <div className="shell">
      <header className="topbar">
        {env === "test" && <div className="testbar" aria-hidden="true" />}
        <div className="topbar-row">
          <Link to="/" className="tb-cell tb-brand" aria-label="discerns home">
            <Logo />
          </Link>
          {local ? <LocalBadge /> : ctx ? <ProjectSwitcher ctx={ctx} /> : <span className="tb-cell" />}
          <div className="tb-spacer" />
          <div className="tb-right">
            {ctx && !local && (
              <button type="button" className="btn btn-sm ask-trigger" aria-expanded={askOpen} aria-controls="ask-panel" onClick={() => setAskOpen((o) => !o)} title="Ask AI (Ctrl+I)">
                <Icon name="sparkles" size={15} />
                <span className="hide-sm">Ask AI</span>
              </button>
            )}
            {ctx && <EnvToggle ctx={ctx} />}
            <Link className="btn btn-ghost btn-sm hide-sm" to="/docs">
              Docs
            </Link>
            {local ? (
              <ThemeButton />
            ) : (
              <>
                <span className="hide-sm">
                  <ThemeButton />
                </span>
                <UserMenu />
              </>
            )}
          </div>
        </div>
        {ctx && <Tabs ctx={ctx} />}
      </header>
      <main className="main">{children}</main>
      {ctx && !local && <AskPanel ctx={ctx} open={askOpen} onClose={() => setAskOpen(false)} />}
    </div>
  );
}

function LocalBadge() {
  return (
    <span className="tb-cell tb-local" title="paynp dev: events stay on this machine">
      <span className="live-dot" aria-hidden="true" />
      <span className="tag tag-local">Local dev server</span>
    </span>
  );
}

function EnvToggle({ ctx }: { ctx: ProjectCtx }) {
  const nav = useNavigate();
  const loc = useLocation();
  return (
    <Seg
      small
      className="env-toggle"
      label="Environment"
      value={ctx.env}
      options={[
        { value: "test", label: "Test" },
        { value: "live", label: "Live" },
      ]}
      onChange={(env) => {
        if (env === ctx.env) return;
        const rest = loc.pathname.slice(ctx.base.length) || "/overview";
        // A payment belongs to one environment, so the detail page falls back to the list.
        const next = rest.startsWith("/payments/") ? "/payments" : rest;
        nav(`/p/${ctx.project.id}/${env}${next}`);
      }}
    />
  );
}

function ProjectSwitcher({ ctx }: { ctx: ProjectCtx }) {
  const me = useMe();
  const nav = useNavigate();
  const goOrg = async (orgId: string, close: () => void) => {
    close();
    if (orgId === ctx.org.id) return;
    try {
      const first = items(await api<Page<Project>>(`/api/orgs/${orgId}/projects`))[0];
      if (first) nav(`/p/${first.id}/${ctx.env}/overview`);
      else toast("That organization has no projects yet", { kind: "info", sub: "Run npx paynp init in an app to create one." });
    } catch {
      toast("Could not load projects", { kind: "error" });
    }
  };
  const [creating, setCreating] = useState(false);
  return (
    <>
    <NewProjectDialog ctx={ctx} open={creating} onClose={() => setCreating(false)} />
    <Menu
      trigger={({ open, toggle, id }) => (
        <button type="button" className="tb-cell" aria-expanded={open} aria-controls={id} aria-haspopup="menu" onClick={toggle} style={{ maxWidth: "min(56vw, 420px)" }}>
          <span className="avatar sq-tone hide-sm" aria-hidden="true">
            {ctx.org.name.slice(0, 1)}
          </span>
          <span className="crumb-org truncate hide-sm">{ctx.org.name}</span>
          <span className="crumb-sep hide-sm" aria-hidden="true">
            /
          </span>
          <span className="crumb-name truncate">{ctx.project.name}</span>
          <Icon name="chevronsUpDown" size={14} className="subtle" />
        </button>
      )}
    >
      {(close) => (
        <>
          <div className="menu-label">Projects in {ctx.org.name}</div>
          {(ctx.projects.length ? ctx.projects : [ctx.project]).map((p) => (
            <Link key={p.id} role="menuitemradio" aria-checked={p.id === ctx.project.id} className="menu-item" to={`/p/${p.id}/${ctx.env}/overview`} onClick={close}>
              <span className="truncate">{p.name}</span>
              {p.id === ctx.project.id && <Icon name="check" className="check-mark" />}
            </Link>
          ))}
          {ctx.canAdmin && (
            <button
              className="menu-item muted"
              onClick={() => {
                close();
                setCreating(true);
              }}
            >
              <Icon name="plus" />
              New project
            </button>
          )}
          <div className="menu-sep" />
          <div className="menu-label">Organizations</div>
          {me.orgs.map((o) => (
            <button key={o.id} role="menuitemradio" aria-checked={o.id === ctx.org.id} className="menu-item" onClick={() => void goOrg(o.id, close)}>
              <span className="avatar sq-tone" aria-hidden="true" style={{ width: 20, height: 20, fontSize: 10 }}>
                {o.name.slice(0, 1)}
              </span>
              <span className="truncate">{o.name}</span>
              <span className="tag" style={{ marginInlineStart: "auto" }}>
                {o.role}
              </span>
              {o.id === ctx.org.id && <Icon name="check" className="check-mark" />}
            </button>
          ))}
        </>
      )}
    </Menu>
    </>
  );
}

function NewProjectDialog({ ctx, open, onClose }: { ctx: ProjectCtx; open: boolean; onClose: () => void }) {
  const nav = useNavigate();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return setErr("Give the project a name");
    setBusy(true);
    try {
      const p = await api<Project>(`/api/orgs/${ctx.org.id}/projects`, { method: "POST", body: { name: name.trim() } });
      invalidate(`/api/orgs/${ctx.org.id}/projects`);
      onClose();
      setName("");
      nav(`/p/${p.id}/test/overview`);
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="New project"
      description={`One app or site in ${ctx.org.name}. It gets its own test and live keys.`}
    >
      <form className="stack" onSubmit={submit}>
        <label className="field">
          <span className="label">Name</span>
          <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Storefront" maxLength={60} />
          {err && <span className="err">{err}</span>}
        </label>
        <div className="actions" style={{ justifyContent: "flex-end" }}>
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={busy}>
            {busy && <span className="spinner" />}
            Create project
          </button>
        </div>
      </form>
    </Dialog>
  );
}

export function ThemeButton() {
  const { resolved } = useTheme();
  return (
    <button type="button" className="btn btn-icon btn-sm hit" aria-label={resolved === "dark" ? "Switch to light theme" : "Switch to dark theme"} title="Toggle theme" onClick={() => setChoice(resolved === "dark" ? "light" : "dark")}>
      <Icon name={resolved === "dark" ? "sun" : "moon"} />
    </button>
  );
}

function UserMenu() {
  const me = useMe();
  const { choice } = useTheme();
  const initials = (me.user.name ?? me.user.email)
    .split(/[\s@.]+/)
    .slice(0, 2)
    .map((s) => s[0])
    .join("");
  return (
    <Menu
      align="end"
      trigger={({ open, toggle, id }) => (
        <button type="button" className="btn btn-icon btn-sm hit" aria-label="Account" aria-expanded={open} aria-controls={id} onClick={toggle}>
          <span className="avatar">{initials}</span>
        </button>
      )}
    >
      {(close) => (
        <>
          <div className="menu-label" style={{ paddingBlockEnd: 8 }}>
            <div className="ink" style={{ fontSize: 13 }}>
              {me.user.name ?? me.user.email}
            </div>
            <div>{me.user.email}</div>
          </div>
          <div className="menu-sep" />
          <div className="menu-label">Theme</div>
          {(["system", "light", "dark"] as const).map((c) => (
            <button
              key={c}
              role="menuitemradio"
              aria-checked={choice === c}
              className="menu-item"
              onClick={() => {
                setChoice(c);
                close();
              }}
            >
              <Icon name={c === "system" ? "monitor" : c === "light" ? "sun" : "moon"} />
              {c === "system" ? "System" : c === "light" ? "Light" : "Dark"}
              {choice === c && <Icon name="check" className="check-mark" />}
            </button>
          ))}
          <div className="menu-sep" />
          <Link className="menu-item" to="/docs" onClick={close}>
            <Icon name="file" />
            Docs
          </Link>
          <button
            className="menu-item"
            onClick={async () => {
              close();
              try {
                await api("/auth/logout", { method: "POST" });
              } finally {
                location.href = "/signin";
              }
            }}
          >
            <Icon name="logout" />
            Sign out
          </button>
        </>
      )}
    </Menu>
  );
}

function Tabs({ ctx }: { ctx: ProjectCtx }) {
  const firing = useQuery<Page<Incident>>(ctx.local ? null : `/api/projects/${ctx.project.id}/incidents?state=firing`, { refreshMs: 60_000 });
  // Same key as the Refunds page (refundsKey there), so the badge and the page agree and share one request.
  const refunds = useQuery<Page<RefundCase> & { open_count?: number }>(`/api/projects/${ctx.project.id}/refunds?env=${ctx.env}&limit=200`, { refreshMs: 60_000 });
  const n = items(firing.data).length;
  const open = refunds.data?.open_count ?? items(refunds.data).filter((c) => c.status === "open" || c.status === "requested" || c.status === "failed").length;
  const nav = useRef<HTMLElement>(null);
  const loc = useLocation();
  // On a phone the tab strip scrolls; keep the current tab in view after navigating.
  useEffect(() => {
    nav.current?.querySelector<HTMLElement>('[aria-current="page"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [loc.pathname]);
  const tabs: { to: string; label: string; extra?: ReactNode; cloud?: boolean }[] = [
    { to: "overview", label: "Overview" },
    { to: "payments", label: "Payments" },
    { to: "live", label: "Live", extra: <span className="live-dot" aria-hidden="true" /> },
    { to: "analytics", label: "Analytics" },
    { to: "support", label: "Support" },
    { to: "refunds", label: "Refunds", extra: open ? <span className="tab-count" aria-label={`${open} open`}>{open}</span> : null },
    { to: "reconcile", label: "Reconcile", cloud: true },
    { to: "exports", label: "Exports", cloud: true },
    { to: "go-live", label: "Go-live" },
    { to: "alerts", label: "Alerts", cloud: true, extra: n ? <span className="tab-count tab-count-warn" aria-label={`${n} firing`}>{n}</span> : null },
    { to: "settings", label: "Settings", cloud: true },
  ].filter((t) => !ctx.local || !t.cloud);
  return (
    <nav className="tabs" aria-label="Project" ref={nav}>
      {tabs.map((t) => (
        <NavLink key={t.to} to={`${ctx.base}/${t.to}`} className="tab">
          {t.label}
          {t.extra}
        </NavLink>
      ))}
    </nav>
  );
}

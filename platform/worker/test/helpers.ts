import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { newId, type PaymentEvent } from "@paynp/shared";
import { devOutbox } from "../src/email.ts";
import worker from "../src/index.ts";

export const BASE = "https://paynp.test";

export interface CallOpts {
  body?: unknown;
  cookie?: string;
  pat?: string;
  key?: string;
  csrf?: boolean;
  headers?: Record<string, string>;
  raw?: string;
}

/** Runs a request through the Worker and waits for its waitUntil work (live publish, alerts, emails). */
export async function call(method: string, path: string, opts: CallOpts = {}): Promise<Response> {
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.body !== undefined || opts.raw !== undefined) headers["content-type"] ??= "application/json";
  if (opts.cookie) headers.cookie = `paynp_session=${opts.cookie}`;
  if (opts.pat) headers.authorization = `Bearer ${opts.pat}`;
  if (opts.key) headers.authorization = `Bearer ${opts.key}`;
  if (opts.cookie && opts.csrf !== false && method !== "GET") headers["x-paynp-csrf"] = "1";
  const req = new Request(BASE + path, { method, headers, body: opts.raw ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined) });
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

export async function json<T = any>(res: Response | Promise<Response>): Promise<T> {
  return (await (await res).json()) as T;
}

export function lastMailTo(email: string) {
  return [...devOutbox].reverse().find((m) => m.to.includes(email));
}

export function tokenFromMail(email: string, path = "/auth/verify"): string {
  const mail = lastMailTo(email);
  const m = mail && new RegExp(`${path.replace(/\//g, "\\/")}\\?token=([A-Za-z0-9_-]+)`).exec(mail.text);
  if (!m) throw new Error(`no ${path} link mailed to ${email}`);
  return m[1];
}

export function cookieFrom(res: Response): string {
  const set = res.headers.get("set-cookie") ?? "";
  const m = /paynp_session=([^;]+)/.exec(set);
  if (!m) throw new Error(`no session cookie in: ${set}`);
  return m[1];
}

let n = 0;
export const uniqueEmail = (tag = "u") => `${tag}${Date.now().toString(36)}${n++}@example.com`;

export async function signUp(email = uniqueEmail()): Promise<{ email: string; cookie: string }> {
  const r = await call("POST", "/auth/login", { body: { email } });
  if (r.status !== 204) throw new Error(`login ${r.status}`);
  const v = await call("GET", `/auth/verify?token=${tokenFromMail(email)}`);
  return { email, cookie: cookieFrom(v) };
}

export interface Setup {
  email: string;
  cookie: string;
  orgId: string;
  projectId: string;
  key: string;
}

/** A signed-in owner with the default project and a test key. */
export async function setup(envName: "test" | "live" = "test"): Promise<Setup> {
  const { email, cookie } = await signUp();
  const me = await json(call("GET", "/api/me", { cookie }));
  const orgId = me.orgs[0].id;
  const projects = await json(call("GET", `/api/orgs/${orgId}/projects`, { cookie }));
  const projectId = projects.items[0].id;
  const key = await json(call("POST", `/api/projects/${projectId}/keys`, { cookie, body: { env: envName, name: "t" } }));
  return { email, cookie, orgId, projectId, key: key.key };
}

const base = Date.now() - 5 * 60_000;
/** Builds an event; `at` is ms after a fixed base a few minutes ago. */
export function ev(type: PaymentEvent["type"], attempt: string, at: number, extra: Partial<PaymentEvent> = {}): PaymentEvent {
  return { id: newId("evt"), type, ts: new Date(base + at).toISOString(), attempt_id: attempt, gateway: "esewa", ...extra };
}

export const ingest = (key: string, events: unknown[]) => call("POST", "/v1/events", { key, body: { events } });

export async function payment(s: Setup, attempt: string, envName = "test") {
  return json(call("GET", `/api/projects/${s.projectId}/payments/${encodeURIComponent(attempt)}?env=${envName}`, { cookie: s.cookie }));
}

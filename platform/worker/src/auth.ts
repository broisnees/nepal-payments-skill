// Auth (platform/SPEC.md section 5). Better Auth (src/lib/better-auth.ts) signs people in and owns sessions: magic
// link, GitHub, Google. This file keeps what is discerns' own: provisioning orgs and projects for a new account, CSRF,
// the CLI device login, PATs and invites.
import { CSRF_HEADER, KEY_PREFIX, newId } from "@paynp/shared";
import type { Context, Hono, MiddlewareHandler } from "hono";
import { enabledSocialProviders, getAuth, reserveCapture, takeCapturedLink } from "./lib/better-auth.ts";
import { DAY, HttpError, MINUTE, appOrigin, badRequest, isEmail, now, randomString, randomToken, readJson, sha256Hex, str } from "./lib/util.ts";
import type { AppEnv, UserRow } from "./types.ts";

export const DEVICE_TTL = 10 * MINUTE;
export const INVITE_TTL = 7 * DAY;
export const PAT_SLIDE = 10 * MINUTE;
const SIGNUP_INTENT_TTL = 15 * MINUTE;

const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ"; // no vowels, no look-alikes

/** What the sign-up form collected. Used only when the verify creates the account. */
export interface SignupProfile {
  name: string;
  org: string;
}

/**
 * The users row for a Better Auth user, created on first use with an org (owner) and a default project: named from
 * the sign-up form when there is one, else "<local part>'s org". Same id as the Better Auth user.
 */
export async function provision(env: Env, authUser: { id: string; email: string; name?: string | null }): Promise<UserRow> {
  const existing = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(authUser.id).first<UserRow>();
  if (existing) return existing;
  const email = authUser.email.toLowerCase();
  const t = now();
  const intent = await env.DB.prepare("DELETE FROM signup_intents WHERE email = ? RETURNING name, org, expires_at").bind(email).first<{ name: string; org: string; expires_at: number }>();
  const profile = intent && intent.expires_at > t ? intent : null;
  const name = profile?.name ?? (authUser.name?.trim() || null);
  const user: UserRow = { id: authUser.id, email, name, created_at: t, digest_opt_out: 0 };
  const orgId = newId("org", t);
  try {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO users (id, email, name, created_at) VALUES (?, ?, ?, ?)").bind(user.id, email, name, t),
      env.DB.prepare("INSERT INTO orgs (id, name, created_at) VALUES (?, ?, ?)").bind(orgId, profile?.org ?? `${email.split("@")[0]}'s org`, t),
      env.DB.prepare("INSERT INTO members (org_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)").bind(orgId, user.id, t),
      env.DB.prepare("INSERT INTO projects (id, org_id, name, slug, created_at) VALUES (?, ?, 'Default', 'default', ?)").bind(newId("prj", t), orgId, t),
      env.DB.prepare("INSERT INTO audit_log (id, org_id, user_id, action, target, at) VALUES (?, ?, ?, 'org.create', ?, ?)").bind(newId("aud", t), orgId, user.id, orgId, t),
    ]);
  } catch (e) {
    // Two first requests racing: the other one created it.
    const again = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(authUser.id).first<UserRow>();
    if (again) return again;
    throw e;
  }
  return user;
}

export async function issuePat(env: Env, userId: string, name: string | null): Promise<string> {
  const token = KEY_PREFIX.pat + randomString(32);
  await env.DB.prepare("INSERT INTO pats (id, user_id, token_hash, name, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(newId("pat"), userId, await sha256Hex(token), name, now())
    .run();
  return token;
}

function userCode(): string {
  const s = randomString(8, USER_CODE_ALPHABET);
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

/** Same-origin check for cookie-authenticated writes: the CSRF header plus a matching Origin when the browser sends one. */
export function checkCsrf(c: Context<AppEnv>): void {
  if (c.req.header(CSRF_HEADER) !== "1") throw new HttpError(403, "csrf", `missing ${CSRF_HEADER}: 1 header`);
  checkOrigin(c);
}

export function checkOrigin(c: Context<AppEnv>): void {
  const origin = c.req.header("origin");
  if (!origin || origin === "null") return;
  let host: string;
  try {
    host = new URL(origin).host;
  } catch {
    throw new HttpError(403, "csrf", "bad Origin");
  }
  const allowed = new Set([c.req.header("host"), new URL(c.req.url).host]);
  if (c.env.APP_URL) allowed.add(new URL(c.env.APP_URL).host);
  if (!allowed.has(host)) throw new HttpError(403, "csrf", "cross-origin request refused");
}

/** /api/* authentication: session cookie or `Authorization: Bearer pnp_pat_...`. */
export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const env = c.env;
  const t = now();
  const header = c.req.header("authorization") ?? "";
  // Browsers' WebSocket API cannot set headers, so the live route also takes a PAT as ?access_token=.
  const bearer = header.startsWith("Bearer ") ? header.slice(7).trim() : c.req.path.endsWith("/live") ? (c.req.query("access_token") ?? "") : "";
  if (bearer) {
    if (!bearer.startsWith(KEY_PREFIX.pat)) throw new HttpError(401, "unauthorized", "expected a personal access token");
    const pat = await env.DB.prepare("SELECT p.id AS pat_id, p.last_used_at, u.* FROM pats p JOIN users u ON u.id = p.user_id WHERE p.token_hash = ? AND p.revoked_at IS NULL")
      .bind(await sha256Hex(bearer))
      .first<UserRow & { pat_id: string; last_used_at: number | null }>();
    if (!pat) throw new HttpError(401, "unauthorized", "unknown or revoked token");
    if (pat.last_used_at === null || t - pat.last_used_at > PAT_SLIDE) {
      c.executionCtx.waitUntil(env.DB.prepare("UPDATE pats SET last_used_at = ? WHERE id = ?").bind(t, pat.pat_id).run());
    }
    const { pat_id, last_used_at: _, ...user } = pat;
    c.set("user", user);
    c.set("authKind", "pat");
    c.set("patId", pat_id);
    return next();
  }

  const { headers, response } = await getAuth(env).api.getSession({ headers: c.req.raw.headers, returnHeaders: true });
  // A refreshed session comes back with a new cookie; pass it on.
  for (const cookie of headers.getSetCookie()) c.header("set-cookie", cookie, { append: true });
  if (!response) throw new HttpError(401, "unauthorized", "sign in first");
  c.set("user", await provision(env, response.user));
  c.set("authKind", "session");
  c.set("sessionId", response.session.id);
  if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method)) checkCsrf(c);
  else if (c.req.header("upgrade")?.toLowerCase() === "websocket") checkOrigin(c);
  return next();
};

export const PROFILE_MAX = 80;

/** A required sign-up text field: trimmed, 1 to 80 characters, no control characters. */
function profileField(body: Record<string, unknown>, key: "name" | "org"): string {
  const v = str(body, key, { required: true, max: PROFILE_MAX })!;
  if (/[\u0000-\u001f\u007f]/.test(v)) throw badRequest(`${key} has characters that are not allowed`);
  return v.replace(/\s+/g, " ");
}

/** Asks Better Auth for a magic link. The answer never says whether the account exists. */
async function sendLoginLink(c: Context<AppEnv>, email: string, name?: string): Promise<void> {
  await getAuth(c.env).api.signInMagicLink({ body: { email, name, callbackURL: "/", errorCallbackURL: "/signin" }, headers: c.req.raw.headers });
}

/** Better Auth answers with Set-Cookie headers on a Response; copy them onto a redirect of our own. */
function redirectWithCookies(c: Context<AppEnv>, res: Response, to: string): Response {
  for (const cookie of res.headers.getSetCookie()) c.header("set-cookie", cookie, { append: true });
  return c.redirect(to, 302);
}

/** Better Auth's error codes in the redirect, as the sign-in page knows them. */
function signinError(location: string | null): string {
  const code = location ? new URL(location, "http://x").searchParams.get("error") : null;
  return code === "INVALID_TOKEN" || !code ? "invalid_link" : code.toLowerCase();
}

export function registerAuth(app: Hono<AppEnv>) {
  app.post("/auth/login", async (c) => {
    checkOrigin(c);
    const body = await readJson(c.req.raw);
    const email = str(body, "email", { required: true, max: 254 })!.toLowerCase();
    if (!isEmail(email)) throw badRequest("email is not valid");
    await limitAuth(c, email);
    await sendLoginLink(c, email);
    return c.body(null, 204);
  });

  // Sign-up: the same magic link, optionally with a name and organization for a new account. The answer is the same 204
  // whether or not the email already has an account, and an existing account just signs in.
  app.post("/auth/signup", async (c) => {
    checkOrigin(c);
    const body = await readJson(c.req.raw);
    const email = str(body, "email", { required: true, max: 254 })!.toLowerCase();
    if (!isEmail(email)) throw badRequest("email is not valid");
    // Name and organization are optional: without them the account gets "<local part>'s org" and no name.
    const name = body.name === undefined || body.name === "" ? null : profileField(body, "name");
    const org = body.org === undefined || body.org === "" ? null : profileField(body, "org");
    await limitAuth(c, email);
    if (name && org) {
      await c.env.DB.prepare("INSERT INTO signup_intents (email, name, org, expires_at) VALUES (?, ?, ?, ?) ON CONFLICT (email) DO UPDATE SET name = excluded.name, org = excluded.org, expires_at = excluded.expires_at")
        .bind(email, name, org, now() + SIGNUP_INTENT_TTL)
        .run();
    }
    await sendLoginLink(c, email, name ?? undefined);
    return c.body(null, 204);
  });

  // The short link in the email. Better Auth checks the token, creates the user if new, and sets the session cookie.
  app.get("/auth/verify", async (c) => {
    const token = c.req.query("token") ?? "";
    if (!token) return c.redirect("/signin?error=invalid_link", 302);
    const next = c.req.query("next");
    const target = next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
    const url = new URL("/auth/magic-link/verify", c.req.url);
    url.searchParams.set("token", token);
    url.searchParams.set("callbackURL", target);
    url.searchParams.set("errorCallbackURL", "/signin");
    const res = await getAuth(c.env).handler(new Request(url, { headers: c.req.raw.headers }));
    const location = res.headers.get("location");
    const failed = !location || new URL(location, url).searchParams.has("error");
    if (failed) return c.redirect(`/signin?error=${signinError(location)}`, 302);
    return redirectWithCookies(c, res, target);
  });

  app.get("/auth/invite", async (c) => {
    const token = c.req.query("token") ?? "";
    const t = now();
    const inv = token
      ? await c.env.DB.prepare("DELETE FROM invites WHERE token_hash = ? AND expires_at > ? RETURNING org_id, email, role").bind(await sha256Hex(token), t).first<{ org_id: string; email: string; role: string }>()
      : null;
    if (!inv) return c.redirect("/signin?error=invalid_invite", 302);
    // The invite link proves the address, so it signs in the same way a magic link does: mint one and follow it.
    const auth = getAuth(c.env);
    const nonce = reserveCapture();
    await auth.api.signInMagicLink({ body: { email: inv.email, callbackURL: "/", metadata: { capture: nonce } }, headers: c.req.raw.headers });
    const link = takeCapturedLink(nonce);
    if (!link) throw new HttpError(500, "internal", "could not sign in from the invite");
    const url = new URL(link);
    const verify = new URL("/auth/magic-link/verify", c.req.url);
    verify.searchParams.set("token", url.searchParams.get("token") ?? "");
    verify.searchParams.set("callbackURL", "/");
    const res = await auth.handler(new Request(verify, { headers: c.req.raw.headers }));
    const session = await auth.api.getSession({ headers: new Headers({ cookie: res.headers.getSetCookie().map((s) => s.split(";")[0]).join("; ") }) });
    if (!session) return c.redirect("/signin?error=invalid_invite", 302);
    const user = await provision(c.env, session.user);
    await c.env.DB.batch([
      c.env.DB.prepare("INSERT INTO members (org_id, user_id, role, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (org_id, user_id) DO NOTHING").bind(inv.org_id, user.id, inv.role, t),
      c.env.DB.prepare("INSERT INTO audit_log (id, org_id, user_id, action, target, at) VALUES (?, ?, ?, 'member.join', ?, ?)").bind(newId("aud", t), inv.org_id, user.id, user.id, t),
    ]);
    return redirectWithCookies(c, res, "/");
  });

  app.post("/auth/logout", async (c) => {
    checkOrigin(c);
    const header = c.req.header("authorization") ?? "";
    if (header.startsWith(`Bearer ${KEY_PREFIX.pat}`)) {
      await c.env.DB.prepare("UPDATE pats SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL").bind(now(), await sha256Hex(header.slice(7).trim())).run();
      return c.body(null, 204);
    }
    const res = await getAuth(c.env).api.signOut({ headers: c.req.raw.headers, asResponse: true });
    for (const cookie of res.headers.getSetCookie()) c.header("set-cookie", cookie, { append: true });
    return c.body(null, 204);
  });

  /** Which sign-in buttons the sign-in page shows. */
  app.get("/auth/providers", (c) => c.json({ magic_link: true, social: enabledSocialProviders(c.env) }));

  app.post("/auth/device", async (c) => {
    const deviceCode = randomToken();
    const t = now();
    let code = "";
    for (let i = 0; i < 5; i++) {
      code = userCode();
      const r = await c.env.DB.prepare("INSERT INTO device_codes (device_code_hash, user_code, expires_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING")
        .bind(await sha256Hex(deviceCode), code, t + DEVICE_TTL)
        .run();
      if (r.meta.changes) break;
      code = "";
    }
    if (!code) throw new HttpError(500, "internal", "could not allocate a user code");
    return c.json({
      device_code: deviceCode,
      user_code: code,
      verification_url: `${appOrigin(c.env, c.req.raw)}/device?code=${code}`,
      interval: 3,
      expires_in: DEVICE_TTL / 1000,
    });
  });

  app.post("/auth/device/token", async (c) => {
    const body = await readJson(c.req.raw);
    const deviceCode = str(body, "device_code", { required: true, max: 100 })!;
    const hash = await sha256Hex(deviceCode);
    const t = now();
    const row = await c.env.DB.prepare("SELECT * FROM device_codes WHERE device_code_hash = ?").bind(hash).first<{ user_id: string | null; expires_at: number; approved_at: number | null }>();
    if (!row || row.expires_at <= t) return c.json({ error: "expired_token" }, 400);
    if (!row.approved_at || !row.user_id) return c.json({ error: "authorization_pending" }, 428);
    // One use: delete first so two polls cannot both get a token.
    const del = await c.env.DB.prepare("DELETE FROM device_codes WHERE device_code_hash = ? AND approved_at IS NOT NULL").bind(hash).run();
    if (!del.meta.changes) return c.json({ error: "expired_token" }, 400);
    const ua = c.req.header("user-agent")?.slice(0, 60);
    const token = await issuePat(c.env, row.user_id, ua ? `CLI (${ua})` : "CLI");
    return c.json({ token });
  });

  // Everything else under /auth is Better Auth's: /auth/sign-in/social, /auth/callback/:provider,
  // /auth/magic-link/verify, /auth/get-session, /auth/sign-out.
  app.on(["GET", "POST"], "/auth/*", (c) => getAuth(c.env).handler(c.req.raw));
}

/** Sign-in mail per address and per IP, through the AUTH_LIMITER binding. Absent binding: no limit (tests, dev). */
async function limitAuth(c: Context<AppEnv>, email: string): Promise<void> {
  const limiter = c.env.AUTH_LIMITER;
  if (!limiter) return;
  const ip = c.req.header("cf-connecting-ip") ?? "local";
  const [byEmail, byIp] = await Promise.all([limiter.limit({ key: `email:${email}` }), limiter.limit({ key: `ip:${ip}` })]);
  if (!byEmail.success || !byIp.success) throw new HttpError(429, "rate_limited", "too many sign-in emails, try again in a minute");
}

/** Approve a device code for the signed-in user (POST /api/device/approve). */
export async function approveDevice(env: Env, userId: string, code: string): Promise<boolean> {
  const t = now();
  const r = await env.DB.prepare("UPDATE device_codes SET user_id = ?, approved_at = ? WHERE user_code = ? AND approved_at IS NULL AND expires_at > ?")
    .bind(userId, t, code.toUpperCase().trim(), t)
    .run();
  return (r.meta.changes ?? 0) > 0;
}


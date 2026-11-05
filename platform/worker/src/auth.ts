// Auth (platform/SPEC.md section 5): magic link, sessions, CSRF, device login, PATs, invites.
import { CSRF_HEADER, KEY_PREFIX, SESSION_COOKIE, newId } from "@paynp/shared";
import type { Context, Hono, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { htmlMail, sendMail } from "./email.ts";
import { DAY, HttpError, MINUTE, appOrigin, badRequest, isEmail, now, randomString, randomToken, readJson, sha256Hex, str } from "./lib/util.ts";
import type { AppEnv, UserRow } from "./types.ts";

export const LOGIN_TTL = 15 * MINUTE;
export const SESSION_TTL = 30 * DAY;
export const SESSION_SLIDE = 10 * MINUTE;
export const DEVICE_TTL = 10 * MINUTE;
export const INVITE_TTL = 7 * DAY;

const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ"; // no vowels, no look-alikes

function sessionCookie(c: Context<AppEnv>, token: string) {
  setCookie(c, SESSION_COOKIE, token, { httpOnly: true, secure: true, sameSite: "Lax", path: "/", maxAge: SESSION_TTL / 1000 });
}

/** Finds or creates the user. A new user gets a personal org (owner) and a default project. */
export async function signIn(env: Env, email: string): Promise<{ user: UserRow; created: boolean }> {
  const existing = await env.DB.prepare("SELECT * FROM users WHERE email = ?").bind(email).first<UserRow>();
  if (existing) return { user: existing, created: false };
  const t = now();
  const user: UserRow = { id: newId("usr", t), email, name: null, created_at: t, digest_opt_out: 0 };
  const orgId = newId("org", t);
  const local = email.split("@")[0];
  try {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO users (id, email, name, created_at) VALUES (?, ?, NULL, ?)").bind(user.id, email, t),
      env.DB.prepare("INSERT INTO orgs (id, name, created_at) VALUES (?, ?, ?)").bind(orgId, `${local}'s org`, t),
      env.DB.prepare("INSERT INTO members (org_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)").bind(orgId, user.id, t),
      env.DB.prepare("INSERT INTO projects (id, org_id, name, slug, created_at) VALUES (?, ?, 'Default', 'default', ?)").bind(newId("prj", t), orgId, t),
      env.DB.prepare("INSERT INTO audit_log (id, org_id, user_id, action, target, at) VALUES (?, ?, ?, 'org.create', ?, ?)").bind(newId("aud", t), orgId, user.id, orgId, t),
    ]);
  } catch (e) {
    // Two verifications racing for the same new email: the other one won.
    const again = await env.DB.prepare("SELECT * FROM users WHERE email = ?").bind(email).first<UserRow>();
    if (again) return { user: again, created: false };
    throw e;
  }
  return { user, created: true };
}

export async function createSession(c: Context<AppEnv>, userId: string): Promise<string> {
  const token = randomToken();
  const t = now();
  const id = newId("ses", t);
  const ip = c.req.header("cf-connecting-ip") ?? c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  await c.env.DB.prepare("INSERT INTO sessions (id, user_id, token_hash, user_agent, ip, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(id, userId, await sha256Hex(token), c.req.header("user-agent")?.slice(0, 300) ?? null, ip, t, t, t + SESSION_TTL)
    .run();
  sessionCookie(c, token);
  return id;
}

async function issuePat(env: Env, userId: string, name: string | null): Promise<string> {
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
    if (pat.last_used_at === null || t - pat.last_used_at > SESSION_SLIDE) {
      c.executionCtx.waitUntil(env.DB.prepare("UPDATE pats SET last_used_at = ? WHERE id = ?").bind(t, pat.pat_id).run());
    }
    const { pat_id, last_used_at: _, ...user } = pat;
    c.set("user", user);
    c.set("authKind", "pat");
    c.set("patId", pat_id);
    return next();
  }

  const token = getCookie(c, SESSION_COOKIE);
  if (!token) throw new HttpError(401, "unauthorized", "sign in first");
  const row = await env.DB.prepare(
    "SELECT s.id AS session_id, s.last_seen_at, s.expires_at, u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.revoked_at IS NULL",
  )
    .bind(await sha256Hex(token))
    .first<UserRow & { session_id: string; last_seen_at: number; expires_at: number }>();
  if (!row || row.expires_at <= t) {
    deleteCookie(c, SESSION_COOKIE, { path: "/", secure: true });
    throw new HttpError(401, "unauthorized", "session expired");
  }
  if (t - row.last_seen_at > SESSION_SLIDE) {
    await env.DB.prepare("UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?").bind(t, t + SESSION_TTL, row.session_id).run();
    sessionCookie(c, token);
  }
  const { session_id, last_seen_at: _a, expires_at: _b, ...user } = row;
  c.set("user", user);
  c.set("authKind", "session");
  c.set("sessionId", session_id);
  if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method)) checkCsrf(c);
  else if (c.req.header("upgrade")?.toLowerCase() === "websocket") checkOrigin(c);
  return next();
};

export function registerAuth(app: Hono<AppEnv>) {
  app.post("/auth/login", async (c) => {
    checkOrigin(c);
    const body = await readJson(c.req.raw);
    const email = str(body, "email", { required: true, max: 254 })!.toLowerCase();
    if (!isEmail(email)) throw badRequest("email is not valid");
    const token = randomToken();
    await c.env.DB.prepare("INSERT INTO login_tokens (token_hash, email, expires_at) VALUES (?, ?, ?)").bind(await sha256Hex(token), email, now() + LOGIN_TTL).run();
    const link = `${appOrigin(c.env, c.req.raw)}/auth/verify?token=${token}`;
    const send = sendMail(c.env, {
      to: [email],
      subject: "Sign in to paynp",
      text: `Sign in to paynp:\n\n${link}\n\nThe link works once and expires in 15 minutes. If you did not ask for it, ignore this email.`,
      html: htmlMail("Sign in to paynp", ["The link works once and expires in 15 minutes. If you did not ask for it, ignore this email."], { href: link, label: "Sign in" }),
    }).catch((e: unknown) => console.error(JSON.stringify({ msg: "login email failed", error: String(e) })));
    c.executionCtx.waitUntil(send);
    return c.body(null, 204);
  });

  app.get("/auth/verify", async (c) => {
    const token = c.req.query("token") ?? "";
    const t = now();
    const row = token
      ? await c.env.DB.prepare("UPDATE login_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ? RETURNING email")
          .bind(t, await sha256Hex(token), t)
          .first<{ email: string }>()
      : null;
    if (!row) return c.redirect("/signin?error=invalid_link", 302);
    const { user } = await signIn(c.env, row.email);
    await createSession(c, user.id);
    const next = c.req.query("next");
    return c.redirect(next && next.startsWith("/") && !next.startsWith("//") ? next : "/", 302);
  });

  app.get("/auth/invite", async (c) => {
    const token = c.req.query("token") ?? "";
    const t = now();
    const inv = token
      ? await c.env.DB.prepare("DELETE FROM invites WHERE token_hash = ? AND expires_at > ? RETURNING org_id, email, role").bind(await sha256Hex(token), t).first<{ org_id: string; email: string; role: string }>()
      : null;
    if (!inv) return c.redirect("/signin?error=invalid_invite", 302);
    const { user } = await signIn(c.env, inv.email);
    await c.env.DB.batch([
      c.env.DB.prepare("INSERT INTO members (org_id, user_id, role, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (org_id, user_id) DO NOTHING").bind(inv.org_id, user.id, inv.role, t),
      c.env.DB.prepare("INSERT INTO audit_log (id, org_id, user_id, action, target, at) VALUES (?, ?, ?, 'member.join', ?, ?)").bind(newId("aud", t), inv.org_id, user.id, user.id, t),
    ]);
    await createSession(c, user.id);
    return c.redirect("/", 302);
  });

  app.post("/auth/logout", async (c) => {
    checkOrigin(c);
    const header = c.req.header("authorization") ?? "";
    const t = now();
    if (header.startsWith(`Bearer ${KEY_PREFIX.pat}`)) {
      await c.env.DB.prepare("UPDATE pats SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL").bind(t, await sha256Hex(header.slice(7).trim())).run();
      return c.body(null, 204);
    }
    const token = getCookie(c, SESSION_COOKIE);
    if (token) await c.env.DB.prepare("UPDATE sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL").bind(t, await sha256Hex(token)).run();
    deleteCookie(c, SESSION_COOKIE, { path: "/", secure: true });
    return c.body(null, 204);
  });

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
}

/** Approve a device code for the signed-in user (POST /api/device/approve). */
export async function approveDevice(env: Env, userId: string, code: string): Promise<boolean> {
  const t = now();
  const r = await env.DB.prepare("UPDATE device_codes SET user_id = ?, approved_at = ? WHERE user_code = ? AND approved_at IS NULL AND expires_at > ?")
    .bind(userId, t, code.toUpperCase().trim(), t)
    .run();
  return (r.meta.changes ?? 0) > 0;
}


// /api/me, orgs, members, invites, sessions, PATs, device approval.
import { newId, type Me, type Role, type Session } from "@paynp/shared";
import type { Context, Hono } from "hono";
import { approveDevice, INVITE_TTL, issuePat } from "../auth.ts";
import { htmlMail, sendMail } from "../email.ts";
import { audit, requireOrg } from "../lib/access.ts";
import { appOrigin, badRequest, decodeCursor, forbidden, HttpError, isEmail, notFound, now, page, parseLimit, randomToken, readJson, sha256Hex, str } from "../lib/util.ts";
import type { AppEnv } from "../types.ts";

const ROLES: Role[] = ["owner", "admin", "viewer"];

function parseRole(v: unknown): Role {
  if (typeof v !== "string" || !ROLES.includes(v as Role)) throw badRequest("role must be owner, admin or viewer");
  return v as Role;
}

export function registerAccount(api: Hono<AppEnv>) {
  api.get("/me", async (c) => {
    const user = c.get("user");
    const orgs = await c.env.DB.prepare("SELECT o.id, o.name, m.role FROM members m JOIN orgs o ON o.id = m.org_id WHERE m.user_id = ? ORDER BY o.created_at")
      .bind(user.id)
      .all<{ id: string; name: string; role: Role }>();
    const me: Me & { user: { digest: boolean } } = {
      user: { id: user.id, email: user.email, name: user.name, digest: !user.digest_opt_out },
      orgs: orgs.results,
    };
    return c.json(me);
  });

  // Addition to the spec table: rename yourself and opt out of the daily digest.
  api.patch("/me", async (c) => {
    const body = await readJson(c.req.raw);
    const user = c.get("user");
    const name = body.name === undefined ? user.name : (str(body, "name", { max: 100 }) ?? null);
    const optOut = body.digest === undefined ? user.digest_opt_out : body.digest === false ? 1 : body.digest === true ? 0 : null;
    if (optOut === null) throw badRequest("digest must be a boolean");
    await c.env.DB.prepare("UPDATE users SET name = ?, digest_opt_out = ? WHERE id = ?").bind(name, optOut, user.id).run();
    return c.json({ user: { id: user.id, email: user.email, name, digest: !optOut } });
  });

  api.post("/orgs", async (c) => {
    const body = await readJson(c.req.raw);
    const name = str(body, "name", { required: true, max: 100 })!;
    const user = c.get("user");
    const t = now();
    const id = newId("org", t);
    await c.env.DB.batch([
      c.env.DB.prepare("INSERT INTO orgs (id, name, created_at) VALUES (?, ?, ?)").bind(id, name, t),
      c.env.DB.prepare("INSERT INTO members (org_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)").bind(id, user.id, t),
      audit(c.env, id, user.id, "org.create", id),
    ]);
    return c.json({ id, name, role: "owner", created_at: t }, 201);
  });

  api.patch("/orgs/:org", async (c) => {
    const orgId = c.req.param("org");
    await requireOrg(c, orgId, "admin");
    const name = str(await readJson(c.req.raw), "name", { required: true, max: 100 })!;
    await c.env.DB.batch([c.env.DB.prepare("UPDATE orgs SET name = ? WHERE id = ?").bind(name, orgId), audit(c.env, orgId, c.get("user").id, "org.rename", orgId, { name })]);
    return c.json(await c.env.DB.prepare("SELECT * FROM orgs WHERE id = ?").bind(orgId).first());
  });

  api.get("/orgs/:org/members", async (c) => {
    const orgId = c.req.param("org");
    await requireOrg(c, orgId, "admin");
    const limit = parseLimit(c.req.query("limit"));
    const cur = decodeCursor(c.req.query("cursor"));
    const rows = await c.env.DB.prepare(
      `SELECT u.id AS user_id, u.email, u.name, m.role, m.created_at FROM members m JOIN users u ON u.id = m.user_id
       WHERE m.org_id = ? ${cur ? "AND (m.created_at, u.id) > (?, ?)" : ""} ORDER BY m.created_at, u.id LIMIT ?`,
    )
      .bind(...[orgId, ...(cur ?? []), limit + 1])
      .all<{ user_id: string; email: string; name: string | null; role: Role; created_at: number }>();
    return c.json(page(rows.results, limit, (r) => [r.created_at, r.user_id]));
  });

  // Addition: list and cancel pending invites.
  api.get("/orgs/:org/invites", async (c) => {
    const orgId = c.req.param("org");
    await requireOrg(c, orgId, "admin");
    const rows = await c.env.DB.prepare("SELECT id, email, role, expires_at FROM invites WHERE org_id = ? AND expires_at > ? ORDER BY expires_at DESC LIMIT 200").bind(orgId, now()).all();
    return c.json({ items: rows.results, next_cursor: null });
  });

  api.delete("/orgs/:org/invites/:id", async (c) => {
    const orgId = c.req.param("org");
    await requireOrg(c, orgId, "admin");
    const r = await c.env.DB.prepare("DELETE FROM invites WHERE id = ? AND org_id = ?").bind(c.req.param("id"), orgId).run();
    if (!r.meta.changes) throw notFound("invite");
    return c.body(null, 204);
  });

  api.post("/orgs/:org/invites", async (c) => {
    const orgId = c.req.param("org");
    const myRole = await requireOrg(c, orgId, "admin");
    const body = await readJson(c.req.raw);
    const email = str(body, "email", { required: true, max: 254 })!.toLowerCase();
    if (!isEmail(email)) throw badRequest("email is not valid");
    const role = parseRole(body.role ?? "viewer");
    if (role === "owner" && myRole !== "owner") throw forbidden("only owners can invite owners");
    const already = await c.env.DB.prepare("SELECT 1 FROM members m JOIN users u ON u.id = m.user_id WHERE m.org_id = ? AND u.email = ?").bind(orgId, email).first();
    if (already) throw new HttpError(409, "conflict", "already a member");
    const token = randomToken();
    const t = now();
    const id = newId("inv", t);
    const org = await c.env.DB.prepare("SELECT name FROM orgs WHERE id = ?").bind(orgId).first<{ name: string }>();
    await c.env.DB.batch([
      c.env.DB.prepare("DELETE FROM invites WHERE org_id = ? AND email = ?").bind(orgId, email),
      c.env.DB.prepare("INSERT INTO invites (id, org_id, email, role, token_hash, expires_at) VALUES (?, ?, ?, ?, ?, ?)").bind(id, orgId, email, role, await sha256Hex(token), t + INVITE_TTL),
      audit(c.env, orgId, c.get("user").id, "invite.create", email, { role }),
    ]);
    const link = `${appOrigin(c.env, c.req.raw)}/auth/invite?token=${token}`;
    const by = c.get("user").email;
    c.executionCtx.waitUntil(
      sendMail(c.env, {
        to: [email],
        subject: `${by} invited you to ${org?.name ?? "an org"} on discerns`,
        text: `${by} invited you to ${org?.name} on discerns as ${role}.\n\nAccept: ${link}\n\nThe link expires in 7 days.`,
        html: htmlMail(`Join ${org?.name} on discerns`, [`${by} invited you as ${role}. The link expires in 7 days.`], { href: link, label: "Accept invite" }),
      }).catch((e: unknown) => console.error(JSON.stringify({ msg: "invite email failed", error: String(e) }))),
    );
    return c.json({ id, email, role, expires_at: t + INVITE_TTL }, 201);
  });

  async function memberChange(c: Context<AppEnv>, newRole: Role | null) {
    const orgId = c.req.param("org")!;
    const userId = c.req.param("user")!;
    const myRole = await requireOrg(c, orgId, "admin");
    const target = await c.env.DB.prepare("SELECT role FROM members WHERE org_id = ? AND user_id = ?").bind(orgId, userId).first<{ role: Role }>();
    if (!target) throw notFound("member");
    if ((target.role === "owner" || newRole === "owner") && myRole !== "owner") throw forbidden("only owners can change owners");
    if (target.role === "owner" && newRole !== "owner") {
      const owners = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM members WHERE org_id = ? AND role = 'owner'").bind(orgId).first<{ n: number }>();
      if ((owners?.n ?? 0) <= 1) throw new HttpError(409, "last_owner", "an org needs at least one owner");
    }
    const me = c.get("user").id;
    if (newRole) {
      await c.env.DB.batch([
        c.env.DB.prepare("UPDATE members SET role = ? WHERE org_id = ? AND user_id = ?").bind(newRole, orgId, userId),
        audit(c.env, orgId, me, "member.role", userId, { role: newRole }),
      ]);
      return c.json({ user_id: userId, role: newRole });
    }
    await c.env.DB.batch([c.env.DB.prepare("DELETE FROM members WHERE org_id = ? AND user_id = ?").bind(orgId, userId), audit(c.env, orgId, me, "member.remove", userId)]);
    return c.body(null, 204);
  }

  api.patch("/orgs/:org/members/:user", async (c) => memberChange(c, parseRole((await readJson(c.req.raw)).role)));
  api.delete("/orgs/:org/members/:user", async (c) => memberChange(c, null));

  // Sessions live in Better Auth's auth_session (ISO dates); the API keeps its epoch-ms shape.
  api.get("/sessions", async (c) => {
    const limit = parseLimit(c.req.query("limit"));
    const cur = decodeCursor(c.req.query("cursor"));
    const rows = await c.env.DB.prepare(
      `SELECT id, userAgent AS user_agent, ipAddress AS ip, createdAt, updatedAt FROM auth_session WHERE userId = ? AND expiresAt > ?
       ${cur ? "AND (updatedAt, id) < (?, ?)" : ""} ORDER BY updatedAt DESC, id DESC LIMIT ?`,
    )
      .bind(...[c.get("user").id, new Date().toISOString(), ...(cur ? [new Date(Number(cur[0])).toISOString(), cur[1]] : []), limit + 1])
      .all<{ id: string; user_agent: string | null; ip: string | null; createdAt: string; updatedAt: string }>();
    const current = c.get("sessionId");
    const sessions = rows.results.map((r) => ({ id: r.id, user_agent: r.user_agent, ip: r.ip, created_at: Date.parse(r.createdAt), last_seen_at: Date.parse(r.updatedAt) }));
    const p = page(sessions, limit, (r) => [r.last_seen_at, r.id]);
    return c.json({ items: p.items.map((s): Session => ({ ...s, current: s.id === current })), next_cursor: p.next_cursor });
  });

  api.delete("/sessions/:id", async (c) => {
    const r = await c.env.DB.prepare("DELETE FROM auth_session WHERE id = ? AND userId = ?").bind(c.req.param("id"), c.get("user").id).run();
    if (!r.meta.changes) throw notFound("session");
    return c.body(null, 204);
  });

  api.get("/pats", async (c) => {
    const limit = parseLimit(c.req.query("limit"));
    const cur = decodeCursor(c.req.query("cursor"));
    const rows = await c.env.DB.prepare(
      `SELECT id, name, created_at, last_used_at FROM pats WHERE user_id = ? AND revoked_at IS NULL
       ${cur ? "AND (created_at, id) < (?, ?)" : ""} ORDER BY created_at DESC, id DESC LIMIT ?`,
    )
      .bind(...[c.get("user").id, ...(cur ?? []), limit + 1])
      .all<{ id: string; name: string | null; created_at: number; last_used_at: number | null }>();
    const currentPat = c.get("patId");
    const p = page(rows.results, limit, (r) => [r.created_at, r.id]);
    return c.json({ items: p.items.map((r) => ({ ...r, current: r.id === currentPat })), next_cursor: p.next_cursor });
  });

  // Tokens for MCP clients and scripts. Only from a browser session: a token cannot mint more tokens.
  api.post("/pats", async (c) => {
    if (c.get("authKind") !== "session") throw new HttpError(403, "forbidden", "create tokens from the dashboard");
    const body = await readJson(c.req.raw);
    const name = str(body, "name", { max: 80 }) ?? "API token";
    const token = await issuePat(c.env, c.get("user").id, name);
    return c.json({ token, name }, 201);
  });

  api.delete("/pats/:id", async (c) => {
    const id = c.req.param("id") === "current" ? c.get("patId") : c.req.param("id");
    if (!id) throw notFound("token");
    const r = await c.env.DB.prepare("UPDATE pats SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL").bind(now(), id, c.get("user").id).run();
    if (!r.meta.changes) throw notFound("token");
    return c.body(null, 204);
  });

  // Addition: the /device page posts the code it shows here.
  api.post("/device/approve", async (c) => {
    if (c.get("authKind") !== "session") throw forbidden("approve device logins from a browser session");
    const code = str(await readJson(c.req.raw), "user_code", { required: true, max: 20 })!;
    if (!(await approveDevice(c.env, c.get("user").id, code))) throw notFound("device code (expired or already used)");
    return c.json({ approved: true });
  });
}


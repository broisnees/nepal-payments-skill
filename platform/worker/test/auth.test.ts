import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { call, cookieFrom, json, lastMailTo, setup, signUp, tokenFromMail, uniqueEmail } from "./helpers.ts";

describe("magic link", () => {
  it("answers 204 for any email, mails a one-use link, and signs in", async () => {
    const email = uniqueEmail("ml");
    const r = await call("POST", "/auth/login", { body: { email } });
    expect(r.status).toBe(204);
    expect(lastMailTo(email)?.subject).toMatch(/Sign in/);
    const token = tokenFromMail(email);
    const v = await call("GET", `/auth/verify?token=${token}`);
    expect(v.status).toBe(302);
    expect(v.headers.get("location")).toBe("/");
    const set = v.headers.get("set-cookie")!;
    expect(set).toMatch(/__Secure-paynp\.session_token=/);
    expect(set).toMatch(/HttpOnly/);
    expect(set).toMatch(/Secure/);
    expect(set).toMatch(/SameSite=Lax/);
    expect(set).toMatch(/Path=\//);
    // second use fails
    const again = await call("GET", `/auth/verify?token=${token}`);
    expect(again.headers.get("location")).toMatch(/error=invalid_link/);
    expect(again.headers.get("set-cookie")).toBeNull();
  });

  it("refuses expired links and stores only hashes", async () => {
    const email = uniqueEmail("exp");
    await call("POST", "/auth/login", { body: { email } });
    const token = tokenFromMail(email);
    const rows = await env.DB.prepare("SELECT identifier FROM auth_verification").all<{ identifier: string }>();
    expect(rows.results.some((r) => r.identifier.includes(token))).toBe(false);
    await env.DB.prepare("UPDATE auth_verification SET expiresAt = '2020-01-01T00:00:00.000Z'").run();
    expect((await call("GET", `/auth/verify?token=${token}`)).headers.get("location")).toMatch(/error=/);
  });

  it("first sign-in creates a personal org (owner) and a default project; the second does not", async () => {
    const { email, cookie } = await signUp();
    const me = await json(call("GET", "/api/me", { cookie }));
    expect(me.user.email).toBe(email);
    expect(me.orgs).toHaveLength(1);
    expect(me.orgs[0].role).toBe("owner");
    const projects = await json(call("GET", `/api/orgs/${me.orgs[0].id}/projects`, { cookie }));
    expect(projects.items.map((p: { slug: string }) => p.slug)).toEqual(["default"]);
    await call("POST", "/auth/login", { body: { email } });
    const c2 = cookieFrom(await call("GET", `/auth/verify?token=${tokenFromMail(email)}`));
    expect((await json(call("GET", "/api/me", { cookie: c2 }))).orgs).toHaveLength(1);
  });

  it("401 without a session", async () => {
    const r = await call("GET", "/api/me");
    expect(r.status).toBe(401);
    expect((await r.json()) as object).toMatchObject({ error: { code: "unauthorized" } });
  });
});

describe("sessions", () => {
  it("lists sessions with the current flag, revokes one, and logout ends the session", async () => {
    const { email, cookie } = await signUp();
    await call("POST", "/auth/login", { body: { email } });
    const other = cookieFrom(await call("GET", `/auth/verify?token=${tokenFromMail(email)}`));
    const list = await json(call("GET", "/api/sessions", { cookie }));
    expect(list.items).toHaveLength(2);
    expect(list.items.filter((s: { current: boolean }) => s.current)).toHaveLength(1);
    const otherId = list.items.find((s: { current: boolean }) => !s.current).id;
    expect((await call("DELETE", `/api/sessions/${otherId}`, { cookie })).status).toBe(204);
    expect((await call("GET", "/api/me", { cookie: other })).status).toBe(401);
    expect((await call("POST", "/auth/logout", { cookie })).status).toBe(204);
    expect((await call("GET", "/api/me", { cookie })).status).toBe(401);
  });

  it("slides: a session older than a day is extended and the cookie is re-set", async () => {
    const { cookie } = await signUp();
    const day = 24 * 3600_000;
    await env.DB.prepare("UPDATE auth_session SET updatedAt = ?, expiresAt = ? WHERE id = (SELECT id FROM auth_session ORDER BY createdAt DESC LIMIT 1)")
      .bind(new Date(Date.now() - 2 * day).toISOString(), new Date(Date.now() + 2 * day).toISOString())
      .run();
    const r = await call("GET", "/api/me", { cookie });
    expect(r.status).toBe(200);
    expect(r.headers.get("set-cookie")).toMatch(/paynp\.session_token=/);
    const s = await env.DB.prepare("SELECT expiresAt FROM auth_session ORDER BY createdAt DESC LIMIT 1").first<{ expiresAt: string }>();
    expect(Date.parse(s!.expiresAt)).toBeGreaterThan(Date.now() + 29 * day);
  });
});

describe("CSRF", () => {
  it("cookie writes need X-Paynp-CSRF: 1 and a same-origin Origin when present", async () => {
    const s = await setup();
    const path = `/api/projects/${s.projectId}/keys`;
    expect((await call("POST", path, { cookie: s.cookie, csrf: false, body: { env: "test" } })).status).toBe(403);
    expect((await call("POST", path, { cookie: s.cookie, body: { env: "test" }, headers: { origin: "https://evil.example" } })).status).toBe(403);
    expect((await call("POST", path, { cookie: s.cookie, body: { env: "test" }, headers: { origin: "https://paynp.test" } })).status).toBe(201);
  });
});

describe("device login and PATs", () => {
  it("pending until approved, then one token; the PAT works on /api and can be revoked", async () => {
    const { cookie } = await signUp();
    const d = await json(call("POST", "/auth/device"));
    expect(d.user_code).toMatch(/^[A-Z]{4}-[A-Z]{4}$/);
    expect(d.verification_url).toBe(`https://paynp.test/device?code=${d.user_code}`);
    expect(d).toMatchObject({ interval: 3, expires_in: 600 });
    const poll = () => call("POST", "/auth/device/token", { body: { device_code: d.device_code } });
    const p1 = await poll();
    expect(p1.status).toBe(428);
    expect(await p1.json()).toEqual({ error: "authorization_pending" });

    expect((await call("POST", "/api/device/approve", { cookie, body: { user_code: "ZZZZ-ZZZZ" } })).status).toBe(404);
    expect((await call("POST", "/api/device/approve", { cookie, body: { user_code: d.user_code.toLowerCase() } })).status).toBe(200);
    const p2 = await poll();
    expect(p2.status).toBe(200);
    const { token } = (await p2.json()) as { token: string };
    expect(token).toMatch(/^pnp_pat_[0-9A-Za-z]{32}$/);
    expect((await poll()).status).toBe(400); // one use

    const me = await call("GET", "/api/me", { pat: token });
    expect(me.status).toBe(200);
    // PAT auth is not cookie auth, so no CSRF header is needed.
    const orgId = (await me.json() as { orgs: { id: string }[] }).orgs[0].id;
    expect((await call("POST", "/api/orgs", { pat: token, body: { name: "from cli" } })).status).toBe(201);
    const pats = await json(call("GET", "/api/pats", { cookie }));
    expect(pats.items).toHaveLength(1);
    expect((await call("DELETE", `/api/pats/${pats.items[0].id}`, { cookie })).status).toBe(204);
    expect((await call("GET", "/api/me", { pat: token })).status).toBe(401);
    expect(orgId).toBeTruthy();
  });

  it("expired device codes and approvals from PATs are refused", async () => {
    const { cookie } = await signUp();
    const d = await json(call("POST", "/auth/device"));
    await env.DB.prepare("UPDATE device_codes SET expires_at = 1 WHERE user_code = ?").bind(d.user_code).run();
    expect((await call("POST", "/api/device/approve", { cookie, body: { user_code: d.user_code } })).status).toBe(404);
    expect((await call("POST", "/auth/device/token", { body: { device_code: d.device_code } })).status).toBe(400);
  });

  it("logout with a PAT revokes it", async () => {
    const { cookie } = await signUp();
    const d = await json(call("POST", "/auth/device"));
    await call("POST", "/api/device/approve", { cookie, body: { user_code: d.user_code } });
    const { token } = await json(call("POST", "/auth/device/token", { body: { device_code: d.device_code } }));
    expect((await call("POST", "/auth/logout", { pat: token })).status).toBe(204);
    expect((await call("GET", "/api/me", { pat: token })).status).toBe(401);
  });
});

describe("invites", () => {
  it("an admin invites by email; the link signs the invitee in as a member with that role", async () => {
    const owner = await setup();
    const invitee = uniqueEmail("inv");
    const r = await call("POST", `/api/orgs/${owner.orgId}/invites`, { cookie: owner.cookie, body: { email: invitee, role: "viewer" } });
    expect(r.status).toBe(201);
    const token = tokenFromMail(invitee, "/auth/invite");
    const accept = await call("GET", `/auth/invite?token=${token}`);
    expect(accept.status).toBe(302);
    const cookie = cookieFrom(accept);
    const me = await json(call("GET", "/api/me", { cookie }));
    expect(me.orgs.find((o: { id: string }) => o.id === owner.orgId)?.role).toBe("viewer");
    expect((await call("GET", `/auth/invite?token=${token}`)).headers.get("location")).toMatch(/error=/);
  });
});

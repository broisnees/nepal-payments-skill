import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { call, cookieFrom, json, lastMailTo, signUp, tokenFromMail, uniqueEmail } from "./helpers.ts";

const signupBody = (email: string, name = "Sita Sharma", org = "Himal Traders") => ({ email, name, org });

describe("sign-up", () => {
  it("a new email gets an account with the typed name and an org with the typed company name", async () => {
    const email = uniqueEmail("su");
    const r = await call("POST", "/auth/signup", { body: signupBody(email.toUpperCase(), "  Sita   Sharma ", " Himal Traders ") });
    expect(r.status).toBe(204);
    expect(lastMailTo(email)?.subject).toMatch(/Sign in/);
    const v = await call("GET", `/auth/verify?token=${tokenFromMail(email)}`);
    expect(v.headers.get("location")).toBe("/");
    const cookie = cookieFrom(v);
    const me = await json(call("GET", "/api/me", { cookie }));
    expect(me.user).toMatchObject({ email, name: "Sita Sharma" });
    expect(me.orgs).toHaveLength(1);
    expect(me.orgs[0]).toMatchObject({ name: "Himal Traders", role: "owner" });
    const projects = await json(call("GET", `/api/orgs/${me.orgs[0].id}/projects`, { cookie }));
    expect(projects.items.map((p: { slug: string }) => p.slug)).toEqual(["default"]);
  });

  it("an existing email just signs in: name, orgs and projects stay as they were", async () => {
    const { email, cookie } = await signUp();
    const before = await json(call("GET", "/api/me", { cookie }));
    const r = await call("POST", "/auth/signup", { body: signupBody(email, "Someone Else", "Another Company") });
    expect(r.status).toBe(204);
    const c2 = cookieFrom(await call("GET", `/auth/verify?token=${tokenFromMail(email)}`));
    const after = await json(call("GET", "/api/me", { cookie: c2 }));
    expect(after.user.id).toBe(before.user.id);
    expect(after.user.name).toBe(before.user.name);
    expect(after.orgs).toEqual(before.orgs);
    const orgs = await env.DB.prepare("SELECT COUNT(*) AS n FROM orgs WHERE name = 'Another Company'").first<{ n: number }>();
    expect(orgs!.n).toBe(0);
  });

  it("answers the same for new and existing emails (no account enumeration)", async () => {
    const { email: existing } = await signUp();
    const fresh = uniqueEmail("enum");
    const a = await call("POST", "/auth/signup", { body: signupBody(existing) });
    const b = await call("POST", "/auth/signup", { body: signupBody(fresh) });
    expect([a.status, b.status]).toEqual([204, 204]);
    expect(await a.text()).toBe(await b.text());
    expect([...a.headers.keys()].sort()).toEqual([...b.headers.keys()].sort());
    expect(lastMailTo(existing)?.subject).toBe(lastMailTo(fresh)?.subject);
  });

  it("rejects missing, overlong or malformed fields without storing a token", async () => {
    const email = uniqueEmail("bad");
    const bad: Record<string, unknown>[] = [
      { email, name: "   ", org: "Acme" },
      { email, name: "Ram", org: "x".repeat(81) },
      { email, name: "y".repeat(81), org: "Acme" },
      { email, name: "Ram\u0000", org: "Acme" },
      { email, name: 42, org: "Acme" },
      { email: "not-an-email", name: "Ram", org: "Acme" },
      { name: "Ram", org: "Acme" },
    ];
    for (const body of bad) {
      const r = await call("POST", "/auth/signup", { body });
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(((await r.json()) as { error: { code: string } }).error.code).toBe("bad_request");
    }
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM signup_intents WHERE email = ?").bind(email).first<{ n: number }>();
    expect(n!.n).toBe(0);
    expect(lastMailTo(email)).toBeUndefined();
  });

  it("an email alone is enough: the account gets the default org name", async () => {
    const email = uniqueEmail("only");
    expect((await call("POST", "/auth/signup", { body: { email } })).status).toBe(204);
    const cookie = cookieFrom(await call("GET", `/auth/verify?token=${tokenFromMail(email)}`));
    const me = await json(call("GET", "/api/me", { cookie }));
    expect(me.user.name).toBeNull();
    expect(me.orgs[0].name).toBe(`${email.split("@")[0]}'s org`);
  });

  it("refuses a cross-origin sign-up", async () => {
    const r = await call("POST", "/auth/signup", { body: signupBody(uniqueEmail("x")), headers: { origin: "https://evil.example" } });
    expect(r.status).toBe(403);
  });

  it("plain sign-in links (no profile) still create the default org name", async () => {
    const email = uniqueEmail("plain");
    await call("POST", "/auth/login", { body: { email } });
    const cookie = cookieFrom(await call("GET", `/auth/verify?token=${tokenFromMail(email)}`));
    const me = await json(call("GET", "/api/me", { cookie }));
    expect(me.user.name).toBeNull();
    expect(me.orgs[0].name).toBe(`${email.split("@")[0]}'s org`);
  });
});

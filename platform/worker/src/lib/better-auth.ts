// The Better Auth instance: magic link, sessions, and GitHub / Google sign-in when their secrets are set. One per
// isolate, built on the first request. Domain rows (users, orgs, projects) are provisioned in auth.ts on first use.
import { newId } from "@paynp/shared";
import { betterAuth } from "better-auth";
import { magicLink } from "better-auth/plugins";
import { htmlMail, sendMail } from "../email.ts";
import { MINUTE } from "./util.ts";

export const MAGIC_LINK_TTL = 15 * MINUTE;
export const SESSION_TTL_S = 30 * 24 * 3600;
export const COOKIE_PREFIX = "paynp";
export const SESSION_COOKIE_NAME = `${COOKIE_PREFIX}.session_token`;

/** Links minted for an invite are handed back to the invite route instead of being mailed. Keyed by a one-use nonce. */
const captured = new Map<string, string>();

export function takeCapturedLink(nonce: string): string | undefined {
  const url = captured.get(nonce);
  captured.delete(nonce);
  return url;
}

export function enabledSocialProviders(env: Env): ("github" | "google")[] {
  const out: ("github" | "google")[] = [];
  if (env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET) out.push("github");
  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) out.push("google");
  return out;
}

function build(env: Env) {
  const origins = ["https://discerns.app", "https://paynp.discerns.app", "http://localhost:5173", "http://localhost:8787"];
  if (env.APP_URL) origins.push(new URL(env.APP_URL).origin);
  return betterAuth({
    appName: "discerns",
    // Without APP_URL (tests, wrangler dev) links point at the local Worker.
    baseURL: env.APP_URL || "http://localhost:8787",
    basePath: "/auth",
    secret: env.BETTER_AUTH_SECRET,
    trustedOrigins: origins,
    database: env.DB,
    user: { modelName: "auth_user" },
    session: { modelName: "auth_session", expiresIn: SESSION_TTL_S, updateAge: 24 * 3600 },
    account: { modelName: "auth_account", accountLinking: { enabled: true, trustedProviders: ["github", "google"] } },
    verification: { modelName: "auth_verification" },
    socialProviders: {
      ...(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET ? { github: { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET } } : {}),
      ...(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET ? { google: { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET } } : {}),
    },
    advanced: {
      cookiePrefix: COOKIE_PREFIX,
      useSecureCookies: true,
      database: { generateId: ({ model }) => (model === "user" || model === "auth_user" ? newId("usr") : crypto.randomUUID()) },
      ipAddress: { ipAddressHeaders: ["cf-connecting-ip", "x-forwarded-for"] },
    },
    // Workers keep no memory between isolates; auth.ts limits sign-in mail with the AUTH_LIMITER binding instead.
    rateLimit: { enabled: false },
    telemetry: { enabled: false },
    plugins: [
      magicLink({
        expiresIn: MAGIC_LINK_TTL / 1000,
        storeToken: "hashed",
        async sendMagicLink({ email, url, token, metadata }) {
          // Our own short link on the same origin: /auth/verify forwards to Better Auth's /auth/magic-link/verify.
          const link = `${new URL(url).origin}/auth/verify?token=${token}`;
          const nonce = typeof metadata?.capture === "string" ? metadata.capture : null;
          if (nonce && captured.has(nonce)) {
            captured.set(nonce, link);
            return;
          }
          // One email for sign-in and sign-up, so it says nothing about whether the account exists.
          await sendMail(env, {
            to: [email],
            subject: "Sign in to discerns",
            text: `Sign in to discerns:\n\n${link}\n\nThe link works once and expires in 15 minutes. If you did not ask for it, ignore this email.`,
            html: htmlMail("Sign in to discerns", ["The link works once and expires in 15 minutes. If you did not ask for it, ignore this email."], { href: link, label: "Sign in" }),
          }).catch((e: unknown) => console.error(JSON.stringify({ msg: "login email failed", error: String(e) })));
        },
      }),
    ],
  });
}

export type Auth = ReturnType<typeof build>;

const cache = new WeakMap<Env, Auth>();

export function getAuth(env: Env): Auth {
  let a = cache.get(env);
  if (!a) cache.set(env, (a = build(env)));
  return a;
}

/** Reserves a nonce so the next magic link sent with metadata.capture = nonce is returned, not mailed. */
export function reserveCapture(): string {
  const nonce = crypto.randomUUID();
  captured.set(nonce, "");
  return nonce;
}

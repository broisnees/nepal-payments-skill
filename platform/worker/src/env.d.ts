// Bindings and secrets that are not in wrangler.jsonc for local dev. EMAIL is the Cloudflare Email Sending
// binding (Workers Paid), RESEND_API_KEY a secret; with neither, emails are logged to the console.
interface Env {
  EMAIL?: SendEmail;
  /** Secret. When set, mail goes through Resend instead of the binding. */
  RESEND_API_KEY?: string;
  /** Secret. Signs Better Auth cookies and tokens. */
  BETTER_AUTH_SECRET?: string;
  /** Secrets. GitHub and Google sign-in show up only when both halves are set. */
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /** Sign-in mail limiter (wrangler.jsonc). Optional so tests and `wrangler dev` run without it. */
  AUTH_LIMITER?: RateLimit;
  /** Secret. With it, Ask discerns and incident summaries use Claude; without it, Workers AI (the AI binding). */
  ANTHROPIC_API_KEY?: string;
  /** Overrides the Claude model (default claude-opus-5-5) or the Workers AI model. */
  AI_MODEL?: string;
  AI_MODEL_WORKERS?: string;
  /** "off" skips the per-minute gateway probes (tests). */
  GATEWAY_PROBES?: string;
  /** Workers AI. Optional so tests and local dev run without it. */
  AI?: Ai;
}

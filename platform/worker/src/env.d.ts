// Bindings and secrets that are not in wrangler.jsonc for local dev. EMAIL is the Cloudflare Email Sending
// binding (Workers Paid), RESEND_API_KEY a secret; with neither, emails are logged to the console.
interface Env {
  EMAIL?: SendEmail;
  /** Secret. When set, mail goes through Resend instead of the binding. */
  RESEND_API_KEY?: string;
}

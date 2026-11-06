// Email through Resend (RESEND_API_KEY secret) or the Cloudflare Email Sending binding (env.EMAIL, Workers
// Paid only). With neither (wrangler dev, tests) the message is logged to the console so the magic link can be
// copied from the terminal.

export interface Mail {
  to: string[];
  subject: string;
  text: string;
  html: string;
}

/** Messages that were logged instead of sent, newest last. Read by tests; capped so it never grows. */
export const devOutbox: Mail[] = [];

function parseFrom(from: string): string | { email: string; name: string } {
  const m = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(from);
  return m && m[1] ? { email: m[2], name: m[1] } : (m?.[2] ?? from.trim());
}

const RESEND_URL = "https://api.resend.com/emails";

export async function sendMail(env: Env, mail: Mail): Promise<void> {
  const to = [...new Set(mail.to)].slice(0, 50);
  if (!to.length) return;
  const from = env.EMAIL_FROM || "discerns <alerts@paynp.dev>";
  if (env.RESEND_API_KEY) {
    // Resend takes at most 50 recipients per message, which the slice above already guarantees.
    const res = await fetch(RESEND_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to, subject: mail.subject, text: mail.text, html: mail.html }),
    });
    if (!res.ok) throw new Error(`Resend answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return;
  }
  if (env.EMAIL) {
    await env.EMAIL.send({ to, from: parseFrom(from), subject: mail.subject, text: mail.text, html: mail.html });
    return;
  }
  console.log(`\n[discerns email] (no email provider configured, not sent)\nTo: ${to.join(", ")}\nSubject: ${mail.subject}\n\n${mail.text}\n`);
  devOutbox.push({ ...mail, to });
  if (devOutbox.length > 50) devOutbox.shift();
}

export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Minimal HTML wrapper: system fonts, square corners, one link button. */
export function htmlMail(title: string, paragraphs: string[], link?: { href: string; label: string }): string {
  const body = paragraphs.map((p) => `<p style="margin:0 0 12px">${escapeHtml(p)}</p>`).join("");
  const button = link
    ? `<p style="margin:20px 0"><a href="${escapeHtml(link.href)}" style="background:#111;color:#fff;padding:10px 16px;text-decoration:none;display:inline-block">${escapeHtml(link.label)}</a></p><p style="margin:0;color:#666;font-size:12px">${escapeHtml(link.href)}</p>`
    : "";
  return `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Inter,sans-serif;font-size:14px;line-height:1.5;color:#111;max-width:560px;margin:0 auto;padding:24px"><h1 style="font-size:18px;margin:0 0 16px">${escapeHtml(title)}</h1>${body}${button}</body></html>`;
}

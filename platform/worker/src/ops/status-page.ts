// Public payment status page for a buyer (SPEC-v2 4.2): GET /s/:token. Server-rendered HTML, no script, no PII
// beyond a masked phone. 404 once the link expires.
import type { Hono } from "hono";
import { now, sha256Hex } from "../lib/util.ts";
import type { AppEnv } from "../types.ts";
import { gatewayName } from "./checklist.ts";
import { nptTime, publicStatus, rs } from "./verdict.ts";

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

const CSS = `
:root{--bg:#fff;--fg:#111;--muted:#666;--line:#e5e5e5;--ok:#0a7d38;--warn:#9a6700;--bad:#b42318;color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--bg:#0d0d0d;--fg:#ededed;--muted:#9a9a9a;--line:#262626;--ok:#3fbf6f;--warn:#d4a72c;--bad:#f0645a}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:440px;margin:0 auto;padding:48px 16px}
.merchant{color:var(--muted);font-size:14px;margin:0 0 8px}
h1{font-size:28px;line-height:1.2;margin:0 0 4px}
.amount{font-size:20px;font-variant-numeric:tabular-nums;margin:0 0 24px}
.ok{color:var(--ok)}.warn{color:var(--warn)}.bad{color:var(--bad)}
dl{margin:0;border-top:1px solid var(--line)}
dl div{display:flex;justify-content:space-between;gap:16px;padding:10px 0;border-bottom:1px solid var(--line)}
dt{color:var(--muted)}dd{margin:0;text-align:right;overflow-wrap:anywhere}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:14px}
.note{margin:24px 0 0;color:var(--muted);font-size:14px}
`;

function page(title: string, body: string, status: number): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(title)}</title><style>${CSS}</style></head><body><main>${body}</main></body></html>`;
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-robots-tag": "noindex",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    },
  });
}

interface LinkView {
  project_name: string;
  gateway: string;
  amount_paisa: number | null;
  status: string;
  started_at: number;
  finished_at: number | null;
  updated_at: number;
  provider_ref: string | null;
  order_id: string | null;
  customer_mask: string | null;
  refunded_paisa: number;
}

export async function renderStatusPage(env: Env, token: string, t = now()): Promise<Response> {
  const notFound = () =>
    page("Link expired", `<h1>This link has expired</h1><p class="note">Payment status links work for a limited time. Ask the merchant for a new one.</p>`, 404);
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return notFound();
  const v = await env.DB.prepare(
    `SELECT pr.name AS project_name, p.gateway, p.amount_paisa, p.status, p.started_at, p.finished_at, p.updated_at, p.provider_ref, p.order_id, p.customer_mask, p.refunded_paisa
     FROM status_links l JOIN payments p ON p.project_id = l.project_id AND p.env = l.env AND p.attempt_id = l.attempt_id JOIN projects pr ON pr.id = l.project_id
     WHERE l.token_hash = ? AND l.expires_at > ?`,
  )
    .bind(await sha256Hex(token), t)
    .first<LinkView>();
  if (!v) return notFound();
  const s = publicStatus(v.status);
  const tone = s.paid ? "ok" : v.status === "pending" || v.status === "unknown" || v.status === "initiated" ? "warn" : v.status === "refunded" ? "" : "bad";
  const rows: [string, string, boolean?][] = [
    ["Paid with", gatewayName(v.gateway)],
    ["Time", `${nptTime(v.finished_at ?? v.started_at)} (Nepal time)`],
  ];
  if (v.order_id) rows.push(["Order", v.order_id, true]);
  if (v.provider_ref) rows.push(["Reference", v.provider_ref, true]);
  if (v.refunded_paisa > 0) rows.push(["Refunded", rs(v.refunded_paisa)]);
  // Only a masked phone is shown; an email mask or a name would be more than the page needs.
  if (v.customer_mask && !v.customer_mask.includes("@")) rows.push(["Phone", v.customer_mask, true]);
  const note = s.paid
    ? "The merchant has received this payment."
    : v.status === "refunded"
      ? "This payment was refunded. Refunds can take a few days to show in your wallet or bank."
      : "This payment is not complete. If money left your account, contact the merchant with the reference above.";
  const body = `<p class="merchant">${esc(v.project_name)}</p>
<h1 class="${tone}">${esc(s.word)}</h1>
<p class="amount">${v.amount_paisa != null ? esc(rs(v.amount_paisa)) : ""}</p>
<dl>${rows.map(([k, val, mono]) => `<div><dt>${esc(k)}</dt><dd${mono ? ' class="mono"' : ""}>${esc(val)}</dd></div>`).join("")}</dl>
<p class="note">${esc(note)}</p>`;
  return page(`${s.word}: ${v.project_name}`, body, 200);
}

export function registerStatusPage(app: Hono<AppEnv>) {
  app.get("/s/:token", (c) => renderStatusPage(c.env, c.req.param("token")));
}

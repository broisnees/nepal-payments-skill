// A small shop that takes real eSewa sandbox payments and reports every step to paynp, so the dashboard shows
// live traffic from a real website. Orders and attempts live in D1; a cron job confirms abandoned payments.
import { createPaynp } from "../../sdk-ts/src/index.ts";
import * as esewa from "./esewa";
import { PaymentError, type Outcome } from "./payments";

interface Env {
  DB: D1Database;
  PAYNP: Fetcher; // service binding to the paynp Worker: ingest without a public round trip
  PAYNP_KEY: string;
  PAYNP_ENDPOINT: string;
  DASHBOARD_URL: string;
}

const PRODUCTS = [
  { sku: "momo", name: "Buff momo, one plate", note: "Steamed, with tomato achar", paisa: 15000 },
  { sku: "notebook", name: "Lokta paper notebook", note: "Handmade in Baglung", paisa: 45000 },
  { sku: "topi", name: "Dhaka topi", note: "Palpali dhaka weave", paisa: 125000 },
];
const OPEN = ["initiated", "pending"];
const HOUR = 3_600_000;

const id = () => [...crypto.getRandomValues(new Uint8Array(10))].map((b) => b.toString(16).padStart(2, "0")).join("");
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const rupees = (p: number) => `Rs ${(p / 100).toLocaleString("en-IN", { minimumFractionDigits: p % 100 ? 2 : 0 })}`;

function tracer(env: Env) {
  return createPaynp({
    key: env.PAYNP_KEY,
    endpoint: env.PAYNP_ENDPOINT,
    fetch: (input, init) => env.PAYNP.fetch(new Request(input, init)),
  });
}

/** Applies the gateway's answer once (compare-and-set in SQL) and tells paynp what changed. */
async function settle(env: Env, paynp: ReturnType<typeof tracer>, attempt: Attempt, outcome: Outcome, source: "return" | "reconcile") {
  const to = outcome.status;
  if (to !== "paid" && to !== "failed" && to !== "canceled" && to !== "pending") return;
  const from = to === "pending" ? ["initiated"] : OPEN;
  const res = await env.DB.prepare(
    `UPDATE shop_attempts SET status = ?, provider_ref = COALESCE(provider_ref, ?) WHERE id = ? AND status IN (${from.map(() => "?").join(",")})`,
  )
    .bind(to, outcome.providerRef ?? null, attempt.id, ...from)
    .run();
  if (!res.meta.changes) return;
  paynp.statusChanged({ attemptId: attempt.id, gateway: "esewa", orderId: attempt.order_id, from: attempt.status, to, amountPaisa: attempt.amount_paisa, source });
  if (to === "paid") {
    // Fulfil here: ship the order, send the receipt. The UPDATE above guarantees this runs once.
    paynp.fulfilled({ attemptId: attempt.id, gateway: "esewa", orderId: attempt.order_id, amountPaisa: attempt.amount_paisa });
  }
}

interface Attempt {
  id: string;
  order_id: string;
  amount_paisa: number;
  status: string;
  provider_ref: string | null;
  created_at: number;
}

function page(title: string, body: string) {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Thamel Goods</title><style>
:root{--bg:#fff;--ink:#0a0a0a;--muted:#5c5c5c;--line:#e6e6e6;--tone:#ebfbe9;--tone-line:#c3ebc0;--ok:#12804f;--bad:#c8102e;--warn:#b54708}
@media (prefers-color-scheme:dark){:root{--bg:#0a0a0a;--ink:#ededed;--muted:#8f8f8f;--line:#232323;--tone:#0e1a10;--tone-line:#1f3d24;--ok:#3ecf8e;--bad:#ff6b81;--warn:#f2994a}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.55 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:760px;margin:0 auto;padding:40px 16px 80px}h1{font-size:30px;font-weight:600;letter-spacing:-.02em;margin:0}
.sub{color:var(--muted);margin:6px 0 28px}.grid{display:grid;gap:12px}@media(min-width:640px){.grid{grid-template-columns:repeat(3,1fr)}}
.card{border:1px solid var(--line);padding:18px;display:flex;flex-direction:column;gap:6px}.card h2{font-size:16px;font-weight:600;margin:0}
.note{color:var(--muted);font-size:14px}.price{font-weight:600;margin-top:auto;padding-top:8px}
button,.btn{appearance:none;border:0;background:#60bb46;color:#fff;font:600 15px system-ui;padding:10px 14px;cursor:pointer;width:100%;text-align:center;text-decoration:none;display:block}
button:hover{filter:brightness(.95)}.box{border:1px solid var(--tone-line);background:var(--tone);padding:14px 16px;font-size:14px;margin:24px 0}
.box code{font:13px ui-monospace,monospace}table{width:100%;border-collapse:collapse;font-size:14px;margin-top:8px}
td,th{text-align:left;padding:8px 6px;border-bottom:1px solid var(--line)}th{font-weight:500;color:var(--muted)}
.s-paid{color:var(--ok)}.s-failed,.s-canceled,.s-expired{color:var(--bad)}.s-initiated,.s-pending{color:var(--warn)}
a{color:inherit}.big{font-size:22px;font-weight:600;margin:8px 0}
</style></head><body><main>${body}</main></body></html>`,
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

async function home(env: Env) {
  const recent = await env.DB.prepare(
    "SELECT o.id, o.name, o.amount_paisa, a.status, a.created_at FROM shop_orders o JOIN shop_attempts a ON a.order_id = o.id ORDER BY a.created_at DESC LIMIT 8",
  ).all<{ id: string; name: string; amount_paisa: number; status: string; created_at: number }>();
  const cards = PRODUCTS.map(
    (p) => `<form class="card" method="post" action="/buy/${p.sku}"><h2>${esc(p.name)}</h2><span class="note">${esc(p.note)}</span>
<span class="price">${rupees(p.paisa)}</span><button>Pay with eSewa</button></form>`,
  ).join("");
  const rows = recent.results
    .map((r) => `<tr><td><a href="/orders/${r.id}">${esc(r.name)}</a></td><td>${rupees(r.amount_paisa)}</td><td class="s-${r.status}">${r.status}</td><td>${new Date(r.created_at).toLocaleTimeString("en-GB", { timeZone: "Asia/Kathmandu" })}</td></tr>`)
    .join("");
  return page(
    "Shop",
    `<h1>Thamel Goods</h1><p class="sub">A demo shop on eSewa's sandbox. Every payment shows up live in <a href="${esc(env.DASHBOARD_URL)}">paynp</a>.</p>
<div class="grid">${cards}</div>
<div class="box">eSewa test login: ID <code>9806800001</code>, password <code>Nepal@123</code>, token <code>123456</code>. Cancel on eSewa to see a failed payment.</div>
${rows ? `<h2 style="font-size:16px;margin:32px 0 0">Recent orders</h2><table><tr><th>Item</th><th>Amount</th><th>Status</th><th>Time (NPT)</th></tr>${rows}</table>` : ""}`,
  );
}

async function buy(env: Env, ctx: ExecutionContext, req: Request, sku: string) {
  const p = PRODUCTS.find((x) => x.sku === sku);
  if (!p) return new Response("Not found", { status: 404 });
  const paynp = tracer(env);
  const orderId = `ord_${id().slice(0, 12)}`;
  const attemptId = id();
  const t = Date.now();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO shop_orders (id, sku, name, amount_paisa, created_at) VALUES (?, ?, ?, ?, ?)").bind(orderId, p.sku, p.name, p.paisa, t),
    env.DB.prepare("INSERT INTO shop_attempts (id, order_id, amount_paisa, status, created_at) VALUES (?, ?, ?, 'initiated', ?)").bind(attemptId, orderId, p.paisa, t),
  ]);
  const gateway = paynp.wrapGateway("esewa", esewa);
  const origin = new URL(req.url).origin;
  try {
    const start = await gateway.startPayment({ attemptId, amountPaisa: p.paisa, returnUrl: `${origin}/pay/return/${attemptId}`, description: p.name });
    if (start.type === "redirect") return Response.redirect(start.url, 303);
    const inputs = Object.entries(start.fields).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join("");
    return new Response(
      `<!doctype html><title>Redirecting to eSewa</title><form id="pay" method="post" action="${esc(start.action)}">${inputs}<noscript><button>Continue to eSewa</button></noscript></form><script>document.getElementById("pay").submit()</script>`,
      { headers: { "content-type": "text/html; charset=utf-8" } },
    );
  } finally {
    ctx.waitUntil(paynp.flush());
  }
}

async function paymentReturn(env: Env, ctx: ExecutionContext, req: Request, attemptId: string) {
  const attempt = await env.DB.prepare("SELECT * FROM shop_attempts WHERE id = ?").bind(attemptId).first<Attempt>();
  if (!attempt) return new Response("Not found", { status: 404 });
  const url = new URL(req.url);
  const params: Record<string, string> = Object.fromEntries(url.searchParams);
  if (req.method === "POST") for (const [k, v] of await req.formData()) if (typeof v === "string") params[k] = v;
  const paynp = tracer(env);
  const gateway = paynp.wrapGateway("esewa", esewa);
  // eSewa's cancel and failure redirects carry no parameters, so the SDK can't tell them from the reconcile job.
  // Record the buyer coming back here; with parameters the wrapper records it itself.
  if (!Object.keys(params).length) paynp.callbackReceived({ attemptId, gateway: "esewa", orderId: attempt.order_id, method: req.method, source: "return" });
  try {
    const outcome = await gateway.confirmPayment({ attemptId, amountPaisa: attempt.amount_paisa, providerRef: attempt.provider_ref, params });
    await settle(env, paynp, attempt, outcome, "return");
    return Response.redirect(`${url.origin}/orders/${attempt.order_id}`, 303);
  } catch (err) {
    if (err instanceof PaymentError) return page("Not verified", `<h1>Payment could not be verified</h1><p class="sub">${esc(err.message)}</p><a class="btn" href="/">Back to the shop</a>`);
    return page("Try again", `<h1>eSewa didn't answer</h1><p class="sub">We'll keep checking in the background.</p><a class="btn" href="/orders/${attempt.order_id}">See the order</a>`);
  } finally {
    ctx.waitUntil(paynp.flush());
  }
}

async function orderPage(env: Env, orderId: string) {
  const o = await env.DB.prepare(
    "SELECT o.name, o.amount_paisa, a.id AS attempt, a.status FROM shop_orders o JOIN shop_attempts a ON a.order_id = o.id WHERE o.id = ? ORDER BY a.created_at DESC LIMIT 1",
  ).bind(orderId).first<{ name: string; amount_paisa: number; attempt: string; status: string }>();
  if (!o) return new Response("Not found", { status: 404 });
  const msg: Record<string, string> = {
    paid: "Paid. eSewa confirmed the payment through its status API.",
    initiated: "Not paid yet. If you cancelled on eSewa, the payment stays open until the reconcile job expires it.",
    pending: "eSewa says the payment is still in progress. The reconcile job checks again every minute.",
    failed: "The payment failed.",
    canceled: "The payment was cancelled.",
    expired: "eSewa never saw a completed payment, so the attempt expired.",
  };
  return page(
    "Order",
    `<p class="sub" style="margin:0 0 4px"><a href="/">Thamel Goods</a> / ${esc(orderId)}</p><h1>${esc(o.name)}</h1>
<p class="big s-${o.status}">${rupees(o.amount_paisa)} · ${o.status}</p><p class="sub">${msg[o.status] ?? ""}</p>
<div class="box">In paynp this payment is attempt <code>${esc(o.attempt)}</code>. Open the dashboard's Payments page to see its timeline.</div>
<a class="btn" href="/">Back to the shop</a>`,
  );
}

/** Confirms attempts the buyer never came back from, like the blog's reconcile job. */
async function reconcile(env: Env) {
  const now = Date.now();
  const open = await env.DB.prepare("SELECT * FROM shop_attempts WHERE status IN ('initiated','pending') AND created_at < ? AND created_at > ? LIMIT 20")
    .bind(now - 2 * 60_000, now - 3 * 24 * HOUR)
    .all<Attempt>();
  const paynp = tracer(env);
  const gateway = paynp.wrapGateway("esewa", esewa);
  for (const a of open.results) {
    try {
      const outcome = await gateway.confirmPayment({ attemptId: a.id, amountPaisa: a.amount_paisa, providerRef: a.provider_ref, params: {} });
      await settle(env, paynp, a, outcome, "reconcile");
      if (outcome.status === "not_found" && now - a.created_at > HOUR) {
        const res = await env.DB.prepare("UPDATE shop_attempts SET status = 'expired' WHERE id = ? AND status IN ('initiated','pending')").bind(a.id).run();
        if (res.meta.changes) paynp.statusChanged({ attemptId: a.id, gateway: "esewa", orderId: a.order_id, from: a.status, to: "expired", source: "reconcile" });
      }
    } catch (err) {
      console.error(`reconcile ${a.id} failed:`, err);
    }
  }
  await paynp.flush();
}

export default {
  async fetch(req, env, ctx) {
    const { pathname } = new URL(req.url);
    let m: RegExpMatchArray | null;
    if (pathname === "/" && req.method === "GET") return home(env);
    if ((m = pathname.match(/^\/buy\/([a-z]+)$/)) && req.method === "POST") return buy(env, ctx, req, m[1]);
    if ((m = pathname.match(/^\/pay\/return\/([0-9a-f]{20})$/)) && (req.method === "GET" || req.method === "POST")) return paymentReturn(env, ctx, req, m[1]);
    if ((m = pathname.match(/^\/orders\/(ord_[0-9a-f]+)$/))) return orderPage(env, m[1]);
    return new Response("Not found", { status: 404 });
  },
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(reconcile(env));
  },
} satisfies ExportedHandler<Env>;

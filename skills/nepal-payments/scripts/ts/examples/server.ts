/**
 * Runnable end-to-end example, zero dependencies (node:http). Works out of the box with the eSewa and
 * Fonepay sandboxes; other providers are enabled by env vars (see references/env.md).
 *
 *   node examples/server.ts            -> http://localhost:3000
 *   PUBLIC_URL=https://xyz.ngrok.app node examples/server.ts   (when the provider must reach you)
 *
 * The in-memory Map stands in for the payment_attempts table in references/architecture.md.
 * Everything else (server-side amount, verify-before-fulfil, conditional transition, reconciliation)
 * is the production pattern.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  createPayments,
  decideTransition,
  escapeHtml,
  OPEN_STATUSES,
  type AttemptStatus,
  ESEWA_SANDBOX,
  newOrderId,
  PaymentError,
  paymentsConfigFromEnv,
  renderAutoSubmitForm,
  type InitiateResult,
  type ProviderId,
} from "../src/index.ts";

const PORT = Number(process.env.PORT ?? 3000);
const PUBLIC_URL = (process.env.PUBLIC_URL ?? `http://localhost:${PORT}`).replace(/\/$/, "");

// Sandbox defaults so the demo works with no setup. Real deployments use env vars only.
const cfg = paymentsConfigFromEnv();
cfg.esewa ??= { env: "sandbox", ...ESEWA_SANDBOX };
cfg.fonepay ??= { env: "sandbox", merchantCode: "NBQM", secretKey: "a7e3512f5032480a83137793cb2021dc" };
const payments = createPayments(cfg);

// ---------------------------------------------------------------- "database"
interface Attempt {
  id: string; // provider order id (<= 20 chars)
  orderId: string;
  provider: ProviderId;
  amountPaisa: number;
  status: AttemptStatus;
  providerRef?: string;
  providerTxnId?: string | null;
  initiate?: InitiateResult;
  createdAt: number;
  /** Set on amount mismatch / missing amount / reconciliation cutoff: a human decides; automation stops. */
  reviewRequired?: boolean;
}
const PRODUCTS: Record<string, { name: string; pricePaisa: number }> = { "tshirt": { name: "Everest T-shirt", pricePaisa: 150000 } };
const orders = new Map<string, { productId: string; status: "unpaid" | "paid"; paidByAttempt?: string }>();
const attempts = new Map<string, Attempt>();
const OPEN = OPEN_STATUSES;
const FINAL: Attempt["status"][] = ["paid", "failed", "canceled", "expired", "refunded", "partially_refunded"];
const RECONCILE_CUTOFF_MS = 3 * 86_400_000;
const SESSION_WINDOW_MS = 60 * 60_000; // longest provider session (Khalti pidx ~60 min, eSewa ~50 min)

function fulfil(a: Attempt) {
  const o = orders.get(a.orderId);
  if (!o) return;
  if (o.status === "paid") {
    // Idempotent for the same attempt; a DIFFERENT paid attempt means the customer paid twice.
    if (o.paidByAttempt !== a.id) console.error(`[alert] duplicate payment: order ${a.orderId} already paid by ${o.paidByAttempt}; refund ${a.provider} ${a.id}`);
    return;
  }
  o.status = "paid";
  o.paidByAttempt = a.id;
  console.log(`[fulfil] order ${a.orderId} paid — ship it / grant access / send email here`);
}

/**
 * architecture.md §4: verify server-side, guard amount, transition exactly once.
 * Returns changed=true only when the stored status actually changed.
 */
async function verifyAndTransition(a: Attempt, callback?: Record<string, string>) {
  if (a.reviewRequired) return { attempt: a, changed: false };
  const result = await payments.adapter(a.provider).verify({
    orderId: a.id,
    amountPaisa: a.amountPaisa,
    providerRef: a.providerRef, // from OUR store, never from the callback
    callback,
  });
  // No await between the decision and the write => atomic in a single Node process. With a DB, apply it with
  // one conditional UPDATE guarded by the previous status (architecture.md §4).
  const prev = a.status;
  const d = decideTransition(prev, result, a.amountPaisa, Date.now() - a.createdAt, SESSION_WINDOW_MS);
  if (!d.next) return { attempt: a, changed: false };
  if (d.reviewRequired) console.error(`[alert] ${a.provider} ${a.id}: ${d.reason} — manual review`);
  if (d.latePaid && !d.reviewRequired) console.warn(`[alert] ${a.provider} ${a.id}: ${d.reason} — recovering`);
  a.status = d.next;
  a.reviewRequired = d.reviewRequired || a.reviewRequired;
  a.providerTxnId = result.transactionId ?? a.providerTxnId;
  console.log(`[verify] ${a.provider} ${a.id}: ${d.reason}`);
  if (a.status === "paid") fulfil(a);
  return { attempt: a, changed: true };
}

// ---------------------------------------------------------------- routes
const returnUrlFor = (provider: ProviderId, attemptId: string) =>
  provider === "esewa"
    ? `${PUBLIC_URL}/payments/esewa/return/${attemptId}` // eSewa appends ?data=; keep the id in the path
    : `${PUBLIC_URL}/payments/${provider}/return`;

async function createAttempt(orderId: string, provider: ProviderId): Promise<Attempt> {
  const order = orders.get(orderId);
  if (!order) throw new Error("order not found");
  if (order.status === "paid") throw new Error("order already paid");
  const product = PRODUCTS[order.productId];
  const a: Attempt = { id: newOrderId(), orderId, provider, amountPaisa: product.pricePaisa, status: "initiated", createdAt: Date.now() };
  const input = { orderId: a.id, amountPaisa: a.amountPaisa, description: product.name, returnUrl: returnUrlFor(provider, a.id) };
  const extra =
    provider === "cybersource"
      ? { billTo: { forename: "Test", surname: "Customer", email: "test@example.com", addressLine1: "Thamel", city: "Kathmandu", country: "NP" } }
      : {};
  a.initiate = await (payments.adapter(provider).initiate as (i: unknown) => Promise<InitiateResult>)({ ...input, ...extra });
  a.providerRef = a.initiate.providerRef; // Khalti pidx / NPS ProcessId / IME TokenId — persist!
  attempts.set(a.id, a);
  return a;
}

function page(body: string) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Nepal payments demo</title><style>body{font:16px system-ui;max-width:560px;margin:40px auto;padding:0 16px}button{font:inherit;padding:10px 14px;margin:4px 4px 4px 0;cursor:pointer}code{background:#f3f3f3;padding:2px 4px}</style></head><body>${body}</body></html>`;
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", PUBLIC_URL);
  const send = (status: number, body: string, type = "text/html; charset=utf-8") => {
    res.writeHead(status, { "Content-Type": type });
    res.end(body);
  };
  const redirect = (to: string) => {
    res.writeHead(302, { Location: to });
    res.end();
  };

  // Home: create an order, offer enabled providers
  if (req.method === "GET" && url.pathname === "/") {
    const orderId = crypto.randomUUID();
    orders.set(orderId, { productId: "tshirt", status: "unpaid" });
    const buttons = payments.enabled
      .map((p) => `<form method="POST" action="/payments" style="display:inline"><input type="hidden" name="orderId" value="${orderId}"><input type="hidden" name="provider" value="${p}"><button>Pay with ${p}</button></form>`)
      .join("");
    return send(200, page(`<h1>Everest T-shirt — Rs 1,500</h1><p>Order <code>${orderId}</code></p>${buttons}<p><small>eSewa sandbox login: 9806800001 / Nepal@123 / token 123456</small></p>`));
  }

  // Create attempt (client sends only orderId + provider; amount comes from the server)
  if (req.method === "POST" && url.pathname === "/payments") {
    const body = await readBody(req);
    const a = await createAttempt(body.orderId, body.provider as ProviderId);
    if (req.headers.accept?.includes("application/json")) {
      return send(201, JSON.stringify({ attemptId: a.id, startUrl: `${PUBLIC_URL}/payments/${a.id}/start`, providerRef: a.providerRef }), "application/json");
    }
    return redirect(`/payments/${a.id}/start`);
  }

  // Start: one URL for web + mobile WebViews (redirect or auto-submit form)
  let m = url.pathname.match(/^\/payments\/([A-Z0-9]+)\/start$/);
  if (req.method === "GET" && m) {
    const a = attempts.get(m[1]);
    if (!a?.initiate) return send(404, "unknown attempt");
    // Never replay a stale or closed attempt's signed form: the user must start a new attempt.
    if (!OPEN.includes(a.status) || Date.now() - a.createdAt > SESSION_WINDOW_MS) return redirect(`/orders/${a.orderId}?attempt=${a.id}`);
    if (a.initiate.kind === "qr") {
      // NEPALPAY QR: the payer scans from their own app; "I've paid" runs the same verify as a return URL.
      const img = a.initiate.qrImage ? `<img alt="NEPALPAY QR" width="280" height="280" src="data:image/png;base64,${a.initiate.qrImage}">` : "";
      return send(200, page(`<h1>Scan to pay</h1>${img}<p><code style="word-break:break-all">${escapeHtml(a.initiate.qrString)}</code></p><p><a href="/payments/${a.provider}/return/${a.id}">I've paid</a></p>`));
    }
    return a.initiate.kind === "redirect" ? redirect(a.initiate.url) : send(200, renderAutoSubmitForm(a.initiate));
  }

  // Status (apps poll this)
  m = url.pathname.match(/^\/payments\/([A-Z0-9]+)$/);
  if (req.method === "GET" && m) {
    const a = attempts.get(m[1]);
    if (!a) return send(404, "{}", "application/json");
    return send(200, JSON.stringify({ status: a.status, amountPaisa: a.amountPaisa }), "application/json");
  }

  // NPS notification URL (configured with NPS)
  if (req.method === "GET" && url.pathname === "/payments/nps/notify") {
    const a = attempts.get(url.searchParams.get("MerchantTxnId") ?? "");
    if (!a) return send(404, "unknown", "text/plain");
    const wasFinal = FINAL.includes(a.status);
    await verifyAndTransition(a);
    // Acknowledge only once a final state is recorded; otherwise NPS should keep notifying.
    if (!FINAL.includes(a.status)) return send(503, "pending", "text/plain");
    return send(200, payments.get("nps").notificationResponse(wasFinal), "text/plain");
  }

  // Return URL for every provider: GET or POST, optional attempt id in the path
  m = url.pathname.match(/^\/payments\/([a-z]+)\/return(?:\/([A-Z0-9]+))?$/);
  if (m) {
    const provider = m[1] as ProviderId;
    const params = { ...Object.fromEntries(url.searchParams), ...(req.method === "POST" ? await readBody(req) : {}) };
    const id = payments.adapter(provider).orderIdFromCallback(params) ?? m[2];
    const a = id ? attempts.get(id) : undefined;
    if (!a || a.provider !== provider) return send(404, page("<h1>Unknown payment</h1>"));
    try {
      await verifyAndTransition(a, Object.keys(params).length ? params : undefined);
    } catch (e) {
      // Network/5xx/invalid signature: leave the attempt open; reconciliation settles it.
      console.error(`[return] ${provider} ${a.id}:`, e instanceof PaymentError ? `${e.code} ${e.message}` : e);
    }
    return redirect(`/orders/${a.orderId}?attempt=${a.id}`);
  }

  // Receipt page (and mobile "done" URL the WebView intercepts)
  m = url.pathname.match(/^\/orders\/([0-9a-f-]+)$/);
  if (req.method === "GET" && m) {
    const o = orders.get(m[1]);
    const a = attempts.get(url.searchParams.get("attempt") ?? "");
    if (!o) return send(404, "unknown order");
    const msg = o.status === "paid" ? "✅ Payment received. Thank you!" : a?.status === "pending" || a?.status === "unknown" || a?.status === "initiated" ? "⏳ We're confirming your payment…" : `❌ Payment ${a?.status ?? "not completed"}.`;
    return send(200, page(`<h1>${msg}</h1><p>Attempt <code>${a?.id}</code> via ${a?.provider}: <b>${a?.status}</b></p><p><a href="/">Start over</a></p>`));
  }

  send(404, "not found", "text/plain");
}

async function readBody(req: IncomingMessage): Promise<Record<string, string>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 64 * 1024) throw new Error("body too large");
    chunks.push(c as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if ((req.headers["content-type"] ?? "").includes("application/json")) return raw ? JSON.parse(raw) : {};
  return Object.fromEntries(new URLSearchParams(raw));
}

// ---------------------------------------------------------------- reconciliation (architecture.md §6)
setInterval(async () => {
  const open = [...attempts.values()].filter((a) => OPEN.includes(a.status) && !a.reviewRequired);
  for (const a of open.filter((x) => Date.now() - x.createdAt >= RECONCILE_CUTOFF_MS)) {
    a.reviewRequired = true; // still unsettled after 3 days: escalate to a human, stop polling
    console.error(`[alert] ${a.provider} ${a.id} still ${a.status} after 3 days — manual review`);
  }
  const stale = open.filter((a) => !a.reviewRequired && Date.now() - a.createdAt > 2 * 60_000);
  for (const a of stale.slice(0, 50)) {
    if (a.provider === "cybersource") continue; // SA has no status API; rely on Merchant POST / REST search
    await verifyAndTransition(a).catch((e) => console.error(`[reconcile] ${a.id}:`, e instanceof Error ? e.message : e));
  }
}, 60_000).unref();

createServer((req, res) => {
  handle(req, res).catch((e) => {
    console.error(e);
    if (!res.headersSent) res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("internal error");
  });
}).listen(PORT, () => console.log(`demo on ${PUBLIC_URL}  (providers: ${payments.enabled.join(", ")})`));

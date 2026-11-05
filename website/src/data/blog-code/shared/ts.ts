// Shared app code for the gateway blog posts: types + settle(), the in-memory
// store, the reconcile job and the routes for each framework. Every gateway post
// reuses it; `g` names the gateway module the routes import.

export interface Block {
  file: string;
  lang: string;
  code: string;
}

export interface GatewayNames {
  id: string;
  name: string;
  ts: string;
  py: string;
  php: string;
  go: string;
  java: string;
  kotlin: string;
}

export const types: Block = { file: "payments.ts", lang: "ts", code: `// Types every gateway module speaks, plus settle(), which applies a gateway
// answer to an attempt. Same file for every gateway and every framework.
import { fulfil, setProviderRef, transition, type Attempt } from "./store";

export type PaymentStatus = "paid" | "pending" | "failed" | "canceled" | "refunded" | "not_found";

// What startPayment hands back: send the buyer to a URL, or auto-POST a form.
export type Start =
  | { type: "redirect"; url: string; providerRef?: string }
  | {
      type: "form";
      action: string;
      fields: Record<string, string>;
      providerRef?: string;
      enctype?: "multipart/form-data"; // unset = urlencoded; NPS needs multipart
    };

export interface Outcome {
  status: PaymentStatus;
  providerRef?: string;
}

export interface StartInput {
  attemptId: string;
  amountPaisa: number; // integer paisa: Rs 100 = 10000
  returnUrl: string;
  description: string;
}

export interface ConfirmInput {
  attemptId: string;
  amountPaisa: number; // the amount WE stored, never one from the callback
  providerRef: string | null;
  params: Record<string, string>; // callback query + body, or {} from the reconcile job
}

// Bad signature, amount mismatch, provider error. The return route answers 400.
export class PaymentError extends Error {}

const OPEN = ["initiated", "pending"] as const;

// Safe to call any number of times for the same attempt (return route hit twice,
// reconcile job racing the buyer): transition() lets exactly one caller move the
// attempt out of an open state, so fulfil() runs once.
export function settle(attempt: Attempt, outcome: Outcome): void {
  const s = outcome.status;
  if (s === "paid" || s === "failed" || s === "canceled") {
    if (transition(attempt.id, [...OPEN], s) && s === "paid") {
      // Keep the gateway's transaction id (refunds, support). A ref saved at start
      // (Khalti pidx, IME TokenId, NPS ProcessId) stays: confirm looks the payment up with it.
      if (outcome.providerRef && !attempt.providerRef) setProviderRef(attempt.id, outcome.providerRef);
      fulfil(attempt.orderId);
    }
  } else if (s === "pending") {
    transition(attempt.id, ["initiated"], "pending");
  }
  // not_found: leave it open. The reconcile job expires it after an hour.
}

export function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

// A page that POSTs the gateway's form as soon as it loads.
export function autoPostPage(
  action: string,
  fields: Record<string, string>,
  enctype?: string,
): string {
  const inputs = Object.entries(fields)
    .map(([k, v]) => \`<input type="hidden" name="\${escapeHtml(k)}" value="\${escapeHtml(v)}">\`)
    .join("\\n");
  return \`<!doctype html>
<title>Redirecting to payment</title>
<form id="pay" method="post" action="\${escapeHtml(action)}"\${enctype ? \` enctype="\${escapeHtml(enctype)}"\` : ""}>
\${inputs}
<noscript><button>Continue to payment</button></noscript>
</form>
<script>document.getElementById("pay").submit()</script>\`;
}
` };

export const store: Block = { file: "store.ts", lang: "ts", code: `// In-memory store so the example runs with zero setup.
// Swap for your database: one row per order, one row per payment attempt.
// Data is lost on restart and is not shared between server processes.

export type AttemptStatus = "initiated" | "pending" | "paid" | "failed" | "canceled" | "expired";

export interface Order {
  id: string;
  amountPaisa: number;
}

export interface Attempt {
  id: string; // 20 lowercase hex chars, fits every gateway's order-id rules
  orderId: string;
  amountPaisa: number;
  status: AttemptStatus;
  providerRef: string | null; // gateway's own id (Khalti pidx, ...), if it gives one
  createdAt: number; // epoch ms
}

type Db = { orders: Map<string, Order>; attempts: Map<string, Attempt> };

// Kept on globalThis so dev servers that reload modules (next dev) keep the data.
const g = globalThis as typeof globalThis & { paymentsDb?: Db };
const db = (g.paymentsDb ??= {
  orders: new Map([["demo", { id: "demo", amountPaisa: 10000 }]]), // Rs 100
  attempts: new Map(),
});

export function getOrder(id: string): Order | undefined {
  return db.orders.get(id);
}

export function createAttempt(orderId: string, amountPaisa: number): Attempt {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  const id = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  const attempt: Attempt = { id, orderId, amountPaisa, status: "initiated", providerRef: null, createdAt: Date.now() };
  db.attempts.set(id, attempt);
  return attempt;
}

export function getAttempt(id: string): Attempt | undefined {
  return db.attempts.get(id);
}

export function setProviderRef(id: string, ref: string): void {
  const a = db.attempts.get(id);
  if (a) a.providerRef = ref;
}

// Compare-and-set: move to \`to\` only if the status is still one of \`from\`.
// Returns true for exactly one caller. In SQL:
//   UPDATE attempts SET status = $to WHERE id = $id AND status IN ($from)
// and check that one row changed. (JS runs this function without interruption.)
export function transition(id: string, from: AttemptStatus[], to: AttemptStatus): boolean {
  const a = db.attempts.get(id);
  if (!a || !from.includes(a.status)) return false;
  a.status = to;
  return true;
}

// Attempts still waiting on the gateway, created at least \`olderThanSeconds\` ago.
export function openAttempts(olderThanSeconds: number): Attempt[] {
  const cutoff = Date.now() - olderThanSeconds * 1000;
  return [...db.attempts.values()].filter(
    (a) => (a.status === "initiated" || a.status === "pending") && a.createdAt <= cutoff,
  );
}

export function latestAttempt(orderId: string): Attempt | undefined {
  return [...db.attempts.values()].filter((a) => a.orderId === orderId).at(-1);
}

// Ship the goods, send the email, ... Runs once per paid attempt.
export function fulfil(orderId: string): void {
  console.log(\`order \${orderId} paid, fulfil it here\`);
}
` };

export const reconcile: Block = { file: "reconcile.ts", lang: "ts", code: `// Reconcile job: asks the gateway about attempts the buyer never came back from
// (closed the tab, lost signal, callback failed). Runs inside the web server
// because the in-memory store lives there; with a database, run it from cron.
import { settle, type ConfirmInput, type Outcome } from "./payments";
import { openAttempts, transition } from "./store";

const HOUR_MS = 60 * 60 * 1000;
const REVIEW_AFTER_MS = 3 * 24 * HOUR_MS;

// Any gateway module fits: pass the one the routes import.
type Gateway = { confirmPayment(input: ConfirmInput): Promise<Outcome> };

export async function reconcileOnce(gateway: Gateway): Promise<void> {
  for (const attempt of openAttempts(120)) {
    if (Date.now() - attempt.createdAt > REVIEW_AFTER_MS) {
      // Still open after 3 days: asking again rarely helps, so a person checks it
      // (gateway dashboard, bank statement) and closes it by hand.
      console.log(\`attempt \${attempt.id} still \${attempt.status} after 3 days, needs manual review\`);
      continue;
    }
    try {
      // Empty params: no callback here, the gateway module asks the status API.
      const outcome = await gateway.confirmPayment({
        attemptId: attempt.id,
        amountPaisa: attempt.amountPaisa,
        providerRef: attempt.providerRef,
        params: {},
      });
      settle(attempt, outcome);
      if (outcome.status === "not_found" && Date.now() - attempt.createdAt > HOUR_MS) {
        transition(attempt.id, ["initiated", "pending"], "expired");
      }
      console.log(\`reconcile \${attempt.id}: \${outcome.status}\`);
    } catch (err) {
      // Log and move on: one bad attempt must not stop the rest.
      console.error(\`reconcile \${attempt.id} failed:\`, err);
    }
  }
}

export function startReconcileLoop(gateway: Gateway, everyMs = 60_000): void {
  setInterval(() => void reconcileOnce(gateway), everyMs);
}
` };

export const routes = (g: GatewayNames): Record<"express" | "hono" | "nextjs" | "fastify", Block[]> => ({
  express: [{ file: "server.ts", lang: "ts", code: `import express, { type Request, type Response } from "express";
import * as gateway from "./${g.ts}";
import { PaymentError, autoPostPage, settle } from "./payments";
import { startReconcileLoop } from "./reconcile";
import { createAttempt, getAttempt, getOrder, latestAttempt, setProviderRef } from "./store";

const PORT = Number(process.env.PORT ?? 3000);
const BASE_URL = process.env.BASE_URL ?? \`http://localhost:\${PORT}\`;
const app = express();

app.get("/", (_req, res) => {
  res.send(\`<!doctype html><title>Shop</title>
<h1>Order demo, Rs 100</h1>
<form method="post" action="/pay/demo"><button>Pay with ${g.name}</button></form>\`);
});

app.post("/pay/:orderId", async (req, res) => {
  const order = getOrder(req.params.orderId);
  if (!order) return void res.status(404).send("Order not found");
  const attempt = createAttempt(order.id, order.amountPaisa);
  const start = await gateway.startPayment({
    attemptId: attempt.id,
    amountPaisa: attempt.amountPaisa,
    // A path segment, not ?attempt=: some gateways append their own query string.
    returnUrl: \`\${BASE_URL}/pay/return/\${attempt.id}\`,
    description: \`Order \${order.id}\`,
  });
  if (start.providerRef) setProviderRef(attempt.id, start.providerRef);
  if (start.type === "redirect") return res.redirect(303, start.url);
  res.send(autoPostPage(start.action, start.fields, start.enctype));
});

// Gateways come back with GET (query string) or POST (form body). Handle both.
async function paymentReturn(req: Request<{ attemptId: string }>, res: Response) {
  const attempt = getAttempt(req.params.attemptId);
  if (!attempt) return void res.status(404).send("Payment not found");
  const params = { ...(req.query as Record<string, string>), ...(req.body ?? {}) };
  try {
    const outcome = await gateway.confirmPayment({
      attemptId: attempt.id,
      amountPaisa: attempt.amountPaisa,
      providerRef: attempt.providerRef,
      params,
    });
    settle(attempt, outcome);
  } catch (err) {
    if (err instanceof PaymentError) return void res.status(400).send("Payment could not be verified");
    console.error(err);
    return void res.status(502).send("Payment gateway error, try again shortly");
  }
  res.redirect(303, \`/orders/\${attempt.orderId}\`);
}
app.get("/pay/return/:attemptId", paymentReturn);
app.post("/pay/return/:attemptId", express.urlencoded({ extended: false }), paymentReturn);

app.get("/orders/:orderId", (req, res) => {
  const attempt = latestAttempt(req.params.orderId);
  res.type("text").send(\`Order \${req.params.orderId}: \${attempt ? attempt.status : "no payment yet"}\`);
});

startReconcileLoop(gateway);
app.listen(PORT, () => console.log(\`listening on \${BASE_URL}\`));
` }],
  hono: [{ file: "server.ts", lang: "ts", code: `import { serve } from "@hono/node-server";
import { Hono } from "hono";
import * as gateway from "./${g.ts}";
import { PaymentError, autoPostPage, settle } from "./payments";
import { startReconcileLoop } from "./reconcile";
import { createAttempt, getAttempt, getOrder, latestAttempt, setProviderRef } from "./store";

const PORT = Number(process.env.PORT ?? 3000);
const BASE_URL = process.env.BASE_URL ?? \`http://localhost:\${PORT}\`;
const app = new Hono();

app.get("/", (c) =>
  c.html(\`<!doctype html><title>Shop</title>
<h1>Order demo, Rs 100</h1>
<form method="post" action="/pay/demo"><button>Pay with ${g.name}</button></form>\`),
);

app.post("/pay/:orderId", async (c) => {
  const order = getOrder(c.req.param("orderId"));
  if (!order) return c.text("Order not found", 404);
  const attempt = createAttempt(order.id, order.amountPaisa);
  const start = await gateway.startPayment({
    attemptId: attempt.id,
    amountPaisa: attempt.amountPaisa,
    // A path segment, not ?attempt=: some gateways append their own query string.
    returnUrl: \`\${BASE_URL}/pay/return/\${attempt.id}\`,
    description: \`Order \${order.id}\`,
  });
  if (start.providerRef) setProviderRef(attempt.id, start.providerRef);
  if (start.type === "redirect") return c.redirect(start.url, 303);
  return c.html(autoPostPage(start.action, start.fields, start.enctype));
});

// Gateways come back with GET (query string) or POST (form body). Handle both.
app.on(["GET", "POST"], "/pay/return/:attemptId", async (c) => {
  const attempt = getAttempt(c.req.param("attemptId"));
  if (!attempt) return c.text("Payment not found", 404);
  const body = c.req.method === "POST" ? ((await c.req.parseBody()) as Record<string, string>) : {};
  const params = { ...c.req.query(), ...body };
  try {
    const outcome = await gateway.confirmPayment({
      attemptId: attempt.id,
      amountPaisa: attempt.amountPaisa,
      providerRef: attempt.providerRef,
      params,
    });
    settle(attempt, outcome);
  } catch (err) {
    if (err instanceof PaymentError) return c.text("Payment could not be verified", 400);
    console.error(err);
    return c.text("Payment gateway error, try again shortly", 502);
  }
  return c.redirect(\`/orders/\${attempt.orderId}\`, 303);
});

app.get("/orders/:orderId", (c) => {
  const attempt = latestAttempt(c.req.param("orderId"));
  return c.text(\`Order \${c.req.param("orderId")}: \${attempt ? attempt.status : "no payment yet"}\`);
});

startReconcileLoop(gateway);
serve({ fetch: app.fetch, port: PORT }, () => console.log(\`listening on \${BASE_URL}\`));
` }],
  nextjs: [
    { file: "app/page.tsx", lang: "tsx", code: `// GET /  Replaces the starter page from create-next-app.
export default function Home() {
  return (
    <main>
      <h1>Order demo, Rs 100</h1>
      <form method="post" action="/pay/demo">
        <button>Pay with ${g.name}</button>
      </form>
    </main>
  );
}
` },
    { file: "app/pay/[orderId]/route.ts", lang: "ts", code: `// POST /pay/:orderId
import * as gateway from "@/${g.ts}";
import { autoPostPage } from "@/payments";
import { createAttempt, getOrder, setProviderRef } from "@/store";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3000";

export async function POST(_req: Request, { params }: { params: Promise<{ orderId: string }> }) {
  const order = getOrder((await params).orderId);
  if (!order) return new Response("Order not found", { status: 404 });
  const attempt = createAttempt(order.id, order.amountPaisa);
  const start = await gateway.startPayment({
    attemptId: attempt.id,
    amountPaisa: attempt.amountPaisa,
    // A path segment, not ?attempt=: some gateways append their own query string.
    returnUrl: \`\${BASE_URL}/pay/return/\${attempt.id}\`,
    description: \`Order \${order.id}\`,
  });
  if (start.providerRef) setProviderRef(attempt.id, start.providerRef);
  if (start.type === "redirect") return Response.redirect(start.url, 303);
  return new Response(autoPostPage(start.action, start.fields, start.enctype), {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
` },
    { file: "app/pay/return/[attemptId]/route.ts", lang: "ts", code: `// GET and POST /pay/return/:attemptId
// Gateways come back with GET (query string) or POST (form body). Handle both.
import * as gateway from "@/${g.ts}";
import { PaymentError, settle } from "@/payments";
import { getAttempt } from "@/store";

export async function GET(req: Request, { params }: { params: Promise<{ attemptId: string }> }) {
  const attempt = getAttempt((await params).attemptId);
  if (!attempt) return new Response("Payment not found", { status: 404 });
  const query = Object.fromEntries(new URL(req.url).searchParams);
  const body = req.method === "POST" ? Object.fromEntries(new URLSearchParams(await req.text())) : {};
  try {
    const outcome = await gateway.confirmPayment({
      attemptId: attempt.id,
      amountPaisa: attempt.amountPaisa,
      providerRef: attempt.providerRef,
      params: { ...query, ...body },
    });
    settle(attempt, outcome);
  } catch (err) {
    if (err instanceof PaymentError) return new Response("Payment could not be verified", { status: 400 });
    console.error(err);
    return new Response("Payment gateway error, try again shortly", { status: 502 });
  }
  // Relative Location: no need to know our own host here.
  return new Response(null, { status: 303, headers: { Location: \`/orders/\${attempt.orderId}\` } });
}

export const POST = GET;
` },
    { file: "app/orders/[orderId]/route.ts", lang: "ts", code: `// GET /orders/:orderId
import { latestAttempt } from "@/store";

export async function GET(_req: Request, { params }: { params: Promise<{ orderId: string }> }) {
  const { orderId } = await params;
  const attempt = latestAttempt(orderId);
  return new Response(\`Order \${orderId}: \${attempt ? attempt.status : "no payment yet"}\`);
}
` },
    { file: "instrumentation.ts", lang: "ts", code: `// Next.js runs register() once when the server starts. Start the reconcile loop
// here, in the Node.js runtime only (the in-memory store lives in this process).
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const gateway = await import("./${g.ts}");
    const { startReconcileLoop } = await import("./reconcile");
    startReconcileLoop(gateway);
  }
}
` },
  ],
  fastify: [{ file: "server.ts", lang: "ts", code: `import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import * as gateway from "./${g.ts}";
import { PaymentError, autoPostPage, settle } from "./payments";
import { startReconcileLoop } from "./reconcile";
import { createAttempt, getAttempt, getOrder, latestAttempt, setProviderRef } from "./store";

const PORT = Number(process.env.PORT ?? 3000);
const BASE_URL = process.env.BASE_URL ?? \`http://localhost:\${PORT}\`;
const app = Fastify();

// Fastify parses JSON only. Parse form posts (from gateways and our own button) too.
app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_req, body, done) => {
  done(null, Object.fromEntries(new URLSearchParams(body as string)));
});

app.get("/", async (_req, reply) =>
  reply.type("text/html").send(\`<!doctype html><title>Shop</title>
<h1>Order demo, Rs 100</h1>
<form method="post" action="/pay/demo"><button>Pay with ${g.name}</button></form>\`),
);

app.post<{ Params: { orderId: string } }>("/pay/:orderId", async (req, reply) => {
  const order = getOrder(req.params.orderId);
  if (!order) return reply.code(404).send("Order not found");
  const attempt = createAttempt(order.id, order.amountPaisa);
  const start = await gateway.startPayment({
    attemptId: attempt.id,
    amountPaisa: attempt.amountPaisa,
    // A path segment, not ?attempt=: some gateways append their own query string.
    returnUrl: \`\${BASE_URL}/pay/return/\${attempt.id}\`,
    description: \`Order \${order.id}\`,
  });
  if (start.providerRef) setProviderRef(attempt.id, start.providerRef);
  if (start.type === "redirect") return reply.redirect(start.url, 303);
  return reply.type("text/html").send(autoPostPage(start.action, start.fields, start.enctype));
});

// Gateways come back with GET (query string) or POST (form body). Handle both.
type ReturnRequest = FastifyRequest<{
  Params: { attemptId: string };
  Querystring: Record<string, string>;
  Body: Record<string, string> | undefined;
}>;
async function paymentReturn(req: ReturnRequest, reply: FastifyReply) {
  const attempt = getAttempt(req.params.attemptId);
  if (!attempt) return reply.code(404).send("Payment not found");
  const params = { ...req.query, ...(req.body ?? {}) };
  try {
    const outcome = await gateway.confirmPayment({
      attemptId: attempt.id,
      amountPaisa: attempt.amountPaisa,
      providerRef: attempt.providerRef,
      params,
    });
    settle(attempt, outcome);
  } catch (err) {
    if (err instanceof PaymentError) return reply.code(400).send("Payment could not be verified");
    req.log.error(err);
    return reply.code(502).send("Payment gateway error, try again shortly");
  }
  return reply.redirect(\`/orders/\${attempt.orderId}\`, 303);
}
app.route({ method: ["GET", "POST"], url: "/pay/return/:attemptId", handler: paymentReturn });

app.get<{ Params: { orderId: string } }>("/orders/:orderId", async (req, reply) => {
  const attempt = latestAttempt(req.params.orderId);
  return reply.type("text/plain").send(\`Order \${req.params.orderId}: \${attempt ? attempt.status : "no payment yet"}\`);
});

startReconcileLoop(gateway);
app.listen({ port: PORT }).then(() => console.log(\`listening on \${BASE_URL}\`));
` }],
});

// Install, env vars and run, per framework. Every framework listens on port 3000.
export const setup: Record<"express" | "hono" | "nextjs" | "fastify", Block> = {
  express: { file: "terminal", lang: "bash", code: `mkdir shop && cd shop
npm init -y
npm i express
npm i -D tsx typescript @types/node @types/express
# Save payments.ts, store.ts, reconcile.ts, server.ts and the gateway file in this folder.

# Plus the gateway's variables from its section.
export BASE_URL=http://localhost:3000   # where the gateway sends the buyer back
npx tsx server.ts                       # http://localhost:3000` },
  hono: { file: "terminal", lang: "bash", code: `mkdir shop && cd shop
npm init -y
npm i hono @hono/node-server
npm i -D tsx typescript @types/node
# Save payments.ts, store.ts, reconcile.ts, server.ts and the gateway file in this folder.

# Plus the gateway's variables from its section.
export BASE_URL=http://localhost:3000   # where the gateway sends the buyer back
npx tsx server.ts                       # http://localhost:3000` },
  fastify: { file: "terminal", lang: "bash", code: `mkdir shop && cd shop
npm init -y
npm i fastify
npm i -D tsx typescript @types/node
# Save payments.ts, store.ts, reconcile.ts, server.ts and the gateway file in this folder.

# Plus the gateway's variables from its section.
export BASE_URL=http://localhost:3000   # where the gateway sends the buyer back
npx tsx server.ts                       # http://localhost:3000` },
  nextjs: { file: "terminal", lang: "bash", code: `npx create-next-app@latest shop --ts --app --no-src-dir --import-alias "@/*" --yes
cd shop
# Save payments.ts, store.ts, reconcile.ts, instrumentation.ts and the gateway file in the
# project root (next to package.json). Route files go under app/ at the paths shown.

# Plus the gateway's variables from its section (or put them all in .env.local).
export BASE_URL=http://localhost:3000   # where the gateway sends the buyer back
npx next dev                            # http://localhost:3000` },
};

export const runCommand: Record<"express" | "hono" | "nextjs" | "fastify", string> = {"express":"npx tsx server.ts","hono":"npx tsx server.ts","fastify":"npx tsx server.ts","nextjs":"npx next dev"};

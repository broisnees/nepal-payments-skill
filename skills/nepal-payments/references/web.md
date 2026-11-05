# Web + backend wiring (Express, Hono, Next.js, FastAPI, Django, Laravel)

Every framework needs the same five routes (see `mobile.md` §3, which reuses them):

| Route | Purpose |
|---|---|
| `POST /payments` `{orderId, provider}` | load the order, compute the amount **server-side**, insert the attempt, `adapter.initiate()`, persist `providerRef` |
| `GET /payments/:attemptId/start` | 302 to `url`, or `renderAutoSubmitForm()` for form providers |
| `GET+POST /payments/:provider/return[/:attemptId]` | `orderIdFromCallback()` → load attempt → `verify()` → conditional transition → redirect to the receipt page |
| `GET /payments/:attemptId` | status for polling (mobile, SPA) |
| provider notifications | NPS `GET /payments/nps/notify`, CyberSource Merchant POST URL, eSewa Intent `callback_url` |

The full reference implementation is `scripts/ts/examples/server.ts` (zero deps; run it with `node examples/server.ts`). The snippets below show how the same pieces map onto each framework. `verifyAndTransition` is the function from `architecture.md` §4.

**POST callbacks need CSRF exemptions**: CyberSource receipt + Merchant POST, IME Pay `RespUrl`, eSewa Intent callback. They're cross-site POSTs without your CSRF token. Their integrity comes from signature verification and the server-side status check, never from the request itself.

## Contents
1. Frontend (any framework)
2. Express
3. Hono (Cloudflare Workers / Bun / Node)
4. Next.js App Router
5. FastAPI
6. Django
7. Laravel (PHP port)
8. Other languages

## 1. Frontend (any framework)

```tsx
// The browser sends ONLY orderId + provider. No amounts, no signatures, no secrets.
async function pay(orderId: string, provider: "esewa" | "khalti" | "fonepay" | "connectips" | "nps" | "cybersource") {
  const res = await fetch("/payments", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ orderId, provider }),
  });
  if (!res.ok) throw new Error("Could not start payment");
  const { startUrl } = await res.json();
  window.location.assign(startUrl); // server redirects or auto-submits the provider form
}
```
For the receipt page, poll `GET /payments/:attemptId` while the status is `pending`/`initiated` (1 s, 2 s, 4 s … about 1 min), then show "We'll email you when it's confirmed".

## 2. Express

```ts
import express from "express";
import { createPayments, paymentsConfigFromEnv, renderAutoSubmitForm, newOrderId } from "./payments/index.ts";

const app = express();
const payments = createPayments(paymentsConfigFromEnv());
app.use(express.json());
app.use("/payments", express.urlencoded({ extended: false })); // CyberSource / IME POST callbacks

app.post("/payments", requireUser, async (req, res) => {
  const order = await db.orders.findForUser(req.body.orderId, req.user.id);
  const attemptId = newOrderId();
  const input = { orderId: attemptId, amountPaisa: order.totalPaisa, description: order.title, returnUrl: returnUrlFor(req.body.provider, attemptId) };
  const init = await payments.adapter(req.body.provider).initiate(input);
  await db.attempts.insert({ id: attemptId, orderId: order.id, provider: req.body.provider, amountPaisa: order.totalPaisa,
                             providerRef: init.providerRef ?? null, initiate: init, status: "initiated" });
  res.status(201).json({ attemptId, startUrl: `/payments/${attemptId}/start` });
});

app.get("/payments/:id/start", async (req, res) => {
  const a = await db.attempts.get(req.params.id);
  if (!a) return res.sendStatus(404);
  a.initiate.kind === "redirect" ? res.redirect(a.initiate.url) : res.type("html").send(renderAutoSubmitForm(a.initiate));
});

// Exclude this route from csurf/lusca if you use them.
app.all("/payments/:provider/return{/:attemptId}", async (req, res) => {   // Express 5 optional-param syntax; Express 4: "/:provider/return/:attemptId?"
  const params = { ...req.query, ...(req.method === "POST" ? req.body : {}) } as Record<string, string>;
  const id = payments.adapter(req.params.provider).orderIdFromCallback(params) ?? req.params.attemptId;
  const a = id && (await db.attempts.get(id));
  if (!a || a.provider !== req.params.provider) return res.sendStatus(404);
  await verifyAndTransition(a, params).catch((e) => log.warn({ e, attempt: a.id }, "verify failed; reconciliation will retry"));
  res.redirect(303, `/orders/${a.orderId}?attempt=${a.id}`);
});
```

## 3. Hono (Cloudflare Workers / Bun / Node)

The adapters use only WebCrypto + `fetch`, so they run on Workers with no `nodejs_compat` flag.
```ts
import { Hono } from "hono";
import { createPayments, paymentsConfigFromEnv, renderAutoSubmitForm } from "./payments/index.ts";

type Env = { Bindings: Record<string, string> & { DB: D1Database } };
const app = new Hono<Env>();

app.get("/payments/:id/start", async (c) => {
  const a = await getAttempt(c.env.DB, c.req.param("id"));
  if (!a) return c.notFound();
  return a.initiate.kind === "redirect" ? c.redirect(a.initiate.url) : c.html(renderAutoSubmitForm(a.initiate));
});

app.on(["GET", "POST"], "/payments/:provider/return/:attemptId?", async (c) => {
  const payments = createPayments(paymentsConfigFromEnv(c.env)); // Workers: secrets come from c.env
  const provider = c.req.param("provider");
  const params: Record<string, string> = { ...c.req.query() };
  if (c.req.method === "POST") Object.assign(params, await c.req.parseBody());
  const id = payments.adapter(provider).orderIdFromCallback(params) ?? c.req.param("attemptId");
  const a = id ? await getAttempt(c.env.DB, id) : null;
  if (!a || a.provider !== provider) return c.notFound();
  await verifyAndTransition(c.env.DB, payments, a, params).catch((e) => console.error("verify", a.id, e));
  return c.redirect(`/orders/${a.orderId}?attempt=${a.id}`, 303);
});
```
Store secrets with `wrangler secret put ESEWA_SECRET_KEY` etc. Never put them in `wrangler.jsonc` `vars`. Run reconciliation from a Cron Trigger (`scheduled()` handler).

## 4. Next.js App Router

```ts
// app/payments/[provider]/return/[[...attempt]]/route.ts
import { NextResponse, type NextRequest } from "next/server";
import { payments, verifyAndTransition, getAttempt } from "@/server/payments"; // server-only module

async function handle(req: NextRequest, { params }: { params: Promise<{ provider: string; attempt?: string[] }> }) {
  const { provider, attempt } = await params;                      // params is a Promise (Next.js 15+)
  const cb: Record<string, string> = Object.fromEntries(req.nextUrl.searchParams);
  if (req.method === "POST") for (const [k, v] of await req.formData()) cb[k] = String(v);
  const id = payments.adapter(provider).orderIdFromCallback(cb) ?? attempt?.[0];
  const a = id ? await getAttempt(id) : null;
  if (!a || a.provider !== provider) return new NextResponse("Not found", { status: 404 });
  await verifyAndTransition(a, cb).catch((e) => console.error("verify", a.id, e));
  return NextResponse.redirect(new URL(`/orders/${a.orderId}?attempt=${a.id}`, req.url), 303);
}
export { handle as GET, handle as POST };
export const dynamic = "force-dynamic";
```
- Put adapters and secrets in a module that starts with `import "server-only"`. Never prefix payment secrets with `NEXT_PUBLIC_`.
- Server Actions can create attempts, but return `startUrl` and navigate with `window.location.assign`. A form-POST provider can't be reached with `redirect()` from an action.

## 5. FastAPI

The Python adapters are synchronous (stdlib `urllib`), so run them in the threadpool from async routes.
```python
from fastapi import FastAPI, Request, HTTPException
from fastapi.responses import HTMLResponse, RedirectResponse, PlainTextResponse
from starlette.concurrency import run_in_threadpool
from nepal_payments import create_payments, config_from_env, render_auto_submit_form, new_order_id, FormResult

app = FastAPI()
payments = create_payments(config_from_env())
FINAL = {"paid", "failed", "canceled", "expired", "refunded", "partially_refunded"}

@app.get("/payments/{attempt_id}/start")
async def start(attempt_id: str):
    a = await db.get_attempt(attempt_id) or _404()
    init = a.initiate  # stored RedirectResult / FormResult
    return RedirectResponse(init.url, 302) if init.kind == "redirect" else HTMLResponse(render_auto_submit_form(init))

@app.api_route("/payments/{provider}/return", methods=["GET", "POST"])
@app.api_route("/payments/{provider}/return/{attempt_id}", methods=["GET", "POST"])
async def payment_return(provider: str, request: Request, attempt_id: str | None = None):
    params = dict(request.query_params)
    if request.method == "POST":
        params.update({k: str(v) for k, v in (await request.form()).items()})  # needs python-multipart
    adapter = payments[provider]
    a = await db.get_attempt(adapter.order_id_from_callback(params) or attempt_id)
    if not a or a.provider != provider:
        raise HTTPException(404)
    try:
        result = await run_in_threadpool(adapter.verify, a.id, a.amount_paisa, a.provider_ref, params)
        await db.transition(a, result)  # decide_transition() + guarded UPDATE (architecture.md §4)
    except Exception:
        log.exception("verify failed; reconciliation will retry")
    return RedirectResponse(f"/orders/{a.order_id}?attempt={a.id}", 303)

@app.get("/payments/nps/notify", response_class=PlainTextResponse)
async def nps_notify(MerchantTxnId: str):
    a = await db.get_attempt(MerchantTxnId) or _404()
    was_final = a.status in FINAL
    result = await run_in_threadpool(payments["nps"].verify, a.id, a.amount_paisa)
    a = await db.transition(a, result)  # returns the stored attempt
    if a.status not in FINAL:
        return PlainTextResponse("pending", status_code=503)  # not acknowledged: NPS retries
    return payments["nps"].notification_response(already_processed=was_final)
```

## 6. Django

```python
from django.http import HttpResponse, HttpResponseNotFound, HttpResponseRedirect
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_http_methods
from nepal_payments import create_payments, config_from_env, render_auto_submit_form

payments = create_payments(config_from_env())

def start(request, attempt_id):
    a = Attempt.objects.get(pk=attempt_id)
    init = a.initiate_result()
    return HttpResponseRedirect(init.url) if init.kind == "redirect" else HttpResponse(render_auto_submit_form(init))

@csrf_exempt                      # cross-site POSTs from CyberSource / IME Pay; integrity comes from verify()
@require_http_methods(["GET", "POST"])
def payment_return(request, provider, attempt_id=None):
    params = {**request.GET.dict(), **request.POST.dict()}
    adapter = payments[provider]
    a = Attempt.objects.filter(pk=adapter.order_id_from_callback(params) or attempt_id, provider=provider).first()
    if not a:
        return HttpResponseNotFound()
    try:
        result = adapter.verify(a.pk, a.amount_paisa, a.provider_ref, params)
        a.transition(result)  # decide_transition() + guarded update; fulfil once
    except Exception:
        logger.exception("verify failed; reconciliation will retry")
    return HttpResponseRedirect(f"/orders/{a.order_id}?attempt={a.pk}")
```
Conditional transition with the Django ORM:
`Attempt.objects.filter(pk=a.pk, status__in=["initiated", "pending", "unknown"]).update(status=new_status, ...)` returns 1 for exactly one caller. Run reconciliation from Celery beat or a management command on cron.

## 7. Laravel (PHP port)

No PHP adapter ships with the skill. Port the TS adapter for the provider you need (each is about 100–200 lines; the signature snippets are in each provider reference). eSewa + Khalti core:

```php
// app/Payments/Esewa.php
use Illuminate\Support\Facades\Http;

final class Esewa {
    public function __construct(private string $productCode, private string $secret, private bool $live) {}

    private function sign(array $fields, array $order): string {
        $msg = implode(',', array_map(fn ($f) => "$f={$fields[$f]}", $order));
        return base64_encode(hash_hmac('sha256', $msg, $this->secret, true));
    }

    public function form(string $uuid, int $amountPaisa, string $returnUrl): array {
        $rs = fn (int $p) => $p % 100 === 0 ? (string) intdiv($p, 100) : sprintf('%d.%02d', intdiv($p, 100), $p % 100);
        $f = ['amount' => $rs($amountPaisa), 'tax_amount' => '0', 'product_service_charge' => '0', 'product_delivery_charge' => '0',
              'total_amount' => $rs($amountPaisa), 'transaction_uuid' => $uuid, 'product_code' => $this->productCode,
              'success_url' => $returnUrl, 'failure_url' => $returnUrl, 'signed_field_names' => 'total_amount,transaction_uuid,product_code'];
        $f['signature'] = $this->sign($f, ['total_amount', 'transaction_uuid', 'product_code']);
        return ['action' => $this->live ? 'https://epay.esewa.com.np/api/epay/main/v2/form' : 'https://rc-epay.esewa.com.np/api/epay/main/v2/form', 'fields' => $f];
    }

    public function status(string $uuid, string $totalRupees): string {          // authoritative
        $url = $this->live ? 'https://esewa.com.np/api/epay/transaction/status/' : 'https://rc.esewa.com.np/api/epay/transaction/status/';
        $r = Http::timeout(15)->retry(2, 300)->get($url, ['product_code' => $this->productCode, 'total_amount' => $totalRupees, 'transaction_uuid' => $uuid]);
        return $r->json('status') ?? 'UNKNOWN';                                    // COMPLETE = paid
    }
}

// Khalti lookup (secret key server-side; trailing slash required)
$r = Http::withHeaders(['Authorization' => 'Key '.config('services.khalti.secret')])
    ->timeout(15)->post((config('services.khalti.live') ? 'https://khalti.com' : 'https://dev.khalti.com').'/api/v2/epayment/lookup/', ['pidx' => $attempt->provider_ref]);
$status = $r->json('status');   // HTTP 400 still carries {status: "Expired" | "User canceled"}
```
CSRF exemption for POST callbacks (Laravel 11+ `bootstrap/app.php`):
```php
->withMiddleware(function (Middleware $middleware): void {
    $middleware->validateCsrfTokens(except: ['payments/*/return', 'payments/*/return/*', 'payments/cybersource/notify']);
})
```
Use `DB::transaction` + `lockForUpdate()` (or a conditional `update()` that returns the affected-row count) for the exactly-once transition.

## 8. Other languages

Go, Java/Kotlin, C#, Ruby, Dart (server): port from `scripts/ts/src/<provider>.ts`. Each provider reference has signature snippets for PHP, Python, Go and Java, plus **test vectors**. Write the vector tests first and port until they pass, then run the sandbox checks in `testing.md`.

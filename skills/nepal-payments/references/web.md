# Web + backend wiring (Express, Hono, Next.js, FastAPI, Django, Laravel, Spring Boot, Ktor)

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
7. Laravel (PHP adapter)
8. Spring Boot (Java)
9. Ktor (Kotlin)
10. Other languages

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

## 7. Laravel (PHP adapter)

The PHP adapters (`scripts/php/src/`, namespace `NepalPayments`, PHP 8.1+, no Composer dependencies) are synchronous, which suits PHP-FPM. Copy `src/` to `app/Payments/NepalPayments/`, add `"NepalPayments\\": "app/Payments/NepalPayments/"` to `autoload.psr-4` in `composer.json`, and run `composer dump-autoload`.

```php
// config/payments.php: every variable from env.md, read through config() so `php artisan config:cache` keeps working
return ['env' => [
    'ESEWA_ENV' => env('ESEWA_ENV'), 'ESEWA_PRODUCT_CODE' => env('ESEWA_PRODUCT_CODE'), 'ESEWA_SECRET_KEY' => env('ESEWA_SECRET_KEY'),
    'KHALTI_ENV' => env('KHALTI_ENV'), 'KHALTI_SECRET_KEY' => env('KHALTI_SECRET_KEY'), 'KHALTI_WEBSITE_URL' => env('KHALTI_WEBSITE_URL'),
    // ... the rest of env.md for the providers you enable
]];

// app/Providers/AppServiceProvider.php
public function register(): void
{
    $this->app->singleton(\NepalPayments\Payments::class, fn () =>
        \NepalPayments\Payments::create(\NepalPayments\Payments::configFromEnv(config('payments.env'))));
}

// routes/web.php
Route::get('/payments/{attempt}/start', [PaymentController::class, 'start']);
Route::match(['get', 'post'], '/payments/{provider}/return/{attemptId?}', [PaymentController::class, 'return']);
```

```php
use NepalPayments\{AttemptStatus, FormResult, Payments, RedirectResult, StateMachine, VerifyInput};

final class PaymentController
{
    public function __construct(private Payments $payments) {}

    public function start(PaymentAttempt $attempt)
    {
        $init = $attempt->initiateResult();               // RedirectResult | FormResult rebuilt from the stored JSON
        return $init instanceof RedirectResult ? redirect()->away($init->url) : response($init->render());
    }

    public function return(Request $request, string $provider, ?string $attemptId = null)
    {
        $enabled = array_map(fn ($p) => $p->value, $this->payments->enabled());
        abort_unless(in_array($provider, $enabled, true), 404);
        $params = array_merge($request->query(), $request->post());
        $id = $this->payments->adapter($provider)->orderIdFromCallback($params) ?? $attemptId;
        $a = PaymentAttempt::where('provider', $provider)->find($id) ?? abort(404);
        try {
            $this->verifyAndTransition($a, $params);
        } catch (\Throwable $e) {
            report($e);                                    // the attempt stays open; reconciliation retries
        }
        return redirect("/orders/{$a->order_id}?attempt={$a->id}", 303);
    }

    private function verifyAndTransition(PaymentAttempt $a, array $params): void
    {
        $result = $this->payments->adapter($a->provider)
            ->verify(new VerifyInput($a->id, $a->amount_paisa, $a->provider_ref, $params));
        $prev = AttemptStatus::from($a->status);
        $ageMs = (int) abs($a->created_at->diffInMilliseconds(now()));
        $d = StateMachine::decideFor($prev, $result, $a->amount_paisa, $ageMs);
        if ($d->next === null) {
            return;
        }
        $won = PaymentAttempt::whereKey($a->id)->where('status', $prev->value)->update([   // 1 row for exactly one caller
            'status' => $d->next->value,
            'review_required' => $a->review_required || $d->reviewRequired,
            'provider_txn_id' => $result->transactionId,
        ]);
        if ($won === 1 && $d->next === AttemptStatus::Paid && !$d->reviewRequired) {
            FulfilOrder::dispatch($a->order_id);
        }
    }
}
```
CSRF exemption for POST callbacks (Laravel 11+ `bootstrap/app.php`):
```php
->withMiddleware(function (Middleware $middleware): void {
    $middleware->validateCsrfTokens(except: ['payments/*/return', 'payments/*/return/*', 'payments/cybersource/notify']);
})
```
- The default transport is ext-curl. To route calls through Laravel's `Http` client (for `Http::fake()` in feature tests), implement `NepalPayments\Http\HttpTransport` and pass it as the second argument to `Payments::create()`; the interface's docblock has Laravel and Guzzle examples.
- connectIPS: `ConnectIpsConfig::fromPfx(...)` reads the creditor `.pfx` directly. Old RC2-encrypted files fail on OpenSSL 3 with a `pfx_legacy_encryption` error that includes the `openssl pkcs12 -legacy` conversion command.
- Run reconciliation from the scheduler (`Schedule::command('payments:reconcile')->everyFiveMinutes()->withoutOverlapping()`).

## 8. Spring Boot (Java)

The Java adapters (`scripts/java/src/main/java/np/payments/`, JDK 17+, no dependencies) are blocking and thread-safe. On Java 21+, set `spring.threads.virtual.enabled=true` so provider calls don't tie up platform threads.
```java
@Configuration
class PaymentsConfiguration {
    @Bean
    Payments payments() {
        return Payments.create(Payments.configFromEnv());   // fails at startup on missing env or a bad connectIPS key
    }

    @Bean
    SecurityFilterChain security(HttpSecurity http) throws Exception {
        http.csrf(csrf -> csrf.ignoringRequestMatchers(       // cross-site POSTs; integrity comes from verify()
            "/payments/*/return", "/payments/*/return/*", "/payments/cybersource/notify"));
        // ... your existing authorizeHttpRequests(...) etc.
        return http.build();
    }
}

@Controller
class PaymentController {
    // constructor-injected: Payments payments, AttemptRepository attempts, JdbcTemplate jdbc, Fulfilment fulfilment

    @GetMapping("/payments/{id}/start")
    ResponseEntity<String> start(@PathVariable String id) {
        Attempt a = attempts.findById(id).orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND));
        InitiateResult init = a.initiateResult();                 // rebuilt from the stored JSON
        if (init instanceof InitiateResult.Redirect r) {
            return ResponseEntity.status(HttpStatus.FOUND).location(URI.create(r.url())).build();
        }
        return ResponseEntity.ok().contentType(MediaType.TEXT_HTML).body(Html.renderAutoSubmitForm((InitiateResult.Form) init));
    }

    @RequestMapping(value = {"/payments/{provider}/return", "/payments/{provider}/return/{attemptId}"},
                    method = {RequestMethod.GET, RequestMethod.POST})
    ResponseEntity<Void> paymentReturn(@PathVariable String provider, @PathVariable(required = false) String attemptId,
                                       @RequestParam Map<String, String> params) {   // query string + form fields
        if (payments.enabled().stream().noneMatch(p -> p.wire().equals(provider))) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND);
        }
        Attempt a = payments.adapter(provider).orderIdFromCallback(params)
                .or(() -> Optional.ofNullable(attemptId))
                .flatMap(attempts::findById)
                .filter(x -> x.provider().equals(provider))
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND));
        try {
            verifyAndTransition(a, params);
        } catch (RuntimeException e) {
            log.warn("verify failed for {}; reconciliation will retry", a.id(), e);
        }
        return ResponseEntity.status(HttpStatus.SEE_OTHER).location(URI.create("/orders/" + a.orderId() + "?attempt=" + a.id())).build();
    }

    void verifyAndTransition(Attempt a, Map<String, String> params) {
        VerifyResult r = payments.adapter(a.provider())
                .verify(VerifyInput.of(a.id(), a.amountPaisa()).withProviderRef(a.providerRef()).withCallback(params));
        AttemptStatus prev = AttemptStatus.fromWire(a.status());
        long ageMs = Duration.between(a.createdAt(), Instant.now()).toMillis();
        TransitionDecision d = StateMachine.decideTransition(prev, r, a.amountPaisa(), ageMs);
        if (d.next() == null) return;
        int won = jdbc.update(                                       // 1 row for exactly one caller
            "UPDATE payment_attempts SET status = ?, review_required = review_required OR ?, provider_txn_id = ? WHERE id = ? AND status = ?",
            d.next().wire(), d.reviewRequired(), r.transactionId(), a.id(), prev.wire());
        if (won == 1 && d.next() == AttemptStatus.PAID && !d.reviewRequired()) fulfilment.fulfil(a.orderId());
    }
}
```
- connectIPS: `ConnectIps.Config.withPkcs12(...)` loads the creditor `.pfx` directly (no OpenSSL step).
- Run reconciliation with `@Scheduled(fixedDelay = 300_000)` plus a lock (ShedLock or a `SELECT ... FOR UPDATE SKIP LOCKED` batch) if several instances run.
- Quarkus/Micronaut: same calls; only the routing annotations differ.

## 9. Ktor (Kotlin)

The Kotlin adapters (`scripts/kotlin/src/main/kotlin/np/payments/`) expose `suspend` functions, so call them straight from route handlers.
```kotlin
import io.ktor.http.*
import io.ktor.server.request.*
import io.ktor.server.response.*
import io.ktor.server.routing.*
import np.payments.*
import java.time.Instant
import kotlin.time.toKotlinDuration

val payments = Payments.create(paymentsConfigFromEnv())   // fails at boot on a bad key or missing env

fun Route.paymentRoutes(db: PaymentsDb) {
    get("/payments/{id}/start") {
        val a = db.attempt(call.parameters["id"]!!) ?: return@get call.respond(HttpStatusCode.NotFound)
        when (val init = a.initiate) {                     // the stored InitiateResult
            is InitiateResult.Redirect -> call.respondRedirect(init.url)
            is InitiateResult.Form -> call.respondText(renderAutoSubmitForm(init), ContentType.Text.Html)
        }
    }

    route("/payments/{provider}/return/{attemptId?}") {
        handle {                                           // GET and POST
            val params = call.request.queryParameters.entries().associate { it.key to it.value.first() }.toMutableMap()
            if (call.request.httpMethod == HttpMethod.Post) {
                params += call.receiveParameters().entries().associate { it.key to it.value.first() }
            }
            val provider = call.parameters["provider"]!!
            if (ProviderId.fromWire(provider) !in payments.enabled) return@handle call.respond(HttpStatusCode.NotFound)
            val id = payments.adapter(provider).orderIdFromCallback(params) ?: call.parameters["attemptId"]
            val a = id?.let { db.attempt(it) }
            if (a == null || a.provider != provider) return@handle call.respond(HttpStatusCode.NotFound)
            try {
                verifyAndTransition(a, params)
            } catch (e: Exception) {
                log.warn("verify failed for ${a.id}; reconciliation will retry", e)
            }
            call.response.header(HttpHeaders.Location, "/orders/${a.orderId}?attempt=${a.id}")
            call.respond(HttpStatusCode.SeeOther)
        }
    }
}

suspend fun verifyAndTransition(a: Attempt, params: Map<String, String>?) {
    val result = payments.adapter(a.provider).verify(VerifyInput(a.id, a.amountPaisa, a.providerRef, params))
    val prev = AttemptStatus.fromWire(a.status)!!
    val d = decideTransition(prev, result, a.amountPaisa, java.time.Duration.between(a.createdAt, Instant.now()).toKotlinDuration())
    val next = d.next ?: return
    // UPDATE payment_attempts SET status = :next, review_required = review_required OR :review, ...
    //  WHERE id = :id AND status = :prev   -> 1 row for exactly one caller (architecture.md §4)
    val won = db.transition(a.id, from = prev.wire, to = next.wire, reviewRequired = d.reviewRequired, result = result)
    if (won && next == PaymentStatus.PAID && !d.reviewRequired) fulfil(a.orderId)
}
```
- Ktor's CSRF plugin can be installed per route: install it on your session-authenticated routes, not around `/payments/{provider}/return`.
- NPS notifications: `payments.nps.notificationAck(wasFinal, currentStatus)` returns the body to send, or `null` while the status isn't final (respond 503 so NPS retries).
- Spring Boot with Kotlin: use these adapters from `suspend` controller methods, with the Spring Security CSRF exemption from §8.

## 10. Other languages

Go: use `scripts/go/payments/` (stdlib only). `payments.New(payments.ConfigFromEnv())`, then in a Go 1.22 `http.ServeMux` handler for `GET /payments/{provider}/return` and `POST /payments/{provider}/return`: flatten `r.URL.Query()` and `r.PostForm` into a `map[string]string`, call `p.Adapter(r.PathValue("provider"))`, `OrderIDFromCallback`, `Verify(r.Context(), …)`, then `payments.DecideTransition` and the guarded `UPDATE` exactly as in §8. The same applies to chi and Gin.

C#, Ruby, Rust, Dart (server): port from `scripts/ts/src/<provider>.ts`. Each provider reference has signature snippets for PHP, Python, Go and Java, plus **test vectors**. Write the vector tests first and port until they pass, then run the sandbox checks in `testing.md`.

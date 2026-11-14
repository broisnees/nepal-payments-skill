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

export const types: Block = { file: "payments.py", lang: "python", code: `# Types every gateway module speaks, plus settle(), which applies a gateway
# answer to an attempt. Same file for every gateway and every framework.
from dataclasses import dataclass
from html import escape

import store


@dataclass
class Start:
    """What start_payment hands back: send the buyer to a URL, or auto-POST a form."""
    type: str                      # "redirect" | "form"
    url: str | None = None
    action: str | None = None
    fields: dict[str, str] | None = None
    provider_ref: str | None = None
    enctype: str | None = None     # unset = urlencoded; NPS needs "multipart/form-data"


@dataclass
class Outcome:
    status: str                    # paid | pending | failed | canceled | expired | refunded | partially_refunded | not_found | unknown
    provider_ref: str | None = None


class PaymentError(Exception):
    """Bad signature, amount mismatch, provider error. The return route answers 400."""


OPEN = ["initiated", "pending"]


def settle(attempt: store.Attempt, outcome: Outcome) -> None:
    # Safe to call any number of times for the same attempt (return route hit
    # twice, reconcile job racing the buyer): transition() lets exactly one
    # caller move the attempt out of an open state, so fulfil() runs once.
    if outcome.status in ("paid", "failed", "canceled", "expired"):
        if store.transition(attempt.id, OPEN, outcome.status) and outcome.status == "paid":
            # Keep the gateway's transaction id (refunds, support). A ref saved at start
            # (Khalti pidx, IME TokenId, NPS ProcessId) stays: confirm looks the payment up with it.
            if outcome.provider_ref and not attempt.provider_ref:
                store.set_provider_ref(attempt.id, outcome.provider_ref)
            store.fulfil(attempt.order_id)
    elif outcome.status == "pending":
        store.transition(attempt.id, ["initiated"], "pending")
    # not_found and unknown: leave it open. The reconcile job re-checks it and expires a
    # not_found after an hour; an unknown status needs a person. refunded and
    # partially_refunded come after paid: nothing to do.


def auto_post_page(action: str, fields: dict[str, str], enctype: str | None = None) -> str:
    """A page that POSTs the gateway's form as soon as it loads."""
    inputs = "\\n".join(
        f'<input type="hidden" name="{escape(k)}" value="{escape(v)}">' for k, v in fields.items()
    )
    enc = f' enctype="{escape(enctype)}"' if enctype else ""
    return f"""<!doctype html>
<title>Redirecting to payment</title>
<form id="pay" method="post" action="{escape(action)}"{enc}>
{inputs}
<noscript><button>Continue to payment</button></noscript>
</form>
<script>document.getElementById("pay").submit()</script>"""
` };

export const store: Block = { file: "store.py", lang: "python", code: `# In-memory store so the example runs with zero setup.
# Swap for your database: one row per order, one row per payment attempt.
# Data is lost on restart and is not shared between server processes.
import secrets
import threading
import time
from dataclasses import dataclass, field


@dataclass
class Order:
    id: str
    amount_paisa: int


@dataclass
class Attempt:
    id: str                        # 20 lowercase hex chars, fits every gateway's order-id rules
    order_id: str
    amount_paisa: int
    status: str = "initiated"      # initiated | pending | paid | failed | canceled | expired
    provider_ref: str | None = None  # gateway's own id (Khalti pidx, ...), if it gives one
    created_at: float = field(default_factory=time.time)


_orders = {"demo": Order("demo", 10000)}  # Rs 100
_attempts: dict[str, Attempt] = {}
_lock = threading.Lock()  # web servers run requests on several threads


def get_order(order_id: str) -> Order | None:
    return _orders.get(order_id)


def create_attempt(order_id: str, amount_paisa: int) -> Attempt:
    attempt = Attempt(id=secrets.token_hex(10), order_id=order_id, amount_paisa=amount_paisa)
    with _lock:
        _attempts[attempt.id] = attempt
    return attempt


def get_attempt(attempt_id: str) -> Attempt | None:
    return _attempts.get(attempt_id)


def set_provider_ref(attempt_id: str, ref: str) -> None:
    with _lock:
        if attempt_id in _attempts:
            _attempts[attempt_id].provider_ref = ref


def transition(attempt_id: str, from_: list[str], to: str) -> bool:
    # Compare-and-set: move to \`to\` only if the status is still one of \`from_\`.
    # Returns True for exactly one caller. In SQL:
    #   UPDATE attempts SET status = %s WHERE id = %s AND status IN (...)
    # and check that one row changed.
    with _lock:
        attempt = _attempts.get(attempt_id)
        if attempt is None or attempt.status not in from_:
            return False
        attempt.status = to
        return True


def open_attempts(older_than_seconds: float) -> list[Attempt]:
    """Attempts still waiting on the gateway, created at least that long ago."""
    cutoff = time.time() - older_than_seconds
    with _lock:
        return [a for a in _attempts.values()
                if a.status in ("initiated", "pending") and a.created_at <= cutoff]


def latest_attempt(order_id: str) -> Attempt | None:
    with _lock:
        matches = [a for a in _attempts.values() if a.order_id == order_id]
    return matches[-1] if matches else None


def fulfil(order_id: str) -> None:
    # Ship the goods, send the email, ... Runs once per paid attempt.
    print(f"order {order_id} paid, fulfil it here", flush=True)
` };

export const reconcile: Block = { file: "reconcile.py", lang: "python", code: `# Reconcile job: asks the gateway about attempts the buyer never came back from
# (closed the tab, lost signal, callback failed). Runs in a thread inside the web
# server because the in-memory store lives there; with a database, run
# reconcile_once() from cron or a task queue instead.
import threading
import time
import traceback

import store
from payments import settle

HOUR = 60 * 60
REVIEW_AFTER = 3 * 24 * HOUR


def reconcile_once(gateway) -> None:
    # gateway: the gateway module the routes import.
    for attempt in store.open_attempts(120):
        if time.time() - attempt.created_at > REVIEW_AFTER:
            # Still open after 3 days: asking again rarely helps, so a person checks it
            # (gateway dashboard, bank statement) and closes it by hand.
            print(f"attempt {attempt.id} still {attempt.status} after 3 days, needs manual review", flush=True)
            continue
        try:
            # Empty params: no callback here, the gateway module asks the status API.
            outcome = gateway.confirm_payment(attempt.id, attempt.amount_paisa, attempt.provider_ref, {})
            settle(attempt, outcome)
            if outcome.status == "not_found" and time.time() - attempt.created_at > HOUR:
                store.transition(attempt.id, ["initiated", "pending"], "expired")
            print(f"reconcile {attempt.id}: {outcome.status}", flush=True)
        except Exception:
            # Log and move on: one bad attempt must not stop the rest.
            print(f"reconcile {attempt.id} failed:", flush=True)
            traceback.print_exc()


def start_reconcile_loop(gateway, every_seconds: float = 60) -> None:
    def loop() -> None:
        while True:
            time.sleep(every_seconds)
            reconcile_once(gateway)

    threading.Thread(target=loop, daemon=True).start()
` };

export const routes = (g: GatewayNames): Record<"django" | "fastapi" | "flask", Block[]> => ({
  django: [
    { file: "shop/urls.py", lang: "python", code: `from django.urls import path

import ${g.py} as gateway
from reconcile import start_reconcile_loop

from . import views

urlpatterns = [
    path("", views.home),
    path("pay/<str:order_id>", views.pay),
    path("pay/return/<str:attempt_id>", views.payment_return),
    path("orders/<str:order_id>", views.order_status),
]

# Django loads this module once per server process, a fine place to start it.
start_reconcile_loop(gateway)
` },
    { file: "shop/views.py", lang: "python", code: `import logging
import os

from django.http import HttpResponse
from django.middleware.csrf import get_token
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_GET, require_http_methods, require_POST

import ${g.py} as gateway
import store
from payments import PaymentError, auto_post_page, settle

BASE_URL = os.environ.get("BASE_URL", "http://localhost:8000")


def see_other(url: str) -> HttpResponse:
    return HttpResponse(status=303, headers={"Location": url})


@require_GET
def home(request):
    # Our own form posts to /pay/demo, so it carries Django's CSRF token.
    return HttpResponse(f"""<!doctype html><title>Shop</title>
<h1>Order demo, Rs 100</h1>
<form method="post" action="/pay/demo">
<input type="hidden" name="csrfmiddlewaretoken" value="{get_token(request)}">
<button>Pay with ${g.name}</button>
</form>""")


@require_POST
def pay(request, order_id: str):
    order = store.get_order(order_id)
    if order is None:
        return HttpResponse("Order not found", status=404)
    attempt = store.create_attempt(order.id, order.amount_paisa)
    start = gateway.start_payment(
        attempt.id,
        attempt.amount_paisa,
        # A path segment, not ?attempt=: some gateways append their own query string.
        f"{BASE_URL}/pay/return/{attempt.id}",
        f"Order {order.id}",
    )
    if start.provider_ref:
        store.set_provider_ref(attempt.id, start.provider_ref)
    if start.type == "redirect":
        return see_other(start.url)
    return HttpResponse(auto_post_page(start.action, start.fields, start.enctype))


# The gateway posts here without our CSRF token, so exempt this one view.
# confirm_payment checks the gateway's signature and status API instead.
@csrf_exempt
@require_http_methods(["GET", "POST"])
def payment_return(request, attempt_id: str):
    attempt = store.get_attempt(attempt_id)
    if attempt is None:
        return HttpResponse("Payment not found", status=404)
    params = {**request.GET.dict(), **request.POST.dict()}
    try:
        outcome = gateway.confirm_payment(attempt.id, attempt.amount_paisa, attempt.provider_ref, params)
    except PaymentError:
        return HttpResponse("Payment could not be verified", status=400)
    except Exception:
        logging.exception("confirm_payment failed")
        return HttpResponse("Payment gateway error, try again shortly", status=502)
    settle(attempt, outcome)
    return see_other(f"/orders/{attempt.order_id}")


@require_GET
def order_status(request, order_id: str):
    attempt = store.latest_attempt(order_id)
    status = attempt.status if attempt else "no payment yet"
    return HttpResponse(f"Order {order_id}: {status}", content_type="text/plain")
` },
  ],
  fastapi: [{ file: "main.py", lang: "python", code: `import logging
import os
from urllib.parse import parse_qsl

from fastapi import FastAPI, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import HTMLResponse, PlainTextResponse, RedirectResponse

import ${g.py} as gateway
import store
from payments import PaymentError, auto_post_page, settle
from reconcile import start_reconcile_loop

BASE_URL = os.environ.get("BASE_URL", "http://localhost:8000")
app = FastAPI()


@app.get("/", response_class=HTMLResponse)
def home():
    return """<!doctype html><title>Shop</title>
<h1>Order demo, Rs 100</h1>
<form method="post" action="/pay/demo"><button>Pay with ${g.name}</button></form>"""


# A plain \`def\`: FastAPI runs it in a thread pool, so the blocking gateway call
# does not stall other requests.
@app.post("/pay/{order_id}")
def pay(order_id: str):
    order = store.get_order(order_id)
    if order is None:
        return PlainTextResponse("Order not found", 404)
    attempt = store.create_attempt(order.id, order.amount_paisa)
    start = gateway.start_payment(
        attempt.id,
        attempt.amount_paisa,
        # A path segment, not ?attempt=: some gateways append their own query string.
        f"{BASE_URL}/pay/return/{attempt.id}",
        f"Order {order.id}",
    )
    if start.provider_ref:
        store.set_provider_ref(attempt.id, start.provider_ref)
    if start.type == "redirect":
        return RedirectResponse(start.url, 303)
    return HTMLResponse(auto_post_page(start.action, start.fields, start.enctype))


# Gateways come back with GET (query string) or POST (form body). Handle both.
@app.api_route("/pay/return/{attempt_id}", methods=["GET", "POST"])
async def payment_return(attempt_id: str, request: Request):
    attempt = store.get_attempt(attempt_id)
    if attempt is None:
        return PlainTextResponse("Payment not found", 404)
    # Parse the form body by hand: request.form() needs the python-multipart package.
    body = dict(parse_qsl((await request.body()).decode())) if request.method == "POST" else {}
    params = {**request.query_params, **body}
    try:
        outcome = await run_in_threadpool(
            gateway.confirm_payment, attempt.id, attempt.amount_paisa, attempt.provider_ref, params
        )
    except PaymentError:
        return PlainTextResponse("Payment could not be verified", 400)
    except Exception:
        logging.exception("confirm_payment failed")
        return PlainTextResponse("Payment gateway error, try again shortly", 502)
    settle(attempt, outcome)
    return RedirectResponse(f"/orders/{attempt.order_id}", 303)


@app.get("/orders/{order_id}", response_class=PlainTextResponse)
def order_status(order_id: str):
    attempt = store.latest_attempt(order_id)
    return f"Order {order_id}: {attempt.status if attempt else 'no payment yet'}"


start_reconcile_loop(gateway)
` }],
  flask: [{ file: "app.py", lang: "python", code: `import os

from flask import Flask, redirect, request

import ${g.py} as gateway
import store
from payments import PaymentError, auto_post_page, settle
from reconcile import start_reconcile_loop

BASE_URL = os.environ.get("BASE_URL", "http://localhost:8000")
app = Flask(__name__)


@app.get("/")
def home():
    return """<!doctype html><title>Shop</title>
<h1>Order demo, Rs 100</h1>
<form method="post" action="/pay/demo"><button>Pay with ${g.name}</button></form>"""


@app.post("/pay/<order_id>")
def pay(order_id: str):
    order = store.get_order(order_id)
    if order is None:
        return "Order not found", 404
    attempt = store.create_attempt(order.id, order.amount_paisa)
    start = gateway.start_payment(
        attempt.id,
        attempt.amount_paisa,
        # A path segment, not ?attempt=: some gateways append their own query string.
        f"{BASE_URL}/pay/return/{attempt.id}",
        f"Order {order.id}",
    )
    if start.provider_ref:
        store.set_provider_ref(attempt.id, start.provider_ref)
    if start.type == "redirect":
        return redirect(start.url, 303)
    return auto_post_page(start.action, start.fields, start.enctype)


# Gateways come back with GET (query string) or POST (form body). Handle both.
@app.route("/pay/return/<attempt_id>", methods=["GET", "POST"])
def payment_return(attempt_id: str):
    attempt = store.get_attempt(attempt_id)
    if attempt is None:
        return "Payment not found", 404
    params = {**request.args.to_dict(), **request.form.to_dict()}
    try:
        outcome = gateway.confirm_payment(attempt.id, attempt.amount_paisa, attempt.provider_ref, params)
    except PaymentError:
        return "Payment could not be verified", 400
    except Exception:
        app.logger.exception("confirm_payment failed")
        return "Payment gateway error, try again shortly", 502
    settle(attempt, outcome)
    return redirect(f"/orders/{attempt.order_id}", 303)


@app.get("/orders/<order_id>")
def order_status(order_id: str):
    attempt = store.latest_attempt(order_id)
    status = attempt.status if attempt else "no payment yet"
    return f"Order {order_id}: {status}", 200, {"Content-Type": "text/plain"}


start_reconcile_loop(gateway)
` }],
});

// Install, env vars and run, per framework. Every framework listens on port 8000.
export const setup: Record<"django" | "fastapi" | "flask", Block> = {
  django: { file: "terminal", lang: "bash", code: `mkdir shop && cd shop
python3 -m venv .venv
. .venv/bin/activate          # Windows: .venv\\Scripts\\activate
pip install django
django-admin startproject shop .
# Save payments.py, store.py, reconcile.py and the gateway file next to manage.py.
# Replace shop/urls.py and add shop/views.py as shown.

# Plus the gateway's variables from its section.
export BASE_URL=http://localhost:8000   # where the gateway sends the buyer back
python manage.py runserver 8000         # http://localhost:8000` },
  fastapi: { file: "terminal", lang: "bash", code: `mkdir shop && cd shop
python3 -m venv .venv
. .venv/bin/activate          # Windows: .venv\\Scripts\\activate
pip install fastapi uvicorn
# Save payments.py, store.py, reconcile.py, main.py and the gateway file in this folder.

# Plus the gateway's variables from its section.
export BASE_URL=http://localhost:8000   # where the gateway sends the buyer back
uvicorn main:app --port 8000            # http://localhost:8000` },
  flask: { file: "terminal", lang: "bash", code: `mkdir shop && cd shop
python3 -m venv .venv
. .venv/bin/activate          # Windows: .venv\\Scripts\\activate
pip install flask
# Save payments.py, store.py, reconcile.py, app.py and the gateway file in this folder.

# Plus the gateway's variables from its section.
export BASE_URL=http://localhost:8000   # where the gateway sends the buyer back
flask --app app run --port 8000         # http://localhost:8000` },
};

export const runCommand: Record<"django" | "fastapi" | "flask", string> = {"django":"python manage.py runserver 8000","fastapi":"uvicorn main:app --port 8000","flask":"flask --app app run --port 8000"};

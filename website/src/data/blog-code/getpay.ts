// Generated GetPay (NCHL card gateway) module, one per language, plus the card routes each framework needs.
// The parts joined with "\n\n" in order (config, token, start, pages, confirm) form the complete file.
// GetPay runs in the browser (an SDK and four pages), so its post replaces the shared routes with cardRoutes:
// a checkout page, a payment page, a return page that forwards the token, and a verify route.

export interface GatewayCode {
  file: string;
  lang: string;
  parts: { config: string; token: string; start: string; pages: string; confirm: string };
}

export interface Block {
  file: string;
  lang: string;
  code: string;
}

export const getpay: Record<"ts" | "python" | "php" | "go" | "java" | "kotlin", GatewayCode> = {
  ts: {
    file: "getpay.ts",
    lang: "typescript",
    parts: {
      config: `import { PaymentError, escapeHtml, type ConfirmInput, type Outcome, type StartInput } from "./payments";

// GetPay, NCHL's hosted card checkout for banks. UAT unless GETPAY_ENV=production.
const PRODUCTION = process.env.GETPAY_ENV === "production";
// GETPAY_BASE_URL is the URL your bank gives you, or a local mock. The status APIs live under it.
const BASE_URL = (
  process.env.GETPAY_BASE_URL ??
  (PRODUCTION
    ? "https://ecom-getpay.nchl.com.np/ecom-web-checkout/v1/secure-merchant/transactions"
    : "https://uat-bank-getpay.nchl.com.np/ecom-web-checkout/v1/secure-merchant/transactions")
).replace(/\\/+$/, "");
// The browser SDK. The bank sends the URL to use; this is the published UAT bundle.
const BUNDLE_URL = process.env.GETPAY_BUNDLE_URL ?? "https://minio-getpay.nchl.com.np/getpay-cdn/webcheckout/v5/bundle.js";

// All of these come from your bank. There are no public test values.
const PAP_INFO = process.env.GETPAY_PAP_INFO ?? ""; // base64 of {"institutionId","mid","tid"}
const OPR_KEY = process.env.GETPAY_OPR_KEY ?? ""; // reaches the browser by GetPay's design, and signs the return token
const INS_KEY = process.env.GETPAY_INS_KEY ?? ""; // blank when the operator hosts the checkout
const WEBSITE_DOMAIN = process.env.GETPAY_WEBSITE_DOMAIN ?? ""; // the origin the bank registered with NCHL
const BUSINESS_NAME = process.env.GETPAY_BUSINESS_NAME ?? "";
const IMAGE_URL = process.env.GETPAY_IMAGE_URL ?? ""; // absolute URL of your logo, shown on the checkout
const CURRENCY = process.env.GETPAY_CURRENCY ?? "NPR";

// Checked on first use, not at import: next build loads this file without the variables.
function requireConfig(): string {
  if (!PAP_INFO || !OPR_KEY || !WEBSITE_DOMAIN || !BUSINESS_NAME || !IMAGE_URL) {
    throw new Error("Set GETPAY_PAP_INFO, GETPAY_OPR_KEY, GETPAY_WEBSITE_DOMAIN, GETPAY_BUSINESS_NAME and GETPAY_IMAGE_URL");
  }
  return new URL(WEBSITE_DOMAIN).origin;
}

// Not a redirect or a form: the script and options the checkout page hands to GetPay's SDK.
export interface CardStart {
  type: "sdk";
  scriptUrl: string;
  options: Record<string, unknown>;
}`,
      token: `// oprSecret = base64(SHA-256(oprKey + transaction id)). GetPay puts it in the return token,
// and only someone with YOUR oprKey can compute it for a given id.
export async function oprSecret(transactionId: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(OPR_KEY + transactionId));
  return btoa(String.fromCharCode(...new Uint8Array(digest)));
}

// The token is base64 JSON {"id", "oprSecret"}. One integration reports "id:oprSecret" text
// instead, so both are accepted. A "+" can arrive as a space after URL decoding.
export function decodeToken(token: string): { id: string; oprSecret: string } | null {
  let text: string;
  try {
    text = new TextDecoder().decode(Uint8Array.from(atob(token.trim().replaceAll(" ", "+")), (c) => c.charCodeAt(0)));
  } catch {
    return null;
  }
  try {
    const j = JSON.parse(text);
    return typeof j?.id === "string" && typeof j?.oprSecret === "string" && j.id && j.oprSecret
      ? { id: j.id, oprSecret: j.oprSecret }
      : null;
  } catch {
    const i = text.indexOf(":");
    return i > 0 && i < text.length - 1 ? { id: text.slice(0, i), oprSecret: text.slice(i + 1) } : null;
  }
}

// Compares every character, so the time taken doesn't say how much of a guess was right.
function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}`,
      start: `// Builds the options for GetPay's browser SDK. Nothing is sent to GetPay yet: the checkout page does that.
export async function startPayment(input: StartInput): Promise<CardStart> {
  const origin = requireConfig();
  // clientRequestId: present and non-empty, at most 50 characters. Our attempt ids are 20 hex characters.
  if (!/^[A-Za-z0-9-]{1,50}$/.test(input.attemptId)) {
    throw new Error(\`GetPay clientRequestId must be 1 to 50 letters, digits or "-": \${input.attemptId}\`);
  }
  // GetPay sends the buyer back only to the registered domain. Catch a wrong BASE_URL here, not at the bank.
  if (new URL(input.returnUrl).origin !== origin) {
    throw new Error(\`GetPay return URL \${input.returnUrl} must be on GETPAY_WEBSITE_DOMAIN (\${origin})\`);
  }
  const rupees = input.amountPaisa / 100;
  return {
    type: "sdk",
    scriptUrl: BUNDLE_URL,
    options: {
      clientRequestId: input.attemptId, // comes back as clientId in merchant-status
      papInfo: PAP_INFO,
      oprKey: OPR_KEY,
      insKey: INS_KEY,
      websiteDomain: origin,
      baseUrl: BASE_URL,
      price: rupees, // a NUMBER in rupees: 100, not "100.00" and not 10000
      currency: CURRENCY,
      businessName: BUSINESS_NAME,
      imageUrl: IMAGE_URL,
      themeColor: "#5662FF",
      allowBillingAddressFields: true,
      userInfo: { name: "", email: "", state: "", country: "", zipcode: "", city: "", address: "" },
      prefill: { name: false, email: false, state: false, city: false, address: false, zipcode: false, country: false },
      disableFields: {},
      // Success and failure land on the same page. The status API says which one it was.
      callbackUrl: { successUrl: input.returnUrl, failUrl: input.returnUrl },
      // Inline HTML on GetPay's page, so escape our own text.
      orderInformationUI: \`<div style="font-family:sans-serif"><h3>\${escapeHtml(input.description)}</h3><p>\${escapeHtml(CURRENCY)} \${rupees.toFixed(2)}</p></div>\`,
    },
  };
}`,
      pages: `// JSON for an inline <script>: "<" is escaped, so a value can't close the script tag.
const inline = (v: unknown) => JSON.stringify(v).replaceAll("<", "\\\\u003c");

// Page 1, checkout: loads the SDK and starts it. When GetPay accepts the options, onSuccess opens page 2.
// onSuccess and onError are functions, so they are added here in the browser, not sent from the server.
export function checkoutPage(start: CardStart, paymentPageUrl: string): string {
  return \`<!doctype html><meta charset="utf-8"><title>Checkout</title>
<script defer src="\${escapeHtml(start.scriptUrl)}"></script>
<p>Starting card checkout.</p>
<noscript>JavaScript is required to pay by card.</noscript>
<script>
window.addEventListener("load", () => {
  const options = \${inline(start.options)};
  options.onSuccess = () => { location.href = \${inline(paymentPageUrl)}; };
  options.onError = (err) => { console.error(err); document.body.insertAdjacentHTML("beforeend", "<p>Card checkout could not start. Try again.</p>"); };
  new GetPay(options).initialize();
});
</script>\`;
}

// Page 2, payment: GetPay draws the card form and runs 3-D Secure inside #checkout.
export function paymentPage(): string {
  return \`<!doctype html><meta charset="utf-8"><title>Pay by card</title>
<script defer src="\${escapeHtml(BUNDLE_URL)}"></script>
<div id="checkout"></div>\`;
}

// Pages 3 and 4, where GetPay sends the buyer back. First leave GetPay's iframe, then read the
// token from the query or the #hash (cards without 3-D Secure put it in the hash, which never
// reaches a server) and hand it to our verify route as ?token=.
export function returnPage(verifyUrl: string): string {
  return \`<!doctype html><meta charset="utf-8"><title>Confirming payment</title>
<p>Confirming your payment.</p>
<script>
if (window.top !== window.self) {
  window.top.location = window.self.location.href;
} else {
  const hash = location.hash.replace(/^#/, "");
  const token = new URLSearchParams(location.search).get("token")
    || new URLSearchParams(hash.includes("?") ? hash.slice(hash.indexOf("?") + 1) : hash).get("token");
  const next = new URL(\${inline(verifyUrl)}, location.href);
  if (token) next.searchParams.set("token", token);
  location.replace(next.toString());
}
</script>\`;
}`,
      confirm: `// GetPay's transaction status -> ours. Anything else counts as pending, so the reconcile job asks again.
const STATUSES: Record<string, Outcome["status"]> = {
  SUCCESS: "paid",
  APPROVED: "paid",
  FAILED: "failed",
  FAILURE: "failed",
  DECLINED: "failed",
  PENDING: "pending",
  CANCELLED: "canceled",
  CANCELED: "canceled",
};

// POSTs JSON to a status API (no auth headers). Returns data, or null for "not found".
async function statusApi(path: "merchant-status" | "transaction-statement", body: Record<string, string>) {
  const res = await fetch(\`\${BASE_URL}/\${path}\`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const json = await res.json().catch(() => null);
  // HTTP 400 with status -1 and "...not found..." is an answer: GetPay has no such transaction.
  if (json?.status === -1 && /not found/i.test(String(json.message))) return null;
  if (res.status !== 200 || json?.status !== 0 || typeof json.data !== "object" || !json.data) {
    throw new Error(\`GetPay \${path} failed: HTTP \${res.status} \${JSON.stringify(json)}\`);
  }
  return json.data as Record<string, unknown>;
}

// Called from the verify route (params.token from the return page) and from the reconcile job (params = {}).
export async function confirmPayment(input: ConfirmInput): Promise<Outcome> {
  requireConfig();
  const token = input.params.token;

  if (!token) {
    // No token: the buyer never reached the return page. Look the attempt up by clientRequestId.
    // Any GetPay merchant can create a transaction with the same clientRequestId, so a SUCCESS
    // here doesn't prove the money is ours. Keep it pending: the buyer's return or a person decides.
    const s = await statusApi("transaction-statement", { clientRequestId: input.attemptId });
    if (!s) return { status: "not_found" };
    const ours = STATUSES[String(s.status ?? "").toUpperCase()] ?? "pending";
    return { status: ours === "paid" ? "pending" : ours };
  }

  // The token must carry an oprSecret that only our oprKey produces for its id.
  const t = decodeToken(token);
  if (!t) throw new PaymentError("GetPay: return token is not base64 {id, oprSecret}");
  if (!sameText(await oprSecret(t.id), t.oprSecret)) throw new PaymentError("GetPay: oprSecret does not match");

  // merchant-status answers for ANY transaction id, whoever asks, so check whose payment it is.
  const d = await statusApi("merchant-status", { id: t.id, papInfo: PAP_INFO });
  if (!d) return { status: "not_found" };
  if (String(d.clientId ?? "") !== input.attemptId) throw new PaymentError("GetPay: transaction is for another clientRequestId");
  const ours = STATUSES[String(d.status ?? "").toUpperCase()] ?? "pending";
  // amount is rupees as a number (100.0). Compare in paisa with the amount WE stored.
  if (ours === "paid" && Math.round(Number(d.amount) * 100) !== input.amountPaisa) {
    throw new PaymentError(\`GetPay: amount mismatch (\${d.amount})\`);
  }
  // The GetPay transaction id is what the bank's portal and disputes use.
  return { status: ours, providerRef: t.id };
}`,
    },
  },
  python: {
    file: "getpay.py",
    lang: "python",
    parts: {
      config: `import base64
import binascii
import hashlib
import hmac
import json
import os
import re
import urllib.error
import urllib.request
from dataclasses import dataclass
from html import escape
from urllib.parse import urlsplit

from payments import Outcome, PaymentError

# GetPay, NCHL's hosted card checkout for banks. UAT unless GETPAY_ENV=production.
PRODUCTION = os.environ.get("GETPAY_ENV") == "production"
# GETPAY_BASE_URL is the URL your bank gives you, or a local mock. The status APIs live under it.
BASE_URL = (os.environ.get("GETPAY_BASE_URL") or (
    "https://ecom-getpay.nchl.com.np/ecom-web-checkout/v1/secure-merchant/transactions" if PRODUCTION
    else "https://uat-bank-getpay.nchl.com.np/ecom-web-checkout/v1/secure-merchant/transactions")).rstrip("/")
# The browser SDK. The bank sends the URL to use; this is the published UAT bundle.
BUNDLE_URL = os.environ.get("GETPAY_BUNDLE_URL") or "https://minio-getpay.nchl.com.np/getpay-cdn/webcheckout/v5/bundle.js"

# All of these come from your bank. There are no public test values.
PAP_INFO = os.environ.get("GETPAY_PAP_INFO", "")  # base64 of {"institutionId","mid","tid"}
OPR_KEY = os.environ.get("GETPAY_OPR_KEY", "")  # reaches the browser by GetPay's design, and signs the return token
INS_KEY = os.environ.get("GETPAY_INS_KEY", "")  # blank when the operator hosts the checkout
WEBSITE_DOMAIN = os.environ.get("GETPAY_WEBSITE_DOMAIN", "")  # the origin the bank registered with NCHL
BUSINESS_NAME = os.environ.get("GETPAY_BUSINESS_NAME", "")
IMAGE_URL = os.environ.get("GETPAY_IMAGE_URL", "")  # absolute URL of your logo, shown on the checkout
CURRENCY = os.environ.get("GETPAY_CURRENCY") or "NPR"
if not (PAP_INFO and OPR_KEY and WEBSITE_DOMAIN and BUSINESS_NAME and IMAGE_URL):
    raise RuntimeError("Set GETPAY_PAP_INFO, GETPAY_OPR_KEY, GETPAY_WEBSITE_DOMAIN, GETPAY_BUSINESS_NAME and GETPAY_IMAGE_URL")


def _origin(url: str) -> str:
    u = urlsplit(url)
    return f"{u.scheme}://{u.netloc}"


ORIGIN = _origin(WEBSITE_DOMAIN)


@dataclass
class CardStart:
    """Not a redirect or a form: the script and options the checkout page hands to GetPay's SDK."""
    script_url: str
    options: dict
    type: str = "sdk"
    provider_ref: str | None = None  # GetPay assigns its id later, in the return token`,
      token: `def opr_secret(transaction_id: str) -> str:
    """base64(SHA-256(oprKey + transaction id)). GetPay puts it in the return token,
    and only someone with YOUR oprKey can compute it for a given id."""
    return base64.b64encode(hashlib.sha256((OPR_KEY + transaction_id).encode()).digest()).decode()


def decode_token(token: str) -> tuple[str, str] | None:
    """The token is base64 JSON {"id", "oprSecret"}. One integration reports "id:oprSecret" text
    instead, so both are accepted. A "+" can arrive as a space after URL decoding."""
    try:
        text = base64.b64decode(token.strip().replace(" ", "+"), validate=True).decode()
    except (binascii.Error, ValueError):
        return None
    try:
        j = json.loads(text)
    except ValueError:
        tx_id, sep, secret = text.partition(":")
        return (tx_id, secret) if sep and tx_id and secret else None
    if isinstance(j, dict) and isinstance(j.get("id"), str) and isinstance(j.get("oprSecret"), str) \\
            and j["id"] and j["oprSecret"]:
        return j["id"], j["oprSecret"]
    return None`,
      start: `def start_payment(attempt_id: str, amount_paisa: int, return_url: str, description: str) -> CardStart:
    """Builds the options for GetPay's browser SDK. Nothing is sent to GetPay yet: the checkout page does that."""
    # clientRequestId: present and non-empty, at most 50 characters. Our attempt ids are 20 hex characters.
    if not re.fullmatch(r"[A-Za-z0-9-]{1,50}", attempt_id):
        raise ValueError(f'GetPay clientRequestId must be 1 to 50 letters, digits or "-": {attempt_id}')
    # GetPay sends the buyer back only to the registered domain. Catch a wrong BASE_URL here, not at the bank.
    if _origin(return_url) != ORIGIN:
        raise ValueError(f"GetPay return URL {return_url} must be on GETPAY_WEBSITE_DOMAIN ({ORIGIN})")
    rupees = amount_paisa / 100
    return CardStart(script_url=BUNDLE_URL, options={
        "clientRequestId": attempt_id,  # comes back as clientId in merchant-status
        "papInfo": PAP_INFO,
        "oprKey": OPR_KEY,
        "insKey": INS_KEY,
        "websiteDomain": ORIGIN,
        "baseUrl": BASE_URL,
        "price": rupees,  # a NUMBER in rupees: 100.0, not "100.00" and not 10000
        "currency": CURRENCY,
        "businessName": BUSINESS_NAME,
        "imageUrl": IMAGE_URL,
        "themeColor": "#5662FF",
        "allowBillingAddressFields": True,
        "userInfo": {"name": "", "email": "", "state": "", "country": "", "zipcode": "", "city": "", "address": ""},
        "prefill": {k: False for k in ("name", "email", "state", "city", "address", "zipcode", "country")},
        "disableFields": {},
        # Success and failure land on the same page. The status API says which one it was.
        "callbackUrl": {"successUrl": return_url, "failUrl": return_url},
        # Inline HTML on GetPay's page, so escape our own text.
        "orderInformationUI": f'<div style="font-family:sans-serif"><h3>{escape(description)}</h3>'
                              f"<p>{escape(CURRENCY)} {rupees:.2f}</p></div>",
    })`,
      pages: `def _inline(value) -> str:
    """JSON for an inline <script>: "<" is escaped, so a value can't close the script tag."""
    return json.dumps(value).replace("<", "\\\\u003c")


CHECKOUT_PAGE = """<!doctype html><meta charset="utf-8"><title>Checkout</title>
<script defer src="SCRIPT_URL"></script>
<p>Starting card checkout.</p>
<noscript>JavaScript is required to pay by card.</noscript>
<script>
window.addEventListener("load", () => {
  const options = OPTIONS;
  options.onSuccess = () => { location.href = PAYMENT_PAGE_URL; };
  options.onError = (err) => { console.error(err); document.body.insertAdjacentHTML("beforeend", "<p>Card checkout could not start. Try again.</p>"); };
  new GetPay(options).initialize();
});
</script>"""


def checkout_page(start: CardStart, payment_page_url: str) -> str:
    """Page 1, checkout: loads the SDK and starts it. When GetPay accepts the options, onSuccess opens page 2.
    onSuccess and onError are functions, so they are added here in the browser, not sent from the server."""
    # Plain replace, not an f-string: the script's own braces would need doubling. Options go in last.
    return (CHECKOUT_PAGE.replace("SCRIPT_URL", escape(start.script_url))
            .replace("PAYMENT_PAGE_URL", _inline(payment_page_url))
            .replace("OPTIONS", _inline(start.options)))


def payment_page() -> str:
    """Page 2, payment: GetPay draws the card form and runs 3-D Secure inside #checkout."""
    return f"""<!doctype html><meta charset="utf-8"><title>Pay by card</title>
<script defer src="{escape(BUNDLE_URL)}"></script>
<div id="checkout"></div>"""


RETURN_PAGE = """<!doctype html><meta charset="utf-8"><title>Confirming payment</title>
<p>Confirming your payment.</p>
<script>
if (window.top !== window.self) {
  window.top.location = window.self.location.href;
} else {
  const hash = location.hash.replace(/^#/, "");
  const token = new URLSearchParams(location.search).get("token")
    || new URLSearchParams(hash.includes("?") ? hash.slice(hash.indexOf("?") + 1) : hash).get("token");
  const next = new URL(VERIFY_URL, location.href);
  if (token) next.searchParams.set("token", token);
  location.replace(next.toString());
}
</script>"""


def return_page(verify_url: str) -> str:
    """Pages 3 and 4, where GetPay sends the buyer back. First leave GetPay's iframe, then read the
    token from the query or the #hash (cards without 3-D Secure put it in the hash, which never
    reaches a server) and hand it to our verify route as ?token=."""
    return RETURN_PAGE.replace("VERIFY_URL", _inline(verify_url))`,
      confirm: `# GetPay's transaction status -> ours. Anything else counts as pending, so the reconcile job asks again.
STATUSES = {
    "SUCCESS": "paid",
    "APPROVED": "paid",
    "FAILED": "failed",
    "FAILURE": "failed",
    "DECLINED": "failed",
    "PENDING": "pending",
    "CANCELLED": "canceled",
    "CANCELED": "canceled",
}


def _status_api(path: str, payload: dict) -> dict | None:
    """POSTs JSON to a status API (no auth headers). Returns data, or None for "not found"."""
    req = urllib.request.Request(f"{BASE_URL}/{path}", data=json.dumps(payload).encode(), method="POST",
                                 # Our own User-Agent: the UAT host answers urllib's default
                                 # "Python-urllib/3.x" with a Cloudflare 403 (error code 1010).
                                 headers={"Content-Type": "application/json", "User-Agent": "shop/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=20) as res:
            status, raw = res.status, res.read()
    except urllib.error.HTTPError as e:  # not found comes back as HTTP 400, body included
        status, raw = e.code, e.read()
    try:
        body = json.loads(raw)
    except ValueError:
        body = None
    body = body if isinstance(body, dict) else {}
    # HTTP 400 with status -1 and "...not found..." is an answer: GetPay has no such transaction.
    if body.get("status") == -1 and "not found" in str(body.get("message", "")).lower():
        return None
    if status != 200 or body.get("status") != 0 or not isinstance(body.get("data"), dict):
        raise RuntimeError(f"GetPay {path} failed: HTTP {status} {body}")
    return body["data"]


def confirm_payment(attempt_id: str, amount_paisa: int, provider_ref: str | None, params: dict[str, str]) -> Outcome:
    """Called from the verify route (params["token"] from the return page) and from the reconcile job (params = {})."""
    token = params.get("token")

    if not token:
        # No token: the buyer never reached the return page. Look the attempt up by clientRequestId.
        # Any GetPay merchant can create a transaction with the same clientRequestId, so a SUCCESS
        # here doesn't prove the money is ours. Keep it pending: the buyer's return or a person decides.
        s = _status_api("transaction-statement", {"clientRequestId": attempt_id})
        if s is None:
            return Outcome(status="not_found")
        ours = STATUSES.get(str(s.get("status", "")).upper(), "pending")
        return Outcome(status="pending" if ours == "paid" else ours)

    # The token must carry an oprSecret that only our oprKey produces for its id.
    decoded = decode_token(token)
    if decoded is None:
        raise PaymentError("GetPay: return token is not base64 {id, oprSecret}")
    tx_id, secret = decoded
    if not hmac.compare_digest(opr_secret(tx_id).encode(), secret.encode()):
        raise PaymentError("GetPay: oprSecret does not match")

    # merchant-status answers for ANY transaction id, whoever asks, so check whose payment it is.
    d = _status_api("merchant-status", {"id": tx_id, "papInfo": PAP_INFO})
    if d is None:
        return Outcome(status="not_found")
    if str(d.get("clientId") or "") != attempt_id:
        raise PaymentError("GetPay: transaction is for another clientRequestId")
    ours = STATUSES.get(str(d.get("status", "")).upper(), "pending")
    if ours == "paid":
        # amount is rupees as a number (100.0). Compare in paisa with the amount WE stored.
        try:
            got = round(float(d.get("amount")) * 100)
        except (TypeError, ValueError, OverflowError):
            got = None
        if got != amount_paisa:
            raise PaymentError(f"GetPay: amount mismatch ({d.get('amount')})")
    # The GetPay transaction id is what the bank's portal and disputes use.
    return Outcome(status=ours, provider_ref=tx_id)`,
    },
  },
  php: {
    file: "GetPayGateway.php",
    lang: "php",
    parts: {
      config: `<?php

declare(strict_types=1);

namespace App\\Payments;

// What startCard() hands back. The shared Start type only knows redirects and forms,
// and GetPay is neither: the checkout page hands these options to GetPay's browser SDK.
final class CardStart
{
    public function __construct(
        public readonly string $scriptUrl,
        public readonly array $options,
    ) {
    }
}

// GetPay, NCHL's hosted card checkout for banks. UAT unless GETPAY_ENV=production.
final class GetPayGateway implements Gateway
{
    private string $origin;

    public function __construct(
        private string $papInfo, // base64 of {"institutionId","mid","tid"}
        private string $oprKey, // reaches the browser by GetPay's design, and signs the return token
        private string $insKey, // blank when the operator hosts the checkout
        string $websiteDomain, // the origin the bank registered with NCHL
        private string $businessName,
        private string $imageUrl, // absolute URL of your logo, shown on the checkout
        private string $currency,
        private string $baseUrl,
        private string $bundleUrl,
    ) {
        $this->origin = self::origin($websiteDomain);
    }

    public static function fromEnv(): self
    {
        $env = static fn (string $name) => $_ENV[$name] ?? (getenv($name) !== false ? getenv($name) : '');
        $production = $env('GETPAY_ENV') === 'production';
        // All of these come from your bank. There are no public test values.
        $required = ['GETPAY_PAP_INFO', 'GETPAY_OPR_KEY', 'GETPAY_WEBSITE_DOMAIN', 'GETPAY_BUSINESS_NAME', 'GETPAY_IMAGE_URL'];
        foreach ($required as $name) {
            if ($env($name) === '') {
                throw new \\RuntimeException('Set ' . implode(', ', $required));
            }
        }
        return new self(
            $env('GETPAY_PAP_INFO'),
            $env('GETPAY_OPR_KEY'),
            $env('GETPAY_INS_KEY'),
            $env('GETPAY_WEBSITE_DOMAIN'),
            $env('GETPAY_BUSINESS_NAME'),
            $env('GETPAY_IMAGE_URL'),
            $env('GETPAY_CURRENCY') ?: 'NPR',
            // GETPAY_BASE_URL is the URL your bank gives you, or a local mock. The status APIs live under it.
            rtrim($env('GETPAY_BASE_URL') ?: ($production
                ? 'https://ecom-getpay.nchl.com.np/ecom-web-checkout/v1/secure-merchant/transactions'
                : 'https://uat-bank-getpay.nchl.com.np/ecom-web-checkout/v1/secure-merchant/transactions'), '/'),
            // The browser SDK. The bank sends the URL to use; this is the published UAT bundle.
            $env('GETPAY_BUNDLE_URL') ?: 'https://minio-getpay.nchl.com.np/getpay-cdn/webcheckout/v5/bundle.js',
        );
    }

    private static function origin(string $url): string
    {
        $u = parse_url($url);
        return ($u['scheme'] ?? '') . '://' . ($u['host'] ?? '') . (isset($u['port']) ? ':' . $u['port'] : '');
    }`,
      token: `    // oprSecret = base64(SHA-256(oprKey + transaction id)). GetPay puts it in the return token,
    // and only someone with YOUR oprKey can compute it for a given id.
    public function oprSecret(string $transactionId): string
    {
        return base64_encode(hash('sha256', $this->oprKey . $transactionId, true));
    }

    // The token is base64 JSON {"id", "oprSecret"}. One integration reports "id:oprSecret" text
    // instead, so both are accepted. A "+" can arrive as a space after URL decoding.
    public static function decodeToken(string $token): ?array
    {
        $text = base64_decode(str_replace(' ', '+', trim($token)), true);
        if ($text === false) {
            return null;
        }
        $j = json_decode($text, true);
        if (is_array($j)) {
            return is_string($j['id'] ?? null) && is_string($j['oprSecret'] ?? null) && $j['id'] !== '' && $j['oprSecret'] !== ''
                ? [$j['id'], $j['oprSecret']]
                : null;
        }
        $i = strpos($text, ':');
        return $i !== false && $i > 0 && $i < strlen($text) - 1 ? [substr($text, 0, $i), substr($text, $i + 1)] : null;
    }`,
      start: `    // Gateway asks for startPayment(), which ends in a redirect or a form. GetPay has neither,
    // so the card routes call startCard() below. The reconcile job only needs confirmPayment().
    public function startPayment(string $attemptId, int $amountPaisa, string $returnUrl, string $description): Start
    {
        throw new \\LogicException('GetPay starts in the browser: call startCard()');
    }

    // Builds the options for GetPay's browser SDK. Nothing is sent to GetPay yet: the checkout page does that.
    public function startCard(string $attemptId, int $amountPaisa, string $returnUrl, string $description): CardStart
    {
        // clientRequestId: present and non-empty, at most 50 characters. Our attempt ids are 20 hex characters.
        if (preg_match('/^[A-Za-z0-9-]{1,50}$/', $attemptId) !== 1) {
            throw new \\InvalidArgumentException("GetPay clientRequestId must be 1 to 50 letters, digits or \\"-\\": $attemptId");
        }
        // GetPay sends the buyer back only to the registered domain. Catch a wrong BASE_URL here, not at the bank.
        if (self::origin($returnUrl) !== $this->origin) {
            throw new \\InvalidArgumentException("GetPay return URL $returnUrl must be on GETPAY_WEBSITE_DOMAIN ({$this->origin})");
        }
        $rupees = $amountPaisa / 100;
        $e = fn (string $s): string => htmlspecialchars($s, ENT_QUOTES);
        $no = ['name' => false, 'email' => false, 'state' => false, 'city' => false, 'address' => false, 'zipcode' => false, 'country' => false];
        return new CardStart($this->bundleUrl, [
            'clientRequestId' => $attemptId, // comes back as clientId in merchant-status
            'papInfo' => $this->papInfo,
            'oprKey' => $this->oprKey,
            'insKey' => $this->insKey,
            'websiteDomain' => $this->origin,
            'baseUrl' => $this->baseUrl,
            'price' => $rupees, // a NUMBER in rupees: 100, not "100.00" and not 10000
            'currency' => $this->currency,
            'businessName' => $this->businessName,
            'imageUrl' => $this->imageUrl,
            'themeColor' => '#5662FF',
            'allowBillingAddressFields' => true,
            'userInfo' => ['name' => '', 'email' => '', 'state' => '', 'country' => '', 'zipcode' => '', 'city' => '', 'address' => ''],
            'prefill' => $no,
            'disableFields' => new \\stdClass(), // {} in JSON, not []
            // Success and failure land on the same page. The status API says which one it was.
            'callbackUrl' => ['successUrl' => $returnUrl, 'failUrl' => $returnUrl],
            // Inline HTML on GetPay's page, so escape our own text.
            'orderInformationUI' => '<div style="font-family:sans-serif"><h3>' . $e($description) . '</h3><p>'
                . $e($this->currency) . ' ' . number_format($rupees, 2, '.', '') . '</p></div>',
        ]);
    }`,
      pages: `    // JSON for an inline <script>: JSON_HEX_TAG escapes "<" and ">", so a value can't close the script tag.
    private static function inline(mixed $value): string
    {
        return json_encode($value, JSON_HEX_TAG | JSON_HEX_AMP | JSON_UNESCAPED_SLASHES | JSON_PRESERVE_ZERO_FRACTION | JSON_THROW_ON_ERROR);
    }

    // Page 1, checkout: loads the SDK and starts it. When GetPay accepts the options, onSuccess opens page 2.
    // onSuccess and onError are functions, so they are added here in the browser, not sent from the server.
    public function checkoutPage(CardStart $start, string $paymentPageUrl): string
    {
        $script = htmlspecialchars($start->scriptUrl, ENT_QUOTES);
        $options = self::inline($start->options);
        $next = self::inline($paymentPageUrl);
        return <<<HTML
<!doctype html><meta charset="utf-8"><title>Checkout</title>
<script defer src="$script"></script>
<p>Starting card checkout.</p>
<noscript>JavaScript is required to pay by card.</noscript>
<script>
window.addEventListener("load", () => {
  const options = $options;
  options.onSuccess = () => { location.href = $next; };
  options.onError = (err) => { console.error(err); document.body.insertAdjacentHTML("beforeend", "<p>Card checkout could not start. Try again.</p>"); };
  new GetPay(options).initialize();
});
</script>
HTML;
    }

    // Page 2, payment: GetPay draws the card form and runs 3-D Secure inside #checkout.
    public function paymentPage(): string
    {
        $script = htmlspecialchars($this->bundleUrl, ENT_QUOTES);
        return <<<HTML
<!doctype html><meta charset="utf-8"><title>Pay by card</title>
<script defer src="$script"></script>
<div id="checkout"></div>
HTML;
    }

    // Pages 3 and 4, where GetPay sends the buyer back. First leave GetPay's iframe, then read the
    // token from the query or the #hash (cards without 3-D Secure put it in the hash, which never
    // reaches a server) and hand it to our verify route as ?token=.
    public function returnPage(string $verifyUrl): string
    {
        $next = self::inline($verifyUrl);
        return <<<HTML
<!doctype html><meta charset="utf-8"><title>Confirming payment</title>
<p>Confirming your payment.</p>
<script>
if (window.top !== window.self) {
  window.top.location = window.self.location.href;
} else {
  const hash = location.hash.replace(/^#/, "");
  const token = new URLSearchParams(location.search).get("token")
    || new URLSearchParams(hash.includes("?") ? hash.slice(hash.indexOf("?") + 1) : hash).get("token");
  const next = new URL($next, location.href);
  if (token) next.searchParams.set("token", token);
  location.replace(next.toString());
}
</script>
HTML;
    }`,
      confirm: `    // GetPay's transaction status -> ours. Anything else counts as pending, so the reconcile job asks again.
    private const STATUSES = [
        'SUCCESS' => 'paid',
        'APPROVED' => 'paid',
        'FAILED' => 'failed',
        'FAILURE' => 'failed',
        'DECLINED' => 'failed',
        'PENDING' => 'pending',
        'CANCELLED' => 'canceled',
        'CANCELED' => 'canceled',
    ];

    // POSTs JSON to a status API (no auth headers). Returns data, or null for "not found".
    private function statusApi(string $path, array $payload): ?array
    {
        $ch = curl_init("{$this->baseUrl}/$path");
        curl_setopt_array($ch, [
            CURLOPT_POST => true,
            CURLOPT_POSTFIELDS => json_encode($payload),
            CURLOPT_HTTPHEADER => ['Content-Type: application/json'],
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT => 20,
        ]);
        $raw = curl_exec($ch);
        $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        if (!is_string($raw)) {
            throw new \\RuntimeException('GetPay unreachable: ' . curl_error($ch));
        }
        $body = json_decode($raw, true);
        // HTTP 400 with status -1 and "...not found..." is an answer: GetPay has no such transaction.
        if (($body['status'] ?? null) === -1 && stripos((string) ($body['message'] ?? ''), 'not found') !== false) {
            return null;
        }
        if ($code !== 200 || ($body['status'] ?? null) !== 0 || !is_array($body['data'] ?? null)) {
            throw new \\RuntimeException("GetPay $path failed: HTTP $code $raw");
        }
        return $body['data'];
    }

    // Called from the verify route (['token' => ...] from the return page) and from the reconcile job ([]).
    public function confirmPayment(string $attemptId, int $amountPaisa, ?string $providerRef, array $params): Outcome
    {
        $token = (string) ($params['token'] ?? '');

        if ($token === '') {
            // No token: the buyer never reached the return page. Look the attempt up by clientRequestId.
            // Any GetPay merchant can create a transaction with the same clientRequestId, so a SUCCESS
            // here doesn't prove the money is ours. Keep it pending: the buyer's return or a person decides.
            $s = $this->statusApi('transaction-statement', ['clientRequestId' => $attemptId]);
            if ($s === null) {
                return new Outcome('not_found');
            }
            $ours = self::STATUSES[strtoupper((string) ($s['status'] ?? ''))] ?? 'pending';
            return new Outcome($ours === 'paid' ? 'pending' : $ours);
        }

        // The token must carry an oprSecret that only our oprKey produces for its id.
        $decoded = self::decodeToken($token);
        if ($decoded === null) {
            throw new PaymentError('GetPay: return token is not base64 {id, oprSecret}');
        }
        [$id, $secret] = $decoded;
        if (!hash_equals($this->oprSecret($id), $secret)) {
            throw new PaymentError('GetPay: oprSecret does not match');
        }

        // merchant-status answers for ANY transaction id, whoever asks, so check whose payment it is.
        $d = $this->statusApi('merchant-status', ['id' => $id, 'papInfo' => $this->papInfo]);
        if ($d === null) {
            return new Outcome('not_found');
        }
        if ((string) ($d['clientId'] ?? '') !== $attemptId) {
            throw new PaymentError('GetPay: transaction is for another clientRequestId');
        }
        $ours = self::STATUSES[strtoupper((string) ($d['status'] ?? ''))] ?? 'pending';
        // amount is rupees as a number (100.0). Compare in paisa with the amount WE stored.
        if ($ours === 'paid' && (!is_numeric($d['amount'] ?? null) || (int) round((float) $d['amount'] * 100) !== $amountPaisa)) {
            throw new PaymentError('GetPay: amount mismatch (' . json_encode($d['amount'] ?? null) . ')');
        }
        // The GetPay transaction id is what the bank's portal and disputes use.
        return new Outcome($ours, $id);
    }
}`,
    },
  },
  go: {
    file: "payments/getpay.go",
    lang: "go",
    parts: {
      config: `package payments

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"html"
	"io"
	"math"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// GetPay is NCHL's hosted card checkout for banks. UAT unless GETPAY_ENV=production.
type GetPay struct {
	papInfo, oprKey, insKey, origin  string
	businessName, imageURL, currency string
	baseURL, bundleURL               string
	client                           *http.Client
}

func NewGetPay() *GetPay {
	g := &GetPay{
		// All of these come from your bank. There are no public test values.
		papInfo:      os.Getenv("GETPAY_PAP_INFO"), // base64 of {"institutionId","mid","tid"}
		oprKey:       os.Getenv("GETPAY_OPR_KEY"),  // reaches the browser by GetPay's design, and signs the return token
		insKey:       os.Getenv("GETPAY_INS_KEY"),  // blank when the operator hosts the checkout
		businessName: os.Getenv("GETPAY_BUSINESS_NAME"),
		imageURL:     os.Getenv("GETPAY_IMAGE_URL"), // absolute URL of your logo, shown on the checkout
		currency:     os.Getenv("GETPAY_CURRENCY"),
		baseURL:      "https://uat-bank-getpay.nchl.com.np/ecom-web-checkout/v1/secure-merchant/transactions",
		// The browser SDK. The bank sends the URL to use; this is the published UAT bundle.
		bundleURL: "https://minio-getpay.nchl.com.np/getpay-cdn/webcheckout/v5/bundle.js",
		client:    &http.Client{Timeout: 20 * time.Second},
	}
	if os.Getenv("GETPAY_ENV") == "production" {
		g.baseURL = "https://ecom-getpay.nchl.com.np/ecom-web-checkout/v1/secure-merchant/transactions"
	}
	// GETPAY_BASE_URL is the URL your bank gives you, or a local mock. The status APIs live under it.
	if u := os.Getenv("GETPAY_BASE_URL"); u != "" {
		g.baseURL = strings.TrimRight(u, "/")
	}
	if u := os.Getenv("GETPAY_BUNDLE_URL"); u != "" {
		g.bundleURL = u
	}
	if g.currency == "" {
		g.currency = "NPR"
	}
	domain := os.Getenv("GETPAY_WEBSITE_DOMAIN") // the origin the bank registered with NCHL
	if g.papInfo == "" || g.oprKey == "" || domain == "" || g.businessName == "" || g.imageURL == "" {
		panic("set GETPAY_PAP_INFO, GETPAY_OPR_KEY, GETPAY_WEBSITE_DOMAIN, GETPAY_BUSINESS_NAME and GETPAY_IMAGE_URL")
	}
	g.origin = origin(domain)
	return g
}

// origin keeps scheme://host[:port] of a URL.
func origin(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return ""
	}
	return u.Scheme + "://" + u.Host
}

// CardStart is what StartPayment hands back: not a redirect or a form, but the script and
// options the checkout page hands to GetPay's SDK. The shared Start type has no room for it.
type CardStart struct {
	ScriptURL string
	Options   map[string]any
}`,
      token: `// OprSecret is base64(SHA-256(oprKey + transaction id)). GetPay puts it in the return token,
// and only someone with YOUR oprKey can compute it for a given id.
func (g *GetPay) OprSecret(transactionID string) string {
	sum := sha256.Sum256([]byte(g.oprKey + transactionID))
	return base64.StdEncoding.EncodeToString(sum[:])
}

// DecodeToken reads the return token: base64 JSON {"id", "oprSecret"}. One integration reports
// "id:oprSecret" text instead, so both are accepted. A "+" can arrive as a space after URL decoding.
func DecodeToken(token string) (id, secret string, ok bool) {
	raw, err := base64.StdEncoding.DecodeString(strings.ReplaceAll(strings.TrimSpace(token), " ", "+"))
	if err != nil {
		return "", "", false
	}
	var j struct {
		ID        *string \`json:"id"\`
		OprSecret *string \`json:"oprSecret"\`
	}
	if json.Unmarshal(raw, &j) == nil {
		if j.ID == nil || j.OprSecret == nil || *j.ID == "" || *j.OprSecret == "" {
			return "", "", false
		}
		return *j.ID, *j.OprSecret, true
	}
	id, secret, found := strings.Cut(string(raw), ":")
	return id, secret, found && id != "" && secret != ""
}`,
      start: `var clientRequestID = regexp.MustCompile(\`^[A-Za-z0-9-]{1,50}$\`)

// StartPayment builds the options for GetPay's browser SDK. Nothing is sent to GetPay yet:
// the checkout page does that.
func (g *GetPay) StartPayment(ctx context.Context, in StartInput) (CardStart, error) {
	// clientRequestId: present and non-empty, at most 50 characters. Our attempt ids are 20 hex characters.
	if !clientRequestID.MatchString(in.AttemptID) {
		return CardStart{}, fmt.Errorf("GetPay clientRequestId must be 1 to 50 letters, digits or \\"-\\": %s", in.AttemptID)
	}
	// GetPay sends the buyer back only to the registered domain. Catch a wrong BASE_URL here, not at the bank.
	if origin(in.ReturnURL) != g.origin {
		return CardStart{}, fmt.Errorf("GetPay return URL %s must be on GETPAY_WEBSITE_DOMAIN (%s)", in.ReturnURL, g.origin)
	}
	rupees := float64(in.AmountPaisa) / 100
	no := map[string]bool{"name": false, "email": false, "state": false, "city": false, "address": false, "zipcode": false, "country": false}
	return CardStart{ScriptURL: g.bundleURL, Options: map[string]any{
		"clientRequestId":           in.AttemptID, // comes back as clientId in merchant-status
		"papInfo":                   g.papInfo,
		"oprKey":                    g.oprKey,
		"insKey":                    g.insKey,
		"websiteDomain":             g.origin,
		"baseUrl":                   g.baseURL,
		"price":                     rupees, // a NUMBER in rupees: 100, not "100.00" and not 10000
		"currency":                  g.currency,
		"businessName":              g.businessName,
		"imageUrl":                  g.imageURL,
		"themeColor":                "#5662FF",
		"allowBillingAddressFields": true,
		"userInfo":                  map[string]string{"name": "", "email": "", "state": "", "country": "", "zipcode": "", "city": "", "address": ""},
		"prefill":                   no,
		"disableFields":             map[string]any{},
		// Success and failure land on the same page. The status API says which one it was.
		"callbackUrl": map[string]string{"successUrl": in.ReturnURL, "failUrl": in.ReturnURL},
		// Inline HTML on GetPay's page, so escape our own text.
		"orderInformationUI": fmt.Sprintf(\`<div style="font-family:sans-serif"><h3>%s</h3><p>%s %.2f</p></div>\`,
			html.EscapeString(in.Description), html.EscapeString(g.currency), rupees),
	}}, nil
}`,
      pages: `// inline turns a value into JSON for an inline <script>. Go's encoder already writes "<", ">"
// and "&" as <, > and &, so a value can't close the script tag.
func inline(v any) string {
	b, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return string(b)
}

// CheckoutPage is page 1: it loads the SDK and starts it. When GetPay accepts the options,
// onSuccess opens page 2. onSuccess and onError are functions, so they are added in the browser.
func (g *GetPay) CheckoutPage(start CardStart, paymentPageURL string) string {
	return \`<!doctype html><meta charset="utf-8"><title>Checkout</title>
<script defer src="\` + html.EscapeString(start.ScriptURL) + \`"></script>
<p>Starting card checkout.</p>
<noscript>JavaScript is required to pay by card.</noscript>
<script>
window.addEventListener("load", () => {
  const options = \` + inline(start.Options) + \`;
  options.onSuccess = () => { location.href = \` + inline(paymentPageURL) + \`; };
  options.onError = (err) => { console.error(err); document.body.insertAdjacentHTML("beforeend", "<p>Card checkout could not start. Try again.</p>"); };
  new GetPay(options).initialize();
});
</script>\`
}

// PaymentPage is page 2: GetPay draws the card form and runs 3-D Secure inside #checkout.
func (g *GetPay) PaymentPage() string {
	return \`<!doctype html><meta charset="utf-8"><title>Pay by card</title>
<script defer src="\` + html.EscapeString(g.bundleURL) + \`"></script>
<div id="checkout"></div>\`
}

// ReturnPage serves pages 3 and 4, where GetPay sends the buyer back. It leaves GetPay's iframe,
// reads the token from the query or the #hash (cards without 3-D Secure put it in the hash, which
// never reaches a server) and hands it to our verify route as ?token=.
func (g *GetPay) ReturnPage(verifyURL string) string {
	return \`<!doctype html><meta charset="utf-8"><title>Confirming payment</title>
<p>Confirming your payment.</p>
<script>
if (window.top !== window.self) {
  window.top.location = window.self.location.href;
} else {
  const hash = location.hash.replace(/^#/, "");
  const token = new URLSearchParams(location.search).get("token")
    || new URLSearchParams(hash.includes("?") ? hash.slice(hash.indexOf("?") + 1) : hash).get("token");
  const next = new URL(\` + inline(verifyURL) + \`, location.href);
  if (token) next.searchParams.set("token", token);
  location.replace(next.toString());
}
</script>\`
}`,
      confirm: `// getpayStatuses maps GetPay's transaction status to ours. Anything else counts as pending,
// so the reconcile job asks again.
var getpayStatuses = map[string]string{
	"SUCCESS":   "paid",
	"APPROVED":  "paid",
	"FAILED":    "failed",
	"FAILURE":   "failed",
	"DECLINED":  "failed",
	"PENDING":   "pending",
	"CANCELLED": "canceled",
	"CANCELED":  "canceled",
}

func getpayStatus(v any) string {
	if s, ok := getpayStatuses[strings.ToUpper(fmt.Sprint(v))]; ok {
		return s
	}
	return "pending"
}

// statusAPI POSTs JSON to a status API (no auth headers). It returns data, or nil for "not found".
func (g *GetPay) statusAPI(ctx context.Context, path string, payload map[string]string) (map[string]any, error) {
	data, _ := json.Marshal(payload)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, g.baseURL+"/"+path, bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := g.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("GetPay %s failed: %w", path, err)
	}
	defer res.Body.Close()
	raw, err := io.ReadAll(res.Body)
	if err != nil {
		return nil, err
	}
	var body struct {
		Status  *int           \`json:"status"\`
		Message string         \`json:"message"\`
		Data    map[string]any \`json:"data"\`
	}
	parsed := json.Unmarshal(raw, &body) == nil
	// HTTP 400 with status -1 and "...not found..." is an answer: GetPay has no such transaction.
	if parsed && body.Status != nil && *body.Status == -1 && strings.Contains(strings.ToLower(body.Message), "not found") {
		return nil, nil
	}
	if !parsed || res.StatusCode != http.StatusOK || body.Status == nil || *body.Status != 0 || body.Data == nil {
		return nil, fmt.Errorf("GetPay %s failed: HTTP %d %s", path, res.StatusCode, raw)
	}
	return body.Data, nil
}

// ConfirmPayment is called from the verify route (Params["token"] from the return page) and
// from the reconcile job (empty Params).
func (g *GetPay) ConfirmPayment(ctx context.Context, in ConfirmInput) (Outcome, error) {
	token := in.Params["token"]

	if token == "" {
		// No token: the buyer never reached the return page. Look the attempt up by clientRequestId.
		// Any GetPay merchant can create a transaction with the same clientRequestId, so a SUCCESS
		// here doesn't prove the money is ours. Keep it pending: the buyer's return or a person decides.
		s, err := g.statusAPI(ctx, "transaction-statement", map[string]string{"clientRequestId": in.AttemptID})
		if err != nil {
			return Outcome{}, err
		}
		if s == nil {
			return Outcome{Status: "not_found"}, nil
		}
		ours := getpayStatus(s["status"])
		if ours == "paid" {
			ours = "pending"
		}
		return Outcome{Status: ours}, nil
	}

	// The token must carry an oprSecret that only our oprKey produces for its id.
	id, secret, ok := DecodeToken(token)
	if !ok {
		return Outcome{}, fmt.Errorf("%w: GetPay return token is not base64 {id, oprSecret}", ErrPayment)
	}
	if subtle.ConstantTimeCompare([]byte(g.OprSecret(id)), []byte(secret)) != 1 {
		return Outcome{}, fmt.Errorf("%w: GetPay oprSecret does not match", ErrPayment)
	}

	// merchant-status answers for ANY transaction id, whoever asks, so check whose payment it is.
	d, err := g.statusAPI(ctx, "merchant-status", map[string]string{"id": id, "papInfo": g.papInfo})
	if err != nil {
		return Outcome{}, err
	}
	if d == nil {
		return Outcome{Status: "not_found"}, nil
	}
	if clientID, _ := d["clientId"].(string); clientID != in.AttemptID {
		return Outcome{}, fmt.Errorf("%w: GetPay transaction is for another clientRequestId", ErrPayment)
	}
	ours := getpayStatus(d["status"])
	if ours == "paid" {
		// amount is rupees as a JSON number (100.0). Compare in paisa with the amount WE stored.
		amount, err := strconv.ParseFloat(fmt.Sprint(d["amount"]), 64)
		if err != nil || int64(math.Round(amount*100)) != in.AmountPaisa {
			return Outcome{}, fmt.Errorf("%w: GetPay amount mismatch (%v)", ErrPayment, d["amount"])
		}
	}
	// The GetPay transaction id is what the bank's portal and disputes use.
	return Outcome{Status: ours, ProviderRef: id}, nil
}`,
    },
  },
  java: {
    file: "src/main/java/payments/GetPayGateway.java",
    lang: "java",
    parts: {
      config: `package payments;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Duration;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

// GetPay, NCHL's hosted card checkout for banks. UAT unless GETPAY_ENV=production.
public final class GetPayGateway implements Gateway {
    private static final ObjectMapper JSON = new ObjectMapper();
    private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build();
    private final String papInfo, oprKey, insKey, origin, businessName, imageUrl, currency, baseUrl, bundleUrl;

    private GetPayGateway(Map<String, String> cfg) {
        this.papInfo = cfg.get("papInfo"); // base64 of {"institutionId","mid","tid"}
        this.oprKey = cfg.get("oprKey"); // reaches the browser by GetPay's design, and signs the return token
        this.insKey = cfg.get("insKey"); // blank when the operator hosts the checkout
        this.origin = origin(cfg.get("websiteDomain")); // the origin the bank registered with NCHL
        this.businessName = cfg.get("businessName");
        this.imageUrl = cfg.get("imageUrl"); // absolute URL of your logo, shown on the checkout
        this.currency = cfg.get("currency");
        this.baseUrl = cfg.get("baseUrl");
        this.bundleUrl = cfg.get("bundleUrl");
    }

    public static GetPayGateway fromEnv() {
        boolean production = "production".equals(System.getenv("GETPAY_ENV"));
        // All of these come from your bank. There are no public test values.
        List<String> required = List.of("GETPAY_PAP_INFO", "GETPAY_OPR_KEY", "GETPAY_WEBSITE_DOMAIN", "GETPAY_BUSINESS_NAME", "GETPAY_IMAGE_URL");
        if (required.stream().anyMatch(name -> envOr(name, "").isEmpty())) {
            throw new IllegalStateException("Set " + String.join(", ", required));
        }
        Map<String, String> cfg = new LinkedHashMap<>();
        cfg.put("papInfo", envOr("GETPAY_PAP_INFO", ""));
        cfg.put("oprKey", envOr("GETPAY_OPR_KEY", ""));
        cfg.put("insKey", envOr("GETPAY_INS_KEY", ""));
        cfg.put("websiteDomain", envOr("GETPAY_WEBSITE_DOMAIN", ""));
        cfg.put("businessName", envOr("GETPAY_BUSINESS_NAME", ""));
        cfg.put("imageUrl", envOr("GETPAY_IMAGE_URL", ""));
        cfg.put("currency", envOr("GETPAY_CURRENCY", "NPR"));
        // GETPAY_BASE_URL is the URL your bank gives you, or a local mock. The status APIs live under it.
        cfg.put("baseUrl", envOr("GETPAY_BASE_URL", production
            ? "https://ecom-getpay.nchl.com.np/ecom-web-checkout/v1/secure-merchant/transactions"
            : "https://uat-bank-getpay.nchl.com.np/ecom-web-checkout/v1/secure-merchant/transactions").replaceAll("/+$", ""));
        // The browser SDK. The bank sends the URL to use; this is the published UAT bundle.
        cfg.put("bundleUrl", envOr("GETPAY_BUNDLE_URL", "https://minio-getpay.nchl.com.np/getpay-cdn/webcheckout/v5/bundle.js"));
        return new GetPayGateway(cfg);
    }

    private static String envOr(String name, String fallback) {
        String value = System.getenv(name);
        return value != null && !value.isEmpty() ? value : fallback;
    }

    // scheme://host[:port] of a URL.
    private static String origin(String url) {
        URI u = URI.create(url);
        return u.getScheme() + "://" + u.getRawAuthority();
    }

    // Not a redirect or a form: the script and options the checkout page hands to GetPay's SDK.
    public record CardStart(String scriptUrl, Map<String, Object> options) {}`,
      token: `    // oprSecret = base64(SHA-256(oprKey + transaction id)). GetPay puts it in the return token,
    // and only someone with YOUR oprKey can compute it for a given id.
    public String oprSecret(String transactionId) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest((oprKey + transactionId).getBytes(StandardCharsets.UTF_8));
            return Base64.getEncoder().encodeToString(digest);
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    // The token is base64 JSON {"id", "oprSecret"}. One integration reports "id:oprSecret" text
    // instead, so both are accepted. A "+" can arrive as a space after URL decoding.
    // Returns {id, oprSecret}, or null.
    public static String[] decodeToken(String token) {
        String text;
        try {
            text = new String(Base64.getDecoder().decode(token.trim().replace(' ', '+')), StandardCharsets.UTF_8);
        } catch (IllegalArgumentException e) {
            return null;
        }
        try {
            JsonNode j = JSON.readTree(text);
            if (j != null && j.isObject()) {
                String id = j.path("id").isTextual() ? j.get("id").asText() : "";
                String secret = j.path("oprSecret").isTextual() ? j.get("oprSecret").asText() : "";
                return id.isEmpty() || secret.isEmpty() ? null : new String[] {id, secret};
            }
        } catch (JsonProcessingException e) {
            // not JSON: try the "id:oprSecret" form below
        }
        int i = text.indexOf(':');
        return i > 0 && i < text.length() - 1 ? new String[] {text.substring(0, i), text.substring(i + 1)} : null;
    }`,
      start: `    // The shared routes expect a redirect or a form, and GetPay has neither: the card routes call startCard.
    @Override
    public Start startPayment(String attemptId, long amountPaisa, String returnUrl, String description) {
        throw new UnsupportedOperationException("GetPay starts in the browser: call startCard");
    }

    // Builds the options for GetPay's browser SDK. Nothing is sent to GetPay yet: the checkout page does that.
    public CardStart startCard(String attemptId, long amountPaisa, String returnUrl, String description) {
        // clientRequestId: present and non-empty, at most 50 characters. Our attempt ids are 20 hex characters.
        if (!attemptId.matches("[A-Za-z0-9-]{1,50}")) {
            throw new IllegalArgumentException("GetPay clientRequestId must be 1 to 50 letters, digits or \\"-\\": " + attemptId);
        }
        // GetPay sends the buyer back only to the registered domain. Catch a wrong BASE_URL here, not at the bank.
        if (!origin(returnUrl).equals(origin)) {
            throw new IllegalArgumentException("GetPay return URL " + returnUrl + " must be on GETPAY_WEBSITE_DOMAIN (" + origin + ")");
        }
        BigDecimal rupees = BigDecimal.valueOf(amountPaisa, 2);
        Map<String, Object> no = new LinkedHashMap<>();
        for (String field : List.of("name", "email", "state", "city", "address", "zipcode", "country")) no.put(field, false);
        Map<String, Object> options = new LinkedHashMap<>();
        options.put("clientRequestId", attemptId); // comes back as clientId in merchant-status
        options.put("papInfo", papInfo);
        options.put("oprKey", oprKey);
        options.put("insKey", insKey);
        options.put("websiteDomain", origin);
        options.put("baseUrl", baseUrl);
        options.put("price", rupees); // a NUMBER in rupees: 100.00, not "100.00" and not 10000
        options.put("currency", currency);
        options.put("businessName", businessName);
        options.put("imageUrl", imageUrl);
        options.put("themeColor", "#5662FF");
        options.put("allowBillingAddressFields", true);
        options.put("userInfo", Map.of("name", "", "email", "", "state", "", "country", "", "zipcode", "", "city", "", "address", ""));
        options.put("prefill", no);
        options.put("disableFields", Map.of());
        // Success and failure land on the same page. The status API says which one it was.
        options.put("callbackUrl", Map.of("successUrl", returnUrl, "failUrl", returnUrl));
        // Inline HTML on GetPay's page, so escape our own text.
        options.put("orderInformationUI", "<div style=\\"font-family:sans-serif\\"><h3>" + escape(description) + "</h3><p>"
            + escape(currency) + " " + rupees.toPlainString() + "</p></div>");
        return new CardStart(bundleUrl, options);
    }`,
      pages: `    static String escape(String s) {
        return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\\"", "&quot;").replace("'", "&#39;");
    }

    // JSON for an inline <script>: "<" is escaped, so a value can't close the script tag.
    private static String inline(Object value) {
        try {
            return JSON.writeValueAsString(value).replace("<", "\\\\u003c");
        } catch (JsonProcessingException e) {
            throw new IllegalStateException(e);
        }
    }

    // Page 1, checkout: loads the SDK and starts it. When GetPay accepts the options, onSuccess opens page 2.
    // onSuccess and onError are functions, so they are added here in the browser, not sent from the server.
    public String checkoutPage(CardStart start, String paymentPageUrl) {
        return """
            <!doctype html><meta charset="utf-8"><title>Checkout</title>
            <script defer src="%s"></script>
            <p>Starting card checkout.</p>
            <noscript>JavaScript is required to pay by card.</noscript>
            <script>
            window.addEventListener("load", () => {
              const options = %s;
              options.onSuccess = () => { location.href = %s; };
              options.onError = (err) => { console.error(err); document.body.insertAdjacentHTML("beforeend", "<p>Card checkout could not start. Try again.</p>"); };
              new GetPay(options).initialize();
            });
            </script>
            """.formatted(escape(start.scriptUrl()), inline(start.options()), inline(paymentPageUrl));
    }

    // Page 2, payment: GetPay draws the card form and runs 3-D Secure inside #checkout.
    public String paymentPage() {
        return """
            <!doctype html><meta charset="utf-8"><title>Pay by card</title>
            <script defer src="%s"></script>
            <div id="checkout"></div>
            """.formatted(escape(bundleUrl));
    }

    // Pages 3 and 4, where GetPay sends the buyer back. First leave GetPay's iframe, then read the
    // token from the query or the #hash (cards without 3-D Secure put it in the hash, which never
    // reaches a server) and hand it to our verify route as ?token=.
    public String returnPage(String verifyUrl) {
        return """
            <!doctype html><meta charset="utf-8"><title>Confirming payment</title>
            <p>Confirming your payment.</p>
            <script>
            if (window.top !== window.self) {
              window.top.location = window.self.location.href;
            } else {
              const hash = location.hash.replace(/^#/, "");
              const token = new URLSearchParams(location.search).get("token")
                || new URLSearchParams(hash.includes("?") ? hash.slice(hash.indexOf("?") + 1) : hash).get("token");
              const next = new URL(%s, location.href);
              if (token) next.searchParams.set("token", token);
              location.replace(next.toString());
            }
            </script>
            """.formatted(inline(verifyUrl));
    }`,
      confirm: `    // GetPay's transaction status -> ours. Anything else counts as pending, so the reconcile job asks again.
    private static final Map<String, String> STATUSES = Map.of(
        "SUCCESS", "paid",
        "APPROVED", "paid",
        "FAILED", "failed",
        "FAILURE", "failed",
        "DECLINED", "failed",
        "PENDING", "pending",
        "CANCELLED", "canceled",
        "CANCELED", "canceled");

    private static String ours(JsonNode status) {
        return STATUSES.getOrDefault(status.asText("").toUpperCase(Locale.ROOT), "pending");
    }

    // POSTs JSON to a status API (no auth headers). Returns data, or null for "not found".
    private JsonNode statusApi(String path, Map<String, String> payload) {
        try {
            HttpRequest request = HttpRequest.newBuilder(URI.create(baseUrl + "/" + path))
                .timeout(Duration.ofSeconds(20))
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(JSON.writeValueAsString(payload)))
                .build();
            HttpResponse<String> res = http.send(request, HttpResponse.BodyHandlers.ofString());
            JsonNode body;
            try {
                body = JSON.readTree(res.body());
            } catch (JsonProcessingException e) {
                body = null;
            }
            // HTTP 400 with status -1 and "...not found..." is an answer: GetPay has no such transaction.
            if (body != null && body.path("status").asInt(0) == -1
                && body.path("message").asText("").toLowerCase(Locale.ROOT).contains("not found")) {
                return null;
            }
            if (res.statusCode() != 200 || body == null || !body.path("status").isInt() || body.get("status").asInt() != 0
                || !body.path("data").isObject()) {
                throw new IllegalStateException("GetPay " + path + " failed: HTTP " + res.statusCode() + " " + res.body());
            }
            return body.get("data");
        } catch (IOException e) {
            throw new IllegalStateException("GetPay " + path + " failed: " + e.getMessage(), e);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("GetPay " + path + " interrupted", e);
        }
    }

    // Called from the verify route (params has "token" from the return page) and from the reconcile job (empty params).
    @Override
    public Outcome confirmPayment(String attemptId, long amountPaisa, String providerRef, Map<String, String> params) {
        String token = params.getOrDefault("token", "");

        if (token.isEmpty()) {
            // No token: the buyer never reached the return page. Look the attempt up by clientRequestId.
            // Any GetPay merchant can create a transaction with the same clientRequestId, so a SUCCESS
            // here doesn't prove the money is ours. Keep it pending: the buyer's return or a person decides.
            JsonNode s = statusApi("transaction-statement", Map.of("clientRequestId", attemptId));
            if (s == null) return new Outcome("not_found", null);
            String status = ours(s.path("status"));
            return new Outcome(status.equals("paid") ? "pending" : status, null);
        }

        // The token must carry an oprSecret that only our oprKey produces for its id.
        String[] t = decodeToken(token);
        if (t == null) throw new PaymentException("GetPay: return token is not base64 {id, oprSecret}");
        if (!MessageDigest.isEqual(oprSecret(t[0]).getBytes(StandardCharsets.UTF_8), t[1].getBytes(StandardCharsets.UTF_8))) {
            throw new PaymentException("GetPay: oprSecret does not match");
        }

        // merchant-status answers for ANY transaction id, whoever asks, so check whose payment it is.
        JsonNode d = statusApi("merchant-status", Map.of("id", t[0], "papInfo", papInfo));
        if (d == null) return new Outcome("not_found", null);
        if (!d.path("clientId").asText("").equals(attemptId)) {
            throw new PaymentException("GetPay: transaction is for another clientRequestId");
        }
        String status = ours(d.path("status"));
        if (status.equals("paid")) {
            // amount is rupees as a JSON number (100.0). Compare in paisa with the amount WE stored.
            JsonNode amount = d.path("amount");
            long paidPaisa;
            try {
                paidPaisa = new BigDecimal(amount.asText()).movePointRight(2).setScale(0, RoundingMode.HALF_UP).longValueExact();
            } catch (NumberFormatException | ArithmeticException e) {
                throw new PaymentException("GetPay: unreadable amount (" + amount + ")");
            }
            if (paidPaisa != amountPaisa) throw new PaymentException("GetPay: amount mismatch (" + amount + ")");
        }
        // The GetPay transaction id is what the bank's portal and disputes use.
        return new Outcome(status, t[0]);
    }
}`,
    },
  },
  kotlin: {
    file: "src/main/kotlin/payments/GetPayGateway.kt",
    lang: "kotlin",
    parts: {
      config: `package payments

import java.math.BigDecimal
import java.math.RoundingMode
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.security.MessageDigest
import java.time.Duration
import java.util.Base64
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject

// What startPayment hands back for GetPay: not a redirect or a form, but the script and options
// the checkout page hands to GetPay's SDK. It sits in the same package as Start, so it can join
// that sealed family. GetPay assigns its own id later, in the return token.
data class CardStart(val scriptUrl: String, val options: JsonObject) : Start {
    override val providerRef: String? = null
}

// GetPay, NCHL's hosted card checkout for banks. UAT unless GETPAY_ENV=production.
class GetPayGateway(
    private val papInfo: String, // base64 of {"institutionId","mid","tid"}
    private val oprKey: String, // reaches the browser by GetPay's design, and signs the return token
    private val insKey: String, // blank when the operator hosts the checkout
    websiteDomain: String, // the origin the bank registered with NCHL
    private val businessName: String,
    private val imageUrl: String, // absolute URL of your logo, shown on the checkout
    private val currency: String,
    private val baseUrl: String,
    private val bundleUrl: String,
) : Gateway {
    private val origin = origin(websiteDomain)
    private val http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build()

    companion object {
        fun fromEnv(): GetPayGateway {
            fun env(name: String) = System.getenv(name).orEmpty()
            val production = env("GETPAY_ENV") == "production"
            // All of these come from your bank. There are no public test values.
            val required = listOf("GETPAY_PAP_INFO", "GETPAY_OPR_KEY", "GETPAY_WEBSITE_DOMAIN", "GETPAY_BUSINESS_NAME", "GETPAY_IMAGE_URL")
            check(required.all { env(it).isNotEmpty() }) { "Set " + required.joinToString(", ") }
            return GetPayGateway(
                papInfo = env("GETPAY_PAP_INFO"),
                oprKey = env("GETPAY_OPR_KEY"),
                insKey = env("GETPAY_INS_KEY"),
                websiteDomain = env("GETPAY_WEBSITE_DOMAIN"),
                businessName = env("GETPAY_BUSINESS_NAME"),
                imageUrl = env("GETPAY_IMAGE_URL"),
                currency = env("GETPAY_CURRENCY").ifEmpty { "NPR" },
                // GETPAY_BASE_URL is the URL your bank gives you, or a local mock. The status APIs live under it.
                baseUrl = env("GETPAY_BASE_URL").ifEmpty {
                    if (production) "https://ecom-getpay.nchl.com.np/ecom-web-checkout/v1/secure-merchant/transactions"
                    else "https://uat-bank-getpay.nchl.com.np/ecom-web-checkout/v1/secure-merchant/transactions"
                }.trimEnd('/'),
                // The browser SDK. The bank sends the URL to use; this is the published UAT bundle.
                bundleUrl = env("GETPAY_BUNDLE_URL").ifEmpty { "https://minio-getpay.nchl.com.np/getpay-cdn/webcheckout/v5/bundle.js" },
            )
        }

        // scheme://host[:port] of a URL.
        private fun origin(url: String): String = URI.create(url).let { "\${it.scheme}://\${it.rawAuthority}" }

        // A JSON value as text: "SUCCESS" and 100.0 both come back as their text, null and objects as null.
        private fun JsonElement?.text(): String? = (this as? JsonPrimitive)?.takeIf { it !is JsonNull }?.content
    }`,
      token: `    // oprSecret = base64(SHA-256(oprKey + transaction id)). GetPay puts it in the return token,
    // and only someone with YOUR oprKey can compute it for a given id.
    fun oprSecret(transactionId: String): String =
        Base64.getEncoder().encodeToString(MessageDigest.getInstance("SHA-256").digest((oprKey + transactionId).toByteArray()))

    // The token is base64 JSON {"id", "oprSecret"}. One integration reports "id:oprSecret" text
    // instead, so both are accepted. A "+" can arrive as a space after URL decoding.
    fun decodeToken(token: String): Pair<String, String>? {
        val text = runCatching { String(Base64.getDecoder().decode(token.trim().replace(' ', '+'))) }.getOrNull() ?: return null
        val json = runCatching { Json.parseToJsonElement(text) }.getOrNull()
        if (json is JsonObject) {
            val id = (json["id"] as? JsonPrimitive)?.takeIf { it.isString }?.content.orEmpty()
            val secret = (json["oprSecret"] as? JsonPrimitive)?.takeIf { it.isString }?.content.orEmpty()
            return if (id.isEmpty() || secret.isEmpty()) null else id to secret
        }
        val i = text.indexOf(':')
        return if (i > 0 && i < text.length - 1) text.substring(0, i) to text.substring(i + 1) else null
    }`,
      start: `    // Builds the options for GetPay's browser SDK. Nothing is sent to GetPay yet: the checkout page does that.
    override suspend fun startPayment(attemptId: String, amountPaisa: Long, returnUrl: String, description: String): CardStart {
        // clientRequestId: present and non-empty, at most 50 characters. Our attempt ids are 20 hex characters.
        require(Regex("[A-Za-z0-9-]{1,50}").matches(attemptId)) { "GetPay clientRequestId must be 1 to 50 letters, digits or \\"-\\"" }
        // GetPay sends the buyer back only to the registered domain. Catch a wrong BASE_URL here, not at the bank.
        require(origin(returnUrl) == origin) { "GetPay return URL $returnUrl must be on GETPAY_WEBSITE_DOMAIN ($origin)" }
        val rupees = BigDecimal.valueOf(amountPaisa, 2)
        val options = buildJsonObject {
            put("clientRequestId", attemptId) // comes back as clientId in merchant-status
            put("papInfo", papInfo)
            put("oprKey", oprKey)
            put("insKey", insKey)
            put("websiteDomain", origin)
            put("baseUrl", baseUrl)
            put("price", rupees.toDouble()) // a NUMBER in rupees: 100.0, not "100.00" and not 10000
            put("currency", currency)
            put("businessName", businessName)
            put("imageUrl", imageUrl)
            put("themeColor", "#5662FF")
            put("allowBillingAddressFields", true)
            putJsonObject("userInfo") { for (f in listOf("name", "email", "state", "country", "zipcode", "city", "address")) put(f, "") }
            putJsonObject("prefill") { for (f in listOf("name", "email", "state", "city", "address", "zipcode", "country")) put(f, false) }
            putJsonObject("disableFields") {}
            // Success and failure land on the same page. The status API says which one it was.
            putJsonObject("callbackUrl") {
                put("successUrl", returnUrl)
                put("failUrl", returnUrl)
            }
            // Inline HTML on GetPay's page, so escape our own text.
            put("orderInformationUI", """<div style="font-family:sans-serif"><h3>\${esc(description)}</h3><p>\${esc(currency)} \${rupees.toPlainString()}</p></div>""")
        }
        return CardStart(bundleUrl, options)
    }`,
      pages: `    private fun esc(s: String) = s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
        .replace("\\"", "&quot;").replace("'", "&#39;")

    // JSON for an inline <script>: "<" is escaped, so a value can't close the script tag.
    private fun inline(value: JsonElement) = value.toString().replace("<", "\\\\u003c")

    // Page 1, checkout: loads the SDK and starts it. When GetPay accepts the options, onSuccess opens page 2.
    // onSuccess and onError are functions, so they are added here in the browser, not sent from the server.
    // The JavaScript has no "$", so the only templates in these raw strings are Kotlin's own.
    fun checkoutPage(start: CardStart, paymentPageUrl: String): String = """<!doctype html><meta charset="utf-8"><title>Checkout</title>
<script defer src="\${esc(start.scriptUrl)}"></script>
<p>Starting card checkout.</p>
<noscript>JavaScript is required to pay by card.</noscript>
<script>
window.addEventListener("load", () => {
  const options = \${inline(start.options)};
  options.onSuccess = () => { location.href = \${inline(JsonPrimitive(paymentPageUrl))}; };
  options.onError = (err) => { console.error(err); document.body.insertAdjacentHTML("beforeend", "<p>Card checkout could not start. Try again.</p>"); };
  new GetPay(options).initialize();
});
</script>"""

    // Page 2, payment: GetPay draws the card form and runs 3-D Secure inside #checkout.
    fun paymentPage(): String = """<!doctype html><meta charset="utf-8"><title>Pay by card</title>
<script defer src="\${esc(bundleUrl)}"></script>
<div id="checkout"></div>"""

    // Pages 3 and 4, where GetPay sends the buyer back. First leave GetPay's iframe, then read the
    // token from the query or the #hash (cards without 3-D Secure put it in the hash, which never
    // reaches a server) and hand it to our verify route as ?token=.
    fun returnPage(verifyUrl: String): String = """<!doctype html><meta charset="utf-8"><title>Confirming payment</title>
<p>Confirming your payment.</p>
<script>
if (window.top !== window.self) {
  window.top.location = window.self.location.href;
} else {
  const hash = location.hash.replace(/^#/, "");
  const token = new URLSearchParams(location.search).get("token")
    || new URLSearchParams(hash.includes("?") ? hash.slice(hash.indexOf("?") + 1) : hash).get("token");
  const next = new URL(\${inline(JsonPrimitive(verifyUrl))}, location.href);
  if (token) next.searchParams.set("token", token);
  location.replace(next.toString());
}
</script>"""`,
      confirm: `    // GetPay's transaction status -> ours. Anything else counts as pending, so the reconcile job asks again.
    private val statuses = mapOf(
        "SUCCESS" to "paid",
        "APPROVED" to "paid",
        "FAILED" to "failed",
        "FAILURE" to "failed",
        "DECLINED" to "failed",
        "PENDING" to "pending",
        "CANCELLED" to "canceled",
        "CANCELED" to "canceled",
    )

    private fun ours(status: JsonElement?) = statuses[status.text()?.uppercase()] ?: "pending"

    // POSTs JSON to a status API (no auth headers). Returns data, or null for "not found".
    private suspend fun statusApi(path: String, payload: JsonObject): JsonObject? {
        val request = HttpRequest.newBuilder(URI.create("$baseUrl/$path"))
            .timeout(Duration.ofSeconds(20))
            .header("Content-Type", "application/json")
            .POST(HttpRequest.BodyPublishers.ofString(payload.toString()))
            .build()
        val res = withContext(Dispatchers.IO) { http.send(request, HttpResponse.BodyHandlers.ofString()) }
        val body = runCatching { Json.parseToJsonElement(res.body()) as JsonObject }.getOrNull()
        val status = (body?.get("status") as? JsonPrimitive)?.intOrNull
        // HTTP 400 with status -1 and "...not found..." is an answer: GetPay has no such transaction.
        if (status == -1 && body?.get("message").text().orEmpty().contains("not found", ignoreCase = true)) return null
        val data = body?.get("data") as? JsonObject
        if (res.statusCode() != 200 || status != 0 || data == null) {
            throw IllegalStateException("GetPay $path failed: HTTP \${res.statusCode()} \${res.body()}")
        }
        return data
    }

    // Called from the verify route (params["token"] from the return page) and from the reconcile job (empty params).
    override suspend fun confirmPayment(attemptId: String, amountPaisa: Long, providerRef: String?, params: Map<String, String>): Outcome {
        val token = params["token"].orEmpty()

        if (token.isEmpty()) {
            // No token: the buyer never reached the return page. Look the attempt up by clientRequestId.
            // Any GetPay merchant can create a transaction with the same clientRequestId, so a SUCCESS
            // here doesn't prove the money is ours. Keep it pending: the buyer's return or a person decides.
            val s = statusApi("transaction-statement", buildJsonObject { put("clientRequestId", attemptId) })
                ?: return Outcome("not_found")
            val status = ours(s["status"])
            return Outcome(if (status == "paid") "pending" else status)
        }

        // The token must carry an oprSecret that only our oprKey produces for its id.
        val (id, secret) = decodeToken(token) ?: throw PaymentException("GetPay: return token is not base64 {id, oprSecret}")
        if (!MessageDigest.isEqual(oprSecret(id).toByteArray(), secret.toByteArray())) {
            throw PaymentException("GetPay: oprSecret does not match")
        }

        // merchant-status answers for ANY transaction id, whoever asks, so check whose payment it is.
        val d = statusApi("merchant-status", buildJsonObject {
            put("id", id)
            put("papInfo", papInfo)
        }) ?: return Outcome("not_found")
        if (d["clientId"].text() != attemptId) throw PaymentException("GetPay: transaction is for another clientRequestId")
        val status = ours(d["status"])
        if (status == "paid") {
            // amount is rupees as a JSON number (100.0). Compare in paisa with the amount WE stored.
            val paidPaisa = d["amount"].text()?.toBigDecimalOrNull()?.movePointRight(2)?.setScale(0, RoundingMode.HALF_UP)?.toLong()
            if (paidPaisa != amountPaisa) throw PaymentException("GetPay: amount mismatch (\${d["amount"]})")
        }
        // The GetPay transaction id is what the bank's portal and disputes use.
        return Outcome(status, id)
    }
}`,
    },
  },
};

export const cardRoutes: Record<string, Block[]> = {
  express: [
    { file: "server.ts", lang: "ts", code: `import express from "express";
import * as gateway from "./getpay";
import { PaymentError, settle } from "./payments";
import { startReconcileLoop } from "./reconcile";
import { createAttempt, getAttempt, getOrder, latestAttempt } from "./store";

const PORT = Number(process.env.PORT ?? 3000);
// Must be the origin your bank registered with NCHL (GETPAY_WEBSITE_DOMAIN).
const BASE_URL = process.env.BASE_URL ?? \`http://localhost:\${PORT}\`;
const app = express();

app.get("/", (_req, res) => {
  res.send(\`<!doctype html><title>Shop</title>
<h1>Order demo, Rs 100</h1>
<form method="post" action="/pay/demo"><button>Pay by card</button></form>\`);
});

// Page 1: creates the attempt and starts GetPay's SDK in the browser.
app.post("/pay/:orderId", async (req, res) => {
  const order = getOrder(req.params.orderId);
  if (!order) return void res.status(404).send("Order not found");
  const attempt = createAttempt(order.id, order.amountPaisa);
  const start = await gateway.startPayment({
    attemptId: attempt.id,
    amountPaisa: attempt.amountPaisa,
    returnUrl: \`\${BASE_URL}/pay/return/\${attempt.id}\`,
    description: \`Order \${order.id}\`,
  });
  res.send(gateway.checkoutPage(start, \`/pay/card/\${attempt.id}\`));
});

// Page 2: GetPay's card form.
app.get("/pay/card/:attemptId", (req, res) => {
  if (!getAttempt(req.params.attemptId)) return void res.status(404).send("Payment not found");
  res.send(gateway.paymentPage());
});

// Pages 3 and 4: GetPay sends the buyer here after a success or a failure.
app.get("/pay/return/:attemptId", (req, res) => {
  const attempt = getAttempt(req.params.attemptId);
  if (!attempt) return void res.status(404).send("Payment not found");
  res.send(gateway.returnPage(\`/pay/verify/\${attempt.id}\`));
});

// The return page forwards the token here. The status API decides, never the token alone.
app.get("/pay/verify/:attemptId", async (req, res) => {
  const attempt = getAttempt(req.params.attemptId);
  if (!attempt) return void res.status(404).send("Payment not found");
  const token = typeof req.query.token === "string" ? req.query.token : "";
  try {
    const outcome = await gateway.confirmPayment({
      attemptId: attempt.id,
      amountPaisa: attempt.amountPaisa,
      providerRef: attempt.providerRef,
      params: token ? { token } : {},
    });
    settle(attempt, outcome);
  } catch (err) {
    if (err instanceof PaymentError) return void res.status(400).send("Payment could not be verified");
    console.error(err);
    return void res.status(502).send("Payment gateway error, try again shortly");
  }
  res.redirect(303, \`/orders/\${attempt.orderId}\`);
});

app.get("/orders/:orderId", (req, res) => {
  const attempt = latestAttempt(req.params.orderId);
  res.type("text").send(\`Order \${req.params.orderId}: \${attempt ? attempt.status : "no payment yet"}\`);
});

startReconcileLoop(gateway);
app.listen(PORT, () => console.log(\`listening on \${BASE_URL}\`));` },
  ],
  hono: [
    { file: "server.ts", lang: "ts", code: `import { serve } from "@hono/node-server";
import { Hono } from "hono";
import * as gateway from "./getpay";
import { PaymentError, settle } from "./payments";
import { startReconcileLoop } from "./reconcile";
import { createAttempt, getAttempt, getOrder, latestAttempt } from "./store";

const PORT = Number(process.env.PORT ?? 3000);
// Must be the origin your bank registered with NCHL (GETPAY_WEBSITE_DOMAIN).
const BASE_URL = process.env.BASE_URL ?? \`http://localhost:\${PORT}\`;
const app = new Hono();

app.get("/", (c) =>
  c.html(\`<!doctype html><title>Shop</title>
<h1>Order demo, Rs 100</h1>
<form method="post" action="/pay/demo"><button>Pay by card</button></form>\`),
);

// Page 1: creates the attempt and starts GetPay's SDK in the browser.
app.post("/pay/:orderId", async (c) => {
  const order = getOrder(c.req.param("orderId"));
  if (!order) return c.text("Order not found", 404);
  const attempt = createAttempt(order.id, order.amountPaisa);
  const start = await gateway.startPayment({
    attemptId: attempt.id,
    amountPaisa: attempt.amountPaisa,
    returnUrl: \`\${BASE_URL}/pay/return/\${attempt.id}\`,
    description: \`Order \${order.id}\`,
  });
  return c.html(gateway.checkoutPage(start, \`/pay/card/\${attempt.id}\`));
});

// Page 2: GetPay's card form.
app.get("/pay/card/:attemptId", (c) => {
  if (!getAttempt(c.req.param("attemptId"))) return c.text("Payment not found", 404);
  return c.html(gateway.paymentPage());
});

// Pages 3 and 4: GetPay sends the buyer here after a success or a failure.
app.get("/pay/return/:attemptId", (c) => {
  const attempt = getAttempt(c.req.param("attemptId"));
  if (!attempt) return c.text("Payment not found", 404);
  return c.html(gateway.returnPage(\`/pay/verify/\${attempt.id}\`));
});

// The return page forwards the token here. The status API decides, never the token alone.
app.get("/pay/verify/:attemptId", async (c) => {
  const attempt = getAttempt(c.req.param("attemptId"));
  if (!attempt) return c.text("Payment not found", 404);
  const token = c.req.query("token") ?? "";
  try {
    const outcome = await gateway.confirmPayment({
      attemptId: attempt.id,
      amountPaisa: attempt.amountPaisa,
      providerRef: attempt.providerRef,
      params: token ? { token } : {},
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
serve({ fetch: app.fetch, port: PORT }, () => console.log(\`listening on \${BASE_URL}\`));` },
  ],
  nextjs: [
    { file: "app/page.tsx", lang: "tsx", code: `// GET /  Replaces the starter page from create-next-app.
export default function Home() {
  return (
    <main>
      <h1>Order demo, Rs 100</h1>
      <form method="post" action="/pay/demo">
        <button>Pay by card</button>
      </form>
    </main>
  );
}` },
    { file: "app/pay/[orderId]/route.ts", lang: "ts", code: `// POST /pay/:orderId  Page 1: creates the attempt and starts GetPay's SDK in the browser.
import * as gateway from "@/getpay";
import { createAttempt, getOrder } from "@/store";

// Must be the origin your bank registered with NCHL (GETPAY_WEBSITE_DOMAIN).
const BASE_URL = process.env.BASE_URL ?? "http://localhost:3000";
const html = (body: string) => new Response(body, { headers: { "Content-Type": "text/html; charset=utf-8" } });

export async function POST(_req: Request, { params }: { params: Promise<{ orderId: string }> }) {
  const order = getOrder((await params).orderId);
  if (!order) return new Response("Order not found", { status: 404 });
  const attempt = createAttempt(order.id, order.amountPaisa);
  const start = await gateway.startPayment({
    attemptId: attempt.id,
    amountPaisa: attempt.amountPaisa,
    returnUrl: \`\${BASE_URL}/pay/return/\${attempt.id}\`,
    description: \`Order \${order.id}\`,
  });
  return html(gateway.checkoutPage(start, \`/pay/card/\${attempt.id}\`));
}` },
    { file: "app/pay/card/[attemptId]/route.ts", lang: "ts", code: `// GET /pay/card/:attemptId  Page 2: GetPay's card form.
import * as gateway from "@/getpay";
import { getAttempt } from "@/store";

export async function GET(_req: Request, { params }: { params: Promise<{ attemptId: string }> }) {
  if (!getAttempt((await params).attemptId)) return new Response("Payment not found", { status: 404 });
  return new Response(gateway.paymentPage(), { headers: { "Content-Type": "text/html; charset=utf-8" } });
}` },
    { file: "app/pay/return/[attemptId]/route.ts", lang: "ts", code: `// GET /pay/return/:attemptId  Pages 3 and 4: GetPay sends the buyer here after a success or a failure.
import * as gateway from "@/getpay";
import { getAttempt } from "@/store";

export async function GET(_req: Request, { params }: { params: Promise<{ attemptId: string }> }) {
  const attempt = getAttempt((await params).attemptId);
  if (!attempt) return new Response("Payment not found", { status: 404 });
  return new Response(gateway.returnPage(\`/pay/verify/\${attempt.id}\`), {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}` },
    { file: "app/pay/verify/[attemptId]/route.ts", lang: "ts", code: `// GET /pay/verify/:attemptId?token=  The return page forwards the token here.
// The status API decides, never the token alone.
import * as gateway from "@/getpay";
import { PaymentError, settle } from "@/payments";
import { getAttempt } from "@/store";

export async function GET(req: Request, { params }: { params: Promise<{ attemptId: string }> }) {
  const attempt = getAttempt((await params).attemptId);
  if (!attempt) return new Response("Payment not found", { status: 404 });
  const token = new URL(req.url).searchParams.get("token") ?? "";
  try {
    const outcome = await gateway.confirmPayment({
      attemptId: attempt.id,
      amountPaisa: attempt.amountPaisa,
      providerRef: attempt.providerRef,
      params: token ? { token } : {},
    });
    settle(attempt, outcome);
  } catch (err) {
    if (err instanceof PaymentError) return new Response("Payment could not be verified", { status: 400 });
    console.error(err);
    return new Response("Payment gateway error, try again shortly", { status: 502 });
  }
  // Relative Location: no need to know our own host here.
  return new Response(null, { status: 303, headers: { Location: \`/orders/\${attempt.orderId}\` } });
}` },
    { file: "app/orders/[orderId]/route.ts", lang: "ts", code: `// GET /orders/:orderId
import { latestAttempt } from "@/store";

export async function GET(_req: Request, { params }: { params: Promise<{ orderId: string }> }) {
  const { orderId } = await params;
  const attempt = latestAttempt(orderId);
  return new Response(\`Order \${orderId}: \${attempt ? attempt.status : "no payment yet"}\`);
}` },
    { file: "instrumentation.ts", lang: "ts", code: `// Next.js runs register() once when the server starts. Start the reconcile loop
// here, in the Node.js runtime only (the in-memory store lives in this process).
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const gateway = await import("./getpay");
    const { startReconcileLoop } = await import("./reconcile");
    startReconcileLoop(gateway);
  }
}` },
  ],
  fastify: [
    { file: "server.ts", lang: "ts", code: `import Fastify from "fastify";
import * as gateway from "./getpay";
import { PaymentError, settle } from "./payments";
import { startReconcileLoop } from "./reconcile";
import { createAttempt, getAttempt, getOrder, latestAttempt } from "./store";

const PORT = Number(process.env.PORT ?? 3000);
// Must be the origin your bank registered with NCHL (GETPAY_WEBSITE_DOMAIN).
const BASE_URL = process.env.BASE_URL ?? \`http://localhost:\${PORT}\`;
const app = Fastify();

// Fastify parses JSON only. Our Pay button posts a form, so parse those too.
app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_req, body, done) => {
  done(null, Object.fromEntries(new URLSearchParams(body as string)));
});

app.get("/", async (_req, reply) =>
  reply.type("text/html").send(\`<!doctype html><title>Shop</title>
<h1>Order demo, Rs 100</h1>
<form method="post" action="/pay/demo"><button>Pay by card</button></form>\`),
);

// Page 1: creates the attempt and starts GetPay's SDK in the browser.
app.post<{ Params: { orderId: string } }>("/pay/:orderId", async (req, reply) => {
  const order = getOrder(req.params.orderId);
  if (!order) return reply.code(404).send("Order not found");
  const attempt = createAttempt(order.id, order.amountPaisa);
  const start = await gateway.startPayment({
    attemptId: attempt.id,
    amountPaisa: attempt.amountPaisa,
    returnUrl: \`\${BASE_URL}/pay/return/\${attempt.id}\`,
    description: \`Order \${order.id}\`,
  });
  return reply.type("text/html").send(gateway.checkoutPage(start, \`/pay/card/\${attempt.id}\`));
});

// Page 2: GetPay's card form.
app.get<{ Params: { attemptId: string } }>("/pay/card/:attemptId", async (req, reply) => {
  if (!getAttempt(req.params.attemptId)) return reply.code(404).send("Payment not found");
  return reply.type("text/html").send(gateway.paymentPage());
});

// Pages 3 and 4: GetPay sends the buyer here after a success or a failure.
app.get<{ Params: { attemptId: string } }>("/pay/return/:attemptId", async (req, reply) => {
  const attempt = getAttempt(req.params.attemptId);
  if (!attempt) return reply.code(404).send("Payment not found");
  return reply.type("text/html").send(gateway.returnPage(\`/pay/verify/\${attempt.id}\`));
});

// The return page forwards the token here. The status API decides, never the token alone.
app.get<{ Params: { attemptId: string }; Querystring: { token?: string } }>("/pay/verify/:attemptId", async (req, reply) => {
  const attempt = getAttempt(req.params.attemptId);
  if (!attempt) return reply.code(404).send("Payment not found");
  const token = req.query.token ?? "";
  try {
    const outcome = await gateway.confirmPayment({
      attemptId: attempt.id,
      amountPaisa: attempt.amountPaisa,
      providerRef: attempt.providerRef,
      params: token ? { token } : {},
    });
    settle(attempt, outcome);
  } catch (err) {
    if (err instanceof PaymentError) return reply.code(400).send("Payment could not be verified");
    req.log.error(err);
    return reply.code(502).send("Payment gateway error, try again shortly");
  }
  return reply.redirect(\`/orders/\${attempt.orderId}\`, 303);
});

app.get<{ Params: { orderId: string } }>("/orders/:orderId", async (req, reply) => {
  const attempt = latestAttempt(req.params.orderId);
  return reply.type("text/plain").send(\`Order \${req.params.orderId}: \${attempt ? attempt.status : "no payment yet"}\`);
});

startReconcileLoop(gateway);
app.listen({ port: PORT }).then(() => console.log(\`listening on \${BASE_URL}\`));` },
  ],
  django: [
    { file: "shop/urls.py", lang: "python", code: `from django.urls import path

import getpay as gateway
from reconcile import start_reconcile_loop

from . import views

urlpatterns = [
    path("", views.home),
    path("pay/<str:order_id>", views.pay),
    path("pay/card/<str:attempt_id>", views.card),
    path("pay/return/<str:attempt_id>", views.payment_return),
    path("pay/verify/<str:attempt_id>", views.verify),
    path("orders/<str:order_id>", views.order_status),
]

# Django loads this module once per server process, a fine place to start it.
start_reconcile_loop(gateway)` },
    { file: "shop/views.py", lang: "python", code: `import logging
import os

from django.http import HttpResponse, HttpResponseRedirect
from django.middleware.csrf import get_token
from django.views.decorators.http import require_GET, require_POST

import getpay as gateway
import store
from payments import PaymentError, settle

# Must be the origin your bank registered with NCHL (GETPAY_WEBSITE_DOMAIN).
BASE_URL = os.environ.get("BASE_URL", "http://localhost:8000")


@require_GET
def home(request):
    # Our own form posts to /pay/demo, so it carries Django's CSRF token.
    return HttpResponse(f"""<!doctype html><title>Shop</title>
<h1>Order demo, Rs 100</h1>
<form method="post" action="/pay/demo">
<input type="hidden" name="csrfmiddlewaretoken" value="{get_token(request)}">
<button>Pay by card</button>
</form>""")


# Page 1: creates the attempt and starts GetPay's SDK in the browser.
@require_POST
def pay(request, order_id: str):
    order = store.get_order(order_id)
    if order is None:
        return HttpResponse("Order not found", status=404)
    attempt = store.create_attempt(order.id, order.amount_paisa)
    start = gateway.start_payment(attempt.id, attempt.amount_paisa, f"{BASE_URL}/pay/return/{attempt.id}",
                                  f"Order {order.id}")
    return HttpResponse(gateway.checkout_page(start, f"/pay/card/{attempt.id}"))


# Page 2: GetPay's card form.
@require_GET
def card(request, attempt_id: str):
    if store.get_attempt(attempt_id) is None:
        return HttpResponse("Payment not found", status=404)
    return HttpResponse(gateway.payment_page())


# Pages 3 and 4: GetPay sends the buyer here after a success or a failure.
@require_GET
def payment_return(request, attempt_id: str):
    if store.get_attempt(attempt_id) is None:
        return HttpResponse("Payment not found", status=404)
    return HttpResponse(gateway.return_page(f"/pay/verify/{attempt_id}"))


# The return page forwards the token here with a GET, so CSRF doesn't apply.
# The status API decides, never the token alone.
@require_GET
def verify(request, attempt_id: str):
    attempt = store.get_attempt(attempt_id)
    if attempt is None:
        return HttpResponse("Payment not found", status=404)
    token = request.GET.get("token", "")
    try:
        outcome = gateway.confirm_payment(attempt.id, attempt.amount_paisa, attempt.provider_ref,
                                          {"token": token} if token else {})
    except PaymentError:
        return HttpResponse("Payment could not be verified", status=400)
    except Exception:
        logging.exception("confirm_payment failed")
        return HttpResponse("Payment gateway error, try again shortly", status=502)
    settle(attempt, outcome)
    return HttpResponseRedirect(f"/orders/{attempt.order_id}", status=303)


@require_GET
def order_status(request, order_id: str):
    attempt = store.latest_attempt(order_id)
    status = attempt.status if attempt else "no payment yet"
    return HttpResponse(f"Order {order_id}: {status}", content_type="text/plain")` },
  ],
  fastapi: [
    { file: "main.py", lang: "python", code: `import logging
import os

from fastapi import FastAPI
from fastapi.responses import HTMLResponse, PlainTextResponse, RedirectResponse

import getpay as gateway
import store
from payments import PaymentError, settle
from reconcile import start_reconcile_loop

app = FastAPI()
# Must be the origin your bank registered with NCHL (GETPAY_WEBSITE_DOMAIN).
BASE_URL = os.environ.get("BASE_URL", "http://localhost:8000")


@app.get("/", response_class=HTMLResponse)
def home():
    return """<!doctype html><title>Shop</title>
<h1>Order demo, Rs 100</h1>
<form method="post" action="/pay/demo"><button>Pay by card</button></form>"""


# Page 1: creates the attempt and starts GetPay's SDK in the browser.
@app.post("/pay/{order_id}")
def pay(order_id: str):
    order = store.get_order(order_id)
    if order is None:
        return PlainTextResponse("Order not found", 404)
    attempt = store.create_attempt(order.id, order.amount_paisa)
    start = gateway.start_payment(attempt.id, attempt.amount_paisa, f"{BASE_URL}/pay/return/{attempt.id}",
                                  f"Order {order.id}")
    return HTMLResponse(gateway.checkout_page(start, f"/pay/card/{attempt.id}"))


# Page 2: GetPay's card form.
@app.get("/pay/card/{attempt_id}")
def card(attempt_id: str):
    if store.get_attempt(attempt_id) is None:
        return PlainTextResponse("Payment not found", 404)
    return HTMLResponse(gateway.payment_page())


# Pages 3 and 4: GetPay sends the buyer here after a success or a failure.
@app.get("/pay/return/{attempt_id}")
def payment_return(attempt_id: str):
    if store.get_attempt(attempt_id) is None:
        return PlainTextResponse("Payment not found", 404)
    return HTMLResponse(gateway.return_page(f"/pay/verify/{attempt_id}"))


# The return page forwards the token here. The status API decides, never the token alone.
# Plain \`def\`: FastAPI runs it in a thread pool, so the blocking GetPay call doesn't stall other requests.
@app.get("/pay/verify/{attempt_id}")
def verify(attempt_id: str, token: str = ""):
    attempt = store.get_attempt(attempt_id)
    if attempt is None:
        return PlainTextResponse("Payment not found", 404)
    try:
        outcome = gateway.confirm_payment(attempt.id, attempt.amount_paisa, attempt.provider_ref,
                                          {"token": token} if token else {})
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


start_reconcile_loop(gateway)` },
  ],
  flask: [
    { file: "app.py", lang: "python", code: `import os

from flask import Flask, redirect, request

import getpay as gateway
import store
from payments import PaymentError, settle
from reconcile import start_reconcile_loop

app = Flask(__name__)
# Must be the origin your bank registered with NCHL (GETPAY_WEBSITE_DOMAIN).
BASE_URL = os.environ.get("BASE_URL", "http://localhost:8000")


@app.get("/")
def home():
    return """<!doctype html><title>Shop</title>
<h1>Order demo, Rs 100</h1>
<form method="post" action="/pay/demo"><button>Pay by card</button></form>"""


# Page 1: creates the attempt and starts GetPay's SDK in the browser.
@app.post("/pay/<order_id>")
def pay(order_id: str):
    order = store.get_order(order_id)
    if order is None:
        return "Order not found", 404
    attempt = store.create_attempt(order.id, order.amount_paisa)
    start = gateway.start_payment(attempt.id, attempt.amount_paisa, f"{BASE_URL}/pay/return/{attempt.id}",
                                  f"Order {order.id}")
    return gateway.checkout_page(start, f"/pay/card/{attempt.id}")


# Page 2: GetPay's card form.
@app.get("/pay/card/<attempt_id>")
def card(attempt_id: str):
    if store.get_attempt(attempt_id) is None:
        return "Payment not found", 404
    return gateway.payment_page()


# Pages 3 and 4: GetPay sends the buyer here after a success or a failure.
@app.get("/pay/return/<attempt_id>")
def payment_return(attempt_id: str):
    if store.get_attempt(attempt_id) is None:
        return "Payment not found", 404
    return gateway.return_page(f"/pay/verify/{attempt_id}")


# The return page forwards the token here. The status API decides, never the token alone.
@app.get("/pay/verify/<attempt_id>")
def verify(attempt_id: str):
    attempt = store.get_attempt(attempt_id)
    if attempt is None:
        return "Payment not found", 404
    token = request.args.get("token", "")
    try:
        outcome = gateway.confirm_payment(attempt.id, attempt.amount_paisa, attempt.provider_ref,
                                          {"token": token} if token else {})
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


start_reconcile_loop(gateway)` },
  ],
  laravel: [
    { file: "routes/web.php", lang: "php", code: `<?php

use App\\Payments\\GetPayGateway;
use App\\Payments\\PaymentError;
use App\\Payments\\Store;
use Illuminate\\Http\\Request;
use Illuminate\\Support\\Facades\\Log;
use Illuminate\\Support\\Facades\\Route;

use function App\\Payments\\settle;

Route::get('/', fn () => '<h1>Order demo, Rs 100</h1>'
    . '<form method="post" action="/pay/demo">' . csrf_field() . '<button>Pay by card</button></form>');

// Page 1: creates the attempt and starts GetPay's SDK in the browser.
Route::post('/pay/{orderId}', function (string $orderId, Store $store, GetPayGateway $gateway) {
    $order = $store->getOrder($orderId) ?? abort(404);
    $attempt = $store->createAttempt($orderId, $order['amountPaisa']);
    // BASE_URL must be the origin your bank registered with NCHL (GETPAY_WEBSITE_DOMAIN).
    $returnUrl = rtrim(env('BASE_URL', 'http://localhost:8000'), '/') . '/pay/return/' . $attempt['id'];
    $start = $gateway->startCard($attempt['id'], $attempt['amountPaisa'], $returnUrl, "Order $orderId");
    return response($gateway->checkoutPage($start, "/pay/card/{$attempt['id']}"));
});

// Page 2: GetPay's card form.
Route::get('/pay/card/{attemptId}', function (string $attemptId, Store $store, GetPayGateway $gateway) {
    $store->getAttempt($attemptId) ?? abort(404);
    return response($gateway->paymentPage());
});

// Pages 3 and 4: GetPay sends the buyer here after a success or a failure.
Route::get('/pay/return/{attemptId}', function (string $attemptId, Store $store, GetPayGateway $gateway) {
    $attempt = $store->getAttempt($attemptId) ?? abort(404);
    return response($gateway->returnPage("/pay/verify/{$attempt['id']}"));
});

// The return page forwards the token here with a GET, so CSRF doesn't apply.
// The status API decides, never the token alone.
Route::get('/pay/verify/{attemptId}', function (Request $request, string $attemptId, Store $store, GetPayGateway $gateway) {
    $attempt = $store->getAttempt($attemptId) ?? abort(404);
    $token = (string) $request->query('token', '');
    try {
        $outcome = $gateway->confirmPayment($attempt['id'], $attempt['amountPaisa'], $attempt['providerRef'], $token !== '' ? ['token' => $token] : []);
    } catch (PaymentError $e) {
        Log::warning("attempt $attemptId: {$e->getMessage()}");
        return response('Payment could not be verified', 400);
    } catch (Throwable $e) {
        report($e); // network or provider outage: the reconcile job retries later
        return response('Payment provider unavailable, try again shortly', 502);
    }
    settle($store, $attempt, $outcome);
    return redirect("/orders/{$attempt['orderId']}", 303);
});

Route::get('/orders/{orderId}', function (string $orderId, Store $store) {
    $attempt = $store->latestAttempt($orderId);
    return response("Order $orderId: " . ($attempt['status'] ?? 'no payment yet'))->header('Content-Type', 'text/plain');
});` },
    { file: "app/Providers/AppServiceProvider.php", lang: "php", code: `<?php

namespace App\\Providers;

use App\\Payments\\Gateway;
use App\\Payments\\GetPayGateway;
use App\\Payments\\Store;
use Illuminate\\Support\\ServiceProvider;

class AppServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        // Payments.php holds several classes and functions, so PSR-4 cannot find them.
        require_once app_path('Payments/Payments.php');
        // GetPayGateway.php also holds CardStart, so load it by hand too.
        require_once app_path('Payments/GetPayGateway.php');

        // One gateway object: the routes ask for GetPayGateway (they need startCard and the pages),
        // the reconcile command asks for Gateway.
        $this->app->singleton(GetPayGateway::class, fn () => GetPayGateway::fromEnv());
        $this->app->alias(GetPayGateway::class, Gateway::class);
        $this->app->singleton(Store::class, fn () => new Store(storage_path('app/payments.json')));
    }

    public function boot(): void
    {
    }
}` },
  ],
  php: [
    { file: "index.php", lang: "php", code: `<?php

declare(strict_types=1);

// Front controller for the built-in server: php -S localhost:8000 index.php

require __DIR__ . '/Payments.php';
require __DIR__ . '/Store.php';
require __DIR__ . '/Reconcile.php';
require __DIR__ . '/GetPayGateway.php';

use App\\Payments\\GetPayGateway;
use App\\Payments\\PaymentError;
use App\\Payments\\Reconcile;
use App\\Payments\\Store;

use function App\\Payments\\settle;

// Keep the data file out of any public web root in production.
$store = new Store(__DIR__ . '/payments.json');
$gateway = GetPayGateway::fromEnv();
// Must be the origin your bank registered with NCHL (GETPAY_WEBSITE_DOMAIN).
$baseUrl = rtrim(getenv('BASE_URL') ?: 'http://localhost:8000', '/');

// Cron, every minute: php index.php reconcile
if (PHP_SAPI === 'cli') {
    Reconcile::run($store, $gateway);
    exit;
}

$method = $_SERVER['REQUEST_METHOD'];
$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);

function respond(int $code, string $body, string $type = 'text/html'): never
{
    http_response_code($code);
    header("Content-Type: $type; charset=utf-8");
    echo $body;
    exit;
}

if ($method === 'GET' && $path === '/') {
    respond(200, '<h1>Order demo, Rs 100</h1><form method="post" action="/pay/demo"><button>Pay by card</button></form>');
}

// Page 1: creates the attempt and starts GetPay's SDK in the browser.
if ($method === 'POST' && preg_match('#^/pay/([\\w-]+)$#', $path, $m)) {
    $order = $store->getOrder($m[1]) ?? respond(404, 'Order not found', 'text/plain');
    $attempt = $store->createAttempt($order['id'], $order['amountPaisa']);
    $start = $gateway->startCard($attempt['id'], $attempt['amountPaisa'], "$baseUrl/pay/return/{$attempt['id']}", "Order {$order['id']}");
    respond(200, $gateway->checkoutPage($start, "/pay/card/{$attempt['id']}"));
}

// Page 2: GetPay's card form.
if ($method === 'GET' && preg_match('#^/pay/card/([a-f0-9]+)$#', $path, $m)) {
    $store->getAttempt($m[1]) ?? respond(404, 'Payment not found', 'text/plain');
    respond(200, $gateway->paymentPage());
}

// Pages 3 and 4: GetPay sends the buyer here after a success or a failure.
if ($method === 'GET' && preg_match('#^/pay/return/([a-f0-9]+)$#', $path, $m)) {
    $attempt = $store->getAttempt($m[1]) ?? respond(404, 'Payment not found', 'text/plain');
    respond(200, $gateway->returnPage("/pay/verify/{$attempt['id']}"));
}

// The return page forwards the token here. The status API decides, never the token alone.
if ($method === 'GET' && preg_match('#^/pay/verify/([a-f0-9]+)$#', $path, $m)) {
    $attempt = $store->getAttempt($m[1]) ?? respond(404, 'Payment not found', 'text/plain');
    $token = is_string($_GET['token'] ?? null) ? $_GET['token'] : '';
    try {
        $outcome = $gateway->confirmPayment($attempt['id'], $attempt['amountPaisa'], $attempt['providerRef'], $token !== '' ? ['token' => $token] : []);
    } catch (PaymentError $e) {
        error_log("attempt {$attempt['id']}: {$e->getMessage()}");
        respond(400, 'Payment could not be verified', 'text/plain');
    } catch (Throwable $e) {
        error_log("attempt {$attempt['id']}: $e"); // the reconcile job retries later
        respond(502, 'Payment provider unavailable, try again shortly', 'text/plain');
    }
    settle($store, $attempt, $outcome);
    header("Location: /orders/{$attempt['orderId']}", true, 303);
    exit;
}

if ($method === 'GET' && preg_match('#^/orders/([\\w-]+)$#', $path, $m)) {
    $attempt = $store->latestAttempt($m[1]);
    respond(200, "Order $m[1]: " . ($attempt['status'] ?? 'no payment yet'), 'text/plain');
}

respond(404, 'Not found', 'text/plain');` },
  ],
  go: [
    { file: "main.go", lang: "go", code: `package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	"shop/payments"
)

// reconcileGateway lets the shared Reconcile job use the GetPay module. Reconcile only calls
// ConfirmPayment, but its Gateway interface also wants a StartPayment that returns a redirect or form.
type reconcileGateway struct{ *payments.GetPay }

func (reconcileGateway) StartPayment(context.Context, payments.StartInput) (payments.Start, error) {
	return payments.Start{}, errors.New("GetPay starts in the browser, not with a redirect")
}

func main() {
	store := payments.NewStore()
	gateway := payments.NewGetPay()
	// Must be the origin your bank registered with NCHL (GETPAY_WEBSITE_DOMAIN).
	baseURL := strings.TrimRight(envOr("BASE_URL", "http://localhost:8080"), "/")

	// Reconcile open attempts every minute: buyers who paid but never reached the return page.
	go func() {
		for {
			payments.Reconcile(context.Background(), store, reconcileGateway{gateway})
			time.Sleep(time.Minute)
		}
	}()

	mux := http.NewServeMux()
	page := func(w http.ResponseWriter, body string) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		fmt.Fprint(w, body)
	}

	mux.HandleFunc("GET /{$}", func(w http.ResponseWriter, r *http.Request) {
		page(w, \`<h1>Order demo, Rs 100</h1><form method="post" action="/pay/demo"><button>Pay by card</button></form>\`)
	})

	// Page 1: creates the attempt and starts GetPay's SDK in the browser.
	mux.HandleFunc("POST /pay/{orderID}", func(w http.ResponseWriter, r *http.Request) {
		order, ok := store.GetOrder(r.PathValue("orderID"))
		if !ok {
			http.NotFound(w, r)
			return
		}
		attempt := store.CreateAttempt(order.ID, order.AmountPaisa)
		start, err := gateway.StartPayment(r.Context(), payments.StartInput{
			AttemptID:   attempt.ID,
			AmountPaisa: attempt.AmountPaisa,
			ReturnURL:   baseURL + "/pay/return/" + attempt.ID,
			Description: "Order " + order.ID,
		})
		if err != nil {
			log.Printf("start %s: %v", attempt.ID, err)
			http.Error(w, "Could not start the payment", http.StatusInternalServerError)
			return
		}
		page(w, gateway.CheckoutPage(start, "/pay/card/"+attempt.ID))
	})

	// Page 2: GetPay's card form.
	mux.HandleFunc("GET /pay/card/{attemptID}", func(w http.ResponseWriter, r *http.Request) {
		if _, ok := store.GetAttempt(r.PathValue("attemptID")); !ok {
			http.NotFound(w, r)
			return
		}
		page(w, gateway.PaymentPage())
	})

	// Pages 3 and 4: GetPay sends the buyer here after a success or a failure.
	mux.HandleFunc("GET /pay/return/{attemptID}", func(w http.ResponseWriter, r *http.Request) {
		attempt, ok := store.GetAttempt(r.PathValue("attemptID"))
		if !ok {
			http.NotFound(w, r)
			return
		}
		page(w, gateway.ReturnPage("/pay/verify/"+attempt.ID))
	})

	// The return page forwards the token here. The status API decides, never the token alone.
	mux.HandleFunc("GET /pay/verify/{attemptID}", func(w http.ResponseWriter, r *http.Request) {
		attempt, ok := store.GetAttempt(r.PathValue("attemptID"))
		if !ok {
			http.NotFound(w, r)
			return
		}
		params := map[string]string{}
		if token := r.URL.Query().Get("token"); token != "" {
			params["token"] = token
		}
		outcome, err := gateway.ConfirmPayment(r.Context(), payments.ConfirmInput{
			AttemptID:   attempt.ID,
			AmountPaisa: attempt.AmountPaisa,
			ProviderRef: attempt.ProviderRef,
			Params:      params,
		})
		if errors.Is(err, payments.ErrPayment) {
			log.Printf("attempt %s: %v", attempt.ID, err)
			http.Error(w, "Payment could not be verified", http.StatusBadRequest)
			return
		}
		if err != nil {
			log.Printf("attempt %s: %v", attempt.ID, err) // the reconcile job retries later
			http.Error(w, "Payment provider unavailable, try again shortly", http.StatusBadGateway)
			return
		}
		payments.Settle(store, attempt, outcome)
		http.Redirect(w, r, "/orders/"+attempt.OrderID, http.StatusSeeOther)
	})

	mux.HandleFunc("GET /orders/{orderID}", func(w http.ResponseWriter, r *http.Request) {
		status := "no payment yet"
		if a, ok := store.LatestAttempt(r.PathValue("orderID")); ok {
			status = a.Status
		}
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		fmt.Fprintf(w, "Order %s: %s", r.PathValue("orderID"), status)
	})

	log.Println("listening on " + baseURL)
	log.Fatal(http.ListenAndServe(":8080", mux))
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}` },
  ],
  spring: [
    { file: "src/main/java/shop/ShopApplication.java", lang: "java", code: `package shop;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.context.annotation.Bean;
import org.springframework.scheduling.annotation.EnableScheduling;
import payments.GetPayGateway;
import payments.Store;

@SpringBootApplication
@EnableScheduling
public class ShopApplication {
    public static void main(String[] args) {
        SpringApplication.run(ShopApplication.class, args);
    }

    // The payments package has no Spring annotations, so register its pieces here.
    @Bean
    Store store() {
        return new Store();
    }

    // Also the Gateway that ReconcileJob gets injected.
    @Bean
    GetPayGateway gateway() {
        return GetPayGateway.fromEnv();
    }
}` },
    { file: "src/main/java/shop/PaymentController.java", lang: "java", code: `package shop;

import java.net.URI;
import java.util.Map;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import payments.GetPayGateway;
import payments.Outcome;
import payments.PaymentException;
import payments.Payments;
import payments.Store;

@RestController
class PaymentController {
    private final Store store;
    private final GetPayGateway gateway;
    private final String baseUrl;

    // BASE_URL must be the origin your bank registered with NCHL (GETPAY_WEBSITE_DOMAIN).
    PaymentController(Store store, GetPayGateway gateway, @Value("\${BASE_URL:http://localhost:8080}") String baseUrl) {
        this.store = store;
        this.gateway = gateway;
        this.baseUrl = baseUrl.replaceAll("/+$", "");
    }

    @GetMapping(value = "/", produces = MediaType.TEXT_HTML_VALUE)
    String home() {
        return "<h1>Order demo, Rs 100</h1><form method=\\"post\\" action=\\"/pay/demo\\"><button>Pay by card</button></form>";
    }

    // Page 1: creates the attempt and starts GetPay's SDK in the browser.
    @PostMapping(value = "/pay/{orderId}", produces = MediaType.TEXT_HTML_VALUE)
    ResponseEntity<String> pay(@PathVariable String orderId) {
        Store.Order order = store.getOrder(orderId);
        if (order == null) return ResponseEntity.notFound().build();
        Store.Attempt attempt = store.createAttempt(orderId, order.amountPaisa());
        GetPayGateway.CardStart start = gateway.startCard(
            attempt.id(), attempt.amountPaisa(), baseUrl + "/pay/return/" + attempt.id(), "Order " + orderId);
        return ResponseEntity.ok(gateway.checkoutPage(start, "/pay/card/" + attempt.id()));
    }

    // Page 2: GetPay's card form.
    @GetMapping(value = "/pay/card/{attemptId}", produces = MediaType.TEXT_HTML_VALUE)
    ResponseEntity<String> card(@PathVariable String attemptId) {
        if (store.getAttempt(attemptId) == null) return ResponseEntity.notFound().build();
        return ResponseEntity.ok(gateway.paymentPage());
    }

    // Pages 3 and 4: GetPay sends the buyer here after a success or a failure.
    @GetMapping(value = "/pay/return/{attemptId}", produces = MediaType.TEXT_HTML_VALUE)
    ResponseEntity<String> paymentReturn(@PathVariable String attemptId) {
        if (store.getAttempt(attemptId) == null) return ResponseEntity.notFound().build();
        return ResponseEntity.ok(gateway.returnPage("/pay/verify/" + attemptId));
    }

    // The return page forwards the token here. The status API decides, never the token alone.
    @GetMapping("/pay/verify/{attemptId}")
    ResponseEntity<String> verify(@PathVariable String attemptId, @RequestParam(defaultValue = "") String token) {
        Store.Attempt attempt = store.getAttempt(attemptId);
        if (attempt == null) return ResponseEntity.notFound().build();
        try {
            Outcome outcome = gateway.confirmPayment(attempt.id(), attempt.amountPaisa(), attempt.providerRef(),
                token.isEmpty() ? Map.of() : Map.of("token", token));
            Payments.settle(store, attempt, outcome);
        } catch (PaymentException e) {
            System.err.println("attempt " + attemptId + ": " + e.getMessage());
            return ResponseEntity.badRequest().body("Payment could not be verified");
        } catch (RuntimeException e) {
            System.err.println("attempt " + attemptId + ": " + e); // the reconcile job retries later
            return ResponseEntity.status(HttpStatus.BAD_GATEWAY).body("Payment provider unavailable, try again shortly");
        }
        return ResponseEntity.status(HttpStatus.SEE_OTHER).location(URI.create("/orders/" + attempt.orderId())).build();
    }

    @GetMapping(value = "/orders/{orderId}", produces = MediaType.TEXT_PLAIN_VALUE)
    String order(@PathVariable String orderId) {
        Store.Attempt attempt = store.latestAttempt(orderId);
        return "Order " + orderId + ": " + (attempt == null ? "no payment yet" : attempt.status());
    }
}` },
  ],
  ktor: [
    { file: "src/main/kotlin/shop/Application.kt", lang: "kotlin", code: `package shop

import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.server.application.Application
import io.ktor.server.application.ApplicationCall
import io.ktor.server.application.log
import io.ktor.server.engine.embeddedServer
import io.ktor.server.netty.Netty
import io.ktor.server.response.respond
import io.ktor.server.response.respondText
import io.ktor.server.routing.get
import io.ktor.server.routing.post
import io.ktor.server.routing.routing
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import payments.GetPayGateway
import payments.PaymentException
import payments.Store
import payments.reconcile
import payments.settle
import kotlin.time.Duration.Companion.minutes

fun main() {
    embeddedServer(Netty, port = 8080, module = Application::module).start(wait = true)
}

fun Application.module() {
    // Must be the origin your bank registered with NCHL (GETPAY_WEBSITE_DOMAIN).
    val baseUrl = (System.getenv("BASE_URL") ?: "http://localhost:8080").trimEnd('/')
    val store = Store()
    val gateway = GetPayGateway.fromEnv()

    // Reconcile open attempts every minute: buyers who paid but never reached the return page.
    launch {
        while (isActive) {
            reconcile(store, gateway)
            delay(1.minutes)
        }
    }

    routing {
        get("/") {
            call.respondText(
                """<h1>Order demo, Rs 100</h1><form method="post" action="/pay/demo"><button>Pay by card</button></form>""",
                ContentType.Text.Html,
            )
        }

        // Page 1: creates the attempt and starts GetPay's SDK in the browser.
        post("/pay/{orderId}") {
            val order = store.getOrder(call.parameters["orderId"]!!) ?: return@post call.respond(HttpStatusCode.NotFound)
            val attempt = store.createAttempt(order.id, order.amountPaisa)
            val start = gateway.startPayment(attempt.id, attempt.amountPaisa, "$baseUrl/pay/return/\${attempt.id}", "Order \${order.id}")
            call.respondText(gateway.checkoutPage(start, "/pay/card/\${attempt.id}"), ContentType.Text.Html)
        }

        // Page 2: GetPay's card form.
        get("/pay/card/{attemptId}") {
            store.getAttempt(call.parameters["attemptId"]!!) ?: return@get call.respond(HttpStatusCode.NotFound)
            call.respondText(gateway.paymentPage(), ContentType.Text.Html)
        }

        // Pages 3 and 4: GetPay sends the buyer here after a success or a failure.
        get("/pay/return/{attemptId}") {
            val attempt = store.getAttempt(call.parameters["attemptId"]!!) ?: return@get call.respond(HttpStatusCode.NotFound)
            call.respondText(gateway.returnPage("/pay/verify/\${attempt.id}"), ContentType.Text.Html)
        }

        // The return page forwards the token here. The status API decides, never the token alone.
        get("/pay/verify/{attemptId}") {
            val attempt = store.getAttempt(call.parameters["attemptId"]!!) ?: return@get call.respond(HttpStatusCode.NotFound)
            val token = call.request.queryParameters["token"].orEmpty()
            val outcome = try {
                gateway.confirmPayment(attempt.id, attempt.amountPaisa, attempt.providerRef, if (token.isEmpty()) emptyMap() else mapOf("token" to token))
            } catch (e: PaymentException) {
                call.application.log.warn("attempt \${attempt.id}: \${e.message}")
                return@get call.respondText("Payment could not be verified", status = HttpStatusCode.BadRequest)
            } catch (e: Exception) {
                call.application.log.error("attempt \${attempt.id}", e) // the reconcile job retries later
                return@get call.respondText("Payment provider unavailable, try again shortly", status = HttpStatusCode.BadGateway)
            }
            settle(store, attempt, outcome)
            call.seeOther("/orders/\${attempt.orderId}")
        }

        get("/orders/{orderId}") {
            val orderId = call.parameters["orderId"]!!
            call.respondText("Order $orderId: \${store.latestAttempt(orderId)?.status ?: "no payment yet"}")
        }
    }
}

private suspend fun ApplicationCall.seeOther(url: String) {
    response.headers.append(HttpHeaders.Location, url)
    respond(HttpStatusCode.SeeOther)
}` },
    { file: "build.gradle.kts", lang: "kotlin", code: `plugins {
    kotlin("jvm") version "2.4.21"
    application
}

repositories {
    mavenCentral()
}

dependencies {
    implementation("io.ktor:ktor-server-netty:3.6.1")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.12.0") // used by the gateway module
    implementation("org.slf4j:slf4j-simple:2.0.20") // Ktor logs through SLF4J
}

application {
    mainClass.set("shop.ApplicationKt")
}` },
  ],
};

// The oprSecret test vector from GetPay's reference: base64(SHA-256(oprKey + id)). Every module above reproduces it.
export const oprSecretVector = {
  oprKey: "4fa4c6b9-3f91-43e5-9b4f-319f68187ba5",
  id: "0cc5b1a39f3c4cad864bc1c6a524534f",
  oprSecret: "FsNmsEdMIM6tH60Wmq7oxfd0kjoK2pxloT35YvHwjOM=",
};

export default getpay;

// Generated NEPALPAY QR (NCHL) gateway module, one per language, plus the QR routes each framework needs.
// The parts joined with "\n\n" in order (config, sign, start, confirm) form the complete file.
// NEPALPAY QR has no redirect, so its post replaces the shared routes with qrRoutes: the pay route shows
// the QR and a status route, polled by that page, asks NCHL.

export interface GatewayCode {
  file: string;
  lang: string;
  parts: { config: string; sign: string; start: string; confirm: string };
}

export interface Block {
  file: string;
  lang: string;
  code: string;
}

export const nepalpay: Record<"ts" | "python" | "php" | "go" | "java" | "kotlin", GatewayCode> = {
  ts: {
    file: "nepalpay.ts",
    lang: "typescript",
    parts: {
      config: `import { PaymentError, type ConfirmInput, type Outcome, type StartInput } from "./payments";

// NEPALPAY QR (NCHL). UAT unless NEPALPAY_ENV=production.
const PRODUCTION = process.env.NEPALPAY_ENV === "production";
// NEPALPAY_BASE_URL is for a local mock or proxy. Leave it unset to talk to NCHL.
const BASE_URL =
  process.env.NEPALPAY_BASE_URL ?? (PRODUCTION ? "https://opennpi.connectips.com" : "https://devopennpi.connectips.com");
const GENERATE_URL = \`\${BASE_URL}/qr/generateQR\`;
const REPORT_URL = \`\${BASE_URL}/nQR/v1/merchanttxnreport\`;

// There is no public test merchant. NCHL issues all of these when your bank enrols you.
const ACQUIRER_ID = process.env.NEPALPAY_ACQUIRER_ID ?? ""; // 8 digits, your acquiring bank
const MERCHANT_ID = process.env.NEPALPAY_MERCHANT_ID ?? "";
const MERCHANT_NAME = (process.env.NEPALPAY_MERCHANT_NAME ?? "").slice(0, 25); // must match the enrolled name
const MCC = process.env.NEPALPAY_MCC ?? ""; // merchant category code
const CITY = process.env.NEPALPAY_MERCHANT_CITY ?? "Kathmandu";
const POSTAL_CODE = process.env.NEPALPAY_MERCHANT_POSTAL_CODE ?? "44600";
const STORE_LABEL = process.env.NEPALPAY_STORE_LABEL ?? "Store1";
const TERMINAL_LABEL = process.env.NEPALPAY_TERMINAL_LABEL ?? "0";
const USERNAME = process.env.NEPALPAY_USERNAME ?? ""; // the NPI user, also the userId inside the token
const PASSWORD = process.env.NEPALPAY_PASSWORD ?? "";
// PKCS#8 PEM ("BEGIN PRIVATE KEY") taken out of the NPI .pfx. Env files often hold it with "\\n" escapes.
const PRIVATE_KEY_PEM = (process.env.NEPALPAY_PRIVATE_KEY_PEM ?? "").replace(/\\\\n/g, "\\n");
// privateKey() below checks these on first use.

// Every call carries the NPI user as HTTP Basic auth.
const HEADERS = {
  Authorization: \`Basic \${btoa(\`\${USERNAME}:\${PASSWORD}\`)}\`,
  "Content-Type": "application/json",
};

// Not a redirect or a form: a QR this page shows. validationTraceId comes back as providerRef.
export interface QrStart {
  type: "qr";
  qrString: string; // the EMVCo payload; any QR library can draw it
  qrImage?: string; // base64 PNG of the same QR, sent because we ask for it
  providerRef: string; // validationTraceId: confirmPayment needs it
}

// 10050 paisa -> "100.50". NCHL wants rupees with exactly two decimals, as text.
export function rupees(paisa: number): string {
  return \`\${Math.trunc(paisa / 100)}.\${String(paisa % 100).padStart(2, "0")}\`;
}`,
      sign: `// Load the key once, not per request. Web Crypto wants the DER bytes inside the PEM armour.
// The settings are checked here, on first use, because next build imports this file without them.
let key: Promise<CryptoKey> | undefined;
function privateKey(): Promise<CryptoKey> {
  if (!key) {
    if (!ACQUIRER_ID || !MERCHANT_ID || !MERCHANT_NAME || !MCC || !USERNAME || !PASSWORD || !PRIVATE_KEY_PEM) {
      throw new Error(
        "Set NEPALPAY_ACQUIRER_ID, NEPALPAY_MERCHANT_ID, NEPALPAY_MERCHANT_NAME, NEPALPAY_MCC, NEPALPAY_USERNAME, NEPALPAY_PASSWORD and NEPALPAY_PRIVATE_KEY_PEM",
      );
    }
    if (!PRIVATE_KEY_PEM.includes("-----BEGIN PRIVATE KEY-----")) {
      throw new Error("NEPALPAY_PRIVATE_KEY_PEM must be PKCS#8 (BEGIN PRIVATE KEY): convert it with openssl pkcs8 -topk8");
    }
    const der = Uint8Array.from(atob(PRIVATE_KEY_PEM.replace(/-----[A-Z ]+-----|\\s/g, "")), (c) => c.charCodeAt(0));
    key = crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  }
  return key;
}

// base64(RSA-SHA256(private key, message)), the same as \`openssl dgst -sha256 -sign key.pem | base64\`.
// Pass the text itself: the SHA-256 step is part of the signature, so never hash it first.
export async function rsaSha256Base64(message: string): Promise<string> {
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", await privateKey(), new TextEncoder().encode(message));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

// The values NCHL signs for a dynamic QR, in this order, joined with bare commas.
// The docs print ", " between them; every working client sends "," with no space.
export function tokenString(amount: string, billNumber: string): string {
  return [ACQUIRER_ID, MERCHANT_ID, MCC, "524", amount, billNumber, USERNAME].join(",");
}`,
      start: `// Asks NCHL for a dynamic QR for this attempt. There is no redirect: the page shows the QR.
export async function startPayment(input: StartInput): Promise<QrStart> {
  // billNumber takes at most 25 characters. Our attempt ids are 20 hex characters.
  if (!/^[A-Za-z0-9-]{1,25}$/.test(input.attemptId)) {
    throw new Error(\`NEPALPAY billNumber must be 1 to 25 letters, digits or "-": \${input.attemptId}\`);
  }
  // Format once: the token signs this exact string, and the body sends the same one.
  const amount = rupees(input.amountPaisa);
  const res = await fetch(GENERATE_URL, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      pointOfInitialization: 12, // 12 = dynamic QR (amount inside), 11 = static
      acquirerId: ACQUIRER_ID,
      merchantId: MERCHANT_ID,
      merchantName: MERCHANT_NAME,
      merchantCategoryCode: Number(MCC),
      merchantCountry: "NP",
      merchantCity: CITY,
      merchantPostalCode: POSTAL_CODE,
      merchantLanguage: "en",
      transactionCurrency: 524, // ISO 4217 numeric for NPR
      transactionAmount: amount,
      valueOfConvenienceFeeFixed: "0.00",
      billNumber: input.attemptId, // comes back as merchantBillNo in the report
      storeLabel: STORE_LABEL,
      terminalLabel: TERMINAL_LABEL,
      purposeOfTransaction: input.description.slice(0, 25),
      qrImage: true, // also send a PNG, so the page needs no QR library
      token: await rsaSha256Base64(tokenString(amount, input.attemptId)),
    }),
    signal: AbortSignal.timeout(20_000),
  });
  // input.returnUrl is not sent: the payer stays in their banking app and never comes back through a URL.
  const body = await res.json().catch(() => null);
  const data = body?.data;
  if (body?.responseCode !== "000" || !data?.qrString || !data?.validationTraceId) {
    // E003 INVALID TOKEN, E010 merchant not found, 400 with fieldErrors, or a 401 for a wrong NPI user.
    throw new PaymentError(\`NEPALPAY generateQR failed: HTTP \${res.status} \${JSON.stringify(body)}\`);
  }
  return {
    type: "qr",
    qrString: String(data.qrString).trim(),
    qrImage: data.qrImage ? String(data.qrImage) : undefined,
    providerRef: String(data.validationTraceId),
  };
}`,
      confirm: `// One row of the transaction report. A QR can have several: a failed scan, then a paid one.
interface ReportRow {
  tranType?: string; // PMT = payment, RFND = refund
  debitStatus?: string; // "000" = the payer's account was debited
  creditStatus?: string; // "000", "999" or "DEFER" = success (DEFER = settlement later)
  amount?: number; // rupees, as a number: 100.0
  merchantBillNo?: string; // the billNumber we sent
  nQrTxnId?: string;
}

const CREDIT_OK = ["000", "999", "DEFER"];

// Called by the status route the QR page polls, and by the reconcile job. Both pass params = {}:
// nothing reaches us from the payer's app, so the report is the only source.
export async function confirmPayment(input: ConfirmInput): Promise<Outcome> {
  // No validationTraceId means generateQR never succeeded, so no QR was ever shown.
  if (!input.providerRef) return { status: "not_found" };

  const res = await fetch(REPORT_URL, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ validationTraceId: input.providerRef, merchantId: MERCHANT_ID, acquirerId: ACQUIRER_ID }),
    signal: AbortSignal.timeout(20_000),
  });
  const body = await res.json().catch(() => null);
  // 401 is a wrong NPI user. Like an outage, it is not the payer's fault: the route answers 502.
  if (res.status === 401) throw new Error("NEPALPAY report: 401, check NEPALPAY_USERNAME and NEPALPAY_PASSWORD");
  if (body?.responseCode === "E010") return { status: "not_found" }; // nobody has paid this QR yet
  if (body?.responseCode !== "200" && body?.responseCode !== "000") {
    throw new Error(\`NEPALPAY report failed: HTTP \${res.status} \${JSON.stringify(body)}\`);
  }

  const rows: ReportRow[] = Array.isArray(body.responseBody) ? body.responseBody : [];
  const payments = rows.filter((r) => (r.tranType ?? "PMT") === "PMT"); // refunds never make an attempt paid
  const paid = payments.find((r) => r.debitStatus === "000" && CREDIT_OK.includes(String(r.creditStatus)));
  if (paid) {
    if (paid.merchantBillNo && paid.merchantBillNo !== input.attemptId) {
      throw new PaymentError("NEPALPAY: report row is for a different bill number");
    }
    // A success for any other amount is not this payment. Compare with what WE stored.
    if (Math.round(Number(paid.amount) * 100) !== input.amountPaisa) {
      throw new PaymentError(\`NEPALPAY: amount mismatch (\${paid.amount})\`);
    }
    return { status: "paid" };
  }
  // Debited but the credit isn't confirmed: money left the payer, so keep asking.
  if (payments.some((r) => r.debitStatus === "000")) return { status: "pending" };
  // No rows, or only failed scans. The payer can scan the same QR again, so this is not "failed".
  return { status: "not_found" };
}`,
    },
  },
  python: {
    file: "nepalpay.py",
    lang: "python",
    parts: {
      config: `import base64
import json
import os
import urllib.error
import urllib.request
from dataclasses import dataclass

# The standard library has no RSA signing, so this one module needs: pip install cryptography
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding

from payments import Outcome, PaymentError

# NEPALPAY QR (NCHL). UAT unless NEPALPAY_ENV=production.
PRODUCTION = os.environ.get("NEPALPAY_ENV") == "production"
# NEPALPAY_BASE_URL is for a local mock or proxy. Leave it unset to talk to NCHL.
BASE_URL = os.environ.get("NEPALPAY_BASE_URL") or (
    "https://opennpi.connectips.com" if PRODUCTION else "https://devopennpi.connectips.com")
GENERATE_URL = f"{BASE_URL}/qr/generateQR"
REPORT_URL = f"{BASE_URL}/nQR/v1/merchanttxnreport"

# There is no public test merchant. Your bank (or businesssupport@nchl.com.np) issues all of these.
ACQUIRER_ID = os.environ.get("NEPALPAY_ACQUIRER_ID", "")  # 8 digits, your acquiring bank
MERCHANT_ID = os.environ.get("NEPALPAY_MERCHANT_ID", "")
MERCHANT_NAME = os.environ.get("NEPALPAY_MERCHANT_NAME", "")[:25]  # must match the enrolled name
MCC = os.environ.get("NEPALPAY_MCC", "")  # merchant category code
USERNAME = os.environ.get("NEPALPAY_USERNAME", "")  # NPI user, also the userId inside the token
PASSWORD = os.environ.get("NEPALPAY_PASSWORD", "")
# PKCS#8 PEM ("BEGIN PRIVATE KEY") taken out of the NPI .pfx. Env files often hold it with "\\n" escapes.
PRIVATE_KEY_PEM = os.environ.get("NEPALPAY_PRIVATE_KEY_PEM", "").replace("\\\\n", "\\n")
MERCHANT_CITY = os.environ.get("NEPALPAY_MERCHANT_CITY", "Kathmandu")
MERCHANT_POSTAL_CODE = os.environ.get("NEPALPAY_MERCHANT_POSTAL_CODE", "44600")
STORE_LABEL = os.environ.get("NEPALPAY_STORE_LABEL", "Store1")
TERMINAL_LABEL = os.environ.get("NEPALPAY_TERMINAL_LABEL", "0")
if not (ACQUIRER_ID and MERCHANT_ID and MERCHANT_NAME and MCC and USERNAME and PASSWORD and PRIVATE_KEY_PEM):
    raise RuntimeError("Set NEPALPAY_ACQUIRER_ID, NEPALPAY_MERCHANT_ID, NEPALPAY_MERCHANT_NAME, NEPALPAY_MCC, "
                       "NEPALPAY_USERNAME, NEPALPAY_PASSWORD and NEPALPAY_PRIVATE_KEY_PEM")
if "-----BEGIN PRIVATE KEY-----" not in PRIVATE_KEY_PEM:
    raise RuntimeError("NEPALPAY_PRIVATE_KEY_PEM must be PKCS#8 (BEGIN PRIVATE KEY): convert it with openssl pkcs8 -topk8")

NPR = 524  # ISO 4217 numeric code for the Nepali rupee
AUTH = "Basic " + base64.b64encode(f"{USERNAME}:{PASSWORD}".encode()).decode()


def post_json(url: str, payload: dict) -> tuple[int, object]:
    """POST JSON with Basic auth. Returns (HTTP status, parsed body). NCHL puts error details in 4xx bodies too."""
    req = urllib.request.Request(url, data=json.dumps(payload).encode(), method="POST", headers={
        "Authorization": AUTH,
        "Content-Type": "application/json",
    })
    try:
        with urllib.request.urlopen(req, timeout=20) as res:
            return res.status, json.load(res)
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.load(e)
        except ValueError:
            return e.code, None
    except (urllib.error.URLError, ValueError) as e:
        raise RuntimeError(f"NEPALPAY request to {url} failed: {e}") from e`,
      sign: `# Load the key once, not per request.
PRIVATE_KEY = serialization.load_pem_private_key(PRIVATE_KEY_PEM.encode(), password=None)


def rsa_sha256_base64(message: str) -> str:
    """base64(RSA-SHA256(private key, message)), the same as \`openssl dgst -sha256 -sign key.pem | base64\`.
    Pass the text itself: the SHA-256 step is part of the signature, so never hash it first."""
    sig = PRIVATE_KEY.sign(message.encode(), padding.PKCS1v15(), hashes.SHA256())
    return base64.b64encode(sig).decode()


def token_string(transaction_amount: str, bill_number: str) -> str:
    """NCHL signs seven values joined by bare commas. The docs print ", " but every working client uses ","."""
    return ",".join([ACQUIRER_ID, MERCHANT_ID, MCC, str(NPR), transaction_amount, bill_number, USERNAME])`,
      start: `@dataclass
class QrStart:
    """What start_payment hands back for NEPALPAY: a QR to show, not a page to send the buyer to."""
    qr_string: str                 # EMVCo payload; any QR library can draw it
    provider_ref: str              # validationTraceId: confirm_payment needs it, so store it
    qr_image: str | None = None    # base64 PNG of the same QR, when NCHL sends one
    type: str = "qr"


def rupees(amount_paisa: int) -> str:
    """10000 paisa -> "100.00". NCHL wants rupees with exactly two decimals, and the token signs this exact text."""
    return f"{amount_paisa // 100}.{amount_paisa % 100:02d}"


def start_payment(attempt_id: str, amount_paisa: int, return_url: str, description: str) -> QrStart:
    """Asks NCHL for a dynamic QR that carries the amount and our attempt id."""
    # return_url is not used: there is no redirect. The buyer pays from their own banking app.
    if not 1 <= len(attempt_id) <= 25:
        raise ValueError(f"NEPALPAY billNumber must be 1 to 25 characters: {attempt_id}")
    amount = rupees(amount_paisa)  # formatted once: the same text goes into the token and the body
    payload = {
        "pointOfInitialization": 12,  # 12 = dynamic QR (one amount, one bill), 11 = static
        "acquirerId": ACQUIRER_ID,
        "merchantId": MERCHANT_ID,
        "merchantName": MERCHANT_NAME,
        "merchantCategoryCode": int(MCC),
        "merchantCountry": "NP",
        "merchantCity": MERCHANT_CITY,
        "merchantPostalCode": MERCHANT_POSTAL_CODE,
        "merchantLanguage": "en",
        "transactionCurrency": NPR,
        "transactionAmount": amount,
        "valueOfConvenienceFeeFixed": "0.00",
        "billNumber": attempt_id,  # comes back as merchantBillNo in the report
        "storeLabel": STORE_LABEL,
        "terminalLabel": TERMINAL_LABEL,
        "purposeOfTransaction": description[:25],
        "qrImage": True,  # also send a PNG, so the page needs no QR library
        "token": rsa_sha256_base64(token_string(amount, attempt_id)),
    }
    status, body = post_json(GENERATE_URL, payload)
    body = body if isinstance(body, dict) else {}
    data = body.get("data") if isinstance(body.get("data"), dict) else {}
    if body.get("responseCode") != "000" or not data.get("qrString") or not data.get("validationTraceId"):
        # E003 INVALID TOKEN, E010 merchant not found, 400 PARAMETER VALIDATION ERROR, ...
        raise PaymentError(f"NEPALPAY generateQR failed (HTTP {status}): "
                           f"{body.get('responseCode')} {body.get('responseMessage')}")
    return QrStart(
        qr_string=str(data["qrString"]).strip(),
        provider_ref=str(data["validationTraceId"]),
        qr_image=str(data["qrImage"]) if data.get("qrImage") else None,
    )`,
      confirm: `CREDIT_OK = {"000", "999", "DEFER"}  # NCHL lists all three as success; DEFER means settlement comes later


def confirm_payment(attempt_id: str, amount_paisa: int, provider_ref: str | None, params: dict[str, str]) -> Outcome:
    """Called from the status route the QR page polls, and from the reconcile job.
    params is always empty: nothing comes back through the browser, so there is no callback to read."""
    # No validationTraceId means generateQR never succeeded, so nobody could have paid.
    if not provider_ref:
        return Outcome(status="not_found")

    status, body = post_json(REPORT_URL, {
        "validationTraceId": provider_ref,
        "merchantId": MERCHANT_ID,
        "acquirerId": ACQUIRER_ID,
    })
    if status == 401:
        # Wrong NPI username or password. Not the buyer's fault, so the route answers 502.
        raise RuntimeError("NEPALPAY report: 401, check NEPALPAY_USERNAME and NEPALPAY_PASSWORD")
    body = body if isinstance(body, dict) else {}
    code = str(body.get("responseCode") or "")
    if code == "E010":  # record not found: the QR exists but nobody has paid it yet
        return Outcome(status="not_found")
    if code not in ("200", "000"):
        raise RuntimeError(f"NEPALPAY report failed (HTTP {status}): {body}")

    rows = body.get("responseBody") if isinstance(body.get("responseBody"), list) else []
    # One QR can have several rows: a failed scan, then a good one. RFND rows are refunds, not payments.
    payments = [r for r in rows if isinstance(r, dict) and (r.get("tranType") or "PMT") == "PMT"]
    paid = next((r for r in payments
                 if r.get("debitStatus") == "000" and str(r.get("creditStatus")) in CREDIT_OK), None)
    if paid:
        if paid.get("merchantBillNo") and paid["merchantBillNo"] != attempt_id:
            raise PaymentError("NEPALPAY: the report is for a different bill number")
        # amount is rupees as a number (100.0). A success for any other amount is not this payment.
        try:
            got = round(float(paid.get("amount")) * 100)
        except (TypeError, ValueError, OverflowError):
            got = None
        if got != amount_paisa:
            raise PaymentError(f"NEPALPAY: amount mismatch ({paid.get('amount')})")
        return Outcome(status="paid")
    if any(r.get("debitStatus") == "000" for r in payments):
        # Money left the payer but the credit leg isn't confirmed. Keep asking, never fail it.
        return Outcome(status="pending")
    # Nothing debited: either no scan yet or a failed one. The payer can scan the same QR again,
    # so this is not "failed". The reconcile job expires it after an hour.
    return Outcome(status="not_found")`,
    },
  },
  php: {
    file: "NepalpayGateway.php",
    lang: "php",
    parts: {
      config: `<?php

declare(strict_types=1);

namespace App\\Payments;

// What startQr() hands back. The shared Start type only knows redirects and forms,
// and a QR is neither: the buyer stays on our page and pays from their own app.
final class QrStart
{
    public function __construct(
        public readonly string $qrString, // EMVCo payload, the text inside the QR
        public readonly ?string $qrImage, // the same QR as a base64 PNG, when NCHL sends one
        public readonly string $providerRef, // validationTraceId: the report API needs it
    ) {
    }

    // The page the buyer scans. It polls /pay/status/<attempt> until the payment settles.
    public function qrPage(string $attemptId, string $orderId): string
    {
        $e = fn (string $s): string => htmlspecialchars($s, ENT_QUOTES);
        $qr = $this->qrImage !== null
            ? '<img src="data:image/png;base64,' . $e($this->qrImage) . '" width="280" height="280" alt="NEPALPAY QR code">'
            : '<p>Render this as a QR code:</p><pre>' . $e($this->qrString) . '</pre>';
        // Attempt and order ids are our own [a-z0-9-] values, safe inside the script.
        return <<<HTML
<!doctype html><title>Scan to pay</title>
<h1>Scan with any NEPALPAY QR app, Rs 100</h1>
$qr
<p>Waiting for payment. Keep this page open.</p>
<script>
async function poll() {
  try {
    const res = await fetch("/pay/status/$attemptId");
    if (res.ok) {
      const { status } = await res.json();
      if (status !== "initiated" && status !== "pending") {
        location.href = "/orders/$orderId";
        return;
      }
    }
  } catch {}
  setTimeout(poll, 4000);
}
setTimeout(poll, 4000);
</script>
HTML;
    }
}

// NEPALPAY QR (NCHL). UAT unless NEPALPAY_ENV=production.
final class NepalpayGateway implements Gateway
{
    private \\OpenSSLAsymmetricKey $privateKey;

    public function __construct(
        private string $acquirerId, // 8 digits, your acquiring bank
        private string $merchantId,
        private string $merchantName, // must match the enrolled name
        private string $mcc,
        private string $merchantCity,
        private string $postalCode,
        private string $storeLabel,
        private string $terminalLabel,
        private string $username, // NPI user, also the userId inside the token
        private string $password,
        string $privateKeyPem,
        private string $baseUrl,
    ) {
        // Load the key once, not per request.
        $key = openssl_pkey_get_private($privateKeyPem);
        if ($key === false) {
            throw new \\RuntimeException('NEPALPAY_PRIVATE_KEY_PEM is not a readable private key');
        }
        $this->privateKey = $key;
    }

    public static function fromEnv(): self
    {
        $env = static fn (string $name) => $_ENV[$name] ?? (getenv($name) !== false ? getenv($name) : '');
        $production = $env('NEPALPAY_ENV') === 'production';
        // NEPALPAY_BASE_URL is for a local mock or proxy. Leave it unset to talk to NCHL.
        $baseUrl = $env('NEPALPAY_BASE_URL')
            ?: ($production ? 'https://opennpi.connectips.com' : 'https://devopennpi.connectips.com');
        // There is no shared test merchant: your bank and NCHL issue all of these, for UAT too.
        $acquirerId = $env('NEPALPAY_ACQUIRER_ID');
        $merchantId = $env('NEPALPAY_MERCHANT_ID');
        $merchantName = mb_substr($env('NEPALPAY_MERCHANT_NAME'), 0, 25);
        $mcc = $env('NEPALPAY_MCC');
        $username = $env('NEPALPAY_USERNAME');
        $password = $env('NEPALPAY_PASSWORD');
        // PKCS#8 PEM ("BEGIN PRIVATE KEY") taken out of the NPI .pfx. Env files often hold it with "\\n" escapes.
        $pem = str_replace('\\n', "\\n", $env('NEPALPAY_PRIVATE_KEY_PEM'));
        if ($acquirerId === '' || $merchantId === '' || $merchantName === '' || $mcc === '' || $username === ''
            || $password === '' || $pem === '') {
            throw new \\RuntimeException('Set NEPALPAY_ACQUIRER_ID, NEPALPAY_MERCHANT_ID, NEPALPAY_MERCHANT_NAME, '
                . 'NEPALPAY_MCC, NEPALPAY_USERNAME, NEPALPAY_PASSWORD and NEPALPAY_PRIVATE_KEY_PEM');
        }
        return new self(
            $acquirerId,
            $merchantId,
            $merchantName,
            $mcc,
            $env('NEPALPAY_MERCHANT_CITY') ?: 'Kathmandu',
            $env('NEPALPAY_MERCHANT_POSTAL_CODE') ?: '44600',
            $env('NEPALPAY_STORE_LABEL') ?: 'Store1',
            $env('NEPALPAY_TERMINAL_LABEL') ?: '0',
            $username,
            $password,
            $pem,
            rtrim($baseUrl, '/'),
        );
    }

    // Both API calls are JSON POSTs with Basic auth (NPI username and password).
    // Returns the HTTP status and the decoded body (null when it isn't JSON).
    private function postJson(string $path, array $body): array
    {
        $ch = curl_init($this->baseUrl . $path);
        curl_setopt_array($ch, [
            CURLOPT_POST => true,
            CURLOPT_POSTFIELDS => json_encode($body),
            CURLOPT_HTTPHEADER => ['Content-Type: application/json'],
            CURLOPT_USERPWD => $this->username . ':' . $this->password, // Authorization: Basic base64(user:pass)
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT => 20,
        ]);
        $raw = curl_exec($ch);
        $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        if (!is_string($raw)) {
            throw new \\RuntimeException('NEPALPAY unreachable: ' . curl_error($ch));
        }
        $data = json_decode($raw, true);
        return [$code, is_array($data) ? $data : null, $raw];
    }`,
      sign: `    // base64(RSA-SHA256(private key, message)), the same as \`openssl dgst -sha256 -sign key.pem | base64\`.
    // Pass the text itself: the SHA-256 step is part of the signature, so never hash it first.
    public function rsaSha256Base64(string $message): string
    {
        if (!openssl_sign($message, $signature, $this->privateKey, OPENSSL_ALGO_SHA256)) {
            throw new \\RuntimeException('NEPALPAY: signing failed');
        }
        return base64_encode($signature);
    }

    // The signed string for a dynamic QR: seven values, bare commas, no spaces.
    // 524 is NPR's ISO currency number, and the last value is the NPI username.
    public function tokenString(string $amount, string $billNumber): string
    {
        return implode(',', [$this->acquirerId, $this->merchantId, $this->mcc, '524', $amount, $billNumber, $this->username]);
    }`,
      start: `    // Gateway asks for startPayment(), which ends in a redirect or a form. A QR has neither,
    // so the QR routes call startQr() below. The reconcile job only needs confirmPayment().
    public function startPayment(string $attemptId, int $amountPaisa, string $returnUrl, string $description): Start
    {
        throw new \\LogicException('NEPALPAY QR has no redirect: call startQr()');
    }

    // Asks NCHL for a dynamic QR that carries the amount and our attempt id.
    public function startQr(string $attemptId, int $amountPaisa, string $description): QrStart
    {
        // billNumber takes at most 25 characters. Our attempt ids are 20 hex characters.
        if (preg_match('/^[A-Za-z0-9-]{1,25}$/', $attemptId) !== 1) {
            throw new \\InvalidArgumentException("NEPALPAY billNumber must be 1 to 25 letters, digits or \\"-\\": $attemptId");
        }
        // Rupees with exactly two decimals, formatted once: the token signs this exact text.
        $amount = sprintf('%d.%02d', intdiv($amountPaisa, 100), $amountPaisa % 100);
        $payload = [
            'pointOfInitialization' => 12, // 12 = dynamic QR, one payment of one amount
            'acquirerId' => $this->acquirerId,
            'merchantId' => $this->merchantId,
            'merchantName' => $this->merchantName,
            'merchantCategoryCode' => (int) $this->mcc,
            'merchantCountry' => 'NP',
            'merchantCity' => $this->merchantCity,
            'merchantPostalCode' => $this->postalCode,
            'merchantLanguage' => 'en',
            'transactionCurrency' => 524,
            'transactionAmount' => $amount,
            'valueOfConvenienceFeeFixed' => '0.00',
            'billNumber' => $attemptId, // comes back as merchantBillNo in the report
            'storeLabel' => $this->storeLabel,
            'terminalLabel' => $this->terminalLabel,
            'purposeOfTransaction' => mb_substr($description, 0, 25),
            'qrImage' => true, // also send a base64 PNG, so the page needs no QR library
            'token' => $this->rsaSha256Base64($this->tokenString($amount, $attemptId)),
        ];
        // No return URL anywhere: the buyer pays from their own banking app and never leaves our page.
        [$code, $body, $raw] = $this->postJson('/qr/generateQR', $payload);
        $data = $body['data'] ?? null;
        if (($body['responseCode'] ?? null) !== '000' || !is_array($data)
            || empty($data['qrString']) || empty($data['validationTraceId'])) {
            throw new PaymentError("NEPALPAY generateQR failed: HTTP $code "
                . ($body['responseCode'] ?? '') . ' ' . ($body['responseMessage'] ?? $raw));
        }
        return new QrStart(
            trim((string) $data['qrString']),
            empty($data['qrImage']) ? null : (string) $data['qrImage'],
            (string) $data['validationTraceId'],
        );
    }`,
      confirm: `    // creditStatus values NCHL lists as success. DEFER means settlement to us comes later;
    // for the payment itself it is final.
    private const CREDIT_OK = ['000', '999', 'DEFER'];

    // Called from the status route the QR page polls, and from the reconcile job. Both pass [] as
    // $params: nothing comes back to us from the buyer's app, so there is no callback to read.
    public function confirmPayment(string $attemptId, int $amountPaisa, ?string $providerRef, array $params): Outcome
    {
        // No validationTraceId means generateQR never succeeded, so nobody could have paid.
        if ($providerRef === null || $providerRef === '') {
            return new Outcome('not_found');
        }
        [$code, $body, $raw] = $this->postJson('/nQR/v1/merchanttxnreport', [
            'validationTraceId' => $providerRef,
            'merchantId' => $this->merchantId,
            'acquirerId' => $this->acquirerId,
        ]);
        // 401 means a wrong NPI username or password. Like an outage, that is not the buyer's fault: the route answers 502.
        if ($code === 401) {
            throw new \\RuntimeException('NEPALPAY: 401, check NEPALPAY_USERNAME and NEPALPAY_PASSWORD');
        }
        $responseCode = (string) ($body['responseCode'] ?? '');
        if ($responseCode === 'E010') {
            return new Outcome('not_found'); // record not found: nobody has scanned it yet
        }
        if ($responseCode !== '200' && $responseCode !== '000') {
            throw new \\RuntimeException("NEPALPAY report failed: HTTP $code $raw");
        }

        // One QR can collect several rows: a scan that failed, then a retry that worked.
        // RFND rows are refunds, which never make an attempt paid.
        $rows = is_array($body['responseBody'] ?? null) ? $body['responseBody'] : [];
        $payments = array_values(array_filter($rows, fn ($r) => is_array($r) && ($r['tranType'] ?? 'PMT') === 'PMT'));

        foreach ($payments as $row) {
            if (($row['debitStatus'] ?? null) !== '000' || !in_array((string) ($row['creditStatus'] ?? ''), self::CREDIT_OK, true)) {
                continue;
            }
            // A paid row has to be this attempt, for the amount WE stored.
            if (isset($row['merchantBillNo']) && (string) $row['merchantBillNo'] !== $attemptId) {
                throw new PaymentError('NEPALPAY: report is for a different bill number');
            }
            // amount is rupees as a number (100.0). Compare in paisa.
            if (!is_numeric($row['amount'] ?? null) || (int) round((float) $row['amount'] * 100) !== $amountPaisa) {
                throw new PaymentError('NEPALPAY: amount mismatch (' . json_encode($row['amount'] ?? null) . ')');
            }
            return new Outcome('paid', isset($row['nQrTxnId']) ? (string) $row['nQrTxnId'] : null);
        }

        foreach ($payments as $row) {
            if (($row['debitStatus'] ?? null) === '000') {
                // Money left the payer but the credit isn't confirmed. Keep asking.
                return new Outcome('pending');
            }
        }
        // Nothing debited. A failed scan isn't the end: the payer can scan the same QR again,
        // so leave the attempt open instead of marking it failed.
        return new Outcome('not_found');
    }
}`,
    },
  },
  go: {
    file: "payments/nepalpay.go",
    lang: "go",
    parts: {
      config: `package payments

import (
	"bytes"
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"math"
	"net/http"
	"os"
	"slices"
	"strconv"
	"strings"
	"time"
)

// Nepalpay is the NEPALPAY QR (NCHL) gateway. UAT unless NEPALPAY_ENV=production.
type Nepalpay struct {
	acquirerID, merchantID, merchantName, mcc   string
	city, postalCode, storeLabel, terminalLabel string
	username, password, baseURL                 string
	key                                         *rsa.PrivateKey
	client                                      *http.Client
}

func NewNepalpay() *Nepalpay {
	n := &Nepalpay{
		// All of these come from NCHL when your bank enrols you. There is no public test merchant.
		acquirerID:    os.Getenv("NEPALPAY_ACQUIRER_ID"), // 8 digits, your acquiring bank
		merchantID:    os.Getenv("NEPALPAY_MERCHANT_ID"),
		merchantName:  clip(os.Getenv("NEPALPAY_MERCHANT_NAME"), 25), // must match the enrolled name
		mcc:           os.Getenv("NEPALPAY_MCC"),
		city:          envOr("NEPALPAY_MERCHANT_CITY", "Kathmandu"),
		postalCode:    envOr("NEPALPAY_MERCHANT_POSTAL_CODE", "44600"),
		storeLabel:    envOr("NEPALPAY_STORE_LABEL", "Store1"),
		terminalLabel: envOr("NEPALPAY_TERMINAL_LABEL", "0"),
		username:      os.Getenv("NEPALPAY_USERNAME"), // the NPI user, also signed into every token
		password:      os.Getenv("NEPALPAY_PASSWORD"),
		baseURL:       "https://devopennpi.connectips.com",
		client:        &http.Client{Timeout: 20 * time.Second},
	}
	if os.Getenv("NEPALPAY_ENV") == "production" {
		n.baseURL = "https://opennpi.connectips.com"
	}
	// NEPALPAY_BASE_URL is for a local mock or proxy. Leave it unset to talk to NCHL.
	if u := os.Getenv("NEPALPAY_BASE_URL"); u != "" {
		n.baseURL = strings.TrimRight(u, "/")
	}
	// PKCS#8 PEM ("BEGIN PRIVATE KEY") taken out of the NPI .pfx. Env files often hold it with "\\n" escapes.
	keyPEM := strings.ReplaceAll(os.Getenv("NEPALPAY_PRIVATE_KEY_PEM"), \`\\n\`, "\\n")
	if n.acquirerID == "" || n.merchantID == "" || n.merchantName == "" || n.mcc == "" ||
		n.username == "" || n.password == "" || keyPEM == "" {
		panic("set NEPALPAY_ACQUIRER_ID, NEPALPAY_MERCHANT_ID, NEPALPAY_MERCHANT_NAME, NEPALPAY_MCC, " +
			"NEPALPAY_USERNAME, NEPALPAY_PASSWORD and NEPALPAY_PRIVATE_KEY_PEM")
	}
	// Load the key once, not per request.
	block, _ := pem.Decode([]byte(keyPEM))
	if block == nil || block.Type != "PRIVATE KEY" {
		panic("NEPALPAY_PRIVATE_KEY_PEM must be PKCS#8 (BEGIN PRIVATE KEY): convert it with openssl pkcs8 -topk8")
	}
	parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	key, ok := parsed.(*rsa.PrivateKey)
	if err != nil || !ok {
		panic("NEPALPAY_PRIVATE_KEY_PEM is not an RSA private key")
	}
	n.key = key
	return n
}

// clip cuts text to max characters. NCHL caps names, labels and the purpose at 25.
func clip(text string, max int) string {
	if r := []rune(text); len(r) > max {
		return string(r[:max])
	}
	return text
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

// post sends JSON with Basic auth (the NPI username and password) and decodes the JSON answer.
func (n *Nepalpay) post(ctx context.Context, path string, body any, out any) (int, error) {
	payload, err := json.Marshal(body)
	if err != nil {
		return 0, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, n.baseURL+path, bytes.NewReader(payload))
	if err != nil {
		return 0, err
	}
	req.SetBasicAuth(n.username, n.password)
	req.Header.Set("Content-Type", "application/json")
	res, err := n.client.Do(req)
	if err != nil {
		return 0, fmt.Errorf("NEPALPAY %s failed: %w", path, err)
	}
	defer res.Body.Close()
	if res.StatusCode == http.StatusUnauthorized {
		// Wrong NPI username or password. Not the buyer's fault: the route answers 502.
		return res.StatusCode, errors.New("NEPALPAY: 401, check NEPALPAY_USERNAME and NEPALPAY_PASSWORD")
	}
	if err := json.NewDecoder(res.Body).Decode(out); err != nil {
		return res.StatusCode, fmt.Errorf("NEPALPAY %s: HTTP %s, unreadable body", path, res.Status)
	}
	return res.StatusCode, nil
}`,
      sign: `// RSASHA256Base64 returns base64(RSA-SHA256(private key, message)),
// the same as \`openssl dgst -sha256 -sign key.pem | base64\`.
func (n *Nepalpay) RSASHA256Base64(message string) (string, error) {
	// Go wants the digest, so hash here. Other languages hash inside their sign call; never hash twice.
	digest := sha256.Sum256([]byte(message))
	sig, err := rsa.SignPKCS1v15(rand.Reader, n.key, crypto.SHA256, digest[:])
	if err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(sig), nil
}

// TokenString is what NCHL wants signed for a dynamic QR. Bare commas, no spaces
// (the docs print ", " but every working client sends ","), and 524 is NPR.
func (n *Nepalpay) TokenString(amount, billNumber string) string {
	return strings.Join([]string{n.acquirerID, n.merchantID, n.mcc, "524", amount, billNumber, n.username}, ",")
}`,
      start: `// QrStart is what StartPayment hands back: a QR to show, not a page to send the buyer to.
// The shared Start type only knows redirects and forms, so this module brings its own.
type QrStart struct {
	QRString    string // EMVCo text; render it with any QR library
	QRImage     string // base64 PNG from NCHL, empty if it sent none
	ProviderRef string // validationTraceId: store it, ConfirmPayment needs it
}

// rupees turns paisa into the two-decimal text NCHL wants: 10000 -> "100.00".
func rupees(paisa int64) string {
	return fmt.Sprintf("%d.%02d", paisa/100, paisa%100)
}

// StartPayment asks NCHL for a dynamic QR carrying the amount and the attempt id.
func (n *Nepalpay) StartPayment(ctx context.Context, in StartInput) (QrStart, error) {
	// in.ReturnURL is not used: there is no redirect, the buyer pays from their own banking app.
	mcc, err := strconv.Atoi(n.mcc)
	if err != nil {
		return QrStart{}, fmt.Errorf("NEPALPAY_MCC must be a number: %w", err)
	}
	// billNumber takes at most 25 characters. Our attempt ids are 20 hex characters.
	if len(in.AttemptID) > 25 {
		return QrStart{}, fmt.Errorf("NEPALPAY billNumber is at most 25 characters: %s", in.AttemptID)
	}
	// Format the amount once. The token signs this exact text, so "100.0" in the body would not match.
	amount := rupees(in.AmountPaisa)
	token, err := n.RSASHA256Base64(n.TokenString(amount, in.AttemptID))
	if err != nil {
		return QrStart{}, err
	}
	body := map[string]any{
		"pointOfInitialization":      12, // 12 = dynamic QR, one payment for one amount
		"acquirerId":                 n.acquirerID,
		"merchantId":                 n.merchantID,
		"merchantName":               n.merchantName,
		"merchantCategoryCode":       mcc,
		"merchantCountry":            "NP",
		"merchantCity":               n.city,
		"merchantPostalCode":         n.postalCode,
		"merchantLanguage":           "en",
		"transactionCurrency":        524,
		"transactionAmount":          amount,
		"valueOfConvenienceFeeFixed": "0.00",
		"billNumber":                 in.AttemptID, // comes back as merchantBillNo in the report
		"storeLabel":                 n.storeLabel,
		"terminalLabel":              n.terminalLabel,
		"purposeOfTransaction":       clip(in.Description, 25),
		"qrImage":                    true, // also send a base64 PNG, so the page needs no QR library
		"token":                      token,
	}
	var res struct {
		ResponseCode    string \`json:"responseCode"\`
		ResponseMessage string \`json:"responseMessage"\`
		Data            struct {
			ValidationTraceID string \`json:"validationTraceId"\`
			QRString          string \`json:"qrString"\`
			QRImage           string \`json:"qrImage"\`
		} \`json:"data"\`
	}
	if _, err := n.post(ctx, "/qr/generateQR", body, &res); err != nil {
		return QrStart{}, err
	}
	// E003 INVALID TOKEN, E010 merchant not found, E999: no QR, so no payment can happen.
	if res.ResponseCode != "000" || res.Data.QRString == "" || res.Data.ValidationTraceID == "" {
		return QrStart{}, fmt.Errorf("%w: NEPALPAY generateQR %s %s", ErrPayment, res.ResponseCode, res.ResponseMessage)
	}
	return QrStart{
		QRString:    strings.TrimSpace(res.Data.QRString),
		QRImage:     res.Data.QRImage,
		ProviderRef: res.Data.ValidationTraceID,
	}, nil
}`,
      confirm: `// nepalpayCreditOK lists the creditStatus values NCHL counts as success. DEFER means the
// merchant's settlement comes later; for the payment itself it is final.
var nepalpayCreditOK = []string{"000", "999", "DEFER"}

// text reads a report field as text whatever JSON type NCHL used for it.
func text(row map[string]any, key string) string {
	if v, ok := row[key]; ok && v != nil {
		return fmt.Sprint(v)
	}
	return ""
}

// ConfirmPayment asks the transaction report what happened to the QR. The QR page polls it
// and so does the reconcile job; neither has a callback, so in.Params is never read.
func (n *Nepalpay) ConfirmPayment(ctx context.Context, in ConfirmInput) (Outcome, error) {
	// No validationTraceId means generateQR never succeeded, so nobody could have paid.
	if in.ProviderRef == "" {
		return Outcome{Status: "not_found"}, nil
	}
	body := map[string]string{"validationTraceId": in.ProviderRef, "merchantId": n.merchantID, "acquirerId": n.acquirerID}
	var res struct {
		ResponseCode any              \`json:"responseCode"\`
		ResponseBody []map[string]any \`json:"responseBody"\`
	}
	if _, err := n.post(ctx, "/nQR/v1/merchanttxnreport", body, &res); err != nil {
		return Outcome{}, err
	}
	switch code := fmt.Sprint(res.ResponseCode); code {
	case "E010": // RECORD NOT FOUND: nobody has paid this QR yet
		return Outcome{Status: "not_found"}, nil
	case "200", "000":
	default:
		return Outcome{}, fmt.Errorf("NEPALPAY report failed: responseCode %s", code)
	}

	// One QR can have several rows: a payer whose first scan failed can scan the same QR again.
	// RFND rows are refunds, so only payments (PMT) count.
	debited := false
	for _, row := range res.ResponseBody {
		if t := text(row, "tranType"); t != "" && t != "PMT" {
			continue
		}
		if text(row, "debitStatus") != "000" {
			continue
		}
		if !slices.Contains(nepalpayCreditOK, text(row, "creditStatus")) {
			debited = true
			continue
		}
		// A success for another bill or another amount is not this payment.
		if bill := text(row, "merchantBillNo"); bill != "" && bill != in.AttemptID {
			return Outcome{}, fmt.Errorf("%w: NEPALPAY merchantBillNo %s is not attempt %s", ErrPayment, bill, in.AttemptID)
		}
		// amount is rupees as a JSON number (100.0). Compare in paisa with the amount WE stored.
		paid, err := strconv.ParseFloat(text(row, "amount"), 64)
		if err != nil || int64(math.Round(paid*100)) != in.AmountPaisa {
			return Outcome{}, fmt.Errorf("%w: NEPALPAY amount mismatch (%s)", ErrPayment, text(row, "amount"))
		}
		return Outcome{Status: "paid"}, nil
	}
	if debited {
		// Money left the payer but the credit isn't confirmed. Keep asking; the reconcile job flags it after 3 days.
		return Outcome{Status: "pending"}, nil
	}
	// Nothing debited: no scan yet, or a failed one. Not "failed", because the payer can
	// scan the same QR again. The reconcile job expires it after an hour.
	return Outcome{Status: "not_found"}, nil
}`,
    },
  },
  java: {
    file: "src/main/java/payments/NepalpayGateway.java",
    lang: "java",
    parts: {
      config: `package payments;

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
import java.security.GeneralSecurityException;
import java.security.KeyFactory;
import java.security.PrivateKey;
import java.security.Signature;
import java.security.spec.PKCS8EncodedKeySpec;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

// NEPALPAY QR (NCHL) dynamic QR. UAT unless NEPALPAY_ENV=production.
public final class NepalpayGateway implements Gateway {
    private static final ObjectMapper JSON = new ObjectMapper();
    private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build();
    private final String baseUrl, acquirerId, merchantId, merchantName, mcc, city, postalCode, storeLabel, terminalLabel,
        username, basicAuth;
    private final PrivateKey privateKey;

    private NepalpayGateway(Map<String, String> cfg, PrivateKey privateKey) {
        this.baseUrl = cfg.get("baseUrl");
        this.acquirerId = cfg.get("acquirerId"); // 8 digits: your acquiring bank, e.g. 00002501
        this.merchantId = cfg.get("merchantId");
        this.merchantName = clip(cfg.get("merchantName"), 25); // must match the enrolled name
        this.mcc = cfg.get("mcc");
        this.city = cfg.get("city");
        this.postalCode = cfg.get("postalCode");
        this.storeLabel = cfg.get("storeLabel");
        this.terminalLabel = cfg.get("terminalLabel");
        this.username = cfg.get("username"); // the NPI user, also the userId inside the signed token
        this.basicAuth = "Basic " + Base64.getEncoder()
            .encodeToString((username + ":" + cfg.get("password")).getBytes(StandardCharsets.UTF_8));
        this.privateKey = privateKey;
    }

    public static NepalpayGateway fromEnv() {
        boolean production = "production".equals(System.getenv("NEPALPAY_ENV"));
        Map<String, String> cfg = new LinkedHashMap<>();
        // NEPALPAY_BASE_URL is for a local mock or proxy. Leave it unset to talk to NCHL.
        cfg.put("baseUrl", envOr("NEPALPAY_BASE_URL", production ? "https://opennpi.connectips.com" : "https://devopennpi.connectips.com")
            .replaceAll("/+$", ""));
        // There is no public test merchant: your bank (or businesssupport@nchl.com.np) issues all of these.
        cfg.put("acquirerId", envOr("NEPALPAY_ACQUIRER_ID", ""));
        cfg.put("merchantId", envOr("NEPALPAY_MERCHANT_ID", ""));
        cfg.put("merchantName", envOr("NEPALPAY_MERCHANT_NAME", ""));
        cfg.put("mcc", envOr("NEPALPAY_MCC", ""));
        cfg.put("username", envOr("NEPALPAY_USERNAME", ""));
        cfg.put("password", envOr("NEPALPAY_PASSWORD", ""));
        cfg.put("city", envOr("NEPALPAY_MERCHANT_CITY", "Kathmandu"));
        cfg.put("postalCode", envOr("NEPALPAY_MERCHANT_POSTAL_CODE", "44600"));
        cfg.put("storeLabel", envOr("NEPALPAY_STORE_LABEL", "Store1"));
        cfg.put("terminalLabel", envOr("NEPALPAY_TERMINAL_LABEL", "0"));
        // PKCS#8 PEM ("BEGIN PRIVATE KEY") taken out of the NPI .pfx. Env files often hold it with "\\n" escapes.
        String pem = envOr("NEPALPAY_PRIVATE_KEY_PEM", "").replace("\\\\n", "\\n");
        if (cfg.values().stream().anyMatch(String::isEmpty) || pem.isEmpty()) {
            throw new IllegalStateException("Set NEPALPAY_ACQUIRER_ID, NEPALPAY_MERCHANT_ID, NEPALPAY_MERCHANT_NAME, NEPALPAY_MCC, "
                + "NEPALPAY_USERNAME, NEPALPAY_PASSWORD and NEPALPAY_PRIVATE_KEY_PEM");
        }
        return new NepalpayGateway(cfg, loadKey(pem));
    }

    private static String envOr(String name, String fallback) {
        String value = System.getenv(name);
        return value != null && !value.isEmpty() ? value : fallback;
    }

    private static String clip(String s, int max) {
        return s.length() > max ? s.substring(0, max) : s;
    }

    // Load the key once, not per request. Java reads PKCS#8 only, the DER bytes inside the PEM armour.
    private static PrivateKey loadKey(String pem) {
        if (!pem.contains("-----BEGIN PRIVATE KEY-----")) {
            throw new IllegalStateException("NEPALPAY_PRIVATE_KEY_PEM must be PKCS#8 (BEGIN PRIVATE KEY): convert it with openssl pkcs8 -topk8");
        }
        String body = pem.replaceAll("-----[A-Z ]+-----|\\\\s", "");
        try {
            return KeyFactory.getInstance("RSA").generatePrivate(new PKCS8EncodedKeySpec(Base64.getDecoder().decode(body)));
        } catch (GeneralSecurityException | IllegalArgumentException e) {
            throw new IllegalStateException("NEPALPAY_PRIVATE_KEY_PEM is not an RSA private key", e);
        }
    }`,
      sign: `    // base64(RSA-SHA256(private key, message)), the same as \`openssl dgst -sha256 -sign key.pem | base64\`.
    // Pass the text itself: SHA256withRSA hashes it, so never hash it first.
    public String rsaSha256Base64(String message) {
        try {
            Signature signer = Signature.getInstance("SHA256withRSA");
            signer.initSign(privateKey);
            signer.update(message.getBytes(StandardCharsets.UTF_8));
            return Base64.getEncoder().encodeToString(signer.sign());
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException(e);
        }
    }

    // NCHL signs seven values joined with bare commas. The docs print ", " but every working client uses ",".
    // 524 is NPR's ISO numeric code.
    String tokenString(String transactionAmount, String billNumber) {
        return String.join(",", acquirerId, merchantId, mcc, "524", transactionAmount, billNumber, username);
    }`,
      start: `    // A QR to show on the page. providerRef is NCHL's validationTraceId: store it, confirmPayment needs it.
    // qrImage is a base64 PNG, or null when NCHL sent only the string.
    public record QrStart(String qrString, String qrImage, String providerRef) {}

    // Rupees with exactly two decimals: 10000 paisa is "100.00", never "100" or "100.0".
    static String rupees(long amountPaisa) {
        return BigDecimal.valueOf(amountPaisa, 2).toPlainString();
    }

    private JsonNode post(String path, Map<String, Object> payload, String what) {
        try {
            HttpRequest request = HttpRequest.newBuilder(URI.create(baseUrl + path))
                .timeout(Duration.ofSeconds(20))
                .header("Authorization", basicAuth)
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(JSON.writeValueAsString(payload)))
                .build();
            HttpResponse<String> res = http.send(request, HttpResponse.BodyHandlers.ofString());
            // 401 means a wrong NPI username or password. Not the buyer's fault: the route answers 502.
            if (res.statusCode() == 401) throw new IllegalStateException("NEPALPAY " + what + ": 401, check the NPI username and password");
            JsonNode body = JSON.readTree(res.body());
            if (body == null || !body.isObject()) throw new IllegalStateException("NEPALPAY " + what + ": HTTP " + res.statusCode() + " " + res.body());
            return body;
        } catch (IOException e) {
            throw new IllegalStateException("NEPALPAY " + what + " failed: " + e.getMessage(), e);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("NEPALPAY " + what + " interrupted", e);
        }
    }

    // The shared routes expect a redirect or a form, and NEPALPAY has neither: the QR routes call startQr.
    @Override
    public Start startPayment(String attemptId, long amountPaisa, String returnUrl, String description) {
        throw new UnsupportedOperationException("NEPALPAY QR has no redirect: call startQr");
    }

    public QrStart startQr(String attemptId, long amountPaisa, String description) {
        // billNumber takes at most 25 characters. Our attempt ids are 20 hex characters.
        if (!attemptId.matches("[A-Za-z0-9-]{1,25}")) {
            throw new IllegalArgumentException("NEPALPAY billNumber must be 1 to 25 letters, digits or \\"-\\": " + attemptId);
        }
        // Format the amount once: the same string is signed and sent.
        String amount = rupees(amountPaisa);
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("pointOfInitialization", 12); // 12 = dynamic QR, one payment for this amount
        payload.put("acquirerId", acquirerId);
        payload.put("merchantId", merchantId);
        payload.put("merchantName", merchantName);
        payload.put("merchantCategoryCode", Integer.parseInt(mcc));
        payload.put("merchantCountry", "NP");
        payload.put("merchantCity", city);
        payload.put("merchantPostalCode", postalCode);
        payload.put("merchantLanguage", "en");
        payload.put("transactionCurrency", 524);
        payload.put("transactionAmount", amount);
        payload.put("valueOfConvenienceFeeFixed", "0.00");
        payload.put("billNumber", attemptId); // comes back as merchantBillNo in the report
        payload.put("storeLabel", storeLabel);
        payload.put("terminalLabel", terminalLabel);
        payload.put("purposeOfTransaction", clip(description, 25));
        payload.put("qrImage", true); // ask for a PNG too, so the page needs no QR library
        payload.put("token", rsaSha256Base64(tokenString(amount, attemptId)));
        // No return URL: there is no redirect, the payer pays from their own banking app.
        JsonNode body = post("/qr/generateQR", payload, "generateQR");
        JsonNode data = body.path("data");
        String qrString = data.path("qrString").asText("").trim();
        String traceId = data.path("validationTraceId").asText("");
        if (!"000".equals(body.path("responseCode").asText()) || qrString.isEmpty() || traceId.isEmpty()) {
            throw new PaymentException("NEPALPAY generateQR refused: " + body.path("responseCode").asText("?") + " "
                + body.path("responseMessage").asText(""));
        }
        String image = data.path("qrImage").asText("");
        return new QrStart(qrString, image.isEmpty() ? null : image, traceId);
    }`,
      confirm: `    // creditStatus values NCHL lists as success. DEFER means settlement to you comes later; the payment is done.
    private static final Set<String> CREDIT_OK = Set.of("000", "999", "DEFER");

    // Called from the status route the QR page polls, and from the reconcile job. NEPALPAY sends nothing
    // to the browser, so params is always empty and the transaction report is the only answer.
    @Override
    public Outcome confirmPayment(String attemptId, long amountPaisa, String providerRef, Map<String, String> params) {
        // No validationTraceId means generateQR never succeeded, so nobody could have paid.
        if (providerRef == null || providerRef.isEmpty()) return new Outcome("not_found", null);

        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("validationTraceId", providerRef);
        payload.put("merchantId", merchantId);
        payload.put("acquirerId", acquirerId);
        JsonNode body = post("/nQR/v1/merchanttxnreport", payload, "merchanttxnreport");
        String code = body.path("responseCode").asText("");
        if (code.equals("E010")) return new Outcome("not_found", null); // record not found
        if (!code.equals("200") && !code.equals("000")) {
            throw new IllegalStateException("NEPALPAY merchanttxnreport failed: " + body);
        }

        // One QR can have several rows: a failed scan, then a good one. RFND rows are refunds, not payments.
        List<JsonNode> rows = new ArrayList<>();
        for (JsonNode row : body.path("responseBody")) {
            String type = row.path("tranType").asText("PMT");
            if (type.equals("PMT")) rows.add(row);
        }
        for (JsonNode row : rows) {
            if (!row.path("debitStatus").asText().equals("000") || !CREDIT_OK.contains(row.path("creditStatus").asText())) continue;
            // merchantBillNo is the billNumber we sent, the attempt id.
            String billNo = row.path("merchantBillNo").asText("");
            if (!billNo.isEmpty() && !billNo.equals(attemptId)) {
                throw new PaymentException("NEPALPAY: report row is for a different payment (" + billNo + ")");
            }
            // amount is rupees as a JSON number (100.0). Compare in paisa with the amount WE stored.
            JsonNode paid = row.path("amount");
            long paidPaisa;
            try {
                paidPaisa = new BigDecimal(paid.asText()).movePointRight(2).setScale(0, RoundingMode.HALF_UP).longValueExact();
            } catch (NumberFormatException | ArithmeticException e) {
                throw new PaymentException("NEPALPAY: unreadable amount (" + paid + ")");
            }
            if (paidPaisa != amountPaisa) throw new PaymentException("NEPALPAY: amount mismatch (" + paid + ")");
            return new Outcome("paid", null);
        }
        // Debited but the credit isn't confirmed: money left the payer, so keep asking.
        for (JsonNode row : rows) {
            if (row.path("debitStatus").asText().equals("000")) return new Outcome("pending", null);
        }
        // Nothing debited. A failed scan doesn't close the QR (the payer can scan it again), so not failed.
        return new Outcome("not_found", null);
    }
}`,
    },
  },
  kotlin: {
    file: "src/main/kotlin/payments/NepalpayGateway.kt",
    lang: "kotlin",
    parts: {
      config: `package payments

import java.math.BigDecimal
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.security.KeyFactory
import java.security.PrivateKey
import java.security.Signature
import java.security.spec.PKCS8EncodedKeySpec
import java.time.Duration
import java.util.Base64
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

// What startPayment hands back for NEPALPAY: a QR to show, not a redirect or a form.
// It sits in the same package as Start, so it can join that sealed family.
// providerRef is NCHL's validationTraceId: store it, confirmPayment looks the payment up with it.
data class QrStart(val qrString: String, val qrImage: String?, override val providerRef: String) : Start

// NEPALPAY QR (NCHL). UAT unless NEPALPAY_ENV=production.
class NepalpayGateway(
    private val acquirerId: String,
    private val merchantId: String,
    private val merchantName: String,
    private val mcc: String,
    private val merchantCity: String,
    private val postalCode: String,
    private val storeLabel: String,
    private val terminalLabel: String,
    private val username: String, // the NPI user: Basic auth, and the userId inside the token
    private val password: String,
    private val privateKey: PrivateKey,
    private val baseUrl: String,
) : Gateway {
    private val http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build()
    private val auth = "Basic " + Base64.getEncoder().encodeToString("$username:$password".toByteArray())

    companion object {
        fun fromEnv(): NepalpayGateway {
            fun env(name: String) = System.getenv(name).orEmpty()
            val production = env("NEPALPAY_ENV") == "production"
            // NEPALPAY_BASE_URL is for a local mock or proxy. Leave it unset to talk to NCHL.
            val baseUrl = env("NEPALPAY_BASE_URL").ifEmpty {
                if (production) "https://opennpi.connectips.com" else "https://devopennpi.connectips.com"
            }
            // There is no public test merchant: your bank or NCHL issues all of these, for UAT too.
            val required = listOf(
                "NEPALPAY_ACQUIRER_ID", "NEPALPAY_MERCHANT_ID", "NEPALPAY_MERCHANT_NAME", "NEPALPAY_MCC",
                "NEPALPAY_USERNAME", "NEPALPAY_PASSWORD", "NEPALPAY_PRIVATE_KEY_PEM",
            )
            check(required.all { env(it).isNotEmpty() }) { "Set " + required.joinToString(", ") }
            // PKCS#8 PEM ("BEGIN PRIVATE KEY") taken out of the NPI .pfx. Env files often hold it with "\\n" escapes.
            val pem = env("NEPALPAY_PRIVATE_KEY_PEM").replace("\\\\n", "\\n")
            return NepalpayGateway(
                acquirerId = env("NEPALPAY_ACQUIRER_ID"), // 8 digits, your acquiring bank
                merchantId = env("NEPALPAY_MERCHANT_ID"),
                merchantName = env("NEPALPAY_MERCHANT_NAME").take(25), // must match the enrolled name
                mcc = env("NEPALPAY_MCC"),
                merchantCity = env("NEPALPAY_MERCHANT_CITY").ifEmpty { "Kathmandu" },
                postalCode = env("NEPALPAY_MERCHANT_POSTAL_CODE").ifEmpty { "44600" },
                storeLabel = env("NEPALPAY_STORE_LABEL").ifEmpty { "Store1" },
                terminalLabel = env("NEPALPAY_TERMINAL_LABEL").ifEmpty { "0" },
                username = env("NEPALPAY_USERNAME"),
                password = env("NEPALPAY_PASSWORD"),
                privateKey = loadKey(pem),
                baseUrl = baseUrl.trimEnd('/'),
            )
        }

        // Load the key once, not per request. The JVM reads PKCS#8 only, the DER bytes inside the PEM armour.
        private fun loadKey(pem: String): PrivateKey {
            check("-----BEGIN PRIVATE KEY-----" in pem) {
                "NEPALPAY_PRIVATE_KEY_PEM must be PKCS#8 (BEGIN PRIVATE KEY): convert it with openssl pkcs8 -topk8"
            }
            val der = Base64.getDecoder().decode(pem.replace(Regex("-----[A-Z ]+-----|\\\\s"), ""))
            return KeyFactory.getInstance("RSA").generatePrivate(PKCS8EncodedKeySpec(der))
        }
    }

    // One JSON POST with Basic auth. Returns the HTTP status and the parsed body (null if it isn't a JSON object).
    private suspend fun post(path: String, payload: JsonObject): Pair<Int, JsonObject?> {
        val request = HttpRequest.newBuilder(URI.create("$baseUrl$path"))
            .timeout(Duration.ofSeconds(20))
            .header("Authorization", auth)
            .header("Content-Type", "application/json")
            .POST(HttpRequest.BodyPublishers.ofString(payload.toString()))
            .build()
        val res = withContext(Dispatchers.IO) { http.send(request, HttpResponse.BodyHandlers.ofString()) }
        return res.statusCode() to runCatching { Json.parseToJsonElement(res.body()) as JsonObject }.getOrNull()
    }

    // A JSON value as text: "000" and 0 both come back as their text, null and objects as null.
    private fun JsonElement?.text(): String? = (this as? JsonPrimitive)?.takeIf { it !is JsonNull }?.content`,
      sign: `    // base64(RSA-SHA256(private key, message)), the same as \`openssl dgst -sha256 -sign key.pem | base64\`.
    // Pass the text itself: SHA256withRSA hashes it, so never hash it first.
    fun rsaSha256Base64(message: String): String {
        val signer = Signature.getInstance("SHA256withRSA")
        signer.initSign(privateKey)
        signer.update(message.toByteArray())
        return Base64.getEncoder().encodeToString(signer.sign())
    }

    // The values NCHL signs for a dynamic QR, in this order, joined by bare commas (no spaces).
    // 524 is NPR's ISO currency number. userId is the NPI username.
    fun tokenString(transactionAmount: String, billNumber: String): String =
        listOf(acquirerId, merchantId, mcc, "524", transactionAmount, billNumber, username).joinToString(",")`,
      start: `    // Paisa to rupees with exactly two decimals: 10000 -> "100.00". Formatted once, then used in the token AND the body.
    private fun rupees(paisa: Long): String = BigDecimal.valueOf(paisa, 2).toPlainString()

    // Asks NCHL for a dynamic QR that carries the amount and the attempt id.
    override suspend fun startPayment(attemptId: String, amountPaisa: Long, returnUrl: String, description: String): QrStart {
        // billNumber takes at most 25 characters. Our attempt ids are exactly 20 hex characters.
        require(Regex("[A-Za-z0-9-]{1,25}").matches(attemptId)) { "NEPALPAY billNumber must be 1 to 25 letters, digits or \\"-\\"" }
        // returnUrl is not used: there is no redirect. The payer scans the QR and pays from their own banking app.
        val amount = rupees(amountPaisa)
        val payload = buildJsonObject {
            put("pointOfInitialization", 12) // 12 = dynamic QR (11 is static)
            put("acquirerId", acquirerId)
            put("merchantId", merchantId)
            put("merchantName", merchantName)
            put("merchantCategoryCode", mcc.toInt())
            put("merchantCountry", "NP")
            put("merchantCity", merchantCity)
            put("merchantPostalCode", postalCode)
            put("merchantLanguage", "en")
            put("transactionCurrency", 524)
            put("transactionAmount", amount)
            put("valueOfConvenienceFeeFixed", "0.00")
            put("billNumber", attemptId) // comes back as merchantBillNo in the report
            put("storeLabel", storeLabel)
            put("terminalLabel", terminalLabel)
            put("purposeOfTransaction", description.take(25))
            put("qrImage", true) // also return a base64 PNG, so the page needs no QR library
            put("token", rsaSha256Base64(tokenString(amount, attemptId)))
        }
        val (status, body) = post("/qr/generateQR", payload)
        val data = body?.get("data") as? JsonObject
        val qrString = data?.get("qrString").text()
        val traceId = data?.get("validationTraceId").text()
        if (data == null || body?.get("responseCode").text() != "000" || qrString == null || traceId == null) {
            // E003 INVALID TOKEN, E010 merchant not found, 400 with fieldErrors, ...
            throw PaymentException(
                "NEPALPAY generateQR failed: HTTP $status \${body?.get("responseCode").text()} \${body?.get("responseMessage").text()}",
            )
        }
        return QrStart(qrString.trim(), data["qrImage"].text(), providerRef = traceId)
    }`,
      confirm: `    // Called by the status route the QR page polls, and by the reconcile job. NEPALPAY sends nothing to a
    // return URL, so params is always empty here: the transaction report is the only answer.
    override suspend fun confirmPayment(attemptId: String, amountPaisa: Long, providerRef: String?, params: Map<String, String>): Outcome {
        // No validationTraceId means generateQR never succeeded, so nobody could have paid.
        if (providerRef == null) return Outcome("not_found")

        val (status, body) = post("/nQR/v1/merchanttxnreport", buildJsonObject {
            put("validationTraceId", providerRef)
            put("merchantId", merchantId)
            put("acquirerId", acquirerId)
        })
        // 401 means a wrong NPI username or password. That is not the buyer's fault: the route answers 502.
        if (status == 401) throw IllegalStateException("NEPALPAY report: 401, check NEPALPAY_USERNAME and NEPALPAY_PASSWORD")
        val code = body?.get("responseCode").text()
        if (code == "E010") return Outcome("not_found") // record not found: nobody has paid this QR yet
        if (body == null || (code != "200" && code != "000")) {
            throw IllegalStateException("NEPALPAY report failed: HTTP $status $code")
        }

        // One QR can have several rows: a failed scan, then a successful one on the same QR.
        // RFND rows are refunds the bank starts; only payments (PMT) count here.
        val rows = (body["responseBody"] as? JsonArray).orEmpty().filterIsInstance<JsonObject>()
            .filter { (it["tranType"].text() ?: "PMT") == "PMT" }
        val paid = rows.firstOrNull { it["debitStatus"].text() == "000" && it["creditStatus"].text() in setOf("000", "999", "DEFER") }
        if (paid != null) {
            // The row must be for this attempt, and for the amount WE stored. amount is rupees (100.0).
            val billNo = paid["merchantBillNo"].text()
            if (billNo != null && billNo != attemptId) throw PaymentException("NEPALPAY: report is for bill $billNo")
            val paidPaisa = paid["amount"].text()?.toBigDecimalOrNull()?.movePointRight(2)?.setScale(0, java.math.RoundingMode.HALF_UP)?.toLong()
            if (paidPaisa != amountPaisa) throw PaymentException("NEPALPAY: amount mismatch (\${paid["amount"]})")
            return Outcome("paid")
        }
        // Debited but the credit isn't confirmed: money left the payer, so keep asking.
        if (rows.any { it["debitStatus"].text() == "000" }) return Outcome("pending")
        // Nothing debited. A failed scan is not a failed payment: the payer can scan the same QR again,
        // so don't return failed. The reconcile job expires the attempt after an hour.
        return Outcome("not_found")
    }
}`,
    },
  },
};

export const qrRoutes: Record<string, Block[]> = {
  express: [
    { file: "qr-page.ts", lang: "ts", code: `import { escapeHtml } from "./payments";
import type { QrStart } from "./nepalpay";

// The page the buyer scans from. It polls our status route until the attempt
// leaves initiated/pending, then goes to the order page.
export function qrPage(qr: QrStart, attemptId: string, orderId: string): string {
  const code = qr.qrImage
    ? \`<img src="data:image/png;base64,\${escapeHtml(qr.qrImage)}" width="280" height="280" alt="NEPALPAY QR code">\`
    : \`<p>Render this as a QR code:</p><pre>\${escapeHtml(qr.qrString)}</pre>\`;
  return \`<!doctype html><title>Scan to pay</title>
<h1>Scan with any NEPALPAY QR app, Rs 100</h1>
\${code}
<p>Waiting for payment. Keep this page open.</p>
<script>
async function poll() {
  try {
    const res = await fetch("/pay/status/\${attemptId}");
    if (res.ok) {
      const { status } = await res.json();
      if (status !== "initiated" && status !== "pending") {
        location.href = "/orders/\${orderId}";
        return;
      }
    }
  } catch {}
  setTimeout(poll, 4000);
}
setTimeout(poll, 4000);
</script>\`;
}` },
    { file: "server.ts", lang: "ts", code: `import express from "express";
import * as gateway from "./nepalpay";
import { PaymentError, settle } from "./payments";
import { qrPage } from "./qr-page";
import { startReconcileLoop } from "./reconcile";
import { createAttempt, getAttempt, getOrder, latestAttempt, setProviderRef } from "./store";

const PORT = Number(process.env.PORT ?? 3000);
const app = express();

app.get("/", (_req, res) => {
  res.send(\`<!doctype html><title>Shop</title>
<h1>Order demo, Rs 100</h1>
<form method="post" action="/pay/demo"><button>Pay with NEPALPAY QR</button></form>\`);
});

app.post("/pay/:orderId", async (req, res) => {
  const order = getOrder(req.params.orderId);
  if (!order) return void res.status(404).send("Order not found");
  const attempt = createAttempt(order.id, order.amountPaisa);
  const qr = await gateway.startPayment({
    attemptId: attempt.id,
    amountPaisa: attempt.amountPaisa,
    returnUrl: "", // no redirect: the buyer pays from their own banking app
    description: \`Order \${order.id}\`,
  });
  // validationTraceId: the only key the report accepts. Save it before showing the QR.
  setProviderRef(attempt.id, qr.providerRef);
  res.send(qrPage(qr, attempt.id, order.id));
});

// Polled by the QR page every few seconds. Asks NCHL only while the attempt is open.
app.get("/pay/status/:attemptId", async (req, res) => {
  const attempt = getAttempt(req.params.attemptId);
  if (!attempt) return void res.status(404).json({ error: "Payment not found" });
  if (attempt.status === "initiated" || attempt.status === "pending") {
    try {
      const outcome = await gateway.confirmPayment({
        attemptId: attempt.id,
        amountPaisa: attempt.amountPaisa,
        providerRef: attempt.providerRef,
        params: {},
      });
      settle(attempt, outcome);
    } catch (err) {
      if (err instanceof PaymentError) return void res.status(400).json({ error: "Payment could not be verified" });
      console.error(err);
      return void res.status(502).json({ error: "Payment gateway error" });
    }
  }
  res.json({ status: getAttempt(attempt.id)!.status });
});

app.get("/orders/:orderId", (req, res) => {
  const attempt = latestAttempt(req.params.orderId);
  res.type("text").send(\`Order \${req.params.orderId}: \${attempt ? attempt.status : "no payment yet"}\`);
});

startReconcileLoop(gateway);
app.listen(PORT, () => console.log(\`listening on http://localhost:\${PORT}\`));` },
  ],
  hono: [
    { file: "qr-page.ts", lang: "ts", code: `import { escapeHtml } from "./payments";
import type { QrStart } from "./nepalpay";

// The page the buyer scans from. It polls our status route until the attempt
// leaves initiated/pending, then goes to the order page.
export function qrPage(qr: QrStart, attemptId: string, orderId: string): string {
  const code = qr.qrImage
    ? \`<img src="data:image/png;base64,\${escapeHtml(qr.qrImage)}" width="280" height="280" alt="NEPALPAY QR code">\`
    : \`<p>Render this as a QR code:</p><pre>\${escapeHtml(qr.qrString)}</pre>\`;
  return \`<!doctype html><title>Scan to pay</title>
<h1>Scan with any NEPALPAY QR app, Rs 100</h1>
\${code}
<p>Waiting for payment. Keep this page open.</p>
<script>
async function poll() {
  try {
    const res = await fetch("/pay/status/\${attemptId}");
    if (res.ok) {
      const { status } = await res.json();
      if (status !== "initiated" && status !== "pending") {
        location.href = "/orders/\${orderId}";
        return;
      }
    }
  } catch {}
  setTimeout(poll, 4000);
}
setTimeout(poll, 4000);
</script>\`;
}` },
    { file: "server.ts", lang: "ts", code: `import { serve } from "@hono/node-server";
import { Hono } from "hono";
import * as gateway from "./nepalpay";
import { PaymentError, settle } from "./payments";
import { qrPage } from "./qr-page";
import { startReconcileLoop } from "./reconcile";
import { createAttempt, getAttempt, getOrder, latestAttempt, setProviderRef } from "./store";

const PORT = Number(process.env.PORT ?? 3000);
const app = new Hono();

app.get("/", (c) =>
  c.html(\`<!doctype html><title>Shop</title>
<h1>Order demo, Rs 100</h1>
<form method="post" action="/pay/demo"><button>Pay with NEPALPAY QR</button></form>\`),
);

app.post("/pay/:orderId", async (c) => {
  const order = getOrder(c.req.param("orderId"));
  if (!order) return c.text("Order not found", 404);
  const attempt = createAttempt(order.id, order.amountPaisa);
  const qr = await gateway.startPayment({
    attemptId: attempt.id,
    amountPaisa: attempt.amountPaisa,
    returnUrl: "", // no redirect: the buyer pays from their own banking app
    description: \`Order \${order.id}\`,
  });
  // validationTraceId: the only key the report accepts. Save it before showing the QR.
  setProviderRef(attempt.id, qr.providerRef);
  return c.html(qrPage(qr, attempt.id, order.id));
});

// Polled by the QR page every few seconds. Asks NCHL only while the attempt is open.
app.get("/pay/status/:attemptId", async (c) => {
  const attempt = getAttempt(c.req.param("attemptId"));
  if (!attempt) return c.json({ error: "Payment not found" }, 404);
  if (attempt.status === "initiated" || attempt.status === "pending") {
    try {
      const outcome = await gateway.confirmPayment({
        attemptId: attempt.id,
        amountPaisa: attempt.amountPaisa,
        providerRef: attempt.providerRef,
        params: {},
      });
      settle(attempt, outcome);
    } catch (err) {
      if (err instanceof PaymentError) return c.json({ error: "Payment could not be verified" }, 400);
      console.error(err);
      return c.json({ error: "Payment gateway error" }, 502);
    }
  }
  return c.json({ status: getAttempt(attempt.id)!.status });
});

app.get("/orders/:orderId", (c) => {
  const attempt = latestAttempt(c.req.param("orderId"));
  return c.text(\`Order \${c.req.param("orderId")}: \${attempt ? attempt.status : "no payment yet"}\`);
});

startReconcileLoop(gateway);
serve({ fetch: app.fetch, port: PORT }, () => console.log(\`listening on http://localhost:\${PORT}\`));` },
  ],
  nextjs: [
    { file: "app/page.tsx", lang: "tsx", code: `// GET /  Replaces the starter page from create-next-app.
export default function Home() {
  return (
    <main>
      <h1>Order demo, Rs 100</h1>
      <form method="post" action="/pay/demo">
        <button>Pay with NEPALPAY QR</button>
      </form>
    </main>
  );
}` },
    { file: "qr-page.ts", lang: "ts", code: `import { escapeHtml } from "./payments";
import type { QrStart } from "./nepalpay";

// The page the buyer scans from. It polls our status route until the attempt
// leaves initiated/pending, then goes to the order page.
export function qrPage(qr: QrStart, attemptId: string, orderId: string): string {
  const code = qr.qrImage
    ? \`<img src="data:image/png;base64,\${escapeHtml(qr.qrImage)}" width="280" height="280" alt="NEPALPAY QR code">\`
    : \`<p>Render this as a QR code:</p><pre>\${escapeHtml(qr.qrString)}</pre>\`;
  return \`<!doctype html><title>Scan to pay</title>
<h1>Scan with any NEPALPAY QR app, Rs 100</h1>
\${code}
<p>Waiting for payment. Keep this page open.</p>
<script>
async function poll() {
  try {
    const res = await fetch("/pay/status/\${attemptId}");
    if (res.ok) {
      const { status } = await res.json();
      if (status !== "initiated" && status !== "pending") {
        location.href = "/orders/\${orderId}";
        return;
      }
    }
  } catch {}
  setTimeout(poll, 4000);
}
setTimeout(poll, 4000);
</script>\`;
}` },
    { file: "app/pay/[orderId]/route.ts", lang: "ts", code: `// POST /pay/:orderId
import * as gateway from "@/nepalpay";
import { qrPage } from "@/qr-page";
import { createAttempt, getOrder, setProviderRef } from "@/store";

export async function POST(_req: Request, { params }: { params: Promise<{ orderId: string }> }) {
  const order = getOrder((await params).orderId);
  if (!order) return new Response("Order not found", { status: 404 });
  const attempt = createAttempt(order.id, order.amountPaisa);
  const qr = await gateway.startPayment({
    attemptId: attempt.id,
    amountPaisa: attempt.amountPaisa,
    returnUrl: "", // no redirect: the buyer pays from their own banking app
    description: \`Order \${order.id}\`,
  });
  // validationTraceId: the only key the report accepts. Save it before showing the QR.
  setProviderRef(attempt.id, qr.providerRef);
  return new Response(qrPage(qr, attempt.id, order.id), {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}` },
    { file: "app/pay/status/[attemptId]/route.ts", lang: "ts", code: `// GET /pay/status/:attemptId, polled by the QR page every few seconds.
// Asks NCHL only while the attempt is open.
import * as gateway from "@/nepalpay";
import { PaymentError, settle } from "@/payments";
import { getAttempt } from "@/store";

export async function GET(_req: Request, { params }: { params: Promise<{ attemptId: string }> }) {
  const attempt = getAttempt((await params).attemptId);
  if (!attempt) return Response.json({ error: "Payment not found" }, { status: 404 });
  if (attempt.status === "initiated" || attempt.status === "pending") {
    try {
      const outcome = await gateway.confirmPayment({
        attemptId: attempt.id,
        amountPaisa: attempt.amountPaisa,
        providerRef: attempt.providerRef,
        params: {},
      });
      settle(attempt, outcome);
    } catch (err) {
      if (err instanceof PaymentError) return Response.json({ error: "Payment could not be verified" }, { status: 400 });
      console.error(err);
      return Response.json({ error: "Payment gateway error" }, { status: 502 });
    }
  }
  return Response.json({ status: getAttempt(attempt.id)!.status });
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
    const gateway = await import("./nepalpay");
    const { startReconcileLoop } = await import("./reconcile");
    startReconcileLoop(gateway);
  }
}` },
  ],
  fastify: [
    { file: "qr-page.ts", lang: "ts", code: `import { escapeHtml } from "./payments";
import type { QrStart } from "./nepalpay";

// The page the buyer scans from. It polls our status route until the attempt
// leaves initiated/pending, then goes to the order page.
export function qrPage(qr: QrStart, attemptId: string, orderId: string): string {
  const code = qr.qrImage
    ? \`<img src="data:image/png;base64,\${escapeHtml(qr.qrImage)}" width="280" height="280" alt="NEPALPAY QR code">\`
    : \`<p>Render this as a QR code:</p><pre>\${escapeHtml(qr.qrString)}</pre>\`;
  return \`<!doctype html><title>Scan to pay</title>
<h1>Scan with any NEPALPAY QR app, Rs 100</h1>
\${code}
<p>Waiting for payment. Keep this page open.</p>
<script>
async function poll() {
  try {
    const res = await fetch("/pay/status/\${attemptId}");
    if (res.ok) {
      const { status } = await res.json();
      if (status !== "initiated" && status !== "pending") {
        location.href = "/orders/\${orderId}";
        return;
      }
    }
  } catch {}
  setTimeout(poll, 4000);
}
setTimeout(poll, 4000);
</script>\`;
}` },
    { file: "server.ts", lang: "ts", code: `import Fastify from "fastify";
import * as gateway from "./nepalpay";
import { PaymentError, settle } from "./payments";
import { qrPage } from "./qr-page";
import { startReconcileLoop } from "./reconcile";
import { createAttempt, getAttempt, getOrder, latestAttempt, setProviderRef } from "./store";

const PORT = Number(process.env.PORT ?? 3000);
const app = Fastify();

// Fastify parses JSON only. Our Pay button posts a form, so parse those too.
app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_req, body, done) => {
  done(null, Object.fromEntries(new URLSearchParams(body as string)));
});

app.get("/", async (_req, reply) =>
  reply.type("text/html").send(\`<!doctype html><title>Shop</title>
<h1>Order demo, Rs 100</h1>
<form method="post" action="/pay/demo"><button>Pay with NEPALPAY QR</button></form>\`),
);

app.post<{ Params: { orderId: string } }>("/pay/:orderId", async (req, reply) => {
  const order = getOrder(req.params.orderId);
  if (!order) return reply.code(404).send("Order not found");
  const attempt = createAttempt(order.id, order.amountPaisa);
  const qr = await gateway.startPayment({
    attemptId: attempt.id,
    amountPaisa: attempt.amountPaisa,
    returnUrl: "", // no redirect: the buyer pays from their own banking app
    description: \`Order \${order.id}\`,
  });
  // validationTraceId: the only key the report accepts. Save it before showing the QR.
  setProviderRef(attempt.id, qr.providerRef);
  return reply.type("text/html").send(qrPage(qr, attempt.id, order.id));
});

// Polled by the QR page every few seconds. Asks NCHL only while the attempt is open.
app.get<{ Params: { attemptId: string } }>("/pay/status/:attemptId", async (req, reply) => {
  const attempt = getAttempt(req.params.attemptId);
  if (!attempt) return reply.code(404).send({ error: "Payment not found" });
  if (attempt.status === "initiated" || attempt.status === "pending") {
    try {
      const outcome = await gateway.confirmPayment({
        attemptId: attempt.id,
        amountPaisa: attempt.amountPaisa,
        providerRef: attempt.providerRef,
        params: {},
      });
      settle(attempt, outcome);
    } catch (err) {
      if (err instanceof PaymentError) return reply.code(400).send({ error: "Payment could not be verified" });
      req.log.error(err);
      return reply.code(502).send({ error: "Payment gateway error" });
    }
  }
  return reply.send({ status: getAttempt(attempt.id)!.status });
});

app.get<{ Params: { orderId: string } }>("/orders/:orderId", async (req, reply) => {
  const attempt = latestAttempt(req.params.orderId);
  return reply.type("text/plain").send(\`Order \${req.params.orderId}: \${attempt ? attempt.status : "no payment yet"}\`);
});

startReconcileLoop(gateway);
app.listen({ port: PORT }).then(() => console.log(\`listening on http://localhost:\${PORT}\`));` },
  ],
  django: [
    { file: "shop/urls.py", lang: "python", code: `from django.urls import path

import nepalpay as gateway
from reconcile import start_reconcile_loop

from . import views

urlpatterns = [
    path("", views.home),
    path("pay/<str:order_id>", views.pay),
    path("pay/status/<str:attempt_id>", views.payment_status),
    path("orders/<str:order_id>", views.order_status),
]

# Django loads this module once per server process, a fine place to start it.
start_reconcile_loop(gateway)` },
    { file: "shop/views.py", lang: "python", code: `import logging
from html import escape

from django.http import HttpResponse, JsonResponse
from django.middleware.csrf import get_token
from django.views.decorators.http import require_GET, require_POST

import nepalpay as gateway
import store
from payments import PaymentError, settle

QR_PAGE = """<!doctype html><title>Scan to pay</title>
<h1>Scan with any NEPALPAY QR app, Rs 100</h1>
QR_CODE
<p>Waiting for payment. Keep this page open.</p>
<script>
async function poll() {
  try {
    const res = await fetch("/pay/status/ATTEMPT");
    if (res.ok) {
      const { status } = await res.json();
      if (status !== "initiated" && status !== "pending") {
        location.href = "/orders/ORDER";
        return;
      }
    }
  } catch {}
  setTimeout(poll, 4000);
}
setTimeout(poll, 4000);
</script>"""


def qr_page(attempt, start) -> str:
    """The QR plus a script that asks /pay/status every 4 seconds until the payment settles."""
    if start.qr_image:
        code = f'<img src="data:image/png;base64,{escape(start.qr_image)}" width="280" height="280" alt="NEPALPAY QR code">'
    else:
        code = f"<p>Render this as a QR code:</p><pre>{escape(start.qr_string)}</pre>"
    # Plain replace, not an f-string: the script's own braces would need doubling.
    # The QR goes in last, so nothing inside it is mistaken for a placeholder.
    page = QR_PAGE.replace("ATTEMPT", attempt.id).replace("ORDER", attempt.order_id)
    return page.replace("QR_CODE", code)


@require_GET
def home(request):
    # Our own form posts to /pay/demo, so it carries Django's CSRF token.
    return HttpResponse(f"""<!doctype html><title>Shop</title>
<h1>Order demo, Rs 100</h1>
<form method="post" action="/pay/demo">
<input type="hidden" name="csrfmiddlewaretoken" value="{get_token(request)}">
<button>Pay with NEPALPAY QR</button>
</form>""")


@require_POST
def pay(request, order_id: str):
    order = store.get_order(order_id)
    if order is None:
        return HttpResponse("Order not found", status=404)
    attempt = store.create_attempt(order.id, order.amount_paisa)
    # No return URL: the buyer stays on our page and pays from their banking app.
    start = gateway.start_payment(attempt.id, attempt.amount_paisa, "", f"Order {order.id}")
    # The validationTraceId is the only handle on this QR. Store it before showing the code.
    store.set_provider_ref(attempt.id, start.provider_ref)
    return HttpResponse(qr_page(attempt, start))


# The QR page polls this. Only our own page calls it, with GET, so CSRF doesn't apply.
@require_GET
def payment_status(request, attempt_id: str):
    attempt = store.get_attempt(attempt_id)
    if attempt is None:
        return JsonResponse({"error": "Payment not found"}, status=404)
    if attempt.status in ("initiated", "pending"):
        try:
            outcome = gateway.confirm_payment(attempt.id, attempt.amount_paisa, attempt.provider_ref, {})
        except PaymentError as e:
            return JsonResponse({"error": str(e)}, status=400)
        except Exception:
            logging.exception("confirm_payment failed")
            return JsonResponse({"error": "Payment gateway error, try again shortly"}, status=502)
        settle(attempt, outcome)
    # Read the status again: settle() may have just moved it.
    return JsonResponse({"status": store.get_attempt(attempt_id).status})


@require_GET
def order_status(request, order_id: str):
    attempt = store.latest_attempt(order_id)
    status = attempt.status if attempt else "no payment yet"
    return HttpResponse(f"Order {order_id}: {status}", content_type="text/plain")` },
  ],
  fastapi: [
    { file: "main.py", lang: "python", code: `import logging
from html import escape

from fastapi import FastAPI
from fastapi.responses import HTMLResponse, JSONResponse, PlainTextResponse

import nepalpay as gateway
import store
from payments import PaymentError, settle
from reconcile import start_reconcile_loop

app = FastAPI()

QR_PAGE = """<!doctype html><title>Scan to pay</title>
<h1>Scan with any NEPALPAY QR app, Rs 100</h1>
QR_CODE
<p>Waiting for payment. Keep this page open.</p>
<script>
async function poll() {
  try {
    const res = await fetch("/pay/status/ATTEMPT");
    if (res.ok) {
      const { status } = await res.json();
      if (status !== "initiated" && status !== "pending") {
        location.href = "/orders/ORDER";
        return;
      }
    }
  } catch {}
  setTimeout(poll, 4000);
}
setTimeout(poll, 4000);
</script>"""


def qr_page(attempt, start) -> str:
    """The QR plus a script that asks /pay/status every 4 seconds until the payment settles."""
    if start.qr_image:
        code = f'<img src="data:image/png;base64,{escape(start.qr_image)}" width="280" height="280" alt="NEPALPAY QR code">'
    else:
        code = f"<p>Render this as a QR code:</p><pre>{escape(start.qr_string)}</pre>"
    # Plain replace, not an f-string: the script's own braces would need doubling.
    # The QR goes in last, so nothing inside it is mistaken for a placeholder.
    page = QR_PAGE.replace("ATTEMPT", attempt.id).replace("ORDER", attempt.order_id)
    return page.replace("QR_CODE", code)


@app.get("/", response_class=HTMLResponse)
def home():
    return """<!doctype html><title>Shop</title>
<h1>Order demo, Rs 100</h1>
<form method="post" action="/pay/demo"><button>Pay with NEPALPAY QR</button></form>"""


# Plain \`def\` routes: FastAPI runs them in a thread pool, so the blocking NCHL
# calls do not stall other requests.
@app.post("/pay/{order_id}")
def pay(order_id: str):
    order = store.get_order(order_id)
    if order is None:
        return PlainTextResponse("Order not found", 404)
    attempt = store.create_attempt(order.id, order.amount_paisa)
    # No return URL: the buyer stays on our page and pays from their banking app.
    start = gateway.start_payment(attempt.id, attempt.amount_paisa, "", f"Order {order.id}")
    # The validationTraceId is the only handle on this QR. Store it before showing the code.
    store.set_provider_ref(attempt.id, start.provider_ref)
    return HTMLResponse(qr_page(attempt, start))


# The QR page polls this every few seconds.
@app.get("/pay/status/{attempt_id}")
def payment_status(attempt_id: str):
    attempt = store.get_attempt(attempt_id)
    if attempt is None:
        return JSONResponse({"error": "Payment not found"}, 404)
    if attempt.status in ("initiated", "pending"):
        try:
            outcome = gateway.confirm_payment(attempt.id, attempt.amount_paisa, attempt.provider_ref, {})
        except PaymentError as e:
            return JSONResponse({"error": str(e)}, 400)
        except Exception:
            logging.exception("confirm_payment failed")
            return JSONResponse({"error": "Payment gateway error, try again shortly"}, 502)
        settle(attempt, outcome)
    # Read the status again: settle() may have just moved it.
    return {"status": store.get_attempt(attempt_id).status}


@app.get("/orders/{order_id}", response_class=PlainTextResponse)
def order_status(order_id: str):
    attempt = store.latest_attempt(order_id)
    return f"Order {order_id}: {attempt.status if attempt else 'no payment yet'}"


start_reconcile_loop(gateway)` },
  ],
  flask: [
    { file: "app.py", lang: "python", code: `from html import escape

from flask import Flask

import nepalpay as gateway
import store
from payments import PaymentError, settle
from reconcile import start_reconcile_loop

app = Flask(__name__)

QR_PAGE = """<!doctype html><title>Scan to pay</title>
<h1>Scan with any NEPALPAY QR app, Rs 100</h1>
QR_CODE
<p>Waiting for payment. Keep this page open.</p>
<script>
async function poll() {
  try {
    const res = await fetch("/pay/status/ATTEMPT");
    if (res.ok) {
      const { status } = await res.json();
      if (status !== "initiated" && status !== "pending") {
        location.href = "/orders/ORDER";
        return;
      }
    }
  } catch {}
  setTimeout(poll, 4000);
}
setTimeout(poll, 4000);
</script>"""


def qr_page(attempt, start) -> str:
    """The QR plus a script that asks /pay/status every 4 seconds until the payment settles."""
    if start.qr_image:
        code = f'<img src="data:image/png;base64,{escape(start.qr_image)}" width="280" height="280" alt="NEPALPAY QR code">'
    else:
        code = f"<p>Render this as a QR code:</p><pre>{escape(start.qr_string)}</pre>"
    # Plain replace, not an f-string: the script's own braces would need doubling.
    # The QR goes in last, so nothing inside it is mistaken for a placeholder.
    page = QR_PAGE.replace("ATTEMPT", attempt.id).replace("ORDER", attempt.order_id)
    return page.replace("QR_CODE", code)


@app.get("/")
def home():
    return """<!doctype html><title>Shop</title>
<h1>Order demo, Rs 100</h1>
<form method="post" action="/pay/demo"><button>Pay with NEPALPAY QR</button></form>"""


@app.post("/pay/<order_id>")
def pay(order_id: str):
    order = store.get_order(order_id)
    if order is None:
        return "Order not found", 404
    attempt = store.create_attempt(order.id, order.amount_paisa)
    # No return URL: the buyer stays on our page and pays from their banking app.
    start = gateway.start_payment(attempt.id, attempt.amount_paisa, "", f"Order {order.id}")
    # The validationTraceId is the only handle on this QR. Store it before showing the code.
    store.set_provider_ref(attempt.id, start.provider_ref)
    return qr_page(attempt, start)


# The QR page polls this every few seconds.
@app.get("/pay/status/<attempt_id>")
def payment_status(attempt_id: str):
    attempt = store.get_attempt(attempt_id)
    if attempt is None:
        return {"error": "Payment not found"}, 404
    if attempt.status in ("initiated", "pending"):
        try:
            outcome = gateway.confirm_payment(attempt.id, attempt.amount_paisa, attempt.provider_ref, {})
        except PaymentError as e:
            return {"error": str(e)}, 400
        except Exception:
            app.logger.exception("confirm_payment failed")
            return {"error": "Payment gateway error, try again shortly"}, 502
        settle(attempt, outcome)
    # Read the status again: settle() may have just moved it.
    return {"status": store.get_attempt(attempt_id).status}


@app.get("/orders/<order_id>")
def order_status(order_id: str):
    attempt = store.latest_attempt(order_id)
    status = attempt.status if attempt else "no payment yet"
    return f"Order {order_id}: {status}", 200, {"Content-Type": "text/plain"}


start_reconcile_loop(gateway)` },
  ],
  laravel: [
    { file: "routes/web.php", lang: "php", code: `<?php

use App\\Payments\\NepalpayGateway;
use App\\Payments\\PaymentError;
use App\\Payments\\Store;
use Illuminate\\Support\\Facades\\Log;
use Illuminate\\Support\\Facades\\Route;

use function App\\Payments\\settle;

Route::get('/', fn () => '<h1>Order demo, Rs 100</h1>'
    . '<form method="post" action="/pay/demo">' . csrf_field() . '<button>Pay with NEPALPAY QR</button></form>');

// Creates the attempt, asks NCHL for a QR and shows it. No redirect: the buyer stays here.
Route::post('/pay/{orderId}', function (string $orderId, Store $store, NepalpayGateway $gateway) {
    $order = $store->getOrder($orderId) ?? abort(404);
    $attempt = $store->createAttempt($orderId, $order['amountPaisa']);

    $qr = $gateway->startQr($attempt['id'], $attempt['amountPaisa'], "Order $orderId");
    // Save validationTraceId now: it is the only way to look this payment up later.
    $store->setProviderRef($attempt['id'], $qr->providerRef);

    return response($qr->qrPage($attempt['id'], $orderId));
});

// The QR page polls this every few seconds. It asks NCHL's report API, applies the answer
// and returns the stored status. A plain GET, so CSRF doesn't apply.
Route::get('/pay/status/{attemptId}', function (string $attemptId, Store $store, NepalpayGateway $gateway) {
    $attempt = $store->getAttempt($attemptId) ?? abort(404);

    if (in_array($attempt['status'], ['initiated', 'pending'], true)) {
        try {
            // Stored amount and validationTraceId. There is no callback, so params stay empty.
            $outcome = $gateway->confirmPayment($attempt['id'], $attempt['amountPaisa'], $attempt['providerRef'], []);
        } catch (PaymentError $e) {
            Log::warning("attempt $attemptId: {$e->getMessage()}");
            return response()->json(['error' => 'Payment could not be verified'], 400);
        } catch (Throwable $e) {
            report($e); // network or provider outage: the page polls again, the reconcile job retries too
            return response()->json(['error' => 'Payment provider unavailable'], 502);
        }
        settle($store, $attempt, $outcome);
    }

    // Read it again: settle() may have just moved it.
    return response()->json(['status' => $store->getAttempt($attemptId)['status']]);
});

Route::get('/orders/{orderId}', function (string $orderId, Store $store) {
    $attempt = $store->latestAttempt($orderId);
    return response("Order $orderId: " . ($attempt['status'] ?? 'no payment yet'))->header('Content-Type', 'text/plain');
});` },
    { file: "app/Providers/AppServiceProvider.php", lang: "php", code: `<?php

namespace App\\Providers;

use App\\Payments\\Gateway;
use App\\Payments\\NepalpayGateway;
use App\\Payments\\Store;
use Illuminate\\Support\\ServiceProvider;

class AppServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        // Payments.php holds several classes and functions, so PSR-4 cannot find them.
        require_once app_path('Payments/Payments.php');

        // One gateway object: the routes ask for NepalpayGateway (they need startQr),
        // the reconcile command asks for Gateway.
        $this->app->singleton(NepalpayGateway::class, fn () => NepalpayGateway::fromEnv());
        $this->app->alias(NepalpayGateway::class, Gateway::class);
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
require __DIR__ . '/NepalpayGateway.php';

use App\\Payments\\NepalpayGateway;
use App\\Payments\\PaymentError;
use App\\Payments\\Reconcile;
use App\\Payments\\Store;

use function App\\Payments\\settle;

// Keep the data file out of any public web root in production.
$store = new Store(__DIR__ . '/payments.json');
$gateway = NepalpayGateway::fromEnv();

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

function json(int $code, array $body): never
{
    respond($code, json_encode($body), 'application/json');
}

if ($method === 'GET' && $path === '/') {
    respond(200, '<h1>Order demo, Rs 100</h1><form method="post" action="/pay/demo"><button>Pay with NEPALPAY QR</button></form>');
}

// Creates the attempt, asks NCHL for a QR and shows it. No redirect: the buyer stays here.
if ($method === 'POST' && preg_match('#^/pay/([\\w-]+)$#', $path, $m)) {
    $order = $store->getOrder($m[1]) ?? respond(404, 'Order not found', 'text/plain');
    $attempt = $store->createAttempt($order['id'], $order['amountPaisa']);

    $qr = $gateway->startQr($attempt['id'], $attempt['amountPaisa'], "Order {$order['id']}");
    // Save validationTraceId now: it is the only way to look this payment up later.
    $store->setProviderRef($attempt['id'], $qr->providerRef);
    respond(200, $qr->qrPage($attempt['id'], $order['id']));
}

// The QR page polls this every few seconds. It asks NCHL's report API, applies the answer
// and returns the stored status.
if ($method === 'GET' && preg_match('#^/pay/status/([a-f0-9]+)$#', $path, $m)) {
    $attempt = $store->getAttempt($m[1]) ?? respond(404, 'Attempt not found', 'text/plain');

    if (in_array($attempt['status'], ['initiated', 'pending'], true)) {
        try {
            // Stored amount and validationTraceId. There is no callback, so params stay empty.
            $outcome = $gateway->confirmPayment($attempt['id'], $attempt['amountPaisa'], $attempt['providerRef'], []);
        } catch (PaymentError $e) {
            error_log("attempt {$attempt['id']}: {$e->getMessage()}");
            json(400, ['error' => 'Payment could not be verified']);
        } catch (Throwable $e) {
            error_log("attempt {$attempt['id']}: $e"); // the page polls again, the reconcile job retries too
            json(502, ['error' => 'Payment provider unavailable']);
        }
        settle($store, $attempt, $outcome);
    }

    // Read it again: settle() may have just moved it.
    json(200, ['status' => $store->getAttempt($attempt['id'])['status']]);
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
	"encoding/json"
	"errors"
	"fmt"
	"html/template"
	"log"
	"net/http"
	"slices"
	"time"

	"shop/payments"
)

// qrPage shows the QR and polls /pay/status until the attempt leaves initiated or pending.
// html/template escapes every value for where it lands: the base64 image inside the src URL,
// the QR string as text, the ids inside the script.
var qrPage = template.Must(template.New("qr").Parse(\`<!doctype html><title>Scan to pay</title>
<h1>Scan with any NEPALPAY QR app, Rs 100</h1>
{{if .QRImage}}<img src="data:image/png;base64,{{.QRImage}}" width="280" height="280" alt="NEPALPAY QR code">
{{else}}<p>Render this as a QR code:</p><pre>{{.QRString}}</pre>
{{end}}<p>Waiting for payment. Keep this page open.</p>
<script>
async function poll() {
  try {
    const res = await fetch("/pay/status/{{.AttemptID}}");
    if (res.ok) {
      const { status } = await res.json();
      if (status !== "initiated" && status !== "pending") {
        location.href = "/orders/{{.OrderID}}";
        return;
      }
    }
  } catch {}
  setTimeout(poll, 4000);
}
setTimeout(poll, 4000);
</script>\`))

// reconcileGateway lets the shared Reconcile job use the NEPALPAY module. Reconcile only calls
// ConfirmPayment, but its Gateway interface also wants a StartPayment that returns a redirect or form.
type reconcileGateway struct{ *payments.Nepalpay }

func (reconcileGateway) StartPayment(context.Context, payments.StartInput) (payments.Start, error) {
	return payments.Start{}, errors.New("NEPALPAY starts with a QR, not a redirect")
}

func main() {
	store := payments.NewStore()
	gateway := payments.NewNepalpay()

	// Reconcile open attempts every minute: buyers who paid and closed the page before it noticed.
	go func() {
		for {
			payments.Reconcile(context.Background(), store, reconcileGateway{gateway})
			time.Sleep(time.Minute)
		}
	}()

	mux := http.NewServeMux()

	mux.HandleFunc("GET /{$}", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, \`<h1>Order demo, Rs 100</h1><form method="post" action="/pay/demo"><button>Pay with NEPALPAY QR</button></form>\`)
	})

	mux.HandleFunc("POST /pay/{orderID}", func(w http.ResponseWriter, r *http.Request) {
		order, ok := store.GetOrder(r.PathValue("orderID"))
		if !ok {
			http.NotFound(w, r)
			return
		}
		attempt := store.CreateAttempt(order.ID, order.AmountPaisa)
		qr, err := gateway.StartPayment(r.Context(), payments.StartInput{
			AttemptID:   attempt.ID,
			AmountPaisa: attempt.AmountPaisa,
			Description: "Order " + order.ID,
			// No ReturnURL: the buyer pays in their banking app and never leaves this page.
		})
		if err != nil {
			log.Printf("start %s: %v", attempt.ID, err)
			http.Error(w, "Could not start the payment", http.StatusBadGateway)
			return
		}
		// validationTraceId: the only key the transaction report takes. Lose it and only
		// a date-wise report can find the payment.
		store.SetProviderRef(attempt.ID, qr.ProviderRef)
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		qrPage.Execute(w, map[string]string{
			"QRImage": qr.QRImage, "QRString": qr.QRString, "AttemptID": attempt.ID, "OrderID": order.ID,
		})
	})

	// The QR page calls this every 4 seconds. It asks NCHL only while the attempt is open,
	// so a paid order costs no more API calls however long the page stays up.
	mux.HandleFunc("GET /pay/status/{attemptID}", func(w http.ResponseWriter, r *http.Request) {
		attempt, ok := store.GetAttempt(r.PathValue("attemptID"))
		if !ok {
			http.NotFound(w, r)
			return
		}
		if slices.Contains(payments.Open, attempt.Status) {
			// Stored amount and providerRef. There is no callback, so Params stays empty.
			outcome, err := gateway.ConfirmPayment(r.Context(), payments.ConfirmInput{
				AttemptID:   attempt.ID,
				AmountPaisa: attempt.AmountPaisa,
				ProviderRef: attempt.ProviderRef,
				Params:      map[string]string{},
			})
			if errors.Is(err, payments.ErrPayment) {
				log.Printf("attempt %s: %v", attempt.ID, err)
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Payment could not be verified"})
				return
			}
			if err != nil {
				log.Printf("attempt %s: %v", attempt.ID, err) // the next poll or the reconcile job retries
				writeJSON(w, http.StatusBadGateway, map[string]string{"error": "Payment provider unavailable"})
				return
			}
			payments.Settle(store, attempt, outcome)
		}
		// Read it again: Settle may have just moved it to paid.
		attempt, _ = store.GetAttempt(attempt.ID)
		writeJSON(w, http.StatusOK, map[string]string{"status": attempt.Status})
	})

	mux.HandleFunc("GET /orders/{orderID}", func(w http.ResponseWriter, r *http.Request) {
		status := "no payment yet"
		if a, ok := store.LatestAttempt(r.PathValue("orderID")); ok {
			status = a.Status
		}
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		fmt.Fprintf(w, "Order %s: %s", r.PathValue("orderID"), status)
	})

	log.Println("listening on :8080")
	log.Fatal(http.ListenAndServe(":8080", mux))
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(v)
}` },
  ],
  spring: [
    { file: "src/main/java/shop/ShopApplication.java", lang: "java", code: `package shop;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.context.annotation.Bean;
import org.springframework.scheduling.annotation.EnableScheduling;
import payments.NepalpayGateway;
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
    NepalpayGateway gateway() {
        return NepalpayGateway.fromEnv();
    }
}` },
    { file: "src/main/java/shop/PaymentController.java", lang: "java", code: `package shop;

import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.util.HtmlUtils;
import payments.NepalpayGateway;
import payments.Outcome;
import payments.PaymentException;
import payments.Payments;
import payments.Store;

@RestController
class PaymentController {
    private final Store store;
    private final NepalpayGateway gateway;

    PaymentController(Store store, NepalpayGateway gateway) {
        this.store = store;
        this.gateway = gateway;
    }

    @GetMapping(value = "/", produces = MediaType.TEXT_HTML_VALUE)
    String home() {
        return "<h1>Order demo, Rs 100</h1><form method=\\"post\\" action=\\"/pay/demo\\"><button>Pay with NEPALPAY QR</button></form>";
    }

    // Creates an attempt, asks NCHL for a QR and shows it. The buyer stays on this page.
    @PostMapping(value = "/pay/{orderId}", produces = MediaType.TEXT_HTML_VALUE)
    ResponseEntity<String> pay(@PathVariable String orderId) {
        Store.Order order = store.getOrder(orderId);
        if (order == null) return ResponseEntity.notFound().build();
        Store.Attempt attempt = store.createAttempt(orderId, order.amountPaisa());

        NepalpayGateway.QrStart qr = gateway.startQr(attempt.id(), attempt.amountPaisa(), "Order " + orderId);
        // The validationTraceId is the only key the transaction report accepts. Store it before showing the QR.
        store.setProviderRef(attempt.id(), qr.providerRef());
        return ResponseEntity.ok(qrPage(qr, attempt.id(), orderId));
    }

    // The QR page polls this every 4 seconds. It asks NCHL while the attempt is open and answers with our status.
    @GetMapping(value = "/pay/status/{attemptId}", produces = MediaType.APPLICATION_JSON_VALUE)
    ResponseEntity<Map<String, String>> status(@PathVariable String attemptId) {
        Store.Attempt attempt = store.getAttempt(attemptId);
        if (attempt == null) return ResponseEntity.notFound().build();

        if (Payments.OPEN.contains(attempt.status())) {
            try {
                // Stored amount and validationTraceId. There is no callback, so params is empty.
                Outcome outcome = gateway.confirmPayment(attempt.id(), attempt.amountPaisa(), attempt.providerRef(), Map.of());
                Payments.settle(store, attempt, outcome);
            } catch (PaymentException e) {
                System.err.println("attempt " + attemptId + ": " + e.getMessage());
                return ResponseEntity.badRequest().body(Map.of("error", "Payment could not be verified"));
            } catch (RuntimeException e) {
                System.err.println("attempt " + attemptId + ": " + e); // the next poll or the reconcile job retries
                return ResponseEntity.status(HttpStatus.BAD_GATEWAY).body(Map.of("error", "Payment provider unavailable"));
            }
        }
        // Read it again: settle() may have just moved it.
        return ResponseEntity.ok(Map.of("status", store.getAttempt(attemptId).status()));
    }

    @GetMapping(value = "/orders/{orderId}", produces = MediaType.TEXT_PLAIN_VALUE)
    String order(@PathVariable String orderId) {
        Store.Attempt attempt = store.latestAttempt(orderId);
        return "Order " + orderId + ": " + (attempt == null ? "no payment yet" : attempt.status());
    }

    // The QR, plus a script that polls the status route and moves on once the attempt is settled.
    private static String qrPage(NepalpayGateway.QrStart qr, String attemptId, String orderId) {
        String code = qr.qrImage() != null
            ? "<img src=\\"data:image/png;base64," + qr.qrImage() + "\\" width=\\"280\\" height=\\"280\\" alt=\\"NEPALPAY QR code\\">"
            : "<p>Render this as a QR code:</p><pre>" + HtmlUtils.htmlEscape(qr.qrString()) + "</pre>";
        return """
            <!doctype html><title>Scan to pay</title>
            <h1>Scan with any NEPALPAY QR app, Rs 100</h1>
            %s
            <p>Waiting for payment. Keep this page open.</p>
            <script>
            async function poll() {
              try {
                const res = await fetch("/pay/status/%s");
                if (res.ok) {
                  const { status } = await res.json();
                  if (status !== "initiated" && status !== "pending") {
                    location.href = "/orders/%s";
                    return;
                  }
                }
              } catch {}
              setTimeout(poll, 4000);
            }
            setTimeout(poll, 4000);
            </script>
            """.formatted(code, attemptId, orderId);
    }
}` },
  ],
  ktor: [
    { file: "src/main/kotlin/shop/Application.kt", lang: "kotlin", code: `package shop

import io.ktor.http.ContentType
import io.ktor.http.HttpStatusCode
import io.ktor.server.application.Application
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
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import payments.NepalpayGateway
import payments.OPEN
import payments.PaymentException
import payments.QrStart
import payments.Store
import payments.reconcile
import payments.settle
import kotlin.time.Duration.Companion.minutes

fun main() {
    embeddedServer(Netty, port = 8080, module = Application::module).start(wait = true)
}

fun Application.module() {
    val store = Store()
    val gateway = NepalpayGateway.fromEnv()

    // Reconcile open attempts every minute: it catches payers who closed the QR page after paying.
    launch {
        while (isActive) {
            reconcile(store, gateway)
            delay(1.minutes)
        }
    }

    routing {
        get("/") {
            call.respondText(
                """<h1>Order demo, Rs 100</h1><form method="post" action="/pay/demo"><button>Pay with NEPALPAY QR</button></form>""",
                ContentType.Text.Html,
            )
        }

        // Creates an attempt, asks NCHL for a QR and shows it. There is no redirect anywhere in this flow.
        post("/pay/{orderId}") {
            val order = store.getOrder(call.parameters["orderId"]!!) ?: return@post call.respond(HttpStatusCode.NotFound)
            val attempt = store.createAttempt(order.id, order.amountPaisa)
            // No return URL: the payer pays from their own banking app and never comes back through ours.
            val qr = gateway.startPayment(attempt.id, attempt.amountPaisa, "", "Order \${order.id}")
            store.setProviderRef(attempt.id, qr.providerRef) // validationTraceId: the only way to look the payment up
            call.respondText(qrPage(qr, attempt.id, order.id), ContentType.Text.Html)
        }

        // The QR page polls this every few seconds. It asks NCHL, applies the answer, and returns the stored status.
        get("/pay/status/{attemptId}") {
            val attempt = store.getAttempt(call.parameters["attemptId"]!!) ?: return@get call.respond(HttpStatusCode.NotFound)
            if (attempt.status in OPEN) {
                try {
                    // Stored amount and providerRef. There is no callback, so params stays empty.
                    settle(store, attempt, gateway.confirmPayment(attempt.id, attempt.amountPaisa, attempt.providerRef, emptyMap()))
                } catch (e: PaymentException) {
                    call.application.log.warn("attempt \${attempt.id}: \${e.message}")
                    return@get call.respondJson(buildJsonObject { put("error", "Payment could not be verified") }.toString(), HttpStatusCode.BadRequest)
                } catch (e: Exception) {
                    call.application.log.error("attempt \${attempt.id}", e) // the next poll or the reconcile job retries
                    return@get call.respondJson(buildJsonObject { put("error", "Payment provider unavailable") }.toString(), HttpStatusCode.BadGateway)
                }
            }
            // Read it again: settle() may have just moved it to paid.
            val status = store.getAttempt(attempt.id)!!.status
            call.respondJson(buildJsonObject { put("status", status) }.toString())
        }

        get("/orders/{orderId}") {
            val orderId = call.parameters["orderId"]!!
            call.respondText("Order $orderId: \${store.latestAttempt(orderId)?.status ?: "no payment yet"}")
        }
    }
}

private suspend fun io.ktor.server.application.ApplicationCall.respondJson(json: String, status: HttpStatusCode = HttpStatusCode.OK) =
    respondText(json, ContentType.Application.Json, status)

// The QR, plus a script that polls /pay/status and moves on once the attempt is settled.
// The JavaScript has no "$", so the only templates in this raw string are $code, $attemptId and $orderId.
private fun qrPage(qr: QrStart, attemptId: String, orderId: String): String {
    fun esc(s: String) = s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
        .replace("\\"", "&quot;").replace("'", "&#39;")
    // qrImage is base64 (A-Z, a-z, 0-9, +, /, =), safe inside the attribute as it is.
    val code = if (qr.qrImage != null) {
        """<img src="data:image/png;base64,\${qr.qrImage}" width="280" height="280" alt="NEPALPAY QR code">"""
    } else {
        """<p>Render this as a QR code:</p><pre>\${esc(qr.qrString)}</pre>"""
    }
    return """<!doctype html><title>Scan to pay</title>
<h1>Scan with any NEPALPAY QR app, Rs 100</h1>
$code
<p>Waiting for payment. Keep this page open.</p>
<script>
async function poll() {
  try {
    const res = await fetch("/pay/status/$attemptId");
    if (res.ok) {
      const { status } = await res.json();
      if (status !== "initiated" && status !== "pending") {
        location.href = "/orders/$orderId";
        return;
      }
    }
  } catch {}
  setTimeout(poll, 4000);
}
setTimeout(poll, 4000);
</script>"""
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
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.12.0") // used by the gateway module and the status route
    implementation("org.slf4j:slf4j-simple:2.0.20") // Ktor logs through SLF4J
}

application {
    mainClass.set("shop.ApplicationKt")
}` },
  ],
};

// Token strings signed with testKey from the connectIPS post (NEPALPAY QR signs with the same kind of NCHL .pfx key).
export const vectors: { message: string; signature: string }[] = [
  {
    message: "00002501,2501ELFDRY2,5411,524,100.00,0f3a9c2e7b1d4a6c8e5f,npiuser",
    signature: "WQqR1yPmBcLAuTO8Ino4b25YlXa7bP4OFN5LjdG4u840a9lIm2jnCXdT5qSiqpLRVDPR7CEJq0iFhaL2ZbWgDFLyvnSSY0bFRwVVjtb5jrFC5fM2pKUhpn8qF0vppZe8XvUnmHLZjbp6IUMO7gkSF7xHIzpiBYds/fHcLHyuyxK6jaaSSSlNkHsh5xnZobALfntJqeg9wL88e9MnviCQgWj37kRlmqnsTnfZubuLuC3peMKKYWNdfPClr9BiONnxbeuJVZnzoD4FHV86RiOxHndLn2mnJxpRQt90BrCJwK+2nS9g6L43520Ly4EsWozw6GRJwMPdeOGFh6Ytpjw3AA==",
  },
  {
    message: "00002501,2501ELFDRY2,5411,524,1500.50,0f3a9c2e7b1d4a6c8e5f,npiuser",
    signature: "c4FkEYuCR8z9iJH/la/JS3D6tywf4zfPdQiI5rpWHvoI6TLi0ro9SUbWifltjm75VlIfxylCQckVb7pebWjzJNUwt5dhUOlezWAss8p8Mrk/T4rwdyaZurjuEosyuucMBMyoSj+w1is6KcUtaNuBWSJ0l3X/p6k7m6EbywvkOwvqFE3GjgrjxiqAxONlZADHGFBenoBfzL9CisdJi8Y5yj2gN6Exp/M/PsEa3SZtx2OAq3mq55qowm5u/rWC4y4v8SLn9XfZIvyrfLQIL2qD7t7VV2HVWIP639bkx2s5Yz5pkTFCx/9rgFDH3XQafPFfVMjM49w3w0tb7ldPaU8Szw==",
  },
];

export default nepalpay;

// Generated Fonepay web payment gateway module, one per language.
// The parts joined with "\n\n" in order (config, sign, start, confirm) form the complete file.

export interface GatewayCode {
  file: string;
  lang: string;
  parts: { config: string; sign: string; start: string; confirm: string };
}

export const fonepay: Record<"ts" | "python" | "php" | "go" | "java" | "kotlin", GatewayCode> = {
  ts: {
    file: "fonepay.ts",
    lang: "typescript",
    parts: {
      config: `import { PaymentError, type ConfirmInput, type Outcome, type PaymentStatus, type Start, type StartInput } from "./payments";

// Fonepay web payment. Sandbox (Fonepay's dev gateway) unless FONEPAY_ENV=production.
const PRODUCTION = process.env.FONEPAY_ENV === "production";

const PAYMENT_URL = PRODUCTION
  ? "https://clientapi.fonepay.com/api/merchantRequest"
  : "https://dev-clientapi.fonepay.com/api/merchantRequest";
// The dev host is not in public DNS. Fonepay gives you a reachable one during onboarding.
const TXN_VERIFICATION_URL = process.env.FONEPAY_TXN_VERIFICATION_URL ?? (PRODUCTION
  ? "https://merchantapi.fonepay.com/api/merchant/merchantDetailsForThirdParty/txnVerification"
  : "https://dev-merchantapi.fonepay.com/api/merchant/merchantDetailsForThirdParty/txnVerification");

// Sandbox defaults are the dev merchant from Fonepay's docs. Production needs your own.
const MERCHANT_CODE = process.env.FONEPAY_MERCHANT_CODE ?? (PRODUCTION ? "" : "NBQM");
const SECRET_KEY = process.env.FONEPAY_SECRET_KEY ?? (PRODUCTION ? "" : "a7e3512f5032480a83137793cb2021dc");
// Merchant-panel login for txnVerification. Fonepay publishes none for the dev gateway.
const USERNAME = process.env.FONEPAY_USERNAME ?? "";
const PASSWORD = process.env.FONEPAY_PASSWORD ?? "";
if (!MERCHANT_CODE || !SECRET_KEY) throw new Error("Set FONEPAY_MERCHANT_CODE and FONEPAY_SECRET_KEY");
if (PRODUCTION && (!USERNAME || !PASSWORD)) throw new Error("Set FONEPAY_USERNAME and FONEPAY_PASSWORD");

// Paisa to Fonepay's rupee text: 10000 -> "100", 10050 -> "100.50".
// DV signs the exact text, so format once and reuse the same string ("100" vs "100.00" fails).
function rupees(paisa: number): string {
  const whole = Math.floor(paisa / 100);
  const rest = paisa % 100;
  return rest === 0 ? String(whole) : \`\${whole}.\${String(rest).padStart(2, "0")}\`;
}

// Today as MM/DD/YYYY in Nepal. Nepal is UTC+05:45 all year, with no daylight saving.
function nepalDate(): string {
  const d = new Date(Date.now() + (5 * 60 + 45) * 60_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return \`\${pad(d.getUTCMonth() + 1)}/\${pad(d.getUTCDate())}/\${d.getUTCFullYear()}\`;
}`,
      sign: `// HMAC-SHA512(key, message) as hex, with Web Crypto so it runs on Node, Bun, Deno and edge runtimes.
export async function hmacHex(key: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-512" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(message)));
  return Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("");
}

// Fonepay's DV: the values (no names) joined with ",", signed, uppercase like Fonepay's Java sample.
async function dv(values: string[]): Promise<string> {
  return (await hmacHex(SECRET_KEY, values.join(","))).toUpperCase();
}

// Compare signatures in constant time, so response timing leaks nothing about the right value.
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}`,
      start: `// Returns the signed Fonepay URL. The route answers 303 to it and the browser follows.
export async function startPayment(input: StartInput): Promise<Start> {
  if (input.returnUrl.length > 150) throw new Error("Fonepay: the return URL (RU) must be 150 characters or fewer");
  const params: Record<string, string> = {
    PID: MERCHANT_CODE,
    MD: "P", // payment mode, always "P"
    PRN: input.attemptId, // 3 to 25 characters, never reused (a reused PRN gets 409 Duplicate PRN)
    AMT: rupees(input.amountPaisa), // rupees; the same string goes into DV
    CRN: "NPR",
    DT: nepalDate(), // MM/DD/YYYY in Nepal time
    R1: input.description.slice(0, 160), // shown to the payer, up to 160 characters
    R2: "N/A", // remarks, "N/A" when unused
    RU: input.returnUrl, // Fonepay appends ?PRN=...&DV=..., so no query string here
  };
  // DV signs the raw values in this order, before URL encoding.
  params.DV = await dv([params.PID, params.MD, params.PRN, params.AMT, params.CRN, params.DT, params.R1, params.R2, params.RU]);
  return { type: "redirect", url: \`\${PAYMENT_URL}?\${new URLSearchParams(params)}\` };
}`,
      confirm: `// txnVerification paymentStatus -> our status.
const STATUSES: Record<string, PaymentStatus> = { success: "paid", pending: "pending", failed: "failed" };
// The fields Fonepay signs on the return URL, in signing order.
const RETURN_FIELDS = ["PRN", "PID", "PS", "RC", "UID", "BC", "INI", "P_AMT", "R_AMT"];
const TXN_PATH = "/merchant/merchantDetailsForThirdParty/txnVerification";

// Checks the DV on the return URL. Throws PaymentError if it is missing, forged, or for another payment.
async function verifyReturn(params: Record<string, string>, attemptId: string): Promise<void> {
  // Hash the values exactly as received: "20.0" turned into "20" no longer matches.
  const expected = await dv(RETURN_FIELDS.map((f) => params[f] ?? ""));
  if (!params.DV || !safeEqual(expected, params.DV.toUpperCase())) {
    throw new PaymentError("Fonepay: missing or bad DV on the return URL");
  }
  if (params.PRN !== attemptId || params.PID !== MERCHANT_CODE) {
    throw new PaymentError("Fonepay: return is for a different payment");
  }
}

// Asks Fonepay for the payment by PRN and amount. Needs no return params, so the reconcile job can use it.
async function txnVerification(prn: string, amount: string): Promise<Record<string, unknown>> {
  // The auth header signs the exact body bytes. Build the string once and send that same string:
  // re-serializing an object changes the spacing and Fonepay answers 401. The spacing copies the spec.
  const body = \`{"prn": \${JSON.stringify(prn)},"merchantCode": \${JSON.stringify(MERCHANT_CODE)},"amount": \${JSON.stringify(amount)}}\`;
  const auth = await hmacHex(SECRET_KEY, [USERNAME, PASSWORD, "POST", "application/json", TXN_PATH, body].join(","));
  const res = await fetch(TXN_VERIFICATION_URL, {
    method: "POST",
    headers: { Authorization: \`Basic \${btoa(\`\${USERNAME}:\${PASSWORD}\`)}\`, auth, "Content-Type": "application/json" },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  const data = await res.json().catch(() => null);
  // A wrong login or a body that differs from the signed one gets 401. Not an answer: retry later.
  if (!res.ok || typeof data?.paymentStatus !== "string") {
    throw new Error(\`Fonepay txnVerification failed: HTTP \${res.status} \${JSON.stringify(data)}\`);
  }
  return data;
}

// Called from the return route (params = query + body) and from the reconcile job (params = {}).
export async function confirmPayment(input: ConfirmInput): Promise<Outcome> {
  const p = input.params;
  const returned = Boolean(p.DV || p.PRN); // Fonepay's return carries both; the reconcile job sends neither
  if (returned) await verifyReturn(p, input.attemptId);

  if (!USERNAME || !PASSWORD) {
    // Sandbox without a panel login, so there is no status API to ask. A signed failure or
    // cancel is final; a signed success stays pending because nothing confirmed it.
    if (returned && p.PS !== "true") return { status: p.RC === "cancel" ? "canceled" : "failed", providerRef: p.UID || undefined };
    return { status: "pending" };
  }

  // The real answer. Send the STORED amount, never one from the return URL.
  const body = await txnVerification(input.attemptId, rupees(input.amountPaisa));
  // requestedAmount is what this PRN was created for. It has to be what we stored.
  if (Math.round(Number(body.requestedAmount) * 100) !== input.amountPaisa) {
    throw new PaymentError(\`Fonepay: amount mismatch (\${body.requestedAmount})\`);
  }
  // Unknown values count as pending, so the reconcile job keeps asking.
  const fonepayStatus = String(body.paymentStatus).toLowerCase();
  const status = Object.hasOwn(STATUSES, fonepayStatus) ? STATUSES[fonepayStatus] : "pending";
  const ref = body.fonepayTraceId ?? (returned ? p.UID : null); // Fonepay's trace id, for support
  return { status, providerRef: ref == null || ref === "" ? undefined : String(ref) };
}`,
    },
  },
  python: {
    file: "fonepay.py",
    lang: "python",
    parts: {
      config: `import base64
import hashlib
import hmac
import json
import os
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

from payments import Outcome, PaymentError, Start

# Fonepay web payment. Sandbox (Fonepay's dev gateway) unless FONEPAY_ENV=production.
PRODUCTION = os.environ.get("FONEPAY_ENV") == "production"

if PRODUCTION:
    PAYMENT_URL = "https://clientapi.fonepay.com/api/merchantRequest"
    TXN_VERIFICATION_URL = "https://merchantapi.fonepay.com/api/merchant/merchantDetailsForThirdParty/txnVerification"
else:
    PAYMENT_URL = "https://dev-clientapi.fonepay.com/api/merchantRequest"
    # The dev host is not in public DNS. Fonepay gives you a reachable one during onboarding.
    TXN_VERIFICATION_URL = "https://dev-merchantapi.fonepay.com/api/merchant/merchantDetailsForThirdParty/txnVerification"
TXN_VERIFICATION_URL = os.environ.get("FONEPAY_TXN_VERIFICATION_URL", TXN_VERIFICATION_URL)

# Sandbox defaults are the dev merchant from Fonepay's docs. Production needs your own.
MERCHANT_CODE = os.environ.get("FONEPAY_MERCHANT_CODE", "" if PRODUCTION else "NBQM")
SECRET_KEY = os.environ.get("FONEPAY_SECRET_KEY", "" if PRODUCTION else "a7e3512f5032480a83137793cb2021dc")
# Merchant-panel login for txnVerification. Fonepay publishes none for the dev gateway.
USERNAME = os.environ.get("FONEPAY_USERNAME", "")
PASSWORD = os.environ.get("FONEPAY_PASSWORD", "")
if not MERCHANT_CODE or not SECRET_KEY:
    raise RuntimeError("Set FONEPAY_MERCHANT_CODE and FONEPAY_SECRET_KEY")
if PRODUCTION and not (USERNAME and PASSWORD):
    raise RuntimeError("Set FONEPAY_USERNAME and FONEPAY_PASSWORD")


def rupees(paisa: int) -> str:
    """Paisa to Fonepay's rupee text: 10000 -> "100", 10050 -> "100.50".
    DV signs the exact text, so format once and reuse the same string ("100" vs "100.00" fails)."""
    whole, rest = divmod(paisa, 100)
    return str(whole) if rest == 0 else f"{whole}.{rest:02d}"


def nepal_date() -> str:
    """Today as MM/DD/YYYY in Nepal. Nepal is UTC+05:45 all year, with no daylight saving."""
    return datetime.now(timezone(timedelta(hours=5, minutes=45))).strftime("%m/%d/%Y")`,
      sign: `def hmac_hex(key: str, message: str) -> str:
    """HMAC-SHA512(key, message) as lowercase hex."""
    return hmac.new(key.encode(), message.encode(), hashlib.sha512).hexdigest()


def dv(values: list[str]) -> str:
    """Fonepay's DV: the values (no names) joined with ",", signed, uppercase like Fonepay's Java sample."""
    return hmac_hex(SECRET_KEY, ",".join(values)).upper()`,
      start: `def start_payment(attempt_id: str, amount_paisa: int, return_url: str, description: str) -> Start:
    """Returns the signed Fonepay URL. The route answers 303 to it and the browser follows."""
    if len(return_url) > 150:
        raise ValueError("Fonepay: the return URL (RU) must be 150 characters or fewer")
    params = {
        "PID": MERCHANT_CODE,
        "MD": "P",  # payment mode, always "P"
        "PRN": attempt_id,  # 3 to 25 characters, never reused (a reused PRN gets 409 Duplicate PRN)
        "AMT": rupees(amount_paisa),  # rupees; the same string goes into DV
        "CRN": "NPR",
        "DT": nepal_date(),  # MM/DD/YYYY in Nepal time
        "R1": description[:160],  # shown to the payer, up to 160 characters
        "R2": "N/A",  # remarks, "N/A" when unused
        "RU": return_url,  # Fonepay appends ?PRN=...&DV=..., so no query string here
    }
    # DV signs the raw values in this order, before URL encoding.
    params["DV"] = dv([params[k] for k in ("PID", "MD", "PRN", "AMT", "CRN", "DT", "R1", "R2", "RU")])
    return Start(type="redirect", url=f"{PAYMENT_URL}?{urllib.parse.urlencode(params)}")`,
      confirm: `# txnVerification paymentStatus -> our status.
STATUSES = {"success": "paid", "pending": "pending", "failed": "failed"}
# The fields Fonepay signs on the return URL, in signing order.
RETURN_FIELDS = ["PRN", "PID", "PS", "RC", "UID", "BC", "INI", "P_AMT", "R_AMT"]
TXN_PATH = "/merchant/merchantDetailsForThirdParty/txnVerification"


def _verify_return(params: dict[str, str], attempt_id: str) -> None:
    """Checks the DV on the return URL. Raises PaymentError if it is missing, forged, or for another payment."""
    # Hash the values exactly as received: "20.0" turned into "20" no longer matches.
    expected = dv([params.get(f, "") for f in RETURN_FIELDS])
    if not params.get("DV") or not hmac.compare_digest(expected, params["DV"].upper()):
        raise PaymentError("Fonepay: missing or bad DV on the return URL")
    if params.get("PRN") != attempt_id or params.get("PID") != MERCHANT_CODE:
        raise PaymentError("Fonepay: return is for a different payment")


def _txn_verification(prn: str, amount: str) -> dict:
    """Asks Fonepay for the payment by PRN and amount. Needs no return params, so the reconcile job can use it."""
    # The auth header signs the exact body bytes. Build the string once and send that same string:
    # json.dumps(dict) puts a space after every comma and Fonepay answers 401. The spacing copies the spec.
    body = f'{{"prn": {json.dumps(prn)},"merchantCode": {json.dumps(MERCHANT_CODE)},"amount": {json.dumps(amount)}}}'
    auth = hmac_hex(SECRET_KEY, ",".join([USERNAME, PASSWORD, "POST", "application/json", TXN_PATH, body]))
    req = urllib.request.Request(TXN_VERIFICATION_URL, data=body.encode(), method="POST", headers={
        "Authorization": "Basic " + base64.b64encode(f"{USERNAME}:{PASSWORD}".encode()).decode(),
        "auth": auth,
        "Content-Type": "application/json",
    })
    try:
        with urllib.request.urlopen(req, timeout=15) as res:
            data = json.load(res)
    except urllib.error.HTTPError as e:
        # A wrong login or a body that differs from the signed one gets 401. Not an answer: retry later.
        raise RuntimeError(f"Fonepay txnVerification failed: HTTP {e.code} {e.read()[:300]!r}") from e
    except (urllib.error.URLError, ValueError) as e:
        raise RuntimeError(f"Fonepay txnVerification failed: {e}") from e
    if not isinstance(data, dict) or not isinstance(data.get("paymentStatus"), str):
        raise RuntimeError(f"Fonepay txnVerification failed: {data}")
    return data


def confirm_payment(attempt_id: str, amount_paisa: int, provider_ref: str | None, params: dict[str, str]) -> Outcome:
    """Called from the return route (params = query + body) and from the reconcile job (params = {})."""
    returned = bool(params.get("DV") or params.get("PRN"))  # Fonepay's return carries both; the reconcile job sends neither
    if returned:
        _verify_return(params, attempt_id)

    if not (USERNAME and PASSWORD):
        # Sandbox without a panel login, so there is no status API to ask. A signed failure or
        # cancel is final; a signed success stays pending because nothing confirmed it.
        if returned and params.get("PS") != "true":
            return Outcome(status="canceled" if params.get("RC") == "cancel" else "failed",
                           provider_ref=params.get("UID") or None)
        return Outcome(status="pending")

    # The real answer. Send the STORED amount, never one from the return URL.
    body = _txn_verification(attempt_id, rupees(amount_paisa))
    # requestedAmount is what this PRN was created for. It has to be what we stored.
    try:
        requested = round(float(body.get("requestedAmount")) * 100)
    except (TypeError, ValueError):
        requested = None
    if requested != amount_paisa:
        raise PaymentError(f"Fonepay: amount mismatch ({body.get('requestedAmount')})")
    # Unknown values count as pending, so the reconcile job keeps asking.
    ref = body.get("fonepayTraceId")  # Fonepay's trace id, for support
    if ref is None and returned:
        ref = params.get("UID")
    return Outcome(status=STATUSES.get(body["paymentStatus"].lower(), "pending"),
                   provider_ref=str(ref) if ref not in (None, "") else None)`,
    },
  },
  php: {
    file: "FonepayGateway.php",
    lang: "php",
    parts: {
      config: `<?php

declare(strict_types=1);

namespace App\\Payments;

// Fonepay web payment. Sandbox (Fonepay's dev gateway) unless FONEPAY_ENV=production.
final class FonepayGateway implements Gateway
{
    public function __construct(
        private string $merchantCode,
        private string $secretKey,
        private string $username,
        private string $password,
        private string $paymentUrl,
        private string $txnVerificationUrl,
    ) {
    }

    public static function fromEnv(): self
    {
        $env = static fn (string $name) => $_ENV[$name] ?? (getenv($name) !== false ? getenv($name) : null);
        $production = $env('FONEPAY_ENV') === 'production';
        // Sandbox defaults are the dev merchant from Fonepay's docs. Production needs your own.
        $merchantCode = $env('FONEPAY_MERCHANT_CODE') ?? ($production ? '' : 'NBQM');
        $secretKey = $env('FONEPAY_SECRET_KEY') ?? ($production ? '' : 'a7e3512f5032480a83137793cb2021dc');
        // Merchant-panel login for txnVerification. Fonepay publishes none for the dev gateway.
        $username = $env('FONEPAY_USERNAME') ?? '';
        $password = $env('FONEPAY_PASSWORD') ?? '';
        if ($merchantCode === '' || $secretKey === '') {
            throw new \\RuntimeException('Set FONEPAY_MERCHANT_CODE and FONEPAY_SECRET_KEY');
        }
        if ($production && ($username === '' || $password === '')) {
            throw new \\RuntimeException('Set FONEPAY_USERNAME and FONEPAY_PASSWORD');
        }
        // The dev txnVerification host is not in public DNS. Fonepay gives you a reachable one during onboarding.
        $txnUrl = $env('FONEPAY_TXN_VERIFICATION_URL') ?? ($production
            ? 'https://merchantapi.fonepay.com/api/merchant/merchantDetailsForThirdParty/txnVerification'
            : 'https://dev-merchantapi.fonepay.com/api/merchant/merchantDetailsForThirdParty/txnVerification');
        $paymentUrl = $production
            ? 'https://clientapi.fonepay.com/api/merchantRequest'
            : 'https://dev-clientapi.fonepay.com/api/merchantRequest';
        return new self($merchantCode, $secretKey, $username, $password, $paymentUrl, $txnUrl);
    }

    // Paisa to Fonepay's rupee text: 10000 -> "100", 10050 -> "100.50".
    // DV signs the exact text, so format once and reuse the same string ("100" vs "100.00" fails).
    private static function rupees(int $paisa): string
    {
        $whole = intdiv($paisa, 100);
        $rest = $paisa % 100;
        return $rest === 0 ? (string) $whole : sprintf('%d.%02d', $whole, $rest);
    }

    // Today as MM/DD/YYYY in Nepal. Nepal is UTC+05:45 all year, with no daylight saving.
    private static function nepalDate(): string
    {
        return (new \\DateTimeImmutable('now', new \\DateTimeZone('+05:45')))->format('m/d/Y');
    }`,
      sign: `    // HMAC-SHA512(key, message) as lowercase hex.
    public static function hmacHex(string $key, string $message): string
    {
        return hash_hmac('sha512', $message, $key);
    }

    // Fonepay's DV: the values (no names) joined with ",", signed, uppercase like Fonepay's Java sample.
    private function dv(array $values): string
    {
        return strtoupper(self::hmacHex($this->secretKey, implode(',', $values)));
    }`,
      start: `    // Returns the signed Fonepay URL. The route answers 303 to it and the browser follows.
    public function startPayment(string $attemptId, int $amountPaisa, string $returnUrl, string $description): Start
    {
        if (strlen($returnUrl) > 150) {
            throw new \\InvalidArgumentException('Fonepay: the return URL (RU) must be 150 characters or fewer');
        }
        $params = [
            'PID' => $this->merchantCode,
            'MD' => 'P', // payment mode, always "P"
            'PRN' => $attemptId, // 3 to 25 characters, never reused (a reused PRN gets 409 Duplicate PRN)
            'AMT' => self::rupees($amountPaisa), // rupees; the same string goes into DV
            'CRN' => 'NPR',
            'DT' => self::nepalDate(), // MM/DD/YYYY in Nepal time
            'R1' => preg_replace('/^(.{160}).+$/su', '$1', $description), // shown to the payer, up to 160 characters
            'R2' => 'N/A', // remarks, "N/A" when unused
            'RU' => $returnUrl, // Fonepay appends ?PRN=...&DV=..., so no query string here
        ];
        // DV signs the raw values in this order (the array's order), before URL encoding.
        $params['DV'] = $this->dv(array_values($params));
        return Start::redirect($this->paymentUrl . '?' . http_build_query($params));
    }`,
      confirm: `    // txnVerification paymentStatus -> our status.
    private const STATUSES = ['success' => 'paid', 'pending' => 'pending', 'failed' => 'failed'];
    // The fields Fonepay signs on the return URL, in signing order.
    private const RETURN_FIELDS = ['PRN', 'PID', 'PS', 'RC', 'UID', 'BC', 'INI', 'P_AMT', 'R_AMT'];
    private const TXN_PATH = '/merchant/merchantDetailsForThirdParty/txnVerification';

    // Checks the DV on the return URL. Throws PaymentError if it is missing, forged, or for another payment.
    private function verifyReturn(array $params, string $attemptId): void
    {
        // Hash the values exactly as received: "20.0" turned into "20" no longer matches.
        $expected = $this->dv(array_map(fn (string $f) => (string) ($params[$f] ?? ''), self::RETURN_FIELDS));
        if (empty($params['DV']) || !hash_equals($expected, strtoupper((string) $params['DV']))) {
            throw new PaymentError('Fonepay: missing or bad DV on the return URL');
        }
        if (($params['PRN'] ?? null) !== $attemptId || ($params['PID'] ?? null) !== $this->merchantCode) {
            throw new PaymentError('Fonepay: return is for a different payment');
        }
    }

    // Asks Fonepay for the payment by PRN and amount. Needs no return params, so the reconcile job can use it.
    private function txnVerification(string $prn, string $amount): array
    {
        // The auth header signs the exact body bytes. Build the string once and send that same string:
        // re-serializing an array changes the spacing and Fonepay answers 401. The spacing copies the spec.
        $body = '{"prn": ' . json_encode($prn) . ',"merchantCode": ' . json_encode($this->merchantCode)
            . ',"amount": ' . json_encode($amount) . '}';
        $auth = self::hmacHex($this->secretKey, implode(',', [
            $this->username, $this->password, 'POST', 'application/json', self::TXN_PATH, $body,
        ]));
        $ch = curl_init($this->txnVerificationUrl);
        curl_setopt_array($ch, [
            CURLOPT_POST => true,
            CURLOPT_POSTFIELDS => $body,
            CURLOPT_HTTPHEADER => [
                'Authorization: Basic ' . base64_encode($this->username . ':' . $this->password),
                'auth: ' . $auth,
                'Content-Type: application/json',
            ],
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT => 15,
        ]);
        $raw = curl_exec($ch);
        $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $error = curl_error($ch);
        $data = is_string($raw) ? json_decode($raw, true) : null;
        // A wrong login or a body that differs from the signed one gets 401. Not an answer: retry later.
        if ($code !== 200 || !is_array($data) || !is_string($data['paymentStatus'] ?? null)) {
            throw new \\RuntimeException("Fonepay txnVerification failed: HTTP $code $error " . (is_string($raw) ? $raw : ''));
        }
        return $data;
    }

    // Called from the return route (params = query + body) and from the reconcile job (params = []).
    public function confirmPayment(string $attemptId, int $amountPaisa, ?string $providerRef, array $params): Outcome
    {
        // Fonepay's return carries both; the reconcile job sends neither.
        $returned = !empty($params['DV']) || !empty($params['PRN']);
        if ($returned) {
            $this->verifyReturn($params, $attemptId);
        }

        if ($this->username === '' || $this->password === '') {
            // Sandbox without a panel login, so there is no status API to ask. A signed failure or
            // cancel is final; a signed success stays pending because nothing confirmed it.
            if ($returned && ($params['PS'] ?? '') !== 'true') {
                return new Outcome(($params['RC'] ?? '') === 'cancel' ? 'canceled' : 'failed', ($params['UID'] ?? '') ?: null);
            }
            return new Outcome('pending', null);
        }

        // The real answer. Send the STORED amount, never one from the return URL.
        $body = $this->txnVerification($attemptId, self::rupees($amountPaisa));
        // requestedAmount is what this PRN was created for. It has to be what we stored.
        $requested = $body['requestedAmount'] ?? null;
        if (!is_numeric($requested) || (int) round((float) $requested * 100) !== $amountPaisa) {
            throw new PaymentError('Fonepay: amount mismatch (' . json_encode($requested) . ')');
        }
        // Unknown values count as pending, so the reconcile job keeps asking.
        $status = self::STATUSES[strtolower($body['paymentStatus'])] ?? 'pending';
        $ref = $body['fonepayTraceId'] ?? ($returned ? ($params['UID'] ?? null) : null); // Fonepay's trace id, for support
        return new Outcome($status, $ref === null || $ref === '' ? null : (string) $ref);
    }
}`,
    },
  },
  go: {
    file: "payments/fonepay.go",
    lang: "go",
    parts: {
      config: `package payments

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha512"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

// Fonepay is the Fonepay web payment gateway. Sandbox (Fonepay's dev gateway) unless FONEPAY_ENV=production.
type Fonepay struct {
	merchantCode, secretKey, username, password string
	paymentURL, txnVerificationURL              string
	client                                      *http.Client
}

func NewFonepay() *Fonepay {
	production := os.Getenv("FONEPAY_ENV") == "production"
	f := &Fonepay{
		merchantCode: os.Getenv("FONEPAY_MERCHANT_CODE"),
		secretKey:    os.Getenv("FONEPAY_SECRET_KEY"),
		// Merchant-panel login for txnVerification. Fonepay publishes none for the dev gateway.
		username:   os.Getenv("FONEPAY_USERNAME"),
		password:   os.Getenv("FONEPAY_PASSWORD"),
		paymentURL: "https://dev-clientapi.fonepay.com/api/merchantRequest",
		// The dev host is not in public DNS. Fonepay gives you a reachable one during onboarding.
		txnVerificationURL: "https://dev-merchantapi.fonepay.com/api/merchant/merchantDetailsForThirdParty/txnVerification",
		client:             &http.Client{Timeout: 15 * time.Second},
	}
	if production {
		f.paymentURL = "https://clientapi.fonepay.com/api/merchantRequest"
		f.txnVerificationURL = "https://merchantapi.fonepay.com/api/merchant/merchantDetailsForThirdParty/txnVerification"
		if f.username == "" || f.password == "" {
			panic("set FONEPAY_USERNAME and FONEPAY_PASSWORD")
		}
	} else {
		// Sandbox defaults are the dev merchant from Fonepay's docs. Production needs your own.
		if f.merchantCode == "" {
			f.merchantCode = "NBQM"
		}
		if f.secretKey == "" {
			f.secretKey = "a7e3512f5032480a83137793cb2021dc"
		}
	}
	if u := os.Getenv("FONEPAY_TXN_VERIFICATION_URL"); u != "" {
		f.txnVerificationURL = u
	}
	if f.merchantCode == "" || f.secretKey == "" {
		panic("set FONEPAY_MERCHANT_CODE and FONEPAY_SECRET_KEY")
	}
	return f
}

// fonepayRupees turns paisa into Fonepay's rupee text: 10000 -> "100", 10050 -> "100.50".
// DV signs the exact text, so format once and reuse the same string ("100" vs "100.00" fails).
func fonepayRupees(paisa int64) string {
	if paisa%100 == 0 {
		return strconv.FormatInt(paisa/100, 10)
	}
	return fmt.Sprintf("%d.%02d", paisa/100, paisa%100)
}

// fonepayDate is today as MM/DD/YYYY in Nepal. Nepal is UTC+05:45 all year, with no daylight saving.
func fonepayDate() string {
	return time.Now().In(time.FixedZone("NPT", 5*3600+45*60)).Format("01/02/2006")
}`,
      sign: `// FonepayHMAC returns HMAC-SHA512(key, message) as lowercase hex.
func FonepayHMAC(key, message string) string {
	mac := hmac.New(sha512.New, []byte(key))
	mac.Write([]byte(message))
	return hex.EncodeToString(mac.Sum(nil))
}

// dv is Fonepay's DV: the values (no names) joined with ",", signed, uppercase like Fonepay's Java sample.
func (f *Fonepay) dv(values ...string) string {
	return strings.ToUpper(FonepayHMAC(f.secretKey, strings.Join(values, ",")))
}`,
      start: `// StartPayment returns the signed Fonepay URL. The route answers 303 to it and the browser follows.
func (f *Fonepay) StartPayment(ctx context.Context, in StartInput) (Start, error) {
	if len(in.ReturnURL) > 150 {
		return Start{}, errors.New("fonepay: the return URL (RU) must be 150 characters or fewer")
	}
	r1 := []rune(in.Description)
	if len(r1) > 160 {
		r1 = r1[:160] // shown to the payer, up to 160 characters
	}
	amt := fonepayRupees(in.AmountPaisa) // rupees; the same string goes into DV
	dt := fonepayDate()                  // MM/DD/YYYY in Nepal time
	q := url.Values{
		"PID": {f.merchantCode},
		"MD":  {"P"},          // payment mode, always "P"
		"PRN": {in.AttemptID}, // 3 to 25 characters, never reused (a reused PRN gets 409 Duplicate PRN)
		"AMT": {amt},
		"CRN": {"NPR"},
		"DT":  {dt},
		"R1":  {string(r1)},
		"R2":  {"N/A"},        // remarks, "N/A" when unused
		"RU":  {in.ReturnURL}, // Fonepay appends ?PRN=...&DV=..., so no query string here
	}
	// DV signs the raw values in this order, before URL encoding.
	q.Set("DV", f.dv(f.merchantCode, "P", in.AttemptID, amt, "NPR", dt, string(r1), "N/A", in.ReturnURL))
	return Start{Type: "redirect", URL: f.paymentURL + "?" + q.Encode()}, nil
}`,
      confirm: `// fonepayStatuses maps txnVerification's paymentStatus to ours.
var fonepayStatuses = map[string]string{"success": "paid", "pending": "pending", "failed": "failed"}

// fonepayReturnFields are the fields Fonepay signs on the return URL, in signing order.
var fonepayReturnFields = []string{"PRN", "PID", "PS", "RC", "UID", "BC", "INI", "P_AMT", "R_AMT"}

const fonepayTxnPath = "/merchant/merchantDetailsForThirdParty/txnVerification"

// verifyReturn checks the DV on the return URL.
// It returns an ErrPayment error if the DV is missing, forged, or for another payment.
func (f *Fonepay) verifyReturn(params map[string]string, attemptID string) error {
	// Hash the values exactly as received: "20.0" turned into "20" no longer matches.
	values := make([]string, len(fonepayReturnFields))
	for i, name := range fonepayReturnFields {
		values[i] = params[name]
	}
	expected := f.dv(values...)
	if params["DV"] == "" || !hmac.Equal([]byte(expected), []byte(strings.ToUpper(params["DV"]))) {
		return fmt.Errorf("%w: missing or bad DV on the Fonepay return URL", ErrPayment)
	}
	if params["PRN"] != attemptID || params["PID"] != f.merchantCode {
		return fmt.Errorf("%w: Fonepay return is for a different payment", ErrPayment)
	}
	return nil
}

// txnVerification asks Fonepay for the payment by PRN and amount.
// It needs no return params, so the reconcile job can use it.
func (f *Fonepay) txnVerification(ctx context.Context, prn, amount string) (map[string]any, error) {
	// The auth header signs the exact body bytes. Build the string once and send that same string:
	// json.Marshal of a struct drops the spaces and Fonepay answers 401. The spacing copies the spec.
	quote := func(s string) string { b, _ := json.Marshal(s); return string(b) }
	body := \`{"prn": \` + quote(prn) + \`,"merchantCode": \` + quote(f.merchantCode) + \`,"amount": \` + quote(amount) + \`}\`
	auth := FonepayHMAC(f.secretKey, strings.Join([]string{f.username, f.password, "POST", "application/json", fonepayTxnPath, body}, ","))
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, f.txnVerificationURL, strings.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.SetBasicAuth(f.username, f.password)
	req.Header.Set("auth", auth)
	req.Header.Set("Content-Type", "application/json")
	res, err := f.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("fonepay txnVerification failed: %w", err)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	// UseNumber keeps fonepayTraceId and amounts as Fonepay wrote them.
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var data map[string]any
	// A wrong login or a body that differs from the signed one gets 401. Not an answer: retry later.
	if err := dec.Decode(&data); err != nil || res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("fonepay txnVerification failed: HTTP %s %.300s", res.Status, raw)
	}
	if _, ok := data["paymentStatus"].(string); !ok {
		return nil, fmt.Errorf("fonepay txnVerification failed: no paymentStatus in %.300s", raw)
	}
	return data, nil
}

// ConfirmPayment is called from the return route (Params = query + body) and from the reconcile job (empty Params).
func (f *Fonepay) ConfirmPayment(ctx context.Context, in ConfirmInput) (Outcome, error) {
	p := in.Params
	returned := p["DV"] != "" || p["PRN"] != "" // Fonepay's return carries both; the reconcile job sends neither
	if returned {
		if err := f.verifyReturn(p, in.AttemptID); err != nil {
			return Outcome{}, err
		}
	}

	if f.username == "" || f.password == "" {
		// Sandbox without a panel login, so there is no status API to ask. A signed failure or
		// cancel is final; a signed success stays pending because nothing confirmed it.
		if returned && p["PS"] != "true" {
			if p["RC"] == "cancel" {
				return Outcome{Status: "canceled", ProviderRef: p["UID"]}, nil
			}
			return Outcome{Status: "failed", ProviderRef: p["UID"]}, nil
		}
		return Outcome{Status: "pending"}, nil
	}

	// The real answer. Send the STORED amount, never one from the return URL.
	body, err := f.txnVerification(ctx, in.AttemptID, fonepayRupees(in.AmountPaisa))
	if err != nil {
		return Outcome{}, err
	}
	// requestedAmount is what this PRN was created for. It has to be what we stored.
	requested, err := strconv.ParseFloat(fmt.Sprint(body["requestedAmount"]), 64)
	if err != nil || int64(math.Round(requested*100)) != in.AmountPaisa {
		return Outcome{}, fmt.Errorf("%w: Fonepay amount mismatch (%v)", ErrPayment, body["requestedAmount"])
	}
	out := Outcome{Status: "pending"} // unknown values count as pending, so the reconcile job keeps asking
	if s, ok := fonepayStatuses[strings.ToLower(body["paymentStatus"].(string))]; ok {
		out.Status = s
	}
	if ref, ok := body["fonepayTraceId"]; ok && ref != nil { // Fonepay's trace id, for support
		out.ProviderRef = fmt.Sprint(ref)
	} else if returned {
		out.ProviderRef = p["UID"]
	}
	return out, nil
}`,
    },
  },
  java: {
    file: "src/main/java/payments/FonepayGateway.java",
    lang: "java",
    parts: {
      config: `package payments;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.TextNode;
import java.io.IOException;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.time.Duration;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

// Fonepay web payment. Sandbox (Fonepay's dev gateway) unless FONEPAY_ENV=production.
public final class FonepayGateway implements Gateway {
    private static final ObjectMapper JSON = new ObjectMapper();
    private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build();
    private final String merchantCode, secretKey, username, password, paymentUrl, txnVerificationUrl;

    public FonepayGateway(String merchantCode, String secretKey, String username, String password,
                          String paymentUrl, String txnVerificationUrl) {
        this.merchantCode = merchantCode;
        this.secretKey = secretKey;
        this.username = username;
        this.password = password;
        this.paymentUrl = paymentUrl;
        this.txnVerificationUrl = txnVerificationUrl;
    }

    public static FonepayGateway fromEnv() {
        boolean production = "production".equals(System.getenv("FONEPAY_ENV"));
        // Sandbox defaults are the dev merchant from Fonepay's docs. Production needs your own.
        String merchantCode = envOr("FONEPAY_MERCHANT_CODE", production ? "" : "NBQM");
        String secretKey = envOr("FONEPAY_SECRET_KEY", production ? "" : "a7e3512f5032480a83137793cb2021dc");
        // Merchant-panel login for txnVerification. Fonepay publishes none for the dev gateway.
        String username = envOr("FONEPAY_USERNAME", "");
        String password = envOr("FONEPAY_PASSWORD", "");
        if (merchantCode.isEmpty() || secretKey.isEmpty()) {
            throw new IllegalStateException("Set FONEPAY_MERCHANT_CODE and FONEPAY_SECRET_KEY");
        }
        if (production && (username.isEmpty() || password.isEmpty())) {
            throw new IllegalStateException("Set FONEPAY_USERNAME and FONEPAY_PASSWORD");
        }
        // The dev txnVerification host is not in public DNS. Fonepay gives you a reachable one during onboarding.
        String txnUrl = envOr("FONEPAY_TXN_VERIFICATION_URL", production
            ? "https://merchantapi.fonepay.com/api/merchant/merchantDetailsForThirdParty/txnVerification"
            : "https://dev-merchantapi.fonepay.com/api/merchant/merchantDetailsForThirdParty/txnVerification");
        String paymentUrl = production
            ? "https://clientapi.fonepay.com/api/merchantRequest"
            : "https://dev-clientapi.fonepay.com/api/merchantRequest";
        return new FonepayGateway(merchantCode, secretKey, username, password, paymentUrl, txnUrl);
    }

    private static String envOr(String name, String fallback) {
        String value = System.getenv(name);
        return value != null ? value : fallback;
    }

    // Paisa to Fonepay's rupee text: 10000 -> "100", 10050 -> "100.50".
    // DV signs the exact text, so format once and reuse the same string ("100" vs "100.00" fails).
    static String rupees(long paisa) {
        return paisa % 100 == 0 ? Long.toString(paisa / 100) : String.format(Locale.ROOT, "%d.%02d", paisa / 100, paisa % 100);
    }

    // Today as MM/DD/YYYY in Nepal. Nepal is UTC+05:45 all year, with no daylight saving.
    static String nepalDate() {
        return OffsetDateTime.now(ZoneOffset.ofHoursMinutes(5, 45)).format(DateTimeFormatter.ofPattern("MM/dd/yyyy"));
    }`,
      sign: `    // HMAC-SHA512(key, message) as lowercase hex.
    public static String hmacHex(String key, String message) {
        try {
            Mac mac = Mac.getInstance("HmacSHA512");
            mac.init(new SecretKeySpec(key.getBytes(StandardCharsets.UTF_8), "HmacSHA512"));
            return HexFormat.of().formatHex(mac.doFinal(message.getBytes(StandardCharsets.UTF_8)));
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException(e);
        }
    }

    // Fonepay's DV: the values (no names) joined with ",", signed, uppercase like Fonepay's Java sample.
    private String dv(List<String> values) {
        return hmacHex(secretKey, String.join(",", values)).toUpperCase(Locale.ROOT);
    }`,
      start: `    // Returns the signed Fonepay URL. The route answers 303 to it and the browser follows.
    @Override
    public Start startPayment(String attemptId, long amountPaisa, String returnUrl, String description) {
        if (returnUrl.length() > 150) {
            throw new IllegalArgumentException("Fonepay: the return URL (RU) must be 150 characters or fewer");
        }
        Map<String, String> params = new LinkedHashMap<>();
        params.put("PID", merchantCode);
        params.put("MD", "P"); // payment mode, always "P"
        params.put("PRN", attemptId); // 3 to 25 characters, never reused (a reused PRN gets 409 Duplicate PRN)
        params.put("AMT", rupees(amountPaisa)); // rupees; the same string goes into DV
        params.put("CRN", "NPR");
        params.put("DT", nepalDate()); // MM/DD/YYYY in Nepal time
        params.put("R1", description.length() > 160 ? description.substring(0, 160) : description); // shown to the payer
        params.put("R2", "N/A"); // remarks, "N/A" when unused
        params.put("RU", returnUrl); // Fonepay appends ?PRN=...&DV=..., so no query string here
        // DV signs the raw values in this order (the map keeps insertion order), before URL encoding.
        params.put("DV", dv(List.copyOf(params.values())));
        List<String> query = new ArrayList<>();
        params.forEach((k, v) -> query.add(k + "=" + URLEncoder.encode(v, StandardCharsets.UTF_8)));
        return new Start.Redirect(paymentUrl + "?" + String.join("&", query), null);
    }`,
      confirm: `    // txnVerification paymentStatus -> our status.
    private static final Map<String, String> STATUSES = Map.of("success", "paid", "pending", "pending", "failed", "failed");
    // The fields Fonepay signs on the return URL, in signing order.
    private static final List<String> RETURN_FIELDS = List.of("PRN", "PID", "PS", "RC", "UID", "BC", "INI", "P_AMT", "R_AMT");
    private static final String TXN_PATH = "/merchant/merchantDetailsForThirdParty/txnVerification";

    // Checks the DV on the return URL. Throws PaymentException if it is missing, forged, or for another payment.
    private void verifyReturn(Map<String, String> params, String attemptId) {
        // Hash the values exactly as received: "20.0" turned into "20" no longer matches.
        List<String> values = new ArrayList<>();
        for (String f : RETURN_FIELDS) values.add(params.getOrDefault(f, ""));
        String expected = dv(values);
        String got = params.getOrDefault("DV", "").toUpperCase(Locale.ROOT);
        if (got.isEmpty() || !MessageDigest.isEqual(expected.getBytes(StandardCharsets.UTF_8), got.getBytes(StandardCharsets.UTF_8))) {
            throw new PaymentException("Fonepay: missing or bad DV on the return URL");
        }
        if (!attemptId.equals(params.get("PRN")) || !merchantCode.equals(params.get("PID"))) {
            throw new PaymentException("Fonepay: return is for a different payment");
        }
    }

    // Asks Fonepay for the payment by PRN and amount. Needs no return params, so the reconcile job can use it.
    private JsonNode txnVerification(String prn, String amount) {
        // The auth header signs the exact body bytes. Build the string once and send that same string:
        // ObjectMapper drops the spaces and Fonepay answers 401. The spacing copies the spec.
        String body = "{\\"prn\\": " + new TextNode(prn) + ",\\"merchantCode\\": " + new TextNode(merchantCode)
            + ",\\"amount\\": " + new TextNode(amount) + "}";
        String auth = hmacHex(secretKey, String.join(",", username, password, "POST", "application/json", TXN_PATH, body));
        String basic = Base64.getEncoder().encodeToString((username + ":" + password).getBytes(StandardCharsets.UTF_8));
        HttpRequest request = HttpRequest.newBuilder(URI.create(txnVerificationUrl))
            .timeout(Duration.ofSeconds(15))
            .header("Authorization", "Basic " + basic)
            .header("auth", auth)
            .header("Content-Type", "application/json")
            .POST(HttpRequest.BodyPublishers.ofString(body, StandardCharsets.UTF_8))
            .build();
        HttpResponse<String> res;
        JsonNode data;
        try {
            res = http.send(request, HttpResponse.BodyHandlers.ofString());
            data = JSON.readTree(res.body());
        } catch (IOException e) {
            throw new IllegalStateException("Fonepay txnVerification failed: " + e.getMessage(), e);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("Fonepay txnVerification interrupted", e);
        }
        // A wrong login or a body that differs from the signed one gets 401. Not an answer: retry later.
        if (res.statusCode() != 200 || data == null || !data.path("paymentStatus").isTextual()) {
            throw new IllegalStateException("Fonepay txnVerification failed: HTTP " + res.statusCode() + " " + res.body());
        }
        return data;
    }

    // Called from the return route (params = query + body) and from the reconcile job (empty params).
    @Override
    public Outcome confirmPayment(String attemptId, long amountPaisa, String providerRef, Map<String, String> params) {
        // Fonepay's return carries both; the reconcile job sends neither.
        boolean returned = !params.getOrDefault("DV", "").isEmpty() || !params.getOrDefault("PRN", "").isEmpty();
        if (returned) verifyReturn(params, attemptId);
        String uid = params.getOrDefault("UID", "").isEmpty() ? null : params.get("UID");

        if (username.isEmpty() || password.isEmpty()) {
            // Sandbox without a panel login, so there is no status API to ask. A signed failure or
            // cancel is final; a signed success stays pending because nothing confirmed it.
            if (returned && !"true".equals(params.get("PS"))) {
                return new Outcome("cancel".equals(params.get("RC")) ? "canceled" : "failed", uid);
            }
            return new Outcome("pending", null);
        }

        // The real answer. Send the STORED amount, never one from the return URL.
        JsonNode body = txnVerification(attemptId, rupees(amountPaisa));
        // requestedAmount is what this PRN was created for. It has to be what we stored.
        JsonNode requested = body.path("requestedAmount");
        double amount = requested.isNumber() || requested.isTextual() ? requested.asDouble(Double.NaN) : Double.NaN;
        if (Double.isNaN(amount) || Math.round(amount * 100) != amountPaisa) {
            throw new PaymentException("Fonepay: amount mismatch (" + requested + ")");
        }
        // Unknown values count as pending, so the reconcile job keeps asking.
        String status = STATUSES.getOrDefault(body.get("paymentStatus").asText().toLowerCase(Locale.ROOT), "pending");
        JsonNode trace = body.path("fonepayTraceId"); // Fonepay's trace id, for support
        String ref = trace.isNumber() || trace.isTextual() ? trace.asText() : (returned ? uid : null);
        return new Outcome(status, ref);
    }
}`,
    },
  },
  kotlin: {
    file: "src/main/kotlin/payments/FonepayGateway.kt",
    lang: "kotlin",
    parts: {
      config: `package payments

import java.net.URI
import java.net.URLEncoder
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.security.MessageDigest
import java.time.Duration
import java.time.OffsetDateTime
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import java.util.Base64
import java.util.HexFormat
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec
import kotlin.math.roundToLong
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

// Fonepay web payment. Sandbox (Fonepay's dev gateway) unless FONEPAY_ENV=production.
class FonepayGateway(
    private val merchantCode: String,
    private val secretKey: String,
    private val username: String,
    private val password: String,
    private val paymentUrl: String,
    private val txnVerificationUrl: String,
) : Gateway {
    private val http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build()

    companion object {
        fun fromEnv(): FonepayGateway {
            val production = System.getenv("FONEPAY_ENV") == "production"
            // Sandbox defaults are the dev merchant from Fonepay's docs. Production needs your own.
            val merchantCode = System.getenv("FONEPAY_MERCHANT_CODE") ?: if (production) "" else "NBQM"
            val secretKey = System.getenv("FONEPAY_SECRET_KEY") ?: if (production) "" else "a7e3512f5032480a83137793cb2021dc"
            // Merchant-panel login for txnVerification. Fonepay publishes none for the dev gateway.
            val username = System.getenv("FONEPAY_USERNAME") ?: ""
            val password = System.getenv("FONEPAY_PASSWORD") ?: ""
            check(merchantCode.isNotEmpty() && secretKey.isNotEmpty()) { "Set FONEPAY_MERCHANT_CODE and FONEPAY_SECRET_KEY" }
            check(!production || (username.isNotEmpty() && password.isNotEmpty())) { "Set FONEPAY_USERNAME and FONEPAY_PASSWORD" }
            // The dev txnVerification host is not in public DNS. Fonepay gives you a reachable one during onboarding.
            val txnUrl = System.getenv("FONEPAY_TXN_VERIFICATION_URL") ?: if (production) {
                "https://merchantapi.fonepay.com/api/merchant/merchantDetailsForThirdParty/txnVerification"
            } else {
                "https://dev-merchantapi.fonepay.com/api/merchant/merchantDetailsForThirdParty/txnVerification"
            }
            val paymentUrl = if (production) {
                "https://clientapi.fonepay.com/api/merchantRequest"
            } else {
                "https://dev-clientapi.fonepay.com/api/merchantRequest"
            }
            return FonepayGateway(merchantCode, secretKey, username, password, paymentUrl, txnUrl)
        }

        // Paisa to Fonepay's rupee text: 10000 -> "100", 10050 -> "100.50".
        // DV signs the exact text, so format once and reuse the same string ("100" vs "100.00" fails).
        fun rupees(paisa: Long): String =
            if (paisa % 100 == 0L) "\${paisa / 100}" else "\${paisa / 100}.\${(paisa % 100).toString().padStart(2, '0')}"

        // Today as MM/DD/YYYY in Nepal. Nepal is UTC+05:45 all year, with no daylight saving.
        fun nepalDate(): String =
            OffsetDateTime.now(ZoneOffset.ofHoursMinutes(5, 45)).format(DateTimeFormatter.ofPattern("MM/dd/yyyy"))
    }`,
      sign: `    // HMAC-SHA512(key, message) as lowercase hex.
    fun hmacHex(key: String, message: String): String {
        val mac = Mac.getInstance("HmacSHA512")
        mac.init(SecretKeySpec(key.toByteArray(), "HmacSHA512"))
        return HexFormat.of().formatHex(mac.doFinal(message.toByteArray()))
    }

    // Fonepay's DV: the values (no names) joined with ",", signed, uppercase like Fonepay's Java sample.
    private fun dv(values: List<String>): String = hmacHex(secretKey, values.joinToString(",")).uppercase()

    // Constant-time comparison, so response timing leaks nothing about the right value.
    private fun safeEqual(a: String, b: String) = MessageDigest.isEqual(a.toByteArray(), b.toByteArray())`,
      start: `    // Returns the signed Fonepay URL. The route answers 303 to it and the browser follows.
    override suspend fun startPayment(attemptId: String, amountPaisa: Long, returnUrl: String, description: String): Start {
        require(returnUrl.length <= 150) { "Fonepay: the return URL (RU) must be 150 characters or fewer" }
        val params = linkedMapOf(
            "PID" to merchantCode,
            "MD" to "P", // payment mode, always "P"
            "PRN" to attemptId, // 3 to 25 characters, never reused (a reused PRN gets 409 Duplicate PRN)
            "AMT" to rupees(amountPaisa), // rupees; the same string goes into DV
            "CRN" to "NPR",
            "DT" to nepalDate(), // MM/DD/YYYY in Nepal time
            "R1" to description.take(160), // shown to the payer, up to 160 characters
            "R2" to "N/A", // remarks, "N/A" when unused
            "RU" to returnUrl, // Fonepay appends ?PRN=...&DV=..., so no query string here
        )
        // DV signs the raw values in this order (linkedMapOf keeps insertion order), before URL encoding.
        params["DV"] = dv(params.values.toList())
        val query = params.entries.joinToString("&") { (k, v) -> "$k=\${URLEncoder.encode(v, Charsets.UTF_8)}" }
        return Start.Redirect("$paymentUrl?$query")
    }`,
      confirm: `    // txnVerification paymentStatus -> our status.
    private val statuses = mapOf("success" to "paid", "pending" to "pending", "failed" to "failed")
    // The fields Fonepay signs on the return URL, in signing order.
    private val returnFields = listOf("PRN", "PID", "PS", "RC", "UID", "BC", "INI", "P_AMT", "R_AMT")
    private val txnPath = "/merchant/merchantDetailsForThirdParty/txnVerification"

    // A JSON value as text. JsonPrimitive.content keeps numbers as Fonepay wrote them.
    private fun JsonElement?.text(): String? = (this as? JsonPrimitive)?.takeIf { it !is JsonNull }?.content

    // Checks the DV on the return URL. Throws PaymentException if it is missing, forged, or for another payment.
    private fun verifyReturn(params: Map<String, String>, attemptId: String) {
        // Hash the values exactly as received: "20.0" turned into "20" no longer matches.
        val expected = dv(returnFields.map { params[it] ?: "" })
        val got = params["DV"].orEmpty().uppercase()
        if (got.isEmpty() || !safeEqual(expected, got)) throw PaymentException("Fonepay: missing or bad DV on the return URL")
        if (params["PRN"] != attemptId || params["PID"] != merchantCode) {
            throw PaymentException("Fonepay: return is for a different payment")
        }
    }

    // Asks Fonepay for the payment by PRN and amount. Needs no return params, so the reconcile job can use it.
    private suspend fun txnVerification(prn: String, amount: String): JsonObject {
        // The auth header signs the exact body bytes. Build the string once and send that same string:
        // Json.encodeToString drops the spaces and Fonepay answers 401. The spacing copies the spec.
        val body = """{"prn": \${JsonPrimitive(prn)},"merchantCode": \${JsonPrimitive(merchantCode)},"amount": \${JsonPrimitive(amount)}}"""
        val auth = hmacHex(secretKey, listOf(username, password, "POST", "application/json", txnPath, body).joinToString(","))
        val basic = Base64.getEncoder().encodeToString("$username:$password".toByteArray())
        val request = HttpRequest.newBuilder(URI.create(txnVerificationUrl))
            .timeout(Duration.ofSeconds(15))
            .header("Authorization", "Basic $basic")
            .header("auth", auth)
            .header("Content-Type", "application/json")
            .POST(HttpRequest.BodyPublishers.ofString(body))
            .build()
        val res = withContext(Dispatchers.IO) { http.send(request, HttpResponse.BodyHandlers.ofString()) }
        val data = runCatching { Json.parseToJsonElement(res.body()) as JsonObject }.getOrNull()
        // A wrong login or a body that differs from the signed one gets 401. Not an answer: retry later.
        if (res.statusCode() != 200 || data == null || data["paymentStatus"].text() == null) {
            throw IllegalStateException("Fonepay txnVerification failed: HTTP \${res.statusCode()} \${res.body()}")
        }
        return data
    }

    // Called from the return route (params = query + body) and from the reconcile job (empty params).
    override suspend fun confirmPayment(attemptId: String, amountPaisa: Long, providerRef: String?, params: Map<String, String>): Outcome {
        // Fonepay's return carries both; the reconcile job sends neither.
        val returned = !params["DV"].isNullOrEmpty() || !params["PRN"].isNullOrEmpty()
        if (returned) verifyReturn(params, attemptId)
        val uid = params["UID"]?.takeIf { it.isNotEmpty() }

        if (username.isEmpty() || password.isEmpty()) {
            // Sandbox without a panel login, so there is no status API to ask. A signed failure or
            // cancel is final; a signed success stays pending because nothing confirmed it.
            if (returned && params["PS"] != "true") return Outcome(if (params["RC"] == "cancel") "canceled" else "failed", uid)
            return Outcome("pending")
        }

        // The real answer. Send the STORED amount, never one from the return URL.
        val body = txnVerification(attemptId, rupees(amountPaisa))
        // requestedAmount is what this PRN was created for. It has to be what we stored.
        val requested = body["requestedAmount"].text()?.toDoubleOrNull()
        if (requested == null || (requested * 100).roundToLong() != amountPaisa) {
            throw PaymentException("Fonepay: amount mismatch (\${body["requestedAmount"]})")
        }
        // Unknown values count as pending, so the reconcile job keeps asking.
        val status = statuses[body["paymentStatus"].text()!!.lowercase()] ?: "pending"
        val ref = body["fonepayTraceId"].text() ?: if (returned) uid else null // Fonepay's trace id, for support
        return Outcome(status, ref)
    }
}`,
    },
  },
};

// HMAC-SHA512 vectors, hex. Compare case-insensitively: Fonepay's Java sample prints uppercase, PHP lowercase.
// The first two are from references/fonepay.md section 3 (Fonepay's docs). The request DV is mine: OpenSSL and
// Python agree on it, and the dev gateway answered 303 to that exact request on 2026-11-05.
export const vectors: { use: string; key: string; message: string; signature: string }[] = [
  { use: "Return URL DV", key: "a7e3512f5032480a83137793cb2021dc", message: "d1580724437729,NBQM,true,successful,36463,NICENPKA,9841845631,20.0,30", signature: "667860224021DF1891F7DE873A37B1DEDA720CCDC43F63BC88F86ED20F579E0DE66526D37C71B1D14A8D466E4B740D17D4FF274CD2819FD6ED2AA3D9A89D7C52" },
  { use: "txnVerification auth", key: "a7e3512f5032480a83137793cb2021dc", message: "gnw71090@zwoho.com,Fonepay@12345,POST,application/json,/merchant/merchantDetailsForThirdParty/txnVerification,{\"prn\": \"d1549791827186\",\"merchantCode\": \"NBQM\",\"amount\": \"30\"}", signature: "0d3ebe65246182596de0d417e8e39d37ebe2f5da028c52ae0a33a05062a3bded8a737c3ff82b6f1a6d9442d11cfcb0432d86998af81f481948c0af7b346f4fa2" },
  { use: "Request DV", key: "a7e3512f5032480a83137793cb2021dc", message: "NBQM,P,3f9a1c0d5e7b2a4c6d8e,100,NPR,11/05/2026,Order demo,N/A,http://localhost:3000/pay/return/3f9a1c0d5e7b2a4c6d8e", signature: "61E6ABA5D1CB6F4DCD5B45E416A660A69C1A73A165B9EC2025F2D45AD524C30B3771238665C2CE6EA14877178B9E80F8FDFAC3A15D5443C8FF8B73C19E5E0F80" },
];

export default fonepay;

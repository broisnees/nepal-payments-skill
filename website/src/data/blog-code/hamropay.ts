// Hamro Pay Checkout gateway module, one per language.
// The parts joined with "\n\n" in order (config, sign, http, start, confirm) form the complete file.

export interface GatewayCode {
  file: string;
  lang: string;
  parts: { config: string; sign: string; http: string; start: string; confirm: string };
}

export const hamropay: Record<"ts" | "python" | "php" | "go" | "java" | "kotlin", GatewayCode> = {
  ts: {
    file: "hamropay.ts",
    lang: "typescript",
    parts: {
      config: `import { PaymentError, type ConfirmInput, type Outcome, type PaymentStatus, type Start, type StartInput } from "./payments";

// Hamro Pay Checkout. UAT unless HAMROPAY_ENV=production.
const PRODUCTION = process.env.HAMROPAY_ENV === "production";

// HAMROPAY_API_BASE_URL is optional and overrides the API host (a local mock, for example).
const API = (
  process.env.HAMROPAY_API_BASE_URL ??
  (PRODUCTION ? "https://payclient.hamropatro.com" : "https://uat-payclient.hamropatro.com")
).replace(/\\/$/, "");
// Hamro Pay issues the live gateway host at go-live and doesn't publish it, so production must set it.
const GATEWAY_URL =
  process.env.HAMROPAY_GATEWAY_URL ?? (PRODUCTION ? "" : "https://uat-checkout-pay.hamropatro.com/api/checkout");

// From the merchant portal, Client Credentials. UAT: pay-sandbox.hamropatro.com (signup OTP 000000).
const MERCHANT_ID = process.env.HAMROPAY_MERCHANT_ID ?? "";
const CLIENT_ID = process.env.HAMROPAY_CLIENT_ID ?? "";
const CLIENT_API_KEY = process.env.HAMROPAY_CLIENT_API_KEY ?? "";
const CLIENT_SECRET = process.env.HAMROPAY_CLIENT_SECRET ?? "";
if (!MERCHANT_ID || !CLIENT_ID || !CLIENT_API_KEY || !CLIENT_SECRET || !GATEWAY_URL) {
  throw new Error("Set HAMROPAY_MERCHANT_ID, HAMROPAY_CLIENT_ID, HAMROPAY_CLIENT_API_KEY, HAMROPAY_CLIENT_SECRET (and HAMROPAY_GATEWAY_URL in production)");
}

// Hamro Pay takes Rs 10 to Rs 50,000 per payment.
const MIN_PAISA = 1_000;
const MAX_PAISA = 5_000_000;`,
      sign: `// base64(HMAC-SHA512(key, values joined by ",")) with Web Crypto, so it runs on Node, Bun, Deno and edge runtimes.
// The join has no escaping: ["a,b", "c"] and ["a", "b,c"] would sign the same text, so a comma in a value is refused.
export async function sign(values: string[], key = CLIENT_SECRET): Promise<string> {
  if (values.some((v) => v.includes(","))) throw new PaymentError("Hamro Pay: signed values must not contain commas");
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-512" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(values.join(","))));
  return btoa(String.fromCharCode(...mac));
}`,
      http: `// Hamro Pay's API ends every response early: the chunked body arrives, the final empty chunk never does,
// and the connection drops. Read what arrived and let the JSON parser decide whether it's complete.
async function readJson(res: Response): Promise<any> {
  const reader = res.body?.getReader();
  const parts: Uint8Array[] = [];
  try {
    for (;;) {
      const { done, value } = (await reader?.read()) ?? { done: true, value: undefined };
      if (done) break;
      parts.push(value);
    }
  } catch {
    // cut off mid-stream, as expected
  }
  const bytes = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  parts.reduce((at, p) => (bytes.set(p, at), at + p.length), 0);
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

// POSTs JSON with the three headers every call needs and returns the parsed body.
// \`signed\` lists the values the Signature header covers, in Hamro Pay's order for this call.
// Errors come back gRPC style, {"code": 16, "message": "Unauthorized Request"}, and throw here.
async function post(path: string, payload: unknown, signed: string[]): Promise<Record<string, unknown>> {
  const res = await fetch(\`\${API}\${path}\`, {
    method: "POST",
    headers: {
      "Client-Id": CLIENT_ID,
      "Client-API-Key": CLIENT_API_KEY,
      Signature: await sign(signed),
      "Content-Type": "application/json",
      // The connection is dead after every response, so never put it back in the pool.
      // Hamro Pay's own sample saw every second request fail when it did.
      Connection: "close",
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15_000),
  });
  const body = await readJson(res);
  if (res.status === 200 && body && typeof body === "object") return body;
  if (res.status === 401 || body?.code === 16) {
    throw new Error("Hamro Pay: unauthorized. Check the Client-Id, Client-API-Key and client secret");
  }
  // 3 INVALID_ARGUMENT, 6 ALREADY_EXISTS (a reused merchantTxnId), 11 OUT_OF_RANGE, 5xx: not an answer.
  throw new Error(\`Hamro Pay \${path} failed: HTTP \${res.status} \${JSON.stringify(body)}\`);
}`,
      start: `// Creates a checkout session, then builds the signed form the browser POSTs to Hamro Pay's gateway.
// The sessionId comes back as providerRef. A session lives about 10 minutes.
export async function startPayment(input: StartInput): Promise<Start> {
  if (input.amountPaisa < MIN_PAISA || input.amountPaisa > MAX_PAISA) {
    throw new PaymentError("Hamro Pay takes Rs 10 to Rs 50,000 per payment");
  }
  // Paisa as a string. The Signature covers this exact text, so sign and send the same string.
  const amount = String(input.amountPaisa);
  const session = await post(
    "/v1/checkout/sessionId",
    {
      merchantTxnId: input.attemptId, // 25 chars max, unique per attempt
      merchantId: MERCHANT_ID,
      transactionAmount: amount,
      successRedirectionUrl: input.returnUrl, // Hamro Pay adds ?MerchantTxnId=<attemptId>
      failedRedirectionUrl: input.returnUrl,
      // price is rupees, for display only. Only transactionAmount is charged.
      productList: [{ name: input.description, description: input.description, price: input.amountPaisa / 100, quantity: 1 }],
    },
    [input.attemptId, amount, MERCHANT_ID, CLIENT_ID, CLIENT_API_KEY],
  );
  // No retry: a timeout may still have created the session. The buyer clicks Pay again and gets a new attempt.
  const sessionId = session.sessionId;
  if (typeof sessionId !== "string" || !sessionId) {
    throw new Error(\`Hamro Pay: Create Session returned no sessionId: \${JSON.stringify(session)}\`);
  }
  // Create Session returns no token for the form. It is signed here, because it needs the client secret.
  const token = await sign([MERCHANT_ID, input.attemptId, sessionId, amount, CLIENT_ID, CLIENT_API_KEY]);
  return {
    type: "form",
    action: GATEWAY_URL,
    fields: {
      merchant_id: MERCHANT_ID,
      session_id: sessionId,
      token,
      merchant_transaction_id: input.attemptId,
      remarks: input.description.slice(0, 250),
    },
    providerRef: sessionId,
  };
}`,
      confirm: `// Hamro Pay transaction status -> our status.
const STATUSES: Record<string, PaymentStatus> = {
  COMPLETED: "paid",
  PENDING: "pending",
  PROCESSING: "pending",
  FAILED: "failed",
  CANCELED: "canceled",
  CANCELLED: "canceled",
  NOT_INITIATED: "not_found", // "TRANSACTION NOT INITIATED YET": the buyer never paid
};

// Called from the return route (params = query + body) and from the reconcile job (params = {}).
export async function confirmPayment(input: ConfirmInput): Promise<Outcome> {
  // The redirect carries only ?MerchantTxnId=. It proves nothing, and it has to name this attempt.
  const named = input.params.MerchantTxnId ?? input.params.merchantTxnId;
  if (named && named !== input.attemptId) throw new PaymentError("Hamro Pay: callback is for a different payment");

  // Get Transaction is the real answer, asked with OUR attempt id.
  const body = await post(
    "/v1/checkout/transaction",
    { merchantId: MERCHANT_ID, merchantTxnId: input.attemptId },
    [input.attemptId, MERCHANT_ID, CLIENT_ID, CLIENT_API_KEY],
  );
  // The docs name the echo merchantTransactionId; the live API answers merchantTxnId. Accept either.
  const echoed = body.merchantTransactionId ?? body.merchantTxnId;
  if (echoed != null && echoed !== "" && String(echoed) !== input.attemptId) {
    throw new PaymentError("Hamro Pay: answer is for a different payment");
  }
  // Unknown values count as pending, so the reconcile job keeps asking.
  const key = String(body.status ?? "").toUpperCase();
  const status = Object.hasOwn(STATUSES, key) ? STATUSES[key] : "pending";
  // amount comes back in RUPEES, and is 0 until the payment finishes, so it only counts on COMPLETED.
  if (status === "paid" && Math.round(Number(body.amount) * 100) !== input.amountPaisa) {
    throw new PaymentError(\`Hamro Pay: amount mismatch (\${body.amount})\`);
  }
  const trackingId = typeof body.trackingId === "string" && body.trackingId ? body.trackingId : undefined;
  return { status, providerRef: trackingId };
}`,
    },
  },
  python: {
    file: "hamropay.py",
    lang: "python",
    parts: {
      config: `import base64
import hashlib
import hmac
import http.client
import json
import os
import urllib.error
import urllib.request

from payments import Outcome, PaymentError, Start

# Hamro Pay Checkout. UAT unless HAMROPAY_ENV=production.
PRODUCTION = os.environ.get("HAMROPAY_ENV") == "production"

# HAMROPAY_API_BASE_URL is optional and overrides the API host (a local mock, for example).
API = os.environ.get(
    "HAMROPAY_API_BASE_URL",
    "https://payclient.hamropatro.com" if PRODUCTION else "https://uat-payclient.hamropatro.com",
).rstrip("/")
# Hamro Pay issues the live gateway host at go-live and doesn't publish it, so production must set it.
GATEWAY_URL = os.environ.get(
    "HAMROPAY_GATEWAY_URL", "" if PRODUCTION else "https://uat-checkout-pay.hamropatro.com/api/checkout"
)

# From the merchant portal, Client Credentials. UAT: pay-sandbox.hamropatro.com (signup OTP 000000).
MERCHANT_ID = os.environ.get("HAMROPAY_MERCHANT_ID", "")
CLIENT_ID = os.environ.get("HAMROPAY_CLIENT_ID", "")
CLIENT_API_KEY = os.environ.get("HAMROPAY_CLIENT_API_KEY", "")
CLIENT_SECRET = os.environ.get("HAMROPAY_CLIENT_SECRET", "")
if not (MERCHANT_ID and CLIENT_ID and CLIENT_API_KEY and CLIENT_SECRET and GATEWAY_URL):
    raise RuntimeError("Set HAMROPAY_MERCHANT_ID, HAMROPAY_CLIENT_ID, HAMROPAY_CLIENT_API_KEY, "
                       "HAMROPAY_CLIENT_SECRET (and HAMROPAY_GATEWAY_URL in production)")

# Hamro Pay takes Rs 10 to Rs 50,000 per payment.
MIN_PAISA = 1_000
MAX_PAISA = 5_000_000`,
      sign: `def sign(values: list[str], key: str | None = None) -> str:
    """base64(HMAC-SHA512(key, values joined by ",")), keyed with the client secret unless told otherwise.
    The join has no escaping: ["a,b", "c"] and ["a", "b,c"] would sign the same text, so a comma in a value is refused."""
    if any("," in v for v in values):
        raise PaymentError("Hamro Pay: signed values must not contain commas")
    mac = hmac.new((key or CLIENT_SECRET).encode(), ",".join(values).encode(), hashlib.sha512).digest()
    return base64.b64encode(mac).decode()`,
      http: `def _read(res) -> bytes:
    """Hamro Pay's API ends every response early: the chunked body arrives, the final empty chunk never does,
    and the connection drops. Keep what arrived and let the JSON parser decide whether it's complete."""
    try:
        return res.read()
    except http.client.IncompleteRead as e:
        return e.partial


def _post(path: str, payload: dict, signed: list[str]) -> dict:
    """POSTs JSON with the three headers every call needs and returns the parsed body.
    \`signed\` lists the values the Signature header covers, in Hamro Pay's order for this call.
    Errors come back gRPC style, {"code": 16, "message": "Unauthorized Request"}, and raise here."""
    req = urllib.request.Request(f"{API}{path}", data=json.dumps(payload).encode(), method="POST", headers={
        "Client-Id": CLIENT_ID,
        "Client-API-Key": CLIENT_API_KEY,
        "Signature": sign(signed),
        "Content-Type": "application/json",
        # The connection is dead after every response, so never reuse it. urllib doesn't anyway;
        # the header keeps that true behind a proxy.
        "Connection": "close",
    })
    try:
        with urllib.request.urlopen(req, timeout=15) as res:
            status, raw = res.status, _read(res)
    except urllib.error.HTTPError as e:  # 4xx and 5xx land here, body included
        status, raw = e.code, _read(e)
    try:
        body = json.loads(raw)
    except ValueError:
        body = None
    if status == 200 and isinstance(body, dict):
        return body
    if status == 401 or (isinstance(body, dict) and body.get("code") == 16):
        raise RuntimeError("Hamro Pay: unauthorized. Check the Client-Id, Client-API-Key and client secret")
    # 3 INVALID_ARGUMENT, 6 ALREADY_EXISTS (a reused merchantTxnId), 11 OUT_OF_RANGE, 5xx: not an answer.
    raise RuntimeError(f"Hamro Pay {path} failed: HTTP {status} {body}")`,
      start: `def start_payment(attempt_id: str, amount_paisa: int, return_url: str, description: str) -> Start:
    """Creates a checkout session, then builds the signed form the browser POSTs to Hamro Pay's gateway.
    The sessionId comes back as provider_ref. A session lives about 10 minutes."""
    if not MIN_PAISA <= amount_paisa <= MAX_PAISA:
        raise PaymentError("Hamro Pay takes Rs 10 to Rs 50,000 per payment")
    # Paisa as a string. The Signature covers this exact text, so sign and send the same string.
    amount = str(amount_paisa)
    session = _post("/v1/checkout/sessionId", {
        "merchantTxnId": attempt_id,  # 25 chars max, unique per attempt
        "merchantId": MERCHANT_ID,
        "transactionAmount": amount,
        "successRedirectionUrl": return_url,  # Hamro Pay adds ?MerchantTxnId=<attempt_id>
        "failedRedirectionUrl": return_url,
        # price is rupees, for display only. Only transactionAmount is charged.
        "productList": [{"name": description, "description": description, "price": amount_paisa / 100, "quantity": 1}],
    }, [attempt_id, amount, MERCHANT_ID, CLIENT_ID, CLIENT_API_KEY])
    # No retry: a timeout may still have created the session. The buyer clicks Pay again and gets a new attempt.
    session_id = session.get("sessionId")
    if not isinstance(session_id, str) or not session_id:
        raise RuntimeError(f"Hamro Pay: Create Session returned no sessionId: {session}")
    # Create Session returns no token for the form. It is signed here, because it needs the client secret.
    token = sign([MERCHANT_ID, attempt_id, session_id, amount, CLIENT_ID, CLIENT_API_KEY])
    return Start(type="form", action=GATEWAY_URL, provider_ref=session_id, fields={
        "merchant_id": MERCHANT_ID,
        "session_id": session_id,
        "token": token,
        "merchant_transaction_id": attempt_id,
        "remarks": description[:250],
    })`,
      confirm: `# Hamro Pay transaction status -> our status.
STATUSES = {
    "COMPLETED": "paid",
    "PENDING": "pending",
    "PROCESSING": "pending",
    "FAILED": "failed",
    "CANCELED": "canceled",
    "CANCELLED": "canceled",
    "NOT_INITIATED": "not_found",  # "TRANSACTION NOT INITIATED YET": the buyer never paid
}


def confirm_payment(attempt_id: str, amount_paisa: int, provider_ref: str | None, params: dict[str, str]) -> Outcome:
    """Called from the return route (params = query + body) and from the reconcile job (params = {})."""
    # The redirect carries only ?MerchantTxnId=. It proves nothing, and it has to name this attempt.
    named = params.get("MerchantTxnId") or params.get("merchantTxnId")
    if named and named != attempt_id:
        raise PaymentError("Hamro Pay: callback is for a different payment")

    # Get Transaction is the real answer, asked with OUR attempt id.
    body = _post("/v1/checkout/transaction", {"merchantId": MERCHANT_ID, "merchantTxnId": attempt_id},
                 [attempt_id, MERCHANT_ID, CLIENT_ID, CLIENT_API_KEY])
    # The docs name the echo merchantTransactionId; the live API answers merchantTxnId. Accept either.
    echoed = body.get("merchantTransactionId", body.get("merchantTxnId"))
    if echoed not in (None, "") and str(echoed) != attempt_id:
        raise PaymentError("Hamro Pay: answer is for a different payment")
    # Unknown values count as pending, so the reconcile job keeps asking.
    status = STATUSES.get(str(body.get("status") or "").upper(), "pending")
    # amount comes back in RUPEES, and is 0 until the payment finishes, so it only counts on COMPLETED.
    if status == "paid":
        try:
            paid = round(float(body.get("amount")) * 100)
        except (TypeError, ValueError):
            paid = None
        if paid != amount_paisa:
            raise PaymentError(f"Hamro Pay: amount mismatch ({body.get('amount')})")
    return Outcome(status=status, provider_ref=body.get("trackingId") or None)`,
    },
  },
  php: {
    file: "HamroPayGateway.php",
    lang: "php",
    parts: {
      config: `<?php

declare(strict_types=1);

namespace App\\Payments;

// Hamro Pay Checkout. UAT unless HAMROPAY_ENV=production.
final class HamroPayGateway implements Gateway
{
    // Hamro Pay takes Rs 10 to Rs 50,000 per payment.
    private const MIN_PAISA = 1_000;
    private const MAX_PAISA = 5_000_000;

    public function __construct(
        private string $merchantId,
        private string $clientId,
        private string $clientApiKey,
        private string $clientSecret,
        private string $apiUrl,
        private string $gatewayUrl,
    ) {
        if ($merchantId === '' || $clientId === '' || $clientApiKey === '' || $clientSecret === '' || $gatewayUrl === '') {
            throw new \\RuntimeException('Set HAMROPAY_MERCHANT_ID, HAMROPAY_CLIENT_ID, HAMROPAY_CLIENT_API_KEY, '
                . 'HAMROPAY_CLIENT_SECRET (and HAMROPAY_GATEWAY_URL in production)');
        }
        $this->apiUrl = rtrim($apiUrl, '/');
    }

    public static function fromEnv(): self
    {
        $env = static fn (string $name) => $_ENV[$name] ?? (getenv($name) !== false ? getenv($name) : null);
        $production = $env('HAMROPAY_ENV') === 'production';
        // From the merchant portal, Client Credentials. UAT: pay-sandbox.hamropatro.com (signup OTP 000000).
        return new self(
            (string) $env('HAMROPAY_MERCHANT_ID'),
            (string) $env('HAMROPAY_CLIENT_ID'),
            (string) $env('HAMROPAY_CLIENT_API_KEY'),
            (string) $env('HAMROPAY_CLIENT_SECRET'),
            // HAMROPAY_API_BASE_URL is optional and overrides the API host (a local mock, for example).
            $env('HAMROPAY_API_BASE_URL')
                ?? ($production ? 'https://payclient.hamropatro.com' : 'https://uat-payclient.hamropatro.com'),
            // Hamro Pay issues the live gateway host at go-live and doesn't publish it, so production must set it.
            $env('HAMROPAY_GATEWAY_URL')
                ?? ($production ? '' : 'https://uat-checkout-pay.hamropatro.com/api/checkout'),
        );
    }`,
      sign: `    // base64(HMAC-SHA512(key, values joined by ",")), keyed with the client secret unless told otherwise.
    // The join has no escaping: ["a,b", "c"] and ["a", "b,c"] would sign the same text, so a comma in a value is refused.
    public function sign(array $values, ?string $key = null): string
    {
        foreach ($values as $v) {
            if (str_contains((string) $v, ',')) {
                throw new PaymentError('Hamro Pay: signed values must not contain commas');
            }
        }
        return base64_encode(hash_hmac('sha512', implode(',', $values), $key ?? $this->clientSecret, true));
    }`,
      http: `    // POSTs JSON with the three headers every call needs and returns the parsed body.
    // $signed lists the values the Signature header covers, in Hamro Pay's order for this call.
    // Errors come back gRPC style, {"code": 16, "message": "Unauthorized Request"}, and throw here.
    private function post(string $path, array $payload, array $signed): array
    {
        $ch = curl_init($this->apiUrl . $path);
        // Hamro Pay's API ends every response early: the chunked body arrives, the final empty chunk never
        // does, and the connection drops. curl calls that error 18 and returns false, so collect the bytes
        // as they arrive and let the JSON parser decide whether they're complete.
        $raw = '';
        curl_setopt_array($ch, [
            CURLOPT_POST => true,
            CURLOPT_POSTFIELDS => json_encode($payload),
            CURLOPT_HTTPHEADER => [
                'Client-Id: ' . $this->clientId,
                'Client-API-Key: ' . $this->clientApiKey,
                'Signature: ' . $this->sign($signed),
                'Content-Type: application/json',
                // The connection is dead after every response, so never reuse it.
                // Hamro Pay's own sample saw every second request fail when it did.
                'Connection: close',
            ],
            CURLOPT_FORBID_REUSE => true,
            CURLOPT_WRITEFUNCTION => function ($ch, string $chunk) use (&$raw): int {
                $raw .= $chunk;
                return strlen($chunk);
            },
            CURLOPT_TIMEOUT => 15,
        ]);
        curl_exec($ch);
        $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        if ($raw === '') {
            throw new \\RuntimeException('Hamro Pay request failed: ' . curl_error($ch));
        }
        $body = json_decode($raw, true);
        if ($code === 200 && is_array($body)) {
            return $body;
        }
        if ($code === 401 || (is_array($body) && ($body['code'] ?? null) === 16)) {
            throw new \\RuntimeException('Hamro Pay: unauthorized. Check the Client-Id, Client-API-Key and client secret');
        }
        // 3 INVALID_ARGUMENT, 6 ALREADY_EXISTS (a reused merchantTxnId), 11 OUT_OF_RANGE, 5xx: not an answer.
        throw new \\RuntimeException("Hamro Pay $path failed: HTTP $code $raw");
    }`,
      start: `    // Creates a checkout session, then builds the signed form the browser POSTs to Hamro Pay's gateway.
    // The sessionId comes back as providerRef. A session lives about 10 minutes.
    public function startPayment(string $attemptId, int $amountPaisa, string $returnUrl, string $description): Start
    {
        if ($amountPaisa < self::MIN_PAISA || $amountPaisa > self::MAX_PAISA) {
            throw new PaymentError('Hamro Pay takes Rs 10 to Rs 50,000 per payment');
        }
        // Paisa as a string. The Signature covers this exact text, so sign and send the same string.
        $amount = (string) $amountPaisa;
        $session = $this->post('/v1/checkout/sessionId', [
            'merchantTxnId' => $attemptId, // 25 chars max, unique per attempt
            'merchantId' => $this->merchantId,
            'transactionAmount' => $amount,
            'successRedirectionUrl' => $returnUrl, // Hamro Pay adds ?MerchantTxnId=<attemptId>
            'failedRedirectionUrl' => $returnUrl,
            // price is rupees, for display only. Only transactionAmount is charged.
            'productList' => [['name' => $description, 'description' => $description, 'price' => $amountPaisa / 100, 'quantity' => 1]],
        ], [$attemptId, $amount, $this->merchantId, $this->clientId, $this->clientApiKey]);
        // No retry: a timeout may still have created the session. The buyer clicks Pay again and gets a new attempt.
        $sessionId = $session['sessionId'] ?? null;
        if (!is_string($sessionId) || $sessionId === '') {
            throw new \\RuntimeException('Hamro Pay: Create Session returned no sessionId: ' . json_encode($session));
        }
        // Create Session returns no token for the form. It is signed here, because it needs the client secret.
        $token = $this->sign([$this->merchantId, $attemptId, $sessionId, $amount, $this->clientId, $this->clientApiKey]);
        return Start::form($this->gatewayUrl, [
            'merchant_id' => $this->merchantId,
            'session_id' => $sessionId,
            'token' => $token,
            'merchant_transaction_id' => $attemptId,
            'remarks' => mb_substr($description, 0, 250),
        ], $sessionId);
    }`,
      confirm: `    // Hamro Pay transaction status -> our status.
    private const STATUSES = [
        'COMPLETED' => 'paid',
        'PENDING' => 'pending',
        'PROCESSING' => 'pending',
        'FAILED' => 'failed',
        'CANCELED' => 'canceled',
        'CANCELLED' => 'canceled',
        'NOT_INITIATED' => 'not_found', // "TRANSACTION NOT INITIATED YET": the buyer never paid
    ];

    // Called from the return route (params = query + body) and from the reconcile job (params = []).
    public function confirmPayment(string $attemptId, int $amountPaisa, ?string $providerRef, array $params): Outcome
    {
        // The redirect carries only ?MerchantTxnId=. It proves nothing, and it has to name this attempt.
        $named = (string) ($params['MerchantTxnId'] ?? $params['merchantTxnId'] ?? '');
        if ($named !== '' && $named !== $attemptId) {
            throw new PaymentError('Hamro Pay: callback is for a different payment');
        }

        // Get Transaction is the real answer, asked with OUR attempt id.
        $body = $this->post('/v1/checkout/transaction', ['merchantId' => $this->merchantId, 'merchantTxnId' => $attemptId],
            [$attemptId, $this->merchantId, $this->clientId, $this->clientApiKey]);
        // The docs name the echo merchantTransactionId; the live API answers merchantTxnId. Accept either.
        $echoed = $body['merchantTransactionId'] ?? $body['merchantTxnId'] ?? null;
        if ($echoed !== null && $echoed !== '' && (string) $echoed !== $attemptId) {
            throw new PaymentError('Hamro Pay: answer is for a different payment');
        }
        // Unknown values count as pending, so the reconcile job keeps asking.
        $status = self::STATUSES[strtoupper((string) ($body['status'] ?? ''))] ?? 'pending';
        // amount comes back in RUPEES, and is 0 until the payment finishes, so it only counts on COMPLETED.
        $amount = $body['amount'] ?? null;
        if ($status === 'paid' && (!is_numeric($amount) || (int) round((float) $amount * 100) !== $amountPaisa)) {
            throw new PaymentError('Hamro Pay: amount mismatch (' . json_encode($amount) . ')');
        }
        $trackingId = $body['trackingId'] ?? null;
        return new Outcome($status, is_string($trackingId) && $trackingId !== '' ? $trackingId : null);
    }
}`,
    },
  },
  go: {
    file: "payments/hamropay.go",
    lang: "go",
    parts: {
      config: `package payments

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha512"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
)

// HamroPay is the Hamro Pay Checkout gateway. UAT unless HAMROPAY_ENV=production.
type HamroPay struct {
	merchantID, clientID, clientAPIKey, clientSecret string
	apiURL, gatewayURL                               string
	client                                           *http.Client
}

// Hamro Pay takes Rs 10 to Rs 50,000 per payment.
const (
	hamroPayMinPaisa = 1_000
	hamroPayMaxPaisa = 5_000_000
)

func NewHamroPay() *HamroPay {
	production := os.Getenv("HAMROPAY_ENV") == "production"
	h := &HamroPay{
		// From the merchant portal, Client Credentials. UAT: pay-sandbox.hamropatro.com (signup OTP 000000).
		merchantID:   os.Getenv("HAMROPAY_MERCHANT_ID"),
		clientID:     os.Getenv("HAMROPAY_CLIENT_ID"),
		clientAPIKey: os.Getenv("HAMROPAY_CLIENT_API_KEY"),
		clientSecret: os.Getenv("HAMROPAY_CLIENT_SECRET"),
		apiURL:       "https://uat-payclient.hamropatro.com",
		gatewayURL:   "https://uat-checkout-pay.hamropatro.com/api/checkout",
		client:       &http.Client{Timeout: 15 * time.Second},
	}
	if production {
		h.apiURL = "https://payclient.hamropatro.com"
		// Hamro Pay issues the live gateway host at go-live and doesn't publish it, so production must set it.
		h.gatewayURL = ""
	}
	// HAMROPAY_API_BASE_URL is optional and overrides the API host (a local mock, for example).
	if v := os.Getenv("HAMROPAY_API_BASE_URL"); v != "" {
		h.apiURL = strings.TrimRight(v, "/")
	}
	if v := os.Getenv("HAMROPAY_GATEWAY_URL"); v != "" {
		h.gatewayURL = v
	}
	if h.merchantID == "" || h.clientID == "" || h.clientAPIKey == "" || h.clientSecret == "" || h.gatewayURL == "" {
		panic("set HAMROPAY_MERCHANT_ID, HAMROPAY_CLIENT_ID, HAMROPAY_CLIENT_API_KEY, HAMROPAY_CLIENT_SECRET (and HAMROPAY_GATEWAY_URL in production)")
	}
	return h
}`,
      sign: `// HamroPaySign returns base64(HMAC-SHA512(key, values joined by ",")).
// The join has no escaping: ["a,b", "c"] and ["a", "b,c"] would sign the same text, so a comma in a value is refused.
func HamroPaySign(key string, values ...string) (string, error) {
	for _, v := range values {
		if strings.Contains(v, ",") {
			return "", fmt.Errorf("%w: Hamro Pay signed values must not contain commas", ErrPayment)
		}
	}
	mac := hmac.New(sha512.New, []byte(key))
	mac.Write([]byte(strings.Join(values, ",")))
	return base64.StdEncoding.EncodeToString(mac.Sum(nil)), nil
}`,
      http: `// post sends JSON with the three headers every call needs and decodes the reply into out.
// signed lists the values the Signature header covers, in Hamro Pay's order for this call.
// Errors come back gRPC style, {"code": 16, "message": "Unauthorized Request"}, and return an error here.
func (h *HamroPay) post(ctx context.Context, path string, payload any, out any, signed ...string) error {
	signature, err := HamroPaySign(h.clientSecret, signed...)
	if err != nil {
		return err
	}
	data, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, h.apiURL+path, bytes.NewReader(data))
	if err != nil {
		return err
	}
	req.Header.Set("Client-Id", h.clientID)
	req.Header.Set("Client-API-Key", h.clientAPIKey)
	req.Header.Set("Signature", signature)
	req.Header.Set("Content-Type", "application/json")
	// The connection is dead after every response (see below), so keep it out of the pool. Hamro Pay's own
	// sample saw every second request fail when it didn't. req.Close sends Connection: close.
	req.Close = true
	res, err := h.client.Do(req)
	if err != nil {
		return fmt.Errorf("hamro pay request failed: %w", err)
	}
	defer res.Body.Close()
	// Hamro Pay's API ends every response early: the chunked body arrives, the final empty chunk never
	// does, and the connection drops. Keep what arrived and let the JSON decoder decide.
	raw, err := io.ReadAll(res.Body)
	if err != nil && len(raw) == 0 {
		return fmt.Errorf("hamro pay request failed: %w", err)
	}
	var e struct {
		Code *int \`json:"code"\`
	}
	_ = json.Unmarshal(raw, &e)
	if res.StatusCode == http.StatusUnauthorized || (e.Code != nil && *e.Code == 16) {
		return fmt.Errorf("hamro pay: unauthorized, check the Client-Id, Client-API-Key and client secret")
	}
	// 3 INVALID_ARGUMENT, 6 ALREADY_EXISTS (a reused merchantTxnId), 11 OUT_OF_RANGE, 5xx: not an answer.
	if res.StatusCode != http.StatusOK || json.Unmarshal(raw, out) != nil {
		return fmt.Errorf("hamro pay %s failed: HTTP %d %s", path, res.StatusCode, raw)
	}
	return nil
}`,
      start: `// StartPayment creates a checkout session, then builds the signed form the browser POSTs to Hamro Pay's
// gateway. The sessionId comes back as ProviderRef. A session lives about 10 minutes.
func (h *HamroPay) StartPayment(ctx context.Context, in StartInput) (Start, error) {
	if in.AmountPaisa < hamroPayMinPaisa || in.AmountPaisa > hamroPayMaxPaisa {
		return Start{}, fmt.Errorf("%w: Hamro Pay takes Rs 10 to Rs 50,000 per payment", ErrPayment)
	}
	// Paisa as a string. The Signature covers this exact text, so sign and send the same string.
	amount := strconv.FormatInt(in.AmountPaisa, 10)
	var session struct {
		SessionID string \`json:"sessionId"\`
	}
	err := h.post(ctx, "/v1/checkout/sessionId", map[string]any{
		"merchantTxnId":         in.AttemptID, // 25 chars max, unique per attempt
		"merchantId":            h.merchantID,
		"transactionAmount":     amount,
		"successRedirectionUrl": in.ReturnURL, // Hamro Pay adds ?MerchantTxnId=<AttemptID>
		"failedRedirectionUrl":  in.ReturnURL,
		// price is rupees, for display only. Only transactionAmount is charged.
		"productList": []map[string]any{{
			"name": in.Description, "description": in.Description, "price": float64(in.AmountPaisa) / 100, "quantity": 1,
		}},
	}, &session, in.AttemptID, amount, h.merchantID, h.clientID, h.clientAPIKey)
	// No retry: a timeout may still have created the session. The buyer clicks Pay again and gets a new attempt.
	if err != nil {
		return Start{}, err
	}
	if session.SessionID == "" {
		return Start{}, fmt.Errorf("hamro pay: Create Session returned no sessionId")
	}
	// Create Session returns no token for the form. It is signed here, because it needs the client secret.
	token, err := HamroPaySign(h.clientSecret, h.merchantID, in.AttemptID, session.SessionID, amount, h.clientID, h.clientAPIKey)
	if err != nil {
		return Start{}, err
	}
	remarks := []rune(in.Description)
	if len(remarks) > 250 {
		remarks = remarks[:250]
	}
	return Start{Type: "form", Action: h.gatewayURL, ProviderRef: session.SessionID, Fields: map[string]string{
		"merchant_id":             h.merchantID,
		"session_id":              session.SessionID,
		"token":                   token,
		"merchant_transaction_id": in.AttemptID,
		"remarks":                 string(remarks),
	}}, nil
}`,
      confirm: `// hamroPayStatuses maps Hamro Pay's transaction status to ours.
var hamroPayStatuses = map[string]string{
	"COMPLETED":     "paid",
	"PENDING":       "pending",
	"PROCESSING":    "pending",
	"FAILED":        "failed",
	"CANCELED":      "canceled",
	"CANCELLED":     "canceled",
	"NOT_INITIATED": "not_found", // "TRANSACTION NOT INITIATED YET": the buyer never paid
}

// ConfirmPayment is called from the return route (Params = query + body) and from the reconcile job (empty Params).
func (h *HamroPay) ConfirmPayment(ctx context.Context, in ConfirmInput) (Outcome, error) {
	// The redirect carries only ?MerchantTxnId=. It proves nothing, and it has to name this attempt.
	named := in.Params["MerchantTxnId"]
	if named == "" {
		named = in.Params["merchantTxnId"]
	}
	if named != "" && named != in.AttemptID {
		return Outcome{}, fmt.Errorf("%w: Hamro Pay callback is for a different payment", ErrPayment)
	}

	// Get Transaction is the real answer, asked with OUR attempt id.
	var body struct {
		// The docs name the echo merchantTransactionId; the live API answers merchantTxnId. Accept either.
		MerchantTransactionID *string      \`json:"merchantTransactionId"\`
		MerchantTxnID         *string      \`json:"merchantTxnId"\`
		Status                string       \`json:"status"\`
		Amount                *json.Number \`json:"amount"\`
		TrackingID            string       \`json:"trackingId"\`
	}
	err := h.post(ctx, "/v1/checkout/transaction",
		map[string]string{"merchantId": h.merchantID, "merchantTxnId": in.AttemptID},
		&body, in.AttemptID, h.merchantID, h.clientID, h.clientAPIKey)
	if err != nil {
		return Outcome{}, err
	}
	for _, echoed := range []*string{body.MerchantTransactionID, body.MerchantTxnID} {
		if echoed != nil && *echoed != "" && *echoed != in.AttemptID {
			return Outcome{}, fmt.Errorf("%w: Hamro Pay answer is for a different payment", ErrPayment)
		}
	}
	status, ok := hamroPayStatuses[strings.ToUpper(body.Status)]
	if !ok {
		status = "pending" // unknown values count as pending, so the reconcile job keeps asking
	}
	// amount comes back in RUPEES, and is 0 until the payment finishes, so it only counts on COMPLETED.
	if status == "paid" {
		var rupees float64
		if body.Amount != nil {
			rupees, err = body.Amount.Float64()
		}
		if body.Amount == nil || err != nil || int64(math.Round(rupees*100)) != in.AmountPaisa {
			return Outcome{}, fmt.Errorf("%w: Hamro Pay amount mismatch", ErrPayment)
		}
	}
	return Outcome{Status: status, ProviderRef: body.TrackingID}, nil
}`,
    },
  },
  java: {
    file: "src/main/java/payments/HamroPayGateway.java",
    lang: "java",
    parts: {
      config: `package payments;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.time.Duration;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

// Hamro Pay Checkout. UAT unless HAMROPAY_ENV=production.
public final class HamroPayGateway implements Gateway {
    private static final ObjectMapper JSON = new ObjectMapper();
    // Hamro Pay takes Rs 10 to Rs 50,000 per payment.
    private static final long MIN_PAISA = 1_000, MAX_PAISA = 5_000_000;
    private final String merchantId, clientId, clientApiKey, clientSecret, apiUrl, gatewayUrl;

    public HamroPayGateway(String merchantId, String clientId, String clientApiKey, String clientSecret,
                           String apiUrl, String gatewayUrl) {
        if (merchantId.isEmpty() || clientId.isEmpty() || clientApiKey.isEmpty() || clientSecret.isEmpty() || gatewayUrl.isEmpty()) {
            throw new IllegalStateException("Set HAMROPAY_MERCHANT_ID, HAMROPAY_CLIENT_ID, HAMROPAY_CLIENT_API_KEY, "
                + "HAMROPAY_CLIENT_SECRET (and HAMROPAY_GATEWAY_URL in production)");
        }
        this.merchantId = merchantId;
        this.clientId = clientId;
        this.clientApiKey = clientApiKey;
        this.clientSecret = clientSecret;
        this.apiUrl = apiUrl.replaceAll("/+$", "");
        this.gatewayUrl = gatewayUrl;
    }

    public static HamroPayGateway fromEnv() {
        boolean production = "production".equals(System.getenv("HAMROPAY_ENV"));
        // From the merchant portal, Client Credentials. UAT: pay-sandbox.hamropatro.com (signup OTP 000000).
        return new HamroPayGateway(
            envOr("HAMROPAY_MERCHANT_ID", ""),
            envOr("HAMROPAY_CLIENT_ID", ""),
            envOr("HAMROPAY_CLIENT_API_KEY", ""),
            envOr("HAMROPAY_CLIENT_SECRET", ""),
            // HAMROPAY_API_BASE_URL is optional and overrides the API host (a local mock, for example).
            envOr("HAMROPAY_API_BASE_URL",
                production ? "https://payclient.hamropatro.com" : "https://uat-payclient.hamropatro.com"),
            // Hamro Pay issues the live gateway host at go-live and doesn't publish it, so production must set it.
            envOr("HAMROPAY_GATEWAY_URL", production ? "" : "https://uat-checkout-pay.hamropatro.com/api/checkout"));
    }

    private static String envOr(String name, String fallback) {
        String value = System.getenv(name);
        return value != null ? value : fallback;
    }`,
      sign: `    // base64(HMAC-SHA512(key, values joined by ",")).
    // The join has no escaping: ["a,b", "c"] and ["a", "b,c"] would sign the same text, so a comma in a value is refused.
    public static String sign(String key, String... values) {
        for (String v : values) {
            if (v.contains(",")) throw new PaymentException("Hamro Pay: signed values must not contain commas");
        }
        try {
            Mac mac = Mac.getInstance("HmacSHA512");
            mac.init(new SecretKeySpec(key.getBytes(StandardCharsets.UTF_8), "HmacSHA512"));
            byte[] digest = mac.doFinal(String.join(",", values).getBytes(StandardCharsets.UTF_8));
            return Base64.getEncoder().encodeToString(digest);
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException(e);
        }
    }`,
      http: `    // Hamro Pay's API ends every response early: the chunked body arrives, the final empty chunk never does,
    // and the connection drops. HttpClient's string handler throws on that, so read the stream by hand, keep
    // what arrived, and let the JSON parser decide whether it's complete.
    private static String readAll(InputStream in) {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        try (in) {
            for (int n; (n = in.read(buf)) != -1; ) out.write(buf, 0, n);
        } catch (IOException cutOff) {
            // expected, see above
        }
        return out.toString(StandardCharsets.UTF_8);
    }

    // POSTs JSON with the three headers every call needs and returns the parsed body.
    // signed lists the values the Signature header covers, in Hamro Pay's order for this call.
    // Errors come back gRPC style, {"code": 16, "message": "Unauthorized Request"}, and throw here.
    private JsonNode post(String path, Map<String, Object> payload, String... signed) {
        // The connection is dead after every response (see readAll), so never reuse it. Hamro Pay's own sample
        // saw every second request fail when it did. HttpClient refuses a "Connection: close" header, so each
        // call gets a fresh client with an empty connection pool instead.
        HttpClient http = HttpClient.newBuilder()
            .version(HttpClient.Version.HTTP_1_1)
            .connectTimeout(Duration.ofSeconds(10))
            .build();
        try {
            HttpRequest request = HttpRequest.newBuilder(URI.create(apiUrl + path))
                .timeout(Duration.ofSeconds(15))
                .header("Client-Id", clientId)
                .header("Client-API-Key", clientApiKey)
                .header("Signature", sign(clientSecret, signed))
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(JSON.writeValueAsString(payload)))
                .build();
            HttpResponse<InputStream> res = http.send(request, HttpResponse.BodyHandlers.ofInputStream());
            String raw = readAll(res.body());
            JsonNode body;
            try {
                body = JSON.readTree(raw);
            } catch (JsonProcessingException e) {
                body = null;
            }
            if (res.statusCode() == 200 && body != null && body.isObject()) return body;
            if (res.statusCode() == 401 || (body != null && body.path("code").asInt(-1) == 16)) {
                throw new IllegalStateException("Hamro Pay: unauthorized. Check the Client-Id, Client-API-Key and client secret");
            }
            // 3 INVALID_ARGUMENT, 6 ALREADY_EXISTS (a reused merchantTxnId), 11 OUT_OF_RANGE, 5xx: not an answer.
            throw new IllegalStateException("Hamro Pay " + path + " failed: HTTP " + res.statusCode() + " " + raw);
        } catch (IOException e) {
            throw new IllegalStateException("Hamro Pay request failed: " + e.getMessage(), e);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("Hamro Pay request interrupted", e);
        }
    }`,
      start: `    // Creates a checkout session, then builds the signed form the browser POSTs to Hamro Pay's gateway.
    // The sessionId comes back as providerRef. A session lives about 10 minutes.
    @Override
    public Start startPayment(String attemptId, long amountPaisa, String returnUrl, String description) {
        if (amountPaisa < MIN_PAISA || amountPaisa > MAX_PAISA) {
            throw new PaymentException("Hamro Pay takes Rs 10 to Rs 50,000 per payment");
        }
        // Paisa as a string. The Signature covers this exact text, so sign and send the same string.
        String amount = Long.toString(amountPaisa);
        Map<String, Object> product = Map.of(
            "name", description,
            "description", description,
            "price", BigDecimal.valueOf(amountPaisa, 2), // rupees, for display only. Only transactionAmount is charged.
            "quantity", 1);
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("merchantTxnId", attemptId); // 25 chars max, unique per attempt
        payload.put("merchantId", merchantId);
        payload.put("transactionAmount", amount);
        payload.put("successRedirectionUrl", returnUrl); // Hamro Pay adds ?MerchantTxnId=<attemptId>
        payload.put("failedRedirectionUrl", returnUrl);
        payload.put("productList", List.of(product));
        // No retry: a timeout may still have created the session. The buyer clicks Pay again and gets a new attempt.
        JsonNode session = post("/v1/checkout/sessionId", payload, attemptId, amount, merchantId, clientId, clientApiKey);
        String sessionId = session.path("sessionId").asText("");
        if (sessionId.isEmpty()) throw new IllegalStateException("Hamro Pay: Create Session returned no sessionId: " + session);
        // Create Session returns no token for the form. It is signed here, because it needs the client secret.
        String token = sign(clientSecret, merchantId, attemptId, sessionId, amount, clientId, clientApiKey);
        Map<String, String> fields = new LinkedHashMap<>();
        fields.put("merchant_id", merchantId);
        fields.put("session_id", sessionId);
        fields.put("token", token);
        fields.put("merchant_transaction_id", attemptId);
        fields.put("remarks", description.length() > 250 ? description.substring(0, 250) : description);
        return new Start.Form(gatewayUrl, fields, sessionId, null);
    }`,
      confirm: `    // Hamro Pay transaction status -> our status.
    private static final Map<String, String> STATUSES = Map.of(
        "COMPLETED", "paid",
        "PENDING", "pending",
        "PROCESSING", "pending",
        "FAILED", "failed",
        "CANCELED", "canceled",
        "CANCELLED", "canceled",
        "NOT_INITIATED", "not_found"); // "TRANSACTION NOT INITIATED YET": the buyer never paid

    // Called from the return route (params = query + body) and from the reconcile job (empty params).
    @Override
    public Outcome confirmPayment(String attemptId, long amountPaisa, String providerRef, Map<String, String> params) {
        // The redirect carries only ?MerchantTxnId=. It proves nothing, and it has to name this attempt.
        String named = params.getOrDefault("MerchantTxnId", params.getOrDefault("merchantTxnId", ""));
        if (!named.isEmpty() && !named.equals(attemptId)) {
            throw new PaymentException("Hamro Pay: callback is for a different payment");
        }

        // Get Transaction is the real answer, asked with OUR attempt id.
        JsonNode body = post("/v1/checkout/transaction", Map.of("merchantId", merchantId, "merchantTxnId", attemptId),
            attemptId, merchantId, clientId, clientApiKey);
        // The docs name the echo merchantTransactionId; the live API answers merchantTxnId. Accept either.
        JsonNode echoed = body.has("merchantTransactionId") ? body.get("merchantTransactionId") : body.path("merchantTxnId");
        if (!echoed.isMissingNode() && !echoed.isNull() && !echoed.asText().isEmpty() && !echoed.asText().equals(attemptId)) {
            throw new PaymentException("Hamro Pay: answer is for a different payment");
        }
        // Unknown values count as pending, so the reconcile job keeps asking.
        String status = STATUSES.getOrDefault(body.path("status").asText("").toUpperCase(Locale.ROOT), "pending");
        // amount comes back in RUPEES, and is 0 until the payment finishes, so it only counts on COMPLETED.
        if (status.equals("paid") && paisa(body.path("amount")) != amountPaisa) {
            throw new PaymentException("Hamro Pay: amount mismatch (" + body.path("amount") + ")");
        }
        String trackingId = body.path("trackingId").asText("");
        return new Outcome(status, trackingId.isEmpty() ? null : trackingId);
    }

    // Rupees (a JSON number or numeric string) to paisa, or -1 when it isn't a number.
    private static long paisa(JsonNode rupees) {
        try {
            return new BigDecimal(rupees.asText()).movePointRight(2).setScale(0, RoundingMode.HALF_UP).longValueExact();
        } catch (ArithmeticException | NumberFormatException e) {
            return -1;
        }
    }
}`,
    },
  },
  kotlin: {
    file: "src/main/kotlin/payments/HamroPayGateway.kt",
    lang: "kotlin",
    parts: {
      config: `package payments

import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.math.BigDecimal
import java.math.RoundingMode
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration
import java.util.Base64
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.addJsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray

// Hamro Pay Checkout. UAT unless HAMROPAY_ENV=production.
class HamroPayGateway(
    private val merchantId: String,
    private val clientId: String,
    private val clientApiKey: String,
    private val clientSecret: String,
    apiUrl: String,
    private val gatewayUrl: String,
) : Gateway {
    private val apiUrl = apiUrl.trimEnd('/')

    init {
        check(listOf(merchantId, clientId, clientApiKey, clientSecret, gatewayUrl).all { it.isNotEmpty() }) {
            "Set HAMROPAY_MERCHANT_ID, HAMROPAY_CLIENT_ID, HAMROPAY_CLIENT_API_KEY, HAMROPAY_CLIENT_SECRET (and HAMROPAY_GATEWAY_URL in production)"
        }
    }

    companion object {
        // Hamro Pay takes Rs 10 to Rs 50,000 per payment.
        private const val MIN_PAISA = 1_000L
        private const val MAX_PAISA = 5_000_000L

        fun fromEnv(): HamroPayGateway {
            val production = System.getenv("HAMROPAY_ENV") == "production"
            // From the merchant portal, Client Credentials. UAT: pay-sandbox.hamropatro.com (signup OTP 000000).
            return HamroPayGateway(
                System.getenv("HAMROPAY_MERCHANT_ID") ?: "",
                System.getenv("HAMROPAY_CLIENT_ID") ?: "",
                System.getenv("HAMROPAY_CLIENT_API_KEY") ?: "",
                System.getenv("HAMROPAY_CLIENT_SECRET") ?: "",
                // HAMROPAY_API_BASE_URL is optional and overrides the API host (a local mock, for example).
                System.getenv("HAMROPAY_API_BASE_URL")
                    ?: if (production) "https://payclient.hamropatro.com" else "https://uat-payclient.hamropatro.com",
                // Hamro Pay issues the live gateway host at go-live and doesn't publish it, so production must set it.
                System.getenv("HAMROPAY_GATEWAY_URL")
                    ?: if (production) "" else "https://uat-checkout-pay.hamropatro.com/api/checkout",
            )
        }
    }`,
      sign: `    // base64(HMAC-SHA512(key, values joined by ",")), keyed with the client secret unless told otherwise.
    // The join has no escaping: ["a,b", "c"] and ["a", "b,c"] would sign the same text, so a comma in a value is refused.
    fun sign(vararg values: String, key: String = clientSecret): String {
        if (values.any { "," in it }) throw PaymentException("Hamro Pay: signed values must not contain commas")
        val mac = Mac.getInstance("HmacSHA512")
        mac.init(SecretKeySpec(key.toByteArray(), "HmacSHA512"))
        return Base64.getEncoder().encodeToString(mac.doFinal(values.joinToString(",").toByteArray()))
    }`,
      http: `    // Hamro Pay's API ends every response early: the chunked body arrives, the final empty chunk never does,
    // and the connection drops. HttpClient's string handler throws on that, so read the stream by hand, keep
    // what arrived, and let the JSON parser decide whether it's complete.
    private fun readAll(input: InputStream): String {
        val out = ByteArrayOutputStream()
        try {
            input.use { it.copyTo(out) }
        } catch (cutOff: IOException) {
            // expected, see above
        }
        return out.toString(Charsets.UTF_8)
    }

    // POSTs JSON with the three headers every call needs and returns the parsed body.
    // signed lists the values the Signature header covers, in Hamro Pay's order for this call.
    // Errors come back gRPC style, {"code": 16, "message": "Unauthorized Request"}, and throw here.
    private suspend fun post(path: String, payload: JsonObject, vararg signed: String): JsonObject {
        // The connection is dead after every response (see readAll), so never reuse it. Hamro Pay's own sample
        // saw every second request fail when it did. HttpClient refuses a "Connection: close" header, so each
        // call gets a fresh client with an empty connection pool instead.
        val http = HttpClient.newBuilder()
            .version(HttpClient.Version.HTTP_1_1)
            .connectTimeout(Duration.ofSeconds(10))
            .build()
        val request = HttpRequest.newBuilder(URI.create(apiUrl + path))
            .timeout(Duration.ofSeconds(15))
            .header("Client-Id", clientId)
            .header("Client-API-Key", clientApiKey)
            .header("Signature", sign(*signed))
            .header("Content-Type", "application/json")
            .POST(HttpRequest.BodyPublishers.ofString(payload.toString()))
            .build()
        val (status, raw) = withContext(Dispatchers.IO) {
            val res = http.send(request, HttpResponse.BodyHandlers.ofInputStream())
            res.statusCode() to readAll(res.body())
        }
        val body = runCatching { Json.parseToJsonElement(raw) as JsonObject }.getOrNull()
        if (status == 200 && body != null) return body
        if (status == 401 || (body?.get("code") as? JsonPrimitive)?.intOrNull == 16) {
            throw IllegalStateException("Hamro Pay: unauthorized. Check the Client-Id, Client-API-Key and client secret")
        }
        // 3 INVALID_ARGUMENT, 6 ALREADY_EXISTS (a reused merchantTxnId), 11 OUT_OF_RANGE, 5xx: not an answer.
        throw IllegalStateException("Hamro Pay $path failed: HTTP $status $raw")
    }

    // A JSON string or number as text, null for missing or null.
    private fun JsonElement?.text(): String? = (this as? JsonPrimitive)?.takeIf { it !is JsonNull }?.content`,
      start: `    // Creates a checkout session, then builds the signed form the browser POSTs to Hamro Pay's gateway.
    // The sessionId comes back as providerRef. A session lives about 10 minutes.
    override suspend fun startPayment(attemptId: String, amountPaisa: Long, returnUrl: String, description: String): Start {
        if (amountPaisa !in MIN_PAISA..MAX_PAISA) throw PaymentException("Hamro Pay takes Rs 10 to Rs 50,000 per payment")
        // Paisa as a string. The Signature covers this exact text, so sign and send the same string.
        val amount = amountPaisa.toString()
        val session = post("/v1/checkout/sessionId", buildJsonObject {
            put("merchantTxnId", attemptId) // 25 chars max, unique per attempt
            put("merchantId", merchantId)
            put("transactionAmount", amount)
            put("successRedirectionUrl", returnUrl) // Hamro Pay adds ?MerchantTxnId=<attemptId>
            put("failedRedirectionUrl", returnUrl)
            putJsonArray("productList") {
                addJsonObject {
                    put("name", description)
                    put("description", description)
                    put("price", BigDecimal.valueOf(amountPaisa, 2)) // rupees, for display only. Only transactionAmount is charged.
                    put("quantity", 1)
                }
            }
        }, attemptId, amount, merchantId, clientId, clientApiKey)
        // No retry: a timeout may still have created the session. The buyer clicks Pay again and gets a new attempt.
        val sessionId = session["sessionId"].text()?.takeIf { it.isNotEmpty() }
            ?: throw IllegalStateException("Hamro Pay: Create Session returned no sessionId: $session")
        // Create Session returns no token for the form. It is signed here, because it needs the client secret.
        val token = sign(merchantId, attemptId, sessionId, amount, clientId, clientApiKey)
        return Start.Form(
            gatewayUrl,
            linkedMapOf(
                "merchant_id" to merchantId,
                "session_id" to sessionId,
                "token" to token,
                "merchant_transaction_id" to attemptId,
                "remarks" to description.take(250),
            ),
            sessionId,
        )
    }`,
      confirm: `    // Hamro Pay transaction status -> our status.
    private val statuses = mapOf(
        "COMPLETED" to "paid",
        "PENDING" to "pending",
        "PROCESSING" to "pending",
        "FAILED" to "failed",
        "CANCELED" to "canceled",
        "CANCELLED" to "canceled",
        "NOT_INITIATED" to "not_found", // "TRANSACTION NOT INITIATED YET": the buyer never paid
    )

    // Called from the return route (params = query + body) and from the reconcile job (empty params).
    override suspend fun confirmPayment(attemptId: String, amountPaisa: Long, providerRef: String?, params: Map<String, String>): Outcome {
        // The redirect carries only ?MerchantTxnId=. It proves nothing, and it has to name this attempt.
        val named = params["MerchantTxnId"] ?: params["merchantTxnId"] ?: ""
        if (named.isNotEmpty() && named != attemptId) throw PaymentException("Hamro Pay: callback is for a different payment")

        // Get Transaction is the real answer, asked with OUR attempt id.
        val body = post("/v1/checkout/transaction", buildJsonObject {
            put("merchantId", merchantId)
            put("merchantTxnId", attemptId)
        }, attemptId, merchantId, clientId, clientApiKey)
        // The docs name the echo merchantTransactionId; the live API answers merchantTxnId. Accept either.
        val echoed = body["merchantTransactionId"].text() ?: body["merchantTxnId"].text()
        if (!echoed.isNullOrEmpty() && echoed != attemptId) throw PaymentException("Hamro Pay: answer is for a different payment")
        // Unknown values count as pending, so the reconcile job keeps asking.
        val status = statuses[body["status"].text().orEmpty().uppercase()] ?: "pending"
        // amount comes back in RUPEES, and is 0 until the payment finishes, so it only counts on COMPLETED.
        val paid = body["amount"].text()?.toBigDecimalOrNull()?.movePointRight(2)?.setScale(0, RoundingMode.HALF_UP)?.toLong()
        if (status == "paid" && paid != amountPaisa) throw PaymentException("Hamro Pay: amount mismatch (\${body["amount"]})")
        return Outcome(status, body["trackingId"].text()?.takeIf { it.isNotEmpty() })
    }
}`,
    },
  },
};

// Signature vector from references/hamropay.md section 2: base64(HMAC-SHA512(key, message)).
// printf 'T1,1000,M,C,K' | openssl dgst -sha512 -hmac abcdefg -binary | base64 -w0
export const vectors: { key: string; message: string; signature: string }[] = [
  { key: "abcdefg", message: "T1,1000,M,C,K", signature: "7MhTBtP9MzyiNUg7P/ljNqxHxrUPQSAHhNpAD9bPlacsF2lMj8GAka1pVKD7MSMnNdBLqCwz9SoY4l+2RHdpxA==" },
];

export default hamropay;

// Generated NPS OnePG gateway module, one per language.
// The parts joined with "\n\n" in order (config, sign, call, start, confirm) form the complete file.

export interface GatewayCode {
  file: string;
  lang: string;
  parts: { config: string; sign: string; call: string; start: string; confirm: string };
}

export const nps: Record<"ts" | "python" | "php" | "go" | "java" | "kotlin", GatewayCode> = {
  ts: {
    file: "nps.ts",
    lang: "typescript",
    parts: {
      config: `import { PaymentError, type ConfirmInput, type Outcome, type PaymentStatus, type Start, type StartInput } from "./payments";

// NPS OnePG (Nepal Payment Solution, now NPX). Sandbox unless NPS_ENV=production.
const PRODUCTION = process.env.NPS_ENV === "production";

// Hosts from the NPS developer guide. If your onboarding PDF lists others, set NPS_API_URL and NPS_GATEWAY_URL.
const API_URL =
  process.env.NPS_API_URL ?? (PRODUCTION ? "https://apigateway.nepalpayment.com" : "https://apisandbox.nepalpayment.com");
const GATEWAY_URL =
  process.env.NPS_GATEWAY_URL ??
  (PRODUCTION ? "https://gateway.nepalpayment.com/Payment/Index" : "https://gatewaysandbox.nepalpayment.com/Payment/Index");

// NPS publishes no shared test credentials. Onboarding gives you all five, for the sandbox and later for live.
const MERCHANT_ID = process.env.NPS_MERCHANT_ID ?? "";
const MERCHANT_NAME = process.env.NPS_MERCHANT_NAME ?? "";
const API_USERNAME = process.env.NPS_API_USERNAME ?? "";
const API_PASSWORD = process.env.NPS_API_PASSWORD ?? "";
const SECRET_KEY = process.env.NPS_SECRET_KEY ?? "";
if (!MERCHANT_ID || !MERCHANT_NAME || !API_USERNAME || !API_PASSWORD || !SECRET_KEY) {
  throw new Error("Set NPS_MERCHANT_ID, NPS_MERCHANT_NAME, NPS_API_USERNAME, NPS_API_PASSWORD and NPS_SECRET_KEY");
}

// Paisa to NPS's rupee text: 10000 -> "100", 10050 -> "100.50".
// NPS signs the exact text, so format once and reuse the same string ("100" and "100.00" sign differently).
function rupees(paisa: number): string {
  const whole = Math.floor(paisa / 100);
  const rest = paisa % 100;
  return rest === 0 ? String(whole) : \`\${whole}.\${String(rest).padStart(2, "0")}\`;
}`,
      sign: `// HMAC-SHA512(key, message) as lowercase hex, with Web Crypto, so it runs on Node, Bun, Deno and edge runtimes.
export async function hmacSha512Hex(key: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-512" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(message)));
  return Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("");
}

// NPS signs the VALUES of every field except Signature, keys sorted A to Z, joined with no separator.
// {MerchantId: "9", MerchantName: "TestMerchant"} signs "9TestMerchant".
export function signedText(payload: Record<string, string>): string {
  return Object.keys(payload)
    .filter((k) => k !== "Signature")
    .sort()
    .map((k) => payload[k])
    .join("");
}`,
      call: `// Every NPS reply looks like {"code":"0","message":"...","errors":[...],"data":...}. "0" means the call worked.
interface NpsReply {
  code: string;
  message?: string;
  errors?: { error_code: string; error_message: string }[] | null;
  data?: any;
}

// POSTs signed JSON with Basic auth. Our merchant id and name go in every call.
async function callNps(path: string, fields: Record<string, string>): Promise<NpsReply> {
  const payload = { MerchantId: MERCHANT_ID, MerchantName: MERCHANT_NAME, ...fields };
  const body = { ...payload, Signature: await hmacSha512Hex(SECRET_KEY, signedText(payload)) };
  const res = await fetch(\`\${API_URL}/\${path}\`, {
    method: "POST",
    headers: {
      Authorization: "Basic " + btoa(\`\${API_USERNAME}:\${API_PASSWORD}\`),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const reply = await res.json().catch(() => null);
  // HTTP 401 is a wrong API username or password. Anything without a code is an outage. Retry later.
  if (!res.ok || reply?.code == null) {
    throw new Error(\`NPS \${path} failed: HTTP \${res.status} \${JSON.stringify(reply)}\`);
  }
  return { ...reply, code: String(reply.code) };
}

// The error messages NPS sent, for logs.
function errorText(reply: NpsReply): string {
  return reply.errors?.map((e) => e.error_message).join("; ") || reply.message || "no message";
}`,
      start: `// Asks NPS for a ProcessId, then returns the form the browser posts to the NPS gateway page.
export async function startPayment(input: StartInput): Promise<Start> {
  const amount = rupees(input.amountPaisa); // the SAME string in GetProcessId and in the form
  const reply = await callNps("GetProcessId", { Amount: amount, MerchantTxnId: input.attemptId });
  const processId = reply.data?.ProcessId;
  // A reused MerchantTxnId answers code "1" with "Duplicate Record".
  if (reply.code !== "0" || !processId) throw new PaymentError(\`NPS GetProcessId: \${errorText(reply)}\`);
  return {
    type: "form",
    action: GATEWAY_URL,
    enctype: "multipart/form-data", // the NPS gateway takes multipart, not a urlencoded body
    fields: {
      MerchantId: MERCHANT_ID,
      MerchantName: MERCHANT_NAME,
      Amount: amount, // Amount, MerchantTxnId and ProcessId must match GetProcessId exactly
      MerchantTxnId: input.attemptId,
      ProcessId: String(processId),
      TransactionRemarks: input.description.slice(0, 100),
      ResponseUrl: input.returnUrl, // NPS sends the buyer here with ?MerchantTxnId=...&GatewayTxnId=...
    },
    providerRef: String(processId), // the app stores it on the attempt
  };
}`,
      confirm: `// NPS Status -> our status.
const STATUSES: Record<string, PaymentStatus> = {
  success: "paid",
  fail: "failed",
  failed: "failed",
  pending: "pending",
};

// Called from the return route (params = query + body) and from the reconcile job (params = {}).
export async function confirmPayment(input: ConfirmInput): Promise<Outcome> {
  // NPS sends ?MerchantTxnId=...&GatewayTxnId=... with no signature, so there is nothing to verify.
  // Reject a callback that names another attempt, then ask NPS.
  const txnId = input.params.MerchantTxnId;
  if (txnId && txnId !== input.attemptId) throw new PaymentError("NPS: callback is for a different payment");

  const reply = await callNps("CheckTransactionStatus", { MerchantTxnId: input.attemptId });
  if (reply.code !== "0") {
    // error_code 3, "Transaction not initialized yet": the buyer never reached the gateway.
    if (reply.errors?.some((e) => String(e.error_code) === "3")) return { status: "not_found" };
    throw new Error(\`NPS CheckTransactionStatus: \${errorText(reply)}\`);
  }
  const data = reply.data ?? {};
  if (data.MerchantTxnId != null && String(data.MerchantTxnId) !== input.attemptId) {
    throw new PaymentError("NPS: status is for a different payment");
  }
  // A failed payment is still code "0". Status decides. Unknown values count as pending.
  const raw = String(data.Status ?? "").toLowerCase();
  const status = Object.hasOwn(STATUSES, raw) ? STATUSES[raw] : "pending";
  // Amount leaves out NPS's ServiceCharge, so it equals what we sent. Compare it with the STORED amount.
  const amount = data.Amount == null ? NaN : Math.round(Number(String(data.Amount).replace(/,/g, "")) * 100);
  if ((status === "paid" || data.Amount != null) && amount !== input.amountPaisa) {
    throw new PaymentError(\`NPS: amount mismatch (\${data.Amount})\`);
  }
  return { status, providerRef: data.GatewayReferenceNo != null ? String(data.GatewayReferenceNo) : undefined };
}`,
    },
  },
  python: {
    file: "nps.py",
    lang: "python",
    parts: {
      config: `import base64
import hashlib
import hmac
import json
import os
import urllib.error
import urllib.request

from payments import Outcome, PaymentError, Start

# NPS OnePG (Nepal Payment Solution, now NPX). Sandbox unless NPS_ENV=production.
PRODUCTION = os.environ.get("NPS_ENV") == "production"

# Hosts from the NPS developer guide. If your onboarding PDF lists others, set NPS_API_URL and NPS_GATEWAY_URL.
if PRODUCTION:
    API_URL = os.environ.get("NPS_API_URL", "https://apigateway.nepalpayment.com")
    GATEWAY_URL = os.environ.get("NPS_GATEWAY_URL", "https://gateway.nepalpayment.com/Payment/Index")
else:
    API_URL = os.environ.get("NPS_API_URL", "https://apisandbox.nepalpayment.com")
    GATEWAY_URL = os.environ.get("NPS_GATEWAY_URL", "https://gatewaysandbox.nepalpayment.com/Payment/Index")

# NPS publishes no shared test credentials. Onboarding gives you all five, for the sandbox and later for live.
MERCHANT_ID = os.environ.get("NPS_MERCHANT_ID", "")
MERCHANT_NAME = os.environ.get("NPS_MERCHANT_NAME", "")
API_USERNAME = os.environ.get("NPS_API_USERNAME", "")
API_PASSWORD = os.environ.get("NPS_API_PASSWORD", "")
SECRET_KEY = os.environ.get("NPS_SECRET_KEY", "")
if not (MERCHANT_ID and MERCHANT_NAME and API_USERNAME and API_PASSWORD and SECRET_KEY):
    raise RuntimeError("Set NPS_MERCHANT_ID, NPS_MERCHANT_NAME, NPS_API_USERNAME, NPS_API_PASSWORD and NPS_SECRET_KEY")


def rupees(paisa: int) -> str:
    """Paisa to NPS's rupee text: 10000 -> "100", 10050 -> "100.50".
    NPS signs the exact text, so format once and reuse the same string ("100" and "100.00" sign differently)."""
    whole, rest = divmod(paisa, 100)
    return str(whole) if rest == 0 else f"{whole}.{rest:02d}"`,
      sign: `def hmac_sha512_hex(key: str, message: str) -> str:
    """HMAC-SHA512(key, message) as lowercase hex."""
    return hmac.new(key.encode(), message.encode(), hashlib.sha512).hexdigest()


def signed_text(payload: dict[str, str]) -> str:
    """NPS signs the VALUES of every field except Signature, keys sorted A to Z, joined with no separator.
    {"MerchantId": "9", "MerchantName": "TestMerchant"} signs "9TestMerchant"."""
    return "".join(payload[k] for k in sorted(payload) if k != "Signature")`,
      call: `def _call_nps(path: str, fields: dict[str, str]) -> dict:
    """POSTs signed JSON with Basic auth. Our merchant id and name go in every call.
    Every reply looks like {"code": "0", "message": "...", "errors": [...], "data": ...}. "0" means the call worked."""
    payload = {"MerchantId": MERCHANT_ID, "MerchantName": MERCHANT_NAME, **fields}
    body = {**payload, "Signature": hmac_sha512_hex(SECRET_KEY, signed_text(payload))}
    auth = base64.b64encode(f"{API_USERNAME}:{API_PASSWORD}".encode()).decode()
    req = urllib.request.Request(
        f"{API_URL}/{path}",
        data=json.dumps(body).encode(),
        headers={"Authorization": f"Basic {auth}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as res:
            reply = json.load(res)
    except (urllib.error.URLError, ValueError) as e:
        # HTTP 401 is a wrong API username or password. Anything else is an outage. Retry later.
        raise RuntimeError(f"NPS {path} failed: {e}") from e
    if not isinstance(reply, dict) or reply.get("code") is None:
        raise RuntimeError(f"NPS {path} failed: {reply}")
    reply["code"] = str(reply["code"])
    return reply


def _error_text(reply: dict) -> str:
    """The error messages NPS sent, for logs."""
    errors = reply.get("errors") or []
    return "; ".join(str(e.get("error_message")) for e in errors) or str(reply.get("message") or "no message")`,
      start: `def start_payment(attempt_id: str, amount_paisa: int, return_url: str, description: str) -> Start:
    """Asks NPS for a ProcessId, then returns the form the browser posts to the NPS gateway page."""
    amount = rupees(amount_paisa)  # the SAME string in GetProcessId and in the form
    reply = _call_nps("GetProcessId", {"Amount": amount, "MerchantTxnId": attempt_id})
    process_id = (reply.get("data") or {}).get("ProcessId")
    # A reused MerchantTxnId answers code "1" with "Duplicate Record".
    if reply["code"] != "0" or not process_id:
        raise PaymentError(f"NPS GetProcessId: {_error_text(reply)}")
    fields = {
        "MerchantId": MERCHANT_ID,
        "MerchantName": MERCHANT_NAME,
        "Amount": amount,  # Amount, MerchantTxnId and ProcessId must match GetProcessId exactly
        "MerchantTxnId": attempt_id,
        "ProcessId": str(process_id),
        "TransactionRemarks": description[:100],
        "ResponseUrl": return_url,  # NPS sends the buyer here with ?MerchantTxnId=...&GatewayTxnId=...
    }
    return Start(
        type="form",
        action=GATEWAY_URL,
        fields=fields,
        provider_ref=str(process_id),  # the app stores it on the attempt
        enctype="multipart/form-data",  # the NPS gateway takes multipart, not a urlencoded body
    )`,
      confirm: `# NPS Status -> our status.
STATUSES = {
    "success": "paid",
    "fail": "failed",
    "failed": "failed",
    "pending": "pending",
}


def confirm_payment(attempt_id: str, amount_paisa: int, provider_ref: str | None, params: dict[str, str]) -> Outcome:
    """Called from the return route (params = query + body) and from the reconcile job (params = {})."""
    # NPS sends ?MerchantTxnId=...&GatewayTxnId=... with no signature, so there is nothing to verify.
    # Reject a callback that names another attempt, then ask NPS.
    txn_id = params.get("MerchantTxnId")
    if txn_id and txn_id != attempt_id:
        raise PaymentError("NPS: callback is for a different payment")

    reply = _call_nps("CheckTransactionStatus", {"MerchantTxnId": attempt_id})
    if reply["code"] != "0":
        # error_code 3, "Transaction not initialized yet": the buyer never reached the gateway.
        if any(str(e.get("error_code")) == "3" for e in reply.get("errors") or []):
            return Outcome(status="not_found")
        raise RuntimeError(f"NPS CheckTransactionStatus: {_error_text(reply)}")
    data = reply.get("data") or {}
    if data.get("MerchantTxnId") is not None and str(data["MerchantTxnId"]) != attempt_id:
        raise PaymentError("NPS: status is for a different payment")
    # A failed payment is still code "0". Status decides. Unknown values count as pending.
    status = STATUSES.get(str(data.get("Status") or "").lower(), "pending")
    # Amount leaves out NPS's ServiceCharge, so it equals what we sent. Compare it with the STORED amount.
    raw_amount = data.get("Amount")
    if status == "paid" or raw_amount is not None:
        try:
            amount = round(float(str(raw_amount).replace(",", "")) * 100)
        except ValueError:
            amount = None
        if amount != amount_paisa:
            raise PaymentError(f"NPS: amount mismatch ({raw_amount})")
    ref = data.get("GatewayReferenceNo")
    return Outcome(status=status, provider_ref=None if ref is None else str(ref))`,
    },
  },
  php: {
    file: "NpsGateway.php",
    lang: "php",
    parts: {
      config: `<?php

declare(strict_types=1);

namespace App\\Payments;

// NPS OnePG (Nepal Payment Solution, now NPX). Sandbox unless NPS_ENV=production.
final class NpsGateway implements Gateway
{
    public function __construct(
        private string $merchantId,
        private string $merchantName,
        private string $apiUsername,
        private string $apiPassword,
        private string $secretKey,
        private string $apiUrl,
        private string $gatewayUrl,
    ) {
    }

    public static function fromEnv(): self
    {
        $env = static fn (string $name) => $_ENV[$name] ?? (getenv($name) !== false ? getenv($name) : null);
        $production = $env('NPS_ENV') === 'production';
        // NPS publishes no shared test credentials. Onboarding gives you all five, for the sandbox and later for live.
        $merchantId = (string) $env('NPS_MERCHANT_ID');
        $merchantName = (string) $env('NPS_MERCHANT_NAME');
        $apiUsername = (string) $env('NPS_API_USERNAME');
        $apiPassword = (string) $env('NPS_API_PASSWORD');
        $secretKey = (string) $env('NPS_SECRET_KEY');
        if (in_array('', [$merchantId, $merchantName, $apiUsername, $apiPassword, $secretKey], true)) {
            throw new \\RuntimeException('Set NPS_MERCHANT_ID, NPS_MERCHANT_NAME, NPS_API_USERNAME, NPS_API_PASSWORD and NPS_SECRET_KEY');
        }
        // Hosts from the NPS developer guide. If your onboarding PDF lists others, set NPS_API_URL and NPS_GATEWAY_URL.
        $apiUrl = $env('NPS_API_URL')
            ?? ($production ? 'https://apigateway.nepalpayment.com' : 'https://apisandbox.nepalpayment.com');
        $gatewayUrl = $env('NPS_GATEWAY_URL')
            ?? ($production ? 'https://gateway.nepalpayment.com/Payment/Index' : 'https://gatewaysandbox.nepalpayment.com/Payment/Index');
        return new self($merchantId, $merchantName, $apiUsername, $apiPassword, $secretKey, $apiUrl, $gatewayUrl);
    }

    // Paisa to NPS's rupee text: 10000 -> "100", 10050 -> "100.50".
    // NPS signs the exact text, so format once and reuse the same string ("100" and "100.00" sign differently).
    private static function rupees(int $paisa): string
    {
        $whole = intdiv($paisa, 100);
        $rest = $paisa % 100;
        return $rest === 0 ? (string) $whole : sprintf('%d.%02d', $whole, $rest);
    }`,
      sign: `    // HMAC-SHA512(key, message) as lowercase hex.
    public static function hmacSha512Hex(string $key, string $message): string
    {
        return hash_hmac('sha512', $message, $key);
    }

    // NPS signs the VALUES of every field except Signature, keys sorted A to Z, joined with no separator.
    // ['MerchantId' => '9', 'MerchantName' => 'TestMerchant'] signs "9TestMerchant".
    public static function signedText(array $payload): string
    {
        unset($payload['Signature']);
        ksort($payload, SORT_STRING);
        return implode('', array_values($payload));
    }`,
      call: `    // POSTs signed JSON with Basic auth. Our merchant id and name go in every call.
    // Every reply looks like {"code":"0","message":"...","errors":[...],"data":...}. "0" means the call worked.
    private function callNps(string $path, array $fields): array
    {
        $payload = ['MerchantId' => $this->merchantId, 'MerchantName' => $this->merchantName] + $fields;
        $payload['Signature'] = self::hmacSha512Hex($this->secretKey, self::signedText($payload));
        $ch = curl_init($this->apiUrl . '/' . $path);
        curl_setopt_array($ch, [
            CURLOPT_POST => true,
            CURLOPT_POSTFIELDS => json_encode($payload),
            CURLOPT_HTTPHEADER => ['Content-Type: application/json'],
            CURLOPT_USERPWD => $this->apiUsername . ':' . $this->apiPassword, // Basic auth
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT => 20,
        ]);
        $raw = curl_exec($ch);
        $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $error = curl_error($ch);
        $reply = is_string($raw) ? json_decode($raw, true) : null;
        // HTTP 401 is a wrong API username or password. Anything without a code is an outage. Retry later.
        if ($code !== 200 || !is_array($reply) || !isset($reply['code'])) {
            throw new \\RuntimeException("NPS $path failed: HTTP $code $error " . (is_string($raw) ? $raw : ''));
        }
        $reply['code'] = (string) $reply['code'];
        return $reply;
    }

    // The error messages NPS sent, for logs.
    private static function errorText(array $reply): string
    {
        $messages = array_map(fn ($e) => (string) ($e['error_message'] ?? ''), $reply['errors'] ?? []);
        return implode('; ', $messages) ?: (string) ($reply['message'] ?? 'no message');
    }`,
      start: `    // Asks NPS for a ProcessId, then returns the form the browser posts to the NPS gateway page.
    public function startPayment(string $attemptId, int $amountPaisa, string $returnUrl, string $description): Start
    {
        $amount = self::rupees($amountPaisa); // the SAME string in GetProcessId and in the form
        $reply = $this->callNps('GetProcessId', ['Amount' => $amount, 'MerchantTxnId' => $attemptId]);
        $processId = $reply['data']['ProcessId'] ?? null;
        // A reused MerchantTxnId answers code "1" with "Duplicate Record".
        if ($reply['code'] !== '0' || $processId === null || $processId === '') {
            throw new PaymentError('NPS GetProcessId: ' . self::errorText($reply));
        }
        $fields = [
            'MerchantId' => $this->merchantId,
            'MerchantName' => $this->merchantName,
            'Amount' => $amount, // Amount, MerchantTxnId and ProcessId must match GetProcessId exactly
            'MerchantTxnId' => $attemptId,
            'ProcessId' => (string) $processId,
            'TransactionRemarks' => substr($description, 0, 100),
            'ResponseUrl' => $returnUrl, // NPS sends the buyer here with ?MerchantTxnId=...&GatewayTxnId=...
        ];
        // The NPS gateway takes multipart, not a urlencoded body. The app stores ProcessId on the attempt.
        return Start::form($this->gatewayUrl, $fields, (string) $processId, 'multipart/form-data');
    }`,
      confirm: `    // NPS Status -> our status.
    private const STATUSES = [
        'success' => 'paid',
        'fail' => 'failed',
        'failed' => 'failed',
        'pending' => 'pending',
    ];

    // Called from the return route (params = query + body) and from the reconcile job (params = []).
    public function confirmPayment(string $attemptId, int $amountPaisa, ?string $providerRef, array $params): Outcome
    {
        // NPS sends ?MerchantTxnId=...&GatewayTxnId=... with no signature, so there is nothing to verify.
        // Reject a callback that names another attempt, then ask NPS.
        $txnId = (string) ($params['MerchantTxnId'] ?? '');
        if ($txnId !== '' && $txnId !== $attemptId) {
            throw new PaymentError('NPS: callback is for a different payment');
        }

        $reply = $this->callNps('CheckTransactionStatus', ['MerchantTxnId' => $attemptId]);
        if ($reply['code'] !== '0') {
            // error_code 3, "Transaction not initialized yet": the buyer never reached the gateway.
            foreach ($reply['errors'] ?? [] as $e) {
                if ((string) ($e['error_code'] ?? '') === '3') {
                    return new Outcome('not_found');
                }
            }
            throw new \\RuntimeException('NPS CheckTransactionStatus: ' . self::errorText($reply));
        }
        $data = is_array($reply['data'] ?? null) ? $reply['data'] : [];
        if (isset($data['MerchantTxnId']) && (string) $data['MerchantTxnId'] !== $attemptId) {
            throw new PaymentError('NPS: status is for a different payment');
        }
        // A failed payment is still code "0". Status decides. Unknown values count as pending.
        $status = self::STATUSES[strtolower((string) ($data['Status'] ?? ''))] ?? 'pending';
        // Amount leaves out NPS's ServiceCharge, so it equals what we sent. Compare it with the STORED amount.
        $raw = $data['Amount'] ?? null;
        if ($status === 'paid' || $raw !== null) {
            $text = str_replace(',', '', (string) $raw);
            if (!is_numeric($text) || (int) round((float) $text * 100) !== $amountPaisa) {
                throw new PaymentError('NPS: amount mismatch (' . ($raw ?? 'none') . ')');
            }
        }
        $ref = $data['GatewayReferenceNo'] ?? null;
        return new Outcome($status, $ref === null ? null : (string) $ref);
    }
}`,
    },
  },
  go: {
    file: "payments/nps.go",
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
	"fmt"
	"math"
	"net/http"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Nps is the NPS OnePG gateway (Nepal Payment Solution, now NPX). Sandbox unless NPS_ENV=production.
type Nps struct {
	merchantID, merchantName, apiUsername, apiPassword, secretKey string
	apiURL, gatewayURL                                            string
	client                                                        *http.Client
}

func NewNps() *Nps {
	production := os.Getenv("NPS_ENV") == "production"
	// NPS publishes no shared test credentials. Onboarding gives you all five, for the sandbox and later for live.
	n := &Nps{
		merchantID:   os.Getenv("NPS_MERCHANT_ID"),
		merchantName: os.Getenv("NPS_MERCHANT_NAME"),
		apiUsername:  os.Getenv("NPS_API_USERNAME"),
		apiPassword:  os.Getenv("NPS_API_PASSWORD"),
		secretKey:    os.Getenv("NPS_SECRET_KEY"),
		apiURL:       "https://apisandbox.nepalpayment.com",
		gatewayURL:   "https://gatewaysandbox.nepalpayment.com/Payment/Index",
		client:       &http.Client{Timeout: 20 * time.Second},
	}
	if production {
		n.apiURL = "https://apigateway.nepalpayment.com"
		n.gatewayURL = "https://gateway.nepalpayment.com/Payment/Index"
	}
	// Hosts from the NPS developer guide. If your onboarding PDF lists others, set NPS_API_URL and NPS_GATEWAY_URL.
	if v := os.Getenv("NPS_API_URL"); v != "" {
		n.apiURL = v
	}
	if v := os.Getenv("NPS_GATEWAY_URL"); v != "" {
		n.gatewayURL = v
	}
	if n.merchantID == "" || n.merchantName == "" || n.apiUsername == "" || n.apiPassword == "" || n.secretKey == "" {
		panic("set NPS_MERCHANT_ID, NPS_MERCHANT_NAME, NPS_API_USERNAME, NPS_API_PASSWORD and NPS_SECRET_KEY")
	}
	return n
}

// npsRupees turns paisa into NPS's rupee text: 10000 -> "100", 10050 -> "100.50".
// NPS signs the exact text, so format once and reuse the same string ("100" and "100.00" sign differently).
func npsRupees(paisa int64) string {
	if paisa%100 == 0 {
		return strconv.FormatInt(paisa/100, 10)
	}
	return fmt.Sprintf("%d.%02d", paisa/100, paisa%100)
}`,
      sign: `// NpsHMAC returns HMAC-SHA512(key, message) as lowercase hex.
func NpsHMAC(key, message string) string {
	mac := hmac.New(sha512.New, []byte(key))
	mac.Write([]byte(message))
	return hex.EncodeToString(mac.Sum(nil))
}

// NpsSignedText is what NPS signs: the VALUES of every field except Signature,
// keys sorted A to Z, joined with no separator. {MerchantId: 9, MerchantName: TestMerchant} signs "9TestMerchant".
func NpsSignedText(payload map[string]string) string {
	keys := make([]string, 0, len(payload))
	for k := range payload {
		if k != "Signature" {
			keys = append(keys, k)
		}
	}
	sort.Strings(keys)
	var b strings.Builder
	for _, k := range keys {
		b.WriteString(payload[k])
	}
	return b.String()
}`,
      call: `// npsReply is every NPS answer: {"code":"0","message":"...","errors":[...],"data":...}. "0" means the call worked.
type npsReply struct {
	Code    json.RawMessage \`json:"code"\`
	Message string          \`json:"message"\`
	Errors  []struct {
		Code    json.RawMessage \`json:"error_code"\`
		Message string          \`json:"error_message"\`
	} \`json:"errors"\`
	Data json.RawMessage \`json:"data"\`
}

// npsText reads a JSON string or number as plain text: "0" and 0 both give "0".
func npsText(raw json.RawMessage) string {
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s
	}
	if string(raw) == "null" {
		return ""
	}
	return string(raw)
}

// errorText joins the error messages NPS sent, for logs.
func (r npsReply) errorText() string {
	msgs := []string{}
	for _, e := range r.Errors {
		msgs = append(msgs, e.Message)
	}
	if len(msgs) == 0 {
		return r.Message
	}
	return strings.Join(msgs, "; ")
}

// call POSTs signed JSON with Basic auth. Our merchant id and name go in every call.
func (n *Nps) call(ctx context.Context, path string, fields map[string]string) (npsReply, error) {
	payload := map[string]string{"MerchantId": n.merchantID, "MerchantName": n.merchantName}
	for k, v := range fields {
		payload[k] = v
	}
	payload["Signature"] = NpsHMAC(n.secretKey, NpsSignedText(payload))
	body, _ := json.Marshal(payload)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, n.apiURL+"/"+path, bytes.NewReader(body))
	if err != nil {
		return npsReply{}, err
	}
	req.SetBasicAuth(n.apiUsername, n.apiPassword)
	req.Header.Set("Content-Type", "application/json")
	res, err := n.client.Do(req)
	if err != nil {
		return npsReply{}, fmt.Errorf("NPS %s failed: %w", path, err)
	}
	defer res.Body.Close()
	var reply npsReply
	// HTTP 401 is a wrong API username or password. Anything without a code is an outage. Retry later.
	if err := json.NewDecoder(res.Body).Decode(&reply); err != nil || res.StatusCode != http.StatusOK || npsText(reply.Code) == "" {
		return npsReply{}, fmt.Errorf("NPS %s failed: HTTP %s", path, res.Status)
	}
	return reply, nil
}`,
      start: `// StartPayment asks NPS for a ProcessId, then returns the form the browser posts to the NPS gateway page.
func (n *Nps) StartPayment(ctx context.Context, in StartInput) (Start, error) {
	amount := npsRupees(in.AmountPaisa) // the SAME string in GetProcessId and in the form
	reply, err := n.call(ctx, "GetProcessId", map[string]string{"Amount": amount, "MerchantTxnId": in.AttemptID})
	if err != nil {
		return Start{}, err
	}
	var data struct {
		ProcessID json.RawMessage \`json:"ProcessId"\`
	}
	json.Unmarshal(reply.Data, &data)
	processID := npsText(data.ProcessID)
	// A reused MerchantTxnId answers code "1" with "Duplicate Record".
	if npsText(reply.Code) != "0" || processID == "" {
		return Start{}, fmt.Errorf("%w: NPS GetProcessId: %s", ErrPayment, reply.errorText())
	}
	remarks := []rune(in.Description)
	if len(remarks) > 100 {
		remarks = remarks[:100]
	}
	return Start{
		Type:    "form",
		Action:  n.gatewayURL,
		Enctype: "multipart/form-data", // the NPS gateway takes multipart, not a urlencoded body
		Fields: map[string]string{
			"MerchantId":         n.merchantID,
			"MerchantName":       n.merchantName,
			"Amount":             amount, // Amount, MerchantTxnId and ProcessId must match GetProcessId exactly
			"MerchantTxnId":      in.AttemptID,
			"ProcessId":          processID,
			"TransactionRemarks": string(remarks),
			"ResponseUrl":        in.ReturnURL, // NPS sends the buyer here with ?MerchantTxnId=...&GatewayTxnId=...
		},
		ProviderRef: processID, // the app stores it on the attempt
	}, nil
}`,
      confirm: `// npsStatuses maps NPS's Status (lowercased) to ours.
var npsStatuses = map[string]string{
	"success": "paid",
	"fail":    "failed",
	"failed":  "failed",
	"pending": "pending",
}

// ConfirmPayment is called from the return route (Params = query + body) and from the reconcile job (empty Params).
func (n *Nps) ConfirmPayment(ctx context.Context, in ConfirmInput) (Outcome, error) {
	// NPS sends ?MerchantTxnId=...&GatewayTxnId=... with no signature, so there is nothing to verify.
	// Reject a callback that names another attempt, then ask NPS.
	if txnID := in.Params["MerchantTxnId"]; txnID != "" && txnID != in.AttemptID {
		return Outcome{}, fmt.Errorf("%w: NPS callback is for a different payment", ErrPayment)
	}

	reply, err := n.call(ctx, "CheckTransactionStatus", map[string]string{"MerchantTxnId": in.AttemptID})
	if err != nil {
		return Outcome{}, err
	}
	if npsText(reply.Code) != "0" {
		// error_code 3, "Transaction not initialized yet": the buyer never reached the gateway.
		for _, e := range reply.Errors {
			if npsText(e.Code) == "3" {
				return Outcome{Status: "not_found"}, nil
			}
		}
		return Outcome{}, fmt.Errorf("NPS CheckTransactionStatus: %s", reply.errorText())
	}
	var data map[string]json.RawMessage
	json.Unmarshal(reply.Data, &data)
	if txn := npsText(data["MerchantTxnId"]); txn != "" && txn != in.AttemptID {
		return Outcome{}, fmt.Errorf("%w: NPS status is for a different payment", ErrPayment)
	}
	// A failed payment is still code "0". Status decides. Unknown values count as pending.
	out := Outcome{Status: "pending", ProviderRef: npsText(data["GatewayReferenceNo"])}
	if s, ok := npsStatuses[strings.ToLower(npsText(data["Status"]))]; ok {
		out.Status = s
	}
	// Amount leaves out NPS's ServiceCharge, so it equals what we sent. Compare it with the STORED amount.
	if raw := npsText(data["Amount"]); out.Status == "paid" || raw != "" {
		amount, err := strconv.ParseFloat(strings.ReplaceAll(raw, ",", ""), 64)
		if err != nil || int64(math.Round(amount*100)) != in.AmountPaisa {
			return Outcome{}, fmt.Errorf("%w: NPS amount mismatch (%s)", ErrPayment, raw)
		}
	}
	return out, nil
}`,
    },
  },
  java: {
    file: "src/main/java/payments/NpsGateway.java",
    lang: "java",
    parts: {
      config: `package payments;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.TreeMap;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

// NPS OnePG (Nepal Payment Solution, now NPX). Sandbox unless NPS_ENV=production.
public final class NpsGateway implements Gateway {
    private static final ObjectMapper JSON = new ObjectMapper();
    private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build();
    private final String merchantId, merchantName, apiUsername, apiPassword, secretKey, apiUrl, gatewayUrl;

    public NpsGateway(String merchantId, String merchantName, String apiUsername, String apiPassword,
                      String secretKey, String apiUrl, String gatewayUrl) {
        this.merchantId = merchantId;
        this.merchantName = merchantName;
        this.apiUsername = apiUsername;
        this.apiPassword = apiPassword;
        this.secretKey = secretKey;
        this.apiUrl = apiUrl;
        this.gatewayUrl = gatewayUrl;
    }

    public static NpsGateway fromEnv() {
        boolean production = "production".equals(System.getenv("NPS_ENV"));
        // NPS publishes no shared test credentials. Onboarding gives you all five, for the sandbox and later for live.
        String merchantId = envOr("NPS_MERCHANT_ID", "");
        String merchantName = envOr("NPS_MERCHANT_NAME", "");
        String apiUsername = envOr("NPS_API_USERNAME", "");
        String apiPassword = envOr("NPS_API_PASSWORD", "");
        String secretKey = envOr("NPS_SECRET_KEY", "");
        if (merchantId.isEmpty() || merchantName.isEmpty() || apiUsername.isEmpty() || apiPassword.isEmpty() || secretKey.isEmpty()) {
            throw new IllegalStateException(
                "Set NPS_MERCHANT_ID, NPS_MERCHANT_NAME, NPS_API_USERNAME, NPS_API_PASSWORD and NPS_SECRET_KEY");
        }
        // Hosts from the NPS developer guide. If your onboarding PDF lists others, set NPS_API_URL and NPS_GATEWAY_URL.
        String apiUrl = envOr("NPS_API_URL",
            production ? "https://apigateway.nepalpayment.com" : "https://apisandbox.nepalpayment.com");
        String gatewayUrl = envOr("NPS_GATEWAY_URL", production
            ? "https://gateway.nepalpayment.com/Payment/Index"
            : "https://gatewaysandbox.nepalpayment.com/Payment/Index");
        return new NpsGateway(merchantId, merchantName, apiUsername, apiPassword, secretKey, apiUrl, gatewayUrl);
    }

    private static String envOr(String name, String fallback) {
        String value = System.getenv(name);
        return value != null && !value.isEmpty() ? value : fallback;
    }

    // Paisa to NPS's rupee text: 10000 -> "100", 10050 -> "100.50".
    // NPS signs the exact text, so format once and reuse the same string ("100" and "100.00" sign differently).
    static String rupees(long paisa) {
        return paisa % 100 == 0 ? Long.toString(paisa / 100) : String.format(Locale.ROOT, "%d.%02d", paisa / 100, paisa % 100);
    }`,
      sign: `    // HMAC-SHA512(key, message) as lowercase hex.
    public static String hmacSha512Hex(String key, String message) {
        try {
            Mac mac = Mac.getInstance("HmacSHA512");
            mac.init(new SecretKeySpec(key.getBytes(StandardCharsets.UTF_8), "HmacSHA512"));
            return HexFormat.of().formatHex(mac.doFinal(message.getBytes(StandardCharsets.UTF_8)));
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException(e);
        }
    }

    // NPS signs the VALUES of every field except Signature, keys sorted A to Z, joined with no separator.
    // {MerchantId=9, MerchantName=TestMerchant} signs "9TestMerchant".
    public static String signedText(Map<String, String> payload) {
        StringBuilder text = new StringBuilder();
        new TreeMap<>(payload).forEach((key, value) -> {
            if (!key.equals("Signature")) text.append(value);
        });
        return text.toString();
    }`,
      call: `    // POSTs signed JSON with Basic auth. Our merchant id and name go in every call.
    // Every reply looks like {"code":"0","message":"...","errors":[...],"data":...}. "0" means the call worked.
    private JsonNode callNps(String path, Map<String, String> fields) {
        Map<String, String> payload = new LinkedHashMap<>();
        payload.put("MerchantId", merchantId);
        payload.put("MerchantName", merchantName);
        payload.putAll(fields);
        payload.put("Signature", hmacSha512Hex(secretKey, signedText(payload)));
        String auth = Base64.getEncoder().encodeToString((apiUsername + ":" + apiPassword).getBytes(StandardCharsets.UTF_8));
        HttpResponse<String> res;
        JsonNode reply;
        try {
            HttpRequest request = HttpRequest.newBuilder(URI.create(apiUrl + "/" + path))
                .timeout(Duration.ofSeconds(20))
                .header("Authorization", "Basic " + auth)
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(JSON.writeValueAsString(payload)))
                .build();
            res = http.send(request, HttpResponse.BodyHandlers.ofString());
            reply = res.statusCode() == 200 ? JSON.readTree(res.body()) : null;
        } catch (IOException e) {
            throw new IllegalStateException("NPS " + path + " failed: " + e.getMessage(), e);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("NPS " + path + " interrupted", e);
        }
        // HTTP 401 is a wrong API username or password. Anything without a code is an outage. Retry later.
        if (reply == null || !reply.hasNonNull("code")) {
            throw new IllegalStateException("NPS " + path + " failed: HTTP " + res.statusCode() + " " + res.body());
        }
        return reply;
    }

    // The error messages NPS sent, for logs.
    private static String errorText(JsonNode reply) {
        List<String> messages = new ArrayList<>();
        for (JsonNode e : reply.path("errors")) messages.add(e.path("error_message").asText());
        return messages.isEmpty() ? reply.path("message").asText("no message") : String.join("; ", messages);
    }`,
      start: `    // Asks NPS for a ProcessId, then returns the form the browser posts to the NPS gateway page.
    @Override
    public Start startPayment(String attemptId, long amountPaisa, String returnUrl, String description) {
        String amount = rupees(amountPaisa); // the SAME string in GetProcessId and in the form
        JsonNode reply = callNps("GetProcessId", Map.of("Amount", amount, "MerchantTxnId", attemptId));
        String processId = reply.path("data").path("ProcessId").asText("");
        // A reused MerchantTxnId answers code "1" with "Duplicate Record".
        if (!reply.get("code").asText().equals("0") || processId.isEmpty()) {
            throw new PaymentException("NPS GetProcessId: " + errorText(reply));
        }
        Map<String, String> fields = new LinkedHashMap<>();
        fields.put("MerchantId", merchantId);
        fields.put("MerchantName", merchantName);
        fields.put("Amount", amount); // Amount, MerchantTxnId and ProcessId must match GetProcessId exactly
        fields.put("MerchantTxnId", attemptId);
        fields.put("ProcessId", processId);
        fields.put("TransactionRemarks", description.length() > 100 ? description.substring(0, 100) : description);
        fields.put("ResponseUrl", returnUrl); // NPS sends the buyer here with ?MerchantTxnId=...&GatewayTxnId=...
        // The NPS gateway takes multipart, not a urlencoded body. The app stores ProcessId on the attempt.
        return new Start.Form(gatewayUrl, fields, processId, "multipart/form-data");
    }`,
      confirm: `    // NPS Status (lowercased) -> our status.
    private static final Map<String, String> STATUSES = Map.of(
        "success", "paid",
        "fail", "failed",
        "failed", "failed",
        "pending", "pending");

    // Called from the return route (params = query + body) and from the reconcile job (empty params).
    @Override
    public Outcome confirmPayment(String attemptId, long amountPaisa, String providerRef, Map<String, String> params) {
        // NPS sends ?MerchantTxnId=...&GatewayTxnId=... with no signature, so there is nothing to verify.
        // Reject a callback that names another attempt, then ask NPS.
        String txnId = params.get("MerchantTxnId");
        if (txnId != null && !txnId.isEmpty() && !txnId.equals(attemptId)) {
            throw new PaymentException("NPS: callback is for a different payment");
        }

        JsonNode reply = callNps("CheckTransactionStatus", Map.of("MerchantTxnId", attemptId));
        if (!reply.get("code").asText().equals("0")) {
            // error_code 3, "Transaction not initialized yet": the buyer never reached the gateway.
            for (JsonNode e : reply.path("errors")) {
                if (e.path("error_code").asText().equals("3")) return new Outcome("not_found", null);
            }
            throw new IllegalStateException("NPS CheckTransactionStatus: " + errorText(reply));
        }
        JsonNode data = reply.path("data");
        if (data.hasNonNull("MerchantTxnId") && !data.get("MerchantTxnId").asText().equals(attemptId)) {
            throw new PaymentException("NPS: status is for a different payment");
        }
        // A failed payment is still code "0". Status decides. Unknown values count as pending.
        String status = STATUSES.getOrDefault(data.path("Status").asText("").toLowerCase(Locale.ROOT), "pending");
        // Amount leaves out NPS's ServiceCharge, so it equals what we sent. Compare it with the STORED amount.
        if (status.equals("paid") || data.hasNonNull("Amount")) {
            String raw = data.path("Amount").asText("").replace(",", "");
            boolean ok;
            try {
                ok = Math.round(Double.parseDouble(raw) * 100) == amountPaisa;
            } catch (NumberFormatException e) {
                ok = false;
            }
            if (!ok) throw new PaymentException("NPS: amount mismatch (" + data.path("Amount") + ")");
        }
        String ref = data.hasNonNull("GatewayReferenceNo") ? data.get("GatewayReferenceNo").asText() : null;
        return new Outcome(status, ref);
    }
}`,
    },
  },
  kotlin: {
    file: "src/main/kotlin/payments/NpsGateway.kt",
    lang: "kotlin",
    parts: {
      config: `package payments

import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration
import java.util.Base64
import java.util.HexFormat
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec
import kotlin.math.roundToLong
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

// NPS OnePG (Nepal Payment Solution, now NPX). Sandbox unless NPS_ENV=production.
class NpsGateway(
    private val merchantId: String,
    private val merchantName: String,
    private val apiUsername: String,
    private val apiPassword: String,
    private val secretKey: String,
    private val apiUrl: String,
    private val gatewayUrl: String,
) : Gateway {
    private val http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build()

    companion object {
        fun fromEnv(): NpsGateway {
            val production = System.getenv("NPS_ENV") == "production"
            fun env(name: String) = System.getenv(name).orEmpty()
            // NPS publishes no shared test credentials. Onboarding gives you all five, for the sandbox and later for live.
            val creds = listOf("NPS_MERCHANT_ID", "NPS_MERCHANT_NAME", "NPS_API_USERNAME", "NPS_API_PASSWORD", "NPS_SECRET_KEY")
                .map(::env)
            check(creds.none { it.isEmpty() }) {
                "Set NPS_MERCHANT_ID, NPS_MERCHANT_NAME, NPS_API_USERNAME, NPS_API_PASSWORD and NPS_SECRET_KEY"
            }
            // Hosts from the NPS developer guide. If your onboarding PDF lists others, set NPS_API_URL and NPS_GATEWAY_URL.
            val apiUrl = env("NPS_API_URL").ifEmpty {
                if (production) "https://apigateway.nepalpayment.com" else "https://apisandbox.nepalpayment.com"
            }
            val gatewayUrl = env("NPS_GATEWAY_URL").ifEmpty {
                if (production) "https://gateway.nepalpayment.com/Payment/Index"
                else "https://gatewaysandbox.nepalpayment.com/Payment/Index"
            }
            val (merchantId, merchantName, apiUsername, apiPassword, secretKey) = creds
            return NpsGateway(merchantId, merchantName, apiUsername, apiPassword, secretKey, apiUrl, gatewayUrl)
        }

        // Paisa to NPS's rupee text: 10000 -> "100", 10050 -> "100.50".
        // NPS signs the exact text, so format once and reuse the same string ("100" and "100.00" sign differently).
        fun rupees(paisa: Long): String =
            if (paisa % 100 == 0L) "\${paisa / 100}" else "\${paisa / 100}.\${(paisa % 100).toString().padStart(2, '0')}"`,
      sign: `        // HMAC-SHA512(key, message) as lowercase hex.
        fun hmacSha512Hex(key: String, message: String): String {
            val mac = Mac.getInstance("HmacSHA512")
            mac.init(SecretKeySpec(key.toByteArray(), "HmacSHA512"))
            return HexFormat.of().formatHex(mac.doFinal(message.toByteArray()))
        }

        // NPS signs the VALUES of every field except Signature, keys sorted A to Z, joined with no separator.
        // mapOf("MerchantId" to "9", "MerchantName" to "TestMerchant") signs "9TestMerchant".
        fun signedText(payload: Map<String, String>): String =
            payload.filterKeys { it != "Signature" }.toSortedMap().values.joinToString("")
    }`,
      call: `    // A JSON value as text: "0" and 0 both give "0", null gives null.
    private fun JsonElement?.text(): String? = (this as? JsonPrimitive)?.takeIf { it !is JsonNull }?.content

    // POSTs signed JSON with Basic auth. Our merchant id and name go in every call.
    // Every reply looks like {"code":"0","message":"...","errors":[...],"data":...}. "0" means the call worked.
    private suspend fun callNps(path: String, fields: Map<String, String>): JsonObject {
        val payload = mapOf("MerchantId" to merchantId, "MerchantName" to merchantName) + fields
        val body = JsonObject((payload + ("Signature" to hmacSha512Hex(secretKey, signedText(payload)))).mapValues { JsonPrimitive(it.value) })
        val auth = Base64.getEncoder().encodeToString("$apiUsername:$apiPassword".toByteArray())
        val request = HttpRequest.newBuilder(URI.create("$apiUrl/$path"))
            .timeout(Duration.ofSeconds(20))
            .header("Authorization", "Basic $auth")
            .header("Content-Type", "application/json")
            .POST(HttpRequest.BodyPublishers.ofString(body.toString()))
            .build()
        val res = withContext(Dispatchers.IO) { http.send(request, HttpResponse.BodyHandlers.ofString()) }
        val reply = runCatching { Json.parseToJsonElement(res.body()) as JsonObject }.getOrNull()
        // HTTP 401 is a wrong API username or password. Anything without a code is an outage. Retry later.
        if (res.statusCode() != 200 || reply?.get("code").text() == null) {
            throw IllegalStateException("NPS $path failed: HTTP \${res.statusCode()} \${res.body()}")
        }
        return reply!!
    }

    private fun JsonObject.errors(): List<JsonObject> = (this["errors"] as? JsonArray).orEmpty().filterIsInstance<JsonObject>()

    // The error messages NPS sent, for logs.
    private fun errorText(reply: JsonObject): String =
        reply.errors().mapNotNull { it["error_message"].text() }.joinToString("; ")
            .ifEmpty { reply["message"].text() ?: "no message" }`,
      start: `    // Asks NPS for a ProcessId, then returns the form the browser posts to the NPS gateway page.
    override suspend fun startPayment(attemptId: String, amountPaisa: Long, returnUrl: String, description: String): Start {
        val amount = rupees(amountPaisa) // the SAME string in GetProcessId and in the form
        val reply = callNps("GetProcessId", mapOf("Amount" to amount, "MerchantTxnId" to attemptId))
        val processId = (reply["data"] as? JsonObject)?.get("ProcessId").text()
        // A reused MerchantTxnId answers code "1" with "Duplicate Record".
        if (reply["code"].text() != "0" || processId.isNullOrEmpty()) {
            throw PaymentException("NPS GetProcessId: \${errorText(reply)}")
        }
        val fields = linkedMapOf(
            "MerchantId" to merchantId,
            "MerchantName" to merchantName,
            "Amount" to amount, // Amount, MerchantTxnId and ProcessId must match GetProcessId exactly
            "MerchantTxnId" to attemptId,
            "ProcessId" to processId,
            "TransactionRemarks" to description.take(100),
            "ResponseUrl" to returnUrl, // NPS sends the buyer here with ?MerchantTxnId=...&GatewayTxnId=...
        )
        // The NPS gateway takes multipart, not a urlencoded body. The app stores ProcessId on the attempt.
        return Start.Form(gatewayUrl, fields, providerRef = processId, enctype = "multipart/form-data")
    }`,
      confirm: `    // NPS Status (lowercased) -> our status.
    private val statuses = mapOf(
        "success" to "paid",
        "fail" to "failed",
        "failed" to "failed",
        "pending" to "pending",
    )

    // Called from the return route (params = query + body) and from the reconcile job (empty params).
    override suspend fun confirmPayment(attemptId: String, amountPaisa: Long, providerRef: String?, params: Map<String, String>): Outcome {
        // NPS sends ?MerchantTxnId=...&GatewayTxnId=... with no signature, so there is nothing to verify.
        // Reject a callback that names another attempt, then ask NPS.
        val txnId = params["MerchantTxnId"]
        if (!txnId.isNullOrEmpty() && txnId != attemptId) throw PaymentException("NPS: callback is for a different payment")

        val reply = callNps("CheckTransactionStatus", mapOf("MerchantTxnId" to attemptId))
        if (reply["code"].text() != "0") {
            // error_code 3, "Transaction not initialized yet": the buyer never reached the gateway.
            if (reply.errors().any { it["error_code"].text() == "3" }) return Outcome("not_found")
            throw IllegalStateException("NPS CheckTransactionStatus: \${errorText(reply)}")
        }
        val data = reply["data"] as? JsonObject ?: JsonObject(emptyMap())
        val dataTxnId = data["MerchantTxnId"].text()
        if (dataTxnId != null && dataTxnId != attemptId) throw PaymentException("NPS: status is for a different payment")
        // A failed payment is still code "0". Status decides. Unknown values count as pending.
        val status = statuses[data["Status"].text().orEmpty().lowercase()] ?: "pending"
        // Amount leaves out NPS's ServiceCharge, so it equals what we sent. Compare it with the STORED amount.
        val rawAmount = data["Amount"].text()
        if (status == "paid" || rawAmount != null) {
            val amount = rawAmount?.replace(",", "")?.toDoubleOrNull()
            if (amount == null || (amount * 100).roundToLong() != amountPaisa) {
                throw PaymentException("NPS: amount mismatch ($rawAmount)")
            }
        }
        return Outcome(status, data["GatewayReferenceNo"].text())
    }
}`,
    },
  },
};

// Signature vectors (my own, key "secret"): HMAC-SHA512 over the values sorted by key, lowercase hex.
// The NPS developer guide gives the rule but no example signatures. These reproduce with OpenSSL and Python.
export const vectors: { key: string; payload: Record<string, string>; message: string; signature: string }[] = [
  { key: "secret", payload: {"MerchantName": "TestMerchant", "MerchantId": "9"}, message: "9TestMerchant", signature: "8c68aeb869bbe3b1ba927d7e070bf0ba2c8db56535c1bc46645e5c550da5d4c74404b79147e3d87c5b69c0a589b60dbf2997dde759853ee51a3142102d9c0d7b" },
  { key: "secret", payload: {"MerchantTxnId": "T1", "MerchantName": "TestMerchant", "MerchantId": "9", "Amount": "100"}, message: "1009TestMerchantT1", signature: "d169fb7da4502fe70cfc6791206b759de2944f1b46755650052e888774b929d677ea71819a868a71c597f0cf98e4d442015931a0553f8af6e792fda37d0927b8" },
  { key: "secret", payload: {"MerchantTxnId": "T1", "MerchantId": "9", "MerchantName": "TestMerchant"}, message: "9TestMerchantT1", signature: "b73999d925b1ff31ca9ff6991b7f32e7fd07462c463b0955b7a07c0a41c55b8f7e20b716789a516343758fe89c8ffb37b0eb01fb98ba3e31ec1a3313bbb33be4" },
  { key: "secret", payload: {"MerchantTxnId": "3f2a9c1e7b5d40a8c6e1", "Amount": "100.50", "MerchantName": "TestMerchant", "MerchantId": "9"}, message: "100.509TestMerchant3f2a9c1e7b5d40a8c6e1", signature: "b8be93ed675f393c1306ed4fa340d7122ac93f514a899152e679d8ab39810018d838ceb21e0c94299a314756925b771bbeed5e60b587e16a2467928dc8f7b5f1" },
];

export default nps;

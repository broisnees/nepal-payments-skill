// Generated eSewa ePay v2 gateway module, one per language.
// The parts joined with "\n\n" in order (config, sign, start, confirm) form the complete file.

export interface GatewayCode {
  file: string;
  lang: string;
  parts: { config: string; sign: string; start: string; confirm: string };
}

export const esewa: Record<"ts" | "python" | "php" | "go" | "java" | "kotlin", GatewayCode> = {
  ts: {
    file: "esewa.ts",
    lang: "typescript",
    parts: {
      config: `import { PaymentError, type ConfirmInput, type Outcome, type PaymentStatus, type Start, type StartInput } from "./payments";

// eSewa ePay v2. Sandbox unless ESEWA_ENV=production.
const PRODUCTION = process.env.ESEWA_ENV === "production";

const FORM_URL = PRODUCTION
  ? "https://epay.esewa.com.np/api/epay/main/v2/form"
  : "https://rc-epay.esewa.com.np/api/epay/main/v2/form";
const STATUS_URL = PRODUCTION
  ? "https://esewa.com.np/api/epay/transaction/status/"
  : "https://rc.esewa.com.np/api/epay/transaction/status/";

// Sandbox defaults are eSewa's public test credentials. Production needs your own.
const PRODUCT_CODE = process.env.ESEWA_PRODUCT_CODE ?? (PRODUCTION ? "" : "EPAYTEST");
// Config UIs and templates sometimes turn "&" into "&amp;", which breaks every signature. Undo it.
const SECRET_KEY = (process.env.ESEWA_SECRET_KEY ?? (PRODUCTION ? "" : "8gBm/:&EnhH.1/q")).replace(/&amp;/g, "&");
if (!PRODUCT_CODE || !SECRET_KEY) throw new Error("Set ESEWA_PRODUCT_CODE and ESEWA_SECRET_KEY");

// Paisa to eSewa's rupee text: 10000 -> "100", 10050 -> "100.50".
// eSewa signs the exact text, so format once and reuse the same string ("100" vs "100.0" fails with ES104).
function rupees(paisa: number): string {
  const whole = Math.floor(paisa / 100);
  const rest = paisa % 100;
  return rest === 0 ? String(whole) : \`\${whole}.\${String(rest).padStart(2, "0")}\`;
}`,
      sign: `// base64(HMAC-SHA256(key, message)) with Web Crypto, so it runs on Node, Bun, Deno and edge runtimes.
export async function hmacBase64(key: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(message)));
  return btoa(String.fromCharCode(...mac));
}

// eSewa signs "name1=value1,name2=value2,..." in the order of signed_field_names. No spaces.
function signFields(fields: Record<string, string>, names: string[]): Promise<string> {
  return hmacBase64(SECRET_KEY, names.map((n) => \`\${n}=\${fields[n] ?? ""}\`).join(","));
}

// Compare signatures in constant time, so response timing leaks nothing about the right value.
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}`,
      start: `// Returns a form the browser auto-POSTs to eSewa. All nine fields plus the signature are required.
export async function startPayment(input: StartInput): Promise<Start> {
  const total = rupees(input.amountPaisa);
  const fields: Record<string, string> = {
    amount: total,
    tax_amount: "0", // send "0" for unused charges; leaving one out fails with ES200
    product_service_charge: "0",
    product_delivery_charge: "0",
    total_amount: total, // must equal the four above added up
    transaction_uuid: input.attemptId, // letters, digits and "-" only, never reused
    product_code: PRODUCT_CODE,
    success_url: input.returnUrl, // eSewa appends ?data=..., so no query string here
    failure_url: input.returnUrl,
    signed_field_names: "total_amount,transaction_uuid,product_code",
  };
  fields.signature = await signFields(fields, fields.signed_field_names.split(","));
  // ePay v2 has no description field, so input.description is not sent.
  return { type: "form", action: FORM_URL, fields };
}`,
      confirm: `// eSewa status -> our status. AMBIGUOUS means "payment is at halt state", so keep checking.
const STATUSES: Record<string, PaymentStatus> = {
  COMPLETE: "paid",
  PENDING: "pending",
  AMBIGUOUS: "pending",
  FULL_REFUND: "refunded",
  PARTIAL_REFUND: "refunded",
  CANCELED: "canceled",
  NOT_FOUND: "not_found", // never paid, session expired, or the wrong total_amount
};

// Value of a signed field as text. Numbers are read from the raw JSON so "1000.0" stays "1000.0".
function fieldText(json: string, payload: Record<string, unknown>, name: string): string {
  const v = payload[name];
  if (typeof v !== "number") return String(v ?? "");
  const escaped = name.replace(/[.*+?^\${}()|[\\]\\\\]/g, "\\\\$&");
  const m = json.match(new RegExp(\`"\${escaped}"\\\\s*:\\\\s*(-?[0-9][0-9.eE+-]*)\`));
  return m ? m[1] : String(v);
}

// Checks the base64 JSON that eSewa appends to success_url as ?data=. Throws PaymentError if it is forged.
async function verifyData(data: string, attemptId: string): Promise<void> {
  let json: string;
  let payload: Record<string, unknown>;
  try {
    // An unencoded "+" in ?data= arrives as a space after query parsing. Put it back before decoding.
    const bytes = Uint8Array.from(atob(data.replace(/ /g, "+")), (c) => c.charCodeAt(0));
    json = new TextDecoder().decode(bytes);
    payload = JSON.parse(json);
  } catch {
    throw new PaymentError("eSewa: data is not base64 JSON");
  }
  if (typeof payload?.signed_field_names !== "string" || typeof payload.signature !== "string") {
    throw new PaymentError("eSewa: data has no signature");
  }
  // Rebuild the message from the payload's own signed_field_names (it lists itself too).
  const names = payload.signed_field_names.split(",");
  const fields = Object.fromEntries(names.map((n) => [n, fieldText(json, payload, n)]));
  let ok = safeEqual(await signFields(fields, names), payload.signature);
  // total_amount can come back as "1,000.0". Sources disagree on whether the comma is signed, so try both.
  if (!ok && fields.total_amount?.includes(",")) {
    ok = safeEqual(await signFields({ ...fields, total_amount: fields.total_amount.replace(/,/g, "") }, names), payload.signature);
  }
  if (!ok) throw new PaymentError("eSewa: bad signature on data");
  if (payload.transaction_uuid !== attemptId || payload.product_code !== PRODUCT_CODE) {
    throw new PaymentError("eSewa: data is for a different payment");
  }
}

// Called from the return route (params = query + body) and from the reconcile job (params = {}).
export async function confirmPayment(input: ConfirmInput): Promise<Outcome> {
  if (input.params.data) await verifyData(input.params.data, input.attemptId);

  // The status API is the real answer. Send the STORED total: a wrong one answers NOT_FOUND,
  // so this doubles as the amount check.
  const query = new URLSearchParams({
    product_code: PRODUCT_CODE,
    total_amount: rupees(input.amountPaisa),
    transaction_uuid: input.attemptId,
  });
  const res = await fetch(\`\${STATUS_URL}?\${query}\`, { signal: AbortSignal.timeout(15_000) });
  const body = await res.json().catch(() => null);
  // Outages look like {"code":0,"error_message":"Service is currently unavailable"}. Retry later.
  if (!res.ok || typeof body?.status !== "string") {
    throw new Error(\`eSewa status check failed: HTTP \${res.status} \${JSON.stringify(body)}\`);
  }
  if (Math.round(Number(body.total_amount) * 100) !== input.amountPaisa) {
    throw new PaymentError(\`eSewa: amount mismatch (\${body.total_amount})\`);
  }
  // Unknown values count as pending, so the reconcile job keeps asking.
  const status = Object.hasOwn(STATUSES, body.status) ? STATUSES[body.status] : "pending";
  return { status, providerRef: body.ref_id ?? undefined };
}`,
    },
  },
  python: {
    file: "esewa.py",
    lang: "python",
    parts: {
      config: `import base64
import binascii
import hashlib
import hmac
import json
import os
import urllib.error
import urllib.parse
import urllib.request

from payments import Outcome, PaymentError, Start

# eSewa ePay v2. Sandbox unless ESEWA_ENV=production.
PRODUCTION = os.environ.get("ESEWA_ENV") == "production"

if PRODUCTION:
    FORM_URL = "https://epay.esewa.com.np/api/epay/main/v2/form"
    STATUS_URL = "https://esewa.com.np/api/epay/transaction/status/"
else:
    FORM_URL = "https://rc-epay.esewa.com.np/api/epay/main/v2/form"
    STATUS_URL = "https://rc.esewa.com.np/api/epay/transaction/status/"

# Sandbox defaults are eSewa's public test credentials. Production needs your own.
PRODUCT_CODE = os.environ.get("ESEWA_PRODUCT_CODE", "" if PRODUCTION else "EPAYTEST")
# Config UIs and templates sometimes turn "&" into "&amp;", which breaks every signature. Undo it.
SECRET_KEY = os.environ.get("ESEWA_SECRET_KEY", "" if PRODUCTION else "8gBm/:&EnhH.1/q").replace("&amp;", "&")
if not PRODUCT_CODE or not SECRET_KEY:
    raise RuntimeError("Set ESEWA_PRODUCT_CODE and ESEWA_SECRET_KEY")


def rupees(paisa: int) -> str:
    """Paisa to eSewa's rupee text: 10000 -> "100", 10050 -> "100.50".
    eSewa signs the exact text, so format once and reuse the same string ("100" vs "100.0" fails with ES104)."""
    whole, rest = divmod(paisa, 100)
    return str(whole) if rest == 0 else f"{whole}.{rest:02d}"`,
      sign: `def hmac_base64(key: str, message: str) -> str:
    """base64(HMAC-SHA256(key, message))."""
    mac = hmac.new(key.encode(), message.encode(), hashlib.sha256).digest()
    return base64.b64encode(mac).decode()


def sign_fields(fields: dict[str, str], names: list[str]) -> str:
    """eSewa signs "name1=value1,name2=value2,..." in the order of signed_field_names. No spaces."""
    return hmac_base64(SECRET_KEY, ",".join(f"{n}={fields.get(n, '')}" for n in names))`,
      start: `def start_payment(attempt_id: str, amount_paisa: int, return_url: str, description: str) -> Start:
    """Returns a form the browser auto-POSTs to eSewa. All nine fields plus the signature are required."""
    total = rupees(amount_paisa)
    fields = {
        "amount": total,
        "tax_amount": "0",  # send "0" for unused charges; leaving one out fails with ES200
        "product_service_charge": "0",
        "product_delivery_charge": "0",
        "total_amount": total,  # must equal the four above added up
        "transaction_uuid": attempt_id,  # letters, digits and "-" only, never reused
        "product_code": PRODUCT_CODE,
        "success_url": return_url,  # eSewa appends ?data=..., so no query string here
        "failure_url": return_url,
        "signed_field_names": "total_amount,transaction_uuid,product_code",
    }
    fields["signature"] = sign_fields(fields, fields["signed_field_names"].split(","))
    # ePay v2 has no description field, so description is not sent.
    return Start(type="form", action=FORM_URL, fields=fields)`,
      confirm: `# eSewa status -> our status. AMBIGUOUS means "payment is at halt state", so keep checking.
STATUSES = {
    "COMPLETE": "paid",
    "PENDING": "pending",
    "AMBIGUOUS": "pending",
    "FULL_REFUND": "refunded",
    "PARTIAL_REFUND": "refunded",
    "CANCELED": "canceled",
    "NOT_FOUND": "not_found",  # never paid, session expired, or the wrong total_amount
}


def _verify_data(data: str, attempt_id: str) -> None:
    """Checks the base64 JSON that eSewa appends to success_url as ?data=. Raises PaymentError if it is forged."""
    try:
        # An unencoded "+" in ?data= arrives as a space after query parsing. Put it back before decoding.
        text = base64.b64decode(data.replace(" ", "+"), validate=True).decode()
        # parse_float/parse_int=str keep numbers as eSewa wrote them, so "1000.0" stays "1000.0".
        payload = json.loads(text, parse_float=str, parse_int=str)
    except (binascii.Error, ValueError):
        raise PaymentError("eSewa: data is not base64 JSON")
    if not isinstance(payload, dict) or not isinstance(payload.get("signed_field_names"), str) \\
            or not isinstance(payload.get("signature"), str):
        raise PaymentError("eSewa: data has no signature")
    # Rebuild the message from the payload's own signed_field_names (it lists itself too).
    names = payload["signed_field_names"].split(",")
    fields = {n: "" if payload.get(n) is None else str(payload[n]) for n in names}
    ok = hmac.compare_digest(sign_fields(fields, names), payload["signature"])
    # total_amount can come back as "1,000.0". Sources disagree on whether the comma is signed, so try both.
    if not ok and "," in fields.get("total_amount", ""):
        no_comma = {**fields, "total_amount": fields["total_amount"].replace(",", "")}
        ok = hmac.compare_digest(sign_fields(no_comma, names), payload["signature"])
    if not ok:
        raise PaymentError("eSewa: bad signature on data")
    if payload.get("transaction_uuid") != attempt_id or payload.get("product_code") != PRODUCT_CODE:
        raise PaymentError("eSewa: data is for a different payment")


def confirm_payment(attempt_id: str, amount_paisa: int, provider_ref: str | None, params: dict[str, str]) -> Outcome:
    """Called from the return route (params = query + body) and from the reconcile job (params = {})."""
    if params.get("data"):
        _verify_data(params["data"], attempt_id)

    # The status API is the real answer. Send the STORED total: a wrong one answers NOT_FOUND,
    # so this doubles as the amount check.
    query = urllib.parse.urlencode({
        "product_code": PRODUCT_CODE,
        "total_amount": rupees(amount_paisa),
        "transaction_uuid": attempt_id,
    })
    try:
        with urllib.request.urlopen(f"{STATUS_URL}?{query}", timeout=15) as res:
            body = json.load(res)
    except (urllib.error.URLError, ValueError) as e:
        # Outages look like {"code":0,"error_message":"Service is currently unavailable"}. Retry later.
        raise RuntimeError(f"eSewa status check failed: {e}") from e
    if not isinstance(body, dict) or not isinstance(body.get("status"), str):
        raise RuntimeError(f"eSewa status check failed: {body}")
    if round(float(body.get("total_amount") or 0) * 100) != amount_paisa:
        raise PaymentError(f"eSewa: amount mismatch ({body.get('total_amount')})")
    # Unknown values count as pending, so the reconcile job keeps asking.
    return Outcome(status=STATUSES.get(body["status"], "pending"), provider_ref=body.get("ref_id"))`,
    },
  },
  php: {
    file: "EsewaGateway.php",
    lang: "php",
    parts: {
      config: `<?php

declare(strict_types=1);

namespace App\\Payments;

// eSewa ePay v2. Sandbox unless ESEWA_ENV=production.
final class EsewaGateway implements Gateway
{
    public function __construct(
        private string $productCode,
        private string $secretKey,
        private string $formUrl,
        private string $statusUrl,
    ) {
        // Config UIs and templates sometimes turn "&" into "&amp;", which breaks every signature. Undo it.
        $this->secretKey = str_replace('&amp;', '&', $secretKey);
    }

    public static function fromEnv(): self
    {
        $env = static fn (string $name) => $_ENV[$name] ?? (getenv($name) !== false ? getenv($name) : null);
        $production = $env('ESEWA_ENV') === 'production';
        // Sandbox defaults are eSewa's public test credentials. Production needs your own.
        $productCode = $env('ESEWA_PRODUCT_CODE') ?? ($production ? '' : 'EPAYTEST');
        $secretKey = $env('ESEWA_SECRET_KEY') ?? ($production ? '' : '8gBm/:&EnhH.1/q');
        if ($productCode === '' || $secretKey === '') {
            throw new \\RuntimeException('Set ESEWA_PRODUCT_CODE and ESEWA_SECRET_KEY');
        }
        return $production
            ? new self($productCode, $secretKey,
                'https://epay.esewa.com.np/api/epay/main/v2/form',
                'https://esewa.com.np/api/epay/transaction/status/')
            : new self($productCode, $secretKey,
                'https://rc-epay.esewa.com.np/api/epay/main/v2/form',
                'https://rc.esewa.com.np/api/epay/transaction/status/');
    }

    // Paisa to eSewa's rupee text: 10000 -> "100", 10050 -> "100.50".
    // eSewa signs the exact text, so format once and reuse the same string ("100" vs "100.0" fails with ES104).
    private static function rupees(int $paisa): string
    {
        $whole = intdiv($paisa, 100);
        $rest = $paisa % 100;
        return $rest === 0 ? (string) $whole : sprintf('%d.%02d', $whole, $rest);
    }`,
      sign: `    // base64(HMAC-SHA256(key, message)).
    public static function hmacBase64(string $key, string $message): string
    {
        return base64_encode(hash_hmac('sha256', $message, $key, true));
    }

    // eSewa signs "name1=value1,name2=value2,..." in the order of signed_field_names. No spaces.
    private function signFields(array $fields, array $names): string
    {
        $parts = array_map(fn (string $n) => $n . '=' . ($fields[$n] ?? ''), $names);
        return self::hmacBase64($this->secretKey, implode(',', $parts));
    }`,
      start: `    // Returns a form the browser auto-POSTs to eSewa. All nine fields plus the signature are required.
    public function startPayment(string $attemptId, int $amountPaisa, string $returnUrl, string $description): Start
    {
        $total = self::rupees($amountPaisa);
        $fields = [
            'amount' => $total,
            'tax_amount' => '0', // send "0" for unused charges; leaving one out fails with ES200
            'product_service_charge' => '0',
            'product_delivery_charge' => '0',
            'total_amount' => $total, // must equal the four above added up
            'transaction_uuid' => $attemptId, // letters, digits and "-" only, never reused
            'product_code' => $this->productCode,
            'success_url' => $returnUrl, // eSewa appends ?data=..., so no query string here
            'failure_url' => $returnUrl,
            'signed_field_names' => 'total_amount,transaction_uuid,product_code',
        ];
        $fields['signature'] = $this->signFields($fields, explode(',', $fields['signed_field_names']));
        // ePay v2 has no description field, so $description is not sent.
        return Start::form($this->formUrl, $fields);
    }`,
      confirm: `    // eSewa status -> our status. AMBIGUOUS means "payment is at halt state", so keep checking.
    private const STATUSES = [
        'COMPLETE' => 'paid',
        'PENDING' => 'pending',
        'AMBIGUOUS' => 'pending',
        'FULL_REFUND' => 'refunded',
        'PARTIAL_REFUND' => 'refunded',
        'CANCELED' => 'canceled',
        'NOT_FOUND' => 'not_found', // never paid, session expired, or the wrong total_amount
    ];

    // Value of a signed field as text. Numbers are read from the raw JSON so "1000.0" stays "1000.0".
    private static function fieldText(string $json, array $payload, string $name): string
    {
        $v = $payload[$name] ?? null;
        if (!is_int($v) && !is_float($v)) {
            return is_bool($v) ? ($v ? 'true' : 'false') : (string) $v;
        }
        $pattern = '/"' . preg_quote($name, '/') . '"\\s*:\\s*(-?[0-9][0-9.eE+-]*)/';
        return preg_match($pattern, $json, $m) === 1 ? $m[1] : (string) $v;
    }

    // Checks the base64 JSON that eSewa appends to success_url as ?data=. Throws PaymentError if it is forged.
    private function verifyData(string $data, string $attemptId): void
    {
        // An unencoded "+" in ?data= arrives as a space after query parsing. Put it back before decoding.
        $json = base64_decode(str_replace(' ', '+', $data), true);
        $payload = $json === false ? null : json_decode($json, true);
        if (!is_array($payload)) {
            throw new PaymentError('eSewa: data is not base64 JSON');
        }
        if (!is_string($payload['signed_field_names'] ?? null) || !is_string($payload['signature'] ?? null)) {
            throw new PaymentError('eSewa: data has no signature');
        }
        // Rebuild the message from the payload's own signed_field_names (it lists itself too).
        $names = explode(',', $payload['signed_field_names']);
        $fields = [];
        foreach ($names as $n) {
            $fields[$n] = self::fieldText($json, $payload, $n);
        }
        $ok = hash_equals($this->signFields($fields, $names), $payload['signature']);
        // total_amount can come back as "1,000.0". Sources disagree on whether the comma is signed, so try both.
        if (!$ok && str_contains($fields['total_amount'] ?? '', ',')) {
            $noComma = ['total_amount' => str_replace(',', '', $fields['total_amount'])] + $fields;
            $ok = hash_equals($this->signFields($noComma, $names), $payload['signature']);
        }
        if (!$ok) {
            throw new PaymentError('eSewa: bad signature on data');
        }
        if (($payload['transaction_uuid'] ?? null) !== $attemptId || ($payload['product_code'] ?? null) !== $this->productCode) {
            throw new PaymentError('eSewa: data is for a different payment');
        }
    }

    // Called from the return route (params = query + body) and from the reconcile job (params = []).
    public function confirmPayment(string $attemptId, int $amountPaisa, ?string $providerRef, array $params): Outcome
    {
        if (!empty($params['data'])) {
            $this->verifyData((string) $params['data'], $attemptId);
        }

        // The status API is the real answer. Send the STORED total: a wrong one answers NOT_FOUND,
        // so this doubles as the amount check.
        $query = http_build_query([
            'product_code' => $this->productCode,
            'total_amount' => self::rupees($amountPaisa),
            'transaction_uuid' => $attemptId,
        ]);
        $ch = curl_init($this->statusUrl . '?' . $query);
        curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 15]);
        $raw = curl_exec($ch);
        $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $error = curl_error($ch);
        $body = is_string($raw) ? json_decode($raw, true) : null;
        // Outages look like {"code":0,"error_message":"Service is currently unavailable"}. Retry later.
        if ($code !== 200 || !is_array($body) || !is_string($body['status'] ?? null)) {
            throw new \\RuntimeException("eSewa status check failed: HTTP $code $error " . (is_string($raw) ? $raw : ''));
        }
        if ((int) round((float) ($body['total_amount'] ?? 0) * 100) !== $amountPaisa) {
            throw new PaymentError('eSewa: amount mismatch (' . ($body['total_amount'] ?? 'none') . ')');
        }
        // Unknown values count as pending, so the reconcile job keeps asking.
        return new Outcome(self::STATUSES[$body['status']] ?? 'pending', $body['ref_id'] ?? null);
    }
}`,
    },
  },
  go: {
    file: "payments/esewa.go",
    lang: "go",
    parts: {
      config: `package payments

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

// Esewa is the eSewa ePay v2 gateway. Sandbox unless ESEWA_ENV=production.
type Esewa struct {
	productCode, secretKey, formURL, statusURL string
	client                                     *http.Client
}

func NewEsewa() *Esewa {
	production := os.Getenv("ESEWA_ENV") == "production"
	e := &Esewa{
		productCode: os.Getenv("ESEWA_PRODUCT_CODE"),
		secretKey:   os.Getenv("ESEWA_SECRET_KEY"),
		formURL:     "https://rc-epay.esewa.com.np/api/epay/main/v2/form",
		statusURL:   "https://rc.esewa.com.np/api/epay/transaction/status/",
		client:      &http.Client{Timeout: 15 * time.Second},
	}
	if production {
		e.formURL = "https://epay.esewa.com.np/api/epay/main/v2/form"
		e.statusURL = "https://esewa.com.np/api/epay/transaction/status/"
	} else {
		// Sandbox defaults are eSewa's public test credentials. Production needs your own.
		if e.productCode == "" {
			e.productCode = "EPAYTEST"
		}
		if e.secretKey == "" {
			e.secretKey = "8gBm/:&EnhH.1/q"
		}
	}
	if e.productCode == "" || e.secretKey == "" {
		panic("set ESEWA_PRODUCT_CODE and ESEWA_SECRET_KEY")
	}
	// Config UIs and templates sometimes turn "&" into "&amp;", which breaks every signature. Undo it.
	e.secretKey = strings.ReplaceAll(e.secretKey, "&amp;", "&")
	return e
}

// esewaRupees turns paisa into eSewa's rupee text: 10000 -> "100", 10050 -> "100.50".
// eSewa signs the exact text, so format once and reuse the same string ("100" vs "100.0" fails with ES104).
func esewaRupees(paisa int64) string {
	if paisa%100 == 0 {
		return strconv.FormatInt(paisa/100, 10)
	}
	return fmt.Sprintf("%d.%02d", paisa/100, paisa%100)
}`,
      sign: `// EsewaHMAC returns base64(HMAC-SHA256(key, message)).
func EsewaHMAC(key, message string) string {
	mac := hmac.New(sha256.New, []byte(key))
	mac.Write([]byte(message))
	return base64.StdEncoding.EncodeToString(mac.Sum(nil))
}

// signFields signs "name1=value1,name2=value2,..." in the order of signed_field_names. No spaces.
func (e *Esewa) signFields(fields map[string]string, names []string) string {
	parts := make([]string, len(names))
	for i, n := range names {
		parts[i] = n + "=" + fields[n]
	}
	return EsewaHMAC(e.secretKey, strings.Join(parts, ","))
}`,
      start: `// StartPayment returns a form the browser auto-POSTs to eSewa. All nine fields plus the signature are required.
func (e *Esewa) StartPayment(ctx context.Context, in StartInput) (Start, error) {
	total := esewaRupees(in.AmountPaisa)
	fields := map[string]string{
		"amount":                  total,
		"tax_amount":              "0", // send "0" for unused charges; leaving one out fails with ES200
		"product_service_charge":  "0",
		"product_delivery_charge": "0",
		"total_amount":            total,        // must equal the four above added up
		"transaction_uuid":        in.AttemptID, // letters, digits and "-" only, never reused
		"product_code":            e.productCode,
		"success_url":             in.ReturnURL, // eSewa appends ?data=..., so no query string here
		"failure_url":             in.ReturnURL,
		"signed_field_names":      "total_amount,transaction_uuid,product_code",
	}
	fields["signature"] = e.signFields(fields, strings.Split(fields["signed_field_names"], ","))
	// ePay v2 has no description field, so in.Description is not sent.
	return Start{Type: "form", Action: e.formURL, Fields: fields}, nil
}`,
      confirm: `// esewaStatuses maps eSewa's status to ours. AMBIGUOUS means "payment is at halt state", so keep checking.
var esewaStatuses = map[string]string{
	"COMPLETE":       "paid",
	"PENDING":        "pending",
	"AMBIGUOUS":      "pending",
	"FULL_REFUND":    "refunded",
	"PARTIAL_REFUND": "refunded",
	"CANCELED":       "canceled",
	"NOT_FOUND":      "not_found", // never paid, session expired, or the wrong total_amount
}

// verifyData checks the base64 JSON that eSewa appends to success_url as ?data=.
// It returns an ErrPayment error if the payload is forged.
func (e *Esewa) verifyData(data, attemptID string) error {
	// An unencoded "+" in ?data= arrives as a space after query parsing. Put it back before decoding.
	raw, err := base64.StdEncoding.DecodeString(strings.ReplaceAll(data, " ", "+"))
	if err != nil {
		return fmt.Errorf("%w: eSewa data is not base64", ErrPayment)
	}
	// UseNumber keeps numbers as eSewa wrote them, so "1000.0" stays "1000.0".
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var payload map[string]any
	if err := dec.Decode(&payload); err != nil {
		return fmt.Errorf("%w: eSewa data is not JSON", ErrPayment)
	}
	names, _ := payload["signed_field_names"].(string)
	signature, _ := payload["signature"].(string)
	if names == "" || signature == "" {
		return fmt.Errorf("%w: eSewa data has no signature", ErrPayment)
	}
	// Rebuild the message from the payload's own signed_field_names (it lists itself too).
	order := strings.Split(names, ",")
	fields := map[string]string{}
	for _, n := range order {
		if v, ok := payload[n]; ok && v != nil {
			fields[n] = fmt.Sprint(v)
		}
	}
	ok := hmac.Equal([]byte(e.signFields(fields, order)), []byte(signature))
	// total_amount can come back as "1,000.0". Sources disagree on whether the comma is signed, so try both.
	if !ok && strings.Contains(fields["total_amount"], ",") {
		fields["total_amount"] = strings.ReplaceAll(fields["total_amount"], ",", "")
		ok = hmac.Equal([]byte(e.signFields(fields, order)), []byte(signature))
	}
	if !ok {
		return fmt.Errorf("%w: bad signature on eSewa data", ErrPayment)
	}
	if payload["transaction_uuid"] != attemptID || payload["product_code"] != e.productCode {
		return fmt.Errorf("%w: eSewa data is for a different payment", ErrPayment)
	}
	return nil
}

// ConfirmPayment is called from the return route (Params = query + body) and from the reconcile job (empty Params).
func (e *Esewa) ConfirmPayment(ctx context.Context, in ConfirmInput) (Outcome, error) {
	if data := in.Params["data"]; data != "" {
		if err := e.verifyData(data, in.AttemptID); err != nil {
			return Outcome{}, err
		}
	}

	// The status API is the real answer. Send the STORED total: a wrong one answers NOT_FOUND,
	// so this doubles as the amount check.
	query := url.Values{
		"product_code":     {e.productCode},
		"total_amount":     {esewaRupees(in.AmountPaisa)},
		"transaction_uuid": {in.AttemptID},
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, e.statusURL+"?"+query.Encode(), nil)
	if err != nil {
		return Outcome{}, err
	}
	res, err := e.client.Do(req)
	if err != nil {
		return Outcome{}, fmt.Errorf("eSewa status check failed: %w", err)
	}
	defer res.Body.Close()
	var body struct {
		Status      string   \`json:"status"\`
		TotalAmount *float64 \`json:"total_amount"\`
		RefID       *string  \`json:"ref_id"\`
	}
	// Outages look like {"code":0,"error_message":"Service is currently unavailable"}. Retry later.
	if err := json.NewDecoder(res.Body).Decode(&body); err != nil || res.StatusCode != http.StatusOK || body.Status == "" {
		return Outcome{}, errors.New("eSewa status check failed: HTTP " + res.Status)
	}
	if body.TotalAmount == nil || int64(math.Round(*body.TotalAmount*100)) != in.AmountPaisa {
		return Outcome{}, fmt.Errorf("%w: eSewa amount mismatch", ErrPayment)
	}
	out := Outcome{Status: "pending"} // unknown values count as pending, so the reconcile job keeps asking
	if s, ok := esewaStatuses[body.Status]; ok {
		out.Status = s
	}
	if body.RefID != nil {
		out.ProviderRef = *body.RefID
	}
	return out, nil
}`,
    },
  },
  java: {
    file: "src/main/java/payments/EsewaGateway.java",
    lang: "java",
    parts: {
      config: `package payments;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
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
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

// eSewa ePay v2. Sandbox unless ESEWA_ENV=production.
public final class EsewaGateway implements Gateway {
    private static final ObjectMapper JSON = new ObjectMapper();
    private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build();
    private final String productCode, secretKey, formUrl, statusUrl;

    public EsewaGateway(String productCode, String secretKey, String formUrl, String statusUrl) {
        this.productCode = productCode;
        // Config UIs and templates sometimes turn "&" into "&amp;", which breaks every signature. Undo it.
        this.secretKey = secretKey.replace("&amp;", "&");
        this.formUrl = formUrl;
        this.statusUrl = statusUrl;
    }

    public static EsewaGateway fromEnv() {
        boolean production = "production".equals(System.getenv("ESEWA_ENV"));
        // Sandbox defaults are eSewa's public test credentials. Production needs your own.
        String productCode = envOr("ESEWA_PRODUCT_CODE", production ? "" : "EPAYTEST");
        String secretKey = envOr("ESEWA_SECRET_KEY", production ? "" : "8gBm/:&EnhH.1/q");
        if (productCode.isEmpty() || secretKey.isEmpty()) {
            throw new IllegalStateException("Set ESEWA_PRODUCT_CODE and ESEWA_SECRET_KEY");
        }
        return production
            ? new EsewaGateway(productCode, secretKey,
                "https://epay.esewa.com.np/api/epay/main/v2/form",
                "https://esewa.com.np/api/epay/transaction/status/")
            : new EsewaGateway(productCode, secretKey,
                "https://rc-epay.esewa.com.np/api/epay/main/v2/form",
                "https://rc.esewa.com.np/api/epay/transaction/status/");
    }

    private static String envOr(String name, String fallback) {
        String value = System.getenv(name);
        return value != null ? value : fallback;
    }

    // Paisa to eSewa's rupee text: 10000 -> "100", 10050 -> "100.50".
    // eSewa signs the exact text, so format once and reuse the same string ("100" vs "100.0" fails with ES104).
    static String rupees(long paisa) {
        return paisa % 100 == 0 ? Long.toString(paisa / 100) : String.format(Locale.ROOT, "%d.%02d", paisa / 100, paisa % 100);
    }`,
      sign: `    // base64(HMAC-SHA256(key, message)).
    public static String hmacBase64(String key, String message) {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(key.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
            return Base64.getEncoder().encodeToString(mac.doFinal(message.getBytes(StandardCharsets.UTF_8)));
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException(e);
        }
    }

    // eSewa signs "name1=value1,name2=value2,..." in the order of signed_field_names. No spaces.
    private String signFields(Map<String, String> fields, List<String> names) {
        List<String> parts = new ArrayList<>();
        for (String n : names) parts.add(n + "=" + fields.getOrDefault(n, ""));
        return hmacBase64(secretKey, String.join(",", parts));
    }`,
      start: `    // Returns a form the browser auto-POSTs to eSewa. All nine fields plus the signature are required.
    @Override
    public Start startPayment(String attemptId, long amountPaisa, String returnUrl, String description) {
        String total = rupees(amountPaisa);
        Map<String, String> fields = new LinkedHashMap<>();
        fields.put("amount", total);
        fields.put("tax_amount", "0"); // send "0" for unused charges; leaving one out fails with ES200
        fields.put("product_service_charge", "0");
        fields.put("product_delivery_charge", "0");
        fields.put("total_amount", total); // must equal the four above added up
        fields.put("transaction_uuid", attemptId); // letters, digits and "-" only, never reused
        fields.put("product_code", productCode);
        fields.put("success_url", returnUrl); // eSewa appends ?data=..., so no query string here
        fields.put("failure_url", returnUrl);
        fields.put("signed_field_names", "total_amount,transaction_uuid,product_code");
        fields.put("signature", signFields(fields, List.of(fields.get("signed_field_names").split(","))));
        // ePay v2 has no description field, so description is not sent.
        return new Start.Form(formUrl, fields, null);
    }`,
      confirm: `    // eSewa status -> our status. AMBIGUOUS means "payment is at halt state", so keep checking.
    private static final Map<String, String> STATUSES = Map.of(
        "COMPLETE", "paid",
        "PENDING", "pending",
        "AMBIGUOUS", "pending",
        "FULL_REFUND", "refunded",
        "PARTIAL_REFUND", "refunded",
        "CANCELED", "canceled",
        "NOT_FOUND", "not_found"); // never paid, session expired, or the wrong total_amount

    // Value of a signed field as text. Numbers are read from the raw JSON so "1000.0" stays "1000.0".
    private static String fieldText(String json, JsonNode payload, String name) {
        JsonNode v = payload.get(name);
        if (v == null || v.isNull()) return "";
        if (!v.isNumber()) return v.asText();
        Matcher m = Pattern.compile("\\"" + Pattern.quote(name) + "\\"\\\\s*:\\\\s*(-?[0-9][0-9.eE+-]*)").matcher(json);
        return m.find() ? m.group(1) : v.asText();
    }

    // Checks the base64 JSON that eSewa appends to success_url as ?data=. Throws PaymentException if it is forged.
    private void verifyData(String data, String attemptId) {
        String json;
        JsonNode payload;
        try {
            // An unencoded "+" in ?data= arrives as a space after query parsing. Put it back before decoding.
            json = new String(Base64.getDecoder().decode(data.replace(' ', '+')), StandardCharsets.UTF_8);
            payload = JSON.readTree(json);
        } catch (IllegalArgumentException | IOException e) {
            throw new PaymentException("eSewa: data is not base64 JSON");
        }
        if (payload == null || !payload.path("signed_field_names").isTextual() || !payload.path("signature").isTextual()) {
            throw new PaymentException("eSewa: data has no signature");
        }
        String signature = payload.get("signature").asText();
        // Rebuild the message from the payload's own signed_field_names (it lists itself too).
        List<String> names = List.of(payload.get("signed_field_names").asText().split(","));
        Map<String, String> fields = new LinkedHashMap<>();
        for (String n : names) fields.put(n, fieldText(json, payload, n));
        boolean ok = safeEqual(signFields(fields, names), signature);
        // total_amount can come back as "1,000.0". Sources disagree on whether the comma is signed, so try both.
        if (!ok && fields.getOrDefault("total_amount", "").contains(",")) {
            fields.put("total_amount", fields.get("total_amount").replace(",", ""));
            ok = safeEqual(signFields(fields, names), signature);
        }
        if (!ok) throw new PaymentException("eSewa: bad signature on data");
        if (!attemptId.equals(payload.path("transaction_uuid").asText(null))
            || !productCode.equals(payload.path("product_code").asText(null))) {
            throw new PaymentException("eSewa: data is for a different payment");
        }
    }

    // Constant-time comparison, so response timing leaks nothing about the right value.
    private static boolean safeEqual(String a, String b) {
        return MessageDigest.isEqual(a.getBytes(StandardCharsets.UTF_8), b.getBytes(StandardCharsets.UTF_8));
    }

    // Called from the return route (params = query + body) and from the reconcile job (empty params).
    @Override
    public Outcome confirmPayment(String attemptId, long amountPaisa, String providerRef, Map<String, String> params) {
        String data = params.get("data");
        if (data != null && !data.isEmpty()) verifyData(data, attemptId);

        // The status API is the real answer. Send the STORED total: a wrong one answers NOT_FOUND,
        // so this doubles as the amount check.
        String query = "product_code=" + URLEncoder.encode(productCode, StandardCharsets.UTF_8)
            + "&total_amount=" + rupees(amountPaisa)
            + "&transaction_uuid=" + URLEncoder.encode(attemptId, StandardCharsets.UTF_8);
        HttpRequest request = HttpRequest.newBuilder(URI.create(statusUrl + "?" + query))
            .timeout(Duration.ofSeconds(15)).GET().build();
        JsonNode body;
        HttpResponse<String> res;
        try {
            res = http.send(request, HttpResponse.BodyHandlers.ofString());
            body = JSON.readTree(res.body());
        } catch (IOException e) {
            throw new IllegalStateException("eSewa status check failed: " + e.getMessage(), e);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("eSewa status check interrupted", e);
        }
        // Outages look like {"code":0,"error_message":"Service is currently unavailable"}. Retry later.
        if (res.statusCode() != 200 || body == null || !body.path("status").isTextual()) {
            throw new IllegalStateException("eSewa status check failed: HTTP " + res.statusCode() + " " + res.body());
        }
        if (Math.round(body.path("total_amount").asDouble() * 100) != amountPaisa) {
            throw new PaymentException("eSewa: amount mismatch (" + body.path("total_amount") + ")");
        }
        // Unknown values count as pending, so the reconcile job keeps asking.
        String status = STATUSES.getOrDefault(body.get("status").asText(), "pending");
        String ref = body.path("ref_id").isTextual() ? body.get("ref_id").asText() : null;
        return new Outcome(status, ref);
    }
}`,
    },
  },
  kotlin: {
    file: "src/main/kotlin/payments/EsewaGateway.kt",
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
import java.util.Base64
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
import kotlinx.serialization.json.doubleOrNull

// eSewa ePay v2. Sandbox unless ESEWA_ENV=production.
class EsewaGateway(
    private val productCode: String,
    secretKey: String,
    private val formUrl: String,
    private val statusUrl: String,
) : Gateway {
    // Config UIs and templates sometimes turn "&" into "&amp;", which breaks every signature. Undo it.
    private val secretKey = secretKey.replace("&amp;", "&")
    private val http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build()

    companion object {
        fun fromEnv(): EsewaGateway {
            val production = System.getenv("ESEWA_ENV") == "production"
            // Sandbox defaults are eSewa's public test credentials. Production needs your own.
            val productCode = System.getenv("ESEWA_PRODUCT_CODE") ?: if (production) "" else "EPAYTEST"
            val secretKey = System.getenv("ESEWA_SECRET_KEY") ?: if (production) "" else "8gBm/:&EnhH.1/q"
            check(productCode.isNotEmpty() && secretKey.isNotEmpty()) { "Set ESEWA_PRODUCT_CODE and ESEWA_SECRET_KEY" }
            return if (production) {
                EsewaGateway(productCode, secretKey,
                    "https://epay.esewa.com.np/api/epay/main/v2/form",
                    "https://esewa.com.np/api/epay/transaction/status/")
            } else {
                EsewaGateway(productCode, secretKey,
                    "https://rc-epay.esewa.com.np/api/epay/main/v2/form",
                    "https://rc.esewa.com.np/api/epay/transaction/status/")
            }
        }

        // Paisa to eSewa's rupee text: 10000 -> "100", 10050 -> "100.50".
        // eSewa signs the exact text, so format once and reuse the same string ("100" vs "100.0" fails with ES104).
        fun rupees(paisa: Long): String =
            if (paisa % 100 == 0L) "\${paisa / 100}" else "\${paisa / 100}.\${(paisa % 100).toString().padStart(2, '0')}"
    }`,
      sign: `    // base64(HMAC-SHA256(key, message)).
    fun hmacBase64(key: String, message: String): String {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(key.toByteArray(), "HmacSHA256"))
        return Base64.getEncoder().encodeToString(mac.doFinal(message.toByteArray()))
    }

    // eSewa signs "name1=value1,name2=value2,..." in the order of signed_field_names. No spaces.
    private fun signFields(fields: Map<String, String>, names: List<String>): String =
        hmacBase64(secretKey, names.joinToString(",") { "$it=\${fields[it] ?: ""}" })

    // Constant-time comparison, so response timing leaks nothing about the right value.
    private fun safeEqual(a: String, b: String) = MessageDigest.isEqual(a.toByteArray(), b.toByteArray())`,
      start: `    // Returns a form the browser auto-POSTs to eSewa. All nine fields plus the signature are required.
    override suspend fun startPayment(attemptId: String, amountPaisa: Long, returnUrl: String, description: String): Start {
        val total = rupees(amountPaisa)
        val fields = linkedMapOf(
            "amount" to total,
            "tax_amount" to "0", // send "0" for unused charges; leaving one out fails with ES200
            "product_service_charge" to "0",
            "product_delivery_charge" to "0",
            "total_amount" to total, // must equal the four above added up
            "transaction_uuid" to attemptId, // letters, digits and "-" only, never reused
            "product_code" to productCode,
            "success_url" to returnUrl, // eSewa appends ?data=..., so no query string here
            "failure_url" to returnUrl,
            "signed_field_names" to "total_amount,transaction_uuid,product_code",
        )
        fields["signature"] = signFields(fields, fields.getValue("signed_field_names").split(","))
        // ePay v2 has no description field, so description is not sent.
        return Start.Form(formUrl, fields)
    }`,
      confirm: `    // eSewa status -> our status. AMBIGUOUS means "payment is at halt state", so keep checking.
    private val statuses = mapOf(
        "COMPLETE" to "paid",
        "PENDING" to "pending",
        "AMBIGUOUS" to "pending",
        "FULL_REFUND" to "refunded",
        "PARTIAL_REFUND" to "refunded",
        "CANCELED" to "canceled",
        "NOT_FOUND" to "not_found", // never paid, session expired, or the wrong total_amount
    )

    // A JSON value as text. JsonPrimitive.content keeps numbers as eSewa wrote them ("1000.0" stays "1000.0").
    private fun JsonElement?.text(): String? = (this as? JsonPrimitive)?.takeIf { it !is JsonNull }?.content

    // Checks the base64 JSON that eSewa appends to success_url as ?data=. Throws PaymentException if it is forged.
    private fun verifyData(data: String, attemptId: String) {
        val payload = try {
            // An unencoded "+" in ?data= arrives as a space after query parsing. Put it back before decoding.
            val json = String(Base64.getDecoder().decode(data.replace(' ', '+')))
            Json.parseToJsonElement(json) as JsonObject
        } catch (e: Exception) {
            throw PaymentException("eSewa: data is not base64 JSON")
        }
        val signature = payload["signature"].text()
        val signedNames = payload["signed_field_names"].text()
        if (signature == null || signedNames == null) throw PaymentException("eSewa: data has no signature")
        // Rebuild the message from the payload's own signed_field_names (it lists itself too).
        val names = signedNames.split(",")
        val fields = names.associateWith { payload[it].text() ?: "" }
        var ok = safeEqual(signFields(fields, names), signature)
        // total_amount can come back as "1,000.0". Sources disagree on whether the comma is signed, so try both.
        val total = fields["total_amount"] ?: ""
        if (!ok && "," in total) {
            ok = safeEqual(signFields(fields + ("total_amount" to total.replace(",", "")), names), signature)
        }
        if (!ok) throw PaymentException("eSewa: bad signature on data")
        if (payload["transaction_uuid"].text() != attemptId || payload["product_code"].text() != productCode) {
            throw PaymentException("eSewa: data is for a different payment")
        }
    }

    // Called from the return route (params = query + body) and from the reconcile job (empty params).
    override suspend fun confirmPayment(attemptId: String, amountPaisa: Long, providerRef: String?, params: Map<String, String>): Outcome {
        params["data"]?.takeIf { it.isNotEmpty() }?.let { verifyData(it, attemptId) }

        // The status API is the real answer. Send the STORED total: a wrong one answers NOT_FOUND,
        // so this doubles as the amount check.
        val query = "product_code=\${URLEncoder.encode(productCode, Charsets.UTF_8)}" +
            "&total_amount=\${rupees(amountPaisa)}" +
            "&transaction_uuid=\${URLEncoder.encode(attemptId, Charsets.UTF_8)}"
        val request = HttpRequest.newBuilder(URI.create("$statusUrl?$query")).timeout(Duration.ofSeconds(15)).GET().build()
        val res = withContext(Dispatchers.IO) { http.send(request, HttpResponse.BodyHandlers.ofString()) }
        val body = runCatching { Json.parseToJsonElement(res.body()) as JsonObject }.getOrNull()
        val esewaStatus = body?.get("status").text()
        // Outages look like {"code":0,"error_message":"Service is currently unavailable"}. Retry later.
        if (res.statusCode() != 200 || body == null || esewaStatus == null) {
            throw IllegalStateException("eSewa status check failed: HTTP \${res.statusCode()} \${res.body()}")
        }
        val total = (body["total_amount"] as? JsonPrimitive)?.doubleOrNull
        if (total == null || (total * 100).roundToLong() != amountPaisa) {
            throw PaymentException("eSewa: amount mismatch (\${body["total_amount"]})")
        }
        // Unknown values count as pending, so the reconcile job keeps asking.
        return Outcome(statuses[esewaStatus] ?: "pending", body["ref_id"].text())
    }
}`,
    },
  },
};

// Signature vectors from references/esewa.md section 4: base64(HMAC-SHA256(key, message)).
// eSewa's own docs print wrong example signatures; these reproduce with OpenSSL and the live sandbox.
export const vectors: { key: string; message: string; signature: string }[] = [
  { key: "8gBm/:&EnhH.1/q", message: "total_amount=100,transaction_uuid=11-201-13,product_code=EPAYTEST", signature: "5DZywcrTKD0gia/rsSMcrRHmJl+4Tbol6S+lWgdJ94E=" },
  { key: "8gBm/:&EnhH.1/q", message: "total_amount=110,transaction_uuid=ab14a8f2b02c3,product_code=EPAYTEST", signature: "0Gh9pc1fiZDZH7OKOBdn42QMx8drH7tOeMPdRQhI83g=" },
  { key: "LB0REg8HUSw3MTYrI1s6JTE8Kyc6JyAqJiA3MQ==", message: "product_code=INTENT,amount=100,transaction_uuid=txn-20251220-001", signature: "oVRo2ZkjNpbt5vKs7RSNx1OCcewDaVssoguWsG31HMA=" },
];

export default esewa;

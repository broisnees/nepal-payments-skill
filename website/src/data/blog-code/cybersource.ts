// Generated CyberSource Secure Acceptance gateway module, one per language.
// The parts joined with "\n\n" in order (config, sign, start, confirm) form the complete file.

export interface GatewayCode {
  file: string;
  lang: string;
  parts: { config: string; sign: string; start: string; confirm: string };
}

export const cybersource: Record<"ts" | "python" | "php" | "go" | "java" | "kotlin", GatewayCode> = {
  ts: {
    file: "cybersource.ts",
    lang: "typescript",
    parts: {
      config: `import { PaymentError, type ConfirmInput, type Outcome, type PaymentStatus, type Start, type StartInput } from "./payments";

// CyberSource Secure Acceptance Hosted Checkout. Test environment unless CYBERSOURCE_ENV=production.
const PRODUCTION = process.env.CYBERSOURCE_ENV === "production";

const PAY_URL = PRODUCTION
  ? "https://secureacceptance.cybersource.com/pay"
  : "https://testsecureacceptance.cybersource.com/pay";

// No public test credentials exist. Your bank sets up a test profile; test and live keys differ.
const PROFILE_ID = process.env.CYBERSOURCE_PROFILE_ID ?? "";
const ACCESS_KEY = process.env.CYBERSOURCE_ACCESS_KEY ?? "";
// Used as the raw text. Do not base64-decode it: that is the REST API rule, not this one.
const SECRET_KEY = process.env.CYBERSOURCE_SECRET_KEY ?? "";
const CURRENCY = process.env.CYBERSOURCE_CURRENCY ?? "NPR";
if (!PROFILE_ID || !ACCESS_KEY || !SECRET_KEY) {
  throw new Error("Set CYBERSOURCE_PROFILE_ID, CYBERSOURCE_ACCESS_KEY and CYBERSOURCE_SECRET_KEY");
}

// Paisa to CyberSource's amount text, always two decimals: 10000 -> "100.00".
function rupees(paisa: number): string {
  return \`\${Math.floor(paisa / 100)}.\${String(paisa % 100).padStart(2, "0")}\`;
}

// UTC with a trailing Z and no milliseconds: "2026-11-04T10:15:30Z". Keep the server clock in sync (NTP).
function signedDateTime(): string {
  return new Date().toISOString().replace(/\\.\\d{3}Z$/, "Z");
}

// A sale needs the buyer's billing details. The demo order has no buyer, so these are placeholders:
// load the real name, email and address from your order instead.
const BILL_TO: Record<string, string> = {
  bill_to_forename: "Demo",
  bill_to_surname: "Buyer",
  bill_to_email: "buyer@example.com",
  bill_to_address_line1: "Durbar Marg",
  bill_to_address_city: "Kathmandu",
  bill_to_address_country: "NP", // state and postal code are only for the US and Canada
};`,
      sign: `// base64(HMAC-SHA256(key, message)) with Web Crypto, so it runs on Node, Bun, Deno and edge runtimes.
export async function hmacBase64(key: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(message)));
  return btoa(String.fromCharCode(...mac));
}

// CyberSource signs "name1=value1,name2=value2,..." in the order of signed_field_names.
// Values go in as they are: no URL-encoding, no trimming.
function sign(fields: Record<string, string>): Promise<string> {
  const names = fields.signed_field_names.split(",");
  return hmacBase64(SECRET_KEY, names.map((n) => \`\${n}=\${fields[n] ?? ""}\`).join(","));
}

// Compare signatures in constant time, so response timing leaks nothing about the right value.
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}`,
      start: `// Returns a form the browser auto-POSTs to the hosted pay page. Every field below is signed.
export async function startPayment(input: StartInput): Promise<Start> {
  const fields: Record<string, string> = {
    access_key: ACCESS_KEY,
    profile_id: PROFILE_ID,
    transaction_uuid: input.attemptId, // unique per attempt; reusing one within 15 minutes fails with 104
    signed_field_names: "", // filled in below, keeps its place in the order
    unsigned_field_names: "", // sent empty, and signed like the rest
    signed_date_time: signedDateTime(),
    locale: "en-us",
    transaction_type: "sale", // authorize and capture in one step
    reference_number: input.attemptId, // comes back as req_reference_number
    amount: rupees(input.amountPaisa),
    currency: CURRENCY,
    ...BILL_TO,
    // Send the buyer back to this attempt's return route. These URLs must be HTTPS.
    override_custom_receipt_page: input.returnUrl,
    override_custom_cancel_page: input.returnUrl,
  };
  fields.signed_field_names = Object.keys(fields).join(",");
  fields.signature = await sign(fields);
  // input.description is not sent: none of these fields is meant for it.
  return { type: "form", action: PAY_URL, fields };
}`,
      confirm: `// decision -> our status. Only a sale that came back ACCEPT is money you keep.
function statusOf(p: Record<string, string>): PaymentStatus {
  switch ((p.decision ?? "").toUpperCase()) {
    case "ACCEPT":
      return p.req_transaction_type === "sale" ? "paid" : "pending"; // an authorization is not captured yet
    case "REVIEW":
      return "pending"; // held for manual review in the Business Center
    case "DECLINE":
    case "ERROR":
      // 150, 151, 152 are system errors and timeouts: the card may still have been charged.
      return ["150", "151", "152"].includes(p.reason_code) ? "pending" : "failed";
    case "CANCEL":
      return "canceled";
    default:
      return "pending";
  }
}

// Rupee text to paisa: "100.00" -> 10000. Anything unreadable gives NaN, which never matches.
const paisa = (text: string) => Math.round(Number(text) * 100);

// Checks the signed result CyberSource POSTs back and keeps only the signed fields.
// Throws PaymentError if it is forged or belongs to another payment.
async function verifyResponse(params: Record<string, string>, attemptId: string): Promise<Record<string, string>> {
  if (!params.signed_field_names || !params.signature) throw new PaymentError("CyberSource: response is not signed");
  // The response names its own signed fields. Rebuild the message from that list with the same key.
  if (!safeEqual(await sign(params), params.signature)) throw new PaymentError("CyberSource: bad signature on response");
  // Read only what the signature covers. Any other field in the POST could come from anyone.
  const signed: Record<string, string> = {};
  for (const n of params.signed_field_names.split(",")) if (Object.hasOwn(params, n)) signed[n] = params[n];
  if (signed.req_reference_number !== attemptId) throw new PaymentError("CyberSource: response is for a different payment");
  if (signed.req_currency && signed.req_currency !== CURRENCY) throw new PaymentError("CyberSource: currency mismatch");
  return signed;
}

// Called from the return route (params = query + body) and from the reconcile job (params = {}).
export async function confirmPayment(input: ConfirmInput): Promise<Outcome> {
  // Secure Acceptance has no status API. Without a signed POST there is nothing to check, so the attempt
  // stays pending until the Merchant POST arrives or you settle it from the Business Center.
  const { params } = input;
  if (!params.signature && !params.signed_field_names && !params.decision) return { status: "pending" };

  const p = await verifyResponse(params, input.attemptId);
  const status = statusOf(p);
  // Compare with the STORED amount. auth_amount is what the card was charged: a partial approval
  // (reason 110) has a lower auth_amount and fails here instead of fulfilling a short payment.
  const amount = p.auth_amount || p.req_amount;
  if ((amount || status === "paid") && paisa(amount ?? "") !== input.amountPaisa) {
    throw new PaymentError(\`CyberSource: amount mismatch (\${amount})\`);
  }
  return { status, providerRef: p.transaction_id || undefined };
}`,
    },
  },
  python: {
    file: "cybersource.py",
    lang: "python",
    parts: {
      config: `import base64
import hashlib
import hmac
import os
from datetime import datetime, timezone

from payments import Outcome, PaymentError, Start

# CyberSource Secure Acceptance Hosted Checkout. Test environment unless CYBERSOURCE_ENV=production.
PRODUCTION = os.environ.get("CYBERSOURCE_ENV") == "production"

if PRODUCTION:
    PAY_URL = "https://secureacceptance.cybersource.com/pay"
else:
    PAY_URL = "https://testsecureacceptance.cybersource.com/pay"

# No public test credentials exist. Your bank sets up a test profile; test and live keys differ.
PROFILE_ID = os.environ.get("CYBERSOURCE_PROFILE_ID", "")
ACCESS_KEY = os.environ.get("CYBERSOURCE_ACCESS_KEY", "")
# Used as the raw text. Do not base64-decode it: that is the REST API rule, not this one.
SECRET_KEY = os.environ.get("CYBERSOURCE_SECRET_KEY", "")
CURRENCY = os.environ.get("CYBERSOURCE_CURRENCY", "NPR")
if not PROFILE_ID or not ACCESS_KEY or not SECRET_KEY:
    raise RuntimeError("Set CYBERSOURCE_PROFILE_ID, CYBERSOURCE_ACCESS_KEY and CYBERSOURCE_SECRET_KEY")


def rupees(paisa: int) -> str:
    """Paisa to CyberSource's amount text, always two decimals: 10000 -> "100.00"."""
    whole, rest = divmod(paisa, 100)
    return f"{whole}.{rest:02d}"


def signed_date_time() -> str:
    """UTC with a trailing Z and no fraction: "2026-11-04T10:15:30Z". Keep the server clock in sync (NTP)."""
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# A sale needs the buyer's billing details. The demo order has no buyer, so these are placeholders:
# load the real name, email and address from your order instead.
BILL_TO = {
    "bill_to_forename": "Demo",
    "bill_to_surname": "Buyer",
    "bill_to_email": "buyer@example.com",
    "bill_to_address_line1": "Durbar Marg",
    "bill_to_address_city": "Kathmandu",
    "bill_to_address_country": "NP",  # state and postal code are only for the US and Canada
}`,
      sign: `def hmac_base64(key: str, message: str) -> str:
    """base64(HMAC-SHA256(key, message))."""
    mac = hmac.new(key.encode(), message.encode(), hashlib.sha256).digest()
    return base64.b64encode(mac).decode()


def sign(fields: dict[str, str]) -> str:
    """CyberSource signs "name1=value1,name2=value2,..." in the order of signed_field_names.
    Values go in as they are: no URL-encoding, no trimming."""
    names = fields["signed_field_names"].split(",")
    return hmac_base64(SECRET_KEY, ",".join(f"{n}={fields.get(n, '')}" for n in names))`,
      start: `def start_payment(attempt_id: str, amount_paisa: int, return_url: str, description: str) -> Start:
    """Returns a form the browser auto-POSTs to the hosted pay page. Every field below is signed."""
    fields = {
        "access_key": ACCESS_KEY,
        "profile_id": PROFILE_ID,
        "transaction_uuid": attempt_id,  # unique per attempt; reusing one within 15 minutes fails with 104
        "signed_field_names": "",  # filled in below, keeps its place in the order
        "unsigned_field_names": "",  # sent empty, and signed like the rest
        "signed_date_time": signed_date_time(),
        "locale": "en-us",
        "transaction_type": "sale",  # authorize and capture in one step
        "reference_number": attempt_id,  # comes back as req_reference_number
        "amount": rupees(amount_paisa),
        "currency": CURRENCY,
        **BILL_TO,
        # Send the buyer back to this attempt's return route. These URLs must be HTTPS.
        "override_custom_receipt_page": return_url,
        "override_custom_cancel_page": return_url,
    }
    fields["signed_field_names"] = ",".join(fields)
    fields["signature"] = sign(fields)
    # description is not sent: none of these fields is meant for it.
    return Start(type="form", action=PAY_URL, fields=fields)`,
      confirm: `def _status_of(p: dict[str, str]) -> str:
    """decision -> our status. Only a sale that came back ACCEPT is money you keep."""
    decision = p.get("decision", "").upper()
    if decision == "ACCEPT":
        return "paid" if p.get("req_transaction_type") == "sale" else "pending"  # an authorization is not captured yet
    if decision == "REVIEW":
        return "pending"  # held for manual review in the Business Center
    if decision in ("DECLINE", "ERROR"):
        # 150, 151, 152 are system errors and timeouts: the card may still have been charged.
        return "pending" if p.get("reason_code") in ("150", "151", "152") else "failed"
    if decision == "CANCEL":
        return "canceled"
    return "pending"


def _paisa(text: str) -> int:
    """Rupee text to paisa: "100.00" -> 10000. Anything unreadable gives -1, which never matches."""
    try:
        return round(float(text) * 100)
    except (ValueError, OverflowError):
        return -1


def _verify_response(params: dict[str, str], attempt_id: str) -> dict[str, str]:
    """Checks the signed result CyberSource POSTs back and keeps only the signed fields.
    Raises PaymentError if it is forged or belongs to another payment."""
    if not params.get("signed_field_names") or not params.get("signature"):
        raise PaymentError("CyberSource: response is not signed")
    # The response names its own signed fields. Rebuild the message from that list with the same key.
    if not hmac.compare_digest(sign(params), params["signature"]):
        raise PaymentError("CyberSource: bad signature on response")
    # Read only what the signature covers. Any other field in the POST could come from anyone.
    signed = {n: params[n] for n in params["signed_field_names"].split(",") if n in params}
    if signed.get("req_reference_number") != attempt_id:
        raise PaymentError("CyberSource: response is for a different payment")
    if signed.get("req_currency") and signed["req_currency"] != CURRENCY:
        raise PaymentError("CyberSource: currency mismatch")
    return signed


def confirm_payment(attempt_id: str, amount_paisa: int, provider_ref: str | None, params: dict[str, str]) -> Outcome:
    """Called from the return route (params = query + body) and from the reconcile job (params = {})."""
    # Secure Acceptance has no status API. Without a signed POST there is nothing to check, so the attempt
    # stays pending until the Merchant POST arrives or you settle it from the Business Center.
    if not params.get("signature") and not params.get("signed_field_names") and not params.get("decision"):
        return Outcome(status="pending")

    p = _verify_response(params, attempt_id)
    status = _status_of(p)
    # Compare with the STORED amount. auth_amount is what the card was charged: a partial approval
    # (reason 110) has a lower auth_amount and fails here instead of fulfilling a short payment.
    amount = p.get("auth_amount") or p.get("req_amount") or ""
    if (amount or status == "paid") and _paisa(amount) != amount_paisa:
        raise PaymentError(f"CyberSource: amount mismatch ({amount})")
    return Outcome(status=status, provider_ref=p.get("transaction_id") or None)`,
    },
  },
  php: {
    file: "CybersourceGateway.php",
    lang: "php",
    parts: {
      config: `<?php

declare(strict_types=1);

namespace App\\Payments;

// CyberSource Secure Acceptance Hosted Checkout. Test environment unless CYBERSOURCE_ENV=production.
final class CybersourceGateway implements Gateway
{
    // A sale needs the buyer's billing details. The demo order has no buyer, so these are placeholders:
    // load the real name, email and address from your order instead.
    private const BILL_TO = [
        'bill_to_forename' => 'Demo',
        'bill_to_surname' => 'Buyer',
        'bill_to_email' => 'buyer@example.com',
        'bill_to_address_line1' => 'Durbar Marg',
        'bill_to_address_city' => 'Kathmandu',
        'bill_to_address_country' => 'NP', // state and postal code are only for the US and Canada
    ];

    public function __construct(
        private string $profileId,
        private string $accessKey,
        private string $secretKey,
        private string $currency,
        private string $payUrl,
    ) {
    }

    public static function fromEnv(): self
    {
        $env = static fn (string $name) => $_ENV[$name] ?? (getenv($name) !== false ? getenv($name) : null);
        $production = $env('CYBERSOURCE_ENV') === 'production';
        // No public test credentials exist. Your bank sets up a test profile; test and live keys differ.
        $profileId = $env('CYBERSOURCE_PROFILE_ID') ?? '';
        $accessKey = $env('CYBERSOURCE_ACCESS_KEY') ?? '';
        // Used as the raw text. Do not base64-decode it: that is the REST API rule, not this one.
        $secretKey = $env('CYBERSOURCE_SECRET_KEY') ?? '';
        if ($profileId === '' || $accessKey === '' || $secretKey === '') {
            throw new \\RuntimeException('Set CYBERSOURCE_PROFILE_ID, CYBERSOURCE_ACCESS_KEY and CYBERSOURCE_SECRET_KEY');
        }
        return new self($profileId, $accessKey, $secretKey, $env('CYBERSOURCE_CURRENCY') ?? 'NPR', $production
            ? 'https://secureacceptance.cybersource.com/pay'
            : 'https://testsecureacceptance.cybersource.com/pay');
    }

    // Paisa to CyberSource's amount text, always two decimals: 10000 -> "100.00".
    private static function rupees(int $paisa): string
    {
        return sprintf('%d.%02d', intdiv($paisa, 100), $paisa % 100);
    }`,
      sign: `    // base64(HMAC-SHA256(key, message)).
    public static function hmacBase64(string $key, string $message): string
    {
        return base64_encode(hash_hmac('sha256', $message, $key, true));
    }

    // CyberSource signs "name1=value1,name2=value2,..." in the order of signed_field_names.
    // Values go in as they are: no URL-encoding, no trimming.
    private function sign(array $fields): string
    {
        $names = explode(',', (string) $fields['signed_field_names']);
        $parts = array_map(fn (string $n) => $n . '=' . ($fields[$n] ?? ''), $names);
        return self::hmacBase64($this->secretKey, implode(',', $parts));
    }`,
      start: `    // Returns a form the browser auto-POSTs to the hosted pay page. Every field below is signed.
    public function startPayment(string $attemptId, int $amountPaisa, string $returnUrl, string $description): Start
    {
        $fields = [
            'access_key' => $this->accessKey,
            'profile_id' => $this->profileId,
            'transaction_uuid' => $attemptId, // unique per attempt; reusing one within 15 minutes fails with 104
            'signed_field_names' => '', // filled in below, keeps its place in the order
            'unsigned_field_names' => '', // sent empty, and signed like the rest
            // UTC with a trailing Z: "2026-11-04T10:15:30Z". Keep the server clock in sync (NTP).
            'signed_date_time' => gmdate('Y-m-d\\TH:i:s\\Z'),
            'locale' => 'en-us',
            'transaction_type' => 'sale', // authorize and capture in one step
            'reference_number' => $attemptId, // comes back as req_reference_number
            'amount' => self::rupees($amountPaisa),
            'currency' => $this->currency,
            ...self::BILL_TO,
            // Send the buyer back to this attempt's return route. These URLs must be HTTPS.
            'override_custom_receipt_page' => $returnUrl,
            'override_custom_cancel_page' => $returnUrl,
        ];
        $fields['signed_field_names'] = implode(',', array_keys($fields));
        $fields['signature'] = $this->sign($fields);
        // $description is not sent: none of these fields is meant for it.
        return Start::form($this->payUrl, $fields);
    }`,
      confirm: `    // decision -> our status. Only a sale that came back ACCEPT is money you keep.
    private static function statusOf(array $p): string
    {
        return match (strtoupper($p['decision'] ?? '')) {
            // an authorization is not captured yet
            'ACCEPT' => ($p['req_transaction_type'] ?? '') === 'sale' ? 'paid' : 'pending',
            'REVIEW' => 'pending', // held for manual review in the Business Center
            // 150, 151, 152 are system errors and timeouts: the card may still have been charged.
            'DECLINE', 'ERROR' => in_array($p['reason_code'] ?? '', ['150', '151', '152'], true) ? 'pending' : 'failed',
            'CANCEL' => 'canceled',
            default => 'pending',
        };
    }

    // Checks the signed result CyberSource POSTs back and keeps only the signed fields.
    // Throws PaymentError if it is forged or belongs to another payment.
    private function verifyResponse(array $params, string $attemptId): array
    {
        if (empty($params['signed_field_names']) || empty($params['signature'])) {
            throw new PaymentError('CyberSource: response is not signed');
        }
        // The response names its own signed fields. Rebuild the message from that list with the same key.
        if (!hash_equals($this->sign($params), (string) $params['signature'])) {
            throw new PaymentError('CyberSource: bad signature on response');
        }
        // Read only what the signature covers. Any other field in the POST could come from anyone.
        $signed = array_intersect_key($params, array_flip(explode(',', (string) $params['signed_field_names'])));
        if (($signed['req_reference_number'] ?? null) !== $attemptId) {
            throw new PaymentError('CyberSource: response is for a different payment');
        }
        if (!empty($signed['req_currency']) && $signed['req_currency'] !== $this->currency) {
            throw new PaymentError('CyberSource: currency mismatch');
        }
        return $signed;
    }

    // Called from the return route (params = query + body) and from the reconcile job (params = []).
    public function confirmPayment(string $attemptId, int $amountPaisa, ?string $providerRef, array $params): Outcome
    {
        // Secure Acceptance has no status API. Without a signed POST there is nothing to check, so the attempt
        // stays pending until the Merchant POST arrives or you settle it from the Business Center.
        if (empty($params['signature']) && empty($params['signed_field_names']) && empty($params['decision'])) {
            return new Outcome('pending');
        }

        $p = $this->verifyResponse($params, $attemptId);
        $status = self::statusOf($p);
        // Compare with the STORED amount. auth_amount is what the card was charged: a partial approval
        // (reason 110) has a lower auth_amount and fails here instead of fulfilling a short payment.
        $amount = (string) (($p['auth_amount'] ?? '') !== '' ? $p['auth_amount'] : ($p['req_amount'] ?? ''));
        $paid = is_numeric($amount) ? (int) round((float) $amount * 100) : -1;
        if (($amount !== '' || $status === 'paid') && $paid !== $amountPaisa) {
            throw new PaymentError("CyberSource: amount mismatch ($amount)");
        }
        return new Outcome($status, ($p['transaction_id'] ?? '') !== '' ? (string) $p['transaction_id'] : null);
    }
}`,
    },
  },
  go: {
    file: "payments/cybersource.go",
    lang: "go",
    parts: {
      config: `package payments

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"math"
	"os"
	"strconv"
	"strings"
	"time"
)

// Cybersource is CyberSource Secure Acceptance Hosted Checkout. Test environment unless CYBERSOURCE_ENV=production.
type Cybersource struct {
	profileID, accessKey, secretKey, currency, payURL string
}

func NewCybersource() *Cybersource {
	c := &Cybersource{
		// No public test credentials exist. Your bank sets up a test profile; test and live keys differ.
		profileID: os.Getenv("CYBERSOURCE_PROFILE_ID"),
		accessKey: os.Getenv("CYBERSOURCE_ACCESS_KEY"),
		// Used as the raw text. Do not base64-decode it: that is the REST API rule, not this one.
		secretKey: os.Getenv("CYBERSOURCE_SECRET_KEY"),
		currency:  os.Getenv("CYBERSOURCE_CURRENCY"),
		payURL:    "https://testsecureacceptance.cybersource.com/pay",
	}
	if os.Getenv("CYBERSOURCE_ENV") == "production" {
		c.payURL = "https://secureacceptance.cybersource.com/pay"
	}
	if c.currency == "" {
		c.currency = "NPR"
	}
	if c.profileID == "" || c.accessKey == "" || c.secretKey == "" {
		panic("set CYBERSOURCE_PROFILE_ID, CYBERSOURCE_ACCESS_KEY and CYBERSOURCE_SECRET_KEY")
	}
	return c
}

// cybersourceAmount turns paisa into CyberSource's amount text, always two decimals: 10000 -> "100.00".
func cybersourceAmount(paisa int64) string {
	return fmt.Sprintf("%d.%02d", paisa/100, paisa%100)
}

// cybersourceBillTo holds the billing details a sale needs. The demo order has no buyer, so these are
// placeholders: load the real name, email and address from your order instead.
var cybersourceBillTo = [][2]string{
	{"bill_to_forename", "Demo"},
	{"bill_to_surname", "Buyer"},
	{"bill_to_email", "buyer@example.com"},
	{"bill_to_address_line1", "Durbar Marg"},
	{"bill_to_address_city", "Kathmandu"},
	{"bill_to_address_country", "NP"}, // state and postal code are only for the US and Canada
}`,
      sign: `// CybersourceHMAC returns base64(HMAC-SHA256(key, message)). The name is gateway-specific so this
// file can sit next to other gateway files in the same package.
func CybersourceHMAC(key, message string) string {
	mac := hmac.New(sha256.New, []byte(key))
	mac.Write([]byte(message))
	return base64.StdEncoding.EncodeToString(mac.Sum(nil))
}

// sign signs "name1=value1,name2=value2,..." in the order of signed_field_names.
// Values go in as they are: no URL-encoding, no trimming.
func (c *Cybersource) sign(fields map[string]string) string {
	names := strings.Split(fields["signed_field_names"], ",")
	parts := make([]string, len(names))
	for i, n := range names {
		parts[i] = n + "=" + fields[n]
	}
	return CybersourceHMAC(c.secretKey, strings.Join(parts, ","))
}`,
      start: `// StartPayment returns a form the browser auto-POSTs to the hosted pay page. Every field below is signed.
func (c *Cybersource) StartPayment(ctx context.Context, in StartInput) (Start, error) {
	// A slice, not a map, because the order of signed_field_names is the order we list here.
	pairs := [][2]string{
		{"access_key", c.accessKey},
		{"profile_id", c.profileID},
		{"transaction_uuid", in.AttemptID}, // unique per attempt; reusing one within 15 minutes fails with 104
		{"signed_field_names", ""},         // filled in below, keeps its place in the order
		{"unsigned_field_names", ""},       // sent empty, and signed like the rest
		// UTC with a trailing Z: "2026-11-04T10:15:30Z". Keep the server clock in sync (NTP).
		{"signed_date_time", time.Now().UTC().Format("2006-01-02T15:04:05Z")},
		{"locale", "en-us"},
		{"transaction_type", "sale"},       // authorize and capture in one step
		{"reference_number", in.AttemptID}, // comes back as req_reference_number
		{"amount", cybersourceAmount(in.AmountPaisa)},
		{"currency", c.currency},
	}
	pairs = append(pairs, cybersourceBillTo...)
	// Send the buyer back to this attempt's return route. These URLs must be HTTPS.
	pairs = append(pairs, [2]string{"override_custom_receipt_page", in.ReturnURL}, [2]string{"override_custom_cancel_page", in.ReturnURL})

	fields := map[string]string{}
	names := make([]string, len(pairs))
	for i, p := range pairs {
		names[i] = p[0]
		fields[p[0]] = p[1]
	}
	fields["signed_field_names"] = strings.Join(names, ",")
	fields["signature"] = c.sign(fields)
	// in.Description is not sent: none of these fields is meant for it.
	return Start{Type: "form", Action: c.payURL, Fields: fields}, nil
}`,
      confirm: `// cybersourceStatus maps decision to our status. Only a sale that came back ACCEPT is money you keep.
func cybersourceStatus(p map[string]string) string {
	switch strings.ToUpper(p["decision"]) {
	case "ACCEPT":
		if p["req_transaction_type"] == "sale" {
			return "paid"
		}
		return "pending" // an authorization is not captured yet
	case "REVIEW":
		return "pending" // held for manual review in the Business Center
	case "DECLINE", "ERROR":
		// 150, 151, 152 are system errors and timeouts: the card may still have been charged.
		switch p["reason_code"] {
		case "150", "151", "152":
			return "pending"
		}
		return "failed"
	case "CANCEL":
		return "canceled"
	}
	return "pending"
}

// cybersourcePaisa turns rupee text into paisa: "100.00" -> 10000. Anything unreadable gives -1, which never matches.
func cybersourcePaisa(text string) int64 {
	f, err := strconv.ParseFloat(text, 64)
	if err != nil || math.IsNaN(f) || math.IsInf(f, 0) {
		return -1
	}
	return int64(math.Round(f * 100))
}

// verifyResponse checks the signed result CyberSource POSTs back and keeps only the signed fields.
// It returns an ErrPayment error if the result is forged or belongs to another payment.
func (c *Cybersource) verifyResponse(params map[string]string, attemptID string) (map[string]string, error) {
	if params["signed_field_names"] == "" || params["signature"] == "" {
		return nil, fmt.Errorf("%w: CyberSource response is not signed", ErrPayment)
	}
	// The response names its own signed fields. Rebuild the message from that list with the same key.
	if !hmac.Equal([]byte(c.sign(params)), []byte(params["signature"])) {
		return nil, fmt.Errorf("%w: bad signature on CyberSource response", ErrPayment)
	}
	// Read only what the signature covers. Any other field in the POST could come from anyone.
	signed := map[string]string{}
	for _, n := range strings.Split(params["signed_field_names"], ",") {
		if v, ok := params[n]; ok {
			signed[n] = v
		}
	}
	if signed["req_reference_number"] != attemptID {
		return nil, fmt.Errorf("%w: CyberSource response is for a different payment", ErrPayment)
	}
	if signed["req_currency"] != "" && signed["req_currency"] != c.currency {
		return nil, fmt.Errorf("%w: CyberSource currency mismatch", ErrPayment)
	}
	return signed, nil
}

// ConfirmPayment is called from the return route (Params = query + body) and from the reconcile job (empty Params).
func (c *Cybersource) ConfirmPayment(ctx context.Context, in ConfirmInput) (Outcome, error) {
	// Secure Acceptance has no status API. Without a signed POST there is nothing to check, so the attempt
	// stays pending until the Merchant POST arrives or you settle it from the Business Center.
	if in.Params["signature"] == "" && in.Params["signed_field_names"] == "" && in.Params["decision"] == "" {
		return Outcome{Status: "pending"}, nil
	}

	p, err := c.verifyResponse(in.Params, in.AttemptID)
	if err != nil {
		return Outcome{}, err
	}
	status := cybersourceStatus(p)
	// Compare with the STORED amount. auth_amount is what the card was charged: a partial approval
	// (reason 110) has a lower auth_amount and fails here instead of fulfilling a short payment.
	amount := p["auth_amount"]
	if amount == "" {
		amount = p["req_amount"]
	}
	if (amount != "" || status == "paid") && cybersourcePaisa(amount) != in.AmountPaisa {
		return Outcome{}, fmt.Errorf("%w: CyberSource amount mismatch (%s)", ErrPayment, amount)
	}
	return Outcome{Status: status, ProviderRef: p["transaction_id"]}, nil
}`,
    },
  },
  java: {
    file: "src/main/java/payments/CybersourceGateway.java",
    lang: "java",
    parts: {
      config: `package payments;

import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

// CyberSource Secure Acceptance Hosted Checkout. Test environment unless CYBERSOURCE_ENV=production.
public final class CybersourceGateway implements Gateway {
    // UTC with a trailing Z: "2026-11-04T10:15:30Z". Keep the server clock in sync (NTP).
    private static final DateTimeFormatter SIGNED_DATE_TIME =
        DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss'Z'").withZone(ZoneOffset.UTC);
    private final String profileId, accessKey, secretKey, currency, payUrl;

    public CybersourceGateway(String profileId, String accessKey, String secretKey, String currency, String payUrl) {
        this.profileId = profileId;
        this.accessKey = accessKey;
        this.secretKey = secretKey;
        this.currency = currency;
        this.payUrl = payUrl;
    }

    public static CybersourceGateway fromEnv() {
        boolean production = "production".equals(System.getenv("CYBERSOURCE_ENV"));
        // No public test credentials exist. Your bank sets up a test profile; test and live keys differ.
        String profileId = envOr("CYBERSOURCE_PROFILE_ID", "");
        String accessKey = envOr("CYBERSOURCE_ACCESS_KEY", "");
        // Used as the raw text. Do not base64-decode it: that is the REST API rule, not this one.
        String secretKey = envOr("CYBERSOURCE_SECRET_KEY", "");
        if (profileId.isEmpty() || accessKey.isEmpty() || secretKey.isEmpty()) {
            throw new IllegalStateException("Set CYBERSOURCE_PROFILE_ID, CYBERSOURCE_ACCESS_KEY and CYBERSOURCE_SECRET_KEY");
        }
        return new CybersourceGateway(profileId, accessKey, secretKey, envOr("CYBERSOURCE_CURRENCY", "NPR"), production
            ? "https://secureacceptance.cybersource.com/pay"
            : "https://testsecureacceptance.cybersource.com/pay");
    }

    private static String envOr(String name, String fallback) {
        String value = System.getenv(name);
        return value != null ? value : fallback;
    }

    // Paisa to CyberSource's amount text, always two decimals: 10000 -> "100.00".
    static String rupees(long paisa) {
        return String.format(Locale.ROOT, "%d.%02d", paisa / 100, paisa % 100);
    }

    // A sale needs the buyer's billing details. The demo order has no buyer, so these are placeholders:
    // load the real name, email and address from your order instead.
    private static void putBillTo(Map<String, String> fields) {
        fields.put("bill_to_forename", "Demo");
        fields.put("bill_to_surname", "Buyer");
        fields.put("bill_to_email", "buyer@example.com");
        fields.put("bill_to_address_line1", "Durbar Marg");
        fields.put("bill_to_address_city", "Kathmandu");
        fields.put("bill_to_address_country", "NP"); // state and postal code are only for the US and Canada
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

    // CyberSource signs "name1=value1,name2=value2,..." in the order of signed_field_names.
    // Values go in as they are: no URL-encoding, no trimming.
    private String sign(Map<String, String> fields) {
        List<String> parts = new ArrayList<>();
        for (String n : fields.getOrDefault("signed_field_names", "").split(",")) {
            parts.add(n + "=" + fields.getOrDefault(n, ""));
        }
        return hmacBase64(secretKey, String.join(",", parts));
    }

    // Constant-time comparison, so response timing leaks nothing about the right value.
    private static boolean safeEqual(String a, String b) {
        return MessageDigest.isEqual(a.getBytes(StandardCharsets.UTF_8), b.getBytes(StandardCharsets.UTF_8));
    }`,
      start: `    // Returns a form the browser auto-POSTs to the hosted pay page. Every field below is signed.
    @Override
    public Start startPayment(String attemptId, long amountPaisa, String returnUrl, String description) {
        Map<String, String> fields = new LinkedHashMap<>(); // keeps insertion order for signed_field_names
        fields.put("access_key", accessKey);
        fields.put("profile_id", profileId);
        fields.put("transaction_uuid", attemptId); // unique per attempt; reusing one within 15 minutes fails with 104
        fields.put("signed_field_names", ""); // filled in below, keeps its place in the order
        fields.put("unsigned_field_names", ""); // sent empty, and signed like the rest
        fields.put("signed_date_time", SIGNED_DATE_TIME.format(Instant.now()));
        fields.put("locale", "en-us");
        fields.put("transaction_type", "sale"); // authorize and capture in one step
        fields.put("reference_number", attemptId); // comes back as req_reference_number
        fields.put("amount", rupees(amountPaisa));
        fields.put("currency", currency);
        putBillTo(fields);
        // Send the buyer back to this attempt's return route. These URLs must be HTTPS.
        fields.put("override_custom_receipt_page", returnUrl);
        fields.put("override_custom_cancel_page", returnUrl);
        fields.put("signed_field_names", String.join(",", fields.keySet()));
        fields.put("signature", sign(fields));
        // description is not sent: none of these fields is meant for it.
        return new Start.Form(payUrl, fields, null);
    }`,
      confirm: `    // decision -> our status. Only a sale that came back ACCEPT is money you keep.
    private static String statusOf(Map<String, String> p) {
        return switch (p.getOrDefault("decision", "").toUpperCase(Locale.ROOT)) {
            // an authorization is not captured yet
            case "ACCEPT" -> "sale".equals(p.get("req_transaction_type")) ? "paid" : "pending";
            case "REVIEW" -> "pending"; // held for manual review in the Business Center
            // 150, 151, 152 are system errors and timeouts: the card may still have been charged.
            case "DECLINE", "ERROR" -> Set.of("150", "151", "152").contains(p.getOrDefault("reason_code", "")) ? "pending" : "failed";
            case "CANCEL" -> "canceled";
            default -> "pending";
        };
    }

    // Rupee text to paisa: "100.00" -> 10000. Anything unreadable gives -1, which never matches.
    private static long paisa(String text) {
        try {
            double d = Double.parseDouble(text);
            return Double.isFinite(d) ? Math.round(d * 100) : -1;
        } catch (NumberFormatException e) {
            return -1;
        }
    }

    private static boolean blank(String s) {
        return s == null || s.isEmpty();
    }

    // Checks the signed result CyberSource POSTs back and keeps only the signed fields.
    // Throws PaymentException if it is forged or belongs to another payment.
    private Map<String, String> verifyResponse(Map<String, String> params, String attemptId) {
        if (blank(params.get("signed_field_names")) || blank(params.get("signature"))) {
            throw new PaymentException("CyberSource: response is not signed");
        }
        // The response names its own signed fields. Rebuild the message from that list with the same key.
        if (!safeEqual(sign(params), params.get("signature"))) {
            throw new PaymentException("CyberSource: bad signature on response");
        }
        // Read only what the signature covers. Any other field in the POST could come from anyone.
        Map<String, String> signed = new LinkedHashMap<>();
        for (String n : params.get("signed_field_names").split(",")) {
            if (params.containsKey(n)) signed.put(n, params.get(n));
        }
        if (!attemptId.equals(signed.get("req_reference_number"))) {
            throw new PaymentException("CyberSource: response is for a different payment");
        }
        if (!blank(signed.get("req_currency")) && !currency.equals(signed.get("req_currency"))) {
            throw new PaymentException("CyberSource: currency mismatch");
        }
        return signed;
    }

    // Called from the return route (params = query + body) and from the reconcile job (empty params).
    @Override
    public Outcome confirmPayment(String attemptId, long amountPaisa, String providerRef, Map<String, String> params) {
        // Secure Acceptance has no status API. Without a signed POST there is nothing to check, so the attempt
        // stays pending until the Merchant POST arrives or you settle it from the Business Center.
        if (blank(params.get("signature")) && blank(params.get("signed_field_names")) && blank(params.get("decision"))) {
            return new Outcome("pending", null);
        }

        Map<String, String> p = verifyResponse(params, attemptId);
        String status = statusOf(p);
        // Compare with the STORED amount. auth_amount is what the card was charged: a partial approval
        // (reason 110) has a lower auth_amount and fails here instead of fulfilling a short payment.
        String amount = !blank(p.get("auth_amount")) ? p.get("auth_amount") : p.getOrDefault("req_amount", "");
        if ((!amount.isEmpty() || status.equals("paid")) && paisa(amount) != amountPaisa) {
            throw new PaymentException("CyberSource: amount mismatch (" + amount + ")");
        }
        return new Outcome(status, blank(p.get("transaction_id")) ? null : p.get("transaction_id"));
    }
}`,
    },
  },
  kotlin: {
    file: "src/main/kotlin/payments/CybersourceGateway.kt",
    lang: "kotlin",
    parts: {
      config: `package payments

import java.security.MessageDigest
import java.time.Instant
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import java.util.Base64
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec
import kotlin.math.roundToLong

// CyberSource Secure Acceptance Hosted Checkout. Test environment unless CYBERSOURCE_ENV=production.
class CybersourceGateway(
    private val profileId: String,
    private val accessKey: String,
    private val secretKey: String,
    private val currency: String,
    private val payUrl: String,
) : Gateway {
    companion object {
        fun fromEnv(): CybersourceGateway {
            val production = System.getenv("CYBERSOURCE_ENV") == "production"
            // No public test credentials exist. Your bank sets up a test profile; test and live keys differ.
            val profileId = System.getenv("CYBERSOURCE_PROFILE_ID") ?: ""
            val accessKey = System.getenv("CYBERSOURCE_ACCESS_KEY") ?: ""
            // Used as the raw text. Do not base64-decode it: that is the REST API rule, not this one.
            val secretKey = System.getenv("CYBERSOURCE_SECRET_KEY") ?: ""
            check(profileId.isNotEmpty() && accessKey.isNotEmpty() && secretKey.isNotEmpty()) {
                "Set CYBERSOURCE_PROFILE_ID, CYBERSOURCE_ACCESS_KEY and CYBERSOURCE_SECRET_KEY"
            }
            val payUrl = if (production) "https://secureacceptance.cybersource.com/pay"
            else "https://testsecureacceptance.cybersource.com/pay"
            return CybersourceGateway(profileId, accessKey, secretKey, System.getenv("CYBERSOURCE_CURRENCY") ?: "NPR", payUrl)
        }

        // Paisa to CyberSource's amount text, always two decimals: 10000 -> "100.00".
        fun rupees(paisa: Long): String = "\${paisa / 100}.\${(paisa % 100).toString().padStart(2, '0')}"

        // UTC with a trailing Z: "2026-11-04T10:15:30Z". Keep the server clock in sync (NTP).
        private val signedDateTime = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss'Z'").withZone(ZoneOffset.UTC)

        // A sale needs the buyer's billing details. The demo order has no buyer, so these are placeholders:
        // load the real name, email and address from your order instead.
        private val billTo = linkedMapOf(
            "bill_to_forename" to "Demo",
            "bill_to_surname" to "Buyer",
            "bill_to_email" to "buyer@example.com",
            "bill_to_address_line1" to "Durbar Marg",
            "bill_to_address_city" to "Kathmandu",
            "bill_to_address_country" to "NP", // state and postal code are only for the US and Canada
        )
    }`,
      sign: `    // base64(HMAC-SHA256(key, message)).
    fun hmacBase64(key: String, message: String): String {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(key.toByteArray(), "HmacSHA256"))
        return Base64.getEncoder().encodeToString(mac.doFinal(message.toByteArray()))
    }

    // CyberSource signs "name1=value1,name2=value2,..." in the order of signed_field_names.
    // Values go in as they are: no URL-encoding, no trimming.
    private fun sign(fields: Map<String, String>): String =
        hmacBase64(secretKey, (fields["signed_field_names"] ?: "").split(",").joinToString(",") { "$it=\${fields[it] ?: ""}" })

    // Constant-time comparison, so response timing leaks nothing about the right value.
    private fun safeEqual(a: String, b: String) = MessageDigest.isEqual(a.toByteArray(), b.toByteArray())`,
      start: `    // Returns a form the browser auto-POSTs to the hosted pay page. Every field below is signed.
    override suspend fun startPayment(attemptId: String, amountPaisa: Long, returnUrl: String, description: String): Start {
        val fields = linkedMapOf( // keeps insertion order for signed_field_names
            "access_key" to accessKey,
            "profile_id" to profileId,
            "transaction_uuid" to attemptId, // unique per attempt; reusing one within 15 minutes fails with 104
            "signed_field_names" to "", // filled in below, keeps its place in the order
            "unsigned_field_names" to "", // sent empty, and signed like the rest
            "signed_date_time" to signedDateTime.format(Instant.now()),
            "locale" to "en-us",
            "transaction_type" to "sale", // authorize and capture in one step
            "reference_number" to attemptId, // comes back as req_reference_number
            "amount" to rupees(amountPaisa),
            "currency" to currency,
        )
        fields.putAll(billTo)
        // Send the buyer back to this attempt's return route. These URLs must be HTTPS.
        fields["override_custom_receipt_page"] = returnUrl
        fields["override_custom_cancel_page"] = returnUrl
        fields["signed_field_names"] = fields.keys.joinToString(",")
        fields["signature"] = sign(fields)
        // description is not sent: none of these fields is meant for it.
        return Start.Form(payUrl, fields)
    }`,
      confirm: `    // decision -> our status. Only a sale that came back ACCEPT is money you keep.
    private fun statusOf(p: Map<String, String>): String = when (p["decision"].orEmpty().uppercase()) {
        "ACCEPT" -> if (p["req_transaction_type"] == "sale") "paid" else "pending" // an authorization is not captured yet
        "REVIEW" -> "pending" // held for manual review in the Business Center
        // 150, 151, 152 are system errors and timeouts: the card may still have been charged.
        "DECLINE", "ERROR" -> if (p["reason_code"] in setOf("150", "151", "152")) "pending" else "failed"
        "CANCEL" -> "canceled"
        else -> "pending"
    }

    // Rupee text to paisa: "100.00" -> 10000. Anything unreadable gives -1, which never matches.
    private fun paisa(text: String): Long =
        text.toDoubleOrNull()?.takeIf { it.isFinite() }?.let { (it * 100).roundToLong() } ?: -1

    // Checks the signed result CyberSource POSTs back and keeps only the signed fields.
    // Throws PaymentException if it is forged or belongs to another payment.
    private fun verifyResponse(params: Map<String, String>, attemptId: String): Map<String, String> {
        val names = params["signed_field_names"].orEmpty()
        val signature = params["signature"].orEmpty()
        if (names.isEmpty() || signature.isEmpty()) throw PaymentException("CyberSource: response is not signed")
        // The response names its own signed fields. Rebuild the message from that list with the same key.
        if (!safeEqual(sign(params), signature)) throw PaymentException("CyberSource: bad signature on response")
        // Read only what the signature covers. Any other field in the POST could come from anyone.
        val allowed = names.split(",").toSet()
        val signed = params.filterKeys { it in allowed }
        if (signed["req_reference_number"] != attemptId) throw PaymentException("CyberSource: response is for a different payment")
        val reqCurrency = signed["req_currency"].orEmpty()
        if (reqCurrency.isNotEmpty() && reqCurrency != currency) throw PaymentException("CyberSource: currency mismatch")
        return signed
    }

    // Called from the return route (params = query + body) and from the reconcile job (empty params).
    override suspend fun confirmPayment(attemptId: String, amountPaisa: Long, providerRef: String?, params: Map<String, String>): Outcome {
        // Secure Acceptance has no status API. Without a signed POST there is nothing to check, so the attempt
        // stays pending until the Merchant POST arrives or you settle it from the Business Center.
        if (listOf("signature", "signed_field_names", "decision").all { params[it].isNullOrEmpty() }) {
            return Outcome("pending")
        }

        val p = verifyResponse(params, attemptId)
        val status = statusOf(p)
        // Compare with the STORED amount. auth_amount is what the card was charged: a partial approval
        // (reason 110) has a lower auth_amount and fails here instead of fulfilling a short payment.
        val amount = p["auth_amount"].takeUnless { it.isNullOrEmpty() } ?: p["req_amount"].orEmpty()
        if ((amount.isNotEmpty() || status == "paid") && paisa(amount) != amountPaisa) {
            throw PaymentException("CyberSource: amount mismatch ($amount)")
        }
        return Outcome(status, p["transaction_id"].takeUnless { it.isNullOrEmpty() })
    }
}`,
    },
  },
};

// Signature vector from references/cybersource.md section 2: base64(HMAC-SHA256(secret_key, message)).
// The key and ids are dummies. It reproduces with OpenSSL and with every module above.
export const vectors: { key: string; message: string; signature: string }[] = [
  { key: "test_secret_key_do_not_use", message: "access_key=a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6,profile_id=PROFILE-0001,transaction_uuid=7f9c2b1e-5d1a-4c3b-9e8f-1a2b3c4d5e6f,signed_field_names=access_key,profile_id,transaction_uuid,signed_field_names,unsigned_field_names,signed_date_time,locale,transaction_type,reference_number,amount,currency,unsigned_field_names=,signed_date_time=2026-11-04T10:15:30Z,locale=en-us,transaction_type=sale,reference_number=ORDER-1001,amount=1500.00,currency=NPR", signature: "QRwjaW8ysHR/UGyQ0LqSIHiGTvnNebKSwwsFRmn4Weg=" },
];

export default cybersource;

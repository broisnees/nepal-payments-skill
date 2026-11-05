// Generated connectIPS (NCHL) gateway module, one per language, plus the redirect route each framework needs.
// The parts joined with "\n\n" in order (config, sign, start, confirm) form the complete file.

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

export const connectips: Record<"ts" | "python" | "php" | "go" | "java" | "kotlin", GatewayCode> = {
  ts: {
    file: "connectips.ts",
    lang: "typescript",
    parts: {
      config: `import { PaymentError, type ConfirmInput, type Outcome, type PaymentStatus, type Start, type StartInput } from "./payments";

// connectIPS (NCHL). UAT unless CONNECTIPS_ENV=production.
const PRODUCTION = process.env.CONNECTIPS_ENV === "production";
// CONNECTIPS_BASE_URL is for a local mock or proxy. Leave it unset to talk to NCHL.
const BASE_URL =
  process.env.CONNECTIPS_BASE_URL ?? (PRODUCTION ? "https://login.connectips.com" : "https://uat.connectips.com");
const GATEWAY_URL = \`\${BASE_URL}/connectipswebgw/loginpage\`;
const VALIDATE_URL = \`\${BASE_URL}/connectipswebws/api/creditor/validatetxn\`;

// connectIPS has no shared test merchant, so UAT needs your own credentials too. NCHL emails them.
const MERCHANT_ID = process.env.CONNECTIPS_MERCHANT_ID ?? "";
const APP_ID = process.env.CONNECTIPS_APP_ID ?? "";
const APP_NAME = process.env.CONNECTIPS_APP_NAME ?? "";
const APP_PASSWORD = process.env.CONNECTIPS_APP_PASSWORD ?? ""; // for validatetxn, not the .pfx password
// PKCS#8 PEM ("BEGIN PRIVATE KEY") taken out of the .pfx. Env files often hold it with "\\n" escapes.
const PRIVATE_KEY_PEM = (process.env.CONNECTIPS_PRIVATE_KEY_PEM ?? "").replace(/\\\\n/g, "\\n");
// privateKey() below checks these on first use.

// TXNDATE is DD-MM-YYYY in Nepal time, whatever time zone the server runs in.
function nepalDate(d = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kathmandu",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).formatToParts(d);
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return \`\${get("day")}-\${get("month")}-\${get("year")}\`;
}`,
      sign: `// Load the key once, not per request. Web Crypto wants the DER bytes inside the PEM armour.
// The settings are checked here, on first use, because next build imports this file without them.
let key: Promise<CryptoKey> | undefined;
function privateKey(): Promise<CryptoKey> {
  if (!key) {
    if (!MERCHANT_ID || !APP_ID || !APP_NAME || !APP_PASSWORD || !PRIVATE_KEY_PEM) {
      throw new Error("Set CONNECTIPS_MERCHANT_ID, CONNECTIPS_APP_ID, CONNECTIPS_APP_NAME, CONNECTIPS_APP_PASSWORD and CONNECTIPS_PRIVATE_KEY_PEM");
    }
    if (!PRIVATE_KEY_PEM.includes("-----BEGIN PRIVATE KEY-----")) {
      throw new Error("CONNECTIPS_PRIVATE_KEY_PEM must be PKCS#8 (BEGIN PRIVATE KEY): convert it with openssl pkcs8 -topk8");
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

// connectIPS signs "NAME=value,NAME=value,..." in a fixed order. Bare commas, no spaces.
export function tokenString(fields: Record<string, string>, names: string[]): string {
  return names.map((n) => \`\${n}=\${fields[n]}\`).join(",");
}`,
      start: `const FORM_FIELDS = ["MERCHANTID", "APPID", "APPNAME", "TXNID", "TXNDATE", "TXNCRNCY", "TXNAMT", "REFERENCEID", "REMARKS", "PARTICULARS"];

// Free text lands inside the signed string, where "," or "=" would break it. Clip to the field's limit too.
const clean = (text: string, max: number) => text.replace(/[,=]/g, " ").slice(0, max);

// Returns a form the browser auto-POSTs to connectIPS.
export async function startPayment(input: StartInput): Promise<Start> {
  // TXNID takes at most 20 characters. Our attempt ids are exactly 20 hex characters; a UUID (36) would not fit.
  if (!/^[A-Za-z0-9-]{1,20}$/.test(input.attemptId)) {
    throw new Error(\`connectIPS TXNID must be 1 to 20 letters, digits or "-": \${input.attemptId}\`);
  }
  const fields: Record<string, string> = {
    MERCHANTID: MERCHANT_ID,
    APPID: APP_ID,
    APPNAME: APP_NAME,
    TXNID: input.attemptId, // unique per attempt; a reused TXNID is refused
    TXNDATE: nepalDate(),
    TXNCRNCY: "NPR",
    TXNAMT: String(input.amountPaisa), // paisa, not rupees: Rs 100 is "10000"
    REFERENCEID: input.attemptId,
    REMARKS: clean(input.description, 50),
    PARTICULARS: clean(input.description, 100),
  };
  // The token string ends with the literal "TOKEN=TOKEN".
  fields.TOKEN = await rsaSha256Base64(tokenString(fields, FORM_FIELDS) + ",TOKEN=TOKEN");
  // input.returnUrl is not sent: connectIPS returns the buyer to the URLs NCHL registered for your app.
  return { type: "form", action: GATEWAY_URL, fields };
}`,
      confirm: `// validatetxn answer -> our status. ERROR covers both "never heard of it" and "not finished", so read statusDesc.
function toStatus(status: string, statusDesc: string): PaymentStatus {
  if (status === "SUCCESS") return "paid";
  if (status === "FAILED") return "failed";
  if (statusDesc.toUpperCase().includes("NOT FOUND")) return "not_found";
  // TRANSACTION INCOMPLETE (no OTP yet) and anything unknown: ask again later.
  return "pending";
}

// Called from the return route (params = query + body) and from the reconcile job (params = {}).
export async function confirmPayment(input: ConfirmInput): Promise<Outcome> {
  // The redirect carries only ?TXNID=, unsigned. It can point at a payment but never prove one.
  if (input.params.TXNID && input.params.TXNID !== input.attemptId) {
    throw new PaymentError("connectIPS: TXNID is for a different payment");
  }

  // validatetxn is the real answer. referenceId is the TXNID we posted (not REFERENCEID),
  // and txnAmt is the STORED amount in paisa.
  const signed = { MERCHANTID: MERCHANT_ID, APPID: APP_ID, REFERENCEID: input.attemptId, TXNAMT: String(input.amountPaisa) };
  const res = await fetch(VALIDATE_URL, {
    method: "POST",
    headers: {
      Authorization: \`Basic \${btoa(\`\${APP_ID}:\${APP_PASSWORD}\`)}\`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      merchantId: Number(MERCHANT_ID),
      appId: APP_ID,
      referenceId: input.attemptId,
      txnAmt: input.amountPaisa,
      token: await rsaSha256Base64(tokenString(signed, ["MERCHANTID", "APPID", "REFERENCEID", "TXNAMT"])),
    }),
    signal: AbortSignal.timeout(20_000),
  });
  const body = await res.json().catch(() => null);
  // 401 means a wrong APPID or app password. Like an outage, that is not the buyer's fault: the route answers 502.
  if (!res.ok || typeof body?.status !== "string") {
    throw new Error(\`connectIPS validatetxn failed: HTTP \${res.status} \${JSON.stringify(body)}\`);
  }
  const status = toStatus(body.status, String(body.statusDesc ?? ""));
  // txnAmt comes back as text ("10000"). A success for any other amount is not this payment.
  if (status === "paid" && Math.round(Number(body.txnAmt)) !== input.amountPaisa) {
    throw new PaymentError(\`connectIPS: amount mismatch (\${body.txnAmt})\`);
  }
  // validatetxn returns no connectIPS transaction id (gettxndetail does), so there is no providerRef to keep.
  return { status };
}`,
    },
  },
  python: {
    file: "connectips.py",
    lang: "python",
    parts: {
      config: `import base64
import json
import os
import re
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

# The standard library has no RSA signing, so this one module needs: pip install cryptography
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding

from payments import Outcome, PaymentError, Start

# connectIPS (NCHL). UAT unless CONNECTIPS_ENV=production.
PRODUCTION = os.environ.get("CONNECTIPS_ENV") == "production"
# CONNECTIPS_BASE_URL is for a local mock or proxy. Leave it unset to talk to NCHL.
BASE_URL = os.environ.get("CONNECTIPS_BASE_URL") or (
    "https://login.connectips.com" if PRODUCTION else "https://uat.connectips.com")
GATEWAY_URL = f"{BASE_URL}/connectipswebgw/loginpage"
VALIDATE_URL = f"{BASE_URL}/connectipswebws/api/creditor/validatetxn"

# connectIPS has no shared test merchant, so UAT needs your own credentials too. NCHL emails them.
MERCHANT_ID = os.environ.get("CONNECTIPS_MERCHANT_ID", "")
APP_ID = os.environ.get("CONNECTIPS_APP_ID", "")
APP_NAME = os.environ.get("CONNECTIPS_APP_NAME", "")
APP_PASSWORD = os.environ.get("CONNECTIPS_APP_PASSWORD", "")  # for validatetxn, not the .pfx password
# PKCS#8 PEM ("BEGIN PRIVATE KEY") taken out of the .pfx. Env files often hold it with "\\n" escapes.
PRIVATE_KEY_PEM = os.environ.get("CONNECTIPS_PRIVATE_KEY_PEM", "").replace("\\\\n", "\\n")
if not (MERCHANT_ID and APP_ID and APP_NAME and APP_PASSWORD and PRIVATE_KEY_PEM):
    raise RuntimeError("Set CONNECTIPS_MERCHANT_ID, CONNECTIPS_APP_ID, CONNECTIPS_APP_NAME, "
                       "CONNECTIPS_APP_PASSWORD and CONNECTIPS_PRIVATE_KEY_PEM")
if "-----BEGIN PRIVATE KEY-----" not in PRIVATE_KEY_PEM:
    raise RuntimeError("CONNECTIPS_PRIVATE_KEY_PEM must be PKCS#8 (BEGIN PRIVATE KEY): convert it with openssl pkcs8 -topk8")

NEPAL_TIME = timezone(timedelta(hours=5, minutes=45))


def nepal_date() -> str:
    """TXNDATE is DD-MM-YYYY in Nepal time, whatever time zone the server runs in."""
    return datetime.now(NEPAL_TIME).strftime("%d-%m-%Y")`,
      sign: `# Load the key once, not per request.
PRIVATE_KEY = serialization.load_pem_private_key(PRIVATE_KEY_PEM.encode(), password=None)


def rsa_sha256_base64(message: str) -> str:
    """base64(RSA-SHA256(private key, message)), the same as \`openssl dgst -sha256 -sign key.pem | base64\`.
    Pass the text itself: the SHA-256 step is part of the signature, so never hash it first."""
    sig = PRIVATE_KEY.sign(message.encode(), padding.PKCS1v15(), hashes.SHA256())
    return base64.b64encode(sig).decode()


def token_string(fields: dict[str, str], names: list[str]) -> str:
    """connectIPS signs "NAME=value,NAME=value,..." in a fixed order. Bare commas, no spaces."""
    return ",".join(f"{n}={fields[n]}" for n in names)`,
      start: `FORM_FIELDS = ["MERCHANTID", "APPID", "APPNAME", "TXNID", "TXNDATE", "TXNCRNCY", "TXNAMT", "REFERENCEID", "REMARKS",
               "PARTICULARS"]


def clean(text: str, limit: int) -> str:
    """Free text lands inside the signed string, where "," or "=" would break it. Clip to the field's limit too."""
    return re.sub(r"[,=]", " ", text)[:limit]


def start_payment(attempt_id: str, amount_paisa: int, return_url: str, description: str) -> Start:
    """Returns a form the browser auto-POSTs to connectIPS."""
    # TXNID takes at most 20 characters. Our attempt ids are exactly 20 hex characters; a UUID (36) would not fit.
    if not re.fullmatch(r"[A-Za-z0-9-]{1,20}", attempt_id):
        raise ValueError(f'connectIPS TXNID must be 1 to 20 letters, digits or "-": {attempt_id}')
    fields = {
        "MERCHANTID": MERCHANT_ID,
        "APPID": APP_ID,
        "APPNAME": APP_NAME,
        "TXNID": attempt_id,  # unique per attempt; a reused TXNID is refused
        "TXNDATE": nepal_date(),
        "TXNCRNCY": "NPR",
        "TXNAMT": str(amount_paisa),  # paisa, not rupees: Rs 100 is "10000"
        "REFERENCEID": attempt_id,
        "REMARKS": clean(description, 50),
        "PARTICULARS": clean(description, 100),
    }
    # The token string ends with the literal "TOKEN=TOKEN".
    fields["TOKEN"] = rsa_sha256_base64(token_string(fields, FORM_FIELDS) + ",TOKEN=TOKEN")
    # return_url is not sent: connectIPS returns the buyer to the URLs NCHL registered for your app.
    return Start(type="form", action=GATEWAY_URL, fields=fields)`,
      confirm: `def to_status(status: str, status_desc: str) -> str:
    """validatetxn answer -> our status. ERROR covers both "never heard of it" and "not finished", so read statusDesc."""
    if status == "SUCCESS":
        return "paid"
    if status == "FAILED":
        return "failed"
    if "NOT FOUND" in status_desc.upper():
        return "not_found"
    # TRANSACTION INCOMPLETE (no OTP yet) and anything unknown: ask again later.
    return "pending"


def confirm_payment(attempt_id: str, amount_paisa: int, provider_ref: str | None, params: dict[str, str]) -> Outcome:
    """Called from the return route (params = query + body) and from the reconcile job (params = {})."""
    # The redirect carries only ?TXNID=, unsigned. It can point at a payment but never prove one.
    if params.get("TXNID") and params["TXNID"] != attempt_id:
        raise PaymentError("connectIPS: TXNID is for a different payment")

    # validatetxn is the real answer. referenceId is the TXNID we posted (not REFERENCEID),
    # and txnAmt is the STORED amount in paisa.
    signed = {"MERCHANTID": MERCHANT_ID, "APPID": APP_ID, "REFERENCEID": attempt_id, "TXNAMT": str(amount_paisa)}
    payload = {
        "merchantId": int(MERCHANT_ID),
        "appId": APP_ID,
        "referenceId": attempt_id,
        "txnAmt": amount_paisa,
        "token": rsa_sha256_base64(token_string(signed, ["MERCHANTID", "APPID", "REFERENCEID", "TXNAMT"])),
    }
    auth = base64.b64encode(f"{APP_ID}:{APP_PASSWORD}".encode()).decode()
    req = urllib.request.Request(VALIDATE_URL, data=json.dumps(payload).encode(), method="POST", headers={
        "Authorization": f"Basic {auth}",
        "Content-Type": "application/json",
    })
    try:
        with urllib.request.urlopen(req, timeout=20) as res:
            body = json.load(res)
    except (urllib.error.URLError, ValueError) as e:
        # A 401 lands here too: wrong APPID or app password. Not the buyer's fault, so the route answers 502.
        raise RuntimeError(f"connectIPS validatetxn failed: {e}") from e
    if not isinstance(body, dict) or not isinstance(body.get("status"), str):
        raise RuntimeError(f"connectIPS validatetxn failed: {body}")
    status = to_status(body["status"], str(body.get("statusDesc") or ""))
    # txnAmt comes back as text ("10000"). A success for any other amount is not this payment.
    if status == "paid":
        try:
            paid = round(float(body.get("txnAmt")))
        except (TypeError, ValueError, OverflowError):
            paid = None
        if paid != amount_paisa:
            raise PaymentError(f"connectIPS: amount mismatch ({body.get('txnAmt')})")
    # validatetxn returns no connectIPS transaction id (gettxndetail does), so there is no provider_ref to keep.
    return Outcome(status=status)`,
    },
  },
  php: {
    file: "ConnectipsGateway.php",
    lang: "php",
    parts: {
      config: `<?php

declare(strict_types=1);

namespace App\\Payments;

// connectIPS (NCHL). UAT unless CONNECTIPS_ENV=production.
final class ConnectipsGateway implements Gateway
{
    private \\OpenSSLAsymmetricKey $privateKey;

    public function __construct(
        private string $merchantId,
        private string $appId,
        private string $appName,
        private string $appPassword, // for validatetxn, not the .pfx password
        string $privateKeyPem,
        private string $baseUrl,
    ) {
        // Load the key once, not per request.
        $key = openssl_pkey_get_private($privateKeyPem);
        if ($key === false) {
            throw new \\RuntimeException('CONNECTIPS_PRIVATE_KEY_PEM is not a readable private key');
        }
        $this->privateKey = $key;
    }

    public static function fromEnv(): self
    {
        $env = static fn (string $name) => $_ENV[$name] ?? (getenv($name) !== false ? getenv($name) : '');
        $production = $env('CONNECTIPS_ENV') === 'production';
        // CONNECTIPS_BASE_URL is for a local mock or proxy. Leave it unset to talk to NCHL.
        $baseUrl = $env('CONNECTIPS_BASE_URL') ?: ($production ? 'https://login.connectips.com' : 'https://uat.connectips.com');
        // connectIPS has no shared test merchant, so UAT needs your own credentials too. NCHL emails them.
        $merchantId = $env('CONNECTIPS_MERCHANT_ID');
        $appId = $env('CONNECTIPS_APP_ID');
        $appName = $env('CONNECTIPS_APP_NAME');
        $appPassword = $env('CONNECTIPS_APP_PASSWORD');
        // PKCS#8 PEM ("BEGIN PRIVATE KEY") taken out of the .pfx. Env files often hold it with "\\n" escapes.
        $pem = str_replace('\\n', "\\n", $env('CONNECTIPS_PRIVATE_KEY_PEM'));
        if ($merchantId === '' || $appId === '' || $appName === '' || $appPassword === '' || $pem === '') {
            throw new \\RuntimeException('Set CONNECTIPS_MERCHANT_ID, CONNECTIPS_APP_ID, CONNECTIPS_APP_NAME, '
                . 'CONNECTIPS_APP_PASSWORD and CONNECTIPS_PRIVATE_KEY_PEM');
        }
        if (!str_contains($pem, '-----BEGIN PRIVATE KEY-----')) {
            throw new \\RuntimeException('CONNECTIPS_PRIVATE_KEY_PEM must be PKCS#8 (BEGIN PRIVATE KEY): convert it with openssl pkcs8 -topk8');
        }
        return new self($merchantId, $appId, $appName, $appPassword, $pem, rtrim($baseUrl, '/'));
    }

    // TXNDATE is DD-MM-YYYY in Nepal time, whatever time zone the server runs in.
    private static function nepalDate(): string
    {
        return (new \\DateTimeImmutable('now', new \\DateTimeZone('Asia/Kathmandu')))->format('d-m-Y');
    }`,
      sign: `    // base64(RSA-SHA256(private key, message)), the same as \`openssl dgst -sha256 -sign key.pem | base64\`.
    // Pass the text itself: the SHA-256 step is part of the signature, so never hash it first.
    public function rsaSha256Base64(string $message): string
    {
        if (!openssl_sign($message, $signature, $this->privateKey, OPENSSL_ALGO_SHA256)) {
            throw new \\RuntimeException('connectIPS: signing failed');
        }
        return base64_encode($signature);
    }

    // connectIPS signs "NAME=value,NAME=value,..." in a fixed order. Bare commas, no spaces.
    public static function tokenString(array $fields, array $names): string
    {
        return implode(',', array_map(fn (string $n) => $n . '=' . $fields[$n], $names));
    }`,
      start: `    private const FORM_FIELDS = ['MERCHANTID', 'APPID', 'APPNAME', 'TXNID', 'TXNDATE', 'TXNCRNCY', 'TXNAMT', 'REFERENCEID',
        'REMARKS', 'PARTICULARS'];

    // Free text lands inside the signed string, where "," or "=" would break it. Clip to the field's limit too.
    private static function clean(string $text, int $max): string
    {
        preg_match('/^.{0,' . $max . '}/us', str_replace([',', '='], ' ', $text), $m); // characters, not bytes
        return $m[0] ?? '';
    }

    // Returns a form the browser auto-POSTs to connectIPS.
    public function startPayment(string $attemptId, int $amountPaisa, string $returnUrl, string $description): Start
    {
        // TXNID takes at most 20 characters. Our attempt ids are exactly 20 hex characters; a UUID (36) would not fit.
        if (preg_match('/^[A-Za-z0-9-]{1,20}$/', $attemptId) !== 1) {
            throw new \\InvalidArgumentException("connectIPS TXNID must be 1 to 20 letters, digits or \\"-\\": $attemptId");
        }
        $fields = [
            'MERCHANTID' => $this->merchantId,
            'APPID' => $this->appId,
            'APPNAME' => $this->appName,
            'TXNID' => $attemptId, // unique per attempt; a reused TXNID is refused
            'TXNDATE' => self::nepalDate(),
            'TXNCRNCY' => 'NPR',
            'TXNAMT' => (string) $amountPaisa, // paisa, not rupees: Rs 100 is "10000"
            'REFERENCEID' => $attemptId,
            'REMARKS' => self::clean($description, 50),
            'PARTICULARS' => self::clean($description, 100),
        ];
        // The token string ends with the literal "TOKEN=TOKEN".
        $fields['TOKEN'] = $this->rsaSha256Base64(self::tokenString($fields, self::FORM_FIELDS) . ',TOKEN=TOKEN');
        // $returnUrl is not sent: connectIPS returns the buyer to the URLs NCHL registered for your app.
        return Start::form($this->baseUrl . '/connectipswebgw/loginpage', $fields);
    }`,
      confirm: `    // validatetxn answer -> our status. ERROR covers both "never heard of it" and "not finished", so read statusDesc.
    private static function toStatus(string $status, string $statusDesc): string
    {
        if ($status === 'SUCCESS') {
            return 'paid';
        }
        if ($status === 'FAILED') {
            return 'failed';
        }
        if (str_contains(strtoupper($statusDesc), 'NOT FOUND')) {
            return 'not_found';
        }
        // TRANSACTION INCOMPLETE (no OTP yet) and anything unknown: ask again later.
        return 'pending';
    }

    // Called from the return route (params = query + body) and from the reconcile job (params = []).
    public function confirmPayment(string $attemptId, int $amountPaisa, ?string $providerRef, array $params): Outcome
    {
        // The redirect carries only ?TXNID=, unsigned. It can point at a payment but never prove one.
        if (!empty($params['TXNID']) && $params['TXNID'] !== $attemptId) {
            throw new PaymentError('connectIPS: TXNID is for a different payment');
        }

        // validatetxn is the real answer. referenceId is the TXNID we posted (not REFERENCEID),
        // and txnAmt is the STORED amount in paisa.
        $signed = ['MERCHANTID' => $this->merchantId, 'APPID' => $this->appId, 'REFERENCEID' => $attemptId,
            'TXNAMT' => (string) $amountPaisa];
        $payload = json_encode([
            'merchantId' => (int) $this->merchantId,
            'appId' => $this->appId,
            'referenceId' => $attemptId,
            'txnAmt' => $amountPaisa,
            'token' => $this->rsaSha256Base64(self::tokenString($signed, ['MERCHANTID', 'APPID', 'REFERENCEID', 'TXNAMT'])),
        ]);
        $ch = curl_init($this->baseUrl . '/connectipswebws/api/creditor/validatetxn');
        curl_setopt_array($ch, [
            CURLOPT_POST => true,
            CURLOPT_POSTFIELDS => $payload,
            CURLOPT_HTTPHEADER => ['Content-Type: application/json'],
            CURLOPT_USERPWD => $this->appId . ':' . $this->appPassword, // HTTP Basic auth
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT => 20,
        ]);
        $raw = curl_exec($ch);
        $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $error = curl_error($ch);
        $body = is_string($raw) ? json_decode($raw, true) : null;
        // 401 means a wrong APPID or app password. Like an outage, that is not the buyer's fault: the route answers 502.
        if ($code !== 200 || !is_array($body) || !is_string($body['status'] ?? null)) {
            throw new \\RuntimeException("connectIPS validatetxn failed: HTTP $code $error " . (is_string($raw) ? $raw : ''));
        }
        $status = self::toStatus($body['status'], (string) ($body['statusDesc'] ?? ''));
        // txnAmt comes back as text ("10000"). A success for any other amount is not this payment.
        if ($status === 'paid' && (!is_numeric($body['txnAmt'] ?? null) || (int) round((float) $body['txnAmt']) !== $amountPaisa)) {
            throw new PaymentError('connectIPS: amount mismatch (' . json_encode($body['txnAmt'] ?? null) . ')');
        }
        // validatetxn returns no connectIPS transaction id (gettxndetail does), so there is no providerRef to keep.
        return new Outcome($status);
    }
}`,
    },
  },
  go: {
    file: "payments/connectips.go",
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
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Connectips is the connectIPS (NCHL) gateway. UAT unless CONNECTIPS_ENV=production.
type Connectips struct {
	merchantID, appID, appName, appPassword, baseURL string
	key                                              *rsa.PrivateKey
	client                                           *http.Client
}

func NewConnectips() *Connectips {
	c := &Connectips{
		// connectIPS has no shared test merchant, so UAT needs your own credentials too. NCHL emails them.
		merchantID:  os.Getenv("CONNECTIPS_MERCHANT_ID"),
		appID:       os.Getenv("CONNECTIPS_APP_ID"),
		appName:     os.Getenv("CONNECTIPS_APP_NAME"),
		appPassword: os.Getenv("CONNECTIPS_APP_PASSWORD"), // for validatetxn, not the .pfx password
		baseURL:     "https://uat.connectips.com",
		client:      &http.Client{Timeout: 20 * time.Second},
	}
	if os.Getenv("CONNECTIPS_ENV") == "production" {
		c.baseURL = "https://login.connectips.com"
	}
	// CONNECTIPS_BASE_URL is for a local mock or proxy. Leave it unset to talk to NCHL.
	if u := os.Getenv("CONNECTIPS_BASE_URL"); u != "" {
		c.baseURL = strings.TrimRight(u, "/")
	}
	// PKCS#8 PEM ("BEGIN PRIVATE KEY") taken out of the .pfx. Env files often hold it with "\\n" escapes.
	keyPEM := strings.ReplaceAll(os.Getenv("CONNECTIPS_PRIVATE_KEY_PEM"), \`\\n\`, "\\n")
	if c.merchantID == "" || c.appID == "" || c.appName == "" || c.appPassword == "" || keyPEM == "" {
		panic("set CONNECTIPS_MERCHANT_ID, CONNECTIPS_APP_ID, CONNECTIPS_APP_NAME, CONNECTIPS_APP_PASSWORD and CONNECTIPS_PRIVATE_KEY_PEM")
	}
	// Load the key once, not per request.
	block, _ := pem.Decode([]byte(keyPEM))
	if block == nil || block.Type != "PRIVATE KEY" {
		panic("CONNECTIPS_PRIVATE_KEY_PEM must be PKCS#8 (BEGIN PRIVATE KEY): convert it with openssl pkcs8 -topk8")
	}
	parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	key, ok := parsed.(*rsa.PrivateKey)
	if err != nil || !ok {
		panic("CONNECTIPS_PRIVATE_KEY_PEM is not an RSA private key")
	}
	c.key = key
	return c
}

// connectipsDate returns TXNDATE: DD-MM-YYYY in Nepal time (UTC+5:45), whatever time zone the server runs in.
func connectipsDate() string {
	return time.Now().In(time.FixedZone("NPT", 5*3600+45*60)).Format("02-01-2006")
}`,
      sign: `// RSASHA256Base64 returns base64(RSA-SHA256(private key, message)),
// the same as \`openssl dgst -sha256 -sign key.pem | base64\`.
func (c *Connectips) RSASHA256Base64(message string) (string, error) {
	// Go wants the digest, so hash here. Other languages hash inside their sign call; never hash twice.
	digest := sha256.Sum256([]byte(message))
	sig, err := rsa.SignPKCS1v15(rand.Reader, c.key, crypto.SHA256, digest[:])
	if err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(sig), nil
}

// connectipsToken builds "NAME=value,NAME=value,..." in a fixed order. Bare commas, no spaces.
func connectipsToken(fields map[string]string, names []string) string {
	parts := make([]string, len(names))
	for i, n := range names {
		parts[i] = n + "=" + fields[n]
	}
	return strings.Join(parts, ",")
}`,
      start: `var (
	connectipsFormFields = []string{"MERCHANTID", "APPID", "APPNAME", "TXNID", "TXNDATE", "TXNCRNCY", "TXNAMT", "REFERENCEID", "REMARKS", "PARTICULARS"}
	connectipsTxnID      = regexp.MustCompile(\`^[A-Za-z0-9-]{1,20}$\`)
)

// connectipsClean keeps free text safe inside the signed string, where "," or "=" would break it,
// and clips it to the field's limit.
func connectipsClean(text string, max int) string {
	r := []rune(strings.NewReplacer(",", " ", "=", " ").Replace(text))
	if len(r) > max {
		r = r[:max]
	}
	return string(r)
}

// StartPayment returns a form the browser auto-POSTs to connectIPS.
func (c *Connectips) StartPayment(ctx context.Context, in StartInput) (Start, error) {
	// TXNID takes at most 20 characters. Our attempt ids are exactly 20 hex characters; a UUID (36) would not fit.
	if !connectipsTxnID.MatchString(in.AttemptID) {
		return Start{}, fmt.Errorf("connectIPS TXNID must be 1 to 20 letters, digits or \\"-\\": %s", in.AttemptID)
	}
	fields := map[string]string{
		"MERCHANTID":  c.merchantID,
		"APPID":       c.appID,
		"APPNAME":     c.appName,
		"TXNID":       in.AttemptID, // unique per attempt; a reused TXNID is refused
		"TXNDATE":     connectipsDate(),
		"TXNCRNCY":    "NPR",
		"TXNAMT":      strconv.FormatInt(in.AmountPaisa, 10), // paisa, not rupees: Rs 100 is "10000"
		"REFERENCEID": in.AttemptID,
		"REMARKS":     connectipsClean(in.Description, 50),
		"PARTICULARS": connectipsClean(in.Description, 100),
	}
	// The token string ends with the literal "TOKEN=TOKEN".
	token, err := c.RSASHA256Base64(connectipsToken(fields, connectipsFormFields) + ",TOKEN=TOKEN")
	if err != nil {
		return Start{}, err
	}
	fields["TOKEN"] = token
	// in.ReturnURL is not sent: connectIPS returns the buyer to the URLs NCHL registered for your app.
	return Start{Type: "form", Action: c.baseURL + "/connectipswebgw/loginpage", Fields: fields}, nil
}`,
      confirm: `// connectipsStatus maps a validatetxn answer to ours.
// ERROR covers both "never heard of it" and "not finished", so read statusDesc.
func connectipsStatus(status, statusDesc string) string {
	switch {
	case status == "SUCCESS":
		return "paid"
	case status == "FAILED":
		return "failed"
	case strings.Contains(strings.ToUpper(statusDesc), "NOT FOUND"):
		return "not_found"
	}
	// TRANSACTION INCOMPLETE (no OTP yet) and anything unknown: ask again later.
	return "pending"
}

// ConfirmPayment is called from the return route (Params = query + body) and from the reconcile job (empty Params).
func (c *Connectips) ConfirmPayment(ctx context.Context, in ConfirmInput) (Outcome, error) {
	// The redirect carries only ?TXNID=, unsigned. It can point at a payment but never prove one.
	if t := in.Params["TXNID"]; t != "" && t != in.AttemptID {
		return Outcome{}, fmt.Errorf("%w: connectIPS TXNID is for a different payment", ErrPayment)
	}

	// validatetxn is the real answer. referenceId is the TXNID we posted (not REFERENCEID),
	// and txnAmt is the STORED amount in paisa.
	amount := strconv.FormatInt(in.AmountPaisa, 10)
	signed := map[string]string{"MERCHANTID": c.merchantID, "APPID": c.appID, "REFERENCEID": in.AttemptID, "TXNAMT": amount}
	token, err := c.RSASHA256Base64(connectipsToken(signed, []string{"MERCHANTID", "APPID", "REFERENCEID", "TXNAMT"}))
	if err != nil {
		return Outcome{}, err
	}
	merchantID, err := strconv.ParseInt(c.merchantID, 10, 64)
	if err != nil {
		return Outcome{}, fmt.Errorf("CONNECTIPS_MERCHANT_ID must be a number: %w", err)
	}
	payload, _ := json.Marshal(map[string]any{
		"merchantId":  merchantID,
		"appId":       c.appID,
		"referenceId": in.AttemptID,
		"txnAmt":      in.AmountPaisa,
		"token":       token,
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/connectipswebws/api/creditor/validatetxn", bytes.NewReader(payload))
	if err != nil {
		return Outcome{}, err
	}
	req.SetBasicAuth(c.appID, c.appPassword)
	req.Header.Set("Content-Type", "application/json")
	res, err := c.client.Do(req)
	if err != nil {
		return Outcome{}, fmt.Errorf("connectIPS validatetxn failed: %w", err)
	}
	defer res.Body.Close()
	var body struct {
		Status     string \`json:"status"\`
		StatusDesc string \`json:"statusDesc"\`
		TxnAmt     any    \`json:"txnAmt"\` // text ("10000") here, a number in gettxndetail
	}
	// 401 means a wrong APPID or app password. Like an outage, that is not the buyer's fault: the route answers 502.
	if err := json.NewDecoder(res.Body).Decode(&body); err != nil || res.StatusCode != http.StatusOK || body.Status == "" {
		return Outcome{}, errors.New("connectIPS validatetxn failed: HTTP " + res.Status)
	}
	status := connectipsStatus(body.Status, body.StatusDesc)
	// A success for any other amount is not this payment.
	if status == "paid" {
		paid, err := strconv.ParseFloat(fmt.Sprint(body.TxnAmt), 64)
		if err != nil || int64(math.Round(paid)) != in.AmountPaisa {
			return Outcome{}, fmt.Errorf("%w: connectIPS amount mismatch (%v)", ErrPayment, body.TxnAmt)
		}
	}
	// validatetxn returns no connectIPS transaction id (gettxndetail does), so there is no ProviderRef to keep.
	return Outcome{Status: status}, nil
}`,
    },
  },
  java: {
    file: "src/main/java/payments/ConnectipsGateway.java",
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
import java.security.KeyFactory;
import java.security.PrivateKey;
import java.security.Signature;
import java.security.spec.PKCS8EncodedKeySpec;
import java.time.Duration;
import java.time.LocalDate;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

// connectIPS (NCHL). UAT unless CONNECTIPS_ENV=production.
public final class ConnectipsGateway implements Gateway {
    private static final ObjectMapper JSON = new ObjectMapper();
    private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build();
    private final String merchantId, appId, appName, appPassword, baseUrl;
    private final PrivateKey privateKey;

    public ConnectipsGateway(String merchantId, String appId, String appName, String appPassword,
                             PrivateKey privateKey, String baseUrl) {
        this.merchantId = merchantId;
        this.appId = appId;
        this.appName = appName;
        this.appPassword = appPassword; // for validatetxn, not the .pfx password
        this.privateKey = privateKey;
        this.baseUrl = baseUrl;
    }

    public static ConnectipsGateway fromEnv() {
        boolean production = "production".equals(System.getenv("CONNECTIPS_ENV"));
        // CONNECTIPS_BASE_URL is for a local mock or proxy. Leave it unset to talk to NCHL.
        String baseUrl = envOr("CONNECTIPS_BASE_URL", production ? "https://login.connectips.com" : "https://uat.connectips.com");
        // connectIPS has no shared test merchant, so UAT needs your own credentials too. NCHL emails them.
        String merchantId = envOr("CONNECTIPS_MERCHANT_ID", "");
        String appId = envOr("CONNECTIPS_APP_ID", "");
        String appName = envOr("CONNECTIPS_APP_NAME", "");
        String appPassword = envOr("CONNECTIPS_APP_PASSWORD", "");
        // PKCS#8 PEM ("BEGIN PRIVATE KEY") taken out of the .pfx. Env files often hold it with "\\n" escapes.
        String pem = envOr("CONNECTIPS_PRIVATE_KEY_PEM", "").replace("\\\\n", "\\n");
        if (merchantId.isEmpty() || appId.isEmpty() || appName.isEmpty() || appPassword.isEmpty() || pem.isEmpty()) {
            throw new IllegalStateException("Set CONNECTIPS_MERCHANT_ID, CONNECTIPS_APP_ID, CONNECTIPS_APP_NAME, "
                + "CONNECTIPS_APP_PASSWORD and CONNECTIPS_PRIVATE_KEY_PEM");
        }
        return new ConnectipsGateway(merchantId, appId, appName, appPassword, loadKey(pem), baseUrl.replaceAll("/+$", ""));
    }

    private static String envOr(String name, String fallback) {
        String value = System.getenv(name);
        return value != null && !value.isEmpty() ? value : fallback;
    }

    // Load the key once, not per request. Java reads PKCS#8 only, the DER bytes inside the PEM armour.
    private static PrivateKey loadKey(String pem) {
        if (!pem.contains("-----BEGIN PRIVATE KEY-----")) {
            throw new IllegalStateException("CONNECTIPS_PRIVATE_KEY_PEM must be PKCS#8 (BEGIN PRIVATE KEY): convert it with openssl pkcs8 -topk8");
        }
        String body = pem.replaceAll("-----[A-Z ]+-----|\\\\s", "");
        try {
            return KeyFactory.getInstance("RSA").generatePrivate(new PKCS8EncodedKeySpec(Base64.getDecoder().decode(body)));
        } catch (GeneralSecurityException | IllegalArgumentException e) {
            throw new IllegalStateException("CONNECTIPS_PRIVATE_KEY_PEM is not an RSA private key", e);
        }
    }

    // TXNDATE is DD-MM-YYYY in Nepal time, whatever time zone the server runs in.
    static String nepalDate() {
        return LocalDate.now(ZoneId.of("Asia/Kathmandu")).format(DateTimeFormatter.ofPattern("dd-MM-yyyy", Locale.ROOT));
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

    // connectIPS signs "NAME=value,NAME=value,..." in a fixed order. Bare commas, no spaces.
    static String tokenString(Map<String, String> fields, List<String> names) {
        List<String> parts = new ArrayList<>();
        for (String n : names) parts.add(n + "=" + fields.get(n));
        return String.join(",", parts);
    }`,
      start: `    private static final List<String> FORM_FIELDS = List.of("MERCHANTID", "APPID", "APPNAME", "TXNID", "TXNDATE",
        "TXNCRNCY", "TXNAMT", "REFERENCEID", "REMARKS", "PARTICULARS");

    // Free text lands inside the signed string, where "," or "=" would break it. Clip to the field's limit too.
    private static String clean(String text, int max) {
        String s = text.replaceAll("[,=]", " ");
        return s.length() > max ? s.substring(0, max) : s;
    }

    // Returns a form the browser auto-POSTs to connectIPS.
    @Override
    public Start startPayment(String attemptId, long amountPaisa, String returnUrl, String description) {
        // TXNID takes at most 20 characters. Our attempt ids are exactly 20 hex characters; a UUID (36) would not fit.
        if (!attemptId.matches("[A-Za-z0-9-]{1,20}")) {
            throw new IllegalArgumentException("connectIPS TXNID must be 1 to 20 letters, digits or \\"-\\": " + attemptId);
        }
        Map<String, String> fields = new LinkedHashMap<>();
        fields.put("MERCHANTID", merchantId);
        fields.put("APPID", appId);
        fields.put("APPNAME", appName);
        fields.put("TXNID", attemptId); // unique per attempt; a reused TXNID is refused
        fields.put("TXNDATE", nepalDate());
        fields.put("TXNCRNCY", "NPR");
        fields.put("TXNAMT", Long.toString(amountPaisa)); // paisa, not rupees: Rs 100 is "10000"
        fields.put("REFERENCEID", attemptId);
        fields.put("REMARKS", clean(description, 50));
        fields.put("PARTICULARS", clean(description, 100));
        // The token string ends with the literal "TOKEN=TOKEN".
        fields.put("TOKEN", rsaSha256Base64(tokenString(fields, FORM_FIELDS) + ",TOKEN=TOKEN"));
        // returnUrl is not sent: connectIPS returns the buyer to the URLs NCHL registered for your app.
        return new Start.Form(baseUrl + "/connectipswebgw/loginpage", fields, null);
    }`,
      confirm: `    // validatetxn answer -> our status. ERROR covers both "never heard of it" and "not finished", so read statusDesc.
    private static String toStatus(String status, String statusDesc) {
        if (status.equals("SUCCESS")) return "paid";
        if (status.equals("FAILED")) return "failed";
        if (statusDesc.toUpperCase(Locale.ROOT).contains("NOT FOUND")) return "not_found";
        // TRANSACTION INCOMPLETE (no OTP yet) and anything unknown: ask again later.
        return "pending";
    }

    // Called from the return route (params = query + body) and from the reconcile job (empty params).
    @Override
    public Outcome confirmPayment(String attemptId, long amountPaisa, String providerRef, Map<String, String> params) {
        // The redirect carries only ?TXNID=, unsigned. It can point at a payment but never prove one.
        String txnId = params.get("TXNID");
        if (txnId != null && !txnId.isEmpty() && !txnId.equals(attemptId)) {
            throw new PaymentException("connectIPS: TXNID is for a different payment");
        }

        // validatetxn is the real answer. referenceId is the TXNID we posted (not REFERENCEID),
        // and txnAmt is the STORED amount in paisa.
        Map<String, String> signed = Map.of("MERCHANTID", merchantId, "APPID", appId, "REFERENCEID", attemptId,
            "TXNAMT", Long.toString(amountPaisa));
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("merchantId", Long.parseLong(merchantId));
        payload.put("appId", appId);
        payload.put("referenceId", attemptId);
        payload.put("txnAmt", amountPaisa);
        payload.put("token", rsaSha256Base64(tokenString(signed, List.of("MERCHANTID", "APPID", "REFERENCEID", "TXNAMT"))));
        String auth = Base64.getEncoder().encodeToString((appId + ":" + appPassword).getBytes(StandardCharsets.UTF_8));
        HttpResponse<String> res;
        JsonNode body;
        try {
            HttpRequest request = HttpRequest.newBuilder(URI.create(baseUrl + "/connectipswebws/api/creditor/validatetxn"))
                .timeout(Duration.ofSeconds(20))
                .header("Authorization", "Basic " + auth)
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(JSON.writeValueAsString(payload)))
                .build();
            res = http.send(request, HttpResponse.BodyHandlers.ofString());
            body = JSON.readTree(res.body());
        } catch (IOException e) {
            throw new IllegalStateException("connectIPS validatetxn failed: " + e.getMessage(), e);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("connectIPS validatetxn interrupted", e);
        }
        // 401 means a wrong APPID or app password. Like an outage, that is not the buyer's fault: the route answers 502.
        if (res.statusCode() != 200 || body == null || !body.path("status").isTextual()) {
            throw new IllegalStateException("connectIPS validatetxn failed: HTTP " + res.statusCode() + " " + res.body());
        }
        String status = toStatus(body.get("status").asText(), body.path("statusDesc").asText(""));
        // txnAmt comes back as text ("10000"). A success for any other amount is not this payment.
        if (status.equals("paid")) {
            JsonNode paid = body.path("txnAmt");
            boolean same;
            try {
                same = (paid.isTextual() || paid.isNumber()) && Math.round(Double.parseDouble(paid.asText())) == amountPaisa;
            } catch (NumberFormatException e) {
                same = false;
            }
            if (!same) throw new PaymentException("connectIPS: amount mismatch (" + paid + ")");
        }
        // validatetxn returns no connectIPS transaction id (gettxndetail does), so there is no providerRef to keep.
        return new Outcome(status, null);
    }
}`,
    },
  },
  kotlin: {
    file: "src/main/kotlin/payments/ConnectipsGateway.kt",
    lang: "kotlin",
    parts: {
      config: `package payments

import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.security.KeyFactory
import java.security.PrivateKey
import java.security.Signature
import java.security.spec.PKCS8EncodedKeySpec
import java.time.Duration
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Base64
import kotlin.math.roundToLong
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

// connectIPS (NCHL). UAT unless CONNECTIPS_ENV=production.
class ConnectipsGateway(
    private val merchantId: String,
    private val appId: String,
    private val appName: String,
    private val appPassword: String, // for validatetxn, not the .pfx password
    private val privateKey: PrivateKey,
    private val baseUrl: String,
) : Gateway {
    private val http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build()

    companion object {
        fun fromEnv(): ConnectipsGateway {
            fun env(name: String) = System.getenv(name).orEmpty()
            val production = env("CONNECTIPS_ENV") == "production"
            // CONNECTIPS_BASE_URL is for a local mock or proxy. Leave it unset to talk to NCHL.
            val baseUrl = env("CONNECTIPS_BASE_URL").ifEmpty {
                if (production) "https://login.connectips.com" else "https://uat.connectips.com"
            }
            // connectIPS has no shared test merchant, so UAT needs your own credentials too. NCHL emails them.
            val merchantId = env("CONNECTIPS_MERCHANT_ID")
            val appId = env("CONNECTIPS_APP_ID")
            val appName = env("CONNECTIPS_APP_NAME")
            val appPassword = env("CONNECTIPS_APP_PASSWORD")
            // PKCS#8 PEM ("BEGIN PRIVATE KEY") taken out of the .pfx. Env files often hold it with "\\n" escapes.
            val pem = env("CONNECTIPS_PRIVATE_KEY_PEM").replace("\\\\n", "\\n")
            check(listOf(merchantId, appId, appName, appPassword, pem).all { it.isNotEmpty() }) {
                "Set CONNECTIPS_MERCHANT_ID, CONNECTIPS_APP_ID, CONNECTIPS_APP_NAME, CONNECTIPS_APP_PASSWORD and CONNECTIPS_PRIVATE_KEY_PEM"
            }
            return ConnectipsGateway(merchantId, appId, appName, appPassword, loadKey(pem), baseUrl.trimEnd('/'))
        }

        // Load the key once, not per request. The JVM reads PKCS#8 only, the DER bytes inside the PEM armour.
        private fun loadKey(pem: String): PrivateKey {
            check("-----BEGIN PRIVATE KEY-----" in pem) {
                "CONNECTIPS_PRIVATE_KEY_PEM must be PKCS#8 (BEGIN PRIVATE KEY): convert it with openssl pkcs8 -topk8"
            }
            val der = Base64.getDecoder().decode(pem.replace(Regex("-----[A-Z ]+-----|\\\\s"), ""))
            return KeyFactory.getInstance("RSA").generatePrivate(PKCS8EncodedKeySpec(der))
        }

        // TXNDATE is DD-MM-YYYY in Nepal time, whatever time zone the server runs in.
        fun nepalDate(): String = LocalDate.now(ZoneId.of("Asia/Kathmandu")).format(DateTimeFormatter.ofPattern("dd-MM-yyyy"))
    }`,
      sign: `    // base64(RSA-SHA256(private key, message)), the same as \`openssl dgst -sha256 -sign key.pem | base64\`.
    // Pass the text itself: SHA256withRSA hashes it, so never hash it first.
    fun rsaSha256Base64(message: String): String {
        val signer = Signature.getInstance("SHA256withRSA")
        signer.initSign(privateKey)
        signer.update(message.toByteArray())
        return Base64.getEncoder().encodeToString(signer.sign())
    }

    // connectIPS signs "NAME=value,NAME=value,..." in a fixed order. Bare commas, no spaces.
    private fun tokenString(fields: Map<String, String>): String = fields.entries.joinToString(",") { "\${it.key}=\${it.value}" }`,
      start: `    // Free text lands inside the signed string, where "," or "=" would break it. Clip to the field's limit too.
    private fun clean(text: String, max: Int) = text.replace(Regex("[,=]"), " ").take(max)

    // Returns a form the browser auto-POSTs to connectIPS.
    override suspend fun startPayment(attemptId: String, amountPaisa: Long, returnUrl: String, description: String): Start {
        // TXNID takes at most 20 characters. Our attempt ids are exactly 20 hex characters; a UUID (36) would not fit.
        require(Regex("[A-Za-z0-9-]{1,20}").matches(attemptId)) {
            "connectIPS TXNID must be 1 to 20 letters, digits or \\"-\\": $attemptId"
        }
        // linkedMapOf keeps this order, which is the order connectIPS signs.
        val fields = linkedMapOf(
            "MERCHANTID" to merchantId,
            "APPID" to appId,
            "APPNAME" to appName,
            "TXNID" to attemptId, // unique per attempt; a reused TXNID is refused
            "TXNDATE" to nepalDate(),
            "TXNCRNCY" to "NPR",
            "TXNAMT" to amountPaisa.toString(), // paisa, not rupees: Rs 100 is "10000"
            "REFERENCEID" to attemptId,
            "REMARKS" to clean(description, 50),
            "PARTICULARS" to clean(description, 100),
        )
        // The token string ends with the literal "TOKEN=TOKEN".
        fields["TOKEN"] = rsaSha256Base64(tokenString(fields) + ",TOKEN=TOKEN")
        // returnUrl is not sent: connectIPS returns the buyer to the URLs NCHL registered for your app.
        return Start.Form("$baseUrl/connectipswebgw/loginpage", fields)
    }`,
      confirm: `    // validatetxn answer -> our status. ERROR covers both "never heard of it" and "not finished", so read statusDesc.
    private fun toStatus(status: String, statusDesc: String) = when {
        status == "SUCCESS" -> "paid"
        status == "FAILED" -> "failed"
        "NOT FOUND" in statusDesc.uppercase() -> "not_found"
        // TRANSACTION INCOMPLETE (no OTP yet) and anything unknown: ask again later.
        else -> "pending"
    }

    // A JSON value as text: "10000" and 10000 both give "10000".
    private fun JsonObject.text(name: String): String? = (this[name] as? JsonPrimitive)?.takeIf { it !is JsonNull }?.content

    // Called from the return route (params = query + body) and from the reconcile job (empty params).
    override suspend fun confirmPayment(attemptId: String, amountPaisa: Long, providerRef: String?, params: Map<String, String>): Outcome {
        // The redirect carries only ?TXNID=, unsigned. It can point at a payment but never prove one.
        val txnId = params["TXNID"]
        if (!txnId.isNullOrEmpty() && txnId != attemptId) throw PaymentException("connectIPS: TXNID is for a different payment")

        // validatetxn is the real answer. referenceId is the TXNID we posted (not REFERENCEID),
        // and txnAmt is the STORED amount in paisa.
        val signed = linkedMapOf("MERCHANTID" to merchantId, "APPID" to appId, "REFERENCEID" to attemptId, "TXNAMT" to amountPaisa.toString())
        val payload = buildJsonObject {
            put("merchantId", merchantId.toLong())
            put("appId", appId)
            put("referenceId", attemptId)
            put("txnAmt", amountPaisa)
            put("token", rsaSha256Base64(tokenString(signed)))
        }
        val auth = Base64.getEncoder().encodeToString("$appId:$appPassword".toByteArray())
        val request = HttpRequest.newBuilder(URI.create("$baseUrl/connectipswebws/api/creditor/validatetxn"))
            .timeout(Duration.ofSeconds(20))
            .header("Authorization", "Basic $auth")
            .header("Content-Type", "application/json")
            .POST(HttpRequest.BodyPublishers.ofString(payload.toString()))
            .build()
        val res = withContext(Dispatchers.IO) { http.send(request, HttpResponse.BodyHandlers.ofString()) }
        val body = runCatching { Json.parseToJsonElement(res.body()) as JsonObject }.getOrNull()
        val cipsStatus = body?.text("status")
        // 401 means a wrong APPID or app password. Like an outage, that is not the buyer's fault: the route answers 502.
        if (res.statusCode() != 200 || body == null || cipsStatus == null) {
            throw IllegalStateException("connectIPS validatetxn failed: HTTP \${res.statusCode()} \${res.body()}")
        }
        val status = toStatus(cipsStatus, body.text("statusDesc").orEmpty())
        // txnAmt comes back as text ("10000"). A success for any other amount is not this payment.
        if (status == "paid" && body.text("txnAmt")?.toDoubleOrNull()?.roundToLong() != amountPaisa) {
            throw PaymentException("connectIPS: amount mismatch (\${body["txnAmt"]})")
        }
        // validatetxn returns no connectIPS transaction id (gettxndetail does), so there is no providerRef to keep.
        return Outcome(status)
    }
}`,
    },
  },
};

// connectIPS sends the buyer to one URL registered with NCHL, not to a URL sent per payment. This route,
// added to each framework, forwards /connectips/return?TXNID=<attempt id> to the shared return route.
export const bridge: Record<string, Block[]> = {
  express: [
    { file: "server.ts", lang: "ts", code: `// Add next to the other routes, before app.listen.
// connectIPS returns the buyer to the one URL NCHL registered, adding ?TXNID=<attempt id>.
// Register BASE_URL/connectips/return and forward from it to the return route.
app.get("/connectips/return", (req, res) => {
  const attempt = getAttempt(String(req.query.TXNID ?? ""));
  if (!attempt) return void res.status(404).send("Payment not found");
  res.redirect(303, \`/pay/return/\${attempt.id}?TXNID=\${attempt.id}\`);
});` },
  ],
  hono: [
    { file: "server.ts", lang: "ts", code: `// Add next to the other routes, before serve().
// connectIPS returns the buyer to the one URL NCHL registered, adding ?TXNID=<attempt id>.
// Register BASE_URL/connectips/return and forward from it to the return route.
app.get("/connectips/return", (c) => {
  const attempt = getAttempt(c.req.query("TXNID") ?? "");
  if (!attempt) return c.text("Payment not found", 404);
  return c.redirect(\`/pay/return/\${attempt.id}?TXNID=\${attempt.id}\`, 303);
});` },
  ],
  nextjs: [
    { file: "app/connectips/return/route.ts", lang: "ts", code: `// GET /connectips/return?TXNID=<attempt id>
// connectIPS returns the buyer to the one URL NCHL registered. Register BASE_URL/connectips/return
// and forward from it to the return route.
import { getAttempt } from "@/store";

export async function GET(req: Request) {
  const attempt = getAttempt(new URL(req.url).searchParams.get("TXNID") ?? "");
  if (!attempt) return new Response("Payment not found", { status: 404 });
  return new Response(null, { status: 303, headers: { Location: \`/pay/return/\${attempt.id}?TXNID=\${attempt.id}\` } });
}` },
  ],
  fastify: [
    { file: "server.ts", lang: "ts", code: `// Add next to the other routes, before app.listen.
// connectIPS returns the buyer to the one URL NCHL registered, adding ?TXNID=<attempt id>.
// Register BASE_URL/connectips/return and forward from it to the return route.
app.get<{ Querystring: { TXNID?: string } }>("/connectips/return", async (req, reply) => {
  const attempt = getAttempt(req.query.TXNID ?? "");
  if (!attempt) return reply.code(404).send("Payment not found");
  return reply.redirect(\`/pay/return/\${attempt.id}?TXNID=\${attempt.id}\`, 303);
});` },
  ],
  django: [
    { file: "shop/views.py", lang: "python", code: `# Add to the end of shop/views.py.
# connectIPS returns the buyer to the one URL NCHL registered, adding ?TXNID=<attempt id>.
# Register BASE_URL/connectips/return and forward from it to the return view.
@require_GET
def connectips_return(request):
    attempt = store.get_attempt(request.GET.get("TXNID", ""))
    if attempt is None:
        return HttpResponse("Payment not found", status=404)
    return see_other(f"/pay/return/{attempt.id}?TXNID={attempt.id}")` },
    { file: "shop/urls.py", lang: "python", code: `urlpatterns = [
    path("", views.home),
    path("pay/<str:order_id>", views.pay),
    path("pay/return/<str:attempt_id>", views.payment_return),
    path("orders/<str:order_id>", views.order_status),
    path("connectips/return", views.connectips_return),  # add this line
]` },
  ],
  fastapi: [
    { file: "main.py", lang: "python", code: `# Add next to the other routes.
# connectIPS returns the buyer to the one URL NCHL registered, adding ?TXNID=<attempt id>.
# Register BASE_URL/connectips/return and forward from it to the return route.
@app.get("/connectips/return")
def connectips_return(request: Request):
    attempt = store.get_attempt(request.query_params.get("TXNID", ""))
    if attempt is None:
        return PlainTextResponse("Payment not found", 404)
    return RedirectResponse(f"/pay/return/{attempt.id}?TXNID={attempt.id}", 303)` },
  ],
  flask: [
    { file: "app.py", lang: "python", code: `# Add next to the other routes.
# connectIPS returns the buyer to the one URL NCHL registered, adding ?TXNID=<attempt id>.
# Register BASE_URL/connectips/return and forward from it to the return route.
@app.get("/connectips/return")
def connectips_return():
    attempt = store.get_attempt(request.args.get("TXNID", ""))
    if attempt is None:
        return "Payment not found", 404
    return redirect(f"/pay/return/{attempt.id}?TXNID={attempt.id}", 303)` },
  ],
  laravel: [
    { file: "routes/web.php", lang: "php", code: `// Add to the end of routes/web.php.
// connectIPS returns the buyer to the one URL NCHL registered, adding ?TXNID=<attempt id>.
// Register BASE_URL/connectips/return and forward from it to the return route.
Route::get('/connectips/return', function (Request $request, Store $store) {
    $attempt = $store->getAttempt((string) $request->query('TXNID', '')) ?? abort(404);
    return redirect("/pay/return/{$attempt['id']}?TXNID={$attempt['id']}", 303);
});` },
  ],
  php: [
    { file: "index.php", lang: "php", code: `// Add to index.php above the final respond(404, ...).
// connectIPS returns the buyer to the one URL NCHL registered, adding ?TXNID=<attempt id>.
// Register BASE_URL/connectips/return and forward from it to the return route.
if ($method === 'GET' && $path === '/connectips/return') {
    $attempt = $store->getAttempt((string) ($_GET['TXNID'] ?? '')) ?? respond(404, 'Attempt not found', 'text/plain');
    seeOther("/pay/return/{$attempt['id']}?TXNID={$attempt['id']}");
}` },
  ],
  go: [
    { file: "main.go", lang: "go", code: `	// Add inside main(), next to the other routes.
	// connectIPS returns the buyer to the one URL NCHL registered, adding ?TXNID=<attempt id>.
	// Register BASE_URL/connectips/return and forward from it to the return route.
	mux.HandleFunc("GET /connectips/return", func(w http.ResponseWriter, r *http.Request) {
		attempt, ok := store.GetAttempt(r.URL.Query().Get("TXNID"))
		if !ok {
			http.NotFound(w, r)
			return
		}
		http.Redirect(w, r, "/pay/return/"+attempt.ID+"?TXNID="+attempt.ID, http.StatusSeeOther)
	})` },
  ],
  spring: [
    { file: "src/main/java/shop/PaymentController.java", lang: "java", code: `    // Add to PaymentController.
    // connectIPS returns the buyer to the one URL NCHL registered, adding ?TXNID=<attempt id>.
    // Register BASE_URL/connectips/return and forward from it to the return route.
    @GetMapping("/connectips/return")
    ResponseEntity<String> connectipsReturn(@RequestParam(name = "TXNID", defaultValue = "") String txnId) {
        Store.Attempt attempt = store.getAttempt(txnId);
        if (attempt == null) return ResponseEntity.notFound().build();
        URI target = URI.create("/pay/return/" + attempt.id() + "?TXNID=" + attempt.id());
        return ResponseEntity.status(HttpStatus.SEE_OTHER).location(target).build();
    }` },
  ],
  ktor: [
    { file: "src/main/kotlin/shop/Application.kt", lang: "kotlin", code: `        // Add inside routing { }, next to the other routes.
        // connectIPS returns the buyer to the one URL NCHL registered, adding ?TXNID=<attempt id>.
        // Register BASE_URL/connectips/return and forward from it to the return route.
        get("/connectips/return") {
            val attempt = store.getAttempt(call.request.queryParameters["TXNID"].orEmpty())
                ?: return@get call.respond(HttpStatusCode.NotFound)
            call.seeOther("/pay/return/\${attempt.id}?TXNID=\${attempt.id}")
        }` },
  ],
};

// A throwaway RSA key I generated only for these vectors. It signs nothing real. connectIPS publishes no
// test key, so the signatures below come from `openssl dgst -sha256 -sign` with this key.
export const testKey = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQCOlS+FPwkZj+LK
IS96tc37G0vHENRCRhcSSByBQ2Ctveyhx36YLwDh8iPkatpGrH6YoguFC/fFYqjy
lg9H09FqtXEhUfhNhqjpBiJPGeI5pqYLfQMbd9RwGj71DGNkwEsMEkTkWuidtAWo
VIWSqmd0l/NTqhYZlceBQ0jjfHmR4+h+TJbnD0sWbX1teksYYd+LhsT51nyGBTOh
e6TxTpNfmWe6v39iW9V9gvcEtv1+HZS8VQSbK8OhrZcQR/+3fzTQ0fl+pixOSWOO
+GH/fpaUSWloj2YkbqRSTokdT8dQqop2uAJ1rOJOpMkctB0V0/i0bzZ1ayvM0uqW
WrQ8IvzvAgMBAAECggEAHAl78bCmgm9HwkVqR6/uVB1W9kr54hpUORUS/dwY67E4
Ecvfud8sRkHOCwFz8IfE0RC0QTJMQ3UWEbWuRYqCWIBbQZkTwXLkTgYVwwYs9Pcv
GX04mjMjA/Q1QwxvkwU4/KOvBlRV/4TBxAryxRdbBpNGlsIQXHGWbHWlpI36fdRO
3Bi7fFfmTy+PVcTEHVtSGnPccucnJ4Q5ia/cC2sjDnpo7Nt79v9PK450JrUD36cC
Uj7kMqHYJJny54447YUx9GHEiC2PgAh81hzuhapxlgDEnjER3PHS+rg737/kvqik
lDFR+9eATTIW7eRT9ZtGmRY9UpvvHIPyGes4HtQeMQKBgQDFCEZyKZ76VgebMKyy
oI6JS454Mh0dcx99IIELLtl5wHmpj4rnWwpeNvqaXLusX7o9lJd0vQtQrOmZv0RC
Sk2D/3DQx1rsODNGqXeYLXtS+JrDjqCtHl3QS3lm5hjnj0IQhGgzCuFJUT/pnhyv
leoVKWdu8C+4yMkLAlLYOcSQuQKBgQC5QTshuBFJzA+y+OH6t8MjR+WRt2IVYZ1d
EszB8ODWmtLqvY//BNl6ZaD6/ypx5wvqSkL3ZMA6QKr4LmhEWsbeBOUanOlSh2+q
s15Ucjl4etafrJEtbqQl/6g1BzSPVMJC52hrX7iLVCgQV8UuAzJVFYhCB+EMn2va
5I6VOriW5wKBgQC7gs6YIygbEfiXJtGUBdzgqLljhj3TIxaanG5y2Bk8F4MxbVxC
JZBObYA9m3c36rpxlJI3FRpJouWF3lL1y4TN1DHnX3IWUL3rx6f7eX1eTx3qcjhT
yQx7CPj2hpC4/stesMQBn58biWmLyV9/cuqdTRQUrhycfOlnwsRY51E8cQKBgEz9
zDp+SkkWUuv5vck6OBJgngtKYKwsLn9xAcIUfw0RuVivwbml5VCWDipig9xkvrH3
fQ9eQvmyyJtuhgzqgT3iYOkHj3yqJwGVnD2SX0owGySvToLIOdZFAz5OqUxsWHP/
wojldkgJiMEKCTvPPkrYMRHoPmLFmsiVNqDUj8S/AoGBAIelpPWla3b2V2ITZSgq
qAI8sUWUUY9Qu5Z+dLnKYwAOP2Tj4CdwixQtpWDp1XRn+LGKwznN5I5yci7wrxYI
tbslVSYTHkl5Lx3l7dVHIRnU8fhmhkc+VHQtbnhaTH1hM57msii7PuLGqJ3cLiwz
Pj4mYql3DbqBte12vn7s5ipp
-----END PRIVATE KEY-----`;

export const vectors: { message: string; signature: string }[] = [
  { message: "MERCHANTID=550,APPID=MER-550-APP-1,APPNAME=Test,TXNID=txn123,TXNDATE=15-03-2022,TXNCRNCY=NPR,TXNAMT=500,REFERENCEID=REF-001,REMARKS=RMKS-001,PARTICULARS=PART-001,TOKEN=TOKEN", signature: "TeagdWA3UkDCFwHWqpyEErGPdloEW2nXdG/WGQHCZuZL1gCs1tGKuVuZATPlbB5sk7rXXfDPzKanDVfbkrM9EK4HOKgXqYURp+8ojUiDYK+Hh4rw/bcVSXSizU8IQbqaxLMEYaIvSXfRvQN4TkIKTX3t0/r/CD9s2FZ42+NiiSBoy7SSpmqUVlD7Ga5DREtu/qmn5CE7ibo2rNkPjtVGHiFc5vLuZUwMTNXcaVYH/qobLBEGd3/bTR5F/8DsFEhX8PX/X+VOk55sKqHxLhEyBI75pNgrnc0oEE38RypmBxc+WSUXu2VjJPHCEM8QOZ2j/zPXz4tybfJ6Yppn8xR/fA==" },
  { message: "MERCHANTID=550,APPID=MER-550-APP-1,REFERENCEID=txn123,TXNAMT=500", signature: "BqcJdXHH/91O4z6hX38OxzrJh5SEC2bvHAaYa67/sxbRVxySXaph7wLCrsk55LmNSSsEvWqehbXUQK3zeAAaNOub/iDnDPUMOxfGFb2Vg2L1Ylt6Omy0wpYNbT8kZ2U215RtcuKUulf+kY0/VB6PxFbTmYD95ZCwJ8q0VLU+fapIC0ZWCPEMUWDxta75NrLo+cB0E7Wwmm9FKQmTICDTe5a9X/+Xd1t4zJ01AtIZNB4BGJYl12e0GIJKXhKK3YnPLxPyPIgJUS4Xdv5pu+fVmmdJUvUPvvZ57cdNQSqkdiousIXl74GgWeQRA5SI/LIgAr76Pp1HMUaJAHh+jn9Xsw==" },
  { message: "MERCHANTID=550,APPID=MER-550-APP-1,APPNAME=Test,TXNID=0f3a9c2e7b1d4a6c8e5f,TXNDATE=05-11-2026,TXNCRNCY=NPR,TXNAMT=10000,REFERENCEID=0f3a9c2e7b1d4a6c8e5f,REMARKS=Order demo,PARTICULARS=Order demo,TOKEN=TOKEN", signature: "IeONo2beCLTgt75p74Ek+c+nvBlukpSN2QRox5dP79EV1p6TrVEXrZ+k09aXActSkoOuWMv1wzoyLZbDMSPSyjkGzk1xjV4exmG9mrljpp/+aSnikRbXbbYRfm6JVkypy0IublJOqpLNZwcM8PJdrWau+oFo0GY82vIBG0XqaDYpaVEuhF/ta5OUJrROxTafBhUoTVflYKkF6G+i/CUWgzUaw0Z4+O6xk356Pk4fZu6VAqT5QFBEXI1tw0mSWQ54E9+CQy7YWoJ5/v5u5tcJ3O69R9HIkhLXCkPcNADkQgQZtPZesGou7fvdtZOvGRyeZ8Lbi0Ouam3SVJHqx7OlGg==" },
];

export default connectips;

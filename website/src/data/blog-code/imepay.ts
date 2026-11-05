// Generated IME Pay web checkout gateway module, one per language.
// The parts joined with "\n\n" in order (config, http, start, confirm) form the complete file.

export interface GatewayCode {
  file: string;
  lang: string;
  parts: { config: string; http: string; start: string; confirm: string };
}

export const imepay: Record<"ts" | "python" | "php" | "go" | "java" | "kotlin", GatewayCode> = {
  ts: {
    file: "imepay.ts",
    lang: "typescript",
    parts: {
      config: `import { PaymentError, type ConfirmInput, type Outcome, type Start, type StartInput } from "./payments";

// IME Pay web checkout. Test server unless IMEPAY_ENV=production.
const PRODUCTION = process.env.IMEPAY_ENV === "production";

// Port 7979 must be open outbound, and IME may need to whitelist your server IP.
// IMEPAY_BASE_URL is optional: point it at a local mock while you wait for credentials.
const BASE_URL =
  process.env.IMEPAY_BASE_URL ?? (PRODUCTION ? "https://payment.imepay.com.np:7979" : "https://stg.imepay.com.np:7979");

// IME Pay has no public test merchant. These four come from the merchant team, for test and live.
const MERCHANT_CODE = process.env.IMEPAY_MERCHANT_CODE ?? "";
const USERNAME = process.env.IMEPAY_USERNAME ?? "";
const PASSWORD = process.env.IMEPAY_PASSWORD ?? "";
const MODULE = process.env.IMEPAY_MODULE ?? "";
if (!MERCHANT_CODE || !USERNAME || !PASSWORD || !MODULE) {
  throw new Error("Set IMEPAY_MERCHANT_CODE, IMEPAY_USERNAME, IMEPAY_PASSWORD and IMEPAY_MODULE");
}

// Paisa to IME's amount text, always two decimals: 10000 -> "100.00", 10050 -> "100.50".
function rupees(paisa: number): string {
  return \`\${Math.floor(paisa / 100)}.\${String(paisa % 100).padStart(2, "0")}\`;
}`,
      http: `// Standard base64 of UTF-8 text. btoa and TextEncoder, not Buffer, so it runs on edge runtimes too.
function base64(text: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(text)));
}

// Every API call sends Basic auth, the Module name base64 encoded (not the plain name), and a JSON body.
// There is no HMAC anywhere in IME Pay.
const HEADERS = {
  Authorization: \`Basic \${base64(\`\${USERNAME}:\${PASSWORD}\`)}\`,
  Module: base64(MODULE),
  "Content-Type": "application/json",
};

async function post(path: string, body: Record<string, string>): Promise<Record<string, unknown>> {
  const res = await fetch(BASE_URL + path, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000), // a hang here usually means port 7979 is blocked
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || typeof data !== "object" || data === null) {
    throw new Error(\`IME Pay \${path} failed: HTTP \${res.status}\`);
  }
  return data as Record<string, unknown>;
}

// ResponseCode can be a number or a string. Compare it as text so 0 and "0" both match.
const codeOf = (data: Record<string, unknown>) => (data.ResponseCode == null ? null : String(data.ResponseCode));`,
      start: `// The checkout payload: seven values joined with "|", then base64.
export function checkoutData(values: string[]): string {
  return base64(values.join("|"));
}

// GetToken books the payment, then the buyer goes to IME's checkout page with the token.
export async function startPayment(input: StartInput): Promise<Start> {
  const amount = rupees(input.amountPaisa); // format once, reuse the same text below
  const res = await post("/api/Web/GetToken", { MerchantCode: MERCHANT_CODE, Amount: amount, RefId: input.attemptId });
  const token = res.TokenId == null ? "" : String(res.TokenId);
  if (codeOf(res) !== "0" || !token) {
    throw new Error(\`IME Pay GetToken failed: \${String(res.ResponseDescription ?? JSON.stringify(res))}\`);
  }
  // TokenId|MerchantCode|RefId|TranAmount|Method|RespUrl|CancelUrl. Method POST: IME posts the result back.
  // Both URLs go to the same route, which asks Recheck either way.
  const data = checkoutData([token, MERCHANT_CODE, input.attemptId, amount, "POST", input.returnUrl, input.returnUrl]);
  // IME Pay has no description field, so input.description is not sent.
  return {
    type: "redirect",
    url: \`\${BASE_URL}/WebCheckout/Checkout?data=\${encodeURIComponent(data)}\`, // base64 has + / =, so encode it
    providerRef: token, // store it: Recheck needs it and the callback leaves it out
  };
}`,
      confirm: `// Called from the return route (params = IME's form POST) and from the reconcile job (params = {}).
// The callback is unsigned: anyone can POST ResponseCode=0 to your return URL. Only Recheck decides.
export async function confirmPayment(input: ConfirmInput): Promise<Outcome> {
  // The callback proves nothing, but a RefId for another attempt is a forgery or a mix-up. Refuse it.
  if (input.params.RefId && input.params.RefId !== input.attemptId) {
    throw new PaymentError("IME Pay: callback is for a different payment");
  }
  // No stored TokenId means GetToken failed, so the buyer never reached IME Pay.
  if (!input.providerRef) return { status: "not_found" };

  const res = await post("/api/Web/Recheck", {
    MerchantCode: MERCHANT_CODE,
    RefId: input.attemptId,
    TokenId: input.providerRef,
  });
  const code = codeOf(res);
  if (code === null) throw new Error(\`IME Pay Recheck returned no ResponseCode: \${JSON.stringify(res)}\`);
  if (res.RefId && String(res.RefId) !== input.attemptId) {
    throw new PaymentError("IME Pay: Recheck answered for a different payment");
  }
  // Check the amount against the one WE stored. A paid answer without an amount is not trusted either.
  const tranAmount = res.TranAmount == null || res.TranAmount === "" ? null : String(res.TranAmount);
  if (tranAmount !== null && Math.round(Number(tranAmount) * 100) !== input.amountPaisa) {
    throw new PaymentError(\`IME Pay: amount mismatch (\${tranAmount})\`);
  }
  if (code !== "0") {
    // Only 0 has one meaning across sources. 1 reads as failed in one library and pending in another,
    // so every other code stays pending and the reconcile job keeps asking.
    return { status: "pending" };
  }
  if (tranAmount === null) throw new PaymentError("IME Pay: Recheck says paid but has no TranAmount");
  return { status: "paid", providerRef: res.TransactionId == null ? undefined : String(res.TransactionId) };
}`,
    },
  },
  python: {
    file: "imepay.py",
    lang: "python",
    parts: {
      config: `import base64
import json
import os
import urllib.error
import urllib.parse
import urllib.request

from payments import Outcome, PaymentError, Start

# IME Pay web checkout. Test server unless IMEPAY_ENV=production.
PRODUCTION = os.environ.get("IMEPAY_ENV") == "production"

# Port 7979 must be open outbound, and IME may need to whitelist your server IP.
# IMEPAY_BASE_URL is optional: point it at a local mock while you wait for credentials.
BASE_URL = os.environ.get("IMEPAY_BASE_URL") or (
    "https://payment.imepay.com.np:7979" if PRODUCTION else "https://stg.imepay.com.np:7979"
)

# IME Pay has no public test merchant. These four come from the merchant team, for test and live.
MERCHANT_CODE = os.environ.get("IMEPAY_MERCHANT_CODE", "")
USERNAME = os.environ.get("IMEPAY_USERNAME", "")
PASSWORD = os.environ.get("IMEPAY_PASSWORD", "")
MODULE = os.environ.get("IMEPAY_MODULE", "")
if not (MERCHANT_CODE and USERNAME and PASSWORD and MODULE):
    raise RuntimeError("Set IMEPAY_MERCHANT_CODE, IMEPAY_USERNAME, IMEPAY_PASSWORD and IMEPAY_MODULE")


def rupees(paisa: int) -> str:
    """Paisa to IME's amount text, always two decimals: 10000 -> "100.00", 10050 -> "100.50"."""
    whole, rest = divmod(paisa, 100)
    return f"{whole}.{rest:02d}"`,
      http: `def b64(text: str) -> str:
    """Standard base64 of UTF-8 text."""
    return base64.b64encode(text.encode()).decode()


# Every API call sends Basic auth, the Module name base64 encoded (not the plain name), and a JSON body.
# There is no HMAC anywhere in IME Pay.
HEADERS = {
    "Authorization": "Basic " + b64(f"{USERNAME}:{PASSWORD}"),
    "Module": b64(MODULE),
    "Content-Type": "application/json",
}


def post(path: str, body: dict[str, str]) -> dict:
    req = urllib.request.Request(BASE_URL + path, data=json.dumps(body).encode(), headers=HEADERS, method="POST")
    try:
        # A hang here usually means port 7979 is blocked.
        with urllib.request.urlopen(req, timeout=20) as res:
            data = json.load(res)
    except (urllib.error.URLError, ValueError) as e:
        raise RuntimeError(f"IME Pay {path} failed: {e}") from e
    if not isinstance(data, dict):
        raise RuntimeError(f"IME Pay {path} failed: {data}")
    return data


def code_of(data: dict) -> str | None:
    """ResponseCode can be a number or a string. Compare it as text so 0 and "0" both match."""
    return None if data.get("ResponseCode") is None else str(data["ResponseCode"])`,
      start: `def checkout_data(values: list[str]) -> str:
    """The checkout payload: seven values joined with "|", then base64."""
    return b64("|".join(values))


def start_payment(attempt_id: str, amount_paisa: int, return_url: str, description: str) -> Start:
    """GetToken books the payment, then the buyer goes to IME's checkout page with the token."""
    amount = rupees(amount_paisa)  # format once, reuse the same text below
    res = post("/api/Web/GetToken", {"MerchantCode": MERCHANT_CODE, "Amount": amount, "RefId": attempt_id})
    token = "" if res.get("TokenId") is None else str(res["TokenId"])
    if code_of(res) != "0" or not token:
        raise RuntimeError(f"IME Pay GetToken failed: {res.get('ResponseDescription') or res}")
    # TokenId|MerchantCode|RefId|TranAmount|Method|RespUrl|CancelUrl. Method POST: IME posts the result back.
    # Both URLs go to the same route, which asks Recheck either way.
    data = checkout_data([token, MERCHANT_CODE, attempt_id, amount, "POST", return_url, return_url])
    # IME Pay has no description field, so description is not sent.
    return Start(
        type="redirect",
        url=f"{BASE_URL}/WebCheckout/Checkout?data={urllib.parse.quote(data, safe='')}",  # base64 has + / =
        provider_ref=token,  # store it: Recheck needs it and the callback leaves it out
    )`,
      confirm: `def confirm_payment(attempt_id: str, amount_paisa: int, provider_ref: str | None, params: dict[str, str]) -> Outcome:
    """Called from the return route (params = IME's form POST) and from the reconcile job (params = {}).
    The callback is unsigned: anyone can POST ResponseCode=0 to your return URL. Only Recheck decides."""
    # The callback proves nothing, but a RefId for another attempt is a forgery or a mix-up. Refuse it.
    if params.get("RefId") and params["RefId"] != attempt_id:
        raise PaymentError("IME Pay: callback is for a different payment")
    # No stored TokenId means GetToken failed, so the buyer never reached IME Pay.
    if not provider_ref:
        return Outcome(status="not_found")

    res = post("/api/Web/Recheck", {"MerchantCode": MERCHANT_CODE, "RefId": attempt_id, "TokenId": provider_ref})
    code = code_of(res)
    if code is None:
        raise RuntimeError(f"IME Pay Recheck returned no ResponseCode: {res}")
    if res.get("RefId") and str(res["RefId"]) != attempt_id:
        raise PaymentError("IME Pay: Recheck answered for a different payment")
    # Check the amount against the one WE stored. A paid answer without an amount is not trusted either.
    tran_amount = None if res.get("TranAmount") in (None, "") else str(res["TranAmount"])
    if tran_amount is not None:
        try:
            matches = round(float(tran_amount) * 100) == amount_paisa
        except (ValueError, OverflowError):  # "abc", "nan", "inf"
            matches = False
        if not matches:
            raise PaymentError(f"IME Pay: amount mismatch ({tran_amount})")
    if code != "0":
        # Only 0 has one meaning across sources. 1 reads as failed in one library and pending in another,
        # so every other code stays pending and the reconcile job keeps asking.
        return Outcome(status="pending")
    if tran_amount is None:
        raise PaymentError("IME Pay: Recheck says paid but has no TranAmount")
    tx = res.get("TransactionId")
    return Outcome(status="paid", provider_ref=None if tx is None else str(tx))`,
    },
  },
  php: {
    file: "ImepayGateway.php",
    lang: "php",
    parts: {
      config: `<?php

declare(strict_types=1);

namespace App\\Payments;

// IME Pay web checkout. Test server unless IMEPAY_ENV=production.
final class ImepayGateway implements Gateway
{
    public function __construct(
        private string $baseUrl,
        private string $merchantCode,
        private string $username,
        private string $password,
        private string $module,
    ) {
    }

    public static function fromEnv(): self
    {
        $env = static fn (string $name) => $_ENV[$name] ?? (getenv($name) !== false ? getenv($name) : null);
        $production = $env('IMEPAY_ENV') === 'production';
        // Port 7979 must be open outbound, and IME may need to whitelist your server IP.
        // IMEPAY_BASE_URL is optional: point it at a local mock while you wait for credentials.
        $baseUrl = $env('IMEPAY_BASE_URL')
            ?? ($production ? 'https://payment.imepay.com.np:7979' : 'https://stg.imepay.com.np:7979');
        // IME Pay has no public test merchant. These four come from the merchant team, for test and live.
        $merchantCode = (string) $env('IMEPAY_MERCHANT_CODE');
        $username = (string) $env('IMEPAY_USERNAME');
        $password = (string) $env('IMEPAY_PASSWORD');
        $module = (string) $env('IMEPAY_MODULE');
        if ($merchantCode === '' || $username === '' || $password === '' || $module === '') {
            throw new \\RuntimeException('Set IMEPAY_MERCHANT_CODE, IMEPAY_USERNAME, IMEPAY_PASSWORD and IMEPAY_MODULE');
        }
        return new self($baseUrl, $merchantCode, $username, $password, $module);
    }

    // Paisa to IME's amount text, always two decimals: 10000 -> "100.00", 10050 -> "100.50".
    private static function rupees(int $paisa): string
    {
        return sprintf('%d.%02d', intdiv($paisa, 100), $paisa % 100);
    }`,
      http: `    // Every API call sends Basic auth, the Module name base64 encoded (not the plain name), and a JSON body.
    // There is no HMAC anywhere in IME Pay.
    private function post(string $path, array $body): array
    {
        $ch = curl_init($this->baseUrl . $path);
        curl_setopt_array($ch, [
            CURLOPT_POST => true,
            CURLOPT_POSTFIELDS => json_encode($body),
            CURLOPT_HTTPHEADER => [
                'Authorization: Basic ' . base64_encode($this->username . ':' . $this->password),
                'Module: ' . base64_encode($this->module),
                'Content-Type: application/json',
            ],
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT => 20, // a hang here usually means port 7979 is blocked
        ]);
        $raw = curl_exec($ch);
        $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $error = curl_error($ch);
        $data = is_string($raw) ? json_decode($raw, true) : null;
        if ($code !== 200 || !is_array($data)) {
            throw new \\RuntimeException("IME Pay $path failed: HTTP $code $error");
        }
        return $data;
    }

    // ResponseCode can be a number or a string. Compare it as text so 0 and "0" both match.
    private static function codeOf(array $data): ?string
    {
        return isset($data['ResponseCode']) ? (string) $data['ResponseCode'] : null;
    }`,
      start: `    // The checkout payload: seven values joined with "|", then base64.
    public static function checkoutData(array $values): string
    {
        return base64_encode(implode('|', $values));
    }

    // GetToken books the payment, then the buyer goes to IME's checkout page with the token.
    public function startPayment(string $attemptId, int $amountPaisa, string $returnUrl, string $description): Start
    {
        $amount = self::rupees($amountPaisa); // format once, reuse the same text below
        $res = $this->post('/api/Web/GetToken', [
            'MerchantCode' => $this->merchantCode,
            'Amount' => $amount,
            'RefId' => $attemptId,
        ]);
        $token = isset($res['TokenId']) ? (string) $res['TokenId'] : '';
        if (self::codeOf($res) !== '0' || $token === '') {
            throw new \\RuntimeException('IME Pay GetToken failed: ' . ($res['ResponseDescription'] ?? json_encode($res)));
        }
        // TokenId|MerchantCode|RefId|TranAmount|Method|RespUrl|CancelUrl. Method POST: IME posts the result back.
        // Both URLs go to the same route, which asks Recheck either way.
        $data = self::checkoutData([$token, $this->merchantCode, $attemptId, $amount, 'POST', $returnUrl, $returnUrl]);
        // IME Pay has no description field, so $description is not sent.
        return Start::redirect(
            $this->baseUrl . '/WebCheckout/Checkout?data=' . rawurlencode($data), // base64 has + / =, so encode it
            $token, // store it: Recheck needs it and the callback leaves it out
        );
    }`,
      confirm: `    // Called from the return route (params = IME's form POST) and from the reconcile job (params = []).
    // The callback is unsigned: anyone can POST ResponseCode=0 to your return URL. Only Recheck decides.
    public function confirmPayment(string $attemptId, int $amountPaisa, ?string $providerRef, array $params): Outcome
    {
        // The callback proves nothing, but a RefId for another attempt is a forgery or a mix-up. Refuse it.
        if (($params['RefId'] ?? '') !== '' && $params['RefId'] !== $attemptId) {
            throw new PaymentError('IME Pay: callback is for a different payment');
        }
        // No stored TokenId means GetToken failed, so the buyer never reached IME Pay.
        if ($providerRef === null || $providerRef === '') {
            return new Outcome('not_found');
        }

        $res = $this->post('/api/Web/Recheck', [
            'MerchantCode' => $this->merchantCode,
            'RefId' => $attemptId,
            'TokenId' => $providerRef,
        ]);
        $code = self::codeOf($res);
        if ($code === null) {
            throw new \\RuntimeException('IME Pay Recheck returned no ResponseCode: ' . json_encode($res));
        }
        if (!empty($res['RefId']) && (string) $res['RefId'] !== $attemptId) {
            throw new PaymentError('IME Pay: Recheck answered for a different payment');
        }
        // Check the amount against the one WE stored. A paid answer without an amount is not trusted either.
        $tranAmount = isset($res['TranAmount']) && $res['TranAmount'] !== '' ? (string) $res['TranAmount'] : null;
        if ($tranAmount !== null
            && (!is_numeric($tranAmount) || (int) round((float) $tranAmount * 100) !== $amountPaisa)) {
            throw new PaymentError("IME Pay: amount mismatch ($tranAmount)");
        }
        if ($code !== '0') {
            // Only 0 has one meaning across sources. 1 reads as failed in one library and pending in another,
            // so every other code stays pending and the reconcile job keeps asking.
            return new Outcome('pending');
        }
        if ($tranAmount === null) {
            throw new PaymentError('IME Pay: Recheck says paid but has no TranAmount');
        }
        return new Outcome('paid', isset($res['TransactionId']) ? (string) $res['TransactionId'] : null);
    }
}`,
    },
  },
  go: {
    file: "payments/imepay.go",
    lang: "go",
    parts: {
      config: `package payments

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

// Imepay is the IME Pay web checkout. Test server unless IMEPAY_ENV=production.
type Imepay struct {
	baseURL, merchantCode, username, password, module string
	client                                            *http.Client
}

func NewImepay() *Imepay {
	i := &Imepay{
		// Port 7979 must be open outbound, and IME may need to whitelist your server IP.
		baseURL: "https://stg.imepay.com.np:7979",
		// IME Pay has no public test merchant. These four come from the merchant team, for test and live.
		merchantCode: os.Getenv("IMEPAY_MERCHANT_CODE"),
		username:     os.Getenv("IMEPAY_USERNAME"),
		password:     os.Getenv("IMEPAY_PASSWORD"),
		module:       os.Getenv("IMEPAY_MODULE"),
		client:       &http.Client{Timeout: 20 * time.Second}, // a hang here usually means port 7979 is blocked
	}
	if os.Getenv("IMEPAY_ENV") == "production" {
		i.baseURL = "https://payment.imepay.com.np:7979"
	}
	// Optional: point it at a local mock while you wait for credentials.
	if u := os.Getenv("IMEPAY_BASE_URL"); u != "" {
		i.baseURL = u
	}
	if i.merchantCode == "" || i.username == "" || i.password == "" || i.module == "" {
		panic("set IMEPAY_MERCHANT_CODE, IMEPAY_USERNAME, IMEPAY_PASSWORD and IMEPAY_MODULE")
	}
	return i
}

// imepayRupees turns paisa into IME's amount text, always two decimals: 10000 -> "100.00", 10050 -> "100.50".
func imepayRupees(paisa int64) string {
	return fmt.Sprintf("%d.%02d", paisa/100, paisa%100)
}`,
      http: `// post sends Basic auth, the Module name base64 encoded (not the plain name), and a JSON body.
// There is no HMAC anywhere in IME Pay.
func (i *Imepay) post(ctx context.Context, path string, body map[string]string) (map[string]any, error) {
	payload, _ := json.Marshal(body)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, i.baseURL+path, bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	req.SetBasicAuth(i.username, i.password)
	req.Header.Set("Module", base64.StdEncoding.EncodeToString([]byte(i.module)))
	req.Header.Set("Content-Type", "application/json")
	res, err := i.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("IME Pay %s failed: %w", path, err)
	}
	defer res.Body.Close()
	var data map[string]any
	// UseNumber keeps "100.00" and 100.00 as written, and ResponseCode 0 as "0".
	dec := json.NewDecoder(res.Body)
	dec.UseNumber()
	if err := dec.Decode(&data); err != nil || res.StatusCode != http.StatusOK || data == nil {
		return nil, fmt.Errorf("IME Pay %s failed: HTTP %s", path, res.Status)
	}
	return data, nil
}

// imepayText reads a JSON value as text, so ResponseCode 0 and "0" both read "0". Missing or null reads "".
func imepayText(data map[string]any, key string) string {
	if v, ok := data[key]; ok && v != nil {
		return fmt.Sprint(v)
	}
	return ""
}`,
      start: `// ImepayCheckoutData is the checkout payload: seven values joined with "|", then base64.
func ImepayCheckoutData(values []string) string {
	return base64.StdEncoding.EncodeToString([]byte(strings.Join(values, "|")))
}

// StartPayment calls GetToken to book the payment, then sends the buyer to IME's checkout page with the token.
func (i *Imepay) StartPayment(ctx context.Context, in StartInput) (Start, error) {
	amount := imepayRupees(in.AmountPaisa) // format once, reuse the same text below
	res, err := i.post(ctx, "/api/Web/GetToken", map[string]string{
		"MerchantCode": i.merchantCode,
		"Amount":       amount,
		"RefId":        in.AttemptID,
	})
	if err != nil {
		return Start{}, err
	}
	token := imepayText(res, "TokenId")
	if imepayText(res, "ResponseCode") != "0" || token == "" {
		return Start{}, fmt.Errorf("IME Pay GetToken failed: %v", res)
	}
	// TokenId|MerchantCode|RefId|TranAmount|Method|RespUrl|CancelUrl. Method POST: IME posts the result back.
	// Both URLs go to the same route, which asks Recheck either way.
	data := ImepayCheckoutData([]string{token, i.merchantCode, in.AttemptID, amount, "POST", in.ReturnURL, in.ReturnURL})
	// IME Pay has no description field, so in.Description is not sent.
	// base64 has + / =, so encode it. Store the token: Recheck needs it and the callback leaves it out.
	return Start{
		Type:        "redirect",
		URL:         i.baseURL + "/WebCheckout/Checkout?data=" + url.QueryEscape(data),
		ProviderRef: token,
	}, nil
}`,
      confirm: `// ConfirmPayment is called from the return route (Params = IME's form POST) and from the reconcile job (empty Params).
// The callback is unsigned: anyone can POST ResponseCode=0 to your return URL. Only Recheck decides.
func (i *Imepay) ConfirmPayment(ctx context.Context, in ConfirmInput) (Outcome, error) {
	// The callback proves nothing, but a RefId for another attempt is a forgery or a mix-up. Refuse it.
	if ref := in.Params["RefId"]; ref != "" && ref != in.AttemptID {
		return Outcome{}, fmt.Errorf("%w: IME Pay callback is for a different payment", ErrPayment)
	}
	// No stored TokenId means GetToken failed, so the buyer never reached IME Pay.
	if in.ProviderRef == "" {
		return Outcome{Status: "not_found"}, nil
	}

	res, err := i.post(ctx, "/api/Web/Recheck", map[string]string{
		"MerchantCode": i.merchantCode,
		"RefId":        in.AttemptID,
		"TokenId":      in.ProviderRef,
	})
	if err != nil {
		return Outcome{}, err
	}
	code := imepayText(res, "ResponseCode")
	if code == "" {
		return Outcome{}, fmt.Errorf("IME Pay Recheck returned no ResponseCode: %v", res)
	}
	if ref := imepayText(res, "RefId"); ref != "" && ref != in.AttemptID {
		return Outcome{}, fmt.Errorf("%w: IME Pay Recheck answered for a different payment", ErrPayment)
	}
	// Check the amount against the one WE stored. A paid answer without an amount is not trusted either.
	tranAmount := imepayText(res, "TranAmount")
	if tranAmount != "" {
		f, err := strconv.ParseFloat(tranAmount, 64)
		if err != nil || math.IsNaN(f) || int64(math.Round(f*100)) != in.AmountPaisa {
			return Outcome{}, fmt.Errorf("%w: IME Pay amount mismatch (%s)", ErrPayment, tranAmount)
		}
	}
	if code != "0" {
		// Only 0 has one meaning across sources. 1 reads as failed in one library and pending in another,
		// so every other code stays pending and the reconcile job keeps asking.
		return Outcome{Status: "pending"}, nil
	}
	if tranAmount == "" {
		return Outcome{}, fmt.Errorf("%w: IME Pay Recheck says paid but has no TranAmount", ErrPayment)
	}
	return Outcome{Status: "paid", ProviderRef: imepayText(res, "TransactionId")}, nil
}`,
    },
  },
  java: {
    file: "src/main/java/payments/ImepayGateway.java",
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
import java.time.Duration;
import java.util.Base64;
import java.util.List;
import java.util.Locale;
import java.util.Map;

// IME Pay web checkout. Test server unless IMEPAY_ENV=production.
public final class ImepayGateway implements Gateway {
    private static final ObjectMapper JSON = new ObjectMapper();
    private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build();
    private final String baseUrl, merchantCode, username, password, module;

    public ImepayGateway(String baseUrl, String merchantCode, String username, String password, String module) {
        this.baseUrl = baseUrl;
        this.merchantCode = merchantCode;
        this.username = username;
        this.password = password;
        this.module = module;
    }

    public static ImepayGateway fromEnv() {
        boolean production = "production".equals(System.getenv("IMEPAY_ENV"));
        // Port 7979 must be open outbound, and IME may need to whitelist your server IP.
        // IMEPAY_BASE_URL is optional: point it at a local mock while you wait for credentials.
        String baseUrl = envOr("IMEPAY_BASE_URL",
            production ? "https://payment.imepay.com.np:7979" : "https://stg.imepay.com.np:7979");
        // IME Pay has no public test merchant. These four come from the merchant team, for test and live.
        String merchantCode = envOr("IMEPAY_MERCHANT_CODE", "");
        String username = envOr("IMEPAY_USERNAME", "");
        String password = envOr("IMEPAY_PASSWORD", "");
        String module = envOr("IMEPAY_MODULE", "");
        if (merchantCode.isEmpty() || username.isEmpty() || password.isEmpty() || module.isEmpty()) {
            throw new IllegalStateException("Set IMEPAY_MERCHANT_CODE, IMEPAY_USERNAME, IMEPAY_PASSWORD and IMEPAY_MODULE");
        }
        return new ImepayGateway(baseUrl, merchantCode, username, password, module);
    }

    private static String envOr(String name, String fallback) {
        String value = System.getenv(name);
        return value != null ? value : fallback;
    }

    // Paisa to IME's amount text, always two decimals: 10000 -> "100.00", 10050 -> "100.50".
    static String rupees(long paisa) {
        return String.format(Locale.ROOT, "%d.%02d", paisa / 100, paisa % 100);
    }`,
      http: `    // Standard base64 of UTF-8 text.
    private static String base64(String text) {
        return Base64.getEncoder().encodeToString(text.getBytes(StandardCharsets.UTF_8));
    }

    // Every API call sends Basic auth, the Module name base64 encoded (not the plain name), and a JSON body.
    // There is no HMAC anywhere in IME Pay.
    private JsonNode post(String path, Map<String, String> body) {
        try {
            HttpRequest request = HttpRequest.newBuilder(URI.create(baseUrl + path))
                .timeout(Duration.ofSeconds(20)) // a hang here usually means port 7979 is blocked
                .header("Authorization", "Basic " + base64(username + ":" + password))
                .header("Module", base64(module))
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(JSON.writeValueAsString(body)))
                .build();
            HttpResponse<String> res = http.send(request, HttpResponse.BodyHandlers.ofString());
            JsonNode data = res.statusCode() == 200 ? JSON.readTree(res.body()) : null;
            if (data == null || !data.isObject()) {
                throw new IllegalStateException("IME Pay " + path + " failed: HTTP " + res.statusCode());
            }
            return data;
        } catch (IOException e) {
            throw new IllegalStateException("IME Pay " + path + " failed: " + e.getMessage(), e);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("IME Pay " + path + " interrupted", e);
        }
    }

    // A JSON value as text, so ResponseCode 0 and "0" both read "0". Missing or null reads "".
    private static String text(JsonNode data, String key) {
        JsonNode v = data.get(key);
        return v == null || v.isNull() ? "" : v.asText();
    }`,
      start: `    // The checkout payload: seven values joined with "|", then base64.
    public static String checkoutData(List<String> values) {
        return base64(String.join("|", values));
    }

    // GetToken books the payment, then the buyer goes to IME's checkout page with the token.
    @Override
    public Start startPayment(String attemptId, long amountPaisa, String returnUrl, String description) {
        String amount = rupees(amountPaisa); // format once, reuse the same text below
        JsonNode res = post("/api/Web/GetToken", Map.of("MerchantCode", merchantCode, "Amount", amount, "RefId", attemptId));
        String token = text(res, "TokenId");
        if (!"0".equals(text(res, "ResponseCode")) || token.isEmpty()) {
            throw new IllegalStateException("IME Pay GetToken failed: " + res);
        }
        // TokenId|MerchantCode|RefId|TranAmount|Method|RespUrl|CancelUrl. Method POST: IME posts the result back.
        // Both URLs go to the same route, which asks Recheck either way.
        String data = checkoutData(List.of(token, merchantCode, attemptId, amount, "POST", returnUrl, returnUrl));
        // IME Pay has no description field, so description is not sent.
        // base64 has + / =, so encode it. Store the token: Recheck needs it and the callback leaves it out.
        return new Start.Redirect(baseUrl + "/WebCheckout/Checkout?data=" + URLEncoder.encode(data, StandardCharsets.UTF_8), token);
    }`,
      confirm: `    // Called from the return route (params = IME's form POST) and from the reconcile job (empty params).
    // The callback is unsigned: anyone can POST ResponseCode=0 to your return URL. Only Recheck decides.
    @Override
    public Outcome confirmPayment(String attemptId, long amountPaisa, String providerRef, Map<String, String> params) {
        // The callback proves nothing, but a RefId for another attempt is a forgery or a mix-up. Refuse it.
        String callbackRef = params.getOrDefault("RefId", "");
        if (!callbackRef.isEmpty() && !callbackRef.equals(attemptId)) {
            throw new PaymentException("IME Pay: callback is for a different payment");
        }
        // No stored TokenId means GetToken failed, so the buyer never reached IME Pay.
        if (providerRef == null || providerRef.isEmpty()) return new Outcome("not_found", null);

        JsonNode res = post("/api/Web/Recheck", Map.of("MerchantCode", merchantCode, "RefId", attemptId, "TokenId", providerRef));
        String code = text(res, "ResponseCode");
        if (code.isEmpty()) throw new IllegalStateException("IME Pay Recheck returned no ResponseCode: " + res);
        String ref = text(res, "RefId");
        if (!ref.isEmpty() && !ref.equals(attemptId)) {
            throw new PaymentException("IME Pay: Recheck answered for a different payment");
        }
        // Check the amount against the one WE stored. A paid answer without an amount is not trusted either.
        String tranAmount = text(res, "TranAmount");
        if (!tranAmount.isEmpty() && toPaisa(tranAmount) != amountPaisa) {
            throw new PaymentException("IME Pay: amount mismatch (" + tranAmount + ")");
        }
        if (!code.equals("0")) {
            // Only 0 has one meaning across sources. 1 reads as failed in one library and pending in another,
            // so every other code stays pending and the reconcile job keeps asking.
            return new Outcome("pending", null);
        }
        if (tranAmount.isEmpty()) throw new PaymentException("IME Pay: Recheck says paid but has no TranAmount");
        String transactionId = text(res, "TransactionId");
        return new Outcome("paid", transactionId.isEmpty() ? null : transactionId);
    }

    // "100.00" -> 10000. Anything that is not a number returns -1, which never matches a stored amount.
    private static long toPaisa(String rupees) {
        try {
            return Math.round(Double.parseDouble(rupees) * 100);
        } catch (NumberFormatException e) {
            return -1;
        }
    }
}`,
    },
  },
  kotlin: {
    file: "src/main/kotlin/payments/ImepayGateway.kt",
    lang: "kotlin",
    parts: {
      config: `package payments

import java.net.URI
import java.net.URLEncoder
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration
import java.util.Base64
import kotlin.math.roundToLong
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

// IME Pay web checkout. Test server unless IMEPAY_ENV=production.
class ImepayGateway(
    private val baseUrl: String,
    private val merchantCode: String,
    private val username: String,
    private val password: String,
    private val module: String,
) : Gateway {
    private val http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build()

    companion object {
        fun fromEnv(): ImepayGateway {
            val production = System.getenv("IMEPAY_ENV") == "production"
            // Port 7979 must be open outbound, and IME may need to whitelist your server IP.
            // IMEPAY_BASE_URL is optional: point it at a local mock while you wait for credentials.
            val baseUrl = System.getenv("IMEPAY_BASE_URL")
                ?: if (production) "https://payment.imepay.com.np:7979" else "https://stg.imepay.com.np:7979"
            // IME Pay has no public test merchant. These four come from the merchant team, for test and live.
            val merchantCode = System.getenv("IMEPAY_MERCHANT_CODE").orEmpty()
            val username = System.getenv("IMEPAY_USERNAME").orEmpty()
            val password = System.getenv("IMEPAY_PASSWORD").orEmpty()
            val module = System.getenv("IMEPAY_MODULE").orEmpty()
            check(listOf(merchantCode, username, password, module).all { it.isNotEmpty() }) {
                "Set IMEPAY_MERCHANT_CODE, IMEPAY_USERNAME, IMEPAY_PASSWORD and IMEPAY_MODULE"
            }
            return ImepayGateway(baseUrl, merchantCode, username, password, module)
        }

        // Paisa to IME's amount text, always two decimals: 10000 -> "100.00", 10050 -> "100.50".
        fun rupees(paisa: Long): String = "\${paisa / 100}.\${(paisa % 100).toString().padStart(2, '0')}"

        // Standard base64 of UTF-8 text.
        private fun base64(text: String): String = Base64.getEncoder().encodeToString(text.toByteArray())
    }`,
      http: `    // Every API call sends Basic auth, the Module name base64 encoded (not the plain name), and a JSON body.
    // There is no HMAC anywhere in IME Pay.
    private suspend fun post(path: String, body: Map<String, String>): JsonObject {
        val json = JsonObject(body.mapValues { JsonPrimitive(it.value) }).toString()
        val request = HttpRequest.newBuilder(URI.create(baseUrl + path))
            .timeout(Duration.ofSeconds(20)) // a hang here usually means port 7979 is blocked
            .header("Authorization", "Basic " + base64("$username:$password"))
            .header("Module", base64(module))
            .header("Content-Type", "application/json")
            .POST(HttpRequest.BodyPublishers.ofString(json))
            .build()
        val res = withContext(Dispatchers.IO) { http.send(request, HttpResponse.BodyHandlers.ofString()) }
        val data = runCatching { Json.parseToJsonElement(res.body()) as JsonObject }.getOrNull()
        if (res.statusCode() != 200 || data == null) {
            throw IllegalStateException("IME Pay $path failed: HTTP \${res.statusCode()}")
        }
        return data
    }

    // A JSON value as text, so ResponseCode 0 and "0" both read "0". Missing or null reads "".
    private fun JsonElement?.text(): String = (this as? JsonPrimitive)?.takeIf { it !is JsonNull }?.content.orEmpty()`,
      start: `    // The checkout payload: seven values joined with "|", then base64.
    fun checkoutData(values: List<String>): String = base64(values.joinToString("|"))

    // GetToken books the payment, then the buyer goes to IME's checkout page with the token.
    override suspend fun startPayment(attemptId: String, amountPaisa: Long, returnUrl: String, description: String): Start {
        val amount = rupees(amountPaisa) // format once, reuse the same text below
        val res = post("/api/Web/GetToken", mapOf("MerchantCode" to merchantCode, "Amount" to amount, "RefId" to attemptId))
        val token = res["TokenId"].text()
        if (res["ResponseCode"].text() != "0" || token.isEmpty()) {
            throw IllegalStateException("IME Pay GetToken failed: $res")
        }
        // TokenId|MerchantCode|RefId|TranAmount|Method|RespUrl|CancelUrl. Method POST: IME posts the result back.
        // Both URLs go to the same route, which asks Recheck either way.
        val data = checkoutData(listOf(token, merchantCode, attemptId, amount, "POST", returnUrl, returnUrl))
        // IME Pay has no description field, so description is not sent.
        return Start.Redirect(
            url = "$baseUrl/WebCheckout/Checkout?data=\${URLEncoder.encode(data, Charsets.UTF_8)}", // base64 has + / =
            providerRef = token, // store it: Recheck needs it and the callback leaves it out
        )
    }`,
      confirm: `    // Called from the return route (params = IME's form POST) and from the reconcile job (empty params).
    // The callback is unsigned: anyone can POST ResponseCode=0 to your return URL. Only Recheck decides.
    override suspend fun confirmPayment(attemptId: String, amountPaisa: Long, providerRef: String?, params: Map<String, String>): Outcome {
        // The callback proves nothing, but a RefId for another attempt is a forgery or a mix-up. Refuse it.
        val callbackRef = params["RefId"].orEmpty()
        if (callbackRef.isNotEmpty() && callbackRef != attemptId) {
            throw PaymentException("IME Pay: callback is for a different payment")
        }
        // No stored TokenId means GetToken failed, so the buyer never reached IME Pay.
        if (providerRef.isNullOrEmpty()) return Outcome("not_found")

        val res = post("/api/Web/Recheck", mapOf("MerchantCode" to merchantCode, "RefId" to attemptId, "TokenId" to providerRef))
        val code = res["ResponseCode"].text()
        if (code.isEmpty()) throw IllegalStateException("IME Pay Recheck returned no ResponseCode: $res")
        val ref = res["RefId"].text()
        if (ref.isNotEmpty() && ref != attemptId) throw PaymentException("IME Pay: Recheck answered for a different payment")
        // Check the amount against the one WE stored. A paid answer without an amount is not trusted either.
        val tranAmount = res["TranAmount"].text()
        val paisa = tranAmount.toDoubleOrNull()?.takeIf { it.isFinite() }?.let { (it * 100).roundToLong() }
        if (tranAmount.isNotEmpty() && paisa != amountPaisa) {
            throw PaymentException("IME Pay: amount mismatch ($tranAmount)")
        }
        if (code != "0") {
            // Only 0 has one meaning across sources. 1 reads as failed in one library and pending in another,
            // so every other code stays pending and the reconcile job keeps asking.
            return Outcome("pending")
        }
        if (tranAmount.isEmpty()) throw PaymentException("IME Pay: Recheck says paid but has no TranAmount")
        return Outcome("paid", res["TransactionId"].text().ifEmpty { null })
    }
}`,
    },
  },
};

// Checkout payload vectors. IME Pay publishes none, so these are mine: the base64 comes from
// `openssl base64 -A` and matches every language's checkoutData().
export const vectors: { values: string[]; payload: string; data: string; urlData: string }[] = [
  { values: ["TKN123", "DEMOMERCHANT", "A1", "100.00", "POST", "https://shop.example.com/r/A1", "https://shop.example.com/r/A1"], payload: "TKN123|DEMOMERCHANT|A1|100.00|POST|https://shop.example.com/r/A1|https://shop.example.com/r/A1", data: "VEtOMTIzfERFTU9NRVJDSEFOVHxBMXwxMDAuMDB8UE9TVHxodHRwczovL3Nob3AuZXhhbXBsZS5jb20vci9BMXxodHRwczovL3Nob3AuZXhhbXBsZS5jb20vci9BMQ==", urlData: "VEtOMTIzfERFTU9NRVJDSEFOVHxBMXwxMDAuMDB8UE9TVHxodHRwczovL3Nob3AuZXhhbXBsZS5jb20vci9BMXxodHRwczovL3Nob3AuZXhhbXBsZS5jb20vci9BMQ%3D%3D" },
  { values: ["TKN123", "DEMOMERCHANT", "3f9c0a7e1b2d4c5e6f70", "100.50", "POST", "http://localhost:3000/pay/return/3f9c0a7e1b2d4c5e6f70", "http://localhost:3000/pay/return/3f9c0a7e1b2d4c5e6f70"], payload: "TKN123|DEMOMERCHANT|3f9c0a7e1b2d4c5e6f70|100.50|POST|http://localhost:3000/pay/return/3f9c0a7e1b2d4c5e6f70|http://localhost:3000/pay/return/3f9c0a7e1b2d4c5e6f70", data: "VEtOMTIzfERFTU9NRVJDSEFOVHwzZjljMGE3ZTFiMmQ0YzVlNmY3MHwxMDAuNTB8UE9TVHxodHRwOi8vbG9jYWxob3N0OjMwMDAvcGF5L3JldHVybi8zZjljMGE3ZTFiMmQ0YzVlNmY3MHxodHRwOi8vbG9jYWxob3N0OjMwMDAvcGF5L3JldHVybi8zZjljMGE3ZTFiMmQ0YzVlNmY3MA==", urlData: "VEtOMTIzfERFTU9NRVJDSEFOVHwzZjljMGE3ZTFiMmQ0YzVlNmY3MHwxMDAuNTB8UE9TVHxodHRwOi8vbG9jYWxob3N0OjMwMDAvcGF5L3JldHVybi8zZjljMGE3ZTFiMmQ0YzVlNmY3MHxodHRwOi8vbG9jYWxob3N0OjMwMDAvcGF5L3JldHVybi8zZjljMGE3ZTFiMmQ0YzVlNmY3MA%3D%3D" },
];

export default imepay;

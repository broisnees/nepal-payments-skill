// Generated Khalti KPG-2 gateway module, one per language.
// The parts joined with "\n\n" in order (config, http, start, confirm) form the complete file.

export interface GatewayCode {
  file: string;
  lang: string;
  parts: { config: string; http: string; start: string; confirm: string };
}

export const khalti: Record<"ts" | "python" | "php" | "go" | "java" | "kotlin", GatewayCode> = {
  ts: {
    file: "khalti.ts",
    lang: "typescript",
    parts: {
      config: `import { PaymentError, type ConfirmInput, type Outcome, type PaymentStatus, type Start, type StartInput } from "./payments";

// Khalti KPG-2 (web checkout). Sandbox unless KHALTI_ENV=production.
const PRODUCTION = process.env.KHALTI_ENV === "production";

// Both endpoints need the trailing slash. Without it Khalti answers 301, and most HTTP
// clients follow that as a GET with no body, which comes back as confusing validation errors.
const API = PRODUCTION ? "https://khalti.com/api/v2" : "https://dev.khalti.com/api/v2";
const INITIATE_URL = \`\${API}/epayment/initiate/\`;
const LOOKUP_URL = \`\${API}/epayment/lookup/\`;

// The "live secret key" from your dashboard: test-admin.khalti.com for the sandbox, admin.khalti.com
// for production. Khalti publishes no shared test key, so both environments need your own.
// A pasted "Key " prefix is stripped, since the header adds it.
const SECRET_KEY = (process.env.KHALTI_SECRET_KEY ?? "").trim().replace(/^key\\s+/i, "");
if (!SECRET_KEY) throw new Error("Set KHALTI_SECRET_KEY");`,
      http: `// POSTs JSON with the secret key and returns the HTTP status with the parsed body.
// The header is "Key <secret>": "Bearer" or a bare key gets 401 "Authentication credentials were not provided."
// The body is read on every status, because lookup reports Expired and User canceled as HTTP 400.
async function postJson(url: string, payload: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: \`Key \${SECRET_KEY}\`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15_000),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}`,
      start: `// Asks Khalti for a payment page and returns a redirect to it. The pidx comes back as providerRef and
// the route stores it: lookup only accepts pidx, there is no lookup by your order id.
export async function startPayment(input: StartInput): Promise<Start> {
  const { status, body } = await postJson(INITIATE_URL, {
    return_url: input.returnUrl, // Khalti sends the buyer here with GET and adds ?pidx=...&status=...
    website_url: new URL(input.returnUrl).origin,
    amount: input.amountPaisa, // integer paisa as a JSON number. Minimum 1000 (Rs 10)
    purchase_order_id: input.attemptId, // unique per attempt
    purchase_order_name: input.description,
  });
  if (status !== 200 || typeof body?.pidx !== "string" || typeof body.payment_url !== "string") {
    // Initiate has no idempotency key, so never retry it. The buyer clicks Pay again and gets a new attempt.
    throw new Error(\`Khalti initiate failed: HTTP \${status} \${JSON.stringify(body)}\`);
  }
  return { type: "redirect", url: body.payment_url, providerRef: body.pidx };
}`,
      confirm: `// Khalti lookup status -> our status. Compared in lower case: the docs write both
// "Partially Refunded" and "Partially refunded".
const STATUSES: Record<string, PaymentStatus> = {
  completed: "paid",
  pending: "pending", // not final; sandbox payments sometimes stay here
  initiated: "pending", // payment page opened, nothing paid yet
  refunded: "refunded",
  "partially refunded": "partially_refunded",
  expired: "expired", // link expired unpaid (HTTP 400)
  "user canceled": "canceled", // buyer canceled on Khalti (HTTP 400)
};

// Called from the return route (params = query + body) and from the reconcile job (params = {}).
export async function confirmPayment(input: ConfirmInput): Promise<Outcome> {
  // The return URL's query is not proof of anything. It only gets checked against what we stored,
  // so a pidx or order id from another payment is refused before any lookup.
  const p = input.params;
  if ((p.pidx && p.pidx !== input.providerRef) || (p.purchase_order_id && p.purchase_order_id !== input.attemptId)) {
    throw new PaymentError("Khalti: callback is for a different payment");
  }
  // No stored pidx means initiate never succeeded, so Khalti has nothing to look up.
  if (!input.providerRef) return { status: "not_found" };

  // Lookup with the STORED pidx is the real answer. Its response has no purchase_order_id,
  // so a pidx taken from the URL could belong to another, cheaper payment.
  const { status, body } = await postJson(LOOKUP_URL, { pidx: input.providerRef });
  if (typeof body?.status === "string") {
    const key = body.status.toLowerCase();
    // Unknown values count as pending, so the reconcile job keeps asking.
    const ours = Object.hasOwn(STATUSES, key) ? STATUSES[key] : "pending";
    if (ours === "paid" && body.total_amount !== input.amountPaisa) {
      throw new PaymentError(\`Khalti: amount mismatch (\${body.total_amount})\`);
    }
    // transaction_id is what Khalti's refund API takes.
    return { status: ours, providerRef: body.transaction_id || undefined };
  }
  // {"detail": "Not found."}: unknown pidx, or a pidx from the other environment.
  if (status === 404 || body?.detail === "Not found.") return { status: "not_found" };
  // 401, 5xx, an HTML error page: not an answer. The route answers 502 and the reconcile job retries.
  throw new Error(\`Khalti lookup failed: HTTP \${status} \${JSON.stringify(body)}\`);
}`,
    },
  },
  python: {
    file: "khalti.py",
    lang: "python",
    parts: {
      config: `import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request

from payments import Outcome, PaymentError, Start

# Khalti KPG-2 (web checkout). Sandbox unless KHALTI_ENV=production.
PRODUCTION = os.environ.get("KHALTI_ENV") == "production"

# Both endpoints need the trailing slash. Without it Khalti answers 301, and most HTTP
# clients follow that as a GET with no body, which comes back as confusing validation errors.
API = "https://khalti.com/api/v2" if PRODUCTION else "https://dev.khalti.com/api/v2"
INITIATE_URL = f"{API}/epayment/initiate/"
LOOKUP_URL = f"{API}/epayment/lookup/"

# The "live secret key" from your dashboard: test-admin.khalti.com for the sandbox, admin.khalti.com
# for production. Khalti publishes no shared test key, so both environments need your own.
# A pasted "Key " prefix is stripped, since the header adds it.
SECRET_KEY = re.sub(r"^key\\s+", "", os.environ.get("KHALTI_SECRET_KEY", "").strip(), flags=re.I)
if not SECRET_KEY:
    raise RuntimeError("Set KHALTI_SECRET_KEY")`,
      http: `def _post_json(url: str, payload: dict) -> tuple[int, dict | None]:
    """POSTs JSON with the secret key and returns the HTTP status with the parsed body.
    The header is "Key <secret>": "Bearer" or a bare key gets 401 "Authentication credentials were not provided."
    The body is read on every status, because lookup reports Expired and User canceled as HTTP 400."""
    req = urllib.request.Request(url, data=json.dumps(payload).encode(), method="POST", headers={
        "Authorization": f"Key {SECRET_KEY}",
        "Content-Type": "application/json",
    })
    try:
        with urllib.request.urlopen(req, timeout=15) as res:
            status, raw = res.status, res.read()
    except urllib.error.HTTPError as e:  # 4xx and 5xx land here, body included
        status, raw = e.code, e.read()
    try:
        body = json.loads(raw)
    except ValueError:
        body = None
    return status, body if isinstance(body, dict) else None`,
      start: `def start_payment(attempt_id: str, amount_paisa: int, return_url: str, description: str) -> Start:
    """Asks Khalti for a payment page and returns a redirect to it. The pidx comes back as provider_ref and
    the route stores it: lookup only accepts pidx, there is no lookup by your order id."""
    url = urllib.parse.urlsplit(return_url)
    status, body = _post_json(INITIATE_URL, {
        "return_url": return_url,  # Khalti sends the buyer here with GET and adds ?pidx=...&status=...
        "website_url": f"{url.scheme}://{url.netloc}",
        "amount": amount_paisa,  # integer paisa as a JSON number. Minimum 1000 (Rs 10)
        "purchase_order_id": attempt_id,  # unique per attempt
        "purchase_order_name": description,
    })
    if status != 200 or not body or not isinstance(body.get("pidx"), str) or not isinstance(body.get("payment_url"), str):
        # Initiate has no idempotency key, so never retry it. The buyer clicks Pay again and gets a new attempt.
        raise RuntimeError(f"Khalti initiate failed: HTTP {status} {body}")
    return Start(type="redirect", url=body["payment_url"], provider_ref=body["pidx"])`,
      confirm: `# Khalti lookup status -> our status. Compared in lower case: the docs write both
# "Partially Refunded" and "Partially refunded".
STATUSES = {
    "completed": "paid",
    "pending": "pending",  # not final; sandbox payments sometimes stay here
    "initiated": "pending",  # payment page opened, nothing paid yet
    "refunded": "refunded",
    "partially refunded": "partially_refunded",
    "expired": "expired",  # link expired unpaid (HTTP 400)
    "user canceled": "canceled",  # buyer canceled on Khalti (HTTP 400)
}


def confirm_payment(attempt_id: str, amount_paisa: int, provider_ref: str | None, params: dict[str, str]) -> Outcome:
    """Called from the return route (params = query + body) and from the reconcile job (params = {})."""
    # The return URL's query is not proof of anything. It only gets checked against what we stored,
    # so a pidx or order id from another payment is refused before any lookup.
    if (params.get("pidx") and params["pidx"] != provider_ref) or \\
            (params.get("purchase_order_id") and params["purchase_order_id"] != attempt_id):
        raise PaymentError("Khalti: callback is for a different payment")
    # No stored pidx means initiate never succeeded, so Khalti has nothing to look up.
    if not provider_ref:
        return Outcome(status="not_found")

    # Lookup with the STORED pidx is the real answer. Its response has no purchase_order_id,
    # so a pidx taken from the URL could belong to another, cheaper payment.
    status, body = _post_json(LOOKUP_URL, {"pidx": provider_ref})
    if body and isinstance(body.get("status"), str):
        # Unknown values count as pending, so the reconcile job keeps asking.
        ours = STATUSES.get(body["status"].lower(), "pending")
        total = body.get("total_amount")
        if ours == "paid" and (type(total) is not int or total != amount_paisa):
            raise PaymentError(f"Khalti: amount mismatch ({total})")
        # transaction_id is what Khalti's refund API takes.
        return Outcome(status=ours, provider_ref=body.get("transaction_id") or None)
    # {"detail": "Not found."}: unknown pidx, or a pidx from the other environment.
    if status == 404 or (body and body.get("detail") == "Not found."):
        return Outcome(status="not_found")
    # 401, 5xx, an HTML error page: not an answer. The route answers 502 and the reconcile job retries.
    raise RuntimeError(f"Khalti lookup failed: HTTP {status} {body}")`,
    },
  },
  php: {
    file: "KhaltiGateway.php",
    lang: "php",
    parts: {
      config: `<?php

declare(strict_types=1);

namespace App\\Payments;

// Khalti KPG-2 (web checkout). Sandbox unless KHALTI_ENV=production.
final class KhaltiGateway implements Gateway
{
    public function __construct(
        private string $secretKey,
        private string $apiUrl,
    ) {
        // A pasted "Key " prefix is stripped, since the header adds it.
        $this->secretKey = (string) preg_replace('/^key\\s+/i', '', trim($secretKey));
        if ($this->secretKey === '') {
            throw new \\RuntimeException('Set KHALTI_SECRET_KEY');
        }
    }

    public static function fromEnv(): self
    {
        $env = static fn (string $name) => $_ENV[$name] ?? (getenv($name) !== false ? getenv($name) : null);
        // The "live secret key" from your dashboard: test-admin.khalti.com for the sandbox, admin.khalti.com
        // for production. Khalti publishes no shared test key, so both environments need your own.
        return new self(
            (string) $env('KHALTI_SECRET_KEY'),
            $env('KHALTI_ENV') === 'production' ? 'https://khalti.com/api/v2' : 'https://dev.khalti.com/api/v2',
        );
    }`,
      http: `    // POSTs JSON with the secret key and returns [HTTP status, parsed body or null].
    // The header is "Key <secret>": "Bearer" or a bare key gets 401 "Authentication credentials were not provided."
    // The body is read on every status, because lookup reports Expired and User canceled as HTTP 400.
    // Both paths need the trailing slash: without it Khalti answers 301 and the POST body is lost.
    private function postJson(string $path, array $payload): array
    {
        $ch = curl_init($this->apiUrl . $path);
        curl_setopt_array($ch, [
            CURLOPT_POST => true,
            CURLOPT_POSTFIELDS => json_encode($payload),
            CURLOPT_HTTPHEADER => ['Authorization: Key ' . $this->secretKey, 'Content-Type: application/json'],
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT => 15,
        ]);
        $raw = curl_exec($ch);
        $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        if (!is_string($raw)) {
            throw new \\RuntimeException('Khalti request failed: ' . curl_error($ch));
        }
        $body = json_decode($raw, true);
        return [$code, is_array($body) ? $body : null];
    }`,
      start: `    // Asks Khalti for a payment page and returns a redirect to it. The pidx comes back as providerRef and
    // the route stores it: lookup only accepts pidx, there is no lookup by your order id.
    public function startPayment(string $attemptId, int $amountPaisa, string $returnUrl, string $description): Start
    {
        $url = parse_url($returnUrl);
        [$code, $body] = $this->postJson('/epayment/initiate/', [
            'return_url' => $returnUrl, // Khalti sends the buyer here with GET and adds ?pidx=...&status=...
            'website_url' => $url['scheme'] . '://' . $url['host'] . (isset($url['port']) ? ':' . $url['port'] : ''),
            'amount' => $amountPaisa, // integer paisa as a JSON number. Minimum 1000 (Rs 10)
            'purchase_order_id' => $attemptId, // unique per attempt
            'purchase_order_name' => $description,
        ]);
        if ($code !== 200 || !is_string($body['pidx'] ?? null) || !is_string($body['payment_url'] ?? null)) {
            // Initiate has no idempotency key, so never retry it. The buyer clicks Pay again and gets a new attempt.
            throw new \\RuntimeException("Khalti initiate failed: HTTP $code " . json_encode($body));
        }
        return Start::redirect($body['payment_url'], $body['pidx']);
    }`,
      confirm: `    // Khalti lookup status -> our status. Compared in lower case: the docs write both
    // "Partially Refunded" and "Partially refunded".
    private const STATUSES = [
        'completed' => 'paid',
        'pending' => 'pending', // not final; sandbox payments sometimes stay here
        'initiated' => 'pending', // payment page opened, nothing paid yet
        'refunded' => 'refunded',
        'partially refunded' => 'partially_refunded',
        'expired' => 'expired', // link expired unpaid (HTTP 400)
        'user canceled' => 'canceled', // buyer canceled on Khalti (HTTP 400)
    ];

    // Called from the return route (params = query + body) and from the reconcile job (params = []).
    public function confirmPayment(string $attemptId, int $amountPaisa, ?string $providerRef, array $params): Outcome
    {
        // The return URL's query is not proof of anything. It only gets checked against what we stored,
        // so a pidx or order id from another payment is refused before any lookup.
        $pidx = (string) ($params['pidx'] ?? '');
        $orderId = (string) ($params['purchase_order_id'] ?? '');
        if (($pidx !== '' && $pidx !== $providerRef) || ($orderId !== '' && $orderId !== $attemptId)) {
            throw new PaymentError('Khalti: callback is for a different payment');
        }
        // No stored pidx means initiate never succeeded, so Khalti has nothing to look up.
        if ($providerRef === null || $providerRef === '') {
            return new Outcome('not_found', null);
        }

        // Lookup with the STORED pidx is the real answer. Its response has no purchase_order_id,
        // so a pidx taken from the URL could belong to another, cheaper payment.
        [$code, $body] = $this->postJson('/epayment/lookup/', ['pidx' => $providerRef]);
        if (is_string($body['status'] ?? null)) {
            // Unknown values count as pending, so the reconcile job keeps asking.
            $ours = self::STATUSES[strtolower($body['status'])] ?? 'pending';
            if ($ours === 'paid' && ($body['total_amount'] ?? null) !== $amountPaisa) {
                throw new PaymentError('Khalti: amount mismatch (' . json_encode($body['total_amount'] ?? null) . ')');
            }
            // transaction_id is what Khalti's refund API takes.
            return new Outcome($ours, is_string($body['transaction_id'] ?? null) && $body['transaction_id'] !== '' ? $body['transaction_id'] : null);
        }
        // {"detail": "Not found."}: unknown pidx, or a pidx from the other environment.
        if ($code === 404 || ($body['detail'] ?? null) === 'Not found.') {
            return new Outcome('not_found', null);
        }
        // 401, 5xx, an HTML error page: not an answer. The route answers 502 and the reconcile job retries.
        throw new \\RuntimeException("Khalti lookup failed: HTTP $code " . json_encode($body));
    }
}`,
    },
  },
  go: {
    file: "payments/khalti.go",
    lang: "go",
    parts: {
      config: `package payments

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strings"
	"time"
)

// Khalti is the Khalti KPG-2 (web checkout) gateway. Sandbox unless KHALTI_ENV=production.
type Khalti struct {
	secretKey, apiURL string
	client            *http.Client
}

func NewKhalti() *Khalti {
	k := &Khalti{
		// The "live secret key" from your dashboard: test-admin.khalti.com for the sandbox, admin.khalti.com
		// for production. Khalti publishes no shared test key, so both environments need your own.
		// A pasted "Key " prefix is stripped, since the header adds it.
		secretKey: regexp.MustCompile(\`(?i)^key\\s+\`).ReplaceAllString(strings.TrimSpace(os.Getenv("KHALTI_SECRET_KEY")), ""),
		apiURL:    "https://dev.khalti.com/api/v2",
		client:    &http.Client{Timeout: 15 * time.Second},
	}
	if os.Getenv("KHALTI_ENV") == "production" {
		k.apiURL = "https://khalti.com/api/v2"
	}
	if k.secretKey == "" {
		panic("set KHALTI_SECRET_KEY")
	}
	return k
}`,
      http: `// postJSON POSTs JSON with the secret key and returns the HTTP status with the raw body.
// The header is "Key <secret>": "Bearer" or a bare key gets 401 "Authentication credentials were not provided."
// The body is returned on every status, because lookup reports Expired and User canceled as HTTP 400.
// Both paths need the trailing slash: without it Khalti answers 301 and Go resends the POST as a GET with no body.
func (k *Khalti) postJSON(ctx context.Context, path string, payload any) (int, []byte, error) {
	data, err := json.Marshal(payload)
	if err != nil {
		return 0, nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, k.apiURL+path, bytes.NewReader(data))
	if err != nil {
		return 0, nil, err
	}
	req.Header.Set("Authorization", "Key "+k.secretKey)
	req.Header.Set("Content-Type", "application/json")
	res, err := k.client.Do(req)
	if err != nil {
		return 0, nil, fmt.Errorf("khalti request failed: %w", err)
	}
	defer res.Body.Close()
	body, err := io.ReadAll(res.Body)
	return res.StatusCode, body, err
}`,
      start: `// StartPayment asks Khalti for a payment page and returns a redirect to it. The pidx comes back as
// ProviderRef and the route stores it: lookup only accepts pidx, there is no lookup by your order id.
func (k *Khalti) StartPayment(ctx context.Context, in StartInput) (Start, error) {
	u, err := url.Parse(in.ReturnURL)
	if err != nil {
		return Start{}, err
	}
	status, raw, err := k.postJSON(ctx, "/epayment/initiate/", map[string]any{
		"return_url":          in.ReturnURL, // Khalti sends the buyer here with GET and adds ?pidx=...&status=...
		"website_url":         u.Scheme + "://" + u.Host,
		"amount":              in.AmountPaisa, // integer paisa as a JSON number. Minimum 1000 (Rs 10)
		"purchase_order_id":   in.AttemptID,   // unique per attempt
		"purchase_order_name": in.Description,
	})
	if err != nil {
		return Start{}, err
	}
	var body struct {
		Pidx       string \`json:"pidx"\`
		PaymentURL string \`json:"payment_url"\`
	}
	if json.Unmarshal(raw, &body) != nil || status != http.StatusOK || body.Pidx == "" || body.PaymentURL == "" {
		// Initiate has no idempotency key, so never retry it. The buyer clicks Pay again and gets a new attempt.
		return Start{}, fmt.Errorf("khalti initiate failed: HTTP %d %s", status, raw)
	}
	return Start{Type: "redirect", URL: body.PaymentURL, ProviderRef: body.Pidx}, nil
}`,
      confirm: `// khaltiStatuses maps Khalti's lookup status to ours. Compared in lower case: the docs write both
// "Partially Refunded" and "Partially refunded".
var khaltiStatuses = map[string]string{
	"completed":          "paid",
	"pending":            "pending", // not final; sandbox payments sometimes stay here
	"initiated":          "pending", // payment page opened, nothing paid yet
	"refunded":           "refunded",
	"partially refunded": "partially_refunded",
	"expired":            "expired",   // link expired unpaid (HTTP 400)
	"user canceled":      "canceled", // buyer canceled on Khalti (HTTP 400)
}

// ConfirmPayment is called from the return route (Params = query + body) and from the reconcile job (empty Params).
func (k *Khalti) ConfirmPayment(ctx context.Context, in ConfirmInput) (Outcome, error) {
	// The return URL's query is not proof of anything. It only gets checked against what we stored,
	// so a pidx or order id from another payment is refused before any lookup.
	pidx, orderID := in.Params["pidx"], in.Params["purchase_order_id"]
	if (pidx != "" && pidx != in.ProviderRef) || (orderID != "" && orderID != in.AttemptID) {
		return Outcome{}, fmt.Errorf("%w: Khalti callback is for a different payment", ErrPayment)
	}
	// No stored pidx means initiate never succeeded, so Khalti has nothing to look up.
	if in.ProviderRef == "" {
		return Outcome{Status: "not_found"}, nil
	}

	// Lookup with the STORED pidx is the real answer. Its response has no purchase_order_id,
	// so a pidx taken from the URL could belong to another, cheaper payment.
	status, raw, err := k.postJSON(ctx, "/epayment/lookup/", map[string]string{"pidx": in.ProviderRef})
	if err != nil {
		return Outcome{}, err
	}
	var body struct {
		Status        *string \`json:"status"\`
		TotalAmount   *int64  \`json:"total_amount"\`
		TransactionID *string \`json:"transaction_id"\`
		Detail        string  \`json:"detail"\`
	}
	parsed := json.Unmarshal(raw, &body) == nil
	if parsed && body.Status != nil {
		ours, ok := khaltiStatuses[strings.ToLower(*body.Status)]
		if !ok {
			ours = "pending" // unknown values count as pending, so the reconcile job keeps asking
		}
		if ours == "paid" && (body.TotalAmount == nil || *body.TotalAmount != in.AmountPaisa) {
			return Outcome{}, fmt.Errorf("%w: Khalti amount mismatch", ErrPayment)
		}
		out := Outcome{Status: ours}
		if body.TransactionID != nil {
			out.ProviderRef = *body.TransactionID // what Khalti's refund API takes
		}
		return out, nil
	}
	// {"detail": "Not found."}: unknown pidx, or a pidx from the other environment.
	if status == http.StatusNotFound || (parsed && body.Detail == "Not found.") {
		return Outcome{Status: "not_found"}, nil
	}
	// 401, 5xx, an HTML error page: not an answer. The route answers 502 and the reconcile job retries.
	return Outcome{}, fmt.Errorf("khalti lookup failed: HTTP %d %s", status, raw)
}`,
    },
  },
  java: {
    file: "src/main/java/payments/KhaltiGateway.java",
    lang: "java",
    parts: {
      config: `package payments;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.Locale;
import java.util.Map;

// Khalti KPG-2 (web checkout). Sandbox unless KHALTI_ENV=production.
public final class KhaltiGateway implements Gateway {
    private static final ObjectMapper JSON = new ObjectMapper();
    private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build();
    private final String secretKey, apiUrl;

    public KhaltiGateway(String secretKey, String apiUrl) {
        // A pasted "Key " prefix is stripped, since the header adds it.
        this.secretKey = secretKey.trim().replaceFirst("(?i)^key\\\\s+", "");
        this.apiUrl = apiUrl;
        if (this.secretKey.isEmpty()) throw new IllegalStateException("Set KHALTI_SECRET_KEY");
    }

    public static KhaltiGateway fromEnv() {
        // The "live secret key" from your dashboard: test-admin.khalti.com for the sandbox, admin.khalti.com
        // for production. Khalti publishes no shared test key, so both environments need your own.
        String secretKey = System.getenv("KHALTI_SECRET_KEY");
        boolean production = "production".equals(System.getenv("KHALTI_ENV"));
        return new KhaltiGateway(secretKey == null ? "" : secretKey,
            production ? "https://khalti.com/api/v2" : "https://dev.khalti.com/api/v2");
    }`,
      http: `    private record Reply(int status, JsonNode body) {}

    // POSTs JSON with the secret key and returns the HTTP status with the parsed body (null if not JSON).
    // The header is "Key <secret>": "Bearer" or a bare key gets 401 "Authentication credentials were not provided."
    // The body is read on every status, because lookup reports Expired and User canceled as HTTP 400.
    // Both paths need the trailing slash: without it Khalti answers 301 and the POST body is lost.
    private Reply postJson(String path, Map<String, Object> payload) {
        try {
            HttpRequest request = HttpRequest.newBuilder(URI.create(apiUrl + path))
                .timeout(Duration.ofSeconds(15))
                .header("Authorization", "Key " + secretKey)
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
            return new Reply(res.statusCode(), body != null && body.isObject() ? body : null);
        } catch (IOException e) {
            throw new IllegalStateException("Khalti request failed: " + e.getMessage(), e);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("Khalti request interrupted", e);
        }
    }`,
      start: `    // Asks Khalti for a payment page and returns a redirect to it. The pidx comes back as providerRef and
    // the route stores it: lookup only accepts pidx, there is no lookup by your order id.
    @Override
    public Start startPayment(String attemptId, long amountPaisa, String returnUrl, String description) {
        URI url = URI.create(returnUrl);
        Reply reply = postJson("/epayment/initiate/", Map.of(
            "return_url", returnUrl, // Khalti sends the buyer here with GET and adds ?pidx=...&status=...
            "website_url", url.getScheme() + "://" + url.getRawAuthority(),
            "amount", amountPaisa, // integer paisa as a JSON number. Minimum 1000 (Rs 10)
            "purchase_order_id", attemptId, // unique per attempt
            "purchase_order_name", description));
        JsonNode body = reply.body();
        if (reply.status() != 200 || body == null || !body.path("pidx").isTextual() || !body.path("payment_url").isTextual()) {
            // Initiate has no idempotency key, so never retry it. The buyer clicks Pay again and gets a new attempt.
            throw new IllegalStateException("Khalti initiate failed: HTTP " + reply.status() + " " + body);
        }
        return new Start.Redirect(body.get("payment_url").asText(), body.get("pidx").asText());
    }`,
      confirm: `    // Khalti lookup status -> our status. Compared in lower case: the docs write both
    // "Partially Refunded" and "Partially refunded".
    private static final Map<String, String> STATUSES = Map.of(
        "completed", "paid",
        "pending", "pending", // not final; sandbox payments sometimes stay here
        "initiated", "pending", // payment page opened, nothing paid yet
        "refunded", "refunded",
        "partially refunded", "partially_refunded",
        "expired", "expired", // link expired unpaid (HTTP 400)
        "user canceled", "canceled"); // buyer canceled on Khalti (HTTP 400)

    // Called from the return route (params = query + body) and from the reconcile job (empty params).
    @Override
    public Outcome confirmPayment(String attemptId, long amountPaisa, String providerRef, Map<String, String> params) {
        // The return URL's query is not proof of anything. It only gets checked against what we stored,
        // so a pidx or order id from another payment is refused before any lookup.
        String pidx = params.getOrDefault("pidx", "");
        String orderId = params.getOrDefault("purchase_order_id", "");
        if ((!pidx.isEmpty() && !pidx.equals(providerRef)) || (!orderId.isEmpty() && !orderId.equals(attemptId))) {
            throw new PaymentException("Khalti: callback is for a different payment");
        }
        // No stored pidx means initiate never succeeded, so Khalti has nothing to look up.
        if (providerRef == null || providerRef.isEmpty()) return new Outcome("not_found", null);

        // Lookup with the STORED pidx is the real answer. Its response has no purchase_order_id,
        // so a pidx taken from the URL could belong to another, cheaper payment.
        Reply reply = postJson("/epayment/lookup/", Map.of("pidx", providerRef));
        JsonNode body = reply.body();
        if (body != null && body.path("status").isTextual()) {
            // Unknown values count as pending, so the reconcile job keeps asking.
            String ours = STATUSES.getOrDefault(body.get("status").asText().toLowerCase(Locale.ROOT), "pending");
            JsonNode total = body.path("total_amount");
            if (ours.equals("paid") && !(total.isIntegralNumber() && total.asLong() == amountPaisa)) {
                throw new PaymentException("Khalti: amount mismatch (" + total + ")");
            }
            // transaction_id is what Khalti's refund API takes.
            String txn = body.path("transaction_id").isTextual() ? body.get("transaction_id").asText() : null;
            return new Outcome(ours, txn == null || txn.isEmpty() ? null : txn);
        }
        // {"detail": "Not found."}: unknown pidx, or a pidx from the other environment.
        if (reply.status() == 404 || (body != null && "Not found.".equals(body.path("detail").asText()))) {
            return new Outcome("not_found", null);
        }
        // 401, 5xx, an HTML error page: not an answer. The route answers 502 and the reconcile job retries.
        throw new IllegalStateException("Khalti lookup failed: HTTP " + reply.status() + " " + body);
    }
}`,
    },
  },
  kotlin: {
    file: "src/main/kotlin/payments/KhaltiGateway.kt",
    lang: "kotlin",
    parts: {
      config: `package payments

import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put

// Khalti KPG-2 (web checkout). Sandbox unless KHALTI_ENV=production.
class KhaltiGateway(secretKey: String, private val apiUrl: String) : Gateway {
    // A pasted "Key " prefix is stripped, since the header adds it.
    private val secretKey = secretKey.trim().replaceFirst(Regex("^key\\\\s+", RegexOption.IGNORE_CASE), "")
    private val http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build()

    init {
        check(this.secretKey.isNotEmpty()) { "Set KHALTI_SECRET_KEY" }
    }

    companion object {
        // The "live secret key" from your dashboard: test-admin.khalti.com for the sandbox, admin.khalti.com
        // for production. Khalti publishes no shared test key, so both environments need your own.
        fun fromEnv(): KhaltiGateway = KhaltiGateway(
            System.getenv("KHALTI_SECRET_KEY") ?: "",
            if (System.getenv("KHALTI_ENV") == "production") "https://khalti.com/api/v2" else "https://dev.khalti.com/api/v2",
        )
    }`,
      http: `    // POSTs JSON with the secret key and returns the HTTP status with the parsed body (null if not JSON).
    // The header is "Key <secret>": "Bearer" or a bare key gets 401 "Authentication credentials were not provided."
    // The body is read on every status, because lookup reports Expired and User canceled as HTTP 400.
    // Both paths need the trailing slash: without it Khalti answers 301 and the POST body is lost.
    private suspend fun postJson(path: String, payload: JsonObject): Pair<Int, JsonObject?> {
        val request = HttpRequest.newBuilder(URI.create(apiUrl + path))
            .timeout(Duration.ofSeconds(15))
            .header("Authorization", "Key $secretKey")
            .header("Content-Type", "application/json")
            .POST(HttpRequest.BodyPublishers.ofString(payload.toString()))
            .build()
        val res = withContext(Dispatchers.IO) { http.send(request, HttpResponse.BodyHandlers.ofString()) }
        return res.statusCode() to runCatching { Json.parseToJsonElement(res.body()) as JsonObject }.getOrNull()
    }

    // A JSON string or number as text, null for missing or null.
    private fun JsonElement?.text(): String? = (this as? JsonPrimitive)?.takeIf { it !is JsonNull }?.content`,
      start: `    // Asks Khalti for a payment page and returns a redirect to it. The pidx comes back as providerRef and
    // the route stores it: lookup only accepts pidx, there is no lookup by your order id.
    override suspend fun startPayment(attemptId: String, amountPaisa: Long, returnUrl: String, description: String): Start {
        val url = URI.create(returnUrl)
        val (status, body) = postJson("/epayment/initiate/", buildJsonObject {
            put("return_url", returnUrl) // Khalti sends the buyer here with GET and adds ?pidx=...&status=...
            put("website_url", "\${url.scheme}://\${url.rawAuthority}")
            put("amount", amountPaisa) // integer paisa as a JSON number. Minimum 1000 (Rs 10)
            put("purchase_order_id", attemptId) // unique per attempt
            put("purchase_order_name", description)
        })
        val pidx = body?.get("pidx").text()
        val paymentUrl = body?.get("payment_url").text()
        if (status != 200 || pidx == null || paymentUrl == null) {
            // Initiate has no idempotency key, so never retry it. The buyer clicks Pay again and gets a new attempt.
            throw IllegalStateException("Khalti initiate failed: HTTP $status $body")
        }
        return Start.Redirect(paymentUrl, pidx)
    }`,
      confirm: `    // Khalti lookup status -> our status. Compared in lower case: the docs write both
    // "Partially Refunded" and "Partially refunded".
    private val statuses = mapOf(
        "completed" to "paid",
        "pending" to "pending", // not final; sandbox payments sometimes stay here
        "initiated" to "pending", // payment page opened, nothing paid yet
        "refunded" to "refunded",
        "partially refunded" to "partially_refunded",
        "expired" to "expired", // link expired unpaid (HTTP 400)
        "user canceled" to "canceled", // buyer canceled on Khalti (HTTP 400)
    )

    // Called from the return route (params = query + body) and from the reconcile job (empty params).
    override suspend fun confirmPayment(attemptId: String, amountPaisa: Long, providerRef: String?, params: Map<String, String>): Outcome {
        // The return URL's query is not proof of anything. It only gets checked against what we stored,
        // so a pidx or order id from another payment is refused before any lookup.
        val pidx = params["pidx"].orEmpty()
        val orderId = params["purchase_order_id"].orEmpty()
        if ((pidx.isNotEmpty() && pidx != providerRef) || (orderId.isNotEmpty() && orderId != attemptId)) {
            throw PaymentException("Khalti: callback is for a different payment")
        }
        // No stored pidx means initiate never succeeded, so Khalti has nothing to look up.
        if (providerRef.isNullOrEmpty()) return Outcome("not_found")

        // Lookup with the STORED pidx is the real answer. Its response has no purchase_order_id,
        // so a pidx taken from the URL could belong to another, cheaper payment.
        val (status, body) = postJson("/epayment/lookup/", buildJsonObject { put("pidx", providerRef) })
        val khaltiStatus = (body?.get("status") as? JsonPrimitive)?.takeIf { it.isString }?.content
        if (body != null && khaltiStatus != null) {
            // Unknown values count as pending, so the reconcile job keeps asking.
            val ours = statuses[khaltiStatus.lowercase()] ?: "pending"
            val total = (body["total_amount"] as? JsonPrimitive)?.takeIf { !it.isString }?.longOrNull
            if (ours == "paid" && total != amountPaisa) {
                throw PaymentException("Khalti: amount mismatch (\${body["total_amount"]})")
            }
            // transaction_id is what Khalti's refund API takes.
            return Outcome(ours, body["transaction_id"].text()?.takeIf { it.isNotEmpty() })
        }
        // {"detail": "Not found."}: unknown pidx, or a pidx from the other environment.
        if (status == 404 || body?.get("detail").text() == "Not found.") return Outcome("not_found")
        // 401, 5xx, an HTML error page: not an answer. The route answers 502 and the reconcile job retries.
        throw IllegalStateException("Khalti lookup failed: HTTP $status $body")
    }
}`,
    },
  },
};

export default khalti;

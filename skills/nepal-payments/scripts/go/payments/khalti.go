package payments

// Khalti KPG-2 (Web Checkout / ePayment) — https://docs.khalti.com/khalti-epayment/
//
// Flow: initiate (server, secret key) -> redirect to payment_url -> Khalti GETs return_url
//       -> lookup (server) with the pidx YOU stored -> fulfil only on "Completed".

import (
	"context"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// KhaltiConfig configures the Khalti adapter.
type KhaltiConfig struct {
	// SecretKey is the "live_secret_key" from test-admin.khalti.com (sandbox) or admin.khalti.com.
	SecretKey string
	Env       Env
	// WebsiteURL is your site's public URL (required by Khalti).
	WebsiteURL string
	Timeout    time.Duration // default 15s
	HTTPClient Doer
}

// KhaltiInitiateOptions are Khalti-only initiate fields.
type KhaltiInitiateOptions struct {
	// AmountBreakdown must sum to AmountPaisa or Khalti returns "Amount Breakdown mismatch".
	AmountBreakdown []KhaltiAmountBreakdown
	ProductDetails  []KhaltiProductDetail
	// MerchantExtras keys must start with "merchant_"; they are echoed back in the success payload.
	MerchantExtras map[string]string
}

// KhaltiAmountBreakdown is one amount_breakdown entry (amount in paisa).
type KhaltiAmountBreakdown struct {
	Label  string `json:"label"`
	Amount int64  `json:"amount"`
}

// KhaltiProductDetail is one product_details entry (prices in paisa).
type KhaltiProductDetail struct {
	Identity   string `json:"identity"`
	Name       string `json:"name"`
	TotalPrice int64  `json:"total_price"`
	Quantity   int64  `json:"quantity"`
	UnitPrice  int64  `json:"unit_price"`
}

// KhaltiRefundOptions configures Refund. A nil AmountPaisa is a full refund.
// Mobile is required for payments made via bank/e-banking.
type KhaltiRefundOptions struct {
	AmountPaisa *int64
	Mobile      string
}

var khaltiHosts = map[Env]string{EnvSandbox: "https://dev.khalti.com", EnvProduction: "https://khalti.com"}

var khaltiStatus = map[string]PaymentStatus{
	"completed":          StatusPaid,
	"pending":            StatusPending,
	"initiated":          StatusPending, // user hasn't paid yet; Khalti flips it to Expired after the link expires
	"refunded":           StatusRefunded,
	"partially refunded": StatusPartiallyRefunded,
	"expired":            StatusExpired,
	"user canceled":      StatusCanceled,
	"failed":             StatusFailed,
}

var khaltiKeyPrefix = regexp.MustCompile(`(?i)^key\s+`)

// Khalti is the Khalti KPG-2 adapter.
type Khalti struct {
	cfg     KhaltiConfig
	host    string
	base    string
	auth    string
	timeout time.Duration
	client  Doer
}

var _ Adapter = (*Khalti)(nil)

// NewKhalti builds the Khalti adapter.
func NewKhalti(cfg KhaltiConfig) (*Khalti, error) {
	if cfg.SecretKey == "" {
		return nil, errMissingConfig(ProviderKhalti, "SecretKey")
	}
	host, ok := khaltiHosts[cfg.Env]
	if !ok {
		return nil, errInvalidEnv(ProviderKhalti, cfg.Env)
	}
	return &Khalti{
		cfg:     cfg,
		host:    host,
		base:    host + "/api/v2",
		auth:    "Key " + khaltiKeyPrefix.ReplaceAllString(cfg.SecretKey, ""),
		timeout: durOr(cfg.Timeout, 15*time.Second),
		client:  cfg.HTTPClient,
	}, nil
}

// ID returns ProviderKhalti.
func (k *Khalti) ID() ProviderID { return ProviderKhalti }

// Initiate creates a Khalti payment (integer paisa, minimum 1000) and returns a redirect.
// ProviderRef is the pidx: PERSIST IT — lookup needs it and there is no lookup-by-order-id.
func (k *Khalti) Initiate(ctx context.Context, in InitiateInput) (InitiateResult, error) {
	if err := AssertPaisa(in.AmountPaisa, ProviderKhalti); err != nil {
		return InitiateResult{}, err
	}
	if in.AmountPaisa < 1000 {
		return InitiateResult{}, newPaymentError(ProviderKhalti, "amount_too_low", "Khalti minimum is Rs 10 (1000 paisa)", 0, nil)
	}
	body := jsonObject{
		{"return_url", in.ReturnURL},
		{"website_url", k.cfg.WebsiteURL},
		{"amount", in.AmountPaisa}, // integer paisa
		{"purchase_order_id", in.OrderID},
		{"purchase_order_name", truncateUTF16(in.Description, 255)},
	}
	if in.Customer != nil {
		body = append(body, jsonKV{"customer_info", in.Customer})
	}
	if o := in.Khalti; o != nil {
		if o.AmountBreakdown != nil {
			body = append(body, jsonKV{"amount_breakdown", o.AmountBreakdown})
		}
		if o.ProductDetails != nil {
			body = append(body, jsonKV{"product_details", o.ProductDetails})
		}
		keys := make([]string, 0, len(o.MerchantExtras))
		for key := range o.MerchantExtras {
			if !strings.HasPrefix(key, "merchant_") {
				return InitiateResult{}, newPaymentError(ProviderKhalti, "invalid_merchant_extra", fmt.Sprintf("khalti: merchant extra %q must start with \"merchant_\"", key), 0, nil)
			}
			keys = append(keys, key)
		}
		sort.Strings(keys)
		for _, key := range keys {
			body = append(body, jsonKV{key, o.MerchantExtras[key]})
		}
	}
	// Trailing slash is REQUIRED: without it Khalti 301s and the POST body is lost. No retries: not idempotent.
	res, err := doHTTP(ctx, k.client, ProviderKhalti, httpRequest{
		method: "POST", url: k.base + "/epayment/initiate/", headers: [][2]string{{"Authorization", k.auth}},
		body: jsonBody(body), timeout: k.timeout,
	})
	if err != nil {
		return InitiateResult{}, err
	}
	pidx, _ := get(res.data, "pidx")
	if res.status != 200 || !truthy(pidx) {
		return InitiateResult{}, newPaymentError(ProviderKhalti, khaltiErrorKey(res.data, res.status), khaltiErrorMessage(res.data, res.text), res.status, res.data)
	}
	return InitiateResult{
		Kind:        KindRedirect,
		URL:         strOrEmpty(res.data, "payment_url"),
		ProviderRef: jsString(pidx),
		ExpiresAt:   strOrEmpty(res.data, "expires_at"),
		Raw:         res.data,
	}, nil
}

// Verify looks the payment up with the pidx stored at initiate time (VerifyInput.ProviderRef).
// The lookup response has no purchase_order_id, so a callback pidx that differs from the stored one is
// rejected (replay guard). Expired / User canceled arrive as HTTP 400 with a normal body and map to a status.
func (k *Khalti) Verify(ctx context.Context, in VerifyInput) (VerifyResult, error) {
	pidx := in.ProviderRef
	if pidx == "" {
		return VerifyResult{}, newPaymentError(ProviderKhalti, "missing_pidx", "khalti: stored pidx required for verify", 0, nil)
	}
	if cb := in.Callback["pidx"]; cb != "" && cb != pidx {
		return VerifyResult{}, newPaymentError(ProviderKhalti, "pidx_mismatch", "khalti: callback pidx does not match stored pidx", 400, in.Callback)
	}
	res, err := doHTTP(ctx, k.client, ProviderKhalti, httpRequest{
		method: "POST", url: k.base + "/epayment/lookup/", headers: [][2]string{{"Authorization", k.auth}},
		body: jsonBody(jsonObject{{"pidx", pidx}}), timeout: k.timeout, retries: 2, // lookup is a read; safe to retry
	})
	if err != nil {
		return VerifyResult{}, err
	}
	if st, ok := get(res.data, "status"); ok {
		if s, isStr := st.(string); isStr {
			status, known := khaltiStatus[strings.ToLower(s)]
			if !known {
				status = StatusUnknown
			}
			var amount *int64
			if ta, ok := get(res.data, "total_amount"); ok {
				if n, ok := jsonInt(ta); ok {
					amount = &n
				}
			}
			return VerifyResult{
				Provider: ProviderKhalti, Status: status, OrderID: in.OrderID, AmountPaisa: amount,
				TransactionID: strOrEmpty(res.data, "transaction_id"), Raw: res.data,
			}, nil
		}
	}
	if detail, _ := get(res.data, "detail"); res.status == 404 || isString(detail, "Not found.") {
		return VerifyResult{Provider: ProviderKhalti, Status: StatusNotFound, OrderID: in.OrderID, Raw: res.data}, nil
	}
	return VerifyResult{}, newPaymentError(ProviderKhalti, khaltiErrorKey(res.data, res.status), khaltiErrorMessage(res.data, res.text), res.status, res.data)
}

// OrderIDFromCallback returns purchase_order_id.
func (k *Khalti) OrderIDFromCallback(params map[string]string) string {
	return params["purchase_order_id"]
}

// Refund refunds a completed transaction (transaction_id from lookup) and returns the response body.
// Khalti's docs say a partial refund `amount` is paisa but their example shows "50.00"; confirm the unit
// in sandbox before relying on partial refunds.
func (k *Khalti) Refund(ctx context.Context, transactionID string, opts KhaltiRefundOptions) (any, error) {
	body := jsonObject{}
	if opts.AmountPaisa != nil {
		if err := AssertPaisa(*opts.AmountPaisa, ProviderKhalti); err != nil {
			return nil, err
		}
		body = append(body, jsonKV{"amount", *opts.AmountPaisa})
	}
	if opts.Mobile != "" {
		body = append(body, jsonKV{"mobile", opts.Mobile})
	}
	res, err := doHTTP(ctx, k.client, ProviderKhalti, httpRequest{
		method: "POST", url: k.host + "/api/merchant-transaction/" + encodeURIComponent(transactionID) + "/refund/",
		headers: [][2]string{{"Authorization", k.auth}}, body: jsonBody(body), timeout: k.timeout,
	})
	if err != nil {
		return nil, err
	}
	if res.status != 200 {
		return nil, newPaymentError(ProviderKhalti, khaltiErrorKey(res.data, res.status), khaltiErrorMessage(res.data, res.text), res.status, res.data)
	}
	return res.data, nil
}

func khaltiErrorKey(data any, status int) string {
	if status == 401 {
		return "unauthorized"
	}
	if v, ok := get(data, "error_key"); ok && truthy(v) {
		return jsString(v)
	}
	return fmt.Sprintf("http_%d", status)
}

func khaltiErrorMessage(data any, text string) string {
	var keys []string
	var value func(string) any
	switch d := data.(type) {
	case map[string]any:
		if detail := d["detail"]; truthy(detail) {
			return "Khalti: " + jsString(detail)
		}
		keys = jsonObjectKeys(text)
		if len(keys) != len(d) { // fallback: key order unknown
			keys = keys[:0]
			for key := range d {
				keys = append(keys, key)
			}
			sort.Strings(keys)
		}
		value = func(key string) any { return d[key] }
	case []any:
		for i := range d {
			keys = append(keys, strconv.Itoa(i))
		}
		value = func(key string) any { i, _ := strconv.Atoi(key); return d[i] }
	default:
		return "Khalti error: " + truncateUTF16(jsString(data), 200)
	}
	var parts []string
	for _, key := range keys {
		if key == "error_key" || key == "status_code" {
			continue
		}
		v := value(key)
		s := jsString(v)
		if arr, ok := v.([]any); ok {
			items := make([]string, len(arr))
			for i, e := range arr {
				if e != nil {
					items[i] = jsString(e)
				}
			}
			s = strings.Join(items, " ")
		}
		parts = append(parts, key+": "+s)
	}
	if len(parts) == 0 {
		return "Khalti: unknown error"
	}
	return "Khalti: " + strings.Join(parts, "; ")
}

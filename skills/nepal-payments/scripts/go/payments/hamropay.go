package payments

// Hamro Pay Checkout (Hamro Patro's wallet): https://hamropay.com.np/checkout/developer/reference/
// Credentials: UAT merchant portal https://pay-sandbox.hamropatro.com (signup OTP 000000) -> Client Credentials:
// merchantId, Client-Id, Client-API-Key, client secret; Configuration -> Webhook gives the webhook signing secret.
//
// Flow: server POST /v1/checkout/sessionId (signed headers) -> server builds the gateway token -> browser form POST to
//       {gateway}/api/checkout -> Hamro Pay redirects to success/failure URL with ?MerchantTxnId= -> POST /v1/checkout/transaction.
//
// Every signature is base64(HMAC-SHA512(clientSecret, values joined by ",")):
//   create session = merchantTxnId,transactionAmount,merchantId,clientId,clientApiKey     (header "Signature")
//   gateway token  = merchantId,merchantTxnId,sessionId,transactionAmount,clientId,clientApiKey   (form field "token")
//   get txn        = merchantTxnId,merchantId,clientId,clientApiKey                       (header "Signature")
//   webhook        = merchantTxnId,merchantId,status,amount   with the webhook secret      (header "Signature")
// transactionAmount is PAISA as a string (Rs 10..50,000); every amount Hamro Pay returns is RUPEES.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"math/big"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// HamroPayConfig configures the Hamro Pay adapter.
type HamroPayConfig struct {
	Env          Env
	MerchantID   string
	ClientID     string
	ClientAPIKey string
	ClientSecret string
	// WebhookSecret is the signing secret shown when you save the webhook URL in the merchant portal.
	// Needed for VerifyWebhook.
	WebhookSecret string
	// APIBaseURL overrides the API host. Default UAT https://uat-payclient.hamropatro.com, live https://payclient.hamropatro.com.
	APIBaseURL string
	// GatewayURL is the full gateway form URL ({gateway}/api/checkout). Required in production: Hamro Pay issues the live host.
	GatewayURL string
	Timeout    time.Duration // default 15s
	HTTPClient Doer
}

// HamroPayInitiateOptions are Hamro Pay-only initiate fields.
type HamroPayInitiateOptions struct {
	// Remarks is the gateway form "remarks" (<= 250 chars); empty means Description.
	Remarks  string
	Metadata map[string]string
}

var hamroPayAPI = map[Env]string{EnvSandbox: "https://uat-payclient.hamropatro.com", EnvProduction: "https://payclient.hamropatro.com"}

const hamroPaySandboxGateway = "https://uat-checkout-pay.hamropatro.com/api/checkout"

// Hamro Pay per-transaction limits in paisa (Rs 10 to Rs 50,000).
const (
	HamroPayMinPaisa = 1000
	HamroPayMaxPaisa = 5_000_000
)

var hamroPayTxnStatus = map[string]PaymentStatus{
	"COMPLETED":     StatusPaid,
	"FAILED":        StatusFailed,
	"PENDING":       StatusPending,
	"PROCESSING":    StatusPending,
	"NOT_INITIATED": StatusNotFound,
	"CANCELED":      StatusCanceled,
	"CANCELLED":     StatusCanceled,
}

var hamroPayTxnIDRe = regexp.MustCompile(`^[A-Za-z0-9-]{1,25}$`)

// HamroPaySign is base64(HMAC-SHA512) over comma-joined values. The join has no escaping, so a comma inside a
// value would let two different tuples share a signature: it is refused instead.
func HamroPaySign(secret string, values ...string) (string, error) {
	for _, v := range values {
		if strings.Contains(v, ",") {
			return "", errors.New("hamropay: signed values must not contain commas")
		}
	}
	return ToBase64(HMACSHA512([]byte(secret), []byte(strings.Join(values, ",")))), nil
}

// HamroPay is the Hamro Pay adapter.
type HamroPay struct {
	cfg     HamroPayConfig
	api     string
	gateway string // "" in production without GatewayURL
	timeout time.Duration
	client  Doer
}

var _ Adapter = (*HamroPay)(nil)

// NewHamroPay builds the Hamro Pay adapter.
func NewHamroPay(cfg HamroPayConfig) (*HamroPay, error) {
	api, ok := hamroPayAPI[cfg.Env]
	if !ok {
		return nil, errInvalidEnv(ProviderHamroPay, cfg.Env)
	}
	if cfg.MerchantID == "" || cfg.ClientID == "" || cfg.ClientAPIKey == "" || cfg.ClientSecret == "" {
		return nil, errMissingConfig(ProviderHamroPay, "MerchantID, ClientID, ClientAPIKey and ClientSecret")
	}
	gateway := cfg.GatewayURL
	if gateway == "" && cfg.Env == EnvSandbox {
		gateway = hamroPaySandboxGateway
	}
	return &HamroPay{
		cfg:     cfg,
		api:     strings.TrimSuffix(orDefault(cfg.APIBaseURL, api), "/"),
		gateway: gateway,
		timeout: durOr(cfg.Timeout, 15*time.Second),
		client:  cfg.HTTPClient,
	}, nil
}

// ID returns ProviderHamroPay.
func (h *HamroPay) ID() ProviderID { return ProviderHamroPay }

func (h *HamroPay) post(ctx context.Context, path string, body jsonObject, signed []string, retries int) (map[string]any, error) {
	sig, err := HamroPaySign(h.cfg.ClientSecret, signed...)
	if err != nil {
		return nil, err
	}
	res, err := doHTTP(ctx, h.client, ProviderHamroPay, httpRequest{
		method: "POST", url: h.api + path,
		headers: [][2]string{{"Signature", sig}, {"Client-Id", h.cfg.ClientID}, {"Client-API-Key", h.cfg.ClientAPIKey}},
		// The API drops each TCP connection without marking it closed; a pooled keep-alive socket then fails on the
		// next call (Hamro Pay's own sample measured every second request failing on UAT).
		close: true,
		body:  jsonBody(body), timeout: h.timeout, retries: retries,
	})
	if err != nil {
		return nil, err
	}
	code, hasCode := getNonNull(res.data, "code")
	if n, ok := jsonInt(code); res.status == 401 || (ok && n == 16) {
		return nil, newPaymentError(ProviderHamroPay, "unauthorized", "Hamro Pay: unauthorized (check Client-Id, Client-API-Key and the client secret)", res.status, res.data)
	}
	d, isObj := res.data.(map[string]any)
	if res.status != 200 || !isObj {
		msg := truncateUTF16(res.text, 200)
		if m, ok := get(res.data, "message"); ok {
			if s, ok := m.(string); ok {
				msg = s
			}
		}
		c := fmt.Sprintf("http_%d", res.status)
		if hasCode {
			c = "code_" + jsString(code)
		}
		return nil, newPaymentError(ProviderHamroPay, c, "Hamro Pay "+path+" failed: "+msg, res.status, res.data)
	}
	return d, nil
}

// Initiate calls Create Session, then returns the signed form for the gateway. merchantTxnId = OrderID (<= 25 chars).
// Persist ProviderRef (the sessionId). A session lives about 10 minutes.
// A timeout here may still have created the session on Hamro Pay's side: retry with a NEW OrderID.
func (h *HamroPay) Initiate(ctx context.Context, in InitiateInput) (InitiateResult, error) {
	if err := AssertPaisa(in.AmountPaisa, ProviderHamroPay); err != nil {
		return InitiateResult{}, err
	}
	if in.AmountPaisa < HamroPayMinPaisa || in.AmountPaisa > HamroPayMaxPaisa {
		return InitiateResult{}, newPaymentError(ProviderHamroPay, "invalid_amount", "Hamro Pay accepts Rs 10 to Rs 50,000 per transaction", 0, nil)
	}
	if !hamroPayTxnIDRe.MatchString(in.OrderID) {
		return InitiateResult{}, newPaymentError(ProviderHamroPay, "invalid_order_id", "Hamro Pay merchantTxnId must be 1–25 chars [A-Za-z0-9-]", 0, nil)
	}
	if h.gateway == "" {
		return InitiateResult{}, &PaymentError{Provider: ProviderHamroPay, Code: "invalid_config", Message: "hamropay: GatewayURL is required in production (Hamro Pay issues the live gateway host)"}
	}
	var o HamroPayInitiateOptions
	if in.HamroPay != nil {
		o = *in.HamroPay
	}
	amount := strconv.FormatInt(in.AmountPaisa, 10) // signed and sent as the same string
	name := orDefault(in.Description, "Payment")
	body := jsonObject{
		{"merchantTxnId", in.OrderID},
		{"merchantId", h.cfg.MerchantID},
		{"transactionAmount", amount},
		{"successRedirectionUrl", in.ReturnURL},
		{"failedRedirectionUrl", orDefault(in.FailureURL, in.ReturnURL)},
		{"productList", []any{jsonObject{
			{"name", name}, {"description", name}, {"price", json.Number(jsRupeesNumber(in.AmountPaisa))}, {"quantity", int64(1)},
		}}},
	}
	if in.Customer != nil && in.Customer.Phone != "" {
		body = append(body, jsonKV{"phone_number", in.Customer.Phone})
	}
	if o.Metadata != nil {
		body = append(body, jsonKV{"metadata", o.Metadata})
	}
	session, err := h.post(ctx, "/v1/checkout/sessionId", body, []string{in.OrderID, amount, h.cfg.MerchantID, h.cfg.ClientID, h.cfg.ClientAPIKey}, 0)
	if err != nil {
		return InitiateResult{}, err
	}
	sessionID, _ := session["sessionId"].(string)
	if sessionID == "" {
		return InitiateResult{}, newPaymentError(ProviderHamroPay, "no_session", "Hamro Pay: Create Session returned no sessionId", 200, session)
	}
	if m, ok := getNonNull(session, "merchantId"); ok && !isString(m, h.cfg.MerchantID) {
		return InitiateResult{}, newPaymentError(ProviderHamroPay, "merchant_mismatch", "Hamro Pay: Create Session answered for a different merchantId", 200, session)
	}
	token, err := HamroPaySign(h.cfg.ClientSecret, h.cfg.MerchantID, in.OrderID, sessionID, amount, h.cfg.ClientID, h.cfg.ClientAPIKey)
	if err != nil {
		return InitiateResult{}, err
	}
	r := formResult(h.gateway, [][2]string{
		{"merchant_id", h.cfg.MerchantID},
		{"session_id", sessionID},
		{"token", token},
		{"merchant_transaction_id", in.OrderID},
		{"remarks", truncateUTF16(orDefault(o.Remarks, in.Description), 250)},
	})
	r.ProviderRef = sessionID
	return r, nil
}

// Verify calls Get Transaction (authoritative). amount is rupees, and 0 until the payment finishes.
func (h *HamroPay) Verify(ctx context.Context, in VerifyInput) (VerifyResult, error) {
	r, err := h.post(ctx, "/v1/checkout/transaction",
		jsonObject{{"merchantId", h.cfg.MerchantID}, {"merchantTxnId", in.OrderID}},
		[]string{in.OrderID, h.cfg.MerchantID, h.cfg.ClientID, h.cfg.ClientAPIKey}, 2)
	if err != nil {
		return VerifyResult{}, err
	}
	// The reference names it merchantTransactionId; the live API answers merchantTxnId.
	echoed, ok := getNonNull(r, "merchantTransactionId")
	if !ok {
		echoed, ok = getNonNull(r, "merchantTxnId")
	}
	if ok && !isString(echoed, "") && jsString(echoed) != in.OrderID {
		return VerifyResult{}, newPaymentError(ProviderHamroPay, "id_mismatch", "Hamro Pay: transaction answer is for a different merchantTxnId", 200, r)
	}
	status, ok := hamroPayTxnStatus[strings.ToUpper(strOrEmpty(r, "status"))]
	if !ok {
		status = StatusUnknown
	}
	var amount *int64
	if a, ok := getNonNull(r, "amount"); ok && status == StatusPaid {
		p, err := paisaFromValue(a)
		if err != nil {
			return VerifyResult{}, err
		}
		amount = &p
	}
	txn, _ := r["trackingId"].(string)
	return VerifyResult{Provider: ProviderHamroPay, Status: status, OrderID: in.OrderID, AmountPaisa: amount, TransactionID: txn, Raw: r}, nil
}

// OrderIDFromCallback returns MerchantTxnId: success and failure redirects carry ?MerchantTxnId=<your OrderID>.
func (h *HamroPay) OrderIDFromCallback(params map[string]string) string {
	return firstNonEmpty(params["MerchantTxnId"], params["merchantTxnId"])
}

// VerifyWebhook checks a webhook's "Signature" header against the decoded JSON body. Hamro Pay signs its own
// rendering of the amount (a double), which may be "1200", "1200.0" or "1200.00", so every form of the PARSED
// number is tried. Fulfil only after Verify.
func (h *HamroPay) VerifyWebhook(body map[string]any, signature string) (bool, error) {
	if h.cfg.WebhookSecret == "" {
		return false, errMissingConfig(ProviderHamroPay, "WebhookSecret (to verify webhooks)")
	}
	if signature == "" {
		return false, nil
	}
	amount, ok := jsonFloat(body["amount"])
	if !ok || math.IsNaN(amount) || math.IsInf(amount, 0) {
		return false, nil
	}
	prefix := make([]string, 0, 4)
	for _, k := range []string{"merchantTxnId", "merchantId", "status"} {
		s, ok := body[k].(string)
		if !ok || s == "" || strings.Contains(s, ",") {
			return false, nil
		}
		prefix = append(prefix, s)
	}
	str := jsFormatFloat(amount)
	seen := map[string]bool{}
	match := false
	for _, a := range []string{str, jsToFixed(amount, 2), str + ".0", jsToFixed(amount, 1)} {
		if seen[a] {
			continue
		}
		seen[a] = true
		want, err := HamroPaySign(h.cfg.WebhookSecret, append(prefix[:3:3], a)...)
		if err != nil {
			return false, nil
		}
		if SafeEqual(want, signature) {
			match = true
		}
	}
	return match, nil
}

// jsonFloat returns a JSON number as float64 (JS `typeof v === "number"`); strings are not numbers.
func jsonFloat(v any) (float64, bool) {
	switch x := v.(type) {
	case json.Number:
		f, err := strconv.ParseFloat(string(x), 64)
		return f, err == nil || errors.Is(err, strconv.ErrRange)
	case float64:
		return x, true
	case float32:
		return float64(x), true
	case int:
		return float64(x), true
	case int64:
		return float64(x), true
	default:
		return 0, false
	}
}

// jsToFixed mirrors Number.prototype.toFixed: the exact binary value rounded half away from zero.
func jsToFixed(f float64, digits int) string {
	if math.IsNaN(f) || math.Abs(f) >= 1e21 {
		return jsFormatFloat(f)
	}
	r := new(big.Rat).SetFloat64(math.Abs(f))
	scale := new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(digits)), nil)
	r.Mul(r, new(big.Rat).SetInt(scale))
	r.Add(r, big.NewRat(1, 2))
	n := new(big.Int).Quo(r.Num(), r.Denom()) // floor(|f| * 10^digits + 1/2)
	s := n.String()
	if digits > 0 {
		if len(s) <= digits {
			s = strings.Repeat("0", digits-len(s)+1) + s
		}
		s = s[:len(s)-digits] + "." + s[len(s)-digits:]
	}
	if f < 0 {
		s = "-" + s
	}
	return s
}

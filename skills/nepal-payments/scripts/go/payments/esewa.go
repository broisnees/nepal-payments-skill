package payments

// eSewa — https://developer.esewa.com.np
//
// Two flows:
//  1. ePay v2 (web, also works in a mobile WebView): signed form POST -> eSewa -> success_url?data=<base64 JSON>
//     -> verify response signature -> status API (authoritative).
//  2. Intent (mobile app-to-app): server books -> app opens deeplink -> eSewa POSTs callback_url +
//     redirects redirect_url -> status API.
//
// Signature (both): base64(HMAC-SHA256(secret, "k1=v1,k2=v2,...")) in signed_field_names order.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"
)

// Public eSewa sandbox credentials.
const (
	EsewaSandboxProductCode       = "EPAYTEST"
	EsewaSandboxSecretKey         = "8gBm/:&EnhH.1/q"
	EsewaSandboxIntentProductCode = "INTENT"
	// EsewaSandboxIntentAccessKey is used as a raw string, NOT base64-decoded.
	EsewaSandboxIntentAccessKey = "LB0REg8HUSw3MTYrI1s6JTE8Kyc6JyAqJiA3MQ=="
)

// EsewaSandboxConfig returns a ready-to-use sandbox config (ePay + Intent).
func EsewaSandboxConfig() EsewaConfig {
	return EsewaConfig{
		Env:         EnvSandbox,
		ProductCode: EsewaSandboxProductCode,
		SecretKey:   EsewaSandboxSecretKey,
		Intent:      &EsewaIntentConfig{ProductCode: EsewaSandboxIntentProductCode, AccessKey: EsewaSandboxIntentAccessKey},
	}
}

// EsewaConfig configures the eSewa adapter.
type EsewaConfig struct {
	Env Env
	// ProductCode is the ePay product code. Sandbox: "EPAYTEST".
	ProductCode string
	// SecretKey is the ePay secret key. "&amp;" (HTML-escaped by config UIs) is turned back into "&".
	SecretKey string
	// Intent holds the Intent (mobile) credentials; only needed for the Intent* methods.
	Intent *EsewaIntentConfig
	// FormURL / StatusURL override the endpoints.
	FormURL   string
	StatusURL string
	// LenientSignature: when true, an invalid success-redirect signature does not abort Verify
	// (TS strictSignature: false). The status API is checked regardless. Default: strict.
	LenientSignature bool
	Timeout          time.Duration // default 15s
	HTTPClient       Doer
}

// EsewaIntentConfig holds Intent credentials. BaseURL is required in production (issued at go-live).
type EsewaIntentConfig struct {
	ProductCode string
	AccessKey   string
	BaseURL     string
}

// EsewaInitiateOptions is an optional breakdown INCLUDED in InitiateInput.AmountPaisa, which is always
// the TOTAL charged (the number you store and pass to Verify). eSewa's `amount` = total - tax - service - delivery.
type EsewaInitiateOptions struct {
	TaxPaisa            int64
	ServiceChargePaisa  int64
	DeliveryChargePaisa int64
}

type esewaEndpoints struct{ form, status, intent string }

var esewaURLs = map[Env]esewaEndpoints{
	EnvSandbox: {
		form:   "https://rc-epay.esewa.com.np/api/epay/main/v2/form",
		status: "https://rc.esewa.com.np/api/epay/transaction/status/",
		intent: "https://rc-checkout.esewa.com.np/api/client/intent/payment",
	},
	EnvProduction: {
		form:   "https://epay.esewa.com.np/api/epay/main/v2/form",
		status: "https://esewa.com.np/api/epay/transaction/status/",
		// production Intent host is issued by eSewa at go-live
	},
}

var esewaEpayStatus = map[string]PaymentStatus{
	"COMPLETE":       StatusPaid,
	"PENDING":        StatusPending,
	"AMBIGUOUS":      StatusPending, // "payment is at halt state": keep re-checking
	"FULL_REFUND":    StatusRefunded,
	"PARTIAL_REFUND": StatusPartiallyRefunded,
	"NOT_FOUND":      StatusNotFound, // session expired / never paid / wrong amount
	"CANCELED":       StatusCanceled,
}

var esewaIntentStatus = map[string]PaymentStatus{
	"SUCCESS":  StatusPaid,
	"BOOKED":   StatusPending,
	"PENDING":  StatusPending,
	"FAILED":   StatusFailed,
	"CANCELED": StatusCanceled,
	"REVERTED": StatusRefunded,
}

// EsewaSign returns base64(HMAC-SHA256(key, "f1=v1,f2=v2")) for the given field order.
// Missing fields sign as empty.
func EsewaSign(key string, fields map[string]string, order []string) string {
	parts := make([]string, len(order))
	for i, f := range order {
		parts[i] = f + "=" + fields[f]
	}
	return ToBase64(HMACSHA256([]byte(key), []byte(strings.Join(parts, ","))))
}

// Esewa is the eSewa adapter (ePay v2 + Intent).
type Esewa struct {
	cfg       EsewaConfig
	formURL   string
	statusURL string
	intentURL string
	secret    string
	timeout   time.Duration
	client    Doer
}

var _ Adapter = (*Esewa)(nil)

// NewEsewa builds the eSewa adapter.
func NewEsewa(cfg EsewaConfig) (*Esewa, error) {
	urls, ok := esewaURLs[cfg.Env]
	if !ok {
		return nil, errInvalidEnv(ProviderEsewa, cfg.Env)
	}
	if cfg.ProductCode == "" || cfg.SecretKey == "" {
		return nil, errMissingConfig(ProviderEsewa, "ProductCode and SecretKey")
	}
	return &Esewa{
		cfg:       cfg,
		formURL:   orDefault(cfg.FormURL, urls.form),
		statusURL: orDefault(cfg.StatusURL, urls.status),
		intentURL: urls.intent,
		secret:    strings.ReplaceAll(cfg.SecretKey, "&amp;", "&"),
		timeout:   durOr(cfg.Timeout, 15*time.Second),
		client:    cfg.HTTPClient,
	}, nil
}

// ID returns ProviderEsewa.
func (e *Esewa) ID() ProviderID { return ProviderEsewa }

var esewaUUIDRe = regexp.MustCompile(`^[A-Za-z0-9-]+$`)

// Initiate returns a form to auto-submit (application/x-www-form-urlencoded POST).
// Keep ReturnURL/FailureURL free of query strings (eSewa appends ?data=...). Put your attempt id in the
// PATH (e.g. /payments/esewa/return/<orderId>) so failures can be matched too.
func (e *Esewa) Initiate(_ context.Context, in InitiateInput) (InitiateResult, error) {
	if err := AssertPaisa(in.AmountPaisa, ProviderEsewa); err != nil {
		return InitiateResult{}, err
	}
	if !esewaUUIDRe.MatchString(in.OrderID) {
		return InitiateResult{}, newPaymentError(ProviderEsewa, "invalid_order_id", "eSewa transaction_uuid allows only letters, digits and '-'", 0, nil)
	}
	var o EsewaInitiateOptions
	if in.Esewa != nil {
		o = *in.Esewa
	}
	base := in.AmountPaisa - o.TaxPaisa - o.ServiceChargePaisa - o.DeliveryChargePaisa // AmountPaisa is the TOTAL
	for _, n := range []int64{o.TaxPaisa, o.ServiceChargePaisa, o.DeliveryChargePaisa} {
		if n < 0 || n > maxSafeInteger {
			base = 0
		}
	}
	if base <= 0 {
		return InitiateResult{}, newPaymentError(ProviderEsewa, "invalid_amount", "eSewa: tax/charges must be non-negative paisa and less than the total", 0, nil)
	}
	// Format ONCE and use the same strings in the form and in the signature ("110" vs "110.0" -> ES104).
	pairs := [][2]string{
		{"amount", PaisaToRupees(base)},
		{"tax_amount", PaisaToRupees(o.TaxPaisa)},
		{"product_service_charge", PaisaToRupees(o.ServiceChargePaisa)},
		{"product_delivery_charge", PaisaToRupees(o.DeliveryChargePaisa)},
		{"total_amount", PaisaToRupees(in.AmountPaisa)},
		{"transaction_uuid", in.OrderID},
		{"product_code", e.cfg.ProductCode},
		{"success_url", in.ReturnURL},
		{"failure_url", orDefault(in.FailureURL, in.ReturnURL)},
		{"signed_field_names", "total_amount,transaction_uuid,product_code"},
	}
	r := formResult(e.formURL, pairs)
	sig := EsewaSign(e.secret, r.Fields, []string{"total_amount", "transaction_uuid", "product_code"})
	r.Fields["signature"] = sig
	r.FieldOrder = append(r.FieldOrder, "signature")
	return r, nil
}

// ParseSuccess decodes the base64 `data` param from success_url and checks its signature.
// Numeric fields are signed with their exact JSON text ("1000.0" stays "1000.0"); a comma-formatted
// total_amount ("1,000.0") is retried without commas. It does NOT prove payment; call Verify.
func (e *Esewa) ParseSuccess(data string) (payload map[string]any, signatureValid bool, err error) {
	raw, err := FromBase64(data)
	if err != nil {
		return nil, false, &PaymentError{Provider: ProviderEsewa, Code: "malformed_callback", HTTPStatus: 400, Message: "eSewa: success payload is not base64: " + err.Error(), Err: err}
	}
	text := strings.TrimPrefix(strings.ToValidUTF8(string(raw), "\uFFFD"), "\uFEFF")
	v, err := decodeJSON(text)
	if err != nil {
		return nil, false, &PaymentError{Provider: ProviderEsewa, Code: "malformed_callback", HTTPStatus: 400, Message: "eSewa: success payload is not JSON: " + err.Error(), Err: err}
	}
	m, ok := v.(map[string]any)
	names, isStr := m["signed_field_names"].(string)
	if !ok || !isStr {
		return nil, false, newPaymentError(ProviderEsewa, "malformed_callback", "eSewa: malformed success payload", 400, v)
	}
	order := splitTrim(names)
	fields := make(map[string]string, len(order))
	for _, f := range order {
		fields[f] = esewaRawValue(m, f)
	}
	sig, sigIsStr := m["signature"].(string)
	valid := sigIsStr && SafeEqual(EsewaSign(e.secret, fields, order), sig)
	// eSewa may format total_amount as "1,000.0"; sources disagree on whether the comma is signed. Try both.
	if ta, has := fields["total_amount"]; !valid && has && strings.Contains(ta, ",") {
		alt := make(map[string]string, len(fields))
		for k, val := range fields {
			alt[k] = val
		}
		alt["total_amount"] = strings.ReplaceAll(ta, ",", "")
		valid = SafeEqual(EsewaSign(e.secret, alt, order), sig)
	}
	return m, valid, nil
}

// esewaRawValue is the exact text of a field as eSewa sent it (numbers keep their JSON formatting).
func esewaRawValue(m map[string]any, field string) string {
	v, ok := m[field]
	if !ok || v == nil {
		return ""
	}
	if n, isNum := v.(json.Number); isNum {
		return string(n)
	}
	return jsString(v)
}

// EsewaVerifyRaw is VerifyResult.Raw for ePay verifies.
type EsewaVerifyRaw struct {
	Status         map[string]any `json:"status"`
	SignatureValid *bool          `json:"signatureValid,omitempty"`
}

// Verify is the authoritative check via the status API. If Callback["data"] is present (success redirect),
// its signature, transaction_uuid and product_code are checked too. AmountPaisa MUST be the TOTAL you
// charged: eSewa returns NOT_FOUND for a wrong total, which doubles as an amount check.
func (e *Esewa) Verify(ctx context.Context, in VerifyInput) (VerifyResult, error) {
	var sigValid *bool
	if data := in.Callback["data"]; data != "" {
		payload, ok, err := e.ParseSuccess(data)
		if err != nil {
			return VerifyResult{}, err
		}
		sigValid = &ok
		if !isString(payload["transaction_uuid"], in.OrderID) || !isString(payload["product_code"], e.cfg.ProductCode) {
			return VerifyResult{}, newPaymentError(ProviderEsewa, "callback_mismatch", "eSewa: callback does not match this attempt", 400, payload)
		}
		if !ok && !e.cfg.LenientSignature {
			return VerifyResult{}, newPaymentError(ProviderEsewa, "invalid_signature", "eSewa: invalid response signature", 400, payload)
		}
	}
	s, err := e.statusCheck(ctx, in.OrderID, in.AmountPaisa)
	if err != nil {
		return VerifyResult{}, err
	}
	status := StatusUnknown
	if st, ok := s["status"].(string); ok {
		if mapped, ok := esewaEpayStatus[st]; ok {
			status = mapped
		}
	}
	var amount *int64
	switch ta := s["total_amount"].(type) {
	case json.Number, string:
		p, err := paisaFromValue(ta)
		if err != nil {
			return VerifyResult{}, err
		}
		amount = &p
	}
	return VerifyResult{
		Provider:      ProviderEsewa,
		Status:        status,
		OrderID:       in.OrderID,
		AmountPaisa:   amount,
		TransactionID: strOrEmpty(s, "ref_id"),
		Raw:           EsewaVerifyRaw{Status: s, SignatureValid: sigValid},
	}, nil
}

func (e *Esewa) statusCheck(ctx context.Context, orderID string, amountPaisa int64) (map[string]any, error) {
	qs := encodeForm([][2]string{
		{"product_code", e.cfg.ProductCode},
		{"total_amount", PaisaToRupees(amountPaisa)},
		{"transaction_uuid", orderID},
	})
	res, err := doHTTP(ctx, e.client, ProviderEsewa, httpRequest{url: e.statusURL + "?" + qs, timeout: e.timeout, retries: 2})
	if err != nil {
		return nil, err
	}
	m, isObj := res.data.(map[string]any)
	_, hasStatus := m["status"]
	if res.status != 200 || !isObj || !hasStatus {
		msg := truncateUTF16(res.text, 200)
		if v, ok := getNonNull(res.data, "error_message"); ok {
			msg = jsString(v)
		}
		code := fmt.Sprintf("http_%d", res.status)
		if v, ok := get(res.data, "code"); ok {
			code = "esewa_" + jsString(v)
		}
		return nil, newPaymentError(ProviderEsewa, code, "eSewa status check failed: "+msg, res.status, res.data)
	}
	return m, nil
}

// OrderIDFromCallback reads transaction_uuid from the `data` param, else (failure redirects carry no
// data) orderId / order_id / transaction_uuid from your path or query params.
func (e *Esewa) OrderIDFromCallback(params map[string]string) string {
	if d := params["data"]; d != "" {
		raw, err := FromBase64(d)
		if err != nil {
			return ""
		}
		v, err := decodeJSON(strings.TrimPrefix(strings.ToValidUTF8(string(raw), "\uFFFD"), "\uFEFF"))
		if err != nil {
			return ""
		}
		return strOrEmpty(v, "transaction_uuid")
	}
	return firstNonEmpty(params["orderId"], params["order_id"], params["transaction_uuid"])
}

// ------------------------------------------------------------------ Intent (mobile app-to-app)

// EsewaIntentBookInput books an Intent payment.
type EsewaIntentBookInput struct {
	OrderID     string
	AmountPaisa int64
	CallbackURL string            // server-to-server POST from eSewa
	RedirectURL string            // where the user lands after paying
	Properties  map[string]string // snake_case keys, shown to the user; default {"remarks": OrderID}
}

// EsewaIntentBooking is the booking result. Persist ProviderRef ("bookingId|correlationId") on the attempt.
type EsewaIntentBooking struct {
	BookingID     string
	Deeplink      string
	CorrelationID string
	ProviderRef   string
	Raw           any
}

func (e *Esewa) requireIntent() (EsewaIntentConfig, error) {
	if e.cfg.Intent == nil {
		return EsewaIntentConfig{}, errors.New("eSewa: configure Intent credentials to use Intent payments")
	}
	ic := *e.cfg.Intent
	ic.BaseURL = orDefault(ic.BaseURL, e.intentURL)
	if ic.BaseURL == "" {
		return EsewaIntentConfig{}, errors.New("eSewa: production Intent BaseURL is issued by eSewa at go-live; set Intent.BaseURL")
	}
	return ic, nil
}

// IntentBook books an Intent payment. Open Deeplink in the app (or mobile browser).
// The amount is sent and signed as a JS number ("100", "100.5").
func (e *Esewa) IntentBook(ctx context.Context, in EsewaIntentBookInput) (EsewaIntentBooking, error) {
	ic, err := e.requireIntent()
	if err != nil {
		return EsewaIntentBooking{}, err
	}
	if err := AssertPaisa(in.AmountPaisa, ProviderEsewa); err != nil {
		return EsewaIntentBooking{}, err
	}
	amount := jsRupeesNumber(in.AmountPaisa)
	order := []string{"product_code", "amount", "transaction_uuid"}
	sig := EsewaSign(ic.AccessKey, map[string]string{"product_code": ic.ProductCode, "amount": amount, "transaction_uuid": in.OrderID}, order)
	props := in.Properties
	if props == nil {
		props = map[string]string{"remarks": in.OrderID}
	}
	body := jsonObject{
		{"product_code", ic.ProductCode},
		{"amount", json.Number(amount)},
		{"transaction_uuid", in.OrderID},
		{"signed_field_names", "product_code,amount,transaction_uuid"},
		{"signature", sig},
		{"callback_url", in.CallbackURL},
		{"redirect_url", in.RedirectURL},
		{"properties", props},
	}
	res, err := doHTTP(ctx, e.client, ProviderEsewa, httpRequest{method: "POST", url: ic.BaseURL + "/book", body: jsonBody(body), timeout: e.timeout})
	if err != nil {
		return EsewaIntentBooking{}, err
	}
	d, _ := get(res.data, "data")
	bid, hasBid := get(d, "booking_id")
	if !truthy(bid) {
		return EsewaIntentBooking{}, esewaIntentError("eSewa intent book failed: ", res)
	}
	corr, hasCorr := get(d, "correlation_id")
	return EsewaIntentBooking{
		BookingID:     jsString(bid),
		Deeplink:      strOrEmpty(d, "deeplink"),
		CorrelationID: strOrEmpty(d, "correlation_id"),
		ProviderRef:   jsTemplate(bid, hasBid) + "|" + jsTemplate(corr, hasCorr),
		Raw:           res.data,
	}, nil
}

func esewaIntentError(prefix string, res *httpResponse) error {
	msg := truncateUTF16(res.text, 200)
	if v, ok := getNonNull(res.data, "error_message"); ok {
		msg = jsString(v)
	}
	code := fmt.Sprintf("http_%d", res.status)
	if v, ok := getNonNull(res.data, "code"); ok {
		code = jsString(v)
	}
	return newPaymentError(ProviderEsewa, code, prefix+msg, res.status, res.data)
}

// IntentVerify is the authoritative Intent status. providerRef = "bookingId|correlationId" stored at booking.
// Pass the stored amount: the status response has none, but the amount was signed at booking.
func (e *Esewa) IntentVerify(ctx context.Context, orderID, providerRef string, amountPaisa *int64) (VerifyResult, error) {
	ic, err := e.requireIntent()
	if err != nil {
		return VerifyResult{}, err
	}
	parts := strings.Split(providerRef, "|")
	fields := map[string]string{"booking_id": parts[0], "product_code": ic.ProductCode}
	body := jsonObject{{"booking_id", parts[0]}, {"product_code", ic.ProductCode}}
	if len(parts) > 1 {
		fields["correlation_id"] = parts[1]
		body = append(body, jsonKV{"correlation_id", parts[1]})
	}
	order := []string{"booking_id", "product_code", "correlation_id"}
	body = append(body, jsonKV{"signed_field_names", strings.Join(order, ",")}, jsonKV{"signature", EsewaSign(ic.AccessKey, fields, order)})
	res, err := doHTTP(ctx, e.client, ProviderEsewa, httpRequest{method: "POST", url: ic.BaseURL + "/status", body: jsonBody(body), timeout: e.timeout, retries: 2})
	if err != nil {
		return VerifyResult{}, err
	}
	d, _ := get(res.data, "data")
	st, _ := get(d, "status")
	if !truthy(st) {
		return VerifyResult{}, esewaIntentError("eSewa intent status failed: ", res)
	}
	if tid, _ := get(d, "transaction_id"); truthy(tid) && !isString(tid, orderID) {
		return VerifyResult{}, newPaymentError(ProviderEsewa, "callback_mismatch", "eSewa intent: status is for a different transaction", 400, d)
	}
	status := StatusUnknown
	if s, ok := st.(string); ok {
		if mapped, ok := esewaIntentStatus[s]; ok {
			status = mapped
		}
	}
	var amount *int64
	if amountPaisa != nil {
		a := *amountPaisa
		amount = &a
	}
	return VerifyResult{
		Provider:      ProviderEsewa,
		Status:        status,
		OrderID:       orderID,
		AmountPaisa:   amount,
		TransactionID: strOrEmpty(d, "reference_code"),
		Raw:           res.data,
	}, nil
}

// IntentCancel cancels a booking that hasn't completed (e.g. user abandoned). Returns the response body.
func (e *Esewa) IntentCancel(ctx context.Context, providerRef string) (any, error) {
	ic, err := e.requireIntent()
	if err != nil {
		return nil, err
	}
	bookingID := strings.Split(providerRef, "|")[0]
	order := []string{"booking_id", "product_code"}
	sig := EsewaSign(ic.AccessKey, map[string]string{"booking_id": bookingID, "product_code": ic.ProductCode}, order)
	body := jsonObject{{"booking_id", bookingID}, {"product_code", ic.ProductCode}, {"signed_field_names", strings.Join(order, ",")}, {"signature", sig}}
	res, err := doHTTP(ctx, e.client, ProviderEsewa, httpRequest{method: "POST", url: ic.BaseURL + "/cancel", body: jsonBody(body), timeout: e.timeout})
	if err != nil {
		return nil, err
	}
	return res.data, nil
}

// IntentCallbackValid verifies the signature on eSewa's Intent callback POST body (decoded JSON;
// numbers are formatted like JavaScript String(n)). Still call IntentVerify before fulfilling.
func (e *Esewa) IntentCallbackValid(body map[string]any) (bool, error) {
	ic, err := e.requireIntent()
	if err != nil {
		return false, err
	}
	names, ok1 := body["signed_field_names"].(string)
	sig, ok2 := body["signature"].(string)
	if !ok1 || !ok2 {
		return false, nil
	}
	order := splitTrim(names)
	fields := make(map[string]string, len(order))
	for _, f := range order {
		fields[f] = strOrEmpty(body, f)
	}
	return SafeEqual(EsewaSign(ic.AccessKey, fields, order), sig), nil
}

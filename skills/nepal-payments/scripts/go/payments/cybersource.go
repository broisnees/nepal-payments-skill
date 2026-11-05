package payments

// CyberSource Secure Acceptance Hosted Checkout — the card gateway most Nepali banks provision
// (e.g. NIC Asia issues profile_id / access_key / secret_key).
//
// CyberSource is sunsetting Secure Acceptance in favour of Unified Checkout; it still works. For NEW
// builds ask your bank for Unified Checkout + REST (JWT) credentials (see references/cybersource.md).
//
// Signature: base64(HMAC-SHA256(secret_key as RAW UTF-8, "f1=v1,f2=v2,...")) over signed_field_names order.
// (REST API secrets are base64-DECODED instead — don't mix them up.)

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"time"
)

// CyberSourceConfig configures the CyberSource Secure Acceptance adapter.
type CyberSourceConfig struct {
	Env       Env
	ProfileID string
	AccessKey string
	SecretKey string
	// TransactionType is "sale" (default; auth+capture) or "authorization" (capture later).
	TransactionType string
	Currency        string // default "NPR"
	Locale          string // default "en-us"
	// UseReturnURLOverride sends override_custom_receipt_page (ReturnURL) and override_custom_cancel_page
	// (FailureURL) when you host the receipt page yourself.
	UseReturnURLOverride bool
}

// BillTo is the card holder's billing info (required for sale/authorization).
type BillTo struct {
	Forename     string
	Surname      string
	Email        string
	AddressLine1 string
	City         string
	Country      string // ISO 3166 alpha-2, e.g. "NP"
	Phone        string
	PostalCode   string // required only for US/CA
	State        string // required only for US/CA
}

// CyberSourceInitiateOptions are CyberSource-only initiate fields. BillTo is required.
type CyberSourceInitiateOptions struct {
	BillTo BillTo
	// MerchantDefinedData maps n -> merchant_defined_data<n> (no PII allowed).
	MerchantDefinedData map[int]string
}

var cyberSourceHosts = map[Env]string{
	EnvSandbox:    "https://testsecureacceptance.cybersource.com",
	EnvProduction: "https://secureacceptance.cybersource.com",
}

// CyberSourceSign signs fields over their own signed_field_names order.
func CyberSourceSign(secretKey string, fields map[string]string) string {
	names := strings.Split(fields["signed_field_names"], ",")
	parts := make([]string, len(names))
	for i, n := range names {
		parts[i] = n + "=" + fields[n]
	}
	return ToBase64(HMACSHA256([]byte(secretKey), []byte(strings.Join(parts, ","))))
}

// SignedDateTime formats t as UTC "yyyy-MM-dd'T'HH:mm:ss'Z'". Keep the server clock NTP-synced.
func SignedDateTime(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05Z") }

// cyberSourceDecision: ACCEPT -> paid (pending for authorization-only); REVIEW -> pending;
// DECLINE / ERROR -> failed (unknown for system errors 150-152); CANCEL -> canceled.
func cyberSourceDecision(decision, reasonCode, txnType string) PaymentStatus {
	switch strings.ToUpper(decision) {
	case "ACCEPT":
		if strings.HasPrefix(txnType, "authorization") {
			return StatusPending // auth-only isn't captured money yet
		}
		return StatusPaid
	case "REVIEW":
		return StatusPending
	case "DECLINE", "ERROR":
		if reasonCode == "150" || reasonCode == "151" || reasonCode == "152" {
			return StatusUnknown // system errors: re-check, don't retry blindly
		}
		return StatusFailed
	case "CANCEL":
		return StatusCanceled
	}
	return StatusUnknown
}

// CyberSource is the Secure Acceptance adapter. It makes no network calls.
type CyberSource struct {
	cfg  CyberSourceConfig
	host string
}

var _ Adapter = (*CyberSource)(nil)

// NewCyberSource builds the CyberSource adapter.
func NewCyberSource(cfg CyberSourceConfig) (*CyberSource, error) {
	host, ok := cyberSourceHosts[cfg.Env]
	if !ok {
		return nil, errInvalidEnv(ProviderCyberSource, cfg.Env)
	}
	if cfg.ProfileID == "" || cfg.AccessKey == "" || cfg.SecretKey == "" {
		return nil, errMissingConfig(ProviderCyberSource, "ProfileID, AccessKey and SecretKey")
	}
	cfg.TransactionType = orDefault(cfg.TransactionType, "sale")
	cfg.Currency = orDefault(cfg.Currency, "NPR")
	cfg.Locale = orDefault(cfg.Locale, "en-us")
	return &CyberSource{cfg: cfg, host: host}, nil
}

// ID returns ProviderCyberSource.
func (c *CyberSource) ID() ProviderID { return ProviderCyberSource }

// ResponseValid verifies a Secure Acceptance response POST (receipt page or Merchant POST URL).
func (c *CyberSource) ResponseValid(params map[string]string) bool {
	if params["signed_field_names"] == "" || params["signature"] == "" {
		return false
	}
	return SafeEqual(CyberSourceSign(c.cfg.SecretKey, params), params["signature"])
}

// signedOnly keeps only the fields listed in the response's signed_field_names.
func signedOnly(params map[string]string) map[string]string {
	out := map[string]string{}
	for _, n := range strings.Split(params["signed_field_names"], ",") {
		if v, ok := params[n]; ok {
			out[n] = v
		}
	}
	return out
}

// Initiate returns a form POST to /pay. OrderID -> transaction_uuid AND reference_number (<= 50 chars).
// Every field, including bill_to_*, is signed; unsigned_field_names is sent empty.
func (c *CyberSource) Initiate(_ context.Context, in InitiateInput) (InitiateResult, error) {
	if err := AssertPaisa(in.AmountPaisa, ProviderCyberSource); err != nil {
		return InitiateResult{}, err
	}
	if utf16Len(in.OrderID) > 50 {
		return InitiateResult{}, newPaymentError(ProviderCyberSource, "invalid_order_id", "CyberSource ids must be <= 50 chars", 0, nil)
	}
	if in.CyberSource == nil {
		return InitiateResult{}, newPaymentError(ProviderCyberSource, "missing_bill_to", "CyberSource: InitiateInput.CyberSource.BillTo is required", 0, nil)
	}
	b := in.CyberSource.BillTo
	pairs := [][2]string{
		{"access_key", c.cfg.AccessKey},
		{"profile_id", c.cfg.ProfileID},
		{"transaction_uuid", in.OrderID},
		{"signed_date_time", SignedDateTime(time.Now())},
		{"locale", c.cfg.Locale},
		{"transaction_type", c.cfg.TransactionType},
		{"reference_number", in.OrderID},
		{"amount", amount2dp(in.AmountPaisa)}, // "1500.00"
		{"currency", c.cfg.Currency},
		{"bill_to_forename", b.Forename},
		{"bill_to_surname", b.Surname},
		{"bill_to_email", b.Email},
		{"bill_to_address_line1", b.AddressLine1},
		{"bill_to_address_city", b.City},
		{"bill_to_address_country", b.Country},
	}
	if b.Phone != "" {
		pairs = append(pairs, [2]string{"bill_to_phone", b.Phone})
	}
	if b.PostalCode != "" {
		pairs = append(pairs, [2]string{"bill_to_address_postal_code", b.PostalCode})
	}
	if b.State != "" {
		pairs = append(pairs, [2]string{"bill_to_address_state", b.State})
	}
	if c.cfg.UseReturnURLOverride {
		pairs = append(pairs, [2]string{"override_custom_receipt_page", in.ReturnURL})
		if in.FailureURL != "" {
			pairs = append(pairs, [2]string{"override_custom_cancel_page", in.FailureURL})
		}
	}
	idx := make([]int, 0, len(in.CyberSource.MerchantDefinedData))
	for i := range in.CyberSource.MerchantDefinedData {
		idx = append(idx, i)
	}
	sort.Ints(idx)
	for _, i := range idx {
		pairs = append(pairs, [2]string{fmt.Sprintf("merchant_defined_data%d", i), in.CyberSource.MerchantDefinedData[i]})
	}
	r := formResult(c.host+"/pay", pairs)
	signed := append(append([]string{}, r.FieldOrder...), "unsigned_field_names", "signed_field_names")
	r.Fields["unsigned_field_names"] = ""
	r.Fields["signed_field_names"] = strings.Join(signed, ",")
	r.Fields["signature"] = CyberSourceSign(c.cfg.SecretKey, r.Fields)
	r.FieldOrder = append(signed, "signature")
	return r, nil
}

// Verify checks the signed response POST (pass its body as Callback). Secure Acceptance has no simple
// status API: the signed response IS the proof. Only signed fields are used. For reconciliation without a
// callback, use the REST Transaction Search via the official SDK (references/cybersource.md).
func (c *CyberSource) Verify(_ context.Context, in VerifyInput) (VerifyResult, error) {
	if in.Callback == nil {
		return VerifyResult{}, newPaymentError(ProviderCyberSource, "verify_unavailable",
			"CyberSource SA: verification needs the signed response POST; use REST transaction search for reconciliation", 0, nil)
	}
	if !c.ResponseValid(in.Callback) {
		return VerifyResult{}, newPaymentError(ProviderCyberSource, "invalid_signature", "CyberSource: invalid response signature — treat as malicious", 400, nil)
	}
	p := signedOnly(in.Callback)
	ref, ok := p["req_reference_number"]
	if ref == "" { // JS ||: an empty reference number falls back too
		ref, ok = p["req_transaction_uuid"]
	}
	if !ok || ref != in.OrderID {
		return VerifyResult{}, newPaymentError(ProviderCyberSource, "callback_mismatch", "CyberSource: response is for a different order", 400, p)
	}
	if cur := p["req_currency"]; cur != "" && cur != c.cfg.Currency {
		return VerifyResult{}, newPaymentError(ProviderCyberSource, "currency_mismatch", "CyberSource: currency mismatch", 400, p)
	}
	paid := firstNonEmpty(p["auth_amount"], p["req_amount"])
	txnType, ok := p["req_transaction_type"]
	if !ok {
		txnType = c.cfg.TransactionType
	}
	var amount *int64
	if paid != "" {
		n, err := RupeesToPaisa(paid)
		if err != nil {
			return VerifyResult{}, err
		}
		amount = &n
	}
	// reason 110 = partial approval: auth_amount < requested; DecideTransition's amount guard catches it.
	return VerifyResult{
		Provider: ProviderCyberSource, Status: cyberSourceDecision(p["decision"], p["reason_code"], txnType),
		OrderID: in.OrderID, AmountPaisa: amount, TransactionID: p["transaction_id"], Raw: p,
	}, nil
}

// OrderIDFromCallback returns req_reference_number (or req_transaction_uuid).
func (c *CyberSource) OrderIDFromCallback(params map[string]string) string {
	return firstNonEmpty(params["req_reference_number"], params["req_transaction_uuid"])
}

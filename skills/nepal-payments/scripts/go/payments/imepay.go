package payments

// IME Pay web checkout. Source: IME Pay's official WooCommerce + WHMCS plugins.
// IME Pay merged into Khalti ("Khalti by IME", July 2025): prefer Khalti for new builds.
//
// Auth: Basic base64(username:password) + header `Module: base64(moduleName)`. No HMAC; callbacks are
// UNSIGNED, so Recheck is the only proof of payment. Port 7979 must be reachable outbound.

import (
	"context"
	"fmt"
	"strings"
	"time"
)

// IMEPayConfig configures the IME Pay adapter.
type IMEPayConfig struct {
	Env          Env
	MerchantCode string
	Username     string
	Password     string
	Module       string
	BaseURL      string
	Timeout      time.Duration // default 20s
	HTTPClient   Doer
}

var imePayBase = map[Env]string{EnvSandbox: "https://stg.imepay.com.np:7979", EnvProduction: "https://payment.imepay.com.np:7979"}

// IMEPay is the IME Pay adapter.
type IMEPay struct {
	cfg     IMEPayConfig
	base    string
	headers [][2]string
	timeout time.Duration
	client  Doer
}

var _ Adapter = (*IMEPay)(nil)

// NewIMEPay builds the IME Pay adapter.
func NewIMEPay(cfg IMEPayConfig) (*IMEPay, error) {
	base, ok := imePayBase[cfg.Env]
	if !ok {
		return nil, errInvalidEnv(ProviderIMEPay, cfg.Env)
	}
	if cfg.MerchantCode == "" || cfg.Username == "" {
		return nil, errMissingConfig(ProviderIMEPay, "MerchantCode and Username")
	}
	return &IMEPay{
		cfg:     cfg,
		base:    orDefault(cfg.BaseURL, base),
		headers: [][2]string{{"Authorization", BasicAuth(cfg.Username, cfg.Password)}, {"Module", ToBase64([]byte(cfg.Module))}},
		timeout: durOr(cfg.Timeout, 20*time.Second),
		client:  cfg.HTTPClient,
	}, nil
}

// ID returns ProviderIMEPay.
func (i *IMEPay) ID() ProviderID { return ProviderIMEPay }

// Initiate calls GetToken and returns a redirect to WebCheckout with the base64 payload. IME POSTs the
// result (ResponseCode, RefId, TransactionId, TranAmount, Msisdn) to RespUrl / CancelUrl.
// ProviderRef = TokenId (persist it).
func (i *IMEPay) Initiate(ctx context.Context, in InitiateInput) (InitiateResult, error) {
	if err := AssertPaisa(in.AmountPaisa, ProviderIMEPay); err != nil {
		return InitiateResult{}, err
	}
	amount := amount2dp(in.AmountPaisa) // "100.00"
	body := jsonObject{{"MerchantCode", i.cfg.MerchantCode}, {"Amount", amount}, {"RefId", in.OrderID}}
	res, err := doHTTP(ctx, i.client, ProviderIMEPay, httpRequest{method: "POST", url: i.base + "/api/Web/GetToken", headers: i.headers, body: jsonBody(body), timeout: i.timeout})
	if err != nil {
		return InitiateResult{}, err
	}
	token, _ := get(res.data, "TokenId")
	rc, hasRC := getNonNull(res.data, "ResponseCode")
	rcPresent := false
	if _, ok := get(res.data, "ResponseCode"); ok {
		rcPresent = true
	}
	if res.status != 200 || !truthy(token) || jsTemplate(rc, rcPresent) != "0" {
		msg := truncateUTF16(res.text, 200)
		if v, ok := getNonNull(res.data, "ResponseDescription"); ok {
			msg = jsString(v)
		}
		code := fmt.Sprintf("imepay_%d", res.status)
		if hasRC {
			code = "imepay_" + jsString(rc)
		}
		return InitiateResult{}, newPaymentError(ProviderIMEPay, code, "IME Pay GetToken failed: "+msg, res.status, res.data)
	}
	tokenID := jsString(token)
	payload := strings.Join([]string{tokenID, i.cfg.MerchantCode, in.OrderID, amount, "POST", in.ReturnURL, orDefault(in.FailureURL, in.ReturnURL)}, "|")
	return InitiateResult{
		Kind:        KindRedirect,
		URL:         i.base + "/WebCheckout/Checkout?data=" + encodeURIComponent(ToBase64([]byte(payload))),
		ProviderRef: tokenID,
		Raw:         res.data,
	}, nil
}

// Verify calls Recheck (authoritative). ResponseCode 0 = paid. Other codes are inconsistently
// documented (1 = failed vs pending), so they stay pending; the reconciliation job escalates at its cutoff.
func (i *IMEPay) Verify(ctx context.Context, in VerifyInput) (VerifyResult, error) {
	if in.ProviderRef == "" {
		return VerifyResult{}, newPaymentError(ProviderIMEPay, "missing_token", "IME Pay: stored TokenId required for verify", 0, nil)
	}
	body := jsonObject{{"MerchantCode", i.cfg.MerchantCode}, {"RefId", in.OrderID}, {"TokenId", in.ProviderRef}}
	res, err := doHTTP(ctx, i.client, ProviderIMEPay, httpRequest{method: "POST", url: i.base + "/api/Web/Recheck", headers: i.headers, body: jsonBody(body), timeout: i.timeout, retries: 2})
	if err != nil {
		return VerifyResult{}, err
	}
	d, _ := res.data.(map[string]any)
	rc, hasRC := d["ResponseCode"]
	if res.status != 200 || !hasRC {
		return VerifyResult{}, newPaymentError(ProviderIMEPay, fmt.Sprintf("http_%d", res.status), "IME Pay Recheck failed: "+truncateUTF16(res.text, 200), res.status, res.data)
	}
	if ref := d["RefId"]; truthy(ref) && !isString(ref, in.OrderID) {
		return VerifyResult{}, newPaymentError(ProviderIMEPay, "callback_mismatch", "IME Pay: Recheck is for a different RefId", 400, d)
	}
	status := StatusPending
	if jsString(rc) == "0" {
		status = StatusPaid
	}
	var amount *int64
	if ta, ok := d["TranAmount"]; ok && ta != nil && !isString(ta, "") {
		p, err := paisaFromValue(ta)
		if err != nil {
			return VerifyResult{}, err
		}
		amount = &p
	}
	txn := ""
	if t := d["TransactionId"]; truthy(t) {
		txn = jsString(t)
	}
	return VerifyResult{Provider: ProviderIMEPay, Status: status, OrderID: in.OrderID, AmountPaisa: amount, TransactionID: txn, Raw: d}, nil
}

// OrderIDFromCallback returns RefId.
func (i *IMEPay) OrderIDFromCallback(params map[string]string) string { return params["RefId"] }

package payments

// GetPay (NCHL card gateway for Nepali banks: Visa/Mastercard with 3-D Secure): https://getpay.global/web-integration/
// Credentials come from the acquiring bank: papInfo (base64 {institutionId, mid, tid}), oprKey, insKey (blank when
// operator-hosted), the bundle URL and the base URL.
//
// Flow (browser SDK, four pages): checkout page loads bundle.js and runs new GetPay(options).initialize()
//   -> onSuccess navigates to the payment page (<div id="checkout">, card form + 3DS)
//   -> GetPay redirects to successUrl / failUrl with token=base64(JSON {id, oprSecret}) in the query or the #hash
//   -> server: oprSecret == base64(SHA-256(oprKey + id)), then POST {base}/merchant-status {id, papInfo}.
//
// merchant-status answers for ANY transaction id regardless of papInfo (checked 2026-11 on UAT), so a paid status
// only counts when the token's oprSecret matches YOUR oprKey and data.clientId is YOUR OrderID.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"strings"
	"time"
)

// GetPayConfig configures the GetPay adapter.
type GetPayConfig struct {
	Env Env
	// PapInfo is base64 {"institutionId","mid","tid"} from the bank.
	PapInfo string
	// OprKey is the operator key from the bank. It also reaches the browser (GetPay's design); it is not a secret.
	OprKey string
	InsKey string
	// WebsiteDomain is your site origin, e.g. "https://shop.example". GetPay requires the callback URLs on this host.
	WebsiteDomain string
	BusinessName  string
	// ImageURL is the logo shown on the checkout page (absolute URL).
	ImageURL   string
	Currency   string // default "NPR"
	ThemeColor string // default "#5662FF"
	BundleURL  string
	BaseURL    string
	Timeout    time.Duration // default 20s
	HTTPClient Doer
}

// GetPayInitiateOptions are GetPay-only initiate fields.
type GetPayInitiateOptions struct {
	// OrderInformationUI is the HTML shown beside the card form; empty means a description + amount block.
	OrderInformationUI string
	// AllowBillingAddressFields defaults to true.
	AllowBillingAddressFields *bool
}

// GetPayStatementQuery selects a transaction-statement by TransactionID or ClientRequestID (set one).
type GetPayStatementQuery struct {
	TransactionID   string
	ClientRequestID string
}

// GetPayToken is the decoded return token.
type GetPayToken struct {
	ID        string
	OprSecret string
}

var getPayBase = map[Env]string{
	EnvSandbox:    "https://uat-bank-getpay.nchl.com.np/ecom-web-checkout/v1/secure-merchant/transactions",
	EnvProduction: "https://ecom-getpay.nchl.com.np/ecom-web-checkout/v1/secure-merchant/transactions",
}

const getPayBundle = "https://minio-getpay.nchl.com.np/getpay-cdn/webcheckout/v5/bundle.js"

var getPayTxnStatus = map[string]PaymentStatus{
	"SUCCESS":   StatusPaid,
	"APPROVED":  StatusPaid,
	"FAILED":    StatusFailed,
	"FAILURE":   StatusFailed,
	"DECLINED":  StatusFailed,
	"PENDING":   StatusPending,
	"CANCELLED": StatusCanceled,
	"CANCELED":  StatusCanceled,
}

var (
	getPayClientIDRe = regexp.MustCompile(`^[A-Za-z0-9-]{1,50}$`)
	getPayNotFoundRe = regexp.MustCompile(`(?i)not found`)
)

// GetPayOprSecret is base64(SHA-256(oprKey + transactionID)): the oprSecret GetPay puts in the return token.
func GetPayOprSecret(oprKey, transactionID string) string {
	return ToBase64(SHA256([]byte(oprKey + transactionID)))
}

// GetPayDecodeToken decodes the return token. GetPay sends base64 JSON {id, oprSecret}; one integration
// reports "id:oprSecret". ok is false when neither form fits.
func GetPayDecodeToken(token string) (t GetPayToken, ok bool) {
	// FromBase64 turns spaces back into "+" before trimming, so pass the token untouched.
	b, err := FromBase64(token)
	if err != nil {
		return GetPayToken{}, false
	}
	text := strings.ToValidUTF8(string(b), "�")
	if v, err := decodeJSON(text); err == nil {
		id, _ := get(v, "id")
		sec, _ := get(v, "oprSecret")
		ids, ok1 := id.(string)
		secs, ok2 := sec.(string)
		if ok1 && ok2 && ids != "" && secs != "" {
			return GetPayToken{ID: ids, OprSecret: secs}, true
		}
		return GetPayToken{}, false
	}
	if i := strings.Index(text, ":"); i > 0 && i < len(text)-1 {
		return GetPayToken{ID: text[:i], OprSecret: text[i+1:]}, true
	}
	return GetPayToken{}, false
}

// urlOrigin mirrors new URL(s).origin for http(s) URLs: lowercased scheme and host, default port dropped.
func urlOrigin(s string) (string, error) {
	u, err := url.Parse(jsTrim(s))
	if err != nil {
		return "", err
	}
	scheme := strings.ToLower(u.Scheme)
	if (scheme != "http" && scheme != "https") || u.Host == "" {
		return "", fmt.Errorf("not an absolute http(s) URL: %s", s)
	}
	host, port := strings.ToLower(u.Hostname()), u.Port()
	if strings.Contains(host, ":") {
		host = "[" + host + "]"
	}
	if port != "" && !(scheme == "https" && port == "443") && !(scheme == "http" && port == "80") {
		host += ":" + port
	}
	return scheme + "://" + host, nil
}

// GetPay is the GetPay adapter.
type GetPay struct {
	cfg       GetPayConfig
	base      string
	bundleURL string
	origin    string
	timeout   time.Duration
	client    Doer
}

var _ Adapter = (*GetPay)(nil)

// NewGetPay builds the GetPay adapter.
func NewGetPay(cfg GetPayConfig) (*GetPay, error) {
	base, ok := getPayBase[cfg.Env]
	if !ok {
		return nil, errInvalidEnv(ProviderGetPay, cfg.Env)
	}
	if cfg.PapInfo == "" || cfg.OprKey == "" {
		return nil, errMissingConfig(ProviderGetPay, "PapInfo and OprKey")
	}
	origin, err := urlOrigin(cfg.WebsiteDomain)
	if err != nil {
		return nil, errMissingConfig(ProviderGetPay, "WebsiteDomain (an absolute http(s) URL)")
	}
	return &GetPay{
		cfg:       cfg,
		base:      strings.TrimSuffix(orDefault(cfg.BaseURL, base), "/"),
		bundleURL: orDefault(cfg.BundleURL, getPayBundle),
		origin:    origin,
		timeout:   durOr(cfg.Timeout, 20*time.Second),
		client:    cfg.HTTPClient,
	}, nil
}

// ID returns ProviderGetPay.
func (g *GetPay) ID() ProviderID { return ProviderGetPay }

// call POSTs to merchant-status or transaction-statement. A "not found" answer is (nil, nil).
func (g *GetPay) call(ctx context.Context, path string, body jsonObject) (map[string]any, error) {
	res, err := doHTTP(ctx, g.client, ProviderGetPay, httpRequest{
		method: "POST", url: g.base + "/" + path, body: jsonBody(body), timeout: g.timeout, retries: 2,
	})
	if err != nil {
		return nil, err
	}
	st, _ := get(res.data, "status")
	code, isNum := jsonInt(st)
	msg, _ := get(res.data, "message")
	if isNum && code == -1 && getPayNotFoundRe.MatchString(jsTemplate(msg, msg != nil)) {
		return nil, nil
	}
	data, _ := get(res.data, "data")
	d, ok := data.(map[string]any)
	if res.status != 200 || !isNum || code != 0 || !ok {
		m := truncateUTF16(res.text, 200)
		if v, ok := getNonNull(res.data, "message"); ok {
			m = jsString(v)
		}
		return nil, newPaymentError(ProviderGetPay, fmt.Sprintf("http_%d", res.status), "GetPay "+path+" failed: "+m, res.status, res.data)
	}
	return d, nil
}

// Initiate returns the options for the browser SDK (KindSDK). clientRequestId = OrderID. ReturnURL / FailureURL
// must be on WebsiteDomain and must serve ReturnPage() (the token can arrive in the #hash, which only the browser sees).
func (g *GetPay) Initiate(_ context.Context, in InitiateInput) (InitiateResult, error) {
	if err := AssertPaisa(in.AmountPaisa, ProviderGetPay); err != nil {
		return InitiateResult{}, err
	}
	if !getPayClientIDRe.MatchString(in.OrderID) {
		return InitiateResult{}, newPaymentError(ProviderGetPay, "invalid_order_id", "GetPay clientRequestId must be 1–50 chars [A-Za-z0-9-]", 0, nil)
	}
	failURL := orDefault(in.FailureURL, in.ReturnURL)
	for _, u := range []string{in.ReturnURL, failURL} {
		if o, err := urlOrigin(u); err != nil || o != g.origin {
			return InitiateResult{}, newPaymentError(ProviderGetPay, "invalid_callback_url", "GetPay callback "+u+" must be on websiteDomain "+g.origin, 0, nil)
		}
	}
	var o GetPayInitiateOptions
	if in.GetPay != nil {
		o = *in.GetPay
	}
	var c Customer
	if in.Customer != nil {
		c = *in.Customer
	}
	currency := orDefault(g.cfg.Currency, "NPR")
	allowBilling := o.AllowBillingAddressFields == nil || *o.AllowBillingAddressFields
	info := o.OrderInformationUI
	if info == "" {
		info = `<div style="font-family:sans-serif"><h3>` + EscapeHTML(in.Description) + `</h3><p>` + EscapeHTML(currency) + " " + amount2dp(in.AmountPaisa) + `</p></div>`
	}
	return InitiateResult{
		Kind:      KindSDK,
		ScriptURL: g.bundleURL,
		Options: map[string]any{
			"clientRequestId":           in.OrderID,
			"papInfo":                   g.cfg.PapInfo,
			"oprKey":                    g.cfg.OprKey,
			"insKey":                    g.cfg.InsKey,
			"websiteDomain":             g.origin,
			"baseUrl":                   g.base,
			"price":                     float64(in.AmountPaisa) / 100, // GetPay wants a number, not a string
			"currency":                  currency,
			"businessName":              g.cfg.BusinessName,
			"imageUrl":                  g.cfg.ImageURL,
			"themeColor":                orDefault(g.cfg.ThemeColor, "#5662FF"),
			"allowBillingAddressFields": allowBilling,
			"userInfo":                  map[string]any{"name": c.Name, "email": c.Email, "state": "", "country": "", "zipcode": "", "city": "", "address": ""},
			"prefill":                   map[string]any{"name": c.Name != "", "email": c.Email != "", "state": false, "city": false, "address": false, "zipcode": false, "country": false},
			"disableFields":             map[string]any{},
			"callbackUrl":               map[string]any{"successUrl": in.ReturnURL, "failUrl": failURL},
			"orderInformationUI":        info,
		},
	}, nil
}

// Verify with Callback["token"]: checks oprSecret against OprKey, then merchant-status, then the transaction must
// carry your OrderID. Without a token (reconciliation): transaction-statement by clientRequestId, which cannot prove
// the transaction is yours, so a success there comes back "unknown" for manual review.
func (g *GetPay) Verify(ctx context.Context, in VerifyInput) (VerifyResult, error) {
	token := in.Callback["token"]
	if token == "" {
		s, err := g.call(ctx, "transaction-statement", jsonObject{{"clientRequestId", in.OrderID}})
		if err != nil {
			return VerifyResult{}, err
		}
		if s == nil {
			return VerifyResult{Provider: ProviderGetPay, Status: StatusNotFound, OrderID: in.OrderID}, nil
		}
		st := getPayStatus(s)
		if st == StatusPaid {
			st = StatusUnknown
		}
		amount, err := getPayAmount(s, "saleTransactionAmount")
		if err != nil {
			return VerifyResult{}, err
		}
		txn, _ := s["transactionId"].(string)
		return VerifyResult{Provider: ProviderGetPay, Status: st, OrderID: in.OrderID, AmountPaisa: amount, TransactionID: txn, Raw: s}, nil
	}
	t, ok := GetPayDecodeToken(token)
	if !ok {
		return VerifyResult{}, newPaymentError(ProviderGetPay, "malformed_callback", "GetPay: return token is not base64 {id, oprSecret}", 400, nil)
	}
	if !SafeEqual(GetPayOprSecret(g.cfg.OprKey, t.ID), t.OprSecret) {
		return VerifyResult{}, newPaymentError(ProviderGetPay, "bad_signature", "GetPay: oprSecret does not match oprKey + id", 400, map[string]any{"id": t.ID})
	}
	d, err := g.Status(ctx, t.ID)
	if err != nil {
		return VerifyResult{}, err
	}
	if d == nil {
		return VerifyResult{Provider: ProviderGetPay, Status: StatusNotFound, OrderID: in.OrderID, TransactionID: t.ID}, nil
	}
	if strOrEmpty(d, "clientId") != in.OrderID {
		return VerifyResult{}, newPaymentError(ProviderGetPay, "id_mismatch", "GetPay: transaction belongs to a different clientRequestId", 400, d)
	}
	amount, err := getPayAmount(d, "amount")
	if err != nil {
		return VerifyResult{}, err
	}
	return VerifyResult{Provider: ProviderGetPay, Status: getPayStatus(d), OrderID: in.OrderID, AmountPaisa: amount, TransactionID: t.ID, Raw: d}, nil
}

func getPayStatus(d map[string]any) PaymentStatus {
	if s, ok := getPayTxnStatus[strings.ToUpper(strOrEmpty(d, "status"))]; ok {
		return s
	}
	return StatusUnknown
}

func getPayAmount(d map[string]any, key string) (*int64, error) {
	a, ok := getNonNull(d, key)
	if !ok {
		return nil, nil
	}
	p, err := paisaFromValue(a)
	if err != nil {
		return nil, err
	}
	return &p, nil
}

// Status calls merchant-status by GetPay transaction id: {status, amount, currency, stan, crrn, clientId, remarks};
// nil if unknown.
func (g *GetPay) Status(ctx context.Context, transactionID string) (map[string]any, error) {
	return g.call(ctx, "merchant-status", jsonObject{{"id", transactionID}, {"papInfo", g.cfg.PapInfo}})
}

// Statement calls transaction-statement (payer, masked PAN, scheme, stan, crrn) by TransactionID or
// ClientRequestID; nil if unknown.
func (g *GetPay) Statement(ctx context.Context, q GetPayStatementQuery) (map[string]any, error) {
	var body jsonObject
	if q.TransactionID != "" {
		body = append(body, jsonKV{"transactionId", q.TransactionID})
	}
	if q.ClientRequestID != "" {
		body = append(body, jsonKV{"clientRequestId", q.ClientRequestID})
	}
	if len(body) == 0 {
		return nil, errors.New("getpay: Statement needs TransactionID or ClientRequestID")
	}
	return g.call(ctx, "transaction-statement", body)
}

// OrderIDFromCallback returns clientRequestId or orderId. GetPay adds only the token to YOUR return URL, so put
// the OrderID in the route path and extract it from there instead.
func (g *GetPay) OrderIDFromCallback(params map[string]string) string {
	return firstNonEmpty(params["clientRequestId"], params["orderId"])
}

// scriptJSON is JSON for a <script> block: "<" escaped as \u003c so the data cannot close the tag.
func scriptJSON(v any) (string, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return "", err
	}
	return strings.ReplaceAll(strings.TrimRight(buf.String(), "\n"), "<", `\u003c`), nil
}

var errNotSDK = errors.New("payments: CheckoutPage needs an sdk result")

// CheckoutPage is page 1: loads the bundle and starts checkout; onSuccess opens paymentPageURL.
func (g *GetPay) CheckoutPage(r InitiateResult, paymentPageURL string) (string, error) {
	if r.Kind != KindSDK {
		return "", errNotSDK
	}
	opts, err := scriptJSON(r.Options)
	if err != nil {
		return "", err
	}
	next := strings.ReplaceAll(jsJSONString(paymentPageURL), "<", `\u003c`)
	return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Checkout</title>
<script defer src="` + EscapeHTML(r.ScriptURL) + `"></script></head><body><div id="checkout" hidden></div><noscript>JavaScript is required to pay by card.</noscript>
<script>window.addEventListener("load",function(){var o=` + opts + `;o.onSuccess=function(){location.href=` + next + `};o.onError=function(e){document.body.insertAdjacentHTML("beforeend","<p>Card checkout could not start. Please try again.</p>");console.error(e)};new GetPay(o).initialize()});</script></body></html>`, nil
}

// PaymentPage is page 2: GetPay renders the card form into #checkout.
func (g *GetPay) PaymentPage() string {
	return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pay by card</title>
<script defer src="` + EscapeHTML(g.bundleURL) + `"></script></head><body><div id="checkout"></div></body></html>`
}

// ReturnPage serves pages 3 and 4 (success and fail URLs): breaks out of GetPay's iframe, reads the token from the
// query or the #hash, and sends it to verifyURL as ?token=. Your server then calls Verify with Callback["token"].
func (g *GetPay) ReturnPage(verifyURL string) string {
	target := strings.ReplaceAll(jsJSONString(verifyURL), "<", `\u003c`)
	return `<!doctype html><html><head><meta charset="utf-8"><title>Confirming payment</title></head><body><p>Confirming your payment...</p>
<script>if(window.top!==window.self){window.top.location=window.self.location.href}else{var h=location.hash||"",q=new URLSearchParams(location.search);var t=q.get("token")||new URLSearchParams(h.indexOf("?")>=0?h.slice(h.indexOf("?")+1):h.replace(/^#/,"")).get("token");var u=new URL(` + target + `,location.href);if(t)u.searchParams.set("token",t);location.replace(u.toString())}</script></body></html>`
}

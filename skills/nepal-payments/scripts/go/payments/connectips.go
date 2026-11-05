package payments

// connectIPS (NCHL) e-payment gateway — https://doc.connectips.com/docs/connectIPS-Gateway/merchant-interface
// Onboarding via your bank -> NCHL emails MERCHANTID, APPID, APPNAME, app password and the creditor .pfx.
//
// Flow: server signs TOKEN (RSA-SHA256 with the creditor private key) -> auto-POST form to loginpage
//       -> connectIPS redirects to your registered success/failure URL with ?TXNID=... -> validatetxn (Basic auth).
//
// Key prep (once; the Go standard library cannot read .pfx):
//
//	openssl pkcs12 -in CREDITOR.pfx -nocerts -nodes [-legacy] | openssl pkcs8 -topk8 -nocrypt -out creditor.key.pem

import (
	"context"
	"crypto/rsa"
	"encoding/json"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// ConnectIPSConfig configures the connectIPS adapter.
type ConnectIPSConfig struct {
	Env        Env
	MerchantID string // e.g. "550"
	AppID      string // e.g. "MER-550-APP-1"
	AppName    string // <= 30 chars
	// AppPassword is used for Basic auth on validatetxn / gettxndetail.
	AppPassword string
	// PrivateKeyPEM is the creditor RSA key as PKCS#8 ("BEGIN PRIVATE KEY") or PKCS#1 ("BEGIN RSA PRIVATE KEY")
	// PEM; see ParseRSAPrivateKeyPEM for the .pfx conversion.
	PrivateKeyPEM string
	BaseURL       string
	Timeout       time.Duration // default 20s
	HTTPClient    Doer
}

// ConnectIPSInitiateOptions are connectIPS-only initiate fields (defaults: OrderID / Description).
type ConnectIPSInitiateOptions struct {
	ReferenceID string
	Remarks     string
	Particulars string
}

var connectIPSBase = map[Env]string{EnvSandbox: "https://uat.connectips.com", EnvProduction: "https://login.connectips.com"}

// ConnectIPSDate formats t as DD-MM-YYYY in Asia/Kathmandu.
func ConnectIPSDate(t time.Time) string { return t.In(kathmandu()).Format("02-01-2006") }

// ConnectIPSTokenString is the exact string connectIPS expects to be signed for the gateway form.
func ConnectIPSTokenString(f map[string]string) string {
	return "MERCHANTID=" + f["MERCHANTID"] + ",APPID=" + f["APPID"] + ",APPNAME=" + f["APPNAME"] + ",TXNID=" + f["TXNID"] +
		",TXNDATE=" + f["TXNDATE"] + ",TXNCRNCY=" + f["TXNCRNCY"] + ",TXNAMT=" + f["TXNAMT"] + ",REFERENCEID=" + f["REFERENCEID"] +
		",REMARKS=" + f["REMARKS"] + ",PARTICULARS=" + f["PARTICULARS"] + ",TOKEN=TOKEN"
}

// clip removes commas/equals (they would corrupt the token string) and cuts to n chars.
func clip(s string, n int) string {
	return truncateUTF16(strings.NewReplacer(",", " ", "=", " ").Replace(s), n)
}

// ConnectIPS is the connectIPS adapter.
type ConnectIPS struct {
	cfg     ConnectIPSConfig
	key     *rsa.PrivateKey
	base    string
	auth    string
	timeout time.Duration
	client  Doer
}

var _ Adapter = (*ConnectIPS)(nil)

// NewConnectIPS builds the connectIPS adapter; the private key is parsed once here.
func NewConnectIPS(cfg ConnectIPSConfig) (*ConnectIPS, error) {
	base, ok := connectIPSBase[cfg.Env]
	if !ok {
		return nil, errInvalidEnv(ProviderConnectIPS, cfg.Env)
	}
	if cfg.MerchantID == "" || cfg.AppID == "" || cfg.PrivateKeyPEM == "" {
		return nil, errMissingConfig(ProviderConnectIPS, "MerchantID, AppID and PrivateKeyPEM")
	}
	key, err := ParseRSAPrivateKeyPEM(cfg.PrivateKeyPEM)
	if err != nil {
		return nil, &PaymentError{Provider: ProviderConnectIPS, Code: "invalid_config", Message: "connectips: private key: " + err.Error(), Err: err}
	}
	return &ConnectIPS{
		cfg:     cfg,
		key:     key,
		base:    orDefault(cfg.BaseURL, base),
		auth:    BasicAuth(cfg.AppID, cfg.AppPassword),
		timeout: durOr(cfg.Timeout, 20*time.Second),
		client:  cfg.HTTPClient,
	}, nil
}

// ID returns ProviderConnectIPS.
func (c *ConnectIPS) ID() ProviderID { return ProviderConnectIPS }

var connectIPSTxnIDRe = regexp.MustCompile(`^[A-Za-z0-9-]{1,20}$`)

// Initiate returns a form POST to the connectIPS login page. TXNID = OrderID (<= 20 chars, unique per app),
// TXNAMT is in PAISA. Success/failure redirect URLs are REGISTERED WITH NCHL; ReturnURL is unused.
func (c *ConnectIPS) Initiate(_ context.Context, in InitiateInput) (InitiateResult, error) {
	if err := AssertPaisa(in.AmountPaisa, ProviderConnectIPS); err != nil {
		return InitiateResult{}, err
	}
	if !connectIPSTxnIDRe.MatchString(in.OrderID) {
		return InitiateResult{}, newPaymentError(ProviderConnectIPS, "invalid_order_id", "connectIPS TXNID must be 1–20 chars [A-Za-z0-9-]", 0, nil)
	}
	var o ConnectIPSInitiateOptions
	if in.ConnectIPS != nil {
		o = *in.ConnectIPS
	}
	r := formResult(c.base+"/connectipswebgw/loginpage", [][2]string{
		{"MERCHANTID", c.cfg.MerchantID},
		{"APPID", c.cfg.AppID},
		{"APPNAME", truncateUTF16(c.cfg.AppName, 30)},
		{"TXNID", in.OrderID},
		{"TXNDATE", ConnectIPSDate(time.Now())},
		{"TXNCRNCY", "NPR"},
		{"TXNAMT", strconv.FormatInt(in.AmountPaisa, 10)}, // PAISA
		{"REFERENCEID", clip(orDefault(o.ReferenceID, in.OrderID), 20)},
		{"REMARKS", orDefault(clip(orDefault(o.Remarks, in.Description), 50), "Payment")},
		{"PARTICULARS", orDefault(clip(orDefault(o.Particulars, in.Description), 100), "Payment")},
	})
	token, err := rsaSign(c.key, ConnectIPSTokenString(r.Fields))
	if err != nil {
		return InitiateResult{}, err
	}
	r.Fields["TOKEN"] = token
	r.FieldOrder = append(r.FieldOrder, "TOKEN")
	return r, nil
}

func (c *ConnectIPS) validationCall(ctx context.Context, path, txnID string, amountPaisa int64) (map[string]any, error) {
	tokenString := fmt.Sprintf("MERCHANTID=%s,APPID=%s,REFERENCEID=%s,TXNAMT=%d", c.cfg.MerchantID, c.cfg.AppID, txnID, amountPaisa)
	token, err := rsaSign(c.key, tokenString)
	if err != nil {
		return nil, err
	}
	body := jsonObject{
		{"merchantId", jsNumberValue(c.cfg.MerchantID)},
		{"appId", c.cfg.AppID},
		{"referenceId", txnID}, // NOTE: the TXNID you sent, not REFERENCEID
		{"txnAmt", amountPaisa},
		{"token", token},
	}
	res, err := doHTTP(ctx, c.client, ProviderConnectIPS, httpRequest{
		method: "POST", url: c.base + "/connectipswebws/api/creditor/" + path,
		headers: [][2]string{{"Authorization", c.auth}}, body: jsonBody(body), timeout: c.timeout, retries: 2,
	})
	if err != nil {
		return nil, err
	}
	if res.status == 401 {
		return nil, newPaymentError(ProviderConnectIPS, "unauthorized", "connectIPS: 401 — wrong APPID/app password", 401, nil)
	}
	st, _ := get(res.data, "status")
	if res.status != 200 || !truthy(st) {
		return nil, newPaymentError(ProviderConnectIPS, fmt.Sprintf("http_%d", res.status), "connectIPS "+path+" failed: "+truncateUTF16(res.text, 200), res.status, res.data)
	}
	return res.data.(map[string]any), nil
}

// jsNumberValue mirrors JSON.stringify(Number(s)): a JSON number, or null when NaN/infinite.
func jsNumberValue(s string) any {
	t := jsTrim(s)
	if t == "" {
		return json.Number("0")
	}
	if !jsDecimalRe.MatchString(t) {
		return nil
	}
	f, err := strconv.ParseFloat(t, 64)
	if err != nil {
		return nil
	}
	return json.Number(jsFormatFloat(f))
}

// Verify calls validatetxn (authoritative). SUCCESS + amount match = paid.
func (c *ConnectIPS) Verify(ctx context.Context, in VerifyInput) (VerifyResult, error) {
	r, err := c.validationCall(ctx, "validatetxn", in.OrderID, in.AmountPaisa)
	if err != nil {
		return VerifyResult{}, err
	}
	desc := strings.ToUpper(strOrEmpty(r, "statusDesc"))
	var status PaymentStatus
	switch {
	case isString(r["status"], "SUCCESS"):
		status = StatusPaid
	case isString(r["status"], "FAILED"):
		status = StatusFailed
	case strings.Contains(desc, "NOT FOUND"):
		status = StatusNotFound
	case strings.Contains(desc, "INCOMPLETE"):
		status = StatusPending // user hasn't finished OTP yet
	default:
		status = StatusUnknown
	}
	var amount *int64
	if v := r["txnAmt"]; v != nil { // null is "no amount", not 0
		if n, ok := jsNumberRounded(v); ok {
			amount = &n
		}
	}
	return VerifyResult{Provider: ProviderConnectIPS, Status: status, OrderID: in.OrderID, AmountPaisa: amount, Raw: r}, nil
}

// GetTxnDetail returns the full detail incl. NCHL txnId, bank, charges and creditStatus
// ("000"/"999"/"DEFER" = credited/OK).
func (c *ConnectIPS) GetTxnDetail(ctx context.Context, orderID string, amountPaisa int64) (map[string]any, error) {
	return c.validationCall(ctx, "gettxndetail", orderID, amountPaisa)
}

// OrderIDFromCallback returns TXNID (or txnId).
func (c *ConnectIPS) OrderIDFromCallback(params map[string]string) string {
	return firstNonEmpty(params["TXNID"], params["txnId"])
}

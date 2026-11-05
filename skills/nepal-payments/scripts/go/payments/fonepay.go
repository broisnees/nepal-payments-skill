package payments

// Fonepay — Web payment (redirect) + Dynamic QR.
// Source: "Technical Specification Document (Fonepay Web Integration) v2.0" + Dynamic QR spec v1.1 (2024).
//
// Signatures: HMAC-SHA512(secretKey UTF-8, comma-joined values) as HEX. Compared case-insensitively.
//
//	request DV       = PID,MD,PRN,AMT,CRN,DT,R1,R2,RU
//	response DV      = PRN,PID,PS,RC,UID,BC,INI,P_AMT,R_AMT   (raw strings as received)
//	txnVerification  = username,password,POST,application/json,/merchant/merchantDetailsForThirdParty/txnVerification,<exact JSON body>
//	QR create        = amount,prn,merchantCode,remarks1,remarks2
//	QR status        = prn,merchantCode
//	legacy verify    = PID,AMT,PRN,BID,UID

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"
)

// FonepayConfig configures the Fonepay adapter.
type FonepayConfig struct {
	Env Env
	// MerchantCode is the PID (3–20 chars). Public dev sample: "NBQM".
	MerchantCode string
	// SecretKey is the HMAC secret. Public dev sample: "a7e3512f5032480a83137793cb2021dc".
	SecretKey string
	// Username / Password (merchant panel) enable txnVerification (recommended) and Dynamic QR.
	Username string
	Password string
	// Endpoint overrides (Fonepay sometimes issues different hosts per merchant/bank).
	PaymentURL         string
	TxnVerificationURL string
	LegacyVerifyURL    string
	QRBaseURL          string
	// LenientSignature: when true, a missing/invalid callback DV is ignored instead of failing Verify
	// (TS strictSignature: false). Unsigned callback flags are never trusted either way.
	LenientSignature bool
	Timeout          time.Duration // default 15s
	HTTPClient       Doer
}

// FonepayInitiateOptions are Fonepay-only initiate fields.
type FonepayInitiateOptions struct {
	// Remarks2 is R2 (<= 50 chars); default "N/A".
	Remarks2 string
}

// FonepayQRInput creates a Dynamic QR.
type FonepayQRInput struct {
	OrderID     string
	AmountPaisa int64
	Remarks1    string
	Remarks2    string // default "N/A"
}

// FonepayQR is a created Dynamic QR. Render QRMessage as a QR code; listen on WebSocketURL or poll QRStatus.
type FonepayQR struct {
	QRMessage    string
	WebSocketURL string
	Raw          any
}

// FonepayLegacyRaw is VerifyResult.Raw for the legacy verification path.
type FonepayLegacyRaw struct {
	Callback     map[string]string `json:"callback"`
	Verification string            `json:"verification"`
}

type fonepayEndpoints struct{ payment, legacyVerify, txnVerification, qrBase string }

var fonepayURLs = map[Env]fonepayEndpoints{
	EnvSandbox: {
		payment:      "https://dev-clientapi.fonepay.com/api/merchantRequest",
		legacyVerify: "https://dev-clientapi.fonepay.com/api/merchantRequest/verificationMerchant",
		// Dev merchant API hosts are not in public DNS (Fonepay whitelists / issues them on onboarding).
		txnVerification: "https://dev-merchantapi.fonepay.com/api/merchant/merchantDetailsForThirdParty/txnVerification",
		qrBase:          "https://dev-merchantapi.fonepay.com/api/merchant/merchantDetailsForThirdParty",
	},
	EnvProduction: {
		payment:         "https://clientapi.fonepay.com/api/merchantRequest",
		legacyVerify:    "https://clientapi.fonepay.com/api/merchantRequest/verificationMerchant",
		txnVerification: "https://merchantapi.fonepay.com/api/merchant/merchantDetailsForThirdParty/txnVerification",
		qrBase:          "https://merchantapi.fonepay.com/api/merchant/merchantDetailsForThirdParty",
	},
}

var fonepayTxnStatus = map[string]PaymentStatus{"success": StatusPaid, "pending": StatusPending, "failed": StatusFailed}

const fonepayTxnResource = "/merchant/merchantDetailsForThirdParty/txnVerification"

var fonepayResponseDVFields = []string{"PRN", "PID", "PS", "RC", "UID", "BC", "INI", "P_AMT", "R_AMT"}

// FonepayHMAC returns uppercase hex HMAC-SHA512(secret, values joined by ",").
func FonepayHMAC(secret string, values []string) string {
	return strings.ToUpper(ToHex(HMACSHA512([]byte(secret), []byte(strings.Join(values, ",")))))
}

// FonepayDate formats t as MM/DD/YYYY in Asia/Kathmandu (Fonepay rejects other formats).
func FonepayDate(t time.Time) string { return t.In(kathmandu()).Format("01/02/2006") }

// Fonepay is the Fonepay web payment + Dynamic QR adapter.
type Fonepay struct {
	cfg     FonepayConfig
	urls    fonepayEndpoints
	timeout time.Duration
	client  Doer
}

var _ Adapter = (*Fonepay)(nil)

// NewFonepay builds the Fonepay adapter.
func NewFonepay(cfg FonepayConfig) (*Fonepay, error) {
	u, ok := fonepayURLs[cfg.Env]
	if !ok {
		return nil, errInvalidEnv(ProviderFonepay, cfg.Env)
	}
	if cfg.MerchantCode == "" || cfg.SecretKey == "" {
		return nil, errMissingConfig(ProviderFonepay, "MerchantCode and SecretKey")
	}
	return &Fonepay{
		cfg: cfg,
		urls: fonepayEndpoints{
			payment:         orDefault(cfg.PaymentURL, u.payment),
			legacyVerify:    orDefault(cfg.LegacyVerifyURL, u.legacyVerify),
			txnVerification: orDefault(cfg.TxnVerificationURL, u.txnVerification),
			qrBase:          orDefault(cfg.QRBaseURL, u.qrBase),
		},
		timeout: durOr(cfg.Timeout, 15*time.Second),
		client:  cfg.HTTPClient,
	}, nil
}

// ID returns ProviderFonepay.
func (f *Fonepay) ID() ProviderID { return ProviderFonepay }

func (f *Fonepay) sign(values ...string) string { return FonepayHMAC(f.cfg.SecretKey, values) }

// CallbackValid checks the response DV on the redirect params. A missing DV is invalid.
func (f *Fonepay) CallbackValid(params map[string]string) bool {
	dv := params["DV"]
	if dv == "" {
		return false
	}
	vals := make([]string, len(fonepayResponseDVFields))
	for i, k := range fonepayResponseDVFields {
		vals[i] = params[k]
	}
	return SafeEqual(FonepayHMAC(f.cfg.SecretKey, vals), strings.ToUpper(dv))
}

// Initiate returns the redirect URL for the Fonepay web payment page.
// PRN = OrderID (3–25 chars). Keep ReturnURL (RU) <= 150 chars and free of query strings.
func (f *Fonepay) Initiate(_ context.Context, in InitiateInput) (InitiateResult, error) {
	if err := AssertPaisa(in.AmountPaisa, ProviderFonepay); err != nil {
		return InitiateResult{}, err
	}
	if n := utf16Len(in.OrderID); n < 3 || n > 25 {
		return InitiateResult{}, newPaymentError(ProviderFonepay, "invalid_order_id", "Fonepay PRN must be 3–25 chars", 0, nil)
	}
	if utf16Len(in.ReturnURL) > 150 {
		return InitiateResult{}, newPaymentError(ProviderFonepay, "invalid_return_url", "Fonepay RU must be <= 150 chars", 0, nil)
	}
	r2 := "N/A"
	if in.Fonepay != nil && in.Fonepay.Remarks2 != "" {
		r2 = orDefault(truncateUTF16(in.Fonepay.Remarks2, 50), "N/A")
	}
	p := [][2]string{
		{"PID", f.cfg.MerchantCode},
		{"MD", "P"},
		{"PRN", in.OrderID},
		{"AMT", PaisaToRupees(in.AmountPaisa)}, // rupees; the SAME string goes into DV
		{"CRN", "NPR"},
		{"DT", FonepayDate(time.Now())},
		{"R1", orDefault(truncateUTF16(in.Description, 160), "Payment")},
		{"R2", r2},
		{"RU", in.ReturnURL},
	}
	vals := make([]string, len(p))
	for i, kv := range p {
		vals[i] = kv[1] // raw (not URL-encoded) values
	}
	p = append(p, [2]string{"DV", FonepayHMAC(f.cfg.SecretKey, vals)})
	return InitiateResult{Kind: KindRedirect, URL: f.urls.payment + "?" + encodeForm(p)}, nil
}

func hasFonepayCallback(cb map[string]string) bool {
	for k := range cb {
		if k == "DV" {
			return true
		}
		for _, f := range fonepayResponseDVFields {
			if k == f {
				return true
			}
		}
	}
	return false
}

// Verify is the authoritative check. With Username/Password configured it uses txnVerification (works
// without a callback, so reconciliation can use it). Otherwise it uses the legacy GET verification, which
// needs UID + BC from a DV-signed redirect. Callback params are trusted ONLY with a valid DV.
func (f *Fonepay) Verify(ctx context.Context, in VerifyInput) (VerifyResult, error) {
	var trusted map[string]string
	if hasFonepayCallback(in.Callback) {
		if f.CallbackValid(in.Callback) {
			if in.Callback["PRN"] != in.OrderID || in.Callback["PID"] != f.cfg.MerchantCode {
				return VerifyResult{}, newPaymentError(ProviderFonepay, "callback_mismatch", "Fonepay: callback does not match this attempt", 400, in.Callback)
			}
			trusted = in.Callback
		} else if !f.cfg.LenientSignature {
			return VerifyResult{}, newPaymentError(ProviderFonepay, "invalid_signature", "Fonepay: missing or invalid response DV", 400, in.Callback)
		}
	}

	if f.cfg.Username != "" && f.cfg.Password != "" {
		r, err := f.txnVerification(ctx, in.OrderID, in.AmountPaisa)
		if err != nil {
			return VerifyResult{}, err
		}
		status, ok := fonepayTxnStatus[strings.ToLower(r["paymentStatus"].(string))]
		if !ok {
			status = StatusUnknown
		}
		var amount *int64
		if ra := r["requestedAmount"]; truthy(ra) {
			p, err := paisaFromValue(ra)
			if err != nil {
				return VerifyResult{}, err
			}
			amount = &p
		}
		txn := trusted["UID"]
		if v, ok := getNonNull(r, "fonepayTraceId"); ok {
			txn = jsString(v)
		}
		return VerifyResult{Provider: ProviderFonepay, Status: status, OrderID: in.OrderID, AmountPaisa: amount, TransactionID: txn, Raw: r}, nil
	}

	if trusted["UID"] != "" && trusted["BC"] != "" {
		// Authentic (DV-verified) negative outcome from Fonepay.
		if trusted["PS"] != "true" || trusted["RC"] != "successful" {
			status := StatusFailed
			if trusted["RC"] == "cancel" {
				status = StatusCanceled
			}
			return VerifyResult{Provider: ProviderFonepay, Status: status, OrderID: in.OrderID, TransactionID: trusted["UID"], Raw: trusted}, nil
		}
		ok, text, err := f.legacyVerify(ctx, in.OrderID, in.AmountPaisa, trusted["UID"], trusted["BC"])
		if err != nil {
			return VerifyResult{}, err
		}
		status := StatusFailed
		if ok {
			status = StatusPaid
		}
		var amount *int64
		if ra := trusted["R_AMT"]; ra != "" { // R_AMT = amount requested by merchant (DV-signed)
			p, err := RupeesToPaisa(ra)
			if err != nil {
				return VerifyResult{}, err
			}
			amount = &p
		}
		return VerifyResult{
			Provider: ProviderFonepay, Status: status, OrderID: in.OrderID, AmountPaisa: amount, TransactionID: trusted["UID"],
			Raw: FonepayLegacyRaw{Callback: trusted, Verification: text},
		}, nil
	}

	return VerifyResult{}, newPaymentError(ProviderFonepay, "verify_unavailable",
		"Fonepay: cannot verify without a DV-signed callback (UID/BC) unless username/password are configured for txnVerification", 0, nil)
}

func (f *Fonepay) txnVerification(ctx context.Context, prn string, amountPaisa int64) (map[string]any, error) {
	if f.cfg.Username == "" || f.cfg.Password == "" {
		return nil, errors.New("fonepay: username/password required for txnVerification")
	}
	// The body is signed byte-for-byte: build it once and send exactly these bytes (spec format).
	body := `{"prn": ` + jsJSONString(prn) + `,"merchantCode": ` + jsJSONString(f.cfg.MerchantCode) + `,"amount": ` + jsJSONString(PaisaToRupees(amountPaisa)) + `}`
	auth := ToHex(HMACSHA512([]byte(f.cfg.SecretKey), []byte(strings.Join([]string{f.cfg.Username, f.cfg.Password, "POST", "application/json", fonepayTxnResource, body}, ","))))
	res, err := doHTTP(ctx, f.client, ProviderFonepay, httpRequest{
		method: "POST", url: f.urls.txnVerification,
		headers: [][2]string{{"Authorization", BasicAuth(f.cfg.Username, f.cfg.Password)}, {"auth", auth}, {"Content-Type", "application/json"}},
		body:    []byte(body), timeout: f.timeout, retries: 2,
	})
	if err != nil {
		return nil, err
	}
	m, _ := res.data.(map[string]any)
	if _, isStr := m["paymentStatus"].(string); res.status != 200 || !isStr {
		return nil, newPaymentError(ProviderFonepay, fmt.Sprintf("http_%d", res.status), "Fonepay txnVerification failed: "+truncateUTF16(res.text, 200), res.status, res.data)
	}
	return m, nil
}

var (
	fonepayResponseCodeRe = regexp.MustCompile(`<response_code>([^<]*)</response_code>`)
	fonepaySuccessRe      = regexp.MustCompile(`<success>([^<]*)</success>`)
)

// legacyVerify is the 2019 GET verification; needs UID + BC from the redirect. Returns XML.
func (f *Fonepay) legacyVerify(ctx context.Context, prn string, amountPaisa int64, uid, bankCode string) (bool, string, error) {
	amt := PaisaToRupees(amountPaisa)
	dv := f.sign(f.cfg.MerchantCode, amt, prn, bankCode, uid)
	qs := encodeForm([][2]string{{"PRN", prn}, {"PID", f.cfg.MerchantCode}, {"BID", bankCode}, {"AMT", amt}, {"UID", uid}, {"DV", dv}})
	res, err := doHTTP(ctx, f.client, ProviderFonepay, httpRequest{url: f.urls.legacyVerify + "?" + qs, headers: [][2]string{{"Accept", "application/xml"}}, timeout: f.timeout, retries: 2})
	if err != nil {
		return false, "", err
	}
	// A 5xx / WAF page / HTML must never read as "not paid": error so the attempt stays open.
	if res.status != 200 {
		return false, "", newPaymentError(ProviderFonepay, "upstream_error", fmt.Sprintf("Fonepay verification HTTP %d", res.status), res.status, truncateUTF16(res.text, 500))
	}
	code := fonepayResponseCodeRe.FindStringSubmatch(res.text)
	if code == nil {
		return false, "", newPaymentError(ProviderFonepay, "malformed_response", "Fonepay verification: unparseable response", res.status, truncateUTF16(res.text, 500))
	}
	success := fonepaySuccessRe.FindStringSubmatch(res.text)
	return code[1] == "successful" && success != nil && success[1] == "true", res.text, nil
}

// OrderIDFromCallback returns PRN.
func (f *Fonepay) OrderIDFromCallback(params map[string]string) string { return params["PRN"] }

// ------------------------------------------------------------------ Dynamic QR (POS / desktop / kiosk)

func (f *Fonepay) requireLogin() error {
	if f.cfg.Username == "" || f.cfg.Password == "" {
		return errors.New("fonepay: username/password required for Dynamic QR")
	}
	return nil
}

var fonepayWSHostRe = regexp.MustCompile(`^wss?://[^/]+`)

// QRCreate creates a Dynamic QR.
func (f *Fonepay) QRCreate(ctx context.Context, in FonepayQRInput) (FonepayQR, error) {
	if err := f.requireLogin(); err != nil {
		return FonepayQR{}, err
	}
	if err := AssertPaisa(in.AmountPaisa, ProviderFonepay); err != nil {
		return FonepayQR{}, err
	}
	amount := PaisaToRupees(in.AmountPaisa)
	remarks2 := orDefault(in.Remarks2, "N/A")
	body := jsonObject{
		{"amount", amount},
		{"remarks1", in.Remarks1},
		{"remarks2", remarks2},
		{"prn", in.OrderID},
		{"merchantCode", f.cfg.MerchantCode},
		{"dataValidation", strings.ToLower(f.sign(amount, in.OrderID, f.cfg.MerchantCode, in.Remarks1, remarks2))},
		{"username", f.cfg.Username},
		{"password", f.cfg.Password},
	}
	res, err := doHTTP(ctx, f.client, ProviderFonepay, httpRequest{method: "POST", url: f.urls.qrBase + "/thirdPartyDynamicQrDownload", body: jsonBody(body), timeout: f.timeout})
	if err != nil {
		return FonepayQR{}, err
	}
	qr, _ := get(res.data, "qrMessage")
	if !truthy(qr) {
		msg := truncateUTF16(res.text, 200)
		if v, ok := getNonNull(res.data, "message"); ok {
			msg = jsString(v)
		}
		return FonepayQR{}, newPaymentError(ProviderFonepay, fmt.Sprintf("http_%d", res.status), "Fonepay QR create failed: "+msg, res.status, res.data)
	}
	ws, _ := get(res.data, "thirdpartyQrWebSocketUrl")
	wsURL, _ := ws.(string)
	// Fonepay has been seen returning a localhost host here; rewrite to the real socket host.
	if strings.Contains(wsURL, "localhost") {
		host := "wss://dev-ws.fonepay.com"
		if f.cfg.Env == EnvProduction {
			host = "wss://ws.fonepay.com"
		}
		wsURL = fonepayWSHostRe.ReplaceAllLiteralString(wsURL, host)
	}
	return FonepayQR{QRMessage: jsString(qr), WebSocketURL: wsURL, Raw: res.data}, nil
}

// QRStatus polls QR payment status. Always call it after a websocket "paymentSuccess" message before
// fulfilling. Pass the stored amount: the status response has none, but the QR was created with it.
func (f *Fonepay) QRStatus(ctx context.Context, orderID string, amountPaisa *int64) (VerifyResult, error) {
	if err := f.requireLogin(); err != nil {
		return VerifyResult{}, err
	}
	body := jsonObject{
		{"prn", orderID},
		{"merchantCode", f.cfg.MerchantCode},
		{"dataValidation", strings.ToLower(f.sign(orderID, f.cfg.MerchantCode))},
		{"username", f.cfg.Username},
		{"password", f.cfg.Password},
	}
	res, err := doHTTP(ctx, f.client, ProviderFonepay, httpRequest{method: "POST", url: f.urls.qrBase + "/thirdPartyDynamicQrGetStatus", body: jsonBody(body), timeout: f.timeout, retries: 2})
	if err != nil {
		return VerifyResult{}, err
	}
	ps, _ := get(res.data, "paymentStatus")
	psStr, isStr := ps.(string)
	if !isStr {
		return VerifyResult{}, newPaymentError(ProviderFonepay, fmt.Sprintf("http_%d", res.status), "Fonepay QR status failed: "+truncateUTF16(res.text, 200), res.status, res.data)
	}
	status, ok := fonepayTxnStatus[strings.ToLower(psStr)]
	if !ok {
		status = StatusUnknown
	}
	var amount *int64
	if amountPaisa != nil {
		a := *amountPaisa
		amount = &a
	}
	return VerifyResult{Provider: ProviderFonepay, Status: status, OrderID: orderID, AmountPaisa: amount, TransactionID: strOrEmpty(res.data, "fonepayTraceId"), Raw: res.data}, nil
}

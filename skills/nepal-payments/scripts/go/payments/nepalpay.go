package payments

// NEPALPAY QR (NCHL) merchant dynamic QR: https://doc.connectips.com/docs/NepalPAY-QR/Merchant-QR-generation/introduction
// Onboarding via your bank (or businesssupport@nchl.com.np) -> acquirerId, merchantId, MCC, NPI username/password,
// and the signing .pfx (NPI.pfx in UAT). Convert the .pfx to PEM as for connectIPS (see ParseRSAPrivateKeyPEM).
//
// Flow: server signs token (RSA-SHA256) -> POST /qr/generateQR -> show QRString / QRImage -> customer scans with any
//       NEPALPAY QR / mobile banking app -> poll /nQR/v1/merchanttxnreport by validationTraceId (= ProviderRef).
//
// Token string (comma-joined, no spaces): acquirerId,merchantId,merchantCategoryCode,transactionCurrency,transactionAmount,billNumber,userId
// Paid = debitStatus "000" and creditStatus "000" | "999" | "DEFER".

import (
	"context"
	"crypto/rsa"
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// NepalPayConfig configures the NEPALPAY QR adapter.
type NepalPayConfig struct {
	Env Env
	// AcquirerID is 8 digits, e.g. "00002501" (your acquiring bank).
	AcquirerID string
	// MerchantID is the creditor id / merchant code, e.g. "2501ELFDRY2".
	MerchantID string
	// MerchantName is <= 25 chars and must match the enrolled name.
	MerchantName         string
	MerchantCategoryCode string // e.g. "5021"
	MerchantCity         string
	MerchantPostalCode   string
	StoreLabel           string
	TerminalLabel        string // default "0"
	// Username is the NPI user issued to the merchant. Also the userId inside the signed token.
	Username string
	Password string
	// PrivateKeyPEM is the key extracted from the NPI .pfx (PKCS#8 or PKCS#1 PEM).
	PrivateKeyPEM string
	// Auth is "basic" (merchant QR doc, the default) or "oauth" (NPI password grant, needs ClientID/ClientSecret).
	Auth         string
	ClientID     string
	ClientSecret string
	// QRImage asks NCHL for a base64 PNG alongside the QR string. nil means true.
	QRImage *bool
	// NCHLPublicKeyPEM is NCHL's public key (SPKI PEM, from NPI.cer): verifies confirm-payment notifications
	// and encrypts the WebSocket api_token.
	NCHLPublicKeyPEM string
	// WSURL is the WebSocket channel issued by NCHL (STOMP endpoint ending in /nqrws), with its own
	// username and API token.
	WSURL      string
	WSUsername string
	WSAPIToken string
	BaseURL    string
	Timeout    time.Duration // default 20s
	HTTPClient Doer
}

var nepalPayBase = map[Env]string{EnvSandbox: "https://devopennpi.connectips.com", EnvProduction: "https://opennpi.connectips.com"}

const nepalPayNPR = 524

var nepalPayCreditOK = map[string]bool{"000": true, "999": true, "DEFER": true}

// NepalPayTokenFields are the values signed for a dynamic QR.
type NepalPayTokenFields struct {
	AcquirerID           string
	MerchantID           string
	MerchantCategoryCode string
	TransactionCurrency  string
	TransactionAmount    string
	BillNumber           string
	UserID               string
}

// NepalPayTokenString is the exact string NCHL expects to be signed for a dynamic QR.
func NepalPayTokenString(f NepalPayTokenFields) string {
	return strings.Join([]string{f.AcquirerID, f.MerchantID, f.MerchantCategoryCode, f.TransactionCurrency, f.TransactionAmount, f.BillNumber, f.UserID}, ",")
}

// NepalPayConfirmationString is what NCHL signs on a confirm-payment notification:
// merchantBillNo,merchantId,merchantName,paymentRef,channel,payerMobileNumber,sessionNo. The docs name the
// field payerMobileNumber; the sample sends payerMobile. Missing or null values become "".
func NepalPayConfirmationString(note map[string]any) string {
	v := func(k string) string {
		if x, ok := note[k]; ok && x != nil {
			return jsString(x)
		}
		return ""
	}
	mobile := v("payerMobile")
	if x, ok := note["payerMobileNumber"]; ok && x != nil {
		mobile = v("payerMobileNumber")
	}
	return strings.Join([]string{v("merchantBillNo"), v("merchantId"), v("merchantName"), v("paymentRef"), v("channel"), mobile, v("sessionNo")}, ",")
}

// NepalPayWebSocketRequest is everything a STOMP client needs to watch one QR live.
type NepalPayWebSocketRequest struct {
	URL       string
	Subscribe string
	Send      string
	Body      NepalPayWebSocketBody
}

// NepalPayWebSocketBody is the JSON sent to NepalPayWebSocketRequest.Send.
type NepalPayWebSocketBody struct {
	MerchantID string `json:"merchant_id"`
	RequestID  string `json:"request_id"`
	Username   string `json:"username"`
	APIToken   string `json:"api_token"`
}

// NepalPayTxn is one merchanttxnreport row as decoded JSON (nQrTxnId, instructionId, amount, debitStatus,
// creditStatus, merchantBillNo, payerName, tranType...). Numbers are json.Number.
type NepalPayTxn = map[string]any

// NepalPayNotification is the part of NCHL's confirm-payment notification the signed reply echoes.
type NepalPayNotification struct {
	TxnDate        string
	MerchantBillNo string
	PaymentRef     string
}

// NepalPayConfirmation is the signed reply body for a confirm-payment notification.
type NepalPayConfirmation struct {
	TxnDate        string `json:"txnDate"`
	Status         string `json:"status"`
	Message        string `json:"message"`
	MerchantBillNo string `json:"merchantBillNo"`
	PaymentRef     string `json:"paymentRef"`
	Signature      string `json:"signature"`
}

// NepalPay is the NEPALPAY QR adapter.
type NepalPay struct {
	cfg     NepalPayConfig
	key     *rsa.PrivateKey
	base    string
	timeout time.Duration
	client  Doer

	mu          sync.Mutex
	cachedToken string
	cachedUntil time.Time
}

var _ Adapter = (*NepalPay)(nil)

// NewNepalPay builds the NEPALPAY QR adapter; the private key is parsed once here.
func NewNepalPay(cfg NepalPayConfig) (*NepalPay, error) {
	base, ok := nepalPayBase[cfg.Env]
	if !ok {
		return nil, errInvalidEnv(ProviderNepalPay, cfg.Env)
	}
	if cfg.AcquirerID == "" || cfg.MerchantID == "" || cfg.Username == "" || cfg.PrivateKeyPEM == "" {
		return nil, errMissingConfig(ProviderNepalPay, "AcquirerID, MerchantID, Username and PrivateKeyPEM")
	}
	if orDefault(cfg.Auth, "basic") != "basic" && (cfg.ClientID == "" || cfg.ClientSecret == "") {
		return nil, errMissingConfig(ProviderNepalPay, `ClientID and ClientSecret (Auth "oauth")`)
	}
	key, err := ParseRSAPrivateKeyPEM(cfg.PrivateKeyPEM)
	if err != nil {
		return nil, &PaymentError{Provider: ProviderNepalPay, Code: "invalid_config", Message: "nepalpay: private key: " + err.Error(), Err: err}
	}
	return &NepalPay{
		cfg:     cfg,
		key:     key,
		base:    orDefault(cfg.BaseURL, base),
		timeout: durOr(cfg.Timeout, 20*time.Second),
		client:  cfg.HTTPClient,
	}, nil
}

// ID returns ProviderNepalPay.
func (n *NepalPay) ID() ProviderID { return ProviderNepalPay }

// authHeader returns Basic auth, or a Bearer token from the password grant cached until 30s before expiry.
func (n *NepalPay) authHeader(ctx context.Context) (string, error) {
	if orDefault(n.cfg.Auth, "basic") == "basic" {
		return BasicAuth(n.cfg.Username, n.cfg.Password), nil
	}
	n.mu.Lock()
	defer n.mu.Unlock()
	if n.cachedToken != "" && time.Now().Before(n.cachedUntil) {
		return "Bearer " + n.cachedToken, nil
	}
	body := encodeForm([][2]string{{"grant_type", "password"}, {"username", n.cfg.Username}, {"password", n.cfg.Password}})
	res, err := doHTTP(ctx, n.client, ProviderNepalPay, httpRequest{
		method: "POST", url: n.base + "/oauth/token",
		headers: [][2]string{{"Authorization", BasicAuth(n.cfg.ClientID, n.cfg.ClientSecret)}, {"Content-Type", "application/x-www-form-urlencoded"}},
		body:    []byte(body), timeout: n.timeout,
	})
	if err != nil {
		return "", err
	}
	at, _ := get(res.data, "access_token")
	if res.status != 200 || !truthy(at) {
		return "", newPaymentError(ProviderNepalPay, "unauthorized", "NEPALPAY oauth failed: "+truncateUTF16(res.text, 200), res.status, res.data)
	}
	ttl := 60.0
	if v, ok := get(res.data, "expires_in"); ok {
		if f, err := strconv.ParseFloat(jsTrim(jsString(v)), 64); err == nil && f != 0 && !math.IsNaN(f) {
			ttl = f
		}
	}
	n.cachedToken = jsString(at)
	n.cachedUntil = time.Now().Add(time.Duration(math.Max(ttl-30, 5) * float64(time.Second)))
	return "Bearer " + n.cachedToken, nil
}

var nepalPayBillRe = regexp.MustCompile(`^[A-Za-z0-9-]{1,25}$`)

// Initiate generates a dynamic QR. billNumber = OrderID (<= 25 chars). Persist ProviderRef (validationTraceId):
// Verify needs it. ReturnURL is unused: there is no redirect, the payer scans the QR from their own app.
func (n *NepalPay) Initiate(ctx context.Context, in InitiateInput) (InitiateResult, error) {
	if err := AssertPaisa(in.AmountPaisa, ProviderNepalPay); err != nil {
		return InitiateResult{}, err
	}
	if !nepalPayBillRe.MatchString(in.OrderID) {
		return InitiateResult{}, newPaymentError(ProviderNepalPay, "invalid_order_id", "NEPALPAY billNumber must be 1–25 chars [A-Za-z0-9-]", 0, nil)
	}
	amount := amount2dp(in.AmountPaisa) // always 2 decimals
	token, err := rsaSign(n.key, NepalPayTokenString(NepalPayTokenFields{
		AcquirerID:           n.cfg.AcquirerID,
		MerchantID:           n.cfg.MerchantID,
		MerchantCategoryCode: n.cfg.MerchantCategoryCode,
		TransactionCurrency:  strconv.Itoa(nepalPayNPR),
		TransactionAmount:    amount,
		BillNumber:           in.OrderID,
		UserID:               n.cfg.Username,
	}))
	if err != nil {
		return InitiateResult{}, err
	}
	qrImage := n.cfg.QRImage == nil || *n.cfg.QRImage
	body := jsonObject{
		{"pointOfInitialization", int64(12)},
		{"acquirerId", n.cfg.AcquirerID},
		{"merchantId", n.cfg.MerchantID},
		{"merchantName", truncateUTF16(n.cfg.MerchantName, 25)},
		{"merchantCategoryCode", jsNumberValue(n.cfg.MerchantCategoryCode)},
		{"merchantCountry", "NP"},
		{"merchantCity", n.cfg.MerchantCity},
		{"merchantPostalCode", n.cfg.MerchantPostalCode},
		{"merchantLanguage", "en"},
		{"transactionCurrency", int64(nepalPayNPR)},
		{"transactionAmount", amount},
		{"valueOfConvenienceFeeFixed", "0.00"},
		{"billNumber", in.OrderID},
		{"storeLabel", n.cfg.StoreLabel},
		{"terminalLabel", orDefault(n.cfg.TerminalLabel, "0")},
		{"purposeOfTransaction", truncateUTF16(orDefault(in.Description, "Payment"), 25)},
		{"qrImage", qrImage},
		{"token", token},
	}
	auth, err := n.authHeader(ctx)
	if err != nil {
		return InitiateResult{}, err
	}
	res, err := doHTTP(ctx, n.client, ProviderNepalPay, httpRequest{
		method: "POST", url: n.base + "/qr/generateQR",
		headers: [][2]string{{"Authorization", auth}}, body: jsonBody(body), timeout: n.timeout,
	})
	if err != nil {
		return InitiateResult{}, err
	}
	data, _ := get(res.data, "data")
	rc, _ := get(res.data, "responseCode")
	qrString, _ := get(data, "qrString")
	traceID, _ := get(data, "validationTraceId")
	if !isString(rc, "000") || !truthy(qrString) || !truthy(traceID) {
		code := fmt.Sprintf("http_%d", res.status)
		if v, ok := getNonNull(res.data, "responseCode"); ok {
			code = jsString(v)
		} else if rs, ok := get(res.data, "responses"); ok {
			if arr, ok := rs.([]any); ok && len(arr) > 0 {
				if v, ok := getNonNull(arr[0], "responseCode"); ok {
					code = jsString(v)
				}
			}
		}
		return InitiateResult{}, newPaymentError(ProviderNepalPay, code, "NEPALPAY generateQR failed: "+truncateUTF16(res.text, 300), res.status, res.data)
	}
	r := InitiateResult{Kind: KindQR, QRString: jsTrim(jsString(qrString)), ProviderRef: jsString(traceID), Raw: res.data}
	if img, _ := get(data, "qrImage"); truthy(img) {
		r.QRImage = jsString(img)
	}
	return r, nil
}

// Report returns every payment made against one QR (a failed scan can be retried on the same QR).
func (n *NepalPay) Report(ctx context.Context, validationTraceID string) ([]NepalPayTxn, error) {
	body := jsonObject{{"validationTraceId", validationTraceID}, {"merchantId", n.cfg.MerchantID}, {"acquirerId", n.cfg.AcquirerID}}
	auth, err := n.authHeader(ctx)
	if err != nil {
		return nil, err
	}
	res, err := doHTTP(ctx, n.client, ProviderNepalPay, httpRequest{
		method: "POST", url: n.base + "/nQR/v1/merchanttxnreport",
		headers: [][2]string{{"Authorization", auth}}, body: jsonBody(body), timeout: n.timeout, retries: 2,
	})
	if err != nil {
		return nil, err
	}
	if res.status == 401 {
		return nil, newPaymentError(ProviderNepalPay, "unauthorized", "NEPALPAY: 401 — wrong NPI username/password", 401, res.data)
	}
	code := strOrEmpty(res.data, "responseCode")
	if code == "E010" {
		return []NepalPayTxn{}, nil // record not found
	}
	if code != "200" && code != "000" {
		return nil, newPaymentError(ProviderNepalPay, orDefault(code, fmt.Sprintf("http_%d", res.status)), "NEPALPAY report failed: "+truncateUTF16(res.text, 200), res.status, res.data)
	}
	rows, _ := get(res.data, "responseBody")
	arr, _ := rows.([]any)
	out := make([]NepalPayTxn, 0, len(arr))
	for _, row := range arr {
		if m, ok := row.(map[string]any); ok {
			out = append(out, m)
		}
	}
	return out, nil
}

// Verify calls merchanttxnreport by validationTraceId (authoritative).
func (n *NepalPay) Verify(ctx context.Context, in VerifyInput) (VerifyResult, error) {
	if in.ProviderRef == "" {
		return VerifyResult{}, newPaymentError(ProviderNepalPay, "missing_provider_ref", "NEPALPAY verify needs providerRef (validationTraceId)", 0, nil)
	}
	txns, err := n.Report(ctx, in.ProviderRef)
	if err != nil {
		return VerifyResult{}, err
	}
	var paid, last NepalPayTxn
	for _, t := range txns {
		if tt, ok := getNonNull(t, "tranType"); ok && !isString(tt, "PMT") {
			continue // refunds (RFND) are not payments
		}
		last = t
		if paid == nil && isString(t["debitStatus"], "000") && nepalPayCreditOK[jsString(t["creditStatus"])] {
			paid = t
		}
	}
	pick := paid
	if pick == nil {
		pick = last
	}
	var status PaymentStatus
	switch {
	case paid != nil:
		status = StatusPaid
	case pick == nil:
		status = StatusNotFound
	case isString(pick["debitStatus"], "000"):
		status = StatusUnknown // debited but credit not confirmed: review
	default:
		status = StatusFailed
	}
	var amount *int64
	txnID := ""
	if pick != nil {
		if v, ok := getNonNull(pick, "amount"); ok {
			p, err := paisaFromValue(v)
			if err != nil {
				return VerifyResult{}, err
			}
			amount = &p
		}
		txnID = strOrEmpty(pick, "nQrTxnId")
	}
	return VerifyResult{Provider: ProviderNepalPay, Status: status, OrderID: in.OrderID, AmountPaisa: amount, TransactionID: txnID, Raw: txns}, nil
}

// OrderIDFromCallback returns your order id from a confirm-payment notification (merchantBillNo = the
// billNumber you sent).
func (n *NepalPay) OrderIDFromCallback(params map[string]string) string {
	return firstNonEmpty(params["merchantBillNo"], params["billNumber"])
}

// VerifyConfirmation checks a confirm-payment notification's signature with NCHLPublicKeyPEM. NCHL doesn't say
// which key signs it, so false here is a reason to log and alert, not proof of forgery. Fulfil only after
// Verify either way. The error is non-nil only when NCHLPublicKeyPEM is unset.
func (n *NepalPay) VerifyConfirmation(note map[string]any) (bool, error) {
	if n.cfg.NCHLPublicKeyPEM == "" {
		return false, errMissingConfig(ProviderNepalPay, "NCHLPublicKeyPEM (to verify notifications)")
	}
	sig, ok := note["signature"].(string)
	if !ok {
		return false, nil
	}
	return RSASHA256VerifyBase64(n.cfg.NCHLPublicKeyPEM, NepalPayConfirmationString(note), sig), nil
}

// WebSocketRequest builds the request to watch one QR live: connect to URL, subscribe to Subscribe, then send
// Body as JSON to Send. Statuses arrive as ENTR, PARSED, then COMPLETED or FAILED. On COMPLETED, call Verify.
// api_token is encrypted fresh on every call (RSA PKCS#1 v1.5 under NCHLPublicKeyPEM).
func (n *NepalPay) WebSocketRequest(validationTraceID string) (NepalPayWebSocketRequest, error) {
	c := n.cfg
	if c.WSURL == "" || c.WSUsername == "" || c.WSAPIToken == "" || c.NCHLPublicKeyPEM == "" {
		return NepalPayWebSocketRequest{}, errMissingConfig(ProviderNepalPay, "WSURL, WSUsername, WSAPIToken and NCHLPublicKeyPEM (for the WebSocket channel)")
	}
	token, err := RSAPKCS1EncryptBase64(c.NCHLPublicKeyPEM, c.WSAPIToken)
	if err != nil {
		return NepalPayWebSocketRequest{}, &PaymentError{Provider: ProviderNepalPay, Code: "invalid_config", Message: "nepalpay: api_token: " + err.Error(), Err: err}
	}
	return NepalPayWebSocketRequest{
		URL:       c.WSURL,
		Subscribe: "/user/nqrws/check-txn-status",
		Send:      "/nqrws/check-txn-status",
		Body:      NepalPayWebSocketBody{MerchantID: orDefault(c.TerminalLabel, "0"), RequestID: validationTraceID, Username: c.WSUsername, APIToken: token},
	}, nil
}

// ConfirmationResponse is the signed reply to NCHL's POST {your base}/nepalpay/confirm-payment notification.
// The notification is a hint: call Verify before fulfilling.
func (n *NepalPay) ConfirmationResponse(note NepalPayNotification, ok bool) (NepalPayConfirmation, error) {
	status, message := "FAILED", "TRANSACTION FAILED"
	if ok {
		status, message = "SUCCESS", "TRANSACTION SUCCESSFUL"
	}
	sig, err := rsaSign(n.key, strings.Join([]string{note.TxnDate, status, message, note.MerchantBillNo, note.PaymentRef}, ","))
	if err != nil {
		return NepalPayConfirmation{}, err
	}
	return NepalPayConfirmation{TxnDate: note.TxnDate, Status: status, Message: message, MerchantBillNo: note.MerchantBillNo, PaymentRef: note.PaymentRef, Signature: sig}, nil
}

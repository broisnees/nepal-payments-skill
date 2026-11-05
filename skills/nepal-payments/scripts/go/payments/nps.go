package payments

// Nepal Payment Solution (NPS / NPX) OnePG — one integration routes to ~29 banks' mobile/e-banking,
// card checkout, and wallets.
//
// Auth: Basic base64(apiUsername:apiPassword) on every API call.
// Signature: HMAC-SHA512(secretKey, values of payload keys sorted alphabetically (excluding Signature),
// concatenated with NO separator) as lowercase hex.
//
// Flow: GetProcessId -> browser auto-POST (multipart) to /Payment/Index -> payer pays
//       -> NPS GETs your Notification URL (server-to-server) + browser returns to ResponseUrl
//       -> CheckTransactionStatus (authoritative).

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"time"
)

// NPSConfig configures the NPS adapter.
type NPSConfig struct {
	Env          Env
	MerchantID   string
	MerchantName string
	APIUsername  string
	APIPassword  string
	SecretKey    string
	APIBaseURL   string
	GatewayURL   string
	Timeout      time.Duration // default 20s
	HTTPClient   Doer
}

// NPSInitiateOptions are NPS-only initiate fields.
type NPSInitiateOptions struct {
	// InstrumentCode skips NPS's bank/wallet picker page (see GetInstruments).
	InstrumentCode string
}

// NPSInstrument is one bank / wallet from GetPaymentInstrumentDetails.
type NPSInstrument struct {
	InstitutionName string
	InstrumentName  string
	InstrumentCode  string
	BankType        string // MBanking, EBanking, CheckoutGateway (wallets), checkoutcard
	LogoURL         string
}

// NPSServiceCharge is the GetServiceCharge result.
type NPSServiceCharge struct {
	Amount            string
	CommissionType    string
	ChargeValue       string
	TotalChargeAmount string
}

type npsEndpoints struct{ api, gateway string }

var npsURLs = map[Env]npsEndpoints{
	EnvSandbox:    {api: "https://apisandbox.nepalpayment.com", gateway: "https://gatewaysandbox.nepalpayment.com/Payment/Index"},
	EnvProduction: {api: "https://apigateway.nepalpayment.com", gateway: "https://gateway.nepalpayment.com/Payment/Index"},
}

var npsStatus = map[string]PaymentStatus{"success": StatusPaid, "fail": StatusFailed, "failed": StatusFailed, "pending": StatusPending}

// NPSSign returns lowercase hex HMAC-SHA512 over the values of the alphabetically sorted keys
// (excluding "Signature"), concatenated with no separator.
func NPSSign(secretKey string, payload map[string]string) string {
	keys := make([]string, 0, len(payload))
	for k := range payload {
		if k != "Signature" {
			keys = append(keys, k)
		}
	}
	sort.Strings(keys)
	var b strings.Builder
	for _, k := range keys {
		b.WriteString(payload[k])
	}
	return ToHex(HMACSHA512([]byte(secretKey), []byte(b.String())))
}

// NPS is the NPS OnePG adapter.
type NPS struct {
	cfg     NPSConfig
	api     string
	gateway string
	auth    string
	timeout time.Duration
	client  Doer
}

var _ Adapter = (*NPS)(nil)

// NewNPS builds the NPS adapter.
func NewNPS(cfg NPSConfig) (*NPS, error) {
	u, ok := npsURLs[cfg.Env]
	if !ok {
		return nil, errInvalidEnv(ProviderNPS, cfg.Env)
	}
	if cfg.MerchantID == "" || cfg.SecretKey == "" {
		return nil, errMissingConfig(ProviderNPS, "MerchantID and SecretKey")
	}
	return &NPS{
		cfg:     cfg,
		api:     orDefault(cfg.APIBaseURL, u.api),
		gateway: orDefault(cfg.GatewayURL, u.gateway),
		auth:    BasicAuth(cfg.APIUsername, cfg.APIPassword),
		timeout: durOr(cfg.Timeout, 20*time.Second),
		client:  cfg.HTTPClient,
	}, nil
}

// ID returns ProviderNPS.
func (n *NPS) ID() ProviderID { return ProviderNPS }

// call POSTs the payload (in the given key order) plus its Signature and returns the response object.
func (n *NPS) call(ctx context.Context, path string, payload [][2]string, retries int) (map[string]any, error) {
	m := make(map[string]string, len(payload))
	body := make(jsonObject, 0, len(payload)+1)
	for _, kv := range payload {
		m[kv[0]] = kv[1]
		body = append(body, jsonKV{kv[0], kv[1]})
	}
	body = append(body, jsonKV{"Signature", NPSSign(n.cfg.SecretKey, m)})
	res, err := doHTTP(ctx, n.client, ProviderNPS, httpRequest{
		method: "POST", url: n.api + "/" + path, headers: [][2]string{{"Authorization", n.auth}},
		body: jsonBody(body), timeout: n.timeout, retries: retries,
	})
	if err != nil {
		return nil, err
	}
	if res.status == 401 {
		return nil, newPaymentError(ProviderNPS, "unauthorized", "NPS: 401 — wrong API username/password", 401, nil)
	}
	r, isObj := res.data.(map[string]any)
	if _, hasCode := r["code"]; res.status != 200 || !isObj || !hasCode {
		return nil, newPaymentError(ProviderNPS, fmt.Sprintf("http_%d", res.status), "NPS "+path+" failed: "+truncateUTF16(res.text, 200), res.status, res.data)
	}
	return r, nil
}

func npsErrors(r map[string]any) []any {
	errs, _ := r["errors"].([]any)
	return errs
}

func npsFail(path string, r map[string]any) error {
	errs := npsErrors(r)
	msgs := make([]string, len(errs))
	for i, e := range errs {
		msgs[i] = strOrEmpty(e, "error_message")
	}
	msg := strings.Join(msgs, "; ")
	if msg == "" {
		m, present := r["message"]
		msg = jsTemplate(m, present)
	}
	code := "nps_error"
	if len(errs) > 0 {
		if ec, _ := get(errs[0], "error_code"); truthy(ec) {
			code = "nps_" + jsString(ec)
		}
	}
	return newPaymentError(ProviderNPS, code, "NPS "+path+": "+msg, 200, r)
}

func (n *NPS) merchant() [][2]string {
	return [][2]string{{"MerchantId", n.cfg.MerchantID}, {"MerchantName", n.cfg.MerchantName}}
}

// GetInstruments lists banks/wallets so you can show your own picker; pass the chosen InstrumentCode to Initiate.
func (n *NPS) GetInstruments(ctx context.Context) ([]NPSInstrument, error) {
	r, err := n.call(ctx, "GetPaymentInstrumentDetails", n.merchant(), 2)
	if err != nil {
		return nil, err
	}
	if !isString(r["code"], "0") {
		return nil, npsFail("GetPaymentInstrumentDetails", r)
	}
	items, _ := r["data"].([]any)
	out := make([]NPSInstrument, 0, len(items))
	for _, it := range items {
		out = append(out, NPSInstrument{
			InstitutionName: strOrEmpty(it, "InstitutionName"),
			InstrumentName:  strOrEmpty(it, "InstrumentName"),
			InstrumentCode:  strOrEmpty(it, "InstrumentCode"),
			BankType:        strOrEmpty(it, "BankType"),
			LogoURL:         strOrEmpty(it, "LogoUrl"),
		})
	}
	return out, nil
}

// GetServiceCharge returns the NPS service charge for an amount + instrument.
func (n *NPS) GetServiceCharge(ctx context.Context, amountPaisa int64, instrumentCode string) (NPSServiceCharge, error) {
	r, err := n.call(ctx, "GetServiceCharge", append(n.merchant(), [2]string{"Amount", PaisaToRupees(amountPaisa)}, [2]string{"InstrumentCode", instrumentCode}), 2)
	if err != nil {
		return NPSServiceCharge{}, err
	}
	if !isString(r["code"], "0") {
		return NPSServiceCharge{}, npsFail("GetServiceCharge", r)
	}
	d := r["data"]
	return NPSServiceCharge{
		Amount:            strOrEmpty(d, "Amount"),
		CommissionType:    strOrEmpty(d, "CommissionType"),
		ChargeValue:       strOrEmpty(d, "ChargeValue"),
		TotalChargeAmount: strOrEmpty(d, "TotalChargeAmount"),
	}, nil
}

// Initiate calls GetProcessId and returns the gateway form (multipart/form-data).
// ProviderRef = ProcessId (persist it). The Notification URL is configured with NPS at onboarding.
func (n *NPS) Initiate(ctx context.Context, in InitiateInput) (InitiateResult, error) {
	if err := AssertPaisa(in.AmountPaisa, ProviderNPS); err != nil {
		return InitiateResult{}, err
	}
	amount := PaisaToRupees(in.AmountPaisa) // the SAME string in GetProcessId and the form
	r, err := n.call(ctx, "GetProcessId", append(n.merchant(), [2]string{"Amount", amount}, [2]string{"MerchantTxnId", in.OrderID}), 0)
	if err != nil {
		return InitiateResult{}, err
	}
	pid, _ := get(r["data"], "ProcessId")
	if !isString(r["code"], "0") || !truthy(pid) {
		return InitiateResult{}, npsFail("GetProcessId", r)
	}
	processID := jsString(pid)
	pairs := append(n.merchant(),
		[2]string{"Amount", amount},
		[2]string{"MerchantTxnId", in.OrderID},
		[2]string{"ProcessId", processID},
		[2]string{"TransactionRemarks", truncateUTF16(in.Description, 100)},
		[2]string{"ResponseUrl", in.ReturnURL},
	)
	if in.NPS != nil && in.NPS.InstrumentCode != "" {
		pairs = append(pairs, [2]string{"InstrumentCode", in.NPS.InstrumentCode}) // skips NPS's picker page
	}
	res := formResult(n.gateway, pairs)
	res.Enctype = "multipart/form-data"
	res.ProviderRef = processID
	return res, nil
}

// Verify calls CheckTransactionStatus. code "0" with data.Status "Fail" is a failed payment, not an API
// error; error_code "3" ("Transaction not initialized yet") maps to not_found.
func (n *NPS) Verify(ctx context.Context, in VerifyInput) (VerifyResult, error) {
	r, err := n.call(ctx, "CheckTransactionStatus", append(n.merchant(), [2]string{"MerchantTxnId", in.OrderID}), 2)
	if err != nil {
		return VerifyResult{}, err
	}
	if !isString(r["code"], "0") {
		for _, e := range npsErrors(r) {
			if ec, _ := get(e, "error_code"); isString(ec, "3") {
				return VerifyResult{Provider: ProviderNPS, Status: StatusNotFound, OrderID: in.OrderID, Raw: r}, nil
			}
		}
		return VerifyResult{}, npsFail("CheckTransactionStatus", r)
	}
	d, ok := r["data"].(map[string]any)
	if !ok {
		d = map[string]any{} // code "0" with null/non-object data: report unknown
	}
	if mt := d["MerchantTxnId"]; truthy(mt) && !isString(mt, in.OrderID) {
		return VerifyResult{}, newPaymentError(ProviderNPS, "callback_mismatch", "NPS: status is for a different transaction", 400, d)
	}
	st, _ := d["Status"].(string)
	status, known := npsStatus[strings.ToLower(st)]
	if !known {
		status = StatusUnknown
	}
	var amount *int64
	if a := d["Amount"]; truthy(a) {
		p, err := paisaFromValue(a) // excludes ServiceCharge
		if err != nil {
			return VerifyResult{}, err
		}
		amount = &p
	}
	return VerifyResult{
		Provider: ProviderNPS, Status: status, OrderID: in.OrderID, AmountPaisa: amount,
		TransactionID: strOrEmpty(d, "GatewayReferenceNo"), Raw: r,
	}, nil
}

// OrderIDFromCallback returns MerchantTxnId.
func (n *NPS) OrderIDFromCallback(params map[string]string) string { return params["MerchantTxnId"] }

// NotificationResponse is the plain-text body for your Notification URL handler: "received" the first
// time, "already received" for repeats. Only acknowledge once a FINAL status is recorded; while the
// payment is still pending return a non-2xx so NPS keeps notifying (references/nps.md).
func (n *NPS) NotificationResponse(alreadyProcessed bool) string {
	if alreadyProcessed {
		return "already received"
	}
	return "received"
}

package payments

// Ported from scripts/ts/test/providers/fonepay.test.ts.

import (
	"context"
	"net/url"
	"regexp"
	"strings"
	"testing"
	"time"
)

const fonepaySecret = "a7e3512f5032480a83137793cb2021dc" // public dev sample (spec v2.0)

func newTestFonepay(t *testing.T, cfg FonepayConfig) *Fonepay {
	t.Helper()
	if cfg.Env == "" {
		cfg.Env = EnvSandbox
	}
	cfg.MerchantCode, cfg.SecretKey = "NBQM", fonepaySecret
	f, err := NewFonepay(cfg)
	if err != nil {
		t.Fatal(err)
	}
	return f
}

// signedCallback adds a valid DV over the response DV fields.
func signedCallback(cb map[string]string) map[string]string {
	vals := make([]string, len(fonepayResponseDVFields))
	for i, k := range fonepayResponseDVFields {
		vals[i] = cb[k]
	}
	cb["DV"] = FonepayHMAC(fonepaySecret, vals)
	return cb
}

func TestFonepay_ResponseDVTestVector(t *testing.T) {
	eq(t, FonepayHMAC(fonepaySecret, []string{"d1580724437729", "NBQM", "true", "successful", "36463", "NICENPKA", "9841845631", "20.0", "30"}),
		"667860224021DF1891F7DE873A37B1DEDA720CCDC43F63BC88F86ED20F579E0DE66526D37C71B1D14A8D466E4B740D17D4FF274CD2819FD6ED2AA3D9A89D7C52")
}

func TestFonepay_TxnVerificationAuthHeaderMatchesSpecByteForByte(t *testing.T) {
	d := mock(reply(200, `{"paymentStatus":"success","prn":"d1549791827186","requestedAmount":"30","fonepayTraceId":12847}`))
	fp := newTestFonepay(t, FonepayConfig{Env: EnvProduction, Username: "gnw71090@zwoho.com", Password: "Fonepay@12345", HTTPClient: d})
	v, err := fp.Verify(context.Background(), VerifyInput{OrderID: "d1549791827186", AmountPaisa: 3000})
	if err != nil {
		t.Fatal(err)
	}
	c := d.Calls()[0]
	eq(t, c.Body, `{"prn": "d1549791827186","merchantCode": "NBQM","amount": "30"}`)
	eq(t, c.Header.Get("auth"), "0d3ebe65246182596de0d417e8e39d37ebe2f5da028c52ae0a33a05062a3bded8a737c3ff82b6f1a6d9442d11cfcb0432d86998af81f481948c0af7b346f4fa2")
	eq(t, c.Header.Get("Authorization"), "Basic Z253NzEwOTBAendvaG8uY29tOkZvbmVwYXlAMTIzNDU=")
	eq(t, v.Status, StatusPaid)
	amountEq(t, v.AmountPaisa, 3000)
	eq(t, v.TransactionID, "12847")
}

func TestFonepay_DynamicQRDataValidationMatchesSpecExample(t *testing.T) {
	d := mock(reply(200, `{"qrMessage":"000201...","status":"CREATED","thirdpartyQrWebSocketUrl":"wss://localhost:8080/x"}`))
	fp := newTestFonepay(t, FonepayConfig{Env: EnvProduction, Username: "u", Password: "p", HTTPClient: d})
	r, err := fp.QRCreate(context.Background(), FonepayQRInput{OrderID: "5d76d323-d1f6", AmountPaisa: 1400, Remarks1: "test1", Remarks2: "test2"})
	if err != nil {
		t.Fatal(err)
	}
	eq(t, jsonMap(t, d.Calls()[0].Body)["dataValidation"], any("5ae718032328ae5615fa4694dfbf3ecd13432bd49031e7285a3f8bc122ecbb8e833e83c7a11f895d30f3e8fd1906317aece113675166ae0d804ecf32a8bbdbaf"))
	eq(t, r.WebSocketURL, "wss://ws.fonepay.com/x") // localhost host rewritten
}

func TestFonepay_InitiateDVOverRawValuesPRNLengthKathmanduDate(t *testing.T) {
	fp := newTestFonepay(t, FonepayConfig{})
	ctx := context.Background()
	r, err := fp.Initiate(ctx, InitiateInput{OrderID: "NP123", AmountPaisa: 1050, Description: "Order 1", ReturnURL: "https://s.example/r"})
	if err != nil {
		t.Fatal(err)
	}
	eq(t, r.Kind, KindRedirect)
	u, err := url.Parse(r.URL)
	if err != nil {
		t.Fatal(err)
	}
	q := u.Query()
	eq(t, q.Get("AMT"), "10.50")
	if !regexp.MustCompile(`^\d{2}/\d{2}/\d{4}$`).MatchString(q.Get("DT")) {
		t.Fatal(q.Get("DT"))
	}
	eq(t, q.Get("DV"), FonepayHMAC(fonepaySecret, []string{"NBQM", "P", "NP123", "10.50", "NPR", q.Get("DT"), "Order 1", "N/A", "https://s.example/r"}))
	_, err = fp.Initiate(ctx, InitiateInput{OrderID: strings.Repeat("X", 26), AmountPaisa: 100, Description: "x", ReturnURL: "https://r"})
	wantErrContains(t, err, "3–25")
	eq(t, FonepayDate(time.Date(2026, 11, 4, 20, 0, 0, 0, time.UTC)), "11/05/2026") // already the 5th in Nepal (UTC+5:45)
}

func TestFonepay_ForgedCallbackWithoutDVCannotForceFailed(t *testing.T) {
	forged := map[string]string{"PRN": "NP123", "PID": "NBQM", "PS": "false", "RC": "failed", "UID": "x", "BC": "y"}
	_, err := newTestFonepay(t, FonepayConfig{}).Verify(context.Background(), VerifyInput{OrderID: "NP123", AmountPaisa: 1000, Callback: forged})
	wantCode(t, err, "invalid_signature")
	_, err = newTestFonepay(t, FonepayConfig{LenientSignature: true}).Verify(context.Background(), VerifyInput{OrderID: "NP123", AmountPaisa: 1000, Callback: forged})
	wantCode(t, err, "verify_unavailable")
}

func TestFonepay_LegacyVerificationUpstream5xxErrorsInsteadOfFailed(t *testing.T) {
	cb := signedCallback(map[string]string{"PRN": "NP123", "PID": "NBQM", "PS": "true", "RC": "successful", "UID": "36463", "BC": "NICENPKA", "INI": "98", "P_AMT": "10", "R_AMT": "10"})
	_, err := newTestFonepay(t, FonepayConfig{HTTPClient: mock(reply(502, "<html>Bad Gateway</html>"))}).Verify(context.Background(), VerifyInput{OrderID: "NP123", AmountPaisa: 1000, Callback: cb})
	wantCode(t, err, "upstream_error")
	fp := newTestFonepay(t, FonepayConfig{HTTPClient: mock(reply(200, "<response><response_code>successful</response_code><success>true</success></response>"))})
	v, err := fp.Verify(context.Background(), VerifyInput{OrderID: "NP123", AmountPaisa: 1000, Callback: cb})
	if err != nil {
		t.Fatal(err)
	}
	eq(t, v.Status, StatusPaid)
	amountEq(t, v.AmountPaisa, 1000)
}

func TestFonepay_CallbackDVVerifiedCaseInsensitivelyTamperRejected(t *testing.T) {
	fp := newTestFonepay(t, FonepayConfig{})
	cb := signedCallback(map[string]string{"PRN": "d1580724437729", "PID": "NBQM", "PS": "true", "RC": "successful", "UID": "36463", "BC": "NICENPKA", "INI": "9841845631", "P_AMT": "20.0", "R_AMT": "30"})
	cb["DV"] = strings.ToLower(cb["DV"])
	eq(t, fp.CallbackValid(cb), true)
	tampered := map[string]string{}
	for k, v := range cb {
		tampered[k] = v
	}
	tampered["R_AMT"] = "3"
	eq(t, fp.CallbackValid(tampered), false)
}

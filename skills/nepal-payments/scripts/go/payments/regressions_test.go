package payments

// Ported from the "regressions" block in scripts/ts/test/adapters.test.ts (TODO.md correctness list).

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"testing"
)

func wantPaymentError(t *testing.T, err error, code string, status int) {
	t.Helper()
	if pe := paymentErr(t, err); pe.Code != code || pe.HTTPStatus != status {
		t.Fatalf("got %q/%d (%s), want %q/%d", pe.Code, pe.HTTPStatus, pe.Message, code, status)
	}
}

func TestRegression_PaisaToRupeesKeepsSignBelowOneRupee(t *testing.T) {
	for p, want := range map[int64]string{-5: "-0.05", -99: "-0.99", -100: "-1", -12345: "-123.45"} {
		eq(t, PaisaToRupees(p), want)
	}
}

func TestRegression_RupeesToPaisaRejectsExponentAndPlusForms(t *testing.T) {
	for _, bad := range []string{"1e3", "+5", "NaN", ""} {
		_, err := RupeesToPaisa(bad)
		wantErrContains(t, err, "not a rupee amount")
	}
}

func TestRegression_BasicAuthEncodesUTF8(t *testing.T) {
	eq(t, BasicAuth("ü", "पासवर्ड"), "Basic "+base64.StdEncoding.EncodeToString([]byte("ü:पासवर्ड")))
}

func TestRegression_NewOrderIDUsesOnly36SymbolAlphabet(t *testing.T) {
	re := regexp.MustCompile(`^P[0-9A-Z]{18,19}$`)
	for i := 0; i < 200; i++ {
		if id := NewOrderID(); !re.MatchString(id) {
			t.Fatal(id)
		}
	}
}

func TestRegression_ProviderLookupIgnoresPrototypeKeys(t *testing.T) {
	cfg := EsewaSandboxConfig()
	p, err := New(Config{Esewa: &cfg})
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"constructor", "__proto__", "toString"} {
		_, err := p.Adapter(id)
		wantErrContains(t, err, "not configured")
	}
	a, err := p.Adapter("esewa")
	if err != nil || a.ID() != ProviderEsewa {
		t.Fatal(a, err)
	}
}

func TestRegression_StatusTablesIgnorePrototypeKeys(t *testing.T) {
	for _, s := range []string{"constructor", "__proto__", "toString"} {
		e := newTestEsewa(t, mock(reply(200, map[string]any{"status": s, "total_amount": 10, "ref_id": nil})))
		v, err := e.Verify(context.Background(), VerifyInput{OrderID: "X", AmountPaisa: 1000})
		if err != nil {
			t.Fatal(err)
		}
		eq(t, v.Status, StatusUnknown)
	}
}

func TestRegression_EsewaMalformedSuccessDataIs400(t *testing.T) {
	e := newTestEsewa(t, nil)
	b64 := func(s string) string { return ToBase64([]byte(s)) }
	for _, data := range []string{"!!!!", b64("not json"), b64("{"), b64("\xff\xfe"), b64(`{"signed_field_names":"a","a":"\xff"}`)} {
		_, _, err := e.ParseSuccess(data)
		wantPaymentError(t, err, "malformed_callback", 400)
		_, err = e.Verify(context.Background(), VerifyInput{OrderID: "X", AmountPaisa: 1000, Callback: map[string]string{"data": data}})
		wantPaymentError(t, err, "malformed_callback", 400)
	}
}

func TestRegression_EsewaErrorBodyFromErrorMessageOrErrorMessageCamel(t *testing.T) {
	ctx := context.Background()
	_, err := newTestEsewa(t, mock(reply(503, `{"code":0,"errorMessage":"Service is currently unavailable"}`))).Verify(ctx, VerifyInput{OrderID: "X", AmountPaisa: 1000})
	wantPaymentError(t, err, "esewa_0", 503)
	wantErrContains(t, err, "Service is currently unavailable")
	_, err = newTestEsewa(t, mock(reply(400, `{"code":"IP-400","error_message":"Invalid Signature"}`))).IntentBook(ctx, EsewaIntentBookInput{OrderID: "X", AmountPaisa: 10000, CallbackURL: "https://c", RedirectURL: "https://r"})
	wantPaymentError(t, err, "esewa_IP-400", 400)
	wantErrContains(t, err, "Invalid Signature")
	_, err = newTestEsewa(t, mock(reply(400, `{"code":"IP-401","errorMessage":"No booking"}`))).IntentVerify(ctx, "X", "B|C", nil)
	wantPaymentError(t, err, "esewa_IP-401", 400)
	wantErrContains(t, err, "No booking")
	_, err = newTestEsewa(t, mock(reply(502, "<html>bad gateway</html>"))).Verify(ctx, VerifyInput{OrderID: "X", AmountPaisa: 1000})
	wantPaymentError(t, err, "http_502", 502)
	_, err = newTestEsewa(t, mock(reply(400, `{"code":null}`))).Verify(ctx, VerifyInput{OrderID: "X", AmountPaisa: 1000})
	wantPaymentError(t, err, "http_400", 400)
}

func TestRegression_EsewaIntentCallbackRawKeepsNumberTextDecodedUsesString(t *testing.T) {
	e := newTestEsewa(t, nil)
	key := EsewaSandboxIntentAccessKey
	order := []string{"product_code", "amount", "reference_code", "status"}
	names := strings.Join(order, ",")
	fields := func(amount string) map[string]string {
		return map[string]string{"product_code": "INTENT", "reference_code": "R1", "status": "SUCCESS", "amount": amount}
	}
	raw := func(r string) bool {
		t.Helper()
		ok, err := e.IntentCallbackValidRaw([]byte(r))
		if err != nil {
			t.Fatal(err)
		}
		return ok
	}
	decoded := func(m map[string]any) bool {
		t.Helper()
		ok, err := e.IntentCallbackValid(m)
		if err != nil {
			t.Fatal(err)
		}
		return ok
	}
	// Signed over "100.0", exactly as the JSON text carries it.
	sigExact := EsewaSign(key, fields("100.0"), order)
	body := fmt.Sprintf(`{"product_code":"INTENT","amount":100.0,"reference_code":"R1","status":"SUCCESS","signed_field_names":"%s","signature":"%s"}`, names, sigExact)
	eq(t, raw(body), true)
	var parsed map[string]any
	if err := json.Unmarshal([]byte(body), &parsed); err != nil {
		t.Fatal(err)
	}
	eq(t, decoded(parsed), false) // decoded: 100.0 is just 100
	eq(t, decoded(jsonMap(t, body)), false)
	// Signed over "100", the String(v) form; the raw body is accepted too.
	sigJS := EsewaSign(key, fields("100"), order)
	body2 := strings.Replace(body, sigExact, sigJS, 1)
	eq(t, raw(body2), true)
	parsed = nil
	if err := json.Unmarshal([]byte(body2), &parsed); err != nil {
		t.Fatal(err)
	}
	eq(t, decoded(parsed), true)
	// null signs as "", tamper and junk fail.
	sigNull := EsewaSign(key, fields(""), order)
	eq(t, decoded(map[string]any{"product_code": "INTENT", "reference_code": "R1", "status": "SUCCESS", "amount": nil, "signed_field_names": names, "signature": sigNull}), true)
	eq(t, raw(strings.Replace(body, "100.0", "1.0", 1)), false)
	eq(t, raw("not json"), false)
	eq(t, raw("[1]"), false)
}

func TestRegression_NPSCode0WithNullDataIsUnknown(t *testing.T) {
	n := newTestNPS(t, mock(reply(200, `{"code":"0","message":"","errors":[],"data":null}`)))
	v, err := n.Verify(context.Background(), VerifyInput{OrderID: "T1", AmountPaisa: 10000})
	if err != nil {
		t.Fatal(err)
	}
	eq(t, v.Status, StatusUnknown)
	if v.AmountPaisa != nil {
		t.Fatalf("amount = %d, want nil", *v.AmountPaisa)
	}
}

func TestRegression_ConnectIPSNullTxnAmtAndEmptyFallbacks(t *testing.T) {
	ctx := context.Background()
	for _, amt := range []string{`"txnAmt":null,`, ``, `"txnAmt":"abc",`} {
		c := newTestConnectIPS(t, mock(reply(200, `{"status":"ERROR",`+amt+`"statusDesc":"TRANSACTION NOT FOUND"}`)))
		v, err := c.Verify(ctx, VerifyInput{OrderID: "T1", AmountPaisa: 500})
		if err != nil {
			t.Fatal(err)
		}
		if v.AmountPaisa != nil {
			t.Fatalf("%s amount = %d, want nil", amt, *v.AmountPaisa)
		}
	}
	r, err := newTestConnectIPS(t, nil).Initiate(ctx, InitiateInput{OrderID: "T1", AmountPaisa: 500, Description: "Shoes", ConnectIPS: &ConnectIPSInitiateOptions{ReferenceID: "", Remarks: ""}})
	if err != nil {
		t.Fatal(err)
	}
	eq(t, r.Fields["REFERENCEID"], "T1")
	eq(t, r.Fields["REMARKS"], "Shoes")
}

func TestRegression_CyberSourceEmptyReferenceNumberFallsBack(t *testing.T) {
	cs, err := NewCyberSource(CyberSourceConfig{Env: EnvSandbox, ProfileID: "p", AccessKey: "a", SecretKey: "s"})
	if err != nil {
		t.Fatal(err)
	}
	keys := []string{"decision", "reason_code", "req_reference_number", "req_transaction_uuid", "req_amount", "req_currency", "transaction_id"}
	p := map[string]string{"decision": "ACCEPT", "reason_code": "100", "req_reference_number": "", "req_transaction_uuid": "T1", "req_amount": "10.00", "req_currency": "NPR", "transaction_id": "X1"}
	p["signed_field_names"] = strings.Join(append(keys, "signed_field_names"), ",")
	p["signature"] = CyberSourceSign("s", p)
	v, err := cs.Verify(context.Background(), VerifyInput{OrderID: "T1", AmountPaisa: 1000, Callback: p})
	if err != nil {
		t.Fatal(err)
	}
	eq(t, v.Status, StatusPaid)
}

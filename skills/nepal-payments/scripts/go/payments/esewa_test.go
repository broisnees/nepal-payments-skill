package payments

// Ported from scripts/ts/test/providers/esewa.test.ts.

import (
	"context"
	"regexp"
	"strings"
	"testing"
)

var esewaOrder = []string{"total_amount", "transaction_uuid", "product_code"}

func newTestEsewa(t *testing.T, d Doer) *Esewa {
	t.Helper()
	cfg := EsewaSandboxConfig()
	cfg.HTTPClient = d
	e, err := NewEsewa(cfg)
	if err != nil {
		t.Fatal(err)
	}
	return e
}

// esewaSuccess mirrors the TS successData(): ordered fields + signature over signed_field_names.
func esewaSuccess(overrides map[string]string) jsonObject {
	keys := []string{"transaction_code", "status", "total_amount", "transaction_uuid", "product_code", "signed_field_names"}
	vals := map[string]string{
		"transaction_code":   "000AWEO",
		"status":             "COMPLETE",
		"total_amount":       "1000.0",
		"transaction_uuid":   "ORD-2",
		"product_code":       "EPAYTEST",
		"signed_field_names": "transaction_code,status,total_amount,transaction_uuid,product_code,signed_field_names",
	}
	for k, v := range overrides {
		vals[k] = v
	}
	o := make(jsonObject, 0, 7)
	for _, k := range keys {
		o = append(o, jsonKV{k, vals[k]})
	}
	sig := EsewaSign(EsewaSandboxSecretKey, vals, strings.Split(vals["signed_field_names"], ","))
	return append(o, jsonKV{"signature", sig})
}

// with returns a copy with key replaced in place (like JS {...p, key: v}).
func with(o jsonObject, key string, v any) jsonObject {
	out := append(jsonObject(nil), o...)
	for i := range out {
		if out[i].k == key {
			out[i].v = v
		}
	}
	return out
}

func b64JSON(o jsonObject) string { return ToBase64(jsonBody(o)) }

func TestEsewa_SignatureTestVectors(t *testing.T) {
	k := EsewaSandboxSecretKey
	eq(t, EsewaSign(k, map[string]string{"total_amount": "100", "transaction_uuid": "11-201-13", "product_code": "EPAYTEST"}, esewaOrder), "5DZywcrTKD0gia/rsSMcrRHmJl+4Tbol6S+lWgdJ94E=")
	eq(t, EsewaSign(k, map[string]string{"total_amount": "110", "transaction_uuid": "ab14a8f2b02c3", "product_code": "EPAYTEST"}, esewaOrder), "0Gh9pc1fiZDZH7OKOBdn42QMx8drH7tOeMPdRQhI83g=")
	eq(t, EsewaSign(EsewaSandboxIntentAccessKey, map[string]string{"product_code": "INTENT", "amount": "100", "transaction_uuid": "txn-20251220-001"}, []string{"product_code", "amount", "transaction_uuid"}),
		"oVRo2ZkjNpbt5vKs7RSNx1OCcewDaVssoguWsG31HMA=")
}

func TestEsewa_InitiateAmountIsTotalBreakdownIncludedSameStringSigned(t *testing.T) {
	e := newTestEsewa(t, nil)
	ctx := context.Background()
	r, err := e.Initiate(ctx, InitiateInput{OrderID: "ORD-1", AmountPaisa: 11050, Description: "x", ReturnURL: "https://s/r/ORD-1", Esewa: &EsewaInitiateOptions{TaxPaisa: 1000}})
	if err != nil {
		t.Fatal(err)
	}
	eq(t, r.Kind, KindForm)
	eq(t, r.Fields["total_amount"], "110.50")
	eq(t, r.Fields["amount"], "100.50")
	_, err = e.Initiate(ctx, InitiateInput{OrderID: "ORD-1", AmountPaisa: 1000, Description: "x", ReturnURL: "https://s", Esewa: &EsewaInitiateOptions{TaxPaisa: 1000}})
	wantErrContains(t, err, "less than the total")
	eq(t, r.Fields["signature"], EsewaSign(EsewaSandboxSecretKey, r.Fields, esewaOrder))
	eq(t, r.Action, "https://rc-epay.esewa.com.np/api/epay/main/v2/form")
}

func TestEsewa_RejectsUUIDWithForbiddenCharacters(t *testing.T) {
	_, err := newTestEsewa(t, nil).Initiate(context.Background(), InitiateInput{OrderID: "a_b", AmountPaisa: 100, Description: "x", ReturnURL: "https://s"})
	wantErrContains(t, err, "letters, digits")
}

func TestEsewa_SuccessPayloadSignatureVerifiesTamperFailsCommaVariantAccepted(t *testing.T) {
	e := newTestEsewa(t, nil)
	valid := func(data string) bool {
		t.Helper()
		_, ok, err := e.ParseSuccess(data)
		if err != nil {
			t.Fatal(err)
		}
		return ok
	}
	p := esewaSuccess(nil)
	data := b64JSON(p)
	eq(t, valid(data), true)
	eq(t, valid(strings.ReplaceAll(data, "+", " ")), true) // '+' -> ' ' in query
	eq(t, valid(b64JSON(with(p, "total_amount", "1.0"))), false)
	// eSewa signs "1000.0" but displays "1,000.0"
	eq(t, valid(b64JSON(with(p, "total_amount", "1,000.0"))), true)
}

func TestEsewa_NumericTotalAmountVerifiedAgainstRawJSONText(t *testing.T) {
	e := newTestEsewa(t, nil)
	j := strings.Replace(string(jsonBody(esewaSuccess(nil))), `"total_amount":"1000.0"`, `"total_amount":1000.0`, 1) // signed over total_amount=1000.0
	if !strings.Contains(j, `"total_amount":1000.0`) {
		t.Fatal(j)
	}
	_, ok, err := e.ParseSuccess(ToBase64([]byte(j)))
	if err != nil || !ok {
		t.Fatalf("valid=%v err=%v", ok, err)
	}
}

func TestEsewa_VerifyStatusAPIAuthoritativeUsesStoredTotal(t *testing.T) {
	d := mock(reply(200, `{"product_code":"EPAYTEST","transaction_uuid":"ORD-2","total_amount":1000,"status":"COMPLETE","ref_id":"0001TS9"}`))
	e := newTestEsewa(t, d)
	v, err := e.Verify(context.Background(), VerifyInput{OrderID: "ORD-2", AmountPaisa: 100000, Callback: map[string]string{"data": b64JSON(esewaSuccess(nil))}})
	if err != nil {
		t.Fatal(err)
	}
	eq(t, v.Status, StatusPaid)
	amountEq(t, v.AmountPaisa, 100000)
	eq(t, v.TransactionID, "0001TS9")
	re := regexp.MustCompile(`^https://rc\.esewa\.com\.np/api/epay/transaction/status/\?product_code=EPAYTEST&total_amount=1000&transaction_uuid=ORD-2$`)
	if u := d.Calls()[0].URL; !re.MatchString(u) {
		t.Fatal(u)
	}
}

func TestEsewa_VerifyCallbackForAnotherOrderRejected(t *testing.T) {
	e := newTestEsewa(t, mock(reply(200, `{}`)))
	_, err := e.Verify(context.Background(), VerifyInput{OrderID: "ORD-2", AmountPaisa: 100000, Callback: map[string]string{"data": b64JSON(esewaSuccess(map[string]string{"transaction_uuid": "OTHER"}))}})
	wantErrContains(t, err, "does not match")
}

func TestEsewa_StatusMapping(t *testing.T) {
	for _, c := range [][2]string{{"PENDING", "pending"}, {"AMBIGUOUS", "pending"}, {"NOT_FOUND", "not_found"}, {"FULL_REFUND", "refunded"}, {"CANCELED", "canceled"}, {"WEIRD", "unknown"}} {
		e := newTestEsewa(t, mock(reply(200, `{"status":"`+c[0]+`","total_amount":10,"ref_id":null}`)))
		v, err := e.Verify(context.Background(), VerifyInput{OrderID: "X", AmountPaisa: 1000})
		if err != nil {
			t.Fatal(err)
		}
		eq(t, string(v.Status), c[1])
	}
}

package payments

// Ported from scripts/ts/test/adapters.test.ts: describe("getpay").

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"reflect"
	"strings"
	"testing"
)

const (
	getPayTestBase = "https://uat-bank-getpay.nchl.com.np/ecom-web-checkout/v1/secure-merchant/transactions"
	getPayTestID   = "0cc5b1a39f3c4cad864bc1c6a524534f"
	getPayTestKey  = "4fa4c6b9-3f91-43e5-9b4f-319f68187ba5"
)

var (
	getPayTestPap = btoa(`{"institutionId":"122","mid":"123123451770986","tid":"12358762"}`)
	// getPayTestSecret is the TS test's node:crypto reference: base64(SHA-256(oprKey + id)).
	getPayTestSecret = func() string {
		h := sha256.Sum256([]byte(getPayTestKey + getPayTestID))
		return base64.StdEncoding.EncodeToString(h[:])
	}()
	getPayTestToken = btoa(`{"id":"` + getPayTestID + `","oprSecret":"` + getPayTestSecret + `"}`)
)

func btoa(s string) string { return base64.StdEncoding.EncodeToString([]byte(s)) }

func newTestGetPay(t *testing.T, d Doer) *GetPay {
	t.Helper()
	g, err := NewGetPay(GetPayConfig{
		Env: EnvSandbox, PapInfo: getPayTestPap, OprKey: getPayTestKey, WebsiteDomain: "https://shop.example",
		BusinessName: "Shop", ImageURL: "https://shop.example/logo.png", HTTPClient: d,
	})
	if err != nil {
		t.Fatal(err)
	}
	return g
}

func getPayOK(data map[string]any) func(call) (int, any) {
	return reply(200, map[string]any{"status": 0, "message": "SUCCESS", "data": data})
}

func TestGetPay_OprSecretAndTokenDecode(t *testing.T) {
	eq(t, GetPayOprSecret(getPayTestKey, getPayTestID), getPayTestSecret)
	want := GetPayToken{ID: getPayTestID, OprSecret: getPayTestSecret}
	tok, ok := GetPayDecodeToken(getPayTestToken)
	eq(t, ok, true)
	eq(t, tok, want)
	tok, ok = GetPayDecodeToken(btoa(getPayTestID + ":" + getPayTestSecret))
	eq(t, ok, true)
	eq(t, tok, want)
	_, ok = GetPayDecodeToken("%%%")
	eq(t, ok, false)
	_, ok = GetPayDecodeToken(btoa(`{"id":"` + getPayTestID + `"}`))
	eq(t, ok, false)
}

func TestGetPay_InitiateSDKOptionsNumericPriceSameOriginCallbacks(t *testing.T) {
	ctx := context.Background()
	g := newTestGetPay(t, nil)
	r, err := g.Initiate(ctx, InitiateInput{OrderID: "P1", AmountPaisa: 120050, Description: "Cup <set>", ReturnURL: "https://shop.example/ok/P1", FailureURL: "https://shop.example/no/P1"})
	if err != nil {
		t.Fatal(err)
	}
	eq(t, r.Kind, KindSDK)
	eq(t, r.ScriptURL, "https://minio-getpay.nchl.com.np/getpay-cdn/webcheckout/v5/bundle.js")
	eq[any](t, r.Options["price"], 1200.5)
	eq[any](t, r.Options["clientRequestId"], "P1")
	eq[any](t, r.Options["baseUrl"], getPayTestBase)
	eq[any](t, r.Options["insKey"], "")
	if cb := r.Options["callbackUrl"]; !reflect.DeepEqual(cb, map[string]any{"successUrl": "https://shop.example/ok/P1", "failUrl": "https://shop.example/no/P1"}) {
		t.Fatalf("callbackUrl = %v", cb)
	}
	if ui, _ := r.Options["orderInformationUI"].(string); !strings.Contains(ui, "Cup &lt;set&gt;") {
		t.Fatalf("orderInformationUI = %q", ui)
	}
	_, err = g.Initiate(ctx, InitiateInput{OrderID: "P1", AmountPaisa: 100, Description: "x", ReturnURL: "https://evil.example/ok"})
	wantCode(t, err, "invalid_callback_url")
	page, err := g.CheckoutPage(r, "/pay/P1</script>")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(page, "new GetPay(o).initialize()") {
		t.Fatal("checkout page does not start GetPay")
	}
	if strings.Contains(page, `</script>"`) || !strings.Contains(page, `\u003c/script>`) {
		t.Fatalf("checkout page does not escape <: %s", page)
	}
	if !strings.Contains(g.PaymentPage(), `<div id="checkout"></div>`) {
		t.Fatal("payment page has no #checkout")
	}
	if !strings.Contains(g.ReturnPage("/payments/getpay/return/P1"), "window.top.location") {
		t.Fatal("return page does not break out of the iframe")
	}
}

func TestGetPay_VerifyTokenOprSecretMerchantStatusClientID(t *testing.T) {
	ctx := context.Background()
	in := VerifyInput{OrderID: "P1", AmountPaisa: 120000, Callback: map[string]string{"token": getPayTestToken}}
	d := mock(getPayOK(map[string]any{"status": "SUCCESS", "amount": 1200.0, "currency": "NPR", "stan": "379832", "crrn": "624503379832", "clientId": "P1", "remarks": "Success"}))
	v, err := newTestGetPay(t, d).Verify(ctx, in)
	if err != nil {
		t.Fatal(err)
	}
	eq(t, v.Status, StatusPaid)
	amountEq(t, v.AmountPaisa, 120000)
	eq(t, v.TransactionID, getPayTestID)
	eq(t, d.Calls()[0].URL, getPayTestBase+"/merchant-status")
	eq(t, d.Calls()[0].Body, `{"id":"`+getPayTestID+`","papInfo":"`+getPayTestPap+`"}`)

	_, err = newTestGetPay(t, mock(getPayOK(map[string]any{"status": "SUCCESS", "amount": 1200.0, "clientId": "SOMEONE-ELSES-ORDER"}))).Verify(ctx, in)
	wantCode(t, err, "id_mismatch")

	g := newTestGetPay(t, nil)
	forged := btoa(`{"id":"` + getPayTestID + `","oprSecret":"` + btoa("not the hash") + `"}`)
	_, err = g.Verify(ctx, VerifyInput{OrderID: "P1", AmountPaisa: 120000, Callback: map[string]string{"token": forged}})
	wantCode(t, err, "bad_signature")
	_, err = g.Verify(ctx, VerifyInput{OrderID: "P1", AmountPaisa: 120000, Callback: map[string]string{"token": "@@"}})
	wantCode(t, err, "malformed_callback")

	v, err = newTestGetPay(t, mock(getPayOK(map[string]any{"status": "FAILED", "amount": 1200.0, "clientId": "P1"}))).Verify(ctx, in)
	if err != nil {
		t.Fatal(err)
	}
	eq(t, v.Status, StatusFailed)
	nf := map[string]any{"status": -1, "message": "Failed to fetch merchant information: Transaction not found for ID: " + getPayTestID}
	v, err = newTestGetPay(t, mock(reply(400, nf))).Verify(ctx, in)
	if err != nil {
		t.Fatal(err)
	}
	eq(t, v.Status, StatusNotFound)
}

func TestGetPay_VerifyWithoutTokenStatementNeverPaid(t *testing.T) {
	ctx := context.Background()
	in := VerifyInput{OrderID: "P1", AmountPaisa: 120000}
	d := mock(getPayOK(map[string]any{"transactionId": getPayTestID, "clientRequestId": "P1", "saleTransactionAmount": 1200.0, "status": "SUCCESS", "paymentScheme": "MASTERCARD"}))
	v, err := newTestGetPay(t, d).Verify(ctx, in)
	if err != nil {
		t.Fatal(err)
	}
	eq(t, v.Status, StatusUnknown)
	amountEq(t, v.AmountPaisa, 120000)
	eq(t, v.TransactionID, getPayTestID)
	eq(t, d.Calls()[0].URL, getPayTestBase+"/transaction-statement")
	eq(t, d.Calls()[0].Body, `{"clientRequestId":"P1"}`)

	v, err = newTestGetPay(t, mock(getPayOK(map[string]any{"transactionId": getPayTestID, "clientRequestId": "P1", "saleTransactionAmount": 1200.0, "status": "FAILED"}))).Verify(ctx, in)
	if err != nil {
		t.Fatal(err)
	}
	eq(t, v.Status, StatusFailed)
	nf := map[string]any{"status": -1, "message": "Failed to fetch transaction statement: Transaction not found for transaction ID: x"}
	v, err = newTestGetPay(t, mock(reply(400, nf))).Verify(ctx, in)
	if err != nil {
		t.Fatal(err)
	}
	eq(t, v.Status, StatusNotFound)
	_, err = newTestGetPay(t, mock(reply(500, "oops"))).Verify(ctx, in)
	paymentErr(t, err)
}

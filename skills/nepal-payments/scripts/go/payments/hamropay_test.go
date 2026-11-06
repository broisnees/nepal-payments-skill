package payments

// Ported from scripts/ts/test/adapters.test.ts: describe("hamropay").

import (
	"bufio"
	"context"
	"crypto/hmac"
	"crypto/sha512"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"reflect"
	"strings"
	"testing"
)

const hamroMerchant = "PN_-Nd99TBnAlBjCgl8ef_b"

func hamroPayTestConfig(d Doer) HamroPayConfig {
	return HamroPayConfig{
		Env: EnvSandbox, MerchantID: hamroMerchant, ClientID: "client@123", ClientAPIKey: "merchant-api-key-test",
		ClientSecret: "abcdefg", WebhookSecret: "whsec", HTTPClient: d,
	}
}

func newTestHamroPay(t *testing.T, cfg HamroPayConfig) *HamroPay {
	t.Helper()
	h, err := NewHamroPay(cfg)
	if err != nil {
		t.Fatal(err)
	}
	return h
}

// hamroNode is the TS test's node:crypto reference: base64(HMAC-SHA512(secret, msg)).
func hamroNode(secret, msg string) string {
	m := hmac.New(sha512.New, []byte(secret))
	m.Write([]byte(msg))
	return base64.StdEncoding.EncodeToString(m.Sum(nil))
}

func TestHamroPay_SignatureCommaJoinedCommasRefused(t *testing.T) {
	got, err := HamroPaySign("abcdefg", "T1", "1000", "M", "C", "K")
	if err != nil {
		t.Fatal(err)
	}
	eq(t, got, hamroNode("abcdefg", "T1,1000,M,C,K"))
	_, err = HamroPaySign("s", "a,b")
	wantErrContains(t, err, "commas")
}

func TestHamroPay_InitiateSignedSessionThenSignedGatewayForm(t *testing.T) {
	const sid = "ca8f7b70-b9c9-11ee-8611-0a73743c8233"
	d := mock(reply(200, map[string]any{"sessionId": sid, "merchantId": hamroMerchant}))
	h := newTestHamroPay(t, hamroPayTestConfig(d))
	r, err := h.Initiate(context.Background(), InitiateInput{OrderID: "P1", AmountPaisa: 8992, Description: "T-shirt", ReturnURL: "https://shop.example/ok", FailureURL: "https://shop.example/no"})
	if err != nil {
		t.Fatal(err)
	}
	c := d.Calls()[0]
	eq(t, c.URL, "https://uat-payclient.hamropatro.com/v1/checkout/sessionId")
	eq(t, c.Header.Get("Client-Id"), "client@123")
	eq(t, c.Header.Get("Client-API-Key"), "merchant-api-key-test")
	eq(t, c.Close, true) // Connection: close
	eq(t, c.Header.Get("Signature"), hamroNode("abcdefg", "P1,8992,"+hamroMerchant+",client@123,merchant-api-key-test"))
	body := jsonMap(t, c.Body)
	product := body["productList"].([]any)[0].(map[string]any)
	got := []any{body["merchantTxnId"], body["transactionAmount"], body["successRedirectionUrl"], body["failedRedirectionUrl"], product["price"]}
	want := []any{"P1", "8992", "https://shop.example/ok", "https://shop.example/no", json.Number("89.92")}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("body = %v, want %v", got, want)
	}
	eq(t, r.Kind, KindForm)
	eq(t, r.Action, "https://uat-checkout-pay.hamropatro.com/api/checkout")
	eq(t, r.ProviderRef, sid)
	eq(t, r.Fields["token"], hamroNode("abcdefg", hamroMerchant+",P1,"+sid+",8992,client@123,merchant-api-key-test"))
	eq(t, strings.Join(r.orderedFieldNames(), ","), "merchant_id,session_id,token,merchant_transaction_id,remarks")
}

func TestHamroPay_InitiateLimitsIDLiveGatewayMerchantEcho(t *testing.T) {
	ctx := context.Background()
	h := newTestHamroPay(t, hamroPayTestConfig(mock(reply(200, map[string]any{}))))
	in := func(id string, paisa int64) InitiateInput {
		return InitiateInput{OrderID: id, AmountPaisa: paisa, Description: "x", ReturnURL: "https://a/"}
	}
	_, err := h.Initiate(ctx, in("P1", 999))
	wantErrContains(t, err, "Rs 10")
	_, err = h.Initiate(ctx, in("P1", 5_000_001))
	wantErrContains(t, err, "Rs 10")
	_, err = h.Initiate(ctx, in(strings.Repeat("X", 26), 1000))
	wantErrContains(t, err, "1–25")
	live := hamroPayTestConfig(nil)
	live.Env = EnvProduction
	_, err = newTestHamroPay(t, live).Initiate(ctx, in("P1", 1000))
	wantErrContains(t, err, "GatewayURL")

	h = newTestHamroPay(t, hamroPayTestConfig(mock(reply(200, map[string]any{"sessionId": "S", "merchantId": "SOMEONE_ELSE"}))))
	_, err = h.Initiate(ctx, in("P1", 1000))
	wantCode(t, err, "merchant_mismatch")
	h = newTestHamroPay(t, hamroPayTestConfig(mock(reply(401, map[string]any{"code": 16, "message": "Unauthorized Request", "details": []any{}}))))
	_, err = h.Initiate(ctx, in("P1", 1000))
	wantCode(t, err, "unauthorized")
}

func TestHamroPay_VerifySignedStatusMappingRupeesIDEcho(t *testing.T) {
	ctx := context.Background()
	cases := []struct {
		body   map[string]any
		want   PaymentStatus
		amount any
	}{
		{map[string]any{"merchantTxnId": "P1", "status": "COMPLETED", "amount": 89.92, "trackingId": "TRK1"}, StatusPaid, int64(8992)},
		{map[string]any{"merchantTransactionId": "P1", "status": "PROCESSING", "amount": 0}, StatusPending, nil},
		{map[string]any{"merchantTxnId": "P1", "status": "FAILED", "amount": 0}, StatusFailed, nil},
		{map[string]any{"merchantTransactionId": "P1", "trackingId": "", "status": "NOT_INITIATED", "amount": 0, "message": "TRANSACTION NOT INITIATED YET"}, StatusNotFound, nil},
		{map[string]any{"merchantTxnId": "P1", "status": "SOMETHING_NEW"}, StatusUnknown, nil},
	}
	for _, tc := range cases {
		d := mock(reply(200, tc.body))
		v, err := newTestHamroPay(t, hamroPayTestConfig(d)).Verify(ctx, VerifyInput{OrderID: "P1", AmountPaisa: 8992})
		if err != nil {
			t.Fatal(err)
		}
		eq(t, v.Status, tc.want)
		eq(t, deref(v.AmountPaisa), tc.amount)
		c := d.Calls()[0]
		eq(t, c.URL, "https://uat-payclient.hamropatro.com/v1/checkout/transaction")
		eq(t, c.Header.Get("Signature"), hamroNode("abcdefg", "P1,"+hamroMerchant+",client@123,merchant-api-key-test"))
		eq(t, c.Body, `{"merchantId":"`+hamroMerchant+`","merchantTxnId":"P1"}`)
	}
	h := newTestHamroPay(t, hamroPayTestConfig(mock(reply(200, map[string]any{"merchantTxnId": "P2", "status": "COMPLETED", "amount": 89.92}))))
	_, err := h.Verify(ctx, VerifyInput{OrderID: "P1", AmountPaisa: 8992})
	wantCode(t, err, "id_mismatch")
	eq(t, h.OrderIDFromCallback(map[string]string{"MerchantTxnId": "P1"}), "P1")
}

func TestHamroPay_WebhookSignatureAnyAmountRendering(t *testing.T) {
	h := newTestHamroPay(t, hamroPayTestConfig(nil))
	body := func(amount any) map[string]any {
		return map[string]any{"merchantTxnId": "P1", "merchantId": hamroMerchant, "amount": amount, "status": "COMPLETED", "metadata": map[string]any{}}
	}
	sig := func(a string) string { return hamroNode("whsec", "P1,"+hamroMerchant+",COMPLETED,"+a) }
	check := func(b map[string]any, s string, want bool) {
		t.Helper()
		ok, err := h.VerifyWebhook(b, s)
		if err != nil {
			t.Fatal(err)
		}
		eq(t, ok, want)
	}
	for _, a := range []string{"1200", "1200.0", "1200.00"} {
		check(body(float64(1200)), sig(a), true)
		check(body(json.Number("1200")), sig(a), true) // decoded with UseNumber
	}
	check(body(1.5), sig("1.50"), true)
	check(body(float64(1201)), sig("1200"), false)
	check(body("1200"), sig("1200"), false)
	check(body(float64(1200)), "", false)
	noSecret := hamroPayTestConfig(nil)
	noSecret.WebhookSecret = ""
	_, err := newTestHamroPay(t, noSecret).VerifyWebhook(body(float64(1200)), "x")
	wantErrContains(t, err, "WebhookSecret")
}

// truncatedServer answers every request like Hamro Pay's Envoy front on errors: a chunked 401 whose only
// chunk is chunk, then the socket closes without the terminating 0-length chunk.
func truncatedServer(t *testing.T, chunk string) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			if req, err := http.ReadRequest(bufio.NewReader(conn)); err == nil {
				_, _ = io.Copy(io.Discard, req.Body)
				fmt.Fprintf(conn, "HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nTrailer: Grpc-Status\r\n"+
					"Transfer-Encoding: chunked\r\n\r\n%x\r\n%s\r\n", len(chunk), chunk)
			}
			conn.Close()
		}
	}()
	return "http://" + ln.Addr().String()
}

func TestHamroPay_TruncatedChunkedBodyKeptOnlyWhenCompleteJSON(t *testing.T) {
	ctx := context.Background()
	verify := func(chunk string) error {
		cfg := hamroPayTestConfig(nil)
		cfg.APIBaseURL = truncatedServer(t, chunk)
		_, err := newTestHamroPay(t, cfg).Verify(ctx, VerifyInput{OrderID: "O1", AmountPaisa: 1000})
		return err
	}
	err := verify(`{"code":16,"message":"Unauthorized Request","details":[]}`)
	wantCode(t, err, "unauthorized")
	if pe := paymentErr(t, err); pe.HTTPStatus != 401 {
		t.Fatalf("status = %d, want 401", pe.HTTPStatus)
	}
	wantCode(t, verify(`{"code":16,"message":"Unauth`), "network_error")
}

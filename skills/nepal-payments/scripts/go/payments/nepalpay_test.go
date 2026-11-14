package payments

// Ported from scripts/ts/test/providers/nepalpay.test.ts.

import (
	"context"
	"crypto"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"reflect"
	"strings"
	"testing"
)

func nepalPayTestConfig(t *testing.T, d Doer) NepalPayConfig {
	t.Helper()
	return NepalPayConfig{
		Env: EnvSandbox, AcquirerID: "00001701", MerchantID: "17012UVSTIR", MerchantName: "BBSM", MerchantCategoryCode: "5021",
		MerchantCity: "Kathmandu", MerchantPostalCode: "4600", StoreLabel: "Store1", TerminalLabel: "Terminal1",
		Username: "npiuser", Password: "pw", PrivateKeyPEM: pkcs8PEM(t, testRSAKey(t)), HTTPClient: d,
	}
}

func newTestNepalPay(t *testing.T, d Doer) *NepalPay {
	t.Helper()
	n, err := NewNepalPay(nepalPayTestConfig(t, d))
	if err != nil {
		t.Fatal(err)
	}
	return n
}

func nepalPayVerifySig(t *testing.T, sigB64, msg string) {
	t.Helper()
	sig, err := FromBase64(sigB64)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256([]byte(msg))
	if err := rsa.VerifyPKCS1v15(&testRSAKey(t).PublicKey, crypto.SHA256, digest[:], sig); err != nil {
		t.Fatalf("signature over %q: %v", msg, err)
	}
}

const nepalPayGenerated = `{"timestamp":"2022-05-23 04:25:26","responseCode":"000","responseStatus":"SUCCESS","responseMessage":"QR String generated successfully.",` +
	`"data":{"validationTraceId":"2205260000001900KIY","qrString":" 000201010212...6304607F","qrImage":"iVBORw0KGgo="}}`

func nepalPayTxnRow(o map[string]any) map[string]any {
	m := map[string]any{"nQrTxnId": "2312060000059575KMB", "amount": 10.5, "tranType": "PMT", "merchantBillNo": "P1"}
	for k, v := range o {
		m[k] = v
	}
	return m
}

func nepalPayReport(rows ...any) map[string]any {
	if rows == nil {
		rows = []any{}
	}
	return map[string]any{"timestamp": "2024-02-07T07:10:47.928+0000", "responseCode": "200", "responseStatus": "SUCCESS", "responseBody": rows}
}

func TestNepalPay_TokenStringCommaJoinedNoSpacesUserIDLast(t *testing.T) {
	eq(t, NepalPayTokenString(NepalPayTokenFields{
		AcquirerID: "00001701", MerchantID: "17012UVSTIR", MerchantCategoryCode: "5021", TransactionCurrency: "524",
		TransactionAmount: "10.50", BillNumber: "P1", UserID: "npiuser",
	}), "00001701,17012UVSTIR,5021,524,10.50,P1,npiuser")
}

func TestNepalPay_InitiateDynamicQRTwoDecimalsSignedTokenBasicAuth(t *testing.T) {
	ctx := context.Background()
	d := mock(reply(200, nepalPayGenerated))
	n := newTestNepalPay(t, d)
	r, err := n.Initiate(ctx, InitiateInput{OrderID: "P1", AmountPaisa: 1050, Description: "Everest T-shirt, large and blue"})
	if err != nil {
		t.Fatal(err)
	}
	c := d.Calls()[0]
	eq(t, c.URL, "https://devopennpi.connectips.com/qr/generateQR")
	eq(t, c.Header.Get("Authorization"), "Basic "+ToBase64([]byte("npiuser:pw")))
	body := jsonMap(t, c.Body)
	eq(t, body["pointOfInitialization"], any(json.Number("12")))
	eq(t, body["transactionAmount"], any("10.50"))
	eq(t, body["transactionCurrency"], any(json.Number("524")))
	eq(t, body["merchantCategoryCode"], any(json.Number("5021")))
	eq(t, body["billNumber"], any("P1"))
	eq(t, len(body["purposeOfTransaction"].(string)), 25)
	eq(t, body["qrImage"], any(true))
	nepalPayVerifySig(t, body["token"].(string), "00001701,17012UVSTIR,5021,524,10.50,P1,npiuser")
	eq(t, r.Kind, KindQR)
	eq(t, r.ProviderRef, "2205260000001900KIY")
	eq(t, r.QRString, "000201010212...6304607F")
	eq(t, r.QRImage, "iVBORw0KGgo=")

	d2 := mock(reply(200, nepalPayGenerated))
	n.client = d2
	if _, err := n.Initiate(ctx, InitiateInput{OrderID: "P2", AmountPaisa: 100000, Description: "x"}); err != nil {
		t.Fatal(err)
	}
	eq(t, jsonMap(t, d2.Calls()[0].Body)["transactionAmount"], any("1000.00"))
}

func TestNepalPay_InitiateBillNumberCharsetLengthErrorCodesSurface(t *testing.T) {
	ctx := context.Background()
	_, err := newTestNepalPay(t, nil).Initiate(ctx, InitiateInput{OrderID: strings.Repeat("X", 26), AmountPaisa: 100, Description: "x"})
	wantErrContains(t, err, "1–25")
	d := mock(reply(400, `{"responses":[{"responseCode":"E003","responseMessage":"INVALID TOKEN"}]}`))
	_, err = newTestNepalPay(t, d).Initiate(ctx, InitiateInput{OrderID: "P1", AmountPaisa: 100, Description: "x"})
	wantCode(t, err, "E003")
}

func TestNepalPay_VerifyReportByTraceIDSuccessAfterFailedScanCounts(t *testing.T) {
	d := mock(reply(200, nepalPayReport(
		nepalPayTxnRow(map[string]any{"nQrTxnId": "A", "debitStatus": "E001", "creditStatus": nil}),
		nepalPayTxnRow(map[string]any{"nQrTxnId": "B", "debitStatus": "000", "creditStatus": "DEFER"}),
	)))
	v, err := newTestNepalPay(t, d).Verify(context.Background(), VerifyInput{OrderID: "P1", AmountPaisa: 1050, ProviderRef: "2205260000001900KIY"})
	if err != nil {
		t.Fatal(err)
	}
	c := d.Calls()[0]
	eq(t, c.URL, "https://devopennpi.connectips.com/nQR/v1/merchanttxnreport")
	if got, want := jsonMap(t, c.Body), map[string]any{"validationTraceId": "2205260000001900KIY", "merchantId": "17012UVSTIR", "acquirerId": "00001701"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("body = %v", got)
	}
	eq(t, v.Status, StatusPaid)
	amountEq(t, v.AmountPaisa, 1050)
	eq(t, v.TransactionID, "B")
}

func TestNepalPay_VerifyStatusMapping(t *testing.T) {
	ctx := context.Background()
	cases := []struct {
		body any
		want PaymentStatus
	}{
		{nepalPayReport(nepalPayTxnRow(map[string]any{"debitStatus": "000", "creditStatus": "000"})), StatusPaid},
		{nepalPayReport(nepalPayTxnRow(map[string]any{"debitStatus": "000", "creditStatus": "999"})), StatusPaid},
		{nepalPayReport(nepalPayTxnRow(map[string]any{"debitStatus": "000", "creditStatus": "E99"})), StatusUnknown},
		{nepalPayReport(nepalPayTxnRow(map[string]any{"debitStatus": "E001", "creditStatus": nil})), StatusFailed},
		{nepalPayReport(nepalPayTxnRow(map[string]any{"debitStatus": "000", "creditStatus": "000", "tranType": "RFND"})), StatusNotFound},
		{nepalPayReport(), StatusNotFound},
		{map[string]any{"responseCode": "E010", "responseMessage": "RECORD NOT FOUND"}, StatusNotFound},
	}
	for _, c := range cases {
		v, err := newTestNepalPay(t, mock(reply(200, c.body))).Verify(ctx, VerifyInput{OrderID: "P1", AmountPaisa: 1050, ProviderRef: "T"})
		if err != nil {
			t.Fatal(err)
		}
		eq(t, v.Status, c.want)
	}
	_, err := newTestNepalPay(t, nil).Verify(ctx, VerifyInput{OrderID: "P1", AmountPaisa: 1050})
	wantCode(t, err, "missing_provider_ref")
}

func TestNepalPay_OAuthPasswordGrantOnceBearerReusedUntilExpiry(t *testing.T) {
	ctx := context.Background()
	d := mock(func(c call) (int, any) {
		if strings.HasSuffix(c.URL, "/oauth/token") {
			return 200, map[string]any{"access_token": "AT1", "token_type": "bearer", "expires_in": 299}
		}
		return 200, nepalPayReport()
	})
	cfg := nepalPayTestConfig(t, d)
	cfg.Auth, cfg.ClientID, cfg.ClientSecret = "oauth", "cid", "csec"
	o, err := NewNepalPay(cfg)
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		if _, err := o.Verify(ctx, VerifyInput{OrderID: "P1", AmountPaisa: 100, ProviderRef: "T"}); err != nil {
			t.Fatal(err)
		}
	}
	calls := d.Calls()
	eq(t, len(calls), 3)
	eq(t, calls[0].Header.Get("Authorization"), "Basic "+ToBase64([]byte("cid:csec")))
	eq(t, calls[0].Body, "grant_type=password&username=npiuser&password=pw")
	eq(t, calls[1].Header.Get("Authorization"), "Bearer AT1")
	eq(t, calls[2].Header.Get("Authorization"), "Bearer AT1")
}

func TestNepalPay_ConfirmPaymentReplySignedOverDocumentedFields(t *testing.T) {
	n := newTestNepalPay(t, nil)
	r, err := n.ConfirmationResponse(NepalPayNotification{TxnDate: "2024-11-10 01:35:31", MerchantBillNo: "P1", PaymentRef: "2411100000067378ZHU"}, true)
	if err != nil {
		t.Fatal(err)
	}
	nepalPayVerifySig(t, r.Signature, "2024-11-10 01:35:31,SUCCESS,TRANSACTION SUCCESSFUL,P1,2411100000067378ZHU")
	eq(t, n.OrderIDFromCallback(map[string]string{"merchantBillNo": "P1"}), "P1")
}

func nepalPayTestSPKI(t *testing.T) string {
	t.Helper()
	der, err := x509.MarshalPKIXPublicKey(&testRSAKey(t).PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	return string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der}))
}

func newTestNepalPayNCHL(t *testing.T) *NepalPay {
	t.Helper()
	cfg := nepalPayTestConfig(t, nil)
	cfg.NCHLPublicKeyPEM, cfg.WSURL, cfg.WSUsername, cfg.WSAPIToken = nepalPayTestSPKI(t), "wss://ws.example/nqrws", "wsuser", "secret-api-token"
	n, err := NewNepalPay(cfg)
	if err != nil {
		t.Fatal(err)
	}
	return n
}

func TestNepalPay_ConfirmationSignatureOverDocumentedStringPayerMobileFallback(t *testing.T) {
	note := map[string]any{
		"merchantBillNo": "NA", "merchantId": "0010SVQNL9H", "merchantName": "Quantum Labs", "paymentRef": "2411100000067378ZHU",
		"channel": "CIPS", "payerMobile": "+977-9843705813", "sessionNo": "5446", "status": "SUCCESS",
	}
	with := func(kv ...any) map[string]any {
		m := map[string]any{}
		for k, v := range note {
			m[k] = v
		}
		for i := 0; i < len(kv); i += 2 {
			m[kv[i].(string)] = kv[i+1]
		}
		return m
	}
	msg := "NA,0010SVQNL9H,Quantum Labs,2411100000067378ZHU,CIPS,+977-9843705813,5446"
	eq(t, NepalPayConfirmationString(note), msg)
	eq(t, NepalPayConfirmationString(with("payerMobileNumber", "98", "sessionNo", nil)), "NA,0010SVQNL9H,Quantum Labs,2411100000067378ZHU,CIPS,98,")
	eq(t, NepalPayConfirmationString(with("payerMobileNumber", nil)), msg)
	sig, err := RSASHA256SignBase64(pkcs8PEM(t, testRSAKey(t)), msg)
	if err != nil {
		t.Fatal(err)
	}
	w := newTestNepalPayNCHL(t)
	for _, c := range []struct {
		note map[string]any
		want bool
	}{
		{with("signature", sig), true},
		{with("sessionNo", "5447", "signature", sig), false},
		{with("signature", "not base64!"), false},
		{note, false},
	} {
		got, err := w.VerifyConfirmation(c.note)
		if err != nil {
			t.Fatal(err)
		}
		eq(t, got, c.want)
	}
	if _, err := newTestNepalPay(t, nil).VerifyConfirmation(note); err == nil || !strings.Contains(err.Error(), "NCHLPublicKeyPEM") {
		t.Fatalf("want NCHLPublicKeyPEM error, got %v", err)
	}
	if RSASHA256VerifyBase64("not a pem", msg, sig) {
		t.Fatal("malformed key verified")
	}
}

func TestNepalPay_WebSocketRequestTerminalAsMerchantIDAPITokenPKCS1Encrypted(t *testing.T) {
	w := newTestNepalPayNCHL(t)
	r, err := w.WebSocketRequest("2205260000001900KIY")
	if err != nil {
		t.Fatal(err)
	}
	eq(t, [6]string{r.URL, r.Subscribe, r.Send, r.Body.MerchantID, r.Body.RequestID, r.Body.Username},
		[6]string{"wss://ws.example/nqrws", "/user/nqrws/check-txn-status", "/nqrws/check-txn-status", "Terminal1", "2205260000001900KIY", "wsuser"})
	b, _ := json.Marshal(r.Body)
	if !strings.HasPrefix(string(b), `{"merchant_id":"Terminal1","request_id":"2205260000001900KIY","username":"wsuser","api_token":"`) {
		t.Fatalf("body JSON: %s", b)
	}
	ct, err := FromBase64(r.Body.APIToken)
	if err != nil {
		t.Fatal(err)
	}
	eq(t, len(ct), 256)
	pt, err := rsa.DecryptPKCS1v15(nil, testRSAKey(t), ct)
	if err != nil {
		t.Fatal(err)
	}
	eq(t, string(pt), "secret-api-token")
	r2, err := w.WebSocketRequest("X")
	if err != nil {
		t.Fatal(err)
	}
	r3, _ := w.WebSocketRequest("X")
	if r2.Body.APIToken == r3.Body.APIToken {
		t.Fatal("two encryptions of the same token are identical")
	}
	if _, err := newTestNepalPay(t, nil).WebSocketRequest("X"); err == nil || !strings.Contains(err.Error(), "WSURL") {
		t.Fatalf("want WSURL error, got %v", err)
	}
	if _, err := RSAPKCS1EncryptBase64(nepalPayTestSPKI(t), strings.Repeat("x", 246)); err == nil || !strings.Contains(err.Error(), "too long") {
		t.Fatalf("want too long error, got %v", err)
	}
	if _, err := RSAPKCS1EncryptBase64(nepalPayTestSPKI(t), strings.Repeat("x", 245)); err != nil {
		t.Fatal(err)
	}
}

package payments

// Python-only cases (scripts/python/tests/) and the behaviours from the port brief that
// the TS suite does not assert directly, plus the Go HTTP layer (retries, ctx, timeouts, body closing).

import (
	"context"
	"crypto"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// ---------------------------------------------------------------- Python-only cases

func TestPy_FormEscapeKeepsEnctype(t *testing.T) {
	html, err := RenderAutoSubmitForm(InitiateResult{Kind: KindForm, Action: "https://x", Fields: map[string]string{"a": `"><script>`}, Enctype: "multipart/form-data"})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(html, "&quot;&gt;&lt;script&gt;") || !strings.Contains(html, `enctype="multipart/form-data"`) {
		t.Fatal(html)
	}
	if _, err := RenderAutoSubmitForm(InitiateResult{Kind: KindRedirect}); err == nil {
		t.Fatal("redirect result must not render")
	}
}

func TestPy_Base64LeadingSpaceRestored(t *testing.T) {
	got, err := FromBase64(" /  ") // "+/++" after '+' -> ' '
	if err != nil || !reflect.DeepEqual(got, []byte{251, 255, 190}) {
		t.Fatalf("%v %v", got, err)
	}
}

func TestPy_EsewaIntentBookSignsAmount(t *testing.T) {
	d := mock(reply(200, `{"code":"IP-201","data":{"booking_id":"VkQ=","deeplink":"https://rc-links.esewa.com.np/pay/VkQ=","correlation_id":"C1"}}`))
	b, err := newTestEsewa(t, d).IntentBook(context.Background(), EsewaIntentBookInput{OrderID: "txn-20251220-001", AmountPaisa: 10000, CallbackURL: "https://cb", RedirectURL: "https://done"})
	if err != nil {
		t.Fatal(err)
	}
	c := d.Calls()[0]
	eq(t, c.URL, "https://rc-checkout.esewa.com.np/api/client/intent/payment/book")
	body := jsonMap(t, c.Body)
	eq(t, body["signature"], any("oVRo2ZkjNpbt5vKs7RSNx1OCcewDaVssoguWsG31HMA="))
	eq(t, body["amount"], any(json.Number("100"))) // a JSON number, like the TS/Python ports
	eq(t, b.ProviderRef, "VkQ=|C1")
	eq(t, b.Deeplink, "https://rc-links.esewa.com.np/pay/VkQ=")
}

func TestPy_KhaltiUserCanceledAndExpiredAs400(t *testing.T) {
	for _, c := range [][2]string{{"User canceled", "canceled"}, {"Expired", "expired"}} {
		v, err := newTestKhalti(t, mock(reply(400, lookupBody(c[0])))).Verify(context.Background(), VerifyInput{OrderID: "O", AmountPaisa: 1000, ProviderRef: "P"})
		if err != nil {
			t.Fatal(err)
		}
		eq(t, string(v.Status), c[1])
	}
}

func TestPy_NPSInitiateProviderRefIsProcessID(t *testing.T) {
	r, err := newTestNPS(t, mock(reply(200, `{"code":"0","message":"","errors":[],"data":{"ProcessId":"PROC_1"}}`))).Initiate(context.Background(), InitiateInput{OrderID: "T1", AmountPaisa: 10000, Description: "x", ReturnURL: "https://r"})
	if err != nil {
		t.Fatal(err)
	}
	eq(t, r.ProviderRef, "PROC_1")
}

// ---------------------------------------------------------------- eSewa

func TestEsewa_OrderIDFromCallbackKeyOrder(t *testing.T) {
	e := newTestEsewa(t, nil)
	eq(t, e.OrderIDFromCallback(map[string]string{"data": b64JSON(esewaSuccess(nil)), "orderId": "PATH"}), "ORD-2")
	eq(t, e.OrderIDFromCallback(map[string]string{"data": "!!!", "orderId": "PATH"}), "") // data present but bad: no fallback
	eq(t, e.OrderIDFromCallback(map[string]string{"orderId": "A", "order_id": "B", "transaction_uuid": "C"}), "A")
	eq(t, e.OrderIDFromCallback(map[string]string{"order_id": "B", "transaction_uuid": "C"}), "B")
	eq(t, e.OrderIDFromCallback(map[string]string{"transaction_uuid": "C"}), "C")
}

func TestEsewa_StrictSignatureLenientModeAndStatusErrors(t *testing.T) {
	bad := b64JSON(with(esewaSuccess(nil), "signature", "AAAA"))
	d := mock(reply(200, `{"status":"COMPLETE","total_amount":"1,000.0","ref_id":"R"}`))
	_, err := newTestEsewa(t, d).Verify(context.Background(), VerifyInput{OrderID: "ORD-2", AmountPaisa: 100000, Callback: map[string]string{"data": bad}})
	wantCode(t, err, "invalid_signature")
	eq(t, len(d.Calls()), 0)

	cfg := EsewaSandboxConfig()
	cfg.LenientSignature, cfg.HTTPClient = true, d
	lax, _ := NewEsewa(cfg)
	v, err := lax.Verify(context.Background(), VerifyInput{OrderID: "ORD-2", AmountPaisa: 100000, Callback: map[string]string{"data": bad}})
	if err != nil {
		t.Fatal(err)
	}
	eq(t, v.Status, StatusPaid)
	amountEq(t, v.AmountPaisa, 100000)
	eq(t, *v.Raw.(EsewaVerifyRaw).SignatureValid, false)

	_, err = newTestEsewa(t, mock(reply(400, `{"code":0,"error_message":"Invalid payload"}`))).Verify(context.Background(), VerifyInput{OrderID: "X", AmountPaisa: 100})
	wantCode(t, err, "esewa_0")
	wantErrContains(t, err, "Invalid payload")
}

func TestEsewa_IntentStatusCancelAndCallbackSignature(t *testing.T) {
	ctx := context.Background()
	d := mock(reply(200, `{"code":"IP-200","data":{"status":"BOOKED","transaction_id":"I1","reference_code":"REF"}}`))
	e := newTestEsewa(t, d)
	v, err := e.IntentVerify(ctx, "I1", "VkQ=|C1", ptr(int64(10000)))
	if err != nil {
		t.Fatal(err)
	}
	eq(t, v.Status, StatusPending)
	amountEq(t, v.AmountPaisa, 10000)
	eq(t, v.TransactionID, "REF")
	body := jsonMap(t, d.Calls()[0].Body)
	eq(t, body["signature"], any(EsewaSign(EsewaSandboxIntentAccessKey, map[string]string{"booking_id": "VkQ=", "product_code": "INTENT", "correlation_id": "C1"}, []string{"booking_id", "product_code", "correlation_id"})))
	_, err = e.IntentVerify(ctx, "OTHER", "VkQ=|C1", nil)
	wantCode(t, err, "callback_mismatch")

	cd := mock(reply(200, `{"code":"IP-210","data":{"status":"CANCELED"}}`))
	res, err := newTestEsewa(t, cd).IntentCancel(ctx, "VkQ=|C1")
	if err != nil {
		t.Fatal(err)
	}
	st, _ := get(res.(map[string]any)["data"], "status")
	eq(t, st, any("CANCELED"))
	eq(t, jsonMap(t, cd.Calls()[0].Body)["booking_id"], any("VkQ="))

	cb := map[string]any{"product_code": "INTENT", "amount": json.Number("100.0"), "status": "SUCCESS", "signed_field_names": "product_code,amount,status"}
	cb["signature"] = EsewaSign(EsewaSandboxIntentAccessKey, map[string]string{"product_code": "INTENT", "amount": "100", "status": "SUCCESS"}, []string{"product_code", "amount", "status"})
	ok, err := e.IntentCallbackValid(cb)
	eq(t, ok, true) // numbers are formatted like JS String(n): 100.0 -> "100"
	eq(t, err, nil)
	cb["status"] = "FAILED"
	ok, _ = e.IntentCallbackValid(cb)
	eq(t, ok, false)
}

// ---------------------------------------------------------------- Khalti

func TestKhalti_LookupTrailingSlashNotFoundMissingPidxRefund(t *testing.T) {
	ctx := context.Background()
	d := mock(reply(404, `{"detail":"Not found.","status_code":404}`))
	v, err := newTestKhalti(t, d).Verify(ctx, VerifyInput{OrderID: "O", AmountPaisa: 1000, ProviderRef: "P"})
	if err != nil {
		t.Fatal(err)
	}
	eq(t, v.Status, StatusNotFound)
	eq(t, d.Calls()[0].URL, "https://dev.khalti.com/api/v2/epayment/lookup/")
	eq(t, d.Calls()[0].Body, `{"pidx":"P"}`)
	_, err = newTestKhalti(t, d).Verify(ctx, VerifyInput{OrderID: "O", AmountPaisa: 1000})
	wantCode(t, err, "missing_pidx")

	rd := mock(reply(200, `{"detail":"Transaction refund successful."}`))
	if _, err := newTestKhalti(t, rd).Refund(ctx, "T/1", KhaltiRefundOptions{AmountPaisa: ptr(int64(500)), Mobile: "98"}); err != nil {
		t.Fatal(err)
	}
	eq(t, rd.Calls()[0].URL, "https://dev.khalti.com/api/merchant-transaction/T%2F1/refund/")
	eq(t, rd.Calls()[0].Body, `{"amount":500,"mobile":"98"}`)

	_, err = newTestKhalti(t, mock(reply(400, `{"return_url":["This field is required."],"error_key":"validation_error"}`))).Initiate(ctx, InitiateInput{OrderID: "O", AmountPaisa: 1000, Description: "x"})
	wantCode(t, err, "validation_error")
	wantErrContains(t, err, "Khalti: return_url: This field is required.")
}

// ---------------------------------------------------------------- Fonepay

func TestFonepay_ValidationNegativeCallbacksLegacyParseAndQR(t *testing.T) {
	ctx := context.Background()
	fp := newTestFonepay(t, FonepayConfig{})
	_, err := fp.Initiate(ctx, InitiateInput{OrderID: "ab", AmountPaisa: 100, ReturnURL: "https://r"})
	wantCode(t, err, "invalid_order_id")
	_, err = fp.Initiate(ctx, InitiateInput{OrderID: "abc", AmountPaisa: 100, ReturnURL: "https://r/" + strings.Repeat("x", 147)})
	wantCode(t, err, "invalid_return_url")

	// DV-signed negative outcome needs no HTTP call.
	d := mock(reply(200, ""))
	cancel := signedCallback(map[string]string{"PRN": "NP123", "PID": "NBQM", "PS": "false", "RC": "cancel", "UID": "U1", "BC": "B"})
	v, err := newTestFonepay(t, FonepayConfig{HTTPClient: d}).Verify(ctx, VerifyInput{OrderID: "NP123", AmountPaisa: 1000, Callback: cancel})
	if err != nil {
		t.Fatal(err)
	}
	eq(t, v.Status, StatusCanceled)
	eq(t, v.TransactionID, "U1")
	eq(t, len(d.Calls()), 0)
	// Valid DV for another PRN is rejected.
	_, err = fp.Verify(ctx, VerifyInput{OrderID: "OTHER", AmountPaisa: 1000, Callback: cancel})
	wantCode(t, err, "callback_mismatch")
	// Missing DV (but DV fields present) is invalid in strict mode.
	_, err = fp.Verify(ctx, VerifyInput{OrderID: "NP123", AmountPaisa: 1000, Callback: map[string]string{"PRN": "NP123"}})
	wantCode(t, err, "invalid_signature")

	// Legacy: 200 but unparseable never reads as "not paid".
	ok := signedCallback(map[string]string{"PRN": "NP123", "PID": "NBQM", "PS": "true", "RC": "successful", "UID": "1", "BC": "B", "R_AMT": "10"})
	ld := mock(reply(200, "<html>maintenance</html>"))
	_, err = newTestFonepay(t, FonepayConfig{HTTPClient: ld}).Verify(ctx, VerifyInput{OrderID: "NP123", AmountPaisa: 1000, Callback: ok})
	wantCode(t, err, "malformed_response")
	c := ld.Calls()[0]
	eq(t, c.Header.Get("Accept"), "application/xml")
	if !strings.Contains(c.URL, "?PRN=NP123&PID=NBQM&BID=B&AMT=10&UID=1&DV="+FonepayHMAC(fonepaySecret, []string{"NBQM", "10", "NP123", "B", "1"})) {
		t.Fatal(c.URL)
	}

	// Sandbox websocket rewrite + QR status.
	qd := mock(func(c call) (int, any) {
		if strings.HasSuffix(c.URL, "thirdPartyDynamicQrGetStatus") {
			return 200, `{"paymentStatus":"success","fonepayTraceId":99}`
		}
		return 200, `{"qrMessage":"0002","thirdpartyQrWebSocketUrl":"ws://localhost:1/x"}`
	})
	qfp := newTestFonepay(t, FonepayConfig{Username: "u", Password: "p", HTTPClient: qd})
	qr, err := qfp.QRCreate(ctx, FonepayQRInput{OrderID: "Q1", AmountPaisa: 100, Remarks1: "r"})
	if err != nil {
		t.Fatal(err)
	}
	eq(t, qr.WebSocketURL, "wss://dev-ws.fonepay.com/x")
	eq(t, jsonMap(t, qd.Calls()[0].Body)["remarks2"], any("N/A"))
	qs, err := qfp.QRStatus(ctx, "Q1", ptr(int64(100)))
	if err != nil {
		t.Fatal(err)
	}
	eq(t, qs.Status, StatusPaid)
	eq(t, qs.TransactionID, "99")
	_, err = newTestFonepay(t, FonepayConfig{}).QRStatus(ctx, "Q1", nil)
	wantErrContains(t, err, "username/password required")
}

func TestKathmanduZoneFallsBackToFixedOffset(t *testing.T) {
	loc := loadKathmandu(func(string) (*time.Location, error) { return nil, errors.New("no tzdata") })
	at := time.Date(2026, 11, 4, 20, 0, 0, 0, time.UTC)
	eq(t, at.In(loc).Format("01/02/2006"), "11/05/2026")
	eq(t, at.In(loc).Format("02-01-2006 15:04"), "05-11-2026 01:45")
	eq(t, ConnectIPSDate(at), "05-11-2026")
}

// ---------------------------------------------------------------- connectIPS

func TestConnectIPS_ClipPKCS1KeyAndAmountParsing(t *testing.T) {
	eq(t, clip("a=b,c", 50), "a b c")
	eq(t, clip(strings.Repeat("x", 30), 20), strings.Repeat("x", 20))

	k := testRSAKey(t)
	pkcs1 := string(pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(k)}))
	d := mock(reply(200, `{"status":"SUCCESS","statusDesc":"TRANSACTION SUCCESSFUL","txnAmt":500.0,"creditStatus":"000"}`))
	c, err := NewConnectIPS(ConnectIPSConfig{Env: EnvSandbox, MerchantID: "550", AppID: "A", PrivateKeyPEM: pkcs1, HTTPClient: d})
	if err != nil {
		t.Fatal(err)
	}
	v, err := c.Verify(context.Background(), VerifyInput{OrderID: "txn1", AmountPaisa: 500})
	if err != nil {
		t.Fatal(err)
	}
	amountEq(t, v.AmountPaisa, 500)
	body := jsonMap(t, d.Calls()[0].Body)
	eq(t, body["merchantId"], any(json.Number("550")))
	sig, _ := FromBase64(body["token"].(string))
	digest := sha256.Sum256([]byte("MERCHANTID=550,APPID=A,REFERENCEID=txn1,TXNAMT=500"))
	if err := rsa.VerifyPKCS1v15(&k.PublicKey, crypto.SHA256, digest[:], sig); err != nil {
		t.Fatal(err)
	}
	det, err := c.GetTxnDetail(context.Background(), "txn1", 500)
	if err != nil {
		t.Fatal(err)
	}
	eq(t, det["creditStatus"], any("000"))
	eq(t, d.Calls()[1].URL, "https://uat.connectips.com/connectipswebws/api/creditor/gettxndetail")

	_, err = NewConnectIPS(ConnectIPSConfig{Env: EnvSandbox, MerchantID: "550", AppID: "A", PrivateKeyPEM: "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----"})
	wantCode(t, err, "invalid_config")
	_, err = newTestConnectIPS(t, mock(reply(401, ""))).Verify(context.Background(), VerifyInput{OrderID: "t", AmountPaisa: 1})
	wantCode(t, err, "unauthorized")
}

// ---------------------------------------------------------------- CyberSource

func TestCyberSource_SignedFieldOrderCurrencyDecisionsMissingInputs(t *testing.T) {
	cs := newTestCyberSource(t)
	ctx := context.Background()
	r, err := cs.Initiate(ctx, InitiateInput{OrderID: "ORD-1", AmountPaisa: 1005, CyberSource: &CyberSourceInitiateOptions{
		BillTo: BillTo{Forename: "R", Surname: "S", Email: "e", AddressLine1: "a", City: "c", Country: "NP", Phone: "98"}, MerchantDefinedData: map[int]string{2: "b", 1: "a"},
	}})
	if err != nil {
		t.Fatal(err)
	}
	eq(t, r.Fields["amount"], "10.05")
	eq(t, r.Fields["signed_field_names"], "access_key,profile_id,transaction_uuid,signed_date_time,locale,transaction_type,reference_number,amount,currency,"+
		"bill_to_forename,bill_to_surname,bill_to_email,bill_to_address_line1,bill_to_address_city,bill_to_address_country,bill_to_phone,"+
		"merchant_defined_data1,merchant_defined_data2,unsigned_field_names,signed_field_names")
	eq(t, ResponseValidOK(cs, r.Fields), true)
	_, err = cs.Initiate(ctx, InitiateInput{OrderID: "ORD-1", AmountPaisa: 100})
	wantCode(t, err, "missing_bill_to")
	_, err = cs.Verify(ctx, VerifyInput{OrderID: "ORD-1", AmountPaisa: 100})
	wantCode(t, err, "verify_unavailable")
	_, err = cs.Verify(ctx, VerifyInput{OrderID: "ORD-1", AmountPaisa: 100, Callback: csResponse([][2]string{{"req_currency", "USD"}, {"decision", "ACCEPT"}})})
	wantCode(t, err, "currency_mismatch")
	for _, c := range []struct {
		o    [][2]string
		want PaymentStatus
	}{
		{[][2]string{{"req_transaction_type", "authorization"}, {"decision", "ACCEPT"}}, StatusPending},
		{[][2]string{{"decision", "ERROR"}, {"reason_code", "151"}}, StatusUnknown},
		{[][2]string{{"decision", "accept"}, {"reason_code", "100"}}, StatusPaid},
	} {
		v, err := cs.Verify(ctx, VerifyInput{OrderID: "ORD-1", AmountPaisa: 100, Callback: csResponse(c.o)})
		if err != nil {
			t.Fatal(err)
		}
		eq(t, v.Status, c.want)
	}
	eq(t, cs.OrderIDFromCallback(map[string]string{"req_reference_number": "", "req_transaction_uuid": "U"}), "U")
}

// ResponseValidOK checks an initiate form's own signature with the response validator.
func ResponseValidOK(cs *CyberSource, f map[string]string) bool { return cs.ResponseValid(f) }

// ---------------------------------------------------------------- NPS

func TestNPS_NotificationResponseErrorsAndLookups(t *testing.T) {
	ctx := context.Background()
	n := newTestNPS(t, nil)
	eq(t, n.NotificationResponse(false), "received")
	eq(t, n.NotificationResponse(true), "already received")

	_, err := newTestNPS(t, mock(reply(200, `{"code":"1","message":"","errors":[{"error_code":"1","error_message":"Duplicate Record"}],"data":null}`))).Initiate(ctx, InitiateInput{OrderID: "T1", AmountPaisa: 100})
	wantCode(t, err, "nps_1")
	wantErrContains(t, err, "NPS GetProcessId: Duplicate Record")
	_, err = newTestNPS(t, mock(reply(401, ""))).Verify(ctx, VerifyInput{OrderID: "T1"})
	wantCode(t, err, "unauthorized")
	_, err = newTestNPS(t, mock(reply(200, `{"code":"0","errors":[],"data":{"Status":"Success","MerchantTxnId":"T2"}}`))).Verify(ctx, VerifyInput{OrderID: "T1"})
	wantCode(t, err, "callback_mismatch")

	d := mock(func(c call) (int, any) {
		if strings.HasSuffix(c.URL, "/GetServiceCharge") {
			return 200, `{"code":"0","errors":[],"data":{"Amount":"100","CommissionType":"P","ChargeValue":1.5,"TotalChargeAmount":"1.50"}}`
		}
		return 200, `{"code":"0","errors":[],"data":[{"InstitutionName":"Khalti","InstrumentName":"Khalti","InstrumentCode":"KHALTI","BankType":"CheckoutGateway","LogoUrl":"https://l"}]}`
	})
	ins, err := newTestNPS(t, d).GetInstruments(ctx)
	if err != nil {
		t.Fatal(err)
	}
	eq(t, ins[0], NPSInstrument{InstitutionName: "Khalti", InstrumentName: "Khalti", InstrumentCode: "KHALTI", BankType: "CheckoutGateway", LogoURL: "https://l"})
	sc, err := newTestNPS(t, d).GetServiceCharge(ctx, 10000, "KHALTI")
	if err != nil {
		t.Fatal(err)
	}
	eq(t, sc.ChargeValue, "1.5")
	body := jsonMap(t, d.Calls()[1].Body)
	eq(t, body["Signature"], any(NPSSign("secret", map[string]string{"MerchantId": "9", "MerchantName": "TestMerchant", "Amount": "100", "InstrumentCode": "KHALTI"})))
}

// ---------------------------------------------------------------- IME Pay

func TestIMEPay_MismatchMissingTokenAndGetTokenError(t *testing.T) {
	ctx := context.Background()
	_, err := newTestIMEPay(t, nil).Verify(ctx, VerifyInput{OrderID: "R1"})
	wantCode(t, err, "missing_token")
	_, err = newTestIMEPay(t, mock(reply(200, `{"ResponseCode":0,"RefId":"R2"}`))).Verify(ctx, VerifyInput{OrderID: "R1", ProviderRef: "TK1"})
	wantCode(t, err, "callback_mismatch")
	_, err = newTestIMEPay(t, mock(reply(200, `{"ResponseCode":1,"ResponseDescription":"Invalid credentials"}`))).Initiate(ctx, InitiateInput{OrderID: "R1", AmountPaisa: 100})
	wantCode(t, err, "imepay_1")
	wantErrContains(t, err, "Invalid credentials")
}

// ---------------------------------------------------------------- HTTP layer

func TestHTTP_RetriesReadsOn5xxButNotInitiate(t *testing.T) {
	d := mock(reply(502, "<html>Bad Gateway</html>"))
	_, err := newTestEsewa(t, d).Verify(context.Background(), VerifyInput{OrderID: "X", AmountPaisa: 100})
	wantCode(t, err, "http_502") // final 5xx is returned to the adapter, which maps it
	eq(t, len(d.Calls()), 3)     // 1 + 2 retries
	eq(t, d.closed, 3)           // every body closed

	kd := mock(reply(503, ""))
	_, err = newTestKhalti(t, kd).Initiate(context.Background(), InitiateInput{OrderID: "O", AmountPaisa: 1000})
	wantCode(t, err, "http_503")
	eq(t, len(kd.Calls()), 1) // initiate is not idempotent: no retries

	// Default headers.
	c := kd.Calls()[0]
	eq(t, c.Header.Get("Accept"), "application/json")
	eq(t, c.Header.Get("Content-Type"), "application/json")
	eq(t, c.Header.Get("User-Agent"), userAgent)
}

func TestHTTP_NetworkErrorsContextAndTimeouts(t *testing.T) {
	boom := errors.New("connection refused")
	d := &fakeDoer{err: boom}
	_, err := newTestKhalti(t, d).Verify(context.Background(), VerifyInput{OrderID: "O", ProviderRef: "P"})
	wantCode(t, err, "network_error")
	wantErrContains(t, err, "request to dev.khalti.com failed: connection refused")
	if !errors.Is(err, boom) {
		t.Fatal("cause not wrapped")
	}
	eq(t, len(d.Calls()), 3)

	// A canceled caller context stops immediately (no retries).
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	var srvHits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { srvHits.Add(1) }))
	defer srv.Close()
	k, _ := NewKhalti(KhaltiConfig{Env: EnvSandbox, SecretKey: "k"})
	k.base = srv.URL
	_, err = k.Verify(ctx, VerifyInput{OrderID: "O", ProviderRef: "P"})
	wantCode(t, err, "network_error")
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("want context.Canceled, got %v", err)
	}
	eq(t, srvHits.Load(), int32(0)) // never reached the server, never retried

	// Per-attempt timeout against a server that never answers.
	release := make(chan struct{})
	hang := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		select {
		case <-r.Context().Done():
		case <-release:
		}
	}))
	defer hang.Close()
	defer close(release) // runs before hang.Close
	k2, _ := NewKhalti(KhaltiConfig{Env: EnvSandbox, SecretKey: "k", Timeout: 50 * time.Millisecond})
	k2.base = hang.URL
	start := time.Now()
	_, err = k2.Verify(context.Background(), VerifyInput{OrderID: "O", ProviderRef: "P"})
	wantCode(t, err, "network_error")
	if !errors.Is(err, context.DeadlineExceeded) || time.Since(start) > 5*time.Second {
		t.Fatalf("err=%v elapsed=%v", err, time.Since(start))
	}

	// Real server: BOM-prefixed JSON is parsed like fetch's res.text() + JSON.parse.
	bom := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("\xEF\xBB\xBF" + lookupBody("Completed")))
	}))
	defer bom.Close()
	k3, _ := NewKhalti(KhaltiConfig{Env: EnvSandbox, SecretKey: "k"})
	k3.base = bom.URL
	v, err := k3.Verify(context.Background(), VerifyInput{OrderID: "O", ProviderRef: "P"})
	if err != nil {
		t.Fatal(err)
	}
	eq(t, v.Status, StatusPaid)
	amountEq(t, v.AmountPaisa, 1000)
}

// ---------------------------------------------------------------- config / helpers

func TestConfigFromLookupNewAndAdapterLookup(t *testing.T) {
	pemText := strings.ReplaceAll(pkcs8PEM(t, testRSAKey(t)), "\n", `\n`)
	env := map[string]string{
		"ESEWA_PRODUCT_CODE": "EPAYTEST", "ESEWA_SECRET_KEY": "8gBm/:&amp;EnhH.1/q", "ESEWA_ENV": "live",
		"ESEWA_INTENT_PRODUCT_CODE": "INTENT", "ESEWA_INTENT_ACCESS_KEY": "k", "ESEWA_INTENT_BASE_URL": "https://intent.example",
		"KHALTI_SECRET_KEY":     "s", // no KHALTI_WEBSITE_URL -> disabled
		"FONEPAY_MERCHANT_CODE": "NBQM", "FONEPAY_SECRET_KEY": "x", "FONEPAY_USERNAME": "u",
		"CONNECTIPS_MERCHANT_ID": "550", "CONNECTIPS_APP_ID": "A", "CONNECTIPS_PRIVATE_KEY_PEM": pemText,
		"CYBERSOURCE_PROFILE_ID": "p", "CYBERSOURCE_ACCESS_KEY": "a", "CYBERSOURCE_SECRET_KEY": "s",
		"NPS_MERCHANT_ID": "9", "NPS_SECRET_KEY": "s",
		"IMEPAY_MERCHANT_CODE": "MC", "IMEPAY_USERNAME": "u",
	}
	cfg := ConfigFromLookup(func(k string) string { return env[k] })
	eq(t, cfg.Esewa.Env, EnvProduction)
	eq(t, cfg.Esewa.Intent.BaseURL, "https://intent.example")
	if cfg.Khalti != nil {
		t.Fatal("khalti should be disabled")
	}
	eq(t, cfg.Fonepay.Username, "u")
	eq(t, cfg.CyberSource.Currency, "NPR")
	if !strings.Contains(cfg.ConnectIPS.PrivateKeyPEM, "\n") {
		t.Fatal(`\n not unescaped`)
	}
	p, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	eq(t, p.Esewa.secret, EsewaSandboxSecretKey) // &amp; -> &
	if got := p.Enabled(); !reflect.DeepEqual(got, []ProviderID{ProviderEsewa, ProviderFonepay, ProviderConnectIPS, ProviderCyberSource, ProviderNPS, ProviderIMEPay}) {
		t.Fatal(got)
	}
	a, err := p.Adapter("nps")
	if err != nil || a.ID() != ProviderNPS {
		t.Fatal(a, err)
	}
	for _, id := range []string{"khalti", "constructor", "toString", ""} {
		if _, err := p.Adapter(id); err == nil {
			t.Fatalf("Adapter(%q) should fail", id)
		}
	}
	_, err = NewKhalti(KhaltiConfig{Env: "staging", SecretKey: "s"})
	wantCode(t, err, "invalid_config")
}

func TestMoneyHelpersEdgeCases(t *testing.T) {
	for _, s := range []string{"abc", "1e3", "", "1.2.3"} {
		if _, err := RupeesToPaisa(s); err == nil {
			t.Fatalf("RupeesToPaisa(%q) should fail", s)
		}
	}
	got, err := paisaFromValue(json.Number("1e3"))
	if err != nil || got != 100000 {
		t.Fatal(got, err)
	}
	eq(t, PaisaToRupees(-5), "-0.05")
	eq(t, PaisaToRupees(-105), "-1.05")
	eq(t, jsRupeesNumber(10050), "100.5")
	eq(t, jsRupeesNumber(10005), "100.05")
	eq(t, amount2dp(150000), "1500.00")
	wantCode(t, AssertPaisa(0, ProviderKhalti), "invalid_amount")
	wantCode(t, AssertPaisa(maxSafeInteger+1, ProviderKhalti), "invalid_amount")
	for _, c := range []struct {
		in   any
		want int64
		ok   bool
	}{{"500", 500, true}, {"500.5", 501, true}, {" 499.49 ", 499, true}, {nil, 0, true}, {"", 0, true}, {"abc", 0, false}, {json.Number("5e2"), 500, true}, {"0x1F4", 500, true}} {
		n, ok := jsNumberRounded(c.in)
		if n != c.want || ok != c.ok {
			t.Fatalf("jsNumberRounded(%v) = %d,%v", c.in, n, ok)
		}
	}
}

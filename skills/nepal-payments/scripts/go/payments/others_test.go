package payments

// Ported from scripts/ts/test/providers/ (connectips, cybersource, nps, imepay).

import (
	"context"
	"crypto"
	"crypto/hmac"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/sha512"
	"encoding/hex"
	"encoding/json"
	"net/url"
	"reflect"
	"regexp"
	"strings"
	"testing"
)

// ---------------------------------------------------------------- connectIPS

func newTestConnectIPS(t *testing.T, d Doer) *ConnectIPS {
	t.Helper()
	c, err := NewConnectIPS(ConnectIPSConfig{Env: EnvSandbox, MerchantID: "550", AppID: "MER-550-APP-1", AppName: "Test", AppPassword: "pw", PrivateKeyPEM: pkcs8PEM(t, testRSAKey(t)), HTTPClient: d})
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func TestConnectIPS_TokenIsRSASHA256OverDocumentedStringPaisaDDMMYYYY(t *testing.T) {
	r, err := newTestConnectIPS(t, nil).Initiate(context.Background(), InitiateInput{OrderID: "txn123", AmountPaisa: 500, Description: "Order, #1"})
	if err != nil {
		t.Fatal(err)
	}
	eq(t, r.Kind, KindForm)
	eq(t, r.Fields["TXNAMT"], "500")
	if !regexp.MustCompile(`^\d{2}-\d{2}-\d{4}$`).MatchString(r.Fields["TXNDATE"]) {
		t.Fatal(r.Fields["TXNDATE"])
	}
	eq(t, r.Fields["REMARKS"], "Order  #1") // commas stripped: they'd corrupt the token string
	msg := ConnectIPSTokenString(r.Fields)
	if !strings.HasSuffix(msg, ",PARTICULARS=Order  #1,TOKEN=TOKEN") {
		t.Fatal(msg)
	}
	sig, err := FromBase64(r.Fields["TOKEN"])
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256([]byte(msg))
	if err := rsa.VerifyPKCS1v15(&testRSAKey(t).PublicKey, crypto.SHA256, digest[:], sig); err != nil {
		t.Fatal(err)
	}
}

func TestConnectIPS_TXNIDMax20Chars(t *testing.T) {
	_, err := newTestConnectIPS(t, nil).Initiate(context.Background(), InitiateInput{OrderID: strings.Repeat("X", 21), AmountPaisa: 100, Description: "x"})
	wantErrContains(t, err, "1–20")
}

func TestConnectIPS_ValidateTxnReferenceIDIsTXNIDBasicAuthStatusMapping(t *testing.T) {
	for _, c := range [][3]string{{"SUCCESS", "TRANSACTION SUCCESSFUL", "paid"}, {"FAILED", "TRANSACTION UNSUCCESSFUL", "failed"}, {"ERROR", "TRANSACTION NOT FOUND", "not_found"}, {"ERROR", "TRANSACTION INCOMPLETE", "pending"}} {
		d := mock(reply(200, `{"merchantId":550,"appId":"MER-550-APP-1","referenceId":"txn123","txnAmt":"500","status":"`+c[0]+`","statusDesc":"`+c[1]+`"}`))
		v, err := newTestConnectIPS(t, d).Verify(context.Background(), VerifyInput{OrderID: "txn123", AmountPaisa: 500})
		if err != nil {
			t.Fatal(err)
		}
		eq(t, string(v.Status), c[2])
		call := d.Calls()[0]
		body := jsonMap(t, call.Body)
		eq(t, body["referenceId"], any("txn123"))
		eq(t, body["txnAmt"], any(json.Number("500")))
		eq(t, call.Header.Get("Authorization"), "Basic "+ToBase64([]byte("MER-550-APP-1:pw")))
		eq(t, call.URL, "https://uat.connectips.com/connectipswebws/api/creditor/validatetxn")
	}
}

// ---------------------------------------------------------------- CyberSource

func TestCyberSource_SecureAcceptanceSignatureWorkedExample(t *testing.T) {
	f := map[string]string{
		"access_key":           "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6",
		"profile_id":           "PROFILE-0001",
		"transaction_uuid":     "7f9c2b1e-5d1a-4c3b-9e8f-1a2b3c4d5e6f",
		"signed_field_names":   "access_key,profile_id,transaction_uuid,signed_field_names,unsigned_field_names,signed_date_time,locale,transaction_type,reference_number,amount,currency",
		"unsigned_field_names": "",
		"signed_date_time":     "2026-11-04T10:15:30Z",
		"locale":               "en-us",
		"transaction_type":     "sale",
		"reference_number":     "ORDER-1001",
		"amount":               "1500.00",
		"currency":             "NPR",
	}
	eq(t, CyberSourceSign("test_secret_key_do_not_use", f), "QRwjaW8ysHR/UGyQ0LqSIHiGTvnNebKSwwsFRmn4Weg=")
}

func newTestCyberSource(t *testing.T) *CyberSource {
	t.Helper()
	cs, err := NewCyberSource(CyberSourceConfig{Env: EnvSandbox, ProfileID: "P", AccessKey: "A", SecretKey: "S"})
	if err != nil {
		t.Fatal(err)
	}
	return cs
}

// csResponse mirrors the TS response(): base fields + overrides, all signed.
func csResponse(o [][2]string) map[string]string {
	keys := []string{"req_reference_number", "req_currency", "req_transaction_type", "transaction_id"}
	p := map[string]string{"req_reference_number": "ORD-1", "req_currency": "NPR", "req_transaction_type": "sale", "transaction_id": "7000"}
	for _, kv := range o {
		if _, ok := p[kv[0]]; !ok {
			keys = append(keys, kv[0])
		}
		p[kv[0]] = kv[1]
	}
	p["signed_field_names"] = strings.Join(append(keys, "signed_field_names"), ",")
	p["signature"] = CyberSourceSign("S", p)
	return p
}

func TestCyberSource_DecisionsMapUnsignedExtrasIgnoredTamperRejected(t *testing.T) {
	cs := newTestCyberSource(t)
	ctx := context.Background()
	verify := func(orderID string, cb map[string]string) (VerifyResult, error) {
		return cs.Verify(ctx, VerifyInput{OrderID: orderID, AmountPaisa: 150000, Callback: cb})
	}
	for _, c := range []struct {
		o    [][2]string
		want PaymentStatus
	}{
		{[][2]string{{"decision", "ACCEPT"}, {"reason_code", "100"}, {"auth_amount", "1500.00"}}, StatusPaid},
		{[][2]string{{"decision", "DECLINE"}, {"reason_code", "203"}}, StatusFailed},
		{[][2]string{{"decision", "REVIEW"}, {"reason_code", "200"}}, StatusPending},
		{[][2]string{{"decision", "CANCEL"}, {"reason_code", ""}}, StatusCanceled},
	} {
		v, err := verify("ORD-1", csResponse(c.o))
		if err != nil {
			t.Fatal(err)
		}
		eq(t, v.Status, c.want)
	}
	ok := csResponse([][2]string{{"decision", "ACCEPT"}, {"reason_code", "100"}, {"auth_amount", "1500.00"}})
	withExtra := map[string]string{"injected": "x"}
	for k, v := range ok {
		withExtra[k] = v
	}
	v, err := verify("ORD-1", withExtra)
	if err != nil {
		t.Fatal(err)
	}
	if _, has := v.Raw.(map[string]string)["injected"]; has {
		t.Fatal("unsigned field leaked into raw")
	}
	tampered := map[string]string{}
	for k, val := range ok {
		tampered[k] = val
	}
	tampered["auth_amount"] = "1.00"
	_, err = verify("ORD-1", tampered)
	wantErrContains(t, err, "invalid response signature")
	_, err = verify("ORD-2", ok)
	wantErrContains(t, err, "different order")
	// signed-but-empty auth_amount falls back to req_amount (same as Python)
	empty := csResponse([][2]string{{"decision", "ACCEPT"}, {"reason_code", "100"}, {"auth_amount", ""}, {"req_amount", "1500.00"}})
	v, err = verify("ORD-1", empty)
	if err != nil {
		t.Fatal(err)
	}
	amountEq(t, v.AmountPaisa, 150000)
}

func TestCyberSource_InitiateSignsEveryFieldInclBillToUnsignedEmpty(t *testing.T) {
	r, err := newTestCyberSource(t).Initiate(context.Background(), InitiateInput{
		OrderID: "ORD-1", AmountPaisa: 150000, Description: "x", ReturnURL: "https://r",
		CyberSource: &CyberSourceInitiateOptions{BillTo: BillTo{Forename: "Ram", Surname: "Sharma", Email: "r@e.com", AddressLine1: "Thamel", City: "Kathmandu", Country: "NP"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	eq(t, r.Kind, KindForm)
	eq(t, r.Fields["amount"], "1500.00")
	eq(t, r.Fields["unsigned_field_names"], "")
	if !regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$`).MatchString(r.Fields["signed_date_time"]) {
		t.Fatal(r.Fields["signed_date_time"])
	}
	if !strings.Contains(r.Fields["signed_field_names"], "bill_to_address_country") {
		t.Fatal(r.Fields["signed_field_names"])
	}
	eq(t, r.Fields["signature"], CyberSourceSign("S", r.Fields))
}

// ---------------------------------------------------------------- NPS

func hmac512Hex(key, msg string) string {
	m := hmac.New(sha512.New, []byte(key))
	m.Write([]byte(msg))
	return hex.EncodeToString(m.Sum(nil))
}

func TestNPS_SignatureIsHMACSHA512OfSortedKeyValuesNoSeparator(t *testing.T) {
	p := map[string]string{"MerchantTxnId": "T1", "MerchantName": "TestMerchant", "Amount": "100", "MerchantId": "9"}
	eq(t, NPSSign("secret", p), hmac512Hex("secret", "100"+"9"+"TestMerchant"+"T1"))
	eq(t, NPSSign("secret", map[string]string{"MerchantId": "9", "MerchantName": "TestMerchant"}), hmac512Hex("secret", "9TestMerchant"))
}

func newTestNPS(t *testing.T, d Doer) *NPS {
	t.Helper()
	n, err := NewNPS(NPSConfig{Env: EnvSandbox, MerchantID: "9", MerchantName: "TestMerchant", APIUsername: "u", APIPassword: "p", SecretKey: "secret", HTTPClient: d})
	if err != nil {
		t.Fatal(err)
	}
	return n
}

func TestNPS_InitiateGetProcessIdThenMultipartForm(t *testing.T) {
	d := mock(reply(200, `{"code":"0","message":"Success","errors":[],"data":{"ProcessId":"PROC_1"}}`))
	r, err := newTestNPS(t, d).Initiate(context.Background(), InitiateInput{OrderID: "T1", AmountPaisa: 10000, Description: "x", ReturnURL: "https://r"})
	if err != nil {
		t.Fatal(err)
	}
	c := d.Calls()[0]
	eq(t, c.URL, "https://apisandbox.nepalpayment.com/GetProcessId")
	eq(t, jsonMap(t, c.Body)["Signature"], any(NPSSign("secret", map[string]string{"MerchantId": "9", "MerchantName": "TestMerchant", "Amount": "100", "MerchantTxnId": "T1"})))
	eq(t, r.Kind, KindForm)
	eq(t, r.Enctype, "multipart/form-data")
	eq(t, r.Fields["Amount"], "100")
	eq(t, r.Fields["ProcessId"], "PROC_1")
	eq(t, r.Action, "https://gatewaysandbox.nepalpayment.com/Payment/Index")
}

func TestNPS_StatusCode0FailIsFailedErrorCode3IsNotFound(t *testing.T) {
	ctx := context.Background()
	v, err := newTestNPS(t, mock(reply(200, `{"code":"0","message":"","errors":[],"data":{"Status":"Fail","Amount":"100","MerchantTxnId":"T1"}}`))).Verify(ctx, VerifyInput{OrderID: "T1", AmountPaisa: 10000})
	if err != nil {
		t.Fatal(err)
	}
	eq(t, v.Status, StatusFailed)
	v, err = newTestNPS(t, mock(reply(200, `{"code":"0","message":"","errors":[],"data":{"Status":"Success","Amount":"100.00","MerchantTxnId":"T1","GatewayReferenceNo":"G1"}}`))).Verify(ctx, VerifyInput{OrderID: "T1", AmountPaisa: 10000})
	if err != nil {
		t.Fatal(err)
	}
	eq(t, v.Status, StatusPaid)
	amountEq(t, v.AmountPaisa, 10000)
	v, err = newTestNPS(t, mock(reply(200, `{"code":"1","message":"","errors":[{"error_code":"3","error_message":"Transaction not initialized yet"}],"data":null}`))).Verify(ctx, VerifyInput{OrderID: "T1", AmountPaisa: 10000})
	if err != nil {
		t.Fatal(err)
	}
	eq(t, v.Status, StatusNotFound)
}

// ---------------------------------------------------------------- IME Pay

func newTestIMEPay(t *testing.T, d Doer) *IMEPay {
	t.Helper()
	i, err := NewIMEPay(IMEPayConfig{Env: EnvSandbox, MerchantCode: "MC", Username: "u", Password: "p", Module: "MOD", HTTPClient: d})
	if err != nil {
		t.Fatal(err)
	}
	return i
}

func TestIMEPay_GetTokenAndCheckoutPayloadFormat(t *testing.T) {
	d := mock(reply(200, `{"TokenId":"TK1","ResponseCode":0}`))
	r, err := newTestIMEPay(t, d).Initiate(context.Background(), InitiateInput{OrderID: "R1", AmountPaisa: 10000, Description: "x", ReturnURL: "https://s/ok", FailureURL: "https://s/no"})
	if err != nil {
		t.Fatal(err)
	}
	c := d.Calls()[0]
	eq(t, c.URL, "https://stg.imepay.com.np:7979/api/Web/GetToken")
	eq(t, c.Header.Get("Module"), ToBase64([]byte("MOD")))
	if got := jsonMap(t, c.Body); !reflect.DeepEqual(got, map[string]any{"MerchantCode": "MC", "Amount": "100.00", "RefId": "R1"}) {
		t.Fatal(got)
	}
	eq(t, r.Kind, KindRedirect)
	u, err := url.Parse(r.URL)
	if err != nil {
		t.Fatal(err)
	}
	payload, err := FromBase64(u.Query().Get("data"))
	if err != nil {
		t.Fatal(err)
	}
	eq(t, string(payload), "TK1|MC|R1|100.00|POST|https://s/ok|https://s/no")
}

func TestIMEPay_RecheckZeroIsPaidAnythingElseStaysPending(t *testing.T) {
	ctx := context.Background()
	in := VerifyInput{OrderID: "R1", AmountPaisa: 10000, ProviderRef: "TK1"}
	v, err := newTestIMEPay(t, mock(reply(200, `{"ResponseCode":0,"RefId":"R1","TranAmount":"100.00","TransactionId":"X9"}`))).Verify(ctx, in)
	if err != nil {
		t.Fatal(err)
	}
	eq(t, v.Status, StatusPaid)
	v, err = newTestIMEPay(t, mock(reply(200, `{"ResponseCode":1,"RefId":"R1"}`))).Verify(ctx, in)
	if err != nil {
		t.Fatal(err)
	}
	eq(t, v.Status, StatusPending)
	v, err = newTestIMEPay(t, mock(reply(200, `{"ResponseCode":0,"RefId":"R1","TranAmount":""}`))).Verify(ctx, in)
	if err != nil {
		t.Fatal(err) // -> review, no error
	}
	if v.AmountPaisa != nil {
		t.Fatalf("amount = %d, want nil", *v.AmountPaisa)
	}
}

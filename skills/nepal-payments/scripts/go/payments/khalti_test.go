package payments

// Ported from scripts/ts/test/adapters.test.ts — describe("khalti").

import (
	"context"
	"encoding/json"
	"testing"
)

func newTestKhalti(t *testing.T, d Doer) *Khalti {
	t.Helper()
	k, err := NewKhalti(KhaltiConfig{Env: EnvSandbox, SecretKey: "live_secret_key_test", WebsiteURL: "https://shop.example", HTTPClient: d})
	if err != nil {
		t.Fatal(err)
	}
	return k
}

func lookupBody(status string) string {
	return `{"pidx":"P","total_amount":1000,"status":"` + status + `","transaction_id":"T","fee":0,"refunded":false}`
}

func TestKhalti_InitiateIntegerPaisaTrailingSlashKeyHeader(t *testing.T) {
	d := mock(reply(200, `{"pidx":"PIDX1","payment_url":"https://test-pay.khalti.com/?pidx=PIDX1","expires_at":"x","expires_in":1800}`))
	r, err := newTestKhalti(t, d).Initiate(context.Background(), InitiateInput{OrderID: "O1", AmountPaisa: 1000, Description: "Book", ReturnURL: "https://shop.example/r"})
	if err != nil {
		t.Fatal(err)
	}
	c := d.Calls()[0]
	eq(t, c.URL, "https://dev.khalti.com/api/v2/epayment/initiate/")
	eq(t, c.Header.Get("Authorization"), "Key live_secret_key_test")
	eq(t, jsonMap(t, c.Body)["amount"], any(json.Number("1000")))
	eq(t, r.Kind, KindRedirect)
	eq(t, r.ProviderRef, "PIDX1")
}

func TestKhalti_MinimumRs10(t *testing.T) {
	_, err := newTestKhalti(t, nil).Initiate(context.Background(), InitiateInput{OrderID: "O", AmountPaisa: 999, Description: "x", ReturnURL: "https://r"})
	wantErrContains(t, err, "minimum")
}

func TestKhalti_LookupExpiredArrivesAsHTTP400WithNormalBody(t *testing.T) {
	k := newTestKhalti(t, mock(reply(400, `{"pidx":"P","total_amount":1000,"status":"Expired","transaction_id":null,"fee":0,"refunded":false}`)))
	v, err := k.Verify(context.Background(), VerifyInput{OrderID: "O", AmountPaisa: 1000, ProviderRef: "P"})
	if err != nil {
		t.Fatal(err)
	}
	eq(t, v.Status, StatusExpired)
}

func TestKhalti_LookupCompletedUserCanceledPartiallyRefunded(t *testing.T) {
	for _, c := range [][2]string{{"Completed", "paid"}, {"User canceled", "canceled"}, {"Partially refunded", "partially_refunded"}, {"Initiated", "pending"}} {
		k := newTestKhalti(t, mock(reply(200, lookupBody(c[0]))))
		v, err := k.Verify(context.Background(), VerifyInput{OrderID: "O", AmountPaisa: 1000, ProviderRef: "P"})
		if err != nil {
			t.Fatal(err)
		}
		eq(t, string(v.Status), c[1])
	}
}

func TestKhalti_RefusesCallbackPidxThatDiffersFromStored(t *testing.T) {
	_, err := newTestKhalti(t, mock(reply(200, lookupBody("Completed")))).Verify(context.Background(),
		VerifyInput{OrderID: "O", AmountPaisa: 1000, ProviderRef: "P", Callback: map[string]string{"pidx": "OTHER"}})
	wantErrContains(t, err, "does not match")
}

func TestKhalti_401SurfacesAsUnauthorized(t *testing.T) {
	_, err := newTestKhalti(t, mock(reply(401, `{"detail":"Invalid token.","status_code":401}`))).Verify(context.Background(), VerifyInput{OrderID: "O", AmountPaisa: 1000, ProviderRef: "P"})
	wantCode(t, err, "unauthorized")
}

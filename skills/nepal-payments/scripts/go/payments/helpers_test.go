package payments

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"errors"
	"io"
	"net/http"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestMain(m *testing.M) {
	retryBaseDelay = time.Millisecond // keep retry tests fast
	os.Exit(m.Run())
}

// call is one request seen by the fake HTTP client (the TS tests' mockFetch `calls`).
type call struct {
	Method string
	URL    string
	Header http.Header
	Body   string
	Close  bool // req.Close: the transport sends Connection: close
}

type fakeDoer struct {
	mu      sync.Mutex
	calls   []call
	handler func(c call) (status int, body any) // body: string sent as-is, anything else JSON-encoded
	err     error                               // when set, Do fails with it (network error)
	closed  int
}

// mock mirrors mockFetch: a fresh fake whose handler answers every request.
func mock(handler func(c call) (int, any)) *fakeDoer { return &fakeDoer{handler: handler} }

// reply returns a handler that always answers status/body.
func reply(status int, body any) func(call) (int, any) {
	return func(call) (int, any) { return status, body }
}

func (f *fakeDoer) Do(req *http.Request) (*http.Response, error) {
	var body []byte
	if req.Body != nil {
		body, _ = io.ReadAll(req.Body)
		req.Body.Close()
	}
	c := call{Method: req.Method, URL: req.URL.String(), Header: req.Header.Clone(), Body: string(body), Close: req.Close}
	f.mu.Lock()
	f.calls = append(f.calls, c)
	f.mu.Unlock()
	if f.err != nil {
		return nil, f.err
	}
	status, b := f.handler(c)
	text, ok := b.(string)
	if !ok {
		bb, _ := json.Marshal(b)
		text = string(bb)
	}
	if status == 0 {
		status = 200
	}
	return &http.Response{StatusCode: status, Header: http.Header{}, Body: &trackedBody{Reader: strings.NewReader(text), f: f}, Request: req}, nil
}

func (f *fakeDoer) Calls() []call {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]call(nil), f.calls...)
}

type trackedBody struct {
	io.Reader
	f *fakeDoer
}

func (b *trackedBody) Close() error {
	b.f.mu.Lock()
	b.f.closed++
	b.f.mu.Unlock()
	return nil
}

func jsonMap(t *testing.T, s string) map[string]any {
	t.Helper()
	v, err := decodeJSON(s)
	if err != nil {
		t.Fatalf("bad JSON %q: %v", s, err)
	}
	m, ok := v.(map[string]any)
	if !ok {
		t.Fatalf("not an object: %s", s)
	}
	return m
}

// paymentErr asserts err is a *PaymentError and returns it.
func paymentErr(t *testing.T, err error) *PaymentError {
	t.Helper()
	var pe *PaymentError
	if !errors.As(err, &pe) {
		t.Fatalf("want *PaymentError, got %T %v", err, err)
	}
	return pe
}

func wantCode(t *testing.T, err error, code string) {
	t.Helper()
	if pe := paymentErr(t, err); pe.Code != code {
		t.Fatalf("code = %q (%s), want %q", pe.Code, pe.Message, code)
	}
}

func wantErrContains(t *testing.T, err error, sub string) {
	t.Helper()
	if err == nil || !strings.Contains(err.Error(), sub) {
		t.Fatalf("error = %v, want it to contain %q", err, sub)
	}
}

func eq[T comparable](t *testing.T, got, want T) {
	t.Helper()
	if got != want {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func amountEq(t *testing.T, got *int64, want int64) {
	t.Helper()
	if got == nil || *got != want {
		t.Fatalf("amount = %v, want %d", deref(got), want)
	}
}

func deref(p *int64) any {
	if p == nil {
		return nil
	}
	return *p
}

func ptr[T any](v T) *T { return &v }

var (
	rsaOnce sync.Once
	rsaKey  *rsa.PrivateKey
)

func testRSAKey(t *testing.T) *rsa.PrivateKey {
	t.Helper()
	rsaOnce.Do(func() {
		k, err := rsa.GenerateKey(rand.Reader, 2048)
		if err != nil {
			panic(err)
		}
		rsaKey = k
	})
	return rsaKey
}

func pkcs8PEM(t *testing.T, k *rsa.PrivateKey) string {
	t.Helper()
	der, err := x509.MarshalPKCS8PrivateKey(k)
	if err != nil {
		t.Fatal(err)
	}
	return string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}))
}

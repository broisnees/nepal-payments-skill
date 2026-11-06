package payments

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Doer sends HTTP requests. *http.Client satisfies it; tests inject a fake.
type Doer interface {
	Do(*http.Request) (*http.Response, error)
}

// defaultClient follows redirects like fetch() does. Each attempt is bounded by the adapter's
// timeout through the request context, so the client itself has no global timeout.
var defaultClient Doer = newDefaultClient()

func newDefaultClient() *http.Client {
	if t, ok := http.DefaultTransport.(*http.Transport); ok {
		return &http.Client{Transport: t.Clone()}
	}
	return &http.Client{}
}

const (
	defaultTimeout   = 15 * time.Second
	maxResponseBytes = 8 << 20
	userAgent        = "nepal-payments-go/1.0"
)

// retryBaseDelay is the first retry backoff (then x2), as in the TS http(); tests shorten it.
var retryBaseDelay = 300 * time.Millisecond

type httpRequest struct {
	method  string
	url     string
	headers [][2]string
	body    []byte // nil = no body
	timeout time.Duration
	retries int  // extra attempts on network error / 5xx / 429 (idempotent reads only)
	close   bool // send Connection: close and never reuse the connection
}

type httpResponse struct {
	status int
	data   any // JSON value (numbers as json.Number), the raw text if not JSON, nil if empty
	text   string
}

// jsonBody encodes an ordered object as a request body.
func jsonBody(o jsonObject) []byte {
	b, err := o.MarshalJSON()
	if err != nil {
		// Only reachable with an unsupported value type, which is a programming error.
		panic(err)
	}
	return b
}

// doHTTP mirrors the TS http(): per-attempt timeout, retries with 300ms*2^n backoff on network
// errors / 5xx / 429, and a final 5xx returned (not thrown) so callers map it themselves.
func doHTTP(ctx context.Context, client Doer, provider ProviderID, req httpRequest) (*httpResponse, error) {
	if client == nil {
		client = defaultClient
	}
	if req.method == "" {
		req.method = http.MethodGet
	}
	if req.timeout <= 0 {
		req.timeout = defaultTimeout
	}
	var lastErr error
	for attempt := 0; attempt <= req.retries; attempt++ {
		if attempt > 0 {
			if err := sleepCtx(ctx, retryBaseDelay<<(attempt-1)); err != nil {
				lastErr = err
				break
			}
		}
		res, err := doOnce(ctx, client, req)
		if err != nil {
			lastErr = err
			if ctx.Err() != nil {
				break // caller gave up: don't retry
			}
			continue
		}
		if (res.status >= 500 || res.status == 429) && attempt < req.retries {
			lastErr = newPaymentError(provider, "upstream_error", fmt.Sprintf("HTTP %d", res.status), res.status, res.text)
			continue
		}
		res.data = nil
		if res.text != "" {
			if v, err := decodeJSON(res.text); err == nil {
				res.data = v
			} else {
				res.data = res.text
			}
		}
		return res, nil
	}
	host := req.url
	if u, err := url.Parse(req.url); err == nil && u.Host != "" {
		host = u.Host
	}
	msg := "unknown error"
	if lastErr != nil {
		msg = lastErr.Error()
	}
	pe := newPaymentError(provider, "network_error", fmt.Sprintf("request to %s failed: %s", host, msg), 0, lastErr)
	pe.Err = lastErr
	return nil, pe
}

func doOnce(ctx context.Context, client Doer, req httpRequest) (*httpResponse, error) {
	actx, cancel := context.WithTimeout(ctx, req.timeout)
	defer cancel()
	var body io.Reader
	if req.body != nil {
		body = bytes.NewReader(req.body)
	}
	hr, err := http.NewRequestWithContext(actx, req.method, req.url, body)
	if err != nil {
		return nil, err
	}
	hr.Header.Set("Accept", "application/json")
	hr.Close = req.close
	for _, h := range req.headers {
		hr.Header.Set(h[0], h[1])
	}
	if req.body != nil && hr.Header.Get("Content-Type") == "" {
		hr.Header.Set("Content-Type", "application/json")
	}
	if hr.Header.Get("User-Agent") == "" {
		hr.Header.Set("User-Agent", userAgent)
	}
	resp, err := client.Do(hr)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseBytes+1))
	// Hamro Pay (grpc-gateway behind Envoy) aborts the stream after its error answers. Keep a body cut off
	// mid-stream only when what arrived is complete JSON.
	if err != nil && (len(b) == 0 || !json.Valid(bytes.TrimPrefix(b, []byte("\xef\xbb\xbf")))) {
		return nil, err
	}
	if len(b) > maxResponseBytes {
		return nil, fmt.Errorf("response body larger than %d bytes", maxResponseBytes)
	}
	// Like fetch's res.text(): UTF-8 with replacement characters, BOM stripped.
	text := strings.TrimPrefix(strings.ToValidUTF8(string(b), "\uFFFD"), "\uFEFF")
	return &httpResponse{status: resp.StatusCode, text: text}, nil
}

func sleepCtx(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

var errNotForm = errors.New("payments: RenderAutoSubmitForm needs a form result")

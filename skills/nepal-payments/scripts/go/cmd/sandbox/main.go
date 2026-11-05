// Command sandbox is the live sandbox smoke test (port of scripts/ts/test/sandbox.ts).
// It hits real provider sandboxes; no payment is completed.
//
//	go run ./cmd/sandbox                          # eSewa (public creds) + Fonepay dev sample
//	KHALTI_SECRET_KEY=... go run ./cmd/sandbox    # + Khalti (key from test-admin.khalti.com)
//
// Exit code 1 if any check fails.
package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/broisnees/nepal-payments-skill/skills/nepal-payments/scripts/go/payments"
)

var failed int

func check(name string, fn func(ctx context.Context) (string, error)) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	msg, err := fn(ctx)
	if err != nil {
		failed++
		fmt.Printf("  FAIL %s: %v\n", name, err)
		return
	}
	fmt.Printf("  ok   %s: %s\n", name, msg)
}

// noRedirect mirrors fetch(..., { redirect: "manual" }).
var noRedirect = &http.Client{
	Timeout:       30 * time.Second,
	CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
}

func snippet(r io.Reader) string {
	b, _ := io.ReadAll(io.LimitReader(r, 200))
	return string(b)
}

func main() {
	fmt.Println("eSewa (rc sandbox)")
	e, err := payments.NewEsewa(payments.EsewaSandboxConfig())
	if err != nil {
		panic(err)
	}
	id := payments.NewOrderID()
	check("signed form accepted (302 to login)", func(ctx context.Context) (string, error) {
		f, err := e.Initiate(ctx, payments.InitiateInput{
			OrderID: id, AmountPaisa: 11050, Description: "smoke", ReturnURL: "https://example.com/payments/esewa/return/" + id,
			Esewa: &payments.EsewaInitiateOptions{TaxPaisa: 1000},
		})
		if err != nil {
			return "", err
		}
		if f.Kind != payments.KindForm {
			return "", errors.New("expected form")
		}
		form := url.Values{}
		for k, v := range f.Fields {
			form.Set(k, v)
		}
		req, _ := http.NewRequestWithContext(ctx, http.MethodPost, f.Action, strings.NewReader(form.Encode()))
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		res, err := noRedirect.Do(req)
		if err != nil {
			return "", err
		}
		defer res.Body.Close()
		loc := res.Header.Get("Location")
		if res.StatusCode != 302 || !strings.Contains(loc, "bookingId=") {
			return "", fmt.Errorf("got %d %s %s", res.StatusCode, loc, snippet(res.Body))
		}
		return loc, nil
	})
	check("status API: unpaid -> pending", func(ctx context.Context) (string, error) {
		v, err := e.Verify(ctx, payments.VerifyInput{OrderID: id, AmountPaisa: 11050})
		if err != nil {
			return "", err
		}
		if v.Status != payments.StatusPending {
			return "", fmt.Errorf("got %s", v.Status)
		}
		return string(v.Status), nil
	})
	check("status API: wrong total -> not_found", func(ctx context.Context) (string, error) {
		v, err := e.Verify(ctx, payments.VerifyInput{OrderID: id, AmountPaisa: 99900})
		if err != nil {
			return "", err
		}
		if v.Status != payments.StatusNotFound {
			return "", fmt.Errorf("got %s", v.Status)
		}
		return string(v.Status), nil
	})
	check("intent book -> status -> cancel", func(ctx context.Context) (string, error) {
		oid := payments.NewOrderIDWithPrefix("I")
		b, err := e.IntentBook(ctx, payments.EsewaIntentBookInput{OrderID: oid, AmountPaisa: 10000, CallbackURL: "https://example.com/cb", RedirectURL: "https://example.com/done"})
		if err != nil {
			return "", err
		}
		s, err := e.IntentVerify(ctx, oid, b.ProviderRef, nil)
		if err != nil {
			return "", err
		}
		if s.Status != payments.StatusPending {
			return "", fmt.Errorf("status %s", s.Status)
		}
		c, err := e.IntentCancel(ctx, b.ProviderRef)
		if err != nil {
			return "", err
		}
		data, _ := c.(map[string]any)["data"].(map[string]any)
		if data["status"] != "CANCELED" {
			return "", fmt.Errorf("cancel %v", c)
		}
		return b.Deeplink + " BOOKED -> CANCELED", nil
	})

	fmt.Println("Fonepay (dev gateway, public sample merchant NBQM)")
	fp, err := payments.NewFonepay(payments.FonepayConfig{Env: payments.EnvSandbox, MerchantCode: "NBQM", SecretKey: "a7e3512f5032480a83137793cb2021dc"})
	if err != nil {
		panic(err)
	}
	fonepayGet := func(ctx context.Context, u string) (*http.Response, error) {
		req, _ := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
		return noRedirect.Do(req)
	}
	check("signed redirect accepted (303 to payment page)", func(ctx context.Context) (string, error) {
		r, err := fp.Initiate(ctx, payments.InitiateInput{OrderID: payments.NewOrderID(), AmountPaisa: 1050, Description: "smoke", ReturnURL: "https://example.com/payments/fonepay/return"})
		if err != nil {
			return "", err
		}
		res, err := fonepayGet(ctx, r.URL)
		if err != nil {
			return "", err
		}
		defer res.Body.Close()
		loc := res.Header.Get("Location")
		if res.StatusCode < 300 || res.StatusCode >= 400 || !strings.Contains(loc, "fonepay.com") {
			return "", fmt.Errorf("got %d %s %s", res.StatusCode, loc, snippet(res.Body))
		}
		return loc, nil
	})
	check("bad DV rejected (409 Data Validation Failed)", func(ctx context.Context) (string, error) {
		r, err := fp.Initiate(ctx, payments.InitiateInput{OrderID: payments.NewOrderID(), AmountPaisa: 1050, Description: "smoke", ReturnURL: "https://example.com/payments/fonepay/return"})
		if err != nil {
			return "", err
		}
		u, _ := url.Parse(r.URL)
		q := u.Query()
		q.Set("DV", strings.Repeat("0", 128))
		u.RawQuery = q.Encode()
		res, err := fonepayGet(ctx, u.String())
		if err != nil {
			return "", err
		}
		defer res.Body.Close()
		body := snippet(res.Body)
		if res.StatusCode >= 300 && res.StatusCode < 400 {
			return "", fmt.Errorf("bad DV was accepted: %d %s", res.StatusCode, res.Header.Get("Location"))
		}
		if res.StatusCode != 409 {
			return "", fmt.Errorf("got %d %s", res.StatusCode, body)
		}
		return fmt.Sprintf("%d %s", res.StatusCode, body), nil
	})

	if key := os.Getenv("KHALTI_SECRET_KEY"); key != "" {
		fmt.Println("Khalti (dev.khalti.com)")
		k, err := payments.NewKhalti(payments.KhaltiConfig{Env: payments.EnvSandbox, SecretKey: key, WebsiteURL: "https://example.com"})
		if err != nil {
			panic(err)
		}
		check("initiate -> lookup (Initiated)", func(ctx context.Context) (string, error) {
			oid := payments.NewOrderID()
			r, err := k.Initiate(ctx, payments.InitiateInput{OrderID: oid, AmountPaisa: 1000, Description: "smoke", ReturnURL: "https://example.com/payments/khalti/return"})
			if err != nil {
				return "", err
			}
			v, err := k.Verify(ctx, payments.VerifyInput{OrderID: oid, AmountPaisa: 1000, ProviderRef: r.ProviderRef})
			if err != nil {
				return "", err
			}
			if v.Status != payments.StatusPending {
				return "", fmt.Errorf("got %s", v.Status)
			}
			return fmt.Sprintf("%s -> %v", r.URL, v.Raw.(map[string]any)["status"]), nil
		})
	} else {
		fmt.Println("Khalti: skipped (set KHALTI_SECRET_KEY from https://test-admin.khalti.com)")
	}

	if failed > 0 {
		fmt.Printf("\n%d check(s) failed\n", failed)
		os.Exit(1)
	}
	fmt.Println("\nall sandbox checks passed")
}

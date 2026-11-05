// Shared app code for Go (net/http): payment types with settle(), the demo store,
// the reconcile job and the routes. Gateway modules live next to this folder.
// Routes take the gateway descriptor g and work for every gateway.

export interface Block {
  file: string;
  lang: string;
  code: string;
}

export interface GatewayRef {
  id: string;
  name: string;
  ts: string;
  py: string;
  php: string;
  go: string;
  java: string;
  kotlin: string;
}

export type Framework = "go";

export const types: Block[] = [
  {
    file: "payments/payments.go",
    lang: "go",
    code: `package payments

import (
	"context"
	"errors"
)

// Start tells the app where to send the buyer: Type "redirect" uses URL,
// Type "form" auto-posts Fields to Action.
type Start struct {
	Type        string
	URL         string
	Action      string
	Fields      map[string]string
	ProviderRef string // id the gateway hands back, if any; the app stores it
	Enctype     string // "" posts urlencoded (the browser default); NPS needs "multipart/form-data"
}

// Outcome.Status is paid, pending, failed, canceled, refunded or not_found.
type Outcome struct {
	Status      string
	ProviderRef string
}

type StartInput struct {
	AttemptID   string
	AmountPaisa int64
	ReturnURL   string
	Description string
}

type ConfirmInput struct {
	AttemptID   string
	AmountPaisa int64
	ProviderRef string
	Params      map[string]string // callback query and body params, empty from the reconcile job
}

type Gateway interface {
	StartPayment(ctx context.Context, in StartInput) (Start, error)
	ConfirmPayment(ctx context.Context, in ConfirmInput) (Outcome, error)
}

// ErrPayment marks a bad signature, amount mismatch or a refusal from the provider.
// Gateways wrap it: fmt.Errorf("%w: ...", ErrPayment). Any other error is a network
// or provider outage.
var ErrPayment = errors.New("payment error")

// Open lists the attempt states that can still change.
var Open = []string{"initiated", "pending"}

// Settle applies a gateway answer to an attempt. Safe to call any number of times:
// Transition only succeeds once, so Fulfil runs once per order.
func Settle(s *Store, a Attempt, o Outcome) {
	switch o.Status {
	case "paid", "failed", "canceled":
		if s.Transition(a.ID, Open, o.Status) && o.Status == "paid" {
			// Keep the gateway's transaction id (refunds, support). A ref saved at start
			// (Khalti pidx, IME TokenId, NPS ProcessId) stays: confirm looks the payment up with it.
			if o.ProviderRef != "" && a.ProviderRef == "" {
				s.SetProviderRef(a.ID, o.ProviderRef)
			}
			s.Fulfil(a.OrderID)
		}
	case "pending":
		s.Transition(a.ID, []string{"initiated"}, "pending")
	}
	// not_found: leave it, the reconcile job expires it after an hour.
}
`,
  },
];

export const store: Block[] = [
  {
    file: "payments/store.go",
    lang: "go",
    code: `package payments

import (
	"crypto/rand"
	"encoding/hex"
	"log"
	"slices"
	"sync"
	"time"
)

type Order struct {
	ID          string
	AmountPaisa int64
}

type Attempt struct {
	ID          string
	OrderID     string
	AmountPaisa int64
	Status      string
	ProviderRef string
	CreatedAt   time.Time
}

// Store is an in-memory demo store: swap for your database (table in the article).
// One mutex guards everything, so Transition is an atomic compare-and-set.
type Store struct {
	mu       sync.Mutex
	orders   map[string]Order
	attempts map[string]*Attempt
	order    []string // attempt ids, oldest first
}

func NewStore() *Store {
	return &Store{
		orders:   map[string]Order{"demo": {ID: "demo", AmountPaisa: 10000}}, // Rs 100
		attempts: map[string]*Attempt{},
	}
}

func (s *Store) GetOrder(id string) (Order, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	o, ok := s.orders[id]
	return o, ok
}

func (s *Store) CreateAttempt(orderID string, amountPaisa int64) Attempt {
	b := make([]byte, 10)
	rand.Read(b)
	a := &Attempt{
		ID:          hex.EncodeToString(b), // 20 lowercase hex chars
		OrderID:     orderID,
		AmountPaisa: amountPaisa,
		Status:      "initiated",
		CreatedAt:   time.Now(),
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.attempts[a.ID] = a
	s.order = append(s.order, a.ID)
	return *a
}

// GetAttempt returns a copy, so callers never race with Transition.
func (s *Store) GetAttempt(id string) (Attempt, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	a, ok := s.attempts[id]
	if !ok {
		return Attempt{}, false
	}
	return *a, true
}

func (s *Store) LatestAttempt(orderID string) (Attempt, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i := len(s.order) - 1; i >= 0; i-- {
		if a := s.attempts[s.order[i]]; a.OrderID == orderID {
			return *a, true
		}
	}
	return Attempt{}, false
}

func (s *Store) SetProviderRef(id, ref string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if a, ok := s.attempts[id]; ok {
		a.ProviderRef = ref
	}
}

// Transition moves the attempt to \`to\` only if its status is in \`from\`.
// In SQL: UPDATE payment_attempts SET status = $1 WHERE id = $2 AND status = ANY($3)
func (s *Store) Transition(id string, from []string, to string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	a, ok := s.attempts[id]
	if !ok || !slices.Contains(from, a.Status) {
		return false
	}
	a.Status = to
	return true
}

func (s *Store) OpenAttempts(olderThan time.Duration) []Attempt {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []Attempt
	for _, id := range s.order {
		a := s.attempts[id]
		if slices.Contains(Open, a.Status) && time.Since(a.CreatedAt) >= olderThan {
			out = append(out, *a)
		}
	}
	return out
}

func (s *Store) Fulfil(orderID string) {
	log.Printf("order %s paid, fulfil it here", orderID)
}
`,
  },
];

export const reconcile: Block[] = [
  {
    file: "payments/reconcile.go",
    lang: "go",
    code: `package payments

import (
	"context"
	"log"
	"time"
)

// Reconcile settles attempts whose buyer never came back. Run it every minute.
func Reconcile(ctx context.Context, s *Store, g Gateway) {
	open := s.OpenAttempts(2 * time.Minute)
	for _, a := range open {
		if time.Since(a.CreatedAt) > 3*24*time.Hour {
			// Still open after 3 days: asking again rarely helps, so a person checks it
			// (gateway dashboard, bank statement) and closes it by hand.
			log.Printf("attempt %s still %s after 3 days, needs manual review", a.ID, a.Status)
			continue
		}
		// Empty params: the gateway module asks the status API.
		o, err := g.ConfirmPayment(ctx, ConfirmInput{
			AttemptID:   a.ID,
			AmountPaisa: a.AmountPaisa,
			ProviderRef: a.ProviderRef,
			Params:      map[string]string{},
		})
		if err != nil {
			log.Printf("reconcile %s: %v", a.ID, err) // one bad attempt must not stop the rest
			continue
		}
		Settle(s, a, o)
		if o.Status == "not_found" && time.Since(a.CreatedAt) > time.Hour {
			s.Transition(a.ID, Open, "expired")
		}
	}
	log.Printf("reconcile: checked %d open attempts", len(open))
}
`,
  },
];

export function routes(g: GatewayRef): Record<Framework, Block[]> {
  return {
    go: [
      {
        file: "main.go",
        lang: "go",
        code: `package main

import (
	"context"
	"errors"
	"fmt"
	"html"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	"shop/payments"
)

func main() {
	baseURL := strings.TrimRight(envOr("BASE_URL", "http://localhost:8080"), "/")
	store := payments.NewStore()
	var gateway payments.Gateway = payments.${g.go}()

	// Reconcile open attempts every minute for as long as the server runs.
	go func() {
		for {
			payments.Reconcile(context.Background(), store, gateway)
			time.Sleep(time.Minute)
		}
	}()

	mux := http.NewServeMux()

	mux.HandleFunc("GET /{$}", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, \`<h1>Order demo, Rs 100</h1><form method="post" action="/pay/demo"><button>Pay with ${g.name}</button></form>\`)
	})

	mux.HandleFunc("POST /pay/{orderID}", func(w http.ResponseWriter, r *http.Request) {
		order, ok := store.GetOrder(r.PathValue("orderID"))
		if !ok {
			http.NotFound(w, r)
			return
		}
		attempt := store.CreateAttempt(order.ID, order.AmountPaisa)
		start, err := gateway.StartPayment(r.Context(), payments.StartInput{
			AttemptID:   attempt.ID,
			AmountPaisa: attempt.AmountPaisa,
			// Path segment, never a query string: some gateways append their own query parameters to this URL.
			ReturnURL:   baseURL + "/pay/return/" + attempt.ID,
			Description: "Order " + order.ID,
		})
		if err != nil {
			log.Printf("start %s: %v", attempt.ID, err)
			http.Error(w, "Could not start the payment", http.StatusBadGateway)
			return
		}
		if start.ProviderRef != "" {
			store.SetProviderRef(attempt.ID, start.ProviderRef)
		}
		if start.Type == "redirect" {
			http.Redirect(w, r, start.URL, http.StatusSeeOther)
			return
		}
		writeAutoPostForm(w, start)
	})

	// GET and POST: most gateways redirect back, CyberSource and IME Pay POST a form.
	returnHandler := func(w http.ResponseWriter, r *http.Request) {
		attempt, ok := store.GetAttempt(r.PathValue("attemptID"))
		if !ok {
			http.NotFound(w, r)
			return
		}
		r.ParseForm() // fills r.Form with query and form body params
		params := map[string]string{}
		for k, v := range r.Form {
			params[k] = v[0]
		}
		// Stored amount and providerRef, never values from the callback.
		outcome, err := gateway.ConfirmPayment(r.Context(), payments.ConfirmInput{
			AttemptID:   attempt.ID,
			AmountPaisa: attempt.AmountPaisa,
			ProviderRef: attempt.ProviderRef,
			Params:      params,
		})
		if errors.Is(err, payments.ErrPayment) {
			log.Printf("attempt %s: %v", attempt.ID, err)
			http.Error(w, "Payment could not be verified", http.StatusBadRequest)
			return
		}
		if err != nil {
			log.Printf("attempt %s: %v", attempt.ID, err) // the reconcile job retries later
			http.Error(w, "Payment provider unavailable, try again shortly", http.StatusBadGateway)
			return
		}
		payments.Settle(store, attempt, outcome)
		http.Redirect(w, r, "/orders/"+attempt.OrderID, http.StatusSeeOther)
	}
	mux.HandleFunc("GET /pay/return/{attemptID}", returnHandler)
	mux.HandleFunc("POST /pay/return/{attemptID}", returnHandler)

	mux.HandleFunc("GET /orders/{orderID}", func(w http.ResponseWriter, r *http.Request) {
		status := "no payment yet"
		if a, ok := store.LatestAttempt(r.PathValue("orderID")); ok {
			status = a.Status
		}
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		fmt.Fprintf(w, "Order %s: %s", r.PathValue("orderID"), status)
	})

	log.Println("listening on :8080")
	log.Fatal(http.ListenAndServe(":8080", mux))
}

// writeAutoPostForm sends a page that posts the gateway form as soon as it loads.
func writeAutoPostForm(w http.ResponseWriter, s payments.Start) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	fmt.Fprintf(w, \`<form id="pay" method="post" action="%s"\`, html.EscapeString(s.Action))
	if s.Enctype != "" {
		fmt.Fprintf(w, \` enctype="%s"\`, html.EscapeString(s.Enctype))
	}
	fmt.Fprint(w, \`>\`)
	for name, value := range s.Fields {
		fmt.Fprintf(w, \`<input type="hidden" name="%s" value="%s">\`, html.EscapeString(name), html.EscapeString(value))
	}
	fmt.Fprint(w, \`<noscript><button>Continue to payment</button></noscript></form>\`+
		\`<script>document.getElementById("pay").submit()</script>\`)
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
`,
      },
    ],
  };
}

export const setup: Record<Framework, Block> = {
  go:
  {
    file: "Terminal",
    lang: "bash",
    code: `# Go 1.22+, standard library only
mkdir shop && cd shop
go mod init shop
mkdir payments
# payments.go, store.go, reconcile.go and the gateway file go in payments/, main.go at the root

export BASE_URL=http://localhost:8080
# export the gateway variables too

go run .   # http://localhost:8080, reconcile runs in the same process every minute
`,
  },
};

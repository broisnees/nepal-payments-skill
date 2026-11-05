package payments

import (
	"crypto/rand"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

var htmlEscaper = strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", `"`, "&quot;", "'", "&#39;")

// EscapeHTML escapes & < > " ' for safe interpolation into HTML attribute values.
func EscapeHTML(s string) string { return htmlEscaper.Replace(s) }

// RenderAutoSubmitForm returns a server-rendered page that auto-POSTs a KindForm result
// (with its Enctype, e.g. multipart/form-data for NPS). Every value is HTML-escaped.
func RenderAutoSubmitForm(r InitiateResult) (string, error) {
	if r.Kind != KindForm {
		return "", errNotForm
	}
	var inputs strings.Builder
	for _, k := range r.orderedFieldNames() {
		inputs.WriteString(`<input type="hidden" name="` + EscapeHTML(k) + `" value="` + EscapeHTML(r.Fields[k]) + `">`)
	}
	enctype := ""
	if r.Enctype != "" {
		enctype = ` enctype="` + EscapeHTML(r.Enctype) + `"`
	}
	return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Redirecting to payment…</title></head><body><form id="f" method="POST" action="` +
		EscapeHTML(r.Action) + `"` + enctype + `>` + inputs.String() +
		`<noscript><button type="submit">Continue to payment</button></noscript></form><script>document.getElementById("f").submit()</script></body></html>`, nil
}

// orderedFieldNames returns FieldOrder (deduplicated, limited to existing fields) followed by any
// remaining fields in sorted order.
func (r InitiateResult) orderedFieldNames() []string {
	seen := make(map[string]bool, len(r.Fields))
	out := make([]string, 0, len(r.Fields))
	for _, k := range r.FieldOrder {
		if _, ok := r.Fields[k]; ok && !seen[k] {
			seen[k] = true
			out = append(out, k)
		}
	}
	var rest []string
	for k := range r.Fields {
		if !seen[k] {
			rest = append(rest, k)
		}
	}
	sort.Strings(rest)
	return append(out, rest...)
}

// formResult builds a KindForm result from ordered pairs.
func formResult(action string, pairs [][2]string) InitiateResult {
	fields := make(map[string]string, len(pairs))
	order := make([]string, 0, len(pairs))
	for _, p := range pairs {
		if _, dup := fields[p[0]]; !dup {
			order = append(order, p[0])
		}
		fields[p[0]] = p[1]
	}
	return InitiateResult{Kind: KindForm, Action: action, Method: "POST", Fields: fields, FieldOrder: order}
}

const orderIDAlphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"

// NewOrderID returns a short, provider-safe attempt id with prefix "P": <= 20 chars of [A-Z0-9]
// (fits connectIPS TXNID 20, Fonepay PRN 25, eSewa uuid charset, Khalti/NPS/IME/CyberSource limits).
// Example: "P1KX3M9Q2ZAB7C4D8E".
func NewOrderID() string { return NewOrderIDWithPrefix("P") }

// NewOrderIDWithPrefix is NewOrderID with a custom prefix; the result is cut to 20 chars.
func NewOrderIDWithPrefix(prefix string) string {
	ts := strings.ToUpper(strconv.FormatInt(time.Now().UnixMilli(), 36))
	tail := make([]byte, 0, 10)
	buf := make([]byte, 16)
	for len(tail) < 10 {
		if _, err := rand.Read(buf); err != nil {
			panic("payments: crypto/rand failed: " + err.Error())
		}
		for _, b := range buf {
			if b < 252 && len(tail) < 10 { // 252 = 7*36: rejection sampling keeps it unbiased
				tail = append(tail, orderIDAlphabet[b%36])
			}
		}
	}
	return truncateUTF16(prefix+ts+string(tail), 20)
}

// kathmandu returns Asia/Kathmandu, falling back to a fixed +05:45 zone (Nepal has no DST) when
// the tz database is unavailable (minimal containers).
var kathmandu = sync.OnceValue(func() *time.Location { return loadKathmandu(time.LoadLocation) })

func loadKathmandu(load func(string) (*time.Location, error)) *time.Location {
	if loc, err := load("Asia/Kathmandu"); err == nil {
		return loc
	}
	return time.FixedZone("+0545", 5*3600+45*60)
}

func errInvalidEnv(provider ProviderID, env Env) error {
	return &PaymentError{Provider: provider, Code: "invalid_config", Message: string(provider) + `: env must be "sandbox" or "production", got "` + string(env) + `"`}
}

func errMissingConfig(provider ProviderID, what string) error {
	return &PaymentError{Provider: provider, Code: "invalid_config", Message: string(provider) + ": " + what + " is required"}
}

func orDefault(s, def string) string {
	if s == "" {
		return def
	}
	return s
}

func durOr(d, def time.Duration) time.Duration {
	if d <= 0 {
		return def
	}
	return d
}

func splitTrim(s string) []string {
	parts := strings.Split(s, ",")
	for i := range parts {
		parts[i] = jsTrim(parts[i])
	}
	return parts
}

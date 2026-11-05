package payments

import (
	"encoding/json"
	"fmt"
	"math/big"
	"regexp"
	"strconv"
	"strings"
)

// maxSafeInteger is JavaScript's Number.MAX_SAFE_INTEGER (2^53-1), the TS port's upper bound.
const maxSafeInteger = 1<<53 - 1

// AssertPaisa returns an "invalid_amount" *PaymentError unless paisa is a positive safe integer.
func AssertPaisa(paisa int64, provider ProviderID) error {
	if paisa <= 0 || paisa > maxSafeInteger {
		return newPaymentError(provider, "invalid_amount", fmt.Sprintf("amount must be a positive integer in paisa, got %d", paisa), 0, nil)
	}
	return nil
}

// PaisaToRupees formats paisa as a rupee string: 12345 -> "123.45", 10000 -> "100", 5 -> "0.05".
// Integer math only.
func PaisaToRupees(paisa int64) string {
	u := uint64(paisa)
	neg := paisa < 0
	if neg {
		u = uint64(^paisa) + 1
	}
	rem := u % 100
	s := strconv.FormatUint(u/100, 10)
	if rem != 0 {
		s += "." + strconv.FormatUint(rem/10, 10) + strconv.FormatUint(rem%10, 10)
	}
	if neg {
		s = "-" + s
	}
	return s
}

var rupeesRe = regexp.MustCompile(`^-?\d+(\.\d+)?$`)

// RupeesToPaisa parses a rupee amount ("123.45", "1,000.0", " 100 ") into paisa.
// It rounds half away from zero on the 3rd decimal and never uses floating point.
func RupeesToPaisa(rupees string) (int64, error) {
	s := strings.ReplaceAll(jsTrim(rupees), ",", "")
	if !rupeesRe.MatchString(s) {
		return 0, fmt.Errorf("not a rupee amount: %s", rupees)
	}
	whole, frac, _ := strings.Cut(s, ".")
	neg := strings.HasPrefix(whole, "-")
	whole = strings.TrimPrefix(whole, "-")
	f := (frac + "000")[:3]
	w, ok := new(big.Int).SetString(whole, 10)
	if !ok {
		return 0, fmt.Errorf("not a rupee amount: %s", rupees)
	}
	p := w.Mul(w, big.NewInt(100))
	p.Add(p, big.NewInt(int64((f[0]-'0')*10+(f[1]-'0'))))
	if f[2] >= '5' {
		p.Add(p, big.NewInt(1))
	}
	if neg {
		p.Neg(p)
	}
	if !p.IsInt64() {
		return 0, fmt.Errorf("rupee amount out of range: %s", rupees)
	}
	return p.Int64(), nil
}

// paisaFromValue converts a JSON-decoded rupee value (string or number) to paisa, like TS
// rupeesToPaisa(string | number). Numbers are converted from their exact JSON text.
func paisaFromValue(v any) (int64, error) {
	switch x := v.(type) {
	case string:
		return RupeesToPaisa(x)
	case json.Number:
		return paisaFromNumberText(string(x))
	case float64:
		return RupeesToPaisa(jsFormatFloat(x))
	case int64:
		return RupeesToPaisa(strconv.FormatInt(x, 10))
	case int:
		return RupeesToPaisa(strconv.Itoa(x))
	default:
		return 0, fmt.Errorf("not a rupee amount: %s", jsString(v))
	}
}

// paisaFromNumberText handles a JSON number literal; exponent forms (1e3) are expanded exactly.
func paisaFromNumberText(s string) (int64, error) {
	if rupeesRe.MatchString(s) {
		return RupeesToPaisa(s)
	}
	r, ok := new(big.Rat).SetString(s)
	if !ok {
		return 0, fmt.Errorf("not a rupee amount: %s", s)
	}
	neg := r.Sign() < 0
	r.Abs(r)
	th := new(big.Int).Mul(r.Num(), big.NewInt(1000))
	th.Quo(th, r.Denom()) // truncate to thousandths
	p, last := new(big.Int).QuoRem(th, big.NewInt(10), new(big.Int))
	if last.Int64() >= 5 {
		p.Add(p, big.NewInt(1))
	}
	if neg {
		p.Neg(p)
	}
	if !p.IsInt64() {
		return 0, fmt.Errorf("rupee amount out of range: %s", s)
	}
	return p.Int64(), nil
}

// jsRupeesNumber is String(Number(paisaToRupees(p))): "100.50" -> "100.5", "100" -> "100".
func jsRupeesNumber(paisa int64) string {
	s := PaisaToRupees(paisa)
	if strings.Contains(s, ".") {
		s = strings.TrimSuffix(strings.TrimRight(s, "0"), ".")
	}
	return s
}

// amount2dp formats paisa as rupees with exactly two decimals: 10000 -> "100.00".
func amount2dp(paisa int64) string {
	neg := ""
	u := uint64(paisa)
	if paisa < 0 {
		neg, u = "-", uint64(^paisa)+1
	}
	return fmt.Sprintf("%s%d.%02d", neg, u/100, u%100)
}

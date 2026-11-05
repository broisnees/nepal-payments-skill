package payments

// Helpers that reproduce the JavaScript semantics the TypeScript adapters rely on
// (String(v), truthiness, Number(v), JSON.stringify, String.prototype.slice / trim,
// URLSearchParams and encodeURIComponent), so the port behaves byte-for-byte the same.

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"math/big"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"
)

// jsString mirrors JavaScript String(v) for JSON-decoded values.
func jsString(v any) string {
	switch x := v.(type) {
	case nil:
		return "null"
	case string:
		return x
	case bool:
		if x {
			return "true"
		}
		return "false"
	case json.Number:
		return jsNumberText(string(x))
	case float64:
		return jsFormatFloat(x)
	case int:
		return strconv.Itoa(x)
	case int64:
		return strconv.FormatInt(x, 10)
	case []any:
		parts := make([]string, len(x))
		for i, e := range x {
			if e != nil {
				parts[i] = jsString(e)
			}
		}
		return strings.Join(parts, ",")
	case map[string]any:
		return "[object Object]"
	default:
		return fmt.Sprint(x)
	}
}

// jsTemplate mirrors `${obj.key}`: "undefined" when the key is absent.
func jsTemplate(v any, present bool) string {
	if !present {
		return "undefined"
	}
	return jsString(v)
}

var jsonIntRe = regexp.MustCompile(`^-?(0|[1-9][0-9]*)$`)

// jsNumberText formats a JSON number literal the way JavaScript prints the parsed number.
// Integer literals are kept exact (JS would lose precision above 2^53).
func jsNumberText(s string) string {
	if jsonIntRe.MatchString(s) {
		if s == "-0" {
			return "0"
		}
		return s
	}
	f, err := strconv.ParseFloat(s, 64)
	if err != nil && !errors.Is(err, strconv.ErrRange) {
		return s
	}
	return jsFormatFloat(f)
}

// jsFormatFloat mirrors Number.prototype.toString().
func jsFormatFloat(f float64) string {
	switch {
	case math.IsNaN(f):
		return "NaN"
	case math.IsInf(f, 1):
		return "Infinity"
	case math.IsInf(f, -1):
		return "-Infinity"
	case f == 0:
		return "0"
	}
	if a := math.Abs(f); a >= 1e21 || a < 1e-6 {
		mant, exp, _ := strings.Cut(strconv.FormatFloat(f, 'e', -1, 64), "e")
		return mant + "e" + exp[:1] + strings.TrimLeft(exp[1:], "0")
	}
	return strconv.FormatFloat(f, 'f', -1, 64)
}

// truthy mirrors JavaScript truthiness for JSON-decoded values.
func truthy(v any) bool {
	switch x := v.(type) {
	case nil:
		return false
	case bool:
		return x
	case string:
		return x != ""
	case json.Number:
		f, _ := strconv.ParseFloat(string(x), 64)
		return f != 0 && !math.IsNaN(f)
	case float64:
		return x != 0 && !math.IsNaN(x)
	case int:
		return x != 0
	case int64:
		return x != 0
	default:
		return true
	}
}

// get returns v[key] when v is a JSON object (JS `v?.[key]`).
func get(v any, key string) (any, bool) {
	m, ok := v.(map[string]any)
	if !ok {
		return nil, false
	}
	x, ok := m[key]
	return x, ok
}

// getNonNull returns v[key] when present and not null (JS `v?.[key] != null`).
func getNonNull(v any, key string) (any, bool) {
	x, ok := get(v, key)
	return x, ok && x != nil
}

// strOrEmpty returns jsString(v[key]) when present and non-null, else "" (JS `v.key ?? ""`).
func strOrEmpty(v any, key string) string {
	if x, ok := getNonNull(v, key); ok {
		return jsString(x)
	}
	return ""
}

// isString reports whether v is a string equal to want (JS `v === want`).
func isString(v any, want string) bool {
	s, ok := v.(string)
	return ok && s == want
}

var jsDecimalRe = regexp.MustCompile(`^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$`)

// jsNumberRounded mirrors Math.round(Number(v)); ok=false when the result is NaN or infinite.
// Exact (big.Rat), so it never loses precision.
func jsNumberRounded(v any) (int64, bool) {
	var s string
	switch x := v.(type) {
	case nil:
		return 0, true
	case bool:
		if x {
			return 1, true
		}
		return 0, true
	case json.Number:
		s = string(x)
	case string:
		s = jsTrim(x)
		if s == "" {
			return 0, true
		}
	case float64:
		if math.IsNaN(x) || math.IsInf(x, 0) {
			return 0, false
		}
		return int64(math.Floor(x + 0.5)), true
	case int64:
		return x, true
	case int:
		return int64(x), true
	default:
		return 0, false
	}
	if len(s) > 2 && s[0] == '0' && strings.ContainsRune("xXoObB", rune(s[1])) {
		n, err := strconv.ParseInt(s, 0, 64)
		return n, err == nil
	}
	if !jsDecimalRe.MatchString(s) {
		return 0, false
	}
	sign := ""
	if s[0] == '+' || s[0] == '-' {
		sign, s = strings.TrimPrefix(s[:1], "+"), s[1:]
	}
	mant, exp, hasExp := strings.Cut(strings.ToLower(s), "e")
	if strings.HasPrefix(mant, ".") {
		mant = "0" + mant
	}
	if strings.HasSuffix(mant, ".") {
		mant += "0"
	}
	if hasExp {
		mant += "e" + exp
	}
	r, ok := new(big.Rat).SetString(sign + mant)
	if !ok {
		return 0, false
	}
	// floor(r + 1/2)
	num := new(big.Int).Mul(r.Num(), big.NewInt(2))
	num.Add(num, r.Denom())
	den := new(big.Int).Mul(r.Denom(), big.NewInt(2))
	q := new(big.Int).Div(num, den) // Euclidean = floor for positive den
	if !q.IsInt64() {
		return 0, false
	}
	return q.Int64(), true
}

// jsonInt returns the integer value of a JSON number (JS `typeof v === "number"`) when it is integral.
func jsonInt(v any) (int64, bool) {
	n, ok := v.(json.Number)
	if !ok {
		return 0, false
	}
	if i, err := n.Int64(); err == nil {
		return i, true
	}
	r, ok := new(big.Rat).SetString(string(n))
	if !ok || !r.IsInt() || !r.Num().IsInt64() {
		return 0, false
	}
	return r.Num().Int64(), true
}

// isJSSpace mirrors the WhiteSpace + LineTerminator set used by String.prototype.trim.
func isJSSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', 0xA0, 0x1680, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF:
		return true
	}
	return r >= 0x2000 && r <= 0x200A
}

func jsTrim(s string) string { return strings.TrimFunc(s, isJSSpace) }

// truncateUTF16 mirrors s.slice(0, n) (JS strings are UTF-16) without splitting a surrogate pair.
func truncateUTF16(s string, n int) string {
	units := 0
	for i, r := range s {
		u := 1
		if r >= 0x10000 {
			u = 2
		}
		if units+u > n {
			return s[:i]
		}
		units += u
	}
	return s
}

// utf16Len mirrors s.length.
func utf16Len(s string) int {
	n := 0
	for _, r := range s {
		if r >= 0x10000 {
			n += 2
		} else {
			n++
		}
	}
	return n
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}

// ---------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------

// decodeJSON parses text like JSON.parse (whole input, numbers kept as json.Number).
func decodeJSON(text string) (any, error) {
	dec := json.NewDecoder(strings.NewReader(text))
	dec.UseNumber()
	var v any
	if err := dec.Decode(&v); err != nil {
		return nil, err
	}
	if _, err := dec.Token(); err != io.EOF {
		return nil, errors.New("unexpected data after JSON value")
	}
	return v, nil
}

// jsonObjectKeys returns the top-level keys of a JSON object in document order (first occurrence).
func jsonObjectKeys(text string) []string {
	dec := json.NewDecoder(strings.NewReader(text))
	if tok, err := dec.Token(); err != nil || tok != json.Delim('{') {
		return nil
	}
	var keys []string
	seen := map[string]bool{}
	for dec.More() {
		t, err := dec.Token()
		if err != nil {
			return nil
		}
		k, _ := t.(string)
		if !seen[k] {
			seen[k] = true
			keys = append(keys, k)
		}
		var skip json.RawMessage
		if err := dec.Decode(&skip); err != nil {
			return nil
		}
	}
	return keys
}

// jsJSONString mirrors JSON.stringify(s).
func jsJSONString(s string) string {
	var b strings.Builder
	b.WriteByte('"')
	for i := 0; i < len(s); {
		r, size := utf8.DecodeRuneInString(s[i:])
		switch {
		case r == utf8.RuneError && size == 1:
			b.WriteString(`\uFFFD`)
		case r == '"':
			b.WriteString(`\"`)
		case r == '\\':
			b.WriteString(`\\`)
		case r == '\b':
			b.WriteString(`\b`)
		case r == '\f':
			b.WriteString(`\f`)
		case r == '\n':
			b.WriteString(`\n`)
		case r == '\r':
			b.WriteString(`\r`)
		case r == '\t':
			b.WriteString(`\t`)
		case r < 0x20:
			fmt.Fprintf(&b, `\u%04x`, r)
		default:
			b.WriteString(s[i : i+size])
		}
		i += size
	}
	b.WriteByte('"')
	return b.String()
}

type jsonKV struct {
	k string
	v any
}

// jsonObject is a JSON object that keeps insertion order, like a JS object literal.
type jsonObject []jsonKV

func (o jsonObject) MarshalJSON() ([]byte, error) {
	var b bytes.Buffer
	b.WriteByte('{')
	for i, kv := range o {
		if i > 0 {
			b.WriteByte(',')
		}
		b.WriteString(jsJSONString(kv.k))
		b.WriteByte(':')
		vb, err := encodeJSONValue(kv.v)
		if err != nil {
			return nil, err
		}
		b.Write(vb)
	}
	b.WriteByte('}')
	return b.Bytes(), nil
}

func encodeJSONValue(v any) ([]byte, error) {
	switch x := v.(type) {
	case nil:
		return []byte("null"), nil
	case string:
		return []byte(jsJSONString(x)), nil
	case jsonObject:
		return x.MarshalJSON()
	case json.Number:
		return []byte(x), nil
	case int64:
		return []byte(strconv.FormatInt(x, 10)), nil
	case bool:
		return []byte(strconv.FormatBool(x)), nil
	case map[string]string:
		keys := make([]string, 0, len(x))
		for k := range x {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		o := make(jsonObject, 0, len(keys))
		for _, k := range keys {
			o = append(o, jsonKV{k, x[k]})
		}
		return o.MarshalJSON()
	default:
		var buf bytes.Buffer
		enc := json.NewEncoder(&buf)
		enc.SetEscapeHTML(false)
		if err := enc.Encode(x); err != nil {
			return nil, err
		}
		return bytes.TrimRight(buf.Bytes(), "\n"), nil
	}
}

// ---------------------------------------------------------------------------
// URL encoding
// ---------------------------------------------------------------------------

const upperHex = "0123456789ABCDEF"

// encodeForm serializes pairs in order like URLSearchParams.toString().
func encodeForm(pairs [][2]string) string {
	var b strings.Builder
	for i, p := range pairs {
		if i > 0 {
			b.WriteByte('&')
		}
		formEscape(&b, p[0])
		b.WriteByte('=')
		formEscape(&b, p[1])
	}
	return b.String()
}

func formEscape(b *strings.Builder, s string) {
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c == ' ':
			b.WriteByte('+')
		case isAlnum(c) || c == '*' || c == '-' || c == '.' || c == '_':
			b.WriteByte(c)
		default:
			b.WriteByte('%')
			b.WriteByte(upperHex[c>>4])
			b.WriteByte(upperHex[c&15])
		}
	}
}

// encodeURIComponent mirrors the JS global of the same name.
func encodeURIComponent(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		if isAlnum(c) || strings.IndexByte("-_.!~*'()", c) >= 0 {
			b.WriteByte(c)
			continue
		}
		b.WriteByte('%')
		b.WriteByte(upperHex[c>>4])
		b.WriteByte(upperHex[c&15])
	}
	return b.String()
}

func isAlnum(c byte) bool {
	return c >= '0' && c <= '9' || c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z'
}

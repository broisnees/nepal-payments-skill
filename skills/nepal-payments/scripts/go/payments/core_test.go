package payments

// Ported from scripts/ts/test/core/.

import (
	"bytes"
	"encoding/json"
	"reflect"
	"regexp"
	"strings"
	"testing"
	"time"
)

func TestCore_MoneyConversionsAreExact(t *testing.T) {
	eq(t, PaisaToRupees(10000), "100")
	eq(t, PaisaToRupees(10050), "100.50")
	eq(t, PaisaToRupees(5), "0.05")
	for _, c := range []struct {
		in   any
		want int64
	}{
		{"1,000.0", 100000},
		{100.1, 10010},                // TS rupeesToPaisa(100.1): a JS number
		{json.Number("100.1"), 10010}, // the same number as it arrives in JSON
		{"0.1", 10},
		{"19.995", 2000},
		{1.005, 101}, // same as Python Decimal(str(x)); toFixed(2) would give 100
		{json.Number("1.005"), 101},
	} {
		got, err := paisaFromValue(c.in)
		if err != nil || got != c.want {
			t.Fatalf("rupeesToPaisa(%v) = %d, %v; want %d", c.in, got, err, c.want)
		}
	}
}

func TestCore_DecideTransitionStateMachine(t *testing.T) {
	const H = time.Hour
	paid := VerifyResult{Status: StatusPaid, AmountPaisa: ptr(int64(1000))}
	next := func(d TransitionDecision) any {
		if d.Next == nil {
			return nil
		}
		return *d.Next
	}
	eq(t, next(DecideTransition(StatusInitiated, paid, 1000, 0, 0)), any(StatusPaid))
	// amount guard: mismatch and missing amount both go to review, never paid
	got := DecideTransition(StatusPending, VerifyResult{Status: StatusPaid, AmountPaisa: ptr(int64(10))}, 1000, 0, 0)
	want := TransitionDecision{Next: ptr(StatusUnknown), ReviewRequired: true, LatePaid: false, Reason: "amount mismatch: stored 1000, provider 10"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v, want %+v", got, want)
	}
	eq(t, DecideTransition(StatusPending, VerifyResult{Status: StatusPaid}, 1000, 0, 0).ReviewRequired, true)
	// not_found keeps the attempt open inside the window, expires after
	eq(t, next(DecideTransition(StatusInitiated, VerifyResult{Status: StatusNotFound}, 1000, 5*time.Minute, H)), nil)
	eq(t, next(DecideTransition(StatusInitiated, VerifyResult{Status: StatusNotFound}, 1000, 2*H, H)), any(StatusExpired))
	// late payment after we closed it is recovered, not dropped
	late := DecideTransition(StatusExpired, paid, 1000, 3*H, H)
	eq(t, next(late), any(StatusPaid))
	eq(t, late.LatePaid, true)
	// paid is terminal for automation; same status is a no-op
	eq(t, next(DecideTransition(StatusPaid, VerifyResult{Status: StatusFailed}, 1000, 0, 0)), nil)
	eq(t, next(DecideTransition(StatusPending, VerifyResult{Status: StatusPending}, 1000, 0, 0)), nil)
	eq(t, next(DecideTransition(StatusFailed, VerifyResult{Status: StatusCanceled}, 1000, 0, 0)), nil)
}

func TestCore_Base64ToleratesPlusTurnedIntoSpace(t *testing.T) {
	b := ToBase64([]byte{251, 255, 190})
	eq(t, b, "+/++")
	got, err := FromBase64(strings.ReplaceAll(b, "+", " "))
	if err != nil || !bytes.Equal(got, []byte{251, 255, 190}) {
		t.Fatalf("got %v, %v", got, err)
	}
}

func TestCore_NewOrderIDFitsEveryProvider(t *testing.T) {
	re := regexp.MustCompile(`^[A-Z0-9]{17,20}$`)
	for i := 0; i < 1000; i++ {
		if id := NewOrderID(); !re.MatchString(id) {
			t.Fatalf("bad id %q", id)
		}
	}
}

func TestCore_AutoSubmitFormEscapesValues(t *testing.T) {
	html, err := RenderAutoSubmitForm(InitiateResult{Kind: KindForm, Action: "https://x/pay", Method: "POST", Fields: map[string]string{"a": `"><script>`}})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(html, "&quot;&gt;&lt;script&gt;") {
		t.Fatal(html)
	}
}

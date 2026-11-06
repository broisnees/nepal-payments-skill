package payments

import (
	"context"
	"fmt"
	"time"
)

// ProviderID identifies a payment provider. Values match the TypeScript wire strings.
type ProviderID string

// Provider ids.
const (
	ProviderEsewa       ProviderID = "esewa"
	ProviderKhalti      ProviderID = "khalti"
	ProviderFonepay     ProviderID = "fonepay"
	ProviderConnectIPS  ProviderID = "connectips"
	ProviderCyberSource ProviderID = "cybersource"
	ProviderNPS         ProviderID = "nps"
	ProviderIMEPay      ProviderID = "imepay"
	ProviderNepalPay    ProviderID = "nepalpay"
)

// PaymentStatus is the normalized payment state. Every provider status maps onto exactly one.
type PaymentStatus string

// Normalized statuses.
const (
	StatusPaid              PaymentStatus = "paid"               // money captured; safe to fulfil
	StatusPending           PaymentStatus = "pending"            // not settled yet; re-check later, do NOT fulfil
	StatusFailed            PaymentStatus = "failed"             // declined / error; retry with a NEW order id
	StatusCanceled          PaymentStatus = "canceled"           // user backed out
	StatusExpired           PaymentStatus = "expired"            // session timed out before payment
	StatusRefunded          PaymentStatus = "refunded"           // fully refunded
	StatusPartiallyRefunded PaymentStatus = "partially_refunded" // partially refunded
	StatusNotFound          PaymentStatus = "not_found"          // provider has no record (never started, or wrong env/credentials)
	StatusUnknown           PaymentStatus = "unknown"            // unmapped; treat like pending and alert
)

// AttemptStatus is the status stored on a payment attempt row: a [PaymentStatus] or [StatusInitiated].
type AttemptStatus = PaymentStatus

// StatusInitiated means the attempt was created and the provider has not been heard from.
// Adapters never return it.
const StatusInitiated AttemptStatus = "initiated"

// Env selects provider endpoints.
type Env string

// Environments.
const (
	EnvSandbox    Env = "sandbox"
	EnvProduction Env = "production"
)

// Customer is optional payer info (used by Khalti as customer_info).
type Customer struct {
	Name  string `json:"name,omitempty"`
	Email string `json:"email,omitempty"`
	Phone string `json:"phone,omitempty"`
}

// InitiateInput starts a payment attempt.
type InitiateInput struct {
	// OrderID is unique per payment ATTEMPT (not per order). Provider-safe charset: [A-Za-z0-9-].
	OrderID string
	// AmountPaisa is the integer paisa amount computed server-side from your order (the TOTAL charged).
	AmountPaisa int64
	// Description is shown to the payer where the provider supports it.
	Description string
	// ReturnURL is where the provider sends the payer back (your server route).
	ReturnURL string
	// FailureURL is used by providers with a separate failure URL; empty means ReturnURL.
	FailureURL string
	// Customer is optional payer info.
	Customer *Customer

	// Provider-specific options; each adapter reads only its own.
	Esewa       *EsewaInitiateOptions
	Khalti      *KhaltiInitiateOptions
	Fonepay     *FonepayInitiateOptions
	ConnectIPS  *ConnectIPSInitiateOptions
	CyberSource *CyberSourceInitiateOptions
	NPS         *NPSInitiateOptions
}

// ResultKind says how to send the payer to the provider.
type ResultKind string

// Initiate result kinds.
const (
	KindRedirect ResultKind = "redirect" // redirect the browser (or open a WebView / Custom Tab) to URL
	KindForm     ResultKind = "form"     // render an auto-submitting form that POSTs Fields to Action
	KindQR       ResultKind = "qr"       // show a QR (QRString, or QRImage when sent) the payer scans from their own app
)

// InitiateResult is a redirect, a form to auto-submit, or a QR to show.
// ProviderRef (Khalti pidx, NPS ProcessId, IME Pay TokenId, NEPALPAY validationTraceId) MUST be persisted on the attempt; Verify needs it.
type InitiateResult struct {
	Kind ResultKind `json:"kind"`

	// Redirect.
	URL       string `json:"url,omitempty"`
	ExpiresAt string `json:"expiresAt,omitempty"`
	Raw       any    `json:"raw,omitempty"`

	// Form.
	Action string            `json:"action,omitempty"`
	Method string            `json:"method,omitempty"` // always "POST"
	Fields map[string]string `json:"fields,omitempty"`
	// FieldOrder is the order the provider documents (and the TS port emits); RenderAutoSubmitForm uses it.
	FieldOrder []string `json:"fieldOrder,omitempty"`
	// Enctype is empty (application/x-www-form-urlencoded) or "multipart/form-data" (NPS).
	Enctype string `json:"enctype,omitempty"`

	// QR (NEPALPAY QR). Render QRString with any QR library, or
	// <img src="data:image/png;base64,{QRImage}"> when the provider sent an image.
	QRString string `json:"qrString,omitempty"`
	QRImage  string `json:"qrImage,omitempty"`

	ProviderRef string `json:"providerRef,omitempty"`
}

// VerifyInput asks the provider about an attempt. All values come from YOUR database except Callback.
type VerifyInput struct {
	OrderID string
	// AmountPaisa is the amount YOU stored for this attempt.
	AmountPaisa int64
	// ProviderRef is the value Initiate returned (Khalti pidx, NPS ProcessId, IME Pay TokenId...).
	ProviderRef string
	// Callback holds the raw query/body params the provider sent to your return URL, if any.
	// A nil map means "no callback".
	Callback map[string]string
}

// VerifyResult is the provider's authoritative answer.
type VerifyResult struct {
	Provider ProviderID    `json:"provider"`
	Status   PaymentStatus `json:"status"`
	// OrderID is your order / transaction id as known to the provider.
	OrderID string `json:"orderId"`
	// AmountPaisa is what the PROVIDER says was paid; nil if the provider doesn't say.
	AmountPaisa *int64 `json:"amountPaisa"`
	// TransactionID is the provider's final transaction id (eSewa ref_id, Khalti transaction_id...); "" if none.
	TransactionID string `json:"transactionId,omitempty"`
	// Raw is the provider response, for audit logs.
	Raw any `json:"raw,omitempty"`
}

// Adapter is the provider-independent interface every provider implements.
type Adapter interface {
	ID() ProviderID
	Initiate(ctx context.Context, in InitiateInput) (InitiateResult, error)
	// Verify is the server-to-server confirmation. Never trust callback params alone.
	Verify(ctx context.Context, in VerifyInput) (VerifyResult, error)
	// OrderIDFromCallback extracts YOUR order id from return-URL params ("" if absent).
	OrderIDFromCallback(params map[string]string) string
}

// PaymentError is returned for provider, validation and network failures.
type PaymentError struct {
	Provider ProviderID
	// Code is a stable machine-readable code, e.g. "invalid_signature", "network_error", "http_502".
	Code string
	// HTTPStatus is the provider HTTP status (or 400 for rejected callbacks); 0 when not applicable.
	HTTPStatus int
	// Details is the provider response or offending payload.
	Details any
	Message string
	// Err is the underlying cause (network errors, context cancellation), for errors.Is.
	Err error
}

func (e *PaymentError) Error() string { return e.Message }

// Unwrap returns the underlying cause.
func (e *PaymentError) Unwrap() error { return e.Err }

func newPaymentError(provider ProviderID, code, msg string, httpStatus int, details any) *PaymentError {
	return &PaymentError{Provider: provider, Code: code, HTTPStatus: httpStatus, Details: details, Message: msg}
}

// ---------------------------------------------------------------------------
// State machine (references/architecture.md §2, §4).
// ---------------------------------------------------------------------------

// OpenStatuses are the attempt statuses that verify results may still move.
var OpenStatuses = []AttemptStatus{StatusInitiated, StatusPending, StatusUnknown}

var (
	openStatuses = map[AttemptStatus]bool{StatusInitiated: true, StatusPending: true, StatusUnknown: true}
	closedUnpaid = map[AttemptStatus]bool{StatusFailed: true, StatusCanceled: true, StatusExpired: true, StatusNotFound: true}
)

// DefaultSessionWindow is the longest provider session (Khalti pidx ~60 min, eSewa ~50 min).
const DefaultSessionWindow = time.Hour

// TransitionDecision is the outcome of [DecideTransition].
type TransitionDecision struct {
	// Next is the status to write, or nil to write nothing.
	Next *AttemptStatus
	// ReviewRequired: stop automation and alert a human (amount mismatch / no amount for a "paid").
	ReviewRequired bool
	// LatePaid: the provider says paid after the attempt was closed; recover + alert.
	LatePaid bool
	Reason   string
}

// DecideTransition is the pure state-machine decision for a verify result.
// Apply Next with a conditional UPDATE guarded by prev, and fulfil only if *Next == StatusPaid.
// Refund transitions (paid -> refunded) come from your refund flow, not from here.
// sessionWindow <= 0 means DefaultSessionWindow.
func DecideTransition(prev AttemptStatus, result VerifyResult, storedAmountPaisa int64, attemptAge, sessionWindow time.Duration) TransitionDecision {
	if sessionWindow <= 0 {
		sessionWindow = DefaultSessionWindow
	}
	latePaid := result.Status == StatusPaid && closedUnpaid[prev]
	if !openStatuses[prev] && !latePaid {
		return TransitionDecision{Reason: fmt.Sprintf("attempt already %s", prev)}
	}
	if result.Status == StatusPaid && (result.AmountPaisa == nil || *result.AmountPaisa != storedAmountPaisa) {
		reason := "provider returned no amount for a paid status"
		if result.AmountPaisa != nil {
			reason = fmt.Sprintf("amount mismatch: stored %d, provider %d", storedAmountPaisa, *result.AmountPaisa)
		}
		next := StatusUnknown
		return TransitionDecision{Next: &next, ReviewRequired: true, LatePaid: latePaid, Reason: reason}
	}
	next := result.Status
	if next == StatusNotFound {
		// Payer may not have reached / finished the provider yet; anyone can hit a return URL early.
		if attemptAge < sessionWindow {
			return TransitionDecision{Reason: "not_found inside session window"}
		}
		next = StatusExpired
	}
	if next == prev {
		return TransitionDecision{Reason: "unchanged"}
	}
	reason := fmt.Sprintf("%s -> %s", prev, next)
	if latePaid {
		reason = fmt.Sprintf("late payment (was %s)", prev)
	}
	return TransitionDecision{Next: &next, LatePaid: latePaid, Reason: reason}
}

import type { LangSnippets } from "./types";

const verifyTail = `if err != nil {
	return err // network, 5xx or bad signature: leave the attempt open, reconciliation settles it
}
d := payments.DecideTransition(attempt.Status, v, attempt.AmountPaisa,
	time.Since(attempt.CreatedAt), payments.DefaultSessionWindow)
if d.Next != nil {
	// UPDATE payment_attempts SET status = *d.Next WHERE id = attempt.ID AND status = attempt.Status
	if *d.Next == payments.StatusPaid {
		// fulfil the order here, only if that UPDATE touched one row
	}
}`;

const saveRef = `if err := db.SaveProviderRef(ctx, attempt.ID, res.ProviderRef); err != nil {
	return err
}`;

const snippets: LangSnippets = {
  lang: "go",
  label: "Go",
  setup: `import (
	"log"
	"time"

	"github.com/broisnees/nepal-payments-skill/skills/nepal-payments/scripts/go/payments"
)

// Standard library only, Go 1.22+. Reads ESEWA_*, KHALTI_*, FONEPAY_*, ... (env.md);
// a provider is enabled when its required vars are set, otherwise its field on p is nil.
p, err := payments.New(payments.ConfigFromEnv())
if err != nil {
	log.Fatal(err)
}
// Every call takes a context first; in a handler use ctx := r.Context().`,
  providers: {
    esewa: {
      initiate: `res, err := p.Esewa.Initiate(ctx, payments.InitiateInput{
	OrderID:     attempt.ID,
	AmountPaisa: attempt.AmountPaisa, // the TOTAL charged
	Description: "Order #42",
	// no query string: eSewa appends ?data=..., so the attempt id goes in the path
	ReturnURL: baseURL + "/payments/esewa/return/" + attempt.ID,
})
if err != nil {
	return err
}
// form result: serve payments.RenderAutoSubmitForm(res) as text/html`,
      verify: `v, err := p.Esewa.Verify(ctx, payments.VerifyInput{
	OrderID:     attempt.ID,
	AmountPaisa: attempt.AmountPaisa,
	Callback:    params, // ?data=... on success; failure redirects carry nothing
})
${verifyTail}`,
      notes: [
        "Tax, service and delivery charges go in `Esewa: &payments.EsewaInitiateOptions{TaxPaisa: ...}` and are included in `AmountPaisa`.",
        "eSewa answers NOT_FOUND for a wrong total, so the stored total doubles as the amount check.",
      ],
    },
    khalti: {
      initiate: `res, err := p.Khalti.Initiate(ctx, payments.InitiateInput{
	OrderID:     attempt.ID,
	AmountPaisa: attempt.AmountPaisa, // minimum 1000 (Rs 10)
	Description: "Order #42",
	ReturnURL:   baseURL + "/payments/khalti/return/" + attempt.ID,
})
if err != nil {
	return err
}
// pidx: Verify needs it and Khalti has no lookup by order id
${saveRef}
// redirect: http.Redirect(w, r, res.URL, http.StatusSeeOther)`,
      verify: `v, err := p.Khalti.Verify(ctx, payments.VerifyInput{
	OrderID:     attempt.ID,
	AmountPaisa: attempt.AmountPaisa,
	ProviderRef: attempt.ProviderRef, // the stored pidx, never the one in params
	Callback:    params,              // a different callback pidx is rejected
})
${verifyTail}`,
      notes: [
        "Optional `Khalti: &payments.KhaltiInitiateOptions{...}`: `AmountBreakdown` (must sum to the amount), `ProductDetails`, `MerchantExtras` (keys start with `merchant_`).",
        "Set `Customer: &payments.Customer{Name: ..., Email: ..., Phone: ...}` on `InitiateInput` to prefill `customer_info`.",
      ],
    },
    fonepay: {
      initiate: `res, err := p.Fonepay.Initiate(ctx, payments.InitiateInput{
	OrderID:     attempt.ID, // PRN, 3 to 25 chars
	AmountPaisa: attempt.AmountPaisa,
	Description: "Order #42", // R1
	// RU: at most 150 chars, no query string
	ReturnURL: baseURL + "/payments/fonepay/return/" + attempt.ID,
	Fonepay:   &payments.FonepayInitiateOptions{Remarks2: "web"}, // R2, optional (default "N/A")
})
if err != nil {
	return err
}
// redirect: http.Redirect(w, r, res.URL, http.StatusSeeOther)`,
      verify: `v, err := p.Fonepay.Verify(ctx, payments.VerifyInput{
	OrderID:     attempt.ID,
	AmountPaisa: attempt.AmountPaisa,
	Callback:    params, // PRN, PS, RC, UID, BC, ..., DV: checked before anything is trusted
})
${verifyTail}`,
      notes: [
        "Set `FONEPAY_USERNAME` and `FONEPAY_PASSWORD` to verify through txnVerification, which also works without a callback (reconciliation). Without them `Verify` needs the DV-signed UID and BC from the redirect.",
        "Dynamic QR: `p.Fonepay.QRCreate`, then `p.Fonepay.QRStatus(ctx, orderID, &amountPaisa)` before fulfilling.",
      ],
    },
    connectips: {
      initiate: `res, err := p.ConnectIPS.Initiate(ctx, payments.InitiateInput{
	OrderID:     attempt.ID, // TXNID: 1 to 20 chars [A-Za-z0-9-]
	AmountPaisa: attempt.AmountPaisa,
	Description: "Order #42", // REMARKS and PARTICULARS default to this
	// unused: success/failure URLs are registered with NCHL and come back with ?TXNID=...
	ReturnURL:  baseURL + "/payments/connectips/return/" + attempt.ID,
	ConnectIPS: &payments.ConnectIPSInitiateOptions{ReferenceID: attempt.ID}, // optional, <= 20 chars
})
if err != nil {
	return err
}
// form result: serve payments.RenderAutoSubmitForm(res) as text/html (RSA-signed TOKEN)`,
      verify: `// validatetxn with Basic auth: the order id and amount are all it needs
v, err := p.ConnectIPS.Verify(ctx, payments.VerifyInput{
	OrderID:     attempt.ID,
	AmountPaisa: attempt.AmountPaisa,
})
${verifyTail}`,
      notes: [
        "`CONNECTIPS_PRIVATE_KEY_PEM` is the creditor key as PEM; literal `\\n` sequences in the env var are turned into newlines.",
      ],
    },
    cybersource: {
      initiate: `res, err := p.CyberSource.Initiate(ctx, payments.InitiateInput{
	OrderID:     attempt.ID, // transaction_uuid and reference_number, <= 50 chars
	AmountPaisa: attempt.AmountPaisa,
	Description: "Order #42",
	ReturnURL:   baseURL + "/payments/cybersource/return/" + attempt.ID,
	CyberSource: &payments.CyberSourceInitiateOptions{
		BillTo: payments.BillTo{ // required for sale/authorization
			Forename: "Ram", Surname: "Shrestha", Email: "ram@example.com",
			AddressLine1: "Durbar Marg", City: "Kathmandu", Country: "NP",
		},
	},
})
if err != nil {
	return err
}
// form result: serve payments.RenderAutoSubmitForm(res) as text/html (POSTs to /pay)`,
      verify: `// params is the signed response POST: it IS the proof (no status API)
v, err := p.CyberSource.Verify(ctx, payments.VerifyInput{
	OrderID:     attempt.ID,
	AmountPaisa: attempt.AmountPaisa,
	Callback:    params,
})
${verifyTail}`,
      notes: [
        "The receipt page comes from the Secure Acceptance profile. `ReturnURL` is sent only with `UseReturnURLOverride: true` on `CyberSourceConfig`, which `ConfigFromEnv` leaves off.",
        "The return is a POST: parse the form body into `params`. Without a callback (reconciliation) `Verify` fails; use REST Transaction Search.",
        "Optional `MerchantDefinedData` maps n to `merchant_defined_data<n>` (no PII).",
      ],
    },
    nps: {
      initiate: `res, err := p.NPS.Initiate(ctx, payments.InitiateInput{
	OrderID:     attempt.ID, // MerchantTxnId
	AmountPaisa: attempt.AmountPaisa,
	Description: "Order #42",                                    // TransactionRemarks
	ReturnURL:   baseURL + "/payments/nps/return/" + attempt.ID, // ResponseUrl
})
if err != nil {
	return err
}
// ProcessId from GetProcessId
${saveRef}
// form result: serve payments.RenderAutoSubmitForm(res) as text/html (multipart POST)`,
      verify: `// CheckTransactionStatus by MerchantTxnId: the order id and amount are all it needs
v, err := p.NPS.Verify(ctx, payments.VerifyInput{
	OrderID:     attempt.ID,
	AmountPaisa: attempt.AmountPaisa,
})
${verifyTail}`,
      notes: [
        "The Notification URL is set with NPS at onboarding. Run the same verify there and reply with `p.NPS.NotificationResponse(alreadyProcessed)` (plain text `received` / `already received`).",
        "`NPS: &payments.NPSInitiateOptions{InstrumentCode: ...}` skips the NPS bank/wallet picker.",
      ],
    },
    imepay: {
      initiate: `res, err := p.IMEPay.Initiate(ctx, payments.InitiateInput{
	OrderID:     attempt.ID, // RefId
	AmountPaisa: attempt.AmountPaisa,
	Description: "Order #42",
	ReturnURL:   baseURL + "/payments/imepay/return/" + attempt.ID, // RespUrl and CancelUrl
})
if err != nil {
	return err
}
// TokenId: Recheck needs it
${saveRef}
// redirect: http.Redirect(w, r, res.URL, http.StatusSeeOther)`,
      verify: `// callbacks are unsigned: Recheck with the stored TokenId is the only proof
v, err := p.IMEPay.Verify(ctx, payments.VerifyInput{
	OrderID:     attempt.ID,
	AmountPaisa: attempt.AmountPaisa,
	ProviderRef: attempt.ProviderRef,
})
${verifyTail}`,
      notes: [
        "IME Pay merged into Khalti in July 2025; prefer Khalti for new builds.",
        "IME POSTs to the return URL, and outbound port 7979 must be reachable.",
        "Non-zero Recheck codes map to pending, never failed; reconciliation escalates them at its cutoff.",
      ],
    },
    nepalpay: {
      initiate: `res, err := p.NepalPay.Initiate(ctx, payments.InitiateInput{
	OrderID:     attempt.ID, // billNumber: 1 to 25 chars [A-Za-z0-9-]
	AmountPaisa: attempt.AmountPaisa, // sent as rupees with two decimals ("100.00")
	Description: "Order #42", // purposeOfTransaction, 25 chars max
	// no ReturnURL: the payer pays from their own banking app
})
if err != nil {
	return err
}
// validationTraceId: Verify looks the payment up by it
${saveRef}
// res.Kind == payments.KindQR: show <img src="data:image/png;base64,{res.QRImage}">, or render res.QRString,
// then poll GET /payments/{id}/status from the page every 3-5 s.`,
      verify: `// GET /payments/{id}/status, polled by the QR page. Also what the reconciliation job runs.
v, err := p.NepalPay.Verify(ctx, payments.VerifyInput{
	OrderID:     attempt.ID,
	AmountPaisa: attempt.AmountPaisa,
	ProviderRef: attempt.ProviderRef, // the stored validationTraceId; required
})
${verifyTail}`,
      notes: [
        "A debited row whose credit isn't confirmed maps to `unknown`: money left the payer, so a person reviews it.",
        "`VerifyConfirmation` and `ConfirmationResponse` handle NCHL's confirm-payment callback; `WebSocketRequest` builds the STOMP request for live status.",
      ],
    },
  },
};

export default snippets;

// Package payments is one interface over Nepali payment gateways: eSewa (ePay v2 + Intent),
// Khalti (KPG-2), Fonepay (web redirect + Dynamic QR), connectIPS, CyberSource Secure Acceptance,
// NPS OnePG, IME Pay, NEPALPAY QR, Hamro Pay and GetPay (NCHL cards).
//
// It is a port of the TypeScript reference adapters in scripts/ts/src, uses only the Go standard
// library, and works on Go 1.22+.
//
// Rules the package enforces:
//   - Money is integer paisa (1 NPR = 100 paisa) everywhere. Convert at the edge with
//     [PaisaToRupees] / [RupeesToPaisa]; never use float64 for money.
//   - Callback / return-URL params are hints. [Adapter.Verify] always asks the provider
//     server-to-server (or checks the provider's signature where that is the only proof).
//   - Apply a verify result with [DecideTransition] and a conditional UPDATE guarded by the
//     status you read; fulfil only when the decision moves the attempt to [StatusPaid].
//
// Every network call takes a [context.Context] first and goes through a [Doer]
// (*http.Client satisfies it), so tests can inject a fake.
//
// Example:
//
//	p, err := payments.New(payments.ConfigFromEnv())
//	if err != nil {
//		log.Fatal(err)
//	}
//	// Start a payment attempt (amount comes from YOUR database).
//	res, err := p.Khalti.Initiate(ctx, payments.InitiateInput{
//		OrderID:     payments.NewOrderID(),
//		AmountPaisa: 150000,
//		Description: "Everest T-shirt",
//		ReturnURL:   "https://shop.example.com/payments/khalti/return",
//	})
//	// Persist res.ProviderRef (Khalti pidx) on the attempt, then redirect to res.URL.
//	// For form results (eSewa, connectIPS, CyberSource, NPS) serve payments.RenderAutoSubmitForm(res).
//
//	// On the return URL (and in the reconciliation job):
//	v, err := p.Khalti.Verify(ctx, payments.VerifyInput{
//		OrderID:     attempt.ProviderOrderID,
//		AmountPaisa: attempt.AmountPaisa,
//		ProviderRef: attempt.ProviderRef, // from YOUR db, never from the callback
//		Callback:    params,
//	})
//	if err != nil {
//		// network / 5xx / invalid signature: leave the attempt open; reconciliation settles it
//	}
//	d := payments.DecideTransition(attempt.Status, v, attempt.AmountPaisa,
//		time.Since(attempt.CreatedAt), payments.DefaultSessionWindow)
//	if d.Next != nil {
//		// UPDATE payment_attempts SET status = *d.Next ... WHERE id = $id AND status = attempt.Status
//	}
//
// Errors returned by adapters are usually *[PaymentError]; use errors.As to read its Code.
package payments

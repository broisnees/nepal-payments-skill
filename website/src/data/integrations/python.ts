import type { LangSnippets } from "./types";

const snippets: LangSnippets = {
  lang: "python",
  label: "Python",
  setup: `import time

from nepal_payments import config_from_env, create_payments, decide_transition, render_auto_submit_form

# Enables every provider whose env vars are set (references/env.md). Build it once per process.
payments = create_payments(config_from_env())

# The adapters are synchronous (stdlib urllib). From async views (FastAPI, Starlette),
# call them through starlette.concurrency.run_in_threadpool.`,
  providers: {
    esewa: {
      initiate: `# No provider_ref: the status API looks the payment up by transaction_uuid + total.
init = payments["esewa"].initiate(
    order_id=attempt.id,  # transaction_uuid: letters, digits and "-" only
    amount_paisa=attempt.amount_paisa,  # the TOTAL charged; verify() gets the same number
    description="Order #42",
    return_url=f"{base_url}/payments/esewa/return/{attempt.id}",  # no query string: eSewa appends ?data=
)
# init.kind == "form": serve render_auto_submit_form(init) as text/html from /payments/{id}/start`,
      verify: `result = payments["esewa"].verify(
    order_id=attempt.id,
    amount_paisa=attempt.amount_paisa,  # stored total; a wrong total comes back as not_found
    callback=params,  # ?data= on success: signature and transaction_uuid are checked, then the status API
)
d = decide_transition(attempt.status, result.status, result.amount_paisa, attempt.amount_paisa,
                      time.time() - attempt.created_at.timestamp())
# Write d.next with UPDATE ... WHERE id = attempt.id AND status = attempt.status.
# d.review_required or d.late_paid: alert a human.
if d.next == "paid":
    pass  # fulfil the order here, only when that UPDATE changed a row`,
      notes: [
        "Optional `tax_paisa`, `service_charge_paisa` and `delivery_charge_paisa` are a breakdown INCLUDED in `amount_paisa`, not added to it.",
        "Failure redirects carry no `data`, so the attempt id in the return path is how the handler finds the attempt.",
        "This is the ePay v2 web flow. The mobile Intent flow uses `intent_book()` and `intent_verify()`.",
      ],
    },
    khalti: {
      initiate: `init = payments["khalti"].initiate(
    order_id=attempt.id,  # purchase_order_id
    amount_paisa=attempt.amount_paisa,  # minimum 1000 (Rs 10)
    description="Order #42",  # purchase_order_name
    return_url=f"{base_url}/payments/khalti/return/{attempt.id}",
)
# pidx: lookup needs it and Khalti has no lookup by order id
db.save_provider_ref(attempt.id, init.provider_ref)
# init.kind == "redirect": 302 the browser to init.url (the link expires at init.expires_at)`,
      verify: `result = payments["khalti"].verify(
    order_id=attempt.id,
    amount_paisa=attempt.amount_paisa,
    provider_ref=attempt.provider_ref,  # the pidx saved at initiate, never the one in params
    callback=params,  # a params["pidx"] that differs from the stored one is rejected
)
d = decide_transition(attempt.status, result.status, result.amount_paisa, attempt.amount_paisa,
                      time.time() - attempt.created_at.timestamp())
# Write d.next with UPDATE ... WHERE id = attempt.id AND status = attempt.status.
# d.review_required or d.late_paid: alert a human.
if d.next == "paid":
    pass  # fulfil the order here, only when that UPDATE changed a row`,
      notes: [
        "Optional extras: `customer` ({\"name\", \"email\", \"phone\"}), `amount_breakdown` (must sum to `amount_paisa`), `product_details`, and `merchant_extras` with `merchant_`-prefixed keys.",
        "Expired and canceled payments come back from lookup as HTTP 400 with a normal body; `verify()` maps them instead of raising.",
      ],
    },
    fonepay: {
      initiate: `# No provider_ref: verification looks the payment up by PRN + amount.
init = payments["fonepay"].initiate(
    order_id=attempt.id,  # PRN: 3-25 chars
    amount_paisa=attempt.amount_paisa,
    description="Order #42",  # R1, up to 160 chars
    return_url=f"{base_url}/payments/fonepay/return/{attempt.id}",  # RU: 150 chars max, no query string
)
# init.kind == "redirect": 302 the browser to init.url`,
      verify: `result = payments["fonepay"].verify(
    order_id=attempt.id,
    amount_paisa=attempt.amount_paisa,
    callback=params,  # PRN, PS, RC, UID, BC, ... DV: trusted only when the DV checks out
)
d = decide_transition(attempt.status, result.status, result.amount_paisa, attempt.amount_paisa,
                      time.time() - attempt.created_at.timestamp())
# Write d.next with UPDATE ... WHERE id = attempt.id AND status = attempt.status.
# d.review_required or d.late_paid: alert a human.
if d.next == "paid":
    pass  # fulfil the order here, only when that UPDATE changed a row`,
      notes: [
        "Set `FONEPAY_USERNAME` and `FONEPAY_PASSWORD`: `verify()` then uses txnVerification, which also works without a callback (reconciliation). Without them it needs the DV-signed UID and BC from the redirect.",
        "Optional `remarks2` fills R2 (50 chars, defaults to \"N/A\").",
      ],
    },
    connectips: {
      initiate: `# No provider_ref: validatetxn looks the payment up by TXNID + amount.
init = payments["connectips"].initiate(
    order_id=attempt.id,  # TXNID: 1-20 chars [A-Za-z0-9-], unique per app
    amount_paisa=attempt.amount_paisa,  # TXNAMT is sent in paisa
    description="Order #42",  # REMARKS and PARTICULARS unless you pass remarks / particulars
    return_url=f"{base_url}/payments/connectips/return/{attempt.id}",  # unused: NCHL holds the registered URLs
)
# init.kind == "form": serve render_auto_submit_form(init) as text/html from /payments/{id}/start`,
      verify: `# connectIPS returns with ?TXNID=<attempt.id>; load the attempt by it, then:
result = payments["connectips"].verify(
    order_id=attempt.id,
    amount_paisa=attempt.amount_paisa,  # signed into the validatetxn token
)
d = decide_transition(attempt.status, result.status, result.amount_paisa, attempt.amount_paisa,
                      time.time() - attempt.created_at.timestamp())
# Write d.next with UPDATE ... WHERE id = attempt.id AND status = attempt.status.
# d.review_required or d.late_paid: alert a human.
if d.next == "paid":
    pass  # fulfil the order here, only when that UPDATE changed a row`,
      notes: [
        "connectIPS signs with RSA, so it needs `pip install cryptography`. The PEM may be PKCS#1 or PKCS#8; `load_pfx_private_key_pem()` in `nepal_payments.core` extracts it from the creditor .pfx.",
        "Success and failure URLs are registered with NCHL, so they can't carry the attempt id; the handler reads `TXNID`.",
        "`get_txn_detail(order_id, amount_paisa)` adds the NCHL txnId, bank, charges and creditStatus.",
      ],
    },
    cybersource: {
      initiate: `init = payments["cybersource"].initiate(
    order_id=attempt.id,  # transaction_uuid and reference_number, 50 chars max
    amount_paisa=attempt.amount_paisa,
    description="Order #42",
    return_url=f"{base_url}/payments/cybersource/return/{attempt.id}",  # sent only with use_return_url_override
    bill_to={
        # required: collect it at checkout (state and postal_code only for US/CA)
        "forename": "Sita", "surname": "Sharma", "email": "sita@example.com",
        "address_line1": "Durbar Marg", "city": "Kathmandu", "country": "NP",
    },
)
# init.kind == "form": serve render_auto_submit_form(init) as text/html from /payments/{id}/start`,
      verify: `result = payments["cybersource"].verify(
    order_id=attempt.id,
    amount_paisa=attempt.amount_paisa,
    callback=params,  # the signed response POST is the only proof: no params, no verify
)
d = decide_transition(attempt.status, result.status, result.amount_paisa, attempt.amount_paisa,
                      time.time() - attempt.created_at.timestamp())
# Write d.next with UPDATE ... WHERE id = attempt.id AND status = attempt.status.
# d.review_required or d.late_paid: alert a human.
if d.next == "paid":
    pass  # fulfil the order here, only when that UPDATE changed a row`,
      notes: [
        "The return is a cross-site form POST: read the form body on this route (FastAPI needs python-multipart) and exempt it from CSRF (`@csrf_exempt` in Django).",
        "The receipt URL comes from the Secure Acceptance profile; `return_url` is only sent when the adapter is built with `use_return_url_override=True`. Optional `merchant_defined_data` must not hold PII.",
        "Secure Acceptance has no status API, so reconciliation needs the REST Transaction Search (references/cybersource.md).",
      ],
    },
    nps: {
      initiate: `init = payments["nps"].initiate(
    order_id=attempt.id,  # MerchantTxnId
    amount_paisa=attempt.amount_paisa,
    description="Order #42",  # TransactionRemarks, 100 chars max
    return_url=f"{base_url}/payments/nps/return/{attempt.id}",  # ResponseUrl
)
# ProcessId from GetProcessId
db.save_provider_ref(attempt.id, init.provider_ref)
# init.kind == "form" (multipart): serve render_auto_submit_form(init) from /payments/{id}/start`,
      verify: `result = payments["nps"].verify(
    order_id=attempt.id,  # CheckTransactionStatus looks up MerchantTxnId
    amount_paisa=attempt.amount_paisa,
)
d = decide_transition(attempt.status, result.status, result.amount_paisa, attempt.amount_paisa,
                      time.time() - attempt.created_at.timestamp())
# Write d.next with UPDATE ... WHERE id = attempt.id AND status = attempt.status.
# d.review_required or d.late_paid: alert a human.
if d.next == "paid":
    pass  # fulfil the order here, only when that UPDATE changed a row`,
      notes: [
        "Optional `instrument_code` (from `get_instruments()`) skips the NPS bank picker.",
        "NPS also GETs your Notification URL (set at onboarding). Run the same verify there and answer with `notification_response(already_processed)`.",
      ],
    },
    imepay: {
      initiate: `init = payments["imepay"].initiate(
    order_id=attempt.id,  # RefId
    amount_paisa=attempt.amount_paisa,
    description="Order #42",
    return_url=f"{base_url}/payments/imepay/return/{attempt.id}",  # RespUrl (and CancelUrl unless failure_url is set)
)
# TokenId: Recheck needs it
db.save_provider_ref(attempt.id, init.provider_ref)
# init.kind == "redirect": 302 the browser to init.url`,
      verify: `result = payments["imepay"].verify(
    order_id=attempt.id,
    amount_paisa=attempt.amount_paisa,
    provider_ref=attempt.provider_ref,  # the stored TokenId; the POSTed callback is unsigned
)
d = decide_transition(attempt.status, result.status, result.amount_paisa, attempt.amount_paisa,
                      time.time() - attempt.created_at.timestamp())
# Write d.next with UPDATE ... WHERE id = attempt.id AND status = attempt.status.
# d.review_required or d.late_paid: alert a human.
if d.next == "paid":
    pass  # fulfil the order here, only when that UPDATE changed a row`,
      notes: [
        "IME Pay POSTs the result to RespUrl / CancelUrl: read the form body and exempt the route from CSRF checks.",
        "Recheck maps every non-zero ResponseCode to pending, never failed; reconciliation escalates at its cutoff.",
        "The API runs on port 7979; outbound traffic to it must be allowed.",
      ],
    },
  },
};

export default snippets;

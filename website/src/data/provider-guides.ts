// Per-provider integration guides. Facts come from skills/nepal-payments/references/*.md and the adapters.
// scripts/sync-docs.mjs turns each entry into docs/providers/<slug>/index.mdx.
import type { ProviderKey } from "./integrations/types";

export interface ProviderGuide {
  key: ProviderKey;
  name: string;
  /** Meta description, under 160 characters. */
  description: string;
  kind: string;
  summary: string;
  flow: string[];
  /** What arrives at your return URL and how to treat it. */
  callback: string;
  env: { required: string[]; optional: string[] };
  /** Public sandbox values, if the provider publishes any. */
  sandboxEnv?: string;
  sandbox: string[];
  gotchas: string[];
  goLive: string[];
  extraSetup?: { title: string; body: string; code?: { lang: string; text: string } };
  /** Heading for step 4 when the provider has no return URL. Default "Verify on return". */
  verifyTitle?: string;
}

export const providerGuides: ProviderGuide[] = [
  {
    key: "esewa",
    name: "eSewa",
    description: "Integrate eSewa ePay v2 step by step in TypeScript, Python, Java, Kotlin, PHP or Go: signed form, success callback and the status API.",
    kind: "Wallet",
    summary:
      "eSewa ePay v2 is a signed form POST. eSewa sends the payer back to your success URL with a base64 `data` parameter, and the status API decides whether the payment went through. The mobile Intent flow is covered in the reference.",
    flow: [
      "Your server signs `total_amount`, `transaction_uuid` and `product_code` with HMAC-SHA256 and renders an auto-submitting form.",
      "The payer logs in and pays on eSewa.",
      "eSewa redirects to `success_url?data=<base64 JSON>`, or to `failure_url` with no parameters.",
      "Your server checks the signature on `data`, then calls the status API with the total you stored. That response decides.",
    ],
    callback:
      "Success adds a signed `data` parameter. Failure adds nothing, so keep the attempt id in the return URL path (`/payments/esewa/return/<attemptId>`) and keep the URL free of query strings, because eSewa appends `?data=`.",
    env: {
      required: ["ESEWA_PRODUCT_CODE", "ESEWA_SECRET_KEY"],
      optional: ["ESEWA_ENV", "ESEWA_INTENT_PRODUCT_CODE", "ESEWA_INTENT_ACCESS_KEY", "ESEWA_INTENT_BASE_URL"],
    },
    sandboxEnv: "ESEWA_ENV=sandbox\nESEWA_PRODUCT_CODE=EPAYTEST\nESEWA_SECRET_KEY='8gBm/:&EnhH.1/q'",
    sandbox: [
      "Merchant: product code `EPAYTEST`, secret key `8gBm/:&EnhH.1/q` (public, from eSewa's docs).",
      "Payer: eSewa ID `9806800001` to `9806800005`, password `Nepal@123`, token `123456`.",
      "The sandbox login has a reCAPTCHA, so finish test payments in a browser.",
    ],
    gotchas: [
      "Format each amount once and use the same string in the form and the signature. `110` signed but `110.0` posted fails with ES104.",
      "The status API returns `NOT_FOUND` for a wrong total, so pass the total including tax and charges.",
      "Secret keys copied from config UIs can arrive HTML-escaped (`&amp;`). The adapter unescapes them.",
    ],
    goLive: [
      "Get the live product code and secret key from eSewa merchant onboarding.",
      "For Intent, get the production host and access key from eSewa and set `ESEWA_INTENT_BASE_URL`.",
    ],
  },
  {
    key: "khalti",
    name: "Khalti",
    description: "Integrate Khalti KPG-2 web checkout step by step in TypeScript, Python, Java, Kotlin, PHP or Go: initiate, return URL and lookup by pidx.",
    kind: "Wallet",
    summary:
      "Khalti KPG-2 returns a payment URL and a `pidx`. Redirect the payer there, store the `pidx`, and confirm with the lookup API when the payer comes back.",
    flow: [
      "Your server calls initiate with the amount in integer paisa and gets `payment_url` plus `pidx`.",
      "Store `pidx` on the attempt, then redirect the payer to `payment_url`.",
      "Khalti redirects to your `return_url` with `pidx`, `status`, `purchase_order_id` and more.",
      "Your server looks the payment up by the `pidx` you stored. That response decides.",
    ],
    callback:
      "A GET with `pidx`, `status`, `transaction_id`, `amount` and `purchase_order_id`. The adapter refuses a callback whose `pidx` differs from the one you stored, which blocks replayed callbacks.",
    env: { required: ["KHALTI_SECRET_KEY", "KHALTI_WEBSITE_URL"], optional: ["KHALTI_ENV", "KHALTI_PUBLIC_KEY"] },
    sandboxEnv: "KHALTI_ENV=sandbox\nKHALTI_SECRET_KEY=...          # from test-admin.khalti.com\nKHALTI_WEBSITE_URL=https://shop.example.com",
    sandbox: [
      "Merchant: sign up at test-admin.khalti.com (signup OTP `987654`) and copy the secret key.",
      "Payer: Khalti ID `9800000000` to `9800000005`, MPIN `1111`, OTP `987654`.",
      "The sandbox has the wallet only, no e-banking or cards.",
    ],
    gotchas: [
      "The amount is integer paisa with a minimum of `1000` (Rs 10).",
      "Payment links expire (60 minutes in production), after which lookup reports the attempt as expired.",
      "An expired payment comes back as HTTP 400 with a normal body. The adapter maps it instead of throwing.",
      "`KHALTI_PUBLIC_KEY` is only for mobile SDK builds. The server never needs it.",
    ],
    goLive: [
      "Complete KYC and the contract, otherwise live payments are capped at NPR 200.",
      "Use live keys from admin.khalti.com and set `KHALTI_ENV=production`.",
    ],
  },
  {
    key: "fonepay",
    name: "Fonepay",
    description: "Integrate Fonepay web payments step by step in TypeScript, Python, Java, Kotlin, PHP or Go: DV signing, callback check and txnVerification.",
    kind: "Bank QR",
    summary:
      "Fonepay web payments are a signed redirect. Every request and response carries a `DV` (HMAC-SHA512) and the verification API confirms the result. Dynamic QR for point of sale is covered in the reference.",
    flow: [
      "Your server builds the request parameters and their `DV`, then redirects the browser to Fonepay.",
      "The payer scans or pays from their bank app.",
      "Fonepay redirects to your return URL with `PRN`, `PID`, `PS`, `RC`, `UID`, `BC`, `INI`, `P_AMT`, `R_AMT` and `DV`.",
      "Your server checks the response `DV`, then calls txnVerification (or the legacy verification). That response decides.",
    ],
    callback:
      "A GET carrying `PRN` (your attempt id) and the result fields, signed by `DV`. A missing or wrong `DV` is rejected, so nobody can force a status with `?PRN=<id>&PS=false`.",
    env: {
      required: ["FONEPAY_MERCHANT_CODE", "FONEPAY_SECRET_KEY"],
      optional: ["FONEPAY_ENV", "FONEPAY_USERNAME", "FONEPAY_PASSWORD"],
    },
    sandboxEnv: "FONEPAY_ENV=sandbox\nFONEPAY_MERCHANT_CODE=NBQM\nFONEPAY_SECRET_KEY=a7e3512f5032480a83137793cb2021dc",
    sandbox: [
      "Merchant: the public dev sample `NBQM` / `a7e3512f5032480a83137793cb2021dc` covers the redirect only.",
      "txnVerification and Dynamic QR need your own merchant-panel username and password.",
      "Payer: scan with a Fonepay-enabled test bank app from your bank.",
    ],
    gotchas: [
      "`PRN` must be 3 to 25 characters and unique. A reused one fails with `Duplicate PRN` (HTTP 409).",
      "Fonepay only accepts dates as `MM/DD/YYYY` in Asia/Kathmandu. The adapter formats them.",
      "The dev merchant-API hosts are not in public DNS. Fonepay whitelists or issues them during onboarding.",
    ],
    goLive: [
      "Get the live PID, secret key and panel login through your acquiring bank.",
      "Confirm the live txnVerification host with Fonepay.",
    ],
  },
  {
    key: "connectips",
    name: "connectIPS",
    description: "Integrate connectIPS direct bank debit step by step in TypeScript, Python, Java, Kotlin, PHP or Go: RSA TOKEN signing and validatetxn.",
    kind: "Bank",
    summary:
      "connectIPS (NCHL) debits the payer's bank account directly. Your server signs a `TOKEN` with the RSA key from your creditor `.pfx`, posts a form to the connectIPS login page, and confirms with `validatetxn`.",
    flow: [
      "Your server signs the `TOKEN` (RSA-SHA256) and renders an auto-submitting form to the connectIPS login page.",
      "The payer logs in to their bank and approves the debit.",
      "connectIPS redirects to the success or failure URL registered with NCHL, adding `TXNID`.",
      "Your server calls `validatetxn` with Basic auth (APPID and app password). That response decides.",
    ],
    callback:
      "A GET to the success or failure URL that NCHL registered for your app, with `TXNID`. connectIPS doesn't take a return URL per request, so the `returnUrl` you pass is ignored.",
    env: {
      required: ["CONNECTIPS_MERCHANT_ID", "CONNECTIPS_APP_ID", "CONNECTIPS_PRIVATE_KEY_PEM"],
      optional: ["CONNECTIPS_ENV", "CONNECTIPS_APP_NAME", "CONNECTIPS_APP_PASSWORD"],
    },
    sandbox: [
      "Request UAT credentials and a test `.pfx` from connectIPS technical support by email.",
      "The payer test login comes with the test account.",
    ],
    extraSetup: {
      title: "Convert the .pfx once",
      body: "TypeScript and Go need the private key as PKCS#8 PEM. Add `-legacy` on OpenSSL 3 if the `.pfx` uses RC2 or 3DES.",
      code: {
        lang: "bash",
        text: "openssl pkcs12 -in CREDITOR.pfx -nocerts -nodes | openssl pkcs8 -topk8 -nocrypt -out creditor.key.pem",
      },
    },
    gotchas: [
      "`TXNID` is 1 to 20 characters of `[A-Za-z0-9-]`. `newOrderId()` fits.",
      "`TXNAMT` is in paisa, and `validatetxn` must get the same paisa amount.",
      "Commas and equals signs in remarks would corrupt the token string, so the adapter replaces them with spaces.",
    ],
    goLive: [
      "Get NCHL activation through your bank and a live `.pfx`.",
      "Register the live success and failure URLs with NCHL.",
    ],
  },
  {
    key: "cybersource",
    name: "CyberSource",
    description: "Accept cards through Nepali banks with CyberSource Secure Acceptance, step by step in TypeScript, Python, Java, Kotlin, PHP or Go.",
    kind: "Cards",
    summary:
      "CyberSource Secure Acceptance takes cards through a Nepali acquiring bank. Your server signs every form field, the payer enters the card on CyberSource, and the signed response POST is the proof. There is no simple status API.",
    flow: [
      "Your server signs every field (HMAC-SHA256), including the `bill_to` address, and renders an auto-submitting form to `/pay`.",
      "The payer enters the card and completes 3-D Secure.",
      "CyberSource POSTs the signed result to your receipt page through the browser and to your Merchant POST URL server to server.",
      "Your server checks the signature, the order id and the currency, then maps the decision. That response decides.",
    ],
    callback:
      "A form POST to the receipt page and to the Merchant POST URL (Profile, Notifications). Both are cross-site POSTs: exempt them from CSRF middleware and rely on the signature. Reply to the Merchant POST within 10 seconds.",
    env: {
      required: ["CYBERSOURCE_PROFILE_ID", "CYBERSOURCE_ACCESS_KEY", "CYBERSOURCE_SECRET_KEY"],
      optional: ["CYBERSOURCE_ENV", "CYBERSOURCE_CURRENCY"],
    },
    sandbox: [
      "Get a Business Center test account and a Secure Acceptance profile from your bank.",
      "Test cards: Visa `4111111111111111`, Mastercard `5555555555554444`, any future expiry. 3-D Secure cards are in the reference.",
    ],
    gotchas: [
      "`billTo` is required for sale and authorization. Use country `NP`; state and postal code only apply to the US and Canada.",
      "Without a callback there is nothing to verify. For reconciliation use the REST Transaction Search through the official SDK.",
      "CyberSource is sunsetting Secure Acceptance in favour of Unified Checkout. Agree a migration date with your bank.",
    ],
    goLive: [
      "Use live profile keys. They expire after two years, so put the renewal in a calendar.",
      "Configure the Merchant POST URL, enable 3-D Secure and enable NPR for each card type.",
    ],
  },
  {
    key: "nps",
    name: "NPS OnePG",
    description: "Integrate NPS OnePG step by step in TypeScript, Python, Java, Kotlin, PHP or Go to reach about 29 banks, wallets and cards in one API.",
    kind: "Aggregator",
    summary:
      "NPS OnePG (NPX) reaches about 29 banks, wallets and card checkouts through one integration. Get a `ProcessId`, post a multipart form to the gateway, and confirm with `CheckTransactionStatus`.",
    flow: [
      "Your server calls `GetProcessId` (HMAC-SHA512, Basic auth) and stores the `ProcessId`.",
      "The browser auto-posts a multipart form to the NPS gateway, and the payer picks a bank or wallet.",
      "NPS calls your Notification URL server to server, and the browser returns to your `ResponseUrl`, both with `MerchantTxnId`.",
      "Your server calls `CheckTransactionStatus`. That response decides.",
    ],
    callback:
      "The Notification URL (registered at onboarding) and the `ResponseUrl` both carry `MerchantTxnId` and `GatewayTxnId`, unsigned. From the Notification URL, reply `received` once you've recorded a final status, `already received` for repeats, and a non-2xx while the payment is still pending.",
    env: {
      required: ["NPS_MERCHANT_ID", "NPS_SECRET_KEY"],
      optional: ["NPS_ENV", "NPS_MERCHANT_NAME", "NPS_API_USERNAME", "NPS_API_PASSWORD"],
    },
    sandbox: ["Sandbox credentials and test logins come from NPS onboarding."],
    gotchas: [
      "`Amount`, `MerchantTxnId` and `ProcessId` in the form must match the `GetProcessId` call exactly.",
      "The gateway requires `multipart/form-data`. The adapter's form result sets `enctype`.",
      "Pass `instrumentCode` to skip the NPS picker when you show your own bank list.",
    ],
    goLive: [
      "Use the live API host and credentials from the onboarding PDF.",
      "Register the Notification URL with NPS.",
    ],
  },
  {
    key: "imepay",
    name: "IME Pay",
    description: "Integrate IME Pay wallet checkout step by step in TypeScript, Python, Java, Kotlin, PHP or Go: GetToken, checkout redirect and Recheck.",
    kind: "Wallet",
    summary:
      "IME Pay merged with Khalti in July 2025, so new builds should use Khalti. For existing IME Pay merchants: get a token, redirect to checkout, and confirm with `Recheck`.",
    flow: [
      "Your server calls `GetToken` and stores the `TokenId`.",
      "The payer is redirected to IME Pay web checkout and pays.",
      "IME POSTs `ResponseCode`, `RefId`, `TransactionId`, `TranAmount` and `Msisdn` to your response URL.",
      "Your server calls `Recheck` with the stored token. `ResponseCode` 0 means paid; that response decides.",
    ],
    callback:
      "A form POST with `RefId` (your attempt id). IME Pay callbacks are unsigned, so only `Recheck` decides.",
    env: {
      required: ["IMEPAY_MERCHANT_CODE", "IMEPAY_USERNAME"],
      optional: ["IMEPAY_ENV", "IMEPAY_PASSWORD", "IMEPAY_MODULE"],
    },
    sandbox: ["Credentials come from the IME or Khalti-by-IME merchant team."],
    gotchas: [
      "Outbound port 7979 must be open, and IME may need to whitelist your server IP.",
      "Non-zero codes are documented inconsistently, so the adapter treats them as pending and lets reconciliation expire the attempt.",
      "Don't copy the WooCommerce plugin's `validate_ipn()`: it fetches Recheck and then ignores the result.",
    ],
    goLive: [
      "Get your server IP whitelisted for port 7979.",
      "Confirm with the merchant team that web checkout is still offered after the merger.",
    ],
  },
  {
    key: "nepalpay",
    name: "NEPALPAY QR",
    description: "Integrate NEPALPAY QR (NCHL) dynamic QR step by step in TypeScript, Python, Java, Kotlin, PHP or Go: RSA token, generateQR and the transaction report.",
    kind: "Bank QR",
    summary:
      "NEPALPAY QR is NCHL's national merchant QR. Your server signs a token with the key from your NPI `.pfx`, asks NCHL for a dynamic QR, and shows it. The payer scans it with any NEPALPAY QR enabled bank or wallet app, and the transaction report confirms the payment. There is no redirect and no return URL.",
    flow: [
      "Your server signs the token (RSA-SHA256) and calls `generateQR` with the amount in rupees and the attempt id as `billNumber`.",
      "Store the `validationTraceId` it returns on the attempt, then show `qrImage` (a base64 PNG) or render `qrString`.",
      "The payer scans the QR and pays from their own banking app. Your page polls a status route on your server every few seconds.",
      "That route calls the transaction report (`merchanttxnreport`) by `validationTraceId`. That response decides.",
    ],
    callback:
      "Nothing comes back to the browser: the payer is in their own app. Poll `verify()` from the QR page (every 3 to 5 seconds), and let the reconciliation job settle anyone who closes the page. Merchants that registered a callback with NCHL also get a confirm-payment POST; treat it as a hint, load the attempt by `merchantBillNo` and run the same `verify()`.",
    verifyTitle: "Verify by polling",
    env: {
      required: ["NEPALPAY_ACQUIRER_ID", "NEPALPAY_MERCHANT_ID", "NEPALPAY_USERNAME", "NEPALPAY_PRIVATE_KEY_PEM"],
      optional: [
        "NEPALPAY_ENV",
        "NEPALPAY_PASSWORD",
        "NEPALPAY_MERCHANT_NAME",
        "NEPALPAY_MCC",
        "NEPALPAY_MERCHANT_CITY",
        "NEPALPAY_MERCHANT_POSTAL_CODE",
        "NEPALPAY_STORE_LABEL",
        "NEPALPAY_TERMINAL_LABEL",
        "NEPALPAY_CLIENT_ID",
        "NEPALPAY_CLIENT_SECRET",
        "NEPALPAY_NCHL_PUBLIC_KEY_PEM",
        "NEPALPAY_WS_URL",
        "NEPALPAY_WS_USERNAME",
        "NEPALPAY_WS_API_TOKEN",
      ],
    },
    sandbox: [
      "There are no public sandbox credentials. Enrol through your bank, or email businesssupport@nchl.com.np for dynamic QR integration, and NCHL issues the UAT acquirer id, merchant id, NPI user and `NPI.pfx`.",
      "The UAT host is `https://devopennpi.connectips.com`. It answers `E401 UNAUTHORIZED` until the credentials are right.",
    ],
    extraSetup: {
      title: "Convert the .pfx once",
      body: "The token is signed with the private key from the NPI `.pfx`. Convert it to PKCS#8 PEM exactly like connectIPS, and add `-legacy` on OpenSSL 3 if the `.pfx` uses RC2 or 3DES.",
      code: {
        lang: "bash",
        text: "openssl pkcs12 -in NPI.pfx -nocerts -nodes | openssl pkcs8 -topk8 -nocrypt -out nepalpay.key.pem",
      },
    },
    gotchas: [
      "Persist `validationTraceId` (the `providerRef`). Without it only a date-wise report can find the payment.",
      "Amounts go out in rupees with two decimals (`\"10.50\"`), unlike connectIPS, which takes paisa. Sign the exact string you send.",
      "The token string joins `acquirerId,merchantId,merchantCategoryCode,transactionCurrency,transactionAmount,billNumber,userId` with bare commas. The docs print a space after each comma, but that is a typesetting artifact: every other NPI token and the working C# client use a bare comma.",
      "One QR can have several report rows: a failed scan can be paid again on the same QR. The adapter reports `paid` when any row has `debitStatus` `000` and `creditStatus` `000`, `999` or `DEFER`.",
      "`merchantName` must match the enrolled name, and `billNumber` is at most 25 characters. `newOrderId()` fits.",
    ],
    goLive: [
      "Get the live acquirer id, merchant id, NPI user and `.pfx` from NCHL through your bank, and set `NEPALPAY_ENV=production` (`opennpi.connectips.com`).",
      "Keep the reconciliation job running: payers who close the QR page never hit your status route.",
    ],
  },
  {
    key: "hamropay",
    name: "Hamro Pay",
    description: "Integrate Hamro Pay checkout step by step in TypeScript, Python, Java, Kotlin, PHP or Go: Create Session, signed form, Get Transaction and webhook.",
    kind: "Wallet",
    summary:
      "Hamro Pay is Hamro Patro's wallet. Its checkout works like eSewa: your server creates a session, the browser posts a signed form to the gateway, the payer approves in Hamro Pay, and Get Transaction decides. It takes Rs 10 to Rs 50,000 per payment, from KYC-verified wallets only.",
    flow: [
      "Your server calls Create Session with the amount in paisa, signed with HMAC-SHA512, and stores the `sessionId`.",
      "Your server signs the gateway `token` and renders an auto-submitting form to the Hamro Pay gateway.",
      "The payer approves in Hamro Pay, which redirects to your success or failure URL with `?MerchantTxnId=`.",
      "Your server calls Get Transaction for that attempt. That response decides.",
    ],
    callback:
      "Both redirects carry only `MerchantTxnId`, which names the attempt and proves nothing. Check it matches the attempt id in your route, then call `verify()`. Get Transaction returns the amount in rupees; the adapter converts it to paisa. If you save a webhook URL in the portal, Hamro Pay also POSTs a signed JSON body: check it with `verifyWebhook()` and the webhook secret, then run the same `verify()`.",
    env: {
      required: ["HAMROPAY_MERCHANT_ID", "HAMROPAY_CLIENT_ID", "HAMROPAY_CLIENT_API_KEY", "HAMROPAY_CLIENT_SECRET"],
      optional: ["HAMROPAY_ENV", "HAMROPAY_WEBHOOK_SECRET", "HAMROPAY_API_BASE_URL", "HAMROPAY_GATEWAY_URL"],
    },
    sandbox: [
      "Merchant: sign up at https://pay-sandbox.hamropatro.com (signup OTP `000000`) and copy the merchant id, Client-Id, Client-API-Key and client secret from Client Credentials.",
      "Payer: Hamro Pay number `9841414141`, T-PIN `0000`.",
      "The UAT API is `https://uat-payclient.hamropatro.com` and the gateway form posts to `https://uat-checkout-pay.hamropatro.com/api/checkout`.",
    ],
    gotchas: [
      "Amount units flip by direction: `transactionAmount` goes out in paisa as a string, and every amount Hamro Pay returns is in rupees.",
      "Send `Connection: close`. The API drops each connection without closing it, and Hamro Pay's own sample saw every second keep-alive request fail on UAT.",
      "Signatures join values with bare commas, so a comma inside a value is refused. `merchantTxnId` is at most 25 characters, and `newOrderId()` fits.",
      "A session lives about 10 minutes. A timed-out Create Session may still exist, so retry with a new attempt id, never the same one.",
      "The webhook is signed with the webhook secret, not the client secret, over Hamro Pay's own rendering of the amount (`1200`, `1200.0` or `1200.00`). `verifyWebhook()` tries each.",
    ],
    goLive: [
      "Get the live credentials and the live gateway URL from Hamro Pay, set `HAMROPAY_ENV=production` and `HAMROPAY_GATEWAY_URL`. The live gateway host isn't published, so the adapter refuses to start a payment without it.",
      "Save the live webhook URL in the live portal and set `HAMROPAY_WEBHOOK_SECRET` if you use it.",
    ],
  },
  {
    key: "getpay",
    name: "GetPay",
    description: "Accept cards through Nepali banks with NCHL's GetPay checkout, step by step in TypeScript, Python, Java, Kotlin, PHP or Go: SDK pages and token check.",
    kind: "Cards",
    summary:
      "GetPay is the card checkout NCHL hosts for Nepali banks (NMB, Global IME and others): Visa and Mastercard with 3-D Secure. It is a browser SDK spread over four pages, not a redirect or a form. GetPay redirects back with a token, and your server checks it against your `oprKey` before it asks `merchant-status`. Credentials come only from your bank, and the bank registers your domain with NCHL.",
    flow: [
      "`initiate()` returns `{ kind: \"sdk\", scriptUrl, options }`: the bundle URL and the SDK options, with the price in rupees and the attempt id as `clientRequestId`.",
      "Your checkout page loads the bundle and runs `new GetPay(options).initialize()`. Its `onSuccess` opens your payment page, where GetPay renders the card form and runs 3-D Secure.",
      "GetPay sends the payer to your success or fail page with a `token`, in the query or, for cards without 3-D Secure, in the `#hash`. That page breaks out of GetPay's iframe and forwards the token to your server.",
      "Your server checks the token's `oprSecret`, calls `merchant-status`, and requires the transaction's `clientId` to equal the attempt id. That response decides.",
    ],
    callback:
      "Point both callback URLs at a page that serves `returnPage()`: only the browser can read a token in the `#hash`. It forwards the token as `?token=` to your verify route, which passes it to `verify()` as `callback.token`. `merchant-status` answers for any transaction id, whoever asks, so the adapter reports `paid` only when the `oprSecret` matches your `oprKey` and `clientId` is your attempt id. Without a token (the reconciliation job), a success can't be proven yours and comes back `unknown` for a person to check in the bank portal.",
    verifyTitle: "Verify the return token",
    env: {
      required: ["GETPAY_PAP_INFO", "GETPAY_OPR_KEY", "GETPAY_WEBSITE_DOMAIN"],
      optional: ["GETPAY_ENV", "GETPAY_INS_KEY", "GETPAY_BUSINESS_NAME", "GETPAY_IMAGE_URL", "GETPAY_CURRENCY", "GETPAY_BUNDLE_URL", "GETPAY_BASE_URL"],
    },
    sandbox: [
      "There are no public credentials. Your bank issues the UAT `papInfo`, `oprKey`, `insKey` (blank when operator-hosted) and bundle URL, and registers your domain with NCHL.",
      "The card form refuses origins NCHL hasn't whitelisted (a `401` from CyberSource's card iframe), so `localhost` doesn't work. Test on the registered domain, with test cards from the bank.",
      "The UAT status APIs are public: `merchant-status` and `transaction-statement` on `https://uat-bank-getpay.nchl.com.np` answer without auth, which is enough to check your server reaches them.",
    ],
    gotchas: [
      "Use four separate pages (checkout, payment, fail, success). GetPay's docs warn that combining them causes caching problems.",
      "`price` is a number in rupees (`1200.5`), not a string and not paisa.",
      "`clientRequestId` must be present or absent, never empty. Keep it to 50 characters of `[A-Za-z0-9-]`; `newOrderId()` fits.",
      "`oprKey` and `papInfo` reach the browser by GetPay's design. Neither is a secret, which is why the token check and the `clientId` check matter.",
      "No refund API is published. Refunds go through the bank's portal. Store `crrn` with the transaction id for disputes.",
    ],
    goLive: [
      "Get the live `papInfo`, `oprKey` and bundle URL from your bank, set `GETPAY_ENV=production`, and have the bank register the production domain with NCHL.",
      "Deploy the four pages on that domain. Refunds go through the bank's portal, not an API.",
    ],
  },
];

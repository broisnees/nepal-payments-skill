# Other gateways: HBL (2C2P PACO), Prabhu Pay, Moru, CellPay, Namaste Pay

These have no adapter in `scripts/`. HBL needs bank-issued RSA keys to test, and the wallets have little or no public documentation. Each section gives what is verifiable and how to build it on the same `PaymentAdapter` interface (`initiate` / `verify` / `orderIdFromCallback`), keeping every rule in `architecture.md`.

Shortcut: **NPS (`nps.md`) already routes to HBL Card Checkout, Khalti, MORU, MyPay, Hamro Pay and ~29 banks.** Only integrate these directly if you need your own acquiring contract.

## Himalayan Bank (HBL): 2C2P PACO, JOSE

HBL's card gateway runs on **2C2P PACO**. Docs: devzone.2c2p.com (`/docs/integration-1`, `/reference/payviapaymentpage`, `/docs/payment-status`). HBL supplies credentials plus 2C2P sample code (C#, PHP, Java). One npm package claims HBL uses Mastercard MPGS instead (UNVERIFIED, conflicts with every other source), so **confirm the product with HBL**.

| | Base |
|---|---|
| UAT | `https://core.demo-paco.2c2p.com` |
| Production | `https://core.paco.2c2p.com` |

Endpoints:
- Payment: `api/1.0/Payment/prePaymentUi` (HBL samples) or `api/2.0/Payment/prePaymentUi` (current 2C2P docs); `api/2.0/Payment/nonUi`
- Inquiry: `GET api/2.0/Inquiry/transactionStatus?orderNo=…`, `api/2.0/Inquiry/transactionList`
- Void / settlement / refund: `api/2.0/void`, `PUT api/2.0/settlement`, `api/2.0/Refund/refund`

**Keys**: `officeId` (merchant id) + API key from HBL; PACO `kid` (UAT `7664a2ed0dee4879bdfca0e8ce1ac313`, PRD `19f84b5655f04e25a99b09f1ee2fac78`); PACO's encryption and signing public keys (from HBL/2C2P); and **two RSA-4096 key pairs you generate** (signing + encryption). Give both public keys to HBL.

**Request** = JWS (PS256, your signing key) wrapped in JWE (RSA-OAEP + A128CBC-HS256, PACO encryption key, `kid` set). Body is the compact JWE, sent with `Content-Type: application/jose; charset=utf-8`, `Accept: application/jose`, and the API key header **as in HBL's sample** (`CompanyApiKey`; 2C2P docs variously say `apiKey` / `token`).

```ts
// npm i jose  (panva/jose: supports PS256, RSA-OAEP, A128CBC-HS256)
import { SignJWT, CompactEncrypt, compactDecrypt, jwtVerify, importPKCS8, importSPKI } from "jose";

async function pacoRequest(path: string, body: unknown) {
  const signKey = await importPKCS8(process.env.HBL_MERCHANT_SIGNING_PRIVATE_KEY!, "PS256");
  const pacoEnc = await importSPKI(process.env.HBL_PACO_ENCRYPTION_PUBLIC_KEY!, "RSA-OAEP");
  const jws = await new SignJWT({ request: body, CompanyApiKey: process.env.HBL_API_KEY })
    .setProtectedHeader({ alg: "PS256", typ: "JWT" })
    .setIssuer(process.env.HBL_API_KEY!).setAudience("PacoAudience")
    .setIssuedAt().setNotBefore("0s").setExpirationTime("5m")
    .sign(signKey);
  const jwe = await new CompactEncrypt(new TextEncoder().encode(jws))
    .setProtectedHeader({ alg: "RSA-OAEP", enc: "A128CBC-HS256", kid: process.env.HBL_PACO_KID!, typ: "JWT" })
    .encrypt(pacoEnc);
  const res = await fetch(`${process.env.HBL_BASE_URL}/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/jose; charset=utf-8", Accept: "application/jose", CompanyApiKey: process.env.HBL_API_KEY! },
    body: jwe, signal: AbortSignal.timeout(20_000),
  });
  // Response: decrypt with YOUR encryption private key, verify with PACO's signing public key
  const encKey = await importPKCS8(process.env.HBL_MERCHANT_ENCRYPTION_PRIVATE_KEY!, "RSA-OAEP");
  const pacoSign = await importSPKI(process.env.HBL_PACO_SIGNING_PUBLIC_KEY!, "PS256");
  const { plaintext } = await compactDecrypt(await res.text(), encKey);
  const { payload } = await jwtVerify(new TextDecoder().decode(plaintext), pacoSign, { issuer: "PacoIssuer", audience: process.env.HBL_API_KEY });
  return payload as any;
}
```

**prePaymentUi body**: `apiRequest{requestMessageID (GUID), requestDateTime (UTC ISO with ms + Z), language:"en-US"}`, `officeId`, `orderNo` (≤40), `productDescription` (≤50), `paymentType:"CC"`, `paymentCategory:"ECOM"`, `request3dsFlag:"Y"`, `transactionAmount{amountText:"000000100000" (minor units, 12-digit zero-padded), currencyCode:"NPR", decimalPlaces:2, amount:1000.00}`, `notificationURLs{confirmationURL, failedURL, cancellationURL, backendURL}`. Success: `apiResponse.responseCode == "PC-B050000"` (errors can come with HTTP 200). Redirect to `response.Data.paymentPage.paymentPageURL`.

**Status**: `paymentStatusInfo.paymentStatus`: **`A` (approved, step PA) or `S` (settled, step ST) = paid**. `I`/`P`/`PCPS` = pending, `F` rejected, `E` expired, `C` cancelled, `V` voided, `R`/`RI` refund. **Webhook**: PACO POSTs a JOSE-encrypted result to `backendURL`; decrypt and verify it like a response. The browser redirect URLs are not proof.

Gotchas: an empty `kid` is rejected; the samples default to THB, so set `NPR`; use `request3dsFlag:"Y"` in production. Community packages: Packagist `bickyraj/hbl`, `thebikramlama/hbl`; WordPress `hbl-payment-for-woocommerce`.

## Prabhu Pay (UNVERIFIED: community plugin only)

No public docs. Get them from the Prabhu Pay merchant team. A community WordPress plugin (`wc-prabhu-pay`, author not affiliated) uses:
- Initiate: `POST https://stagesys.prabhupay.com/api/EPayment/Initiate` (live `sys.prabhupay.com`) with `{totalAmount, merchantId, invoiceNo, returnUrl, remarks, password, productDetails:[{productName, quantity, rate, total}]}` → `data.redirectionUrl`
- Return: `?status&message&transactionId&invoiceNo`
- Verify: `POST /api/EPayment/CheckStatus` with `{merchantId, invoiceNo, transactionId, password}`; `status == "00"` = success

## Moru (official docs)

Docs: https://moru-digital-wallet.github.io/moru-payment-gateway-docs/
- **Web**: load `https://web.payment-gateway.moru.com.np/sdk/build/moru-checkout.js` or npm `@moruwallet/moru-web-sdk`, then `new MoruCheckout({ access_key, transaction_id, additional_fields, callback_handler: { onSuccess, onError, onClose } }).open({ amount })`. `onSuccess` gives `{amount, moru_txn_identifier, status:"success"}` and is **not proof**.
- **Verify (mandatory, server)**: `POST https://test.moru-gateway.pnpl.com.np/gateway/v1/check-payment` (live `https://api.payment-gateway.moru.com.np/gateway/v1/check-payment`) with `{secret_key, txn_identifier}` → `data{amount, complete, state:"Completed", moru_txn_identifier, external_txn_identifier}`. Paid = `state == "Completed"` and amount matches.
- Flutter: `moru_payment_gateway`. Amounts appear to be rupees.

## CellPay (mobile SDK only)

Android `github.com/cellcom-nepal/cellpay-sdk`, Flutter `cellpay_sdk`. Config: `Config(publicKey, merchantId, invoiceNumber, description, amount:Long, extras, listener)`. Success keys: `cellpay_ref_id, merchant_invoice_number, cellpay_transaction_status, merchant_amount`. There is **no public server-side verification API**; ask CellPay for one before going live, because an SDK callback alone is not proof.

## MoCo / Namaste Pay

Nothing public (no docs, SDKs or packages). Specs come from Namaste Pay's business team.

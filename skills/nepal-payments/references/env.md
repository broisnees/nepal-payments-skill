# Environment variables

`paymentsConfigFromEnv()` (TS) and `config_from_env()` (Python) enable a provider when its required variables are set. `*_ENV` is `sandbox` (default) or `production` (`live` also accepted).

| Provider | Required | Optional |
|---|---|---|
| eSewa | `ESEWA_PRODUCT_CODE`, `ESEWA_SECRET_KEY` | `ESEWA_ENV`, `ESEWA_INTENT_PRODUCT_CODE`, `ESEWA_INTENT_ACCESS_KEY`, `ESEWA_INTENT_BASE_URL` (production Intent host from eSewa) |
| Khalti | `KHALTI_SECRET_KEY`, `KHALTI_WEBSITE_URL` | `KHALTI_ENV`; `KHALTI_PUBLIC_KEY` for mobile SDK builds only |
| Fonepay | `FONEPAY_MERCHANT_CODE`, `FONEPAY_SECRET_KEY` | `FONEPAY_ENV`, `FONEPAY_USERNAME`, `FONEPAY_PASSWORD` (needed for txnVerification + Dynamic QR) |
| connectIPS | `CONNECTIPS_MERCHANT_ID`, `CONNECTIPS_APP_ID`, `CONNECTIPS_PRIVATE_KEY_PEM` | `CONNECTIPS_ENV`, `CONNECTIPS_APP_NAME`, `CONNECTIPS_APP_PASSWORD` |
| CyberSource SA | `CYBERSOURCE_PROFILE_ID`, `CYBERSOURCE_ACCESS_KEY`, `CYBERSOURCE_SECRET_KEY` | `CYBERSOURCE_ENV`, `CYBERSOURCE_CURRENCY` (NPR) |
| CyberSource REST (SDK) | `CYBERSOURCE_MERCHANT_ID`, `CYBERSOURCE_KEY_ID`, `CYBERSOURCE_SHARED_SECRET` | |
| NPS | `NPS_MERCHANT_ID`, `NPS_SECRET_KEY` | `NPS_ENV`, `NPS_MERCHANT_NAME`, `NPS_API_USERNAME`, `NPS_API_PASSWORD` |
| IME Pay | `IMEPAY_MERCHANT_CODE`, `IMEPAY_USERNAME` | `IMEPAY_ENV`, `IMEPAY_PASSWORD`, `IMEPAY_MODULE` |

`.env.example` (sandbox values that are public in provider docs; everything else blank):
```dotenv
APP_PUBLIC_URL=https://shop.example.com     # used to build return URLs; must be reachable by the payer's browser

ESEWA_ENV=sandbox
ESEWA_PRODUCT_CODE=EPAYTEST
ESEWA_SECRET_KEY=8gBm/:&EnhH.1/q
ESEWA_INTENT_PRODUCT_CODE=INTENT
ESEWA_INTENT_ACCESS_KEY=LB0REg8HUSw3MTYrI1s6JTE8Kyc6JyAqJiA3MQ==

KHALTI_ENV=sandbox
KHALTI_SECRET_KEY=                          # test-admin.khalti.com → Keys (login OTP 987654)
KHALTI_WEBSITE_URL=https://shop.example.com

FONEPAY_ENV=sandbox
FONEPAY_MERCHANT_CODE=NBQM                  # public dev sample from Fonepay's spec
FONEPAY_SECRET_KEY=a7e3512f5032480a83137793cb2021dc
FONEPAY_USERNAME=
FONEPAY_PASSWORD=

CONNECTIPS_ENV=sandbox
CONNECTIPS_MERCHANT_ID=
CONNECTIPS_APP_ID=
CONNECTIPS_APP_NAME=
CONNECTIPS_APP_PASSWORD=
CONNECTIPS_PRIVATE_KEY_PEM=                 # PKCS#8 PEM; "\n" escapes allowed

CYBERSOURCE_ENV=sandbox
CYBERSOURCE_PROFILE_ID=
CYBERSOURCE_ACCESS_KEY=
CYBERSOURCE_SECRET_KEY=

NPS_ENV=sandbox
NPS_MERCHANT_ID=
NPS_MERCHANT_NAME=
NPS_API_USERNAME=
NPS_API_PASSWORD=
NPS_SECRET_KEY=

IMEPAY_ENV=sandbox
IMEPAY_MERCHANT_CODE=
IMEPAY_USERNAME=
IMEPAY_PASSWORD=
IMEPAY_MODULE=
```

Rules:
- Commit `.env.example` only. Production secrets live in the platform's secret store (Vercel/Render/Fly env, `wrangler secret put`, AWS/GCP Secret Manager, Kubernetes secrets).
- Never expose these to the client. In Next.js, no `NEXT_PUBLIC_` prefix; in Vite, no `VITE_` prefix; in Expo, no `EXPO_PUBLIC_` prefix. The only value a client may hold is the Khalti **public** key for its mobile SDK.
- Fail fast at boot when a provider is half-configured in production (e.g. `*_ENV=production` with a sandbox product code like `EPAYTEST`).

export const REPO = "https://github.com/broisnees/nepal-payments-skill";
export const INSTALL = "npx skills add broisnees/nepal-payments-skill";
export const SITE_NAME = "Nepal Payments";
/** The sister product: payment observability. Its name lives in platform/shared/src/brand.ts; mirror it here. */
export const PLATFORM_URL = "https://discerns.app";
export const PLATFORM_NAME = "discerns";
/** The third product: live status of every Nepali gateway, with a public API. */
export const STATUS_URL = "https://status.discerns.app";
/** Counts read from platform/shared/src (EVENT_TYPES in events.ts, RuleType and ChannelType in api.ts). */
export const platformFacts = [
  { value: "11", label: "event types, from payment.started to payment.refunded" },
  { value: "11", label: "alert rules, including amount_mismatch and double_fulfilment" },
  { value: "4", label: "alert channels: email, Slack, Discord and signed webhooks" },
] as const;
export const AGENT_PROMPT =
  "Use the nepal-payments skill to add eSewa and Khalti checkout to this app: server-side signing, server-to-server verification with decideTransition, a payment_attempts table, the return route, reconciliation and tests.";

export const providers = [
  { name: "eSewa", slug: "esewa", checkout: "form", blog: "esewa-payment-gateway-integration", flows: "ePay v2 web checkout, Intent app-to-app", kind: "Wallet" },
  { name: "Khalti", slug: "khalti", checkout: "redirect", blog: "khalti-payment-gateway-integration", flows: "KPG-2 web checkout, refunds", kind: "Wallet" },
  { name: "Fonepay", slug: "fonepay", checkout: "redirect", blog: "fonepay-payment-gateway-integration", flows: "Web redirect, Dynamic QR over WebSocket", kind: "Bank QR" },
  { name: "connectIPS", slug: "connectips", checkout: "form", blog: "connectips-payment-gateway-integration", flows: "Direct bank debit, RSA-signed with your .pfx", kind: "Bank" },
  { name: "CyberSource", slug: "cybersource", checkout: "form", blog: "cybersource-payment-gateway-nepal", flows: "Secure Acceptance cards via Nepali banks", kind: "Cards" },
  { name: "NPS OnePG", slug: "nps", checkout: "form", blog: "nps-onepg-payment-gateway-integration", flows: "About 29 banks, wallets and cards in one API", kind: "Aggregator" },
  { name: "IME Pay", slug: "imepay", checkout: "redirect", blog: "imepay-payment-gateway-integration", flows: "Wallet checkout for existing merchants", kind: "Wallet" },
  { name: "NEPALPAY QR", slug: "nepalpay", checkout: "qr", blog: "nepalpay-qr-payment-integration", flows: "NCHL dynamic QR any bank app can scan", kind: "Bank QR" },
  { name: "Hamro Pay", slug: "hamropay", checkout: "form", blog: "hamropay-payment-gateway-integration", flows: "Hamro Patro wallet checkout, signed webhook", kind: "Wallet" },
  { name: "GetPay", slug: "getpay", checkout: "sdk", blog: "getpay-card-payment-integration", flows: "NCHL hosted card checkout for Nepali banks", kind: "Cards" },
] as const;

/**
 * The four shapes initiate() returns (InitiateResult in scripts/ts/src/core/types.ts). `checkout` on each provider is the
 * kind its adapter's initiate() returns.
 */
export const checkoutKinds = [
  { kind: "redirect", title: "Redirect", body: "Send the browser, WebView or Custom Tab to the gateway's URL. Persist providerRef when one comes back." },
  { kind: "form", title: "Signed form", body: "Render an auto-submitting form that POSTs the signed fields. renderAutoSubmitForm() builds it on the server." },
  { kind: "qr", title: "Dynamic QR", body: "Render qrString as a QR the payer scans from their own bank app, then call verify() until it settles." },
  { kind: "sdk", title: "Hosted SDK", body: "Load the gateway's script in the browser and start its checkout with the options the server returns." },
] as const;

export const languages = [
  { name: "TypeScript", runtime: "Node 22.18+, Bun, Deno, Workers, Next.js edge", deps: "Zero dependencies", tests: 73, path: "scripts/ts/src/", test: "npm test" },
  { name: "Python", runtime: "Python 3.10+", deps: "Stdlib (cryptography for connectIPS)", tests: 53, path: "scripts/python/nepal_payments/", test: "python -m unittest discover -s tests" },
  { name: "Java", runtime: "JDK 17+ (Spring Boot, Quarkus)", deps: "No dependencies", tests: 132, path: "scripts/java/src/main/java/np/payments/", test: "./gradlew test" },
  { name: "Kotlin", runtime: "JDK 17+ (Ktor, Spring), suspend API", deps: "kotlin-stdlib only", tests: 106, path: "scripts/kotlin/src/main/kotlin/np/payments/", test: "./gradlew test" },
  { name: "PHP", runtime: "PHP 8.1+ (Laravel, Symfony)", deps: "ext-curl and ext-openssl, no Composer deps", tests: 90, path: "scripts/php/src/", test: "vendor/bin/phpunit" },
  { name: "Go", runtime: "Go 1.22+", deps: "Stdlib only", tests: 87, path: "scripts/go/payments/", test: "go test -race ./..." },
] as const;

export const totalTests = languages.reduce((n, l) => n + l.tests, 0);

/** How each adapter authenticates or signs, read from scripts/ts/src. */
export const signing = [
  { provider: "eSewa", scheme: "HMAC-SHA256", encoding: "base64" },
  { provider: "Khalti", scheme: "Key header", encoding: "secret key" },
  { provider: "Fonepay", scheme: "HMAC-SHA512", encoding: "hex" },
  { provider: "connectIPS", scheme: "RSA-SHA256", encoding: "base64" },
  { provider: "CyberSource", scheme: "HMAC-SHA256", encoding: "base64" },
  { provider: "NPS OnePG", scheme: "HMAC-SHA512", encoding: "hex" },
  { provider: "IME Pay", scheme: "Basic auth", encoding: "base64" },
  { provider: "NEPALPAY QR", scheme: "RSA-SHA256", encoding: "base64" },
  { provider: "Hamro Pay", scheme: "HMAC-SHA512", encoding: "base64" },
  { provider: "GetPay", scheme: "SHA-256 (return token)", encoding: "base64" },
] as const;

/** Cases from the decideTransition tests (stored amount Rs 10). */
export const transitions = [
  { prev: "initiated", says: "paid Rs 10", next: "paid", tone: "ok" },
  { prev: "pending", says: "paid Rs 0.10", next: "unknown (review)", tone: "warn" },
  { prev: "initiated", says: "not_found 5m", next: "no write", tone: "muted" },
  { prev: "initiated", says: "not_found 2h", next: "expired", tone: "muted" },
  { prev: "expired", says: "paid Rs 10", next: "paid (late)", tone: "ok" },
  { prev: "paid", says: "failed", next: "no write", tone: "muted" },
] as const;

export const frameworks = ["Express", "Hono", "Next.js", "FastAPI", "Django", "Laravel", "Spring Boot", "Ktor"] as const;
export const agents = ["Claude Code", "Codex", "Cursor", "Gemini CLI", "GitHub Copilot"] as const;

/** The six steps SKILL.md gives the agent. */
export const workflow = ["Picks providers", "Detects your stack", "Copies the adapters", "Adds routes and the attempts table", "Adds reconciliation", "Runs the tests"] as const;

export const guarantees = [
  { title: "Secrets stay on the server", body: "Signing keys never reach the browser or the app. Clients only ever send an order id." },
  { title: "A redirect is not a payment", body: "Return URLs and callbacks are hints. The provider's status API decides whether money moved." },
  { title: "Your numbers, not theirs", body: "Verification uses the amount and ids stored in your database, never the values in the callback." },
  { title: "One state machine", body: "decideTransition handles early return hits, late payments, missing or mismatched amounts and duplicates." },
  { title: "Reconciliation built in", body: "A scheduled job settles payments where the customer paid and closed the tab." },
  { title: "Vectors before code", body: "Every adapter is tested against the provider's own signature test vectors in all six languages." },
] as const;

export const prompts = [
  "Add eSewa and Khalti payments to my Hono API on Cloudflare Workers with D1.",
  "Integrate Fonepay dynamic QR for our restaurant POS.",
  "Our eSewa callback says ES104 invalid signature. Fix it.",
  "Add Khalti checkout to the Flutter app; the backend is FastAPI.",
  "Set up connectIPS with our .pfx and a reconciliation job.",
] as const;

export const snippets = [
  {
    lang: "ts",
    label: "TypeScript",
    code: `import { createPayments, paymentsConfigFromEnv, newOrderId } from "./payments/index.ts";

const payments = createPayments(paymentsConfigFromEnv());
const attemptId = newOrderId(); // store it on a new payment_attempts row
const init = await payments.get("khalti").initiate({
  orderId: attemptId, amountPaisa: 150000, description: "Order #42",
  returnUrl: "https://shop.example.com/payments/khalti/return/" + attemptId,
});

// later, in the return handler: verify with values from YOUR database
const result = await payments.get("khalti").verify({
  orderId: attempt.id, amountPaisa: attempt.amountPaisa, providerRef: attempt.providerRef,
});`,
  },
  {
    lang: "python",
    label: "Python",
    code: `from nepal_payments import create_payments, config_from_env, new_order_id

payments = create_payments(config_from_env())
attempt_id = new_order_id()  # store it on a new payment_attempts row
init = payments["khalti"].initiate(
    order_id=attempt_id, amount_paisa=150000, description="Order #42",
    return_url=f"https://shop.example.com/payments/khalti/return/{attempt_id}",
)

# later, in the return handler: verify with values from YOUR database
result = payments["khalti"].verify(attempt.id, attempt.amount_paisa, provider_ref=attempt.provider_ref)`,
  },
  {
    lang: "go",
    label: "Go",
    code: `p, err := payments.New(payments.ConfigFromEnv())
if err != nil {
	log.Fatal(err)
}
attemptID := payments.NewOrderID() // store it on a new payment_attempts row
init, err := p.Khalti.Initiate(ctx, payments.InitiateInput{
	OrderID: attemptID, AmountPaisa: 150000, Description: "Order #42",
	ReturnURL: "https://shop.example.com/payments/khalti/return/" + attemptID,
})

// later, in the return handler: verify with values from YOUR database
res, err := p.Khalti.Verify(ctx, payments.VerifyInput{
	OrderID: a.ID, AmountPaisa: a.AmountPaisa, ProviderRef: a.ProviderRef,
})`,
  },
  {
    lang: "java",
    label: "Java",
    code: `Payments payments = Payments.create(Payments.configFromEnv());
String attemptId = Payments.newOrderId(); // store it on a new payment_attempts row
InitiateResult init = payments.khalti().initiate(InitiateInput.of(
    attemptId, 150_000, "Order #42", "https://shop.example.com/payments/khalti/return/" + attemptId));

// later, in the return handler: verify with values from YOUR database
VerifyResult result = payments.khalti().verify(
    new VerifyInput(attempt.id(), attempt.amountPaisa(), attempt.providerRef(), null));`,
  },
  {
    lang: "kotlin",
    label: "Kotlin",
    code: `val payments = Payments.create(paymentsConfigFromEnv())
val attemptId = newOrderId() // store it on a new payment_attempts row
val init = payments.khalti.initiate(InitiateInput(
    orderId = attemptId, amountPaisa = 150_000, description = "Order #42",
    returnUrl = "https://shop.example.com/payments/khalti/return/" + attemptId,
))

// later, in the return handler (suspend): verify with values from YOUR database
val result = payments.khalti.verify(VerifyInput(attempt.id, attempt.amountPaisa, providerRef = attempt.providerRef))`,
  },
  {
    lang: "php",
    label: "PHP",
    code: `use NepalPayments\\{InitiateInput, Payments, VerifyInput};

$payments = Payments::create(Payments::configFromEnv());
$attemptId = Payments::newOrderId(); // store it on a new payment_attempts row
$init = $payments->khalti()->initiate(new InitiateInput(
    orderId: $attemptId, amountPaisa: 150000, description: 'Order #42',
    returnUrl: 'https://shop.example.com/payments/khalti/return/' . $attemptId,
));

// later, in the return handler: verify with values from YOUR database
$result = $payments->khalti()->verify(new VerifyInput($attempt->id, $attempt->amountPaisa, $attempt->providerRef));`,
  },
] as const;

export const faqs = [
  {
    q: "What is an Agent Skill?",
    a: "A folder of instructions, references and scripts that a coding agent loads when a task matches. This one teaches the agent how Nepali payment gateways actually behave, so it follows a tested recipe instead of guessing signatures and callback formats.",
  },
  {
    q: "Which agents does it work with?",
    a: "Any agent that supports the Agent Skills format: Claude Code, Codex, Cursor, Gemini CLI, GitHub Copilot and others. Claude Code can also install it from the plugin marketplace.",
  },
  {
    q: "Can I use the adapters without an agent?",
    a: "Yes. Copy the folder for your language into your server code. The adapters have no runtime dependencies beyond each language's standard library (connectIPS in Python also needs the cryptography package).",
  },
  {
    q: "Which provider should I start with?",
    a: "eSewa and Khalti cover the largest wallets. Add NPS or Fonepay to reach most banks through one integration, NEPALPAY QR for a QR any NEPALPAY QR enabled bank app can scan, connectIPS for direct bank debit, and Hamro Pay for Hamro Patro's wallet users. For cards, use CyberSource or GetPay, whichever your acquiring bank offers.",
  },
  {
    q: "Is it affiliated with eSewa, Khalti or the other providers?",
    a: "No. It is an independent open-source project under the MIT license. The sandbox credentials it uses are the public ones from each provider's documentation.",
  },
  {
    q: "Does it handle mobile apps?",
    a: "Yes. The mobile guide covers Flutter, React Native, Expo, Android and iOS, including eSewa Intent app-to-app payments, with all signing kept on your server.",
  },
] as const;

/**
 * Official gateway logos in public/logos (sources in public/logos/README.md). `dark` is the gateway's own version
 * for dark backgrounds; logos without one sit on a light chip in dark mode. `ratio` is width / height;
 * `scale` evens out optical size, since tall or detailed marks look smaller than wide wordmarks at the same height.
 */
export const gatewayLogos: Record<string, { light: string; dark?: string; ratio: number; chip?: boolean; scale?: number }> = {
  esewa: { light: "/logos/esewa.svg", dark: "/logos/esewa-white.svg", ratio: 324.77 / 89.38 },
  khalti: { light: "/logos/khalti.svg", ratio: 366.28 / 150.29 },
  fonepay: { light: "/logos/fonepay.png", dark: "/logos/fonepay-white.png", ratio: 1008 / 308 },
  connectips: { light: "/logos/connectips.png", ratio: 100 / 65, chip: true, scale: 1.7 },
  cybersource: { light: "/logos/cybersource.png", ratio: 177 / 44, chip: true, scale: 1.2 },
  nps: { light: "/logos/nps.png", dark: "/logos/nps-white.png", ratio: 1200 / 527 },
  imepay: { light: "/logos/khalti-by-ime.png", ratio: 1028 / 569, chip: true, scale: 1.45 },
  nepalpay: { light: "/logos/nepalpay.png", ratio: 169 / 92, chip: true, scale: 1.5 },
  hamropay: { light: "/logos/hamropay.svg", ratio: 1, scale: 1.4 },
  getpay: { light: "/logos/getpay.png", dark: "/logos/getpay-white.png", ratio: 240 / 62 },
};

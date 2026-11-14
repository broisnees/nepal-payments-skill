# Mobile integration (Flutter, React Native, Expo, Android, iOS)

## Contents
1. The rule
2. Choosing an approach
3. Backend endpoints the app needs
4. WebView pattern (works for every provider)
5. System browser + deep link pattern
6. Native SDKs (eSewa, Khalti)
7. After returning: confirming status in the app
8. Gotchas

## 1. The rule

The app holds **no secrets** and **never decides** that a payment succeeded. It asks your backend to start a payment, shows the provider's UI, then asks your backend for the verified result. The secret key, merchant secret, `.pfx` or CyberSource secret would be extracted from an APK/IPA within minutes.

## 2. Choosing an approach

| Approach | Use for | Pros | Cons |
|---|---|---|---|
| **Native SDK** | eSewa, Khalti | Best UX, app-to-app switching to the wallet | SDK quirks; still must verify on server |
| **WebView** (in-app) | Fonepay, connectIPS, NPS, IME Pay, Hamro Pay, CyberSource, GetPay, or any provider without an SDK | One code path for every provider; you control the return | Some bank 3DS / wallet deep links need extra handling (§8) |
| **System browser / Custom Tabs / ASWebAuthenticationSession** + deep link | Card payments (3DS: CyberSource, GetPay), or when WebViews are blocked or unreliable |
| **Show a QR, poll the server** | NEPALPAY QR (and Fonepay Dynamic QR) on a second screen: POS, kiosk, desktop checkout | No redirect to handle at all | The payer needs another device to scan it; on a phone-only checkout offer a wallet or bank provider instead | Real browser: 3DS, password managers and wallet apps all work | Needs universal/app links configured |

Pragmatic default: native SDK for Khalti/eSewa if you want app switching, and the **WebView pattern for everything else** using the same backend endpoints.

## 3. Backend endpoints the app needs

```
POST /payments                 {orderId, provider}  -> {attemptId, startUrl, providerRef?, url?}
GET  /payments/:attemptId/start                     -> 302 to provider, OR auto-submit HTML form (form-POST providers)
GET|POST /payments/:provider/return                 -> verifies server-side, then 302 to
                                                       https://YOUR_DOMAIN/payments/done?attempt=<id>&status=<status>
GET  /payments/:attemptId                           -> {status, amountPaisa}   (app polls this)
POST /payments/:attemptId/verify                    -> re-runs adapter.verify() and the conditional update; returns status
```

`/start` is what makes the WebView approach universal: eSewa, connectIPS, Fonepay and CyberSource need a form POST or a signed redirect, so the server renders `renderAutoSubmitForm()` (from `core/html.ts`) or issues a 302, and the app just loads one URL. The secret never leaves the server.

The `/payments/done` URL is the app's **finish line**: the WebView intercepts it, or the OS opens the app through an app link.

## 4. WebView pattern

### React Native (`react-native-webview` 14.x)
```tsx
import { WebView } from "react-native-webview";

const DONE = "https://api.example.com/payments/done";

export function PaymentScreen({ route, navigation }) {
  const { startUrl, attemptId } = route.params; // from POST /payments
  const finished = React.useRef(false);

  const finish = async () => {
    if (finished.current) return;
    finished.current = true;
    const status = await confirmPayment(attemptId); // §7 — asks YOUR backend
    navigation.replace("PaymentResult", { status });
  };

  return (
    <WebView
      source={{ uri: startUrl }}
      originWhitelist={["https://*", "esewa://*", "khalti://*"]}
      onShouldStartLoadWithRequest={(req) => {
        if (req.url.startsWith(DONE)) { finish(); return false; }
        // Let wallet app deep links leave the WebView (see §8)
        if (!req.url.startsWith("http")) { Linking.openURL(req.url).catch(() => {}); return false; }
        return true;
      }}
      onNavigationStateChange={(s) => { if (s.url.startsWith(DONE)) finish(); }} // Android fallback for redirects
      startInLoadingState
      javaScriptEnabled
      domStorageEnabled
    />
  );
}
```
Handle the hardware back button / close icon by calling `finish()` too: the user may have paid and then backed out, so always ask the server.

### Flutter (`webview_flutter` 4.x)
```dart
import 'package:webview_flutter/webview_flutter.dart';
import 'package:url_launcher/url_launcher.dart';

class PaymentPage extends StatefulWidget {
  const PaymentPage({super.key, required this.startUrl, required this.attemptId});
  final String startUrl, attemptId;
  @override State<PaymentPage> createState() => _PaymentPageState();
}

class _PaymentPageState extends State<PaymentPage> {
  static const done = 'https://api.example.com/payments/done';
  late final WebViewController _c;
  bool _finished = false;

  @override
  void initState() {
    super.initState();
    _c = WebViewController()
      ..setJavaScriptMode(JavaScriptMode.unrestricted)
      ..setNavigationDelegate(NavigationDelegate(
        onNavigationRequest: (req) {
          if (req.url.startsWith(done)) { _finish(); return NavigationDecision.prevent; }
          if (!req.url.startsWith('http')) {             // wallet app deep link
            launchUrl(Uri.parse(req.url), mode: LaunchMode.externalApplication);
            return NavigationDecision.prevent;
          }
          return NavigationDecision.navigate;
        },
        onUrlChange: (c) { if (c.url?.startsWith(done) ?? false) _finish(); },
      ))
      ..loadRequest(Uri.parse(widget.startUrl));
  }

  Future<void> _finish() async {
    if (_finished) return;
    _finished = true;
    final status = await confirmPayment(widget.attemptId); // §7
    if (mounted) Navigator.of(context).pop(status);
  }

  @override
  Widget build(BuildContext context) => PopScope(
        canPop: false,
        onPopInvokedWithResult: (didPop, _) { if (!didPop) _finish(); },
        child: Scaffold(appBar: AppBar(title: const Text('Payment')), body: WebViewWidget(controller: _c)),
      );
}
```
`flutter_inappwebview` (6.x) works the same way via `shouldOverrideUrlLoading` if you need more control.

### Android (Kotlin, `WebView`)
```kotlin
webView.settings.javaScriptEnabled = true
webView.settings.domStorageEnabled = true
webView.webViewClient = object : WebViewClient() {
    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
        val url = request.url.toString()
        return when {
            url.startsWith(DONE_URL) -> { finishPayment(); true }
            !url.startsWith("http") -> {                       // wallet deep link
                runCatching { startActivity(Intent(Intent.ACTION_VIEW, request.url)) }; true
            }
            else -> false
        }
    }
}
webView.loadUrl(startUrl)
```

### iOS (Swift, `WKWebView`)
```swift
func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
             decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
    guard let url = action.request.url else { return decisionHandler(.allow) }
    if url.absoluteString.hasPrefix(doneURL) { finishPayment(); return decisionHandler(.cancel) }
    if !["http", "https"].contains(url.scheme ?? "") {           // wallet deep link
        UIApplication.shared.open(url); return decisionHandler(.cancel)
    }
    decisionHandler(.allow)
}
```

## 5. System browser + deep link pattern

Use this for card/3DS flows or when a provider page misbehaves in a WebView.

**Expo / React Native**: `expo-web-browser` opens an auth session that closes automatically when the browser hits your redirect:
```ts
import * as WebBrowser from "expo-web-browser";
const result = await WebBrowser.openAuthSessionAsync(startUrl, "myapp://payments/done");
// result.type: "success" | "cancel" | "dismiss": in EVERY case, ask the server.
const status = await confirmPayment(attemptId);
```
Here the backend return handler finishes with a 302 to `myapp://payments/done?attempt=…` instead of the https done URL. Pass a `client=app` flag when creating the attempt so the server knows which finish URL to use.

**Flutter**: `url_launcher` with `LaunchMode.externalApplication` (or `inAppBrowserView` for Custom Tabs / SFSafariViewController), plus `app_links` (7.x) to receive `https://YOUR_DOMAIN/payments/done` as a universal/app link and route it to the result screen.

**Native**: Android Custom Tabs (`androidx.browser`) plus an intent filter with `android:autoVerify="true"` for app links. iOS `ASWebAuthenticationSession(url:callbackURLScheme:)`.

## 6. Native SDKs

- **Khalti**: Flutter `khalti_checkout_flutter`, Android `com.khalti:checkout-android`, iOS `KhaltiCheckout`. Full code in `khalti.md` §8.
- **eSewa**: see `esewa.md` (mobile SDK section).

In both cases the backend creates the payment first, and the SDK success callback triggers `POST /payments/:attemptId/verify`. The UI shows what the server returns.

## 7. After returning: confirming status in the app

```ts
async function confirmPayment(attemptId: string): Promise<string> {
  // The return handler usually verified already; /verify makes it deterministic.
  let { status } = await api.post(`/payments/${attemptId}/verify`);
  for (let i = 0, delay = 1000; status === "pending" && i < 6; i++, delay *= 2) {
    await sleep(delay);                              // 1s, 2s, 4s ... ~1 min total
    ({ status } = await api.get(`/payments/${attemptId}`));
  }
  return status; // 'paid' -> success screen; 'pending' -> "We'll notify you"; else -> retry option
}
```
- On app start / resume, re-check any attempt the app left in `initiated`/`pending` (the OS may have killed the app mid-payment). The server's reconciliation job settles it anyway; the app just needs to display it.
- Push a notification when reconciliation settles a pending payment.
- "Retry" creates a **new attempt** (new provider order id). Never resubmit the old one.

## 8. Gotchas

- **Wallet app switching from a WebView**: eSewa/Khalti pages may try to open `esewa://`, `khalti://` or `intent://` URLs. A WebView can't load these, so hand them to the OS (shown above). On Android 11+, declare `<queries>` for those schemes/packages in `AndroidManifest.xml` or `canLaunch` returns false. On iOS, add the schemes to `LSApplicationQueriesSchemes`.
- **Android `intent://` URLs**: parse with `Intent.parseUri(url, Intent.URI_INTENT_SCHEME)`. If the app isn't installed, open the URL in `browser_fallback_url`.
- **Form POST providers**: never build the form in the app (that requires the secret). Load your `/start` URL.
- **Cookies / third-party storage**: 3DS ACS pages sometimes need third-party cookies. On Android enable `CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true)`. If problems persist, use the system-browser pattern.
- **Back button / close**: always confirm with the server when the user leaves the payment screen. "Closed" doesn't mean "not paid".
- **Don't hardcode sandbox in release builds.** The backend decides the environment; the app only needs the Khalti public key for the SDK, injected per flavor.
- **GetPay in a WebView: don't stop at GetPay's success URL.** For cards without 3-D Secure the return token sits in the URL `#hash`, which only the page's JavaScript can read. Let `getpay.returnPage()` load and forward the token to your return route; close the WebView only on your own receipt URL, like every other provider. GetPay's card iframe also refuses origins not registered with NCHL, so load your `/start` URL from your registered domain, never a local file or `localhost`.
- **NEPALPAY QR**: get `qrImage`/`qrString` from your backend (never generate the QR in the app; the token needs the `.pfx`), show it, and poll `GET /payments/:attemptId` every 3-5 s. There is no return URL to intercept.
- **Hamro Pay** is a form provider: load your `/start` URL in the WebView exactly like eSewa.
- **Return URL must be reachable from the phone**: use your public HTTPS domain or a tunnel (ngrok / cloudflared) in development, never `localhost`.

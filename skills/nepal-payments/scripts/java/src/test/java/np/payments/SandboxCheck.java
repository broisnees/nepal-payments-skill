package np.payments;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.concurrent.Callable;

/**
 * Live sandbox smoke test (mirrors scripts/ts/test/sandbox.ts). Hits real provider sandboxes; no payment is completed.
 * <pre>
 *   ./gradlew sandbox                          # eSewa (public creds) + Fonepay dev sample
 *   KHALTI_SECRET_KEY=... ./gradlew sandbox    # + Khalti (key from test-admin.khalti.com)
 * </pre>
 * Exits 1 if any check fails. Not a JUnit test: never runs as part of {@code ./gradlew test}.
 */
public final class SandboxCheck {
    private static int failed;
    private static final HttpClient RAW = HttpClient.newBuilder()
            .version(HttpClient.Version.HTTP_1_1)
            .followRedirects(HttpClient.Redirect.NEVER) // fetch(..., { redirect: "manual" })
            .connectTimeout(Duration.ofSeconds(15))
            .build();

    private SandboxCheck() {}

    public static void main(String[] args) {
        System.out.println("eSewa (rc sandbox)");
        Esewa e = new Esewa(Esewa.Config.sandbox());
        String id = Payments.newOrderId();
        check("signed form accepted (302 to login)", () -> {
            InitiateResult.Form f = (InitiateResult.Form) e.initiate(
                    InitiateInput.of(id, 11050, "smoke", "https://example.com/payments/esewa/return/" + id), new Esewa.Extras(1000, 0, 0));
            HttpResponse<String> r = RAW.send(HttpRequest.newBuilder(URI.create(f.action()))
                    .timeout(Duration.ofSeconds(20))
                    .header("Content-Type", "application/x-www-form-urlencoded")
                    .POST(HttpRequest.BodyPublishers.ofString(Codec.formEncode(f.fields())))
                    .build(), HttpResponse.BodyHandlers.ofString());
            String loc = r.headers().firstValue("location").orElse("");
            require(r.statusCode() == 302 && loc.contains("bookingId="), "got " + r.statusCode() + " " + loc + " " + Js.slice(r.body(), 200));
            return loc;
        });
        check("status API: unpaid -> pending", () -> {
            VerifyResult v = e.verify(VerifyInput.of(id, 11050));
            require(v.status() == PaymentStatus.PENDING, "got " + v.status());
            return v.status().wire();
        });
        check("status API: wrong total -> not_found", () -> {
            VerifyResult v = e.verify(VerifyInput.of(id, 99900));
            require(v.status() == PaymentStatus.NOT_FOUND, "got " + v.status());
            return v.status().wire();
        });
        check("intent book -> status -> cancel", () -> {
            String oid = Payments.newOrderId("I");
            Esewa.IntentBooking b = e.intentBook(oid, 10000, "https://example.com/cb", "https://example.com/done");
            VerifyResult s = e.intentVerify(oid, b.providerRef());
            require(s.status() == PaymentStatus.PENDING, "status " + s.status());
            Object c = e.intentCancel(b.providerRef());
            require("CANCELED".equals(Js.get(Js.get(c, "data"), "status")), "cancel " + Json.write(c));
            return b.deeplink() + " BOOKED -> CANCELED";
        });

        System.out.println("Fonepay (dev gateway, public sample merchant NBQM)");
        Fonepay fp = new Fonepay(Fonepay.Config.of(Environment.SANDBOX, "NBQM", "a7e3512f5032480a83137793cb2021dc"));
        check("signed redirect accepted (303 to payment page)", () -> {
            String url = ((InitiateResult.Redirect) fp.initiate(
                    InitiateInput.of(Payments.newOrderId(), 1050, "smoke", "https://example.com/payments/fonepay/return"))).url();
            HttpResponse<String> r = get(url);
            String loc = r.headers().firstValue("location").orElse("");
            require(r.statusCode() >= 300 && r.statusCode() < 400 && loc.contains("fonepay.com"), "got " + r.statusCode() + " " + loc + " " + Js.slice(r.body(), 200));
            return r.statusCode() + " " + loc;
        });
        check("bad DV rejected (4xx, not a redirect)", () -> {
            String url = ((InitiateResult.Redirect) fp.initiate(
                    InitiateInput.of(Payments.newOrderId(), 1050, "smoke", "https://example.com/payments/fonepay/return"))).url();
            String bad = url.replaceFirst("DV=([0-9A-F])", "DV=" + (url.matches(".*DV=0.*") ? "1" : "0"));
            HttpResponse<String> r = get(bad);
            require(r.statusCode() >= 400 && r.statusCode() < 500, "got " + r.statusCode() + " " + Js.slice(r.body(), 200));
            return r.statusCode() + " " + Js.slice(r.body(), 120);
        });

        String khaltiKey = System.getenv("KHALTI_SECRET_KEY");
        if (khaltiKey != null && !khaltiKey.isEmpty()) {
            System.out.println("Khalti (dev.khalti.com)");
            Khalti k = new Khalti(Khalti.Config.of(Environment.SANDBOX, khaltiKey, "https://example.com"));
            check("initiate -> lookup (Initiated)", () -> {
                String oid = Payments.newOrderId();
                InitiateResult r = k.initiate(InitiateInput.of(oid, 1000, "smoke", "https://example.com/payments/khalti/return"));
                VerifyResult v = k.verify(VerifyInput.of(oid, 1000).withProviderRef(r.providerRef()));
                require(v.status() == PaymentStatus.PENDING, "got " + v.status());
                return ((InitiateResult.Redirect) r).url() + " -> " + Js.get(v.raw(), "status");
            });
        } else {
            System.out.println("Khalti: skipped (set KHALTI_SECRET_KEY from https://test-admin.khalti.com)");
        }

        System.out.println(failed > 0 ? "\n" + failed + " check(s) failed" : "\nall sandbox checks passed");
        System.exit(failed > 0 ? 1 : 0);
    }

    private static HttpResponse<String> get(String url) throws Exception {
        return RAW.send(HttpRequest.newBuilder(URI.create(url)).timeout(Duration.ofSeconds(20)).GET().build(), HttpResponse.BodyHandlers.ofString());
    }

    private static void check(String name, Callable<String> fn) {
        try {
            System.out.println("  ok   " + name + ": " + fn.call());
        } catch (Exception ex) {
            failed++;
            String code = ex instanceof PaymentException pe ? " [" + pe.code() + "]" : "";
            System.out.println("  FAIL " + name + ": " + ex.getMessage() + code);
        }
    }

    private static void require(boolean cond, String msg) {
        if (!cond) throw new IllegalStateException(msg);
    }
}

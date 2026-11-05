// Shared app code for Java (Spring Boot): payment types with settle(), the demo store,
// the reconcile job and the routes. Gateway modules live next to this folder.
// Routes take the gateway descriptor g and work for every gateway.

export interface Block {
  file: string;
  lang: string;
  code: string;
}

export interface GatewayRef {
  id: string;
  name: string;
  ts: string;
  py: string;
  php: string;
  go: string;
  java: string;
  kotlin: string;
}

export type Framework = "spring";

export const types: Block[] = [
  {
    file: "src/main/java/payments/Start.java",
    lang: "java",
    code: `package payments;

import java.util.Map;

// Where to send the buyer: a redirect, or a form the browser auto-posts.
// providerRef: id the gateway hands back (Khalti pidx, ...), or null. The app stores it.
public sealed interface Start {
    String providerRef();

    record Redirect(String url, String providerRef) implements Start {}

    // enctype: null posts urlencoded (the browser default); NPS needs "multipart/form-data".
    record Form(String action, Map<String, String> fields, String providerRef, String enctype) implements Start {
        public Form(String action, Map<String, String> fields, String providerRef) {
            this(action, fields, providerRef, null);
        }
    }
}
`,
  },
  {
    file: "src/main/java/payments/Outcome.java",
    lang: "java",
    code: `package payments;

// status: paid, pending, failed, canceled, refunded or not_found
public record Outcome(String status, String providerRef) {}
`,
  },
  {
    file: "src/main/java/payments/Gateway.java",
    lang: "java",
    code: `package payments;

import java.util.Map;

public interface Gateway {
    Start startPayment(String attemptId, long amountPaisa, String returnUrl, String description);

    // params: the callback's query and body params, or an empty map from the reconcile job.
    Outcome confirmPayment(String attemptId, long amountPaisa, String providerRef, Map<String, String> params);
}
`,
  },
  {
    file: "src/main/java/payments/PaymentException.java",
    lang: "java",
    code: `package payments;

// Bad signature, amount mismatch or a refusal from the provider.
// Any other exception from a gateway is a network or provider outage.
public class PaymentException extends RuntimeException {
    public PaymentException(String message) {
        super(message);
    }
}
`,
  },
  {
    file: "src/main/java/payments/Payments.java",
    lang: "java",
    code: `package payments;

import java.util.List;

public final class Payments {
    private Payments() {}

    // Attempt states that can still change.
    public static final List<String> OPEN = List.of("initiated", "pending");

    // Apply a gateway answer to an attempt. Safe to call any number of times:
    // transition() only succeeds once, so fulfil() runs once per order.
    public static void settle(Store store, Store.Attempt attempt, Outcome outcome) {
        switch (outcome.status()) {
            case "paid", "failed", "canceled" -> {
                if (store.transition(attempt.id(), OPEN, outcome.status()) && outcome.status().equals("paid")) {
                    // Keep the gateway's transaction id (refunds, support). A ref saved at start
                    // (Khalti pidx, IME TokenId, NPS ProcessId) stays: confirm looks the payment up with it.
                    if (outcome.providerRef() != null && attempt.providerRef() == null) {
                        store.setProviderRef(attempt.id(), outcome.providerRef());
                    }
                    store.fulfil(attempt.orderId());
                }
            }
            case "pending" -> store.transition(attempt.id(), List.of("initiated"), "pending");
            default -> {} // not_found: leave it, the reconcile job expires it after an hour
        }
    }
}
`,
  },
];

export const store: Block[] = [
  {
    file: "src/main/java/payments/Store.java",
    lang: "java",
    code: `package payments;

import java.security.SecureRandom;
import java.time.Duration;
import java.time.Instant;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

// In-memory demo store: swap for your database (table in the article).
// Every method is synchronized, so transition() is an atomic compare-and-set.
public class Store {
    public record Order(String id, long amountPaisa) {}

    public record Attempt(String id, String orderId, long amountPaisa, String status, String providerRef, Instant createdAt) {
        Attempt withStatus(String s) { return new Attempt(id, orderId, amountPaisa, s, providerRef, createdAt); }
        Attempt withProviderRef(String r) { return new Attempt(id, orderId, amountPaisa, status, r, createdAt); }
    }

    private static final SecureRandom RANDOM = new SecureRandom();
    private final Map<String, Order> orders = Map.of("demo", new Order("demo", 10_000)); // Rs 100
    private final Map<String, Attempt> attempts = new LinkedHashMap<>(); // oldest first

    public synchronized Order getOrder(String id) {
        return orders.get(id);
    }

    public synchronized Attempt createAttempt(String orderId, long amountPaisa) {
        byte[] bytes = new byte[10];
        RANDOM.nextBytes(bytes);
        String id = HexFormat.of().formatHex(bytes); // 20 lowercase hex chars
        Attempt attempt = new Attempt(id, orderId, amountPaisa, "initiated", null, Instant.now());
        attempts.put(id, attempt);
        return attempt;
    }

    public synchronized Attempt getAttempt(String id) {
        return attempts.get(id);
    }

    public synchronized Attempt latestAttempt(String orderId) {
        Attempt latest = null;
        for (Attempt a : attempts.values()) {
            if (a.orderId().equals(orderId)) latest = a;
        }
        return latest;
    }

    public synchronized void setProviderRef(String id, String ref) {
        attempts.computeIfPresent(id, (k, a) -> a.withProviderRef(ref));
    }

    // Move to \`to\` only if the status is in \`from\`.
    // In SQL: UPDATE payment_attempts SET status = ? WHERE id = ? AND status IN (...)
    public synchronized boolean transition(String id, List<String> from, String to) {
        Attempt a = attempts.get(id);
        if (a == null || !from.contains(a.status())) return false;
        attempts.put(id, a.withStatus(to));
        return true;
    }

    public synchronized List<Attempt> openAttempts(Duration olderThan) {
        Instant cutoff = Instant.now().minus(olderThan);
        return attempts.values().stream()
                .filter(a -> Payments.OPEN.contains(a.status()) && !a.createdAt().isAfter(cutoff))
                .toList();
    }

    public void fulfil(String orderId) {
        System.out.println("order " + orderId + " paid, fulfil it here");
    }
}
`,
  },
];

export const reconcile: Block[] = [
  {
    file: "src/main/java/payments/Reconcile.java",
    lang: "java",
    code: `package payments;

import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;

public final class Reconcile {
    private Reconcile() {}

    // Settle attempts whose buyer never came back. Run it every minute.
    public static void run(Store store, Gateway gateway) {
        List<Store.Attempt> open = store.openAttempts(Duration.ofMinutes(2));
        for (Store.Attempt a : open) {
            if (a.createdAt().isBefore(Instant.now().minus(Duration.ofDays(3)))) {
                // Still open after 3 days: asking again rarely helps, so a person checks it
                // (gateway dashboard, bank statement) and closes it by hand.
                System.out.println("attempt " + a.id() + " still " + a.status() + " after 3 days, needs manual review");
                continue;
            }
            try {
                // Empty params: the gateway module asks the status API.
                Outcome outcome = gateway.confirmPayment(a.id(), a.amountPaisa(), a.providerRef(), Map.of());
                Payments.settle(store, a, outcome);
                if (outcome.status().equals("not_found") && a.createdAt().isBefore(Instant.now().minus(Duration.ofHours(1)))) {
                    store.transition(a.id(), Payments.OPEN, "expired");
                }
            } catch (Exception e) {
                // One bad attempt must not stop the rest.
                System.err.println("reconcile " + a.id() + ": " + e);
            }
        }
        System.out.println("reconcile: checked " + open.size() + " open attempts");
    }
}
`,
  },
  {
    file: "src/main/java/shop/ReconcileJob.java",
    lang: "java",
    code: `package shop;

import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import payments.Gateway;
import payments.Reconcile;
import payments.Store;

// Runs at startup, then one minute after each run finishes (@EnableScheduling is on ShopApplication).
@Component
class ReconcileJob {
    private final Store store;
    private final Gateway gateway;

    ReconcileJob(Store store, Gateway gateway) {
        this.store = store;
        this.gateway = gateway;
    }

    @Scheduled(fixedDelay = 60_000)
    void run() {
        Reconcile.run(store, gateway);
    }
}
`,
  },
];

export function routes(g: GatewayRef): Record<Framework, Block[]> {
  return {
    spring: [
      {
        file: "src/main/java/shop/ShopApplication.java",
        lang: "java",
        code: `package shop;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.context.annotation.Bean;
import org.springframework.scheduling.annotation.EnableScheduling;
import payments.${g.java};
import payments.Gateway;
import payments.Store;

@SpringBootApplication
@EnableScheduling
public class ShopApplication {
    public static void main(String[] args) {
        SpringApplication.run(ShopApplication.class, args);
    }

    // The payments package has no Spring annotations, so register its pieces here.
    @Bean
    Store store() {
        return new Store();
    }

    @Bean
    Gateway gateway() {
        return ${g.java}.fromEnv();
    }
}
`,
      },
      {
        file: "src/main/java/shop/PaymentController.java",
        lang: "java",
        code: `package shop;

import java.net.URI;
import java.util.Map;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestMethod;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.util.HtmlUtils;
import payments.Gateway;
import payments.Outcome;
import payments.PaymentException;
import payments.Payments;
import payments.Start;
import payments.Store;

@RestController
class PaymentController {
    private final Store store;
    private final Gateway gateway;
    private final String baseUrl;

    PaymentController(Store store, Gateway gateway, @Value("\${BASE_URL:http://localhost:8080}") String baseUrl) {
        this.store = store;
        this.gateway = gateway;
        this.baseUrl = baseUrl.replaceAll("/+$", "");
    }

    @GetMapping(value = "/", produces = MediaType.TEXT_HTML_VALUE)
    String home() {
        return "<h1>Order demo, Rs 100</h1><form method=\\"post\\" action=\\"/pay/demo\\"><button>Pay with ${g.name}</button></form>";
    }

    @PostMapping("/pay/{orderId}")
    ResponseEntity<String> pay(@PathVariable String orderId) {
        Store.Order order = store.getOrder(orderId);
        if (order == null) return ResponseEntity.notFound().build();
        Store.Attempt attempt = store.createAttempt(orderId, order.amountPaisa());

        // Path segment, never a query string: some gateways append their own query parameters to this URL.
        String returnUrl = baseUrl + "/pay/return/" + attempt.id();
        Start start = gateway.startPayment(attempt.id(), attempt.amountPaisa(), returnUrl, "Order " + orderId);
        if (start.providerRef() != null) store.setProviderRef(attempt.id(), start.providerRef());

        return switch (start) {
            case Start.Redirect r -> ResponseEntity.status(HttpStatus.SEE_OTHER).location(URI.create(r.url())).build();
            case Start.Form f -> ResponseEntity.ok().contentType(MediaType.TEXT_HTML).body(autoPostForm(f));
        };
    }

    // GET and POST: most gateways redirect back, CyberSource and IME Pay POST a form.
    // @RequestParam Map holds query and form body params together.
    @RequestMapping(value = "/pay/return/{attemptId}", method = {RequestMethod.GET, RequestMethod.POST})
    ResponseEntity<String> paymentReturn(@PathVariable String attemptId, @RequestParam Map<String, String> params) {
        Store.Attempt attempt = store.getAttempt(attemptId);
        if (attempt == null) return ResponseEntity.notFound().build();

        Outcome outcome;
        try {
            // Stored amount and providerRef, never values from the callback.
            outcome = gateway.confirmPayment(attempt.id(), attempt.amountPaisa(), attempt.providerRef(), params);
        } catch (PaymentException e) {
            System.err.println("attempt " + attemptId + ": " + e.getMessage());
            return ResponseEntity.badRequest().body("Payment could not be verified");
        } catch (RuntimeException e) {
            System.err.println("attempt " + attemptId + ": " + e); // the reconcile job retries later
            return ResponseEntity.status(HttpStatus.BAD_GATEWAY).body("Payment provider unavailable, try again shortly");
        }

        Payments.settle(store, attempt, outcome);
        return ResponseEntity.status(HttpStatus.SEE_OTHER).location(URI.create("/orders/" + attempt.orderId())).build();
    }

    @GetMapping(value = "/orders/{orderId}", produces = MediaType.TEXT_PLAIN_VALUE)
    String order(@PathVariable String orderId) {
        Store.Attempt attempt = store.latestAttempt(orderId);
        return "Order " + orderId + ": " + (attempt == null ? "no payment yet" : attempt.status());
    }

    // A page that posts the gateway form as soon as it loads.
    private static String autoPostForm(Start.Form form) {
        StringBuilder html = new StringBuilder("<form id=\\"pay\\" method=\\"post\\" action=\\"" + HtmlUtils.htmlEscape(form.action()) + "\\"");
        if (form.enctype() != null) html.append(" enctype=\\"").append(HtmlUtils.htmlEscape(form.enctype())).append("\\"");
        html.append(">");
        form.fields().forEach((name, value) -> html.append("<input type=\\"hidden\\" name=\\"")
                .append(HtmlUtils.htmlEscape(name)).append("\\" value=\\"").append(HtmlUtils.htmlEscape(value)).append("\\">"));
        return html.append("<noscript><button>Continue to payment</button></noscript></form>")
                .append("<script>document.getElementById(\\"pay\\").submit()</script>").toString();
    }
}
`,
      },
    ],
  };
}

export const setup: Record<Framework, Block> = {
  spring:
  {
    file: "Terminal",
    lang: "bash",
    code: `# New Spring Boot app with Spring Web, Java 21 (the code runs on Boot 3 and 4)
curl https://start.spring.io/starter.tgz -d type=gradle-project -d language=java \\
  -d javaVersion=21 -d dependencies=web -d name=shop -d packageName=shop -d baseDir=shop | tar -xzf -
cd shop
# Gateway classes parse JSON with Jackson 2 (com.fasterxml). Boot 4 ships Jackson 3, so add it.
# Boot manages the version; on Boot 3 the line changes nothing.
echo "dependencies { implementation 'com.fasterxml.jackson.core:jackson-databind' }" >> build.gradle
# Start.java, Outcome.java, Gateway.java, PaymentException.java, Payments.java,
# Store.java, Reconcile.java and the gateway class go in src/main/java/payments/
# ShopApplication.java (replace the generated one), PaymentController.java and
# ReconcileJob.java go in src/main/java/shop/
mkdir -p src/main/java/payments

export BASE_URL=http://localhost:8080
# export the gateway variables too

./gradlew bootRun   # http://localhost:8080, reconcile runs every minute
`,
  },
};

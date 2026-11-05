package np.payments;

import java.io.IOException;
import java.time.Duration;
import java.util.Map;
import java.util.Objects;

/**
 * One HTTP exchange. The default is {@link JdkHttpTransport}; implement this to plug OkHttp, Spring's RestClient, a
 * proxy, or a test double. Timeouts, retries and JSON handling live in {@link Http}, so every transport behaves the
 * same.
 *
 * <p>Implementations must: send {@code body} as UTF-8 exactly as given (signatures may cover it byte for byte), send
 * every header in {@code headers}, follow redirects except https-to-http, finish (including reading the body) within
 * {@code timeout}, return non-2xx responses normally, decode the response body as UTF-8, and throw IOException for
 * network failures and timeouts.
 */
public interface HttpTransport {

    Response send(Request request) throws IOException;

    /** Back-off between retries. Override in tests to avoid real sleeping. */
    default void sleep(Duration delay) throws InterruptedException {
        Thread.sleep(delay.toMillis());
    }

    /** @param body null = no body */
    record Request(String method, String url, Map<String, String> headers, String body, Duration timeout) {
        public Request {
            Objects.requireNonNull(method, "method");
            Objects.requireNonNull(url, "url");
            Objects.requireNonNull(headers, "headers");
            Objects.requireNonNull(timeout, "timeout");
        }
    }

    record Response(int status, String body) {
        public Response {
            Objects.requireNonNull(body, "body");
        }
    }
}

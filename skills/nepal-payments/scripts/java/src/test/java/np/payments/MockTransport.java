package np.payments;

import java.io.IOException;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Function;

/** Test double for {@link HttpTransport} (the TS tests' mockFetch): records calls, never sleeps, no network. */
final class MockTransport implements HttpTransport {

    interface Handler {
        Response handle(Request request) throws IOException;
    }

    final List<Request> calls = new ArrayList<>();
    final List<Duration> sleeps = new ArrayList<>();
    private Handler handler = r -> {
        throw new AssertionError("unexpected HTTP call: " + r.method() + " " + r.url());
    };

    /** Like mockFetch: resets recorded calls and answers every request with status + body. */
    MockTransport respond(int status, String body) {
        return handle(r -> new Response(status, body));
    }

    MockTransport respond(String body) {
        return respond(200, body);
    }

    MockTransport respondWith(Function<Request, Response> fn) {
        return handle(fn::apply);
    }

    MockTransport handle(Handler h) {
        calls.clear();
        sleeps.clear();
        handler = h;
        return this;
    }

    @Override
    public Response send(Request request) throws IOException {
        calls.add(request);
        return handler.handle(request);
    }

    @Override
    public void sleep(Duration delay) {
        sleeps.add(delay);
    }

    Request call(int i) {
        return calls.get(i);
    }

    /** Exact-case header lookup, like the TS tests' header(). */
    static String header(Request r, String name) {
        return r.headers().get(name);
    }

    @SuppressWarnings("unchecked")
    static Map<String, Object> bodyJson(Request r) {
        return (Map<String, Object>) Json.parse(r.body());
    }

    /** JSON with ' for " so test bodies stay readable. */
    static String q(String singleQuoted) {
        return singleQuoted.replace('\'', '"');
    }

    /** new URL(url).searchParams as a map. */
    static Map<String, String> query(String url) {
        Map<String, String> m = new LinkedHashMap<>();
        String qs = url.substring(url.indexOf('?') + 1);
        for (String kv : qs.split("&")) {
            int i = kv.indexOf('=');
            m.put(URLDecoder.decode(kv.substring(0, i), StandardCharsets.UTF_8), URLDecoder.decode(kv.substring(i + 1), StandardCharsets.UTF_8));
        }
        return m;
    }
}

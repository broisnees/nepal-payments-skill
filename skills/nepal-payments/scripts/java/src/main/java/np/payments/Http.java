package np.payments;

import java.io.IOException;
import java.net.URI;
import java.time.Duration;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;

/**
 * HTTP with timeouts (TS {@code http()}). Adds {@code Accept: application/json}, JSON-encodes non-String bodies (and
 * sets {@code Content-Type: application/json} unless given), parses JSON responses (non-JSON stays text), and retries
 * only when asked (idempotent reads): on network error, 5xx or 429, with 300 ms * 2^n back-off. The final 5xx/429 is
 * returned, not thrown; network failures after the last attempt throw {@code network_error}.
 */
public final class Http {
    public static final Duration DEFAULT_TIMEOUT = Duration.ofSeconds(15);

    private final HttpTransport transport;

    public Http(HttpTransport transport) {
        this.transport = Objects.requireNonNull(transport, "transport");
    }

    /**
     * @param body    null = none; String is sent as-is; anything else is JSON-encoded with {@link Json#write}
     * @param retries extra attempts on network error / 5xx / 429
     */
    public record Options(String method, Map<String, String> headers, Object body, Duration timeout, int retries) {
        public Options {
            if (method == null) method = "GET";
            headers = headers == null ? Map.of() : Collections.unmodifiableMap(new LinkedHashMap<>(headers));
            if (timeout == null) timeout = DEFAULT_TIMEOUT;
            if (retries < 0) throw new IllegalArgumentException("retries must be >= 0");
        }

        public static Options get() {
            return new Options("GET", null, null, null, 0);
        }

        public static Options post(Object body) {
            return new Options("POST", null, body, null, 0);
        }

        public Options withHeaders(Map<String, String> headers) {
            return new Options(method, headers, body, timeout, retries);
        }

        public Options withTimeout(Duration timeout) {
            return new Options(method, headers, body, timeout, retries);
        }

        public Options withRetries(int retries) {
            return new Options(method, headers, body, timeout, retries);
        }
    }

    /** @param data parsed JSON, or the text when it isn't JSON, or null for an empty body */
    public record Response(int status, Object data, String text) {}

    public Response request(ProviderId provider, String url, Options opts) {
        String payload = opts.body() == null ? null : opts.body() instanceof String s ? s : Json.write(opts.body());
        Map<String, String> headers = new LinkedHashMap<>();
        headers.put("Accept", "application/json");
        headers.putAll(opts.headers());
        if (payload != null && headers.keySet().stream().noneMatch(h -> h.equalsIgnoreCase("content-type"))) {
            headers.put("Content-Type", "application/json");
        }
        HttpTransport.Request req = new HttpTransport.Request(opts.method(), url, Collections.unmodifiableMap(headers), payload, opts.timeout());

        Exception lastErr = null;
        for (int attempt = 0; attempt <= opts.retries(); attempt++) {
            if (attempt > 0) {
                try {
                    transport.sleep(Duration.ofMillis(300L << (attempt - 1)));
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    throw new PaymentException("request to " + host(url) + " interrupted", provider, "network_error", null, e);
                }
            }
            HttpTransport.Response res;
            try {
                res = transport.send(req);
            } catch (IOException | RuntimeException e) {
                lastErr = e;
                if (attempt >= opts.retries()) break;
                continue;
            }
            String text = res.body().startsWith("﻿") ? res.body().substring(1) : res.body();
            if ((res.status() >= 500 || res.status() == 429) && attempt < opts.retries()) {
                lastErr = new PaymentException("HTTP " + res.status(), provider, "upstream_error", res.status(), text);
                continue;
            }
            Object data = null;
            if (!text.isEmpty()) {
                try {
                    data = Json.parse(text);
                } catch (JsonException e) {
                    data = text; // non-JSON body: keep text
                }
            }
            return new Response(res.status(), data, text);
        }
        String why = lastErr == null ? "unknown error" : lastErr.getMessage() != null ? lastErr.getMessage() : lastErr.getClass().getSimpleName();
        throw new PaymentException("request to " + host(url) + " failed: " + why, provider, "network_error", null, lastErr);
    }

    private static String host(String url) {
        try {
            URI u = URI.create(url);
            if (u.getHost() == null) return url;
            int port = u.getPort();
            boolean defaultPort = port == -1 || ("https".equals(u.getScheme()) && port == 443) || ("http".equals(u.getScheme()) && port == 80);
            return defaultPort ? u.getHost() : u.getHost() + ":" + port;
        } catch (IllegalArgumentException e) {
            return url;
        }
    }
}

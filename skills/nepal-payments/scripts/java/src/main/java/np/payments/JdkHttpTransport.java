package np.payments;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InterruptedIOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.HttpTimeoutException;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.Flow;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

/**
 * {@link HttpTransport} on {@code java.net.http.HttpClient}: HTTP/1.1, redirects followed (never https to http), and
 * the timeout bounds the whole exchange including the body, like {@code fetch} + {@code AbortSignal.timeout}.
 * Thread-safe; share one instance.
 *
 * <p>HttpClient refuses the "Connection" header ("restricted header name") unless the JVM runs with
 * {@code -Djdk.httpclient.allowRestrictedHeaders=connection}. Without that flag, a request that asks for
 * {@code Connection: close} (Hamro Pay) is sent without the header on a one-shot client built from this one's settings,
 * so its socket never returns to the shared keep-alive pool; the one-shot client is released for GC afterwards.
 *
 * <p>Hamro Pay's gateway aborts the body stream on error responses (the chunked body never gets its terminating
 * chunk). When the body read fails after some bytes arrived and those bytes parse as a complete JSON value, the
 * response is returned with them as the body; anything else still throws.
 */
public final class JdkHttpTransport implements HttpTransport {
    private final HttpClient client;

    public JdkHttpTransport() {
        this(HttpClient.newBuilder()
                .version(HttpClient.Version.HTTP_1_1)
                .followRedirects(HttpClient.Redirect.NORMAL)
                .build());
    }

    /** Use your own client (proxy, SSL context, executor). */
    public JdkHttpTransport(HttpClient client) {
        this.client = client;
    }

    /** Process-wide default instance used when no transport is passed. */
    public static JdkHttpTransport shared() {
        return Holder.INSTANCE;
    }

    private static final class Holder {
        static final JdkHttpTransport INSTANCE = new JdkHttpTransport();
    }

    @Override
    public Response send(Request r) throws IOException {
        HttpRequest.Builder b = HttpRequest.newBuilder(URI.create(r.url())).timeout(r.timeout());
        HttpClient via = client;
        for (Map.Entry<String, String> h : r.headers().entrySet()) {
            if (h.getKey().equalsIgnoreCase("Connection")) {
                try {
                    b.header(h.getKey(), h.getValue());
                } catch (IllegalArgumentException restricted) {
                    if (h.getValue().equalsIgnoreCase("close")) via = oneShot();
                }
            } else {
                b.header(h.getKey(), h.getValue());
            }
        }
        b.method(r.method(), r.body() == null
                ? HttpRequest.BodyPublishers.noBody()
                : HttpRequest.BodyPublishers.ofString(r.body(), StandardCharsets.UTF_8));
        CompletableFuture<HttpResponse<byte[]>> f = via.sendAsync(b.build(), info -> new LenientBody());
        try {
            HttpResponse<byte[]> res = f.get(r.timeout().toMillis(), TimeUnit.MILLISECONDS);
            return new Response(res.statusCode(), new String(res.body(), StandardCharsets.UTF_8));
        } catch (TimeoutException e) {
            f.cancel(true);
            throw new HttpTimeoutException("request timed out after " + r.timeout().toMillis() + " ms");
        } catch (InterruptedException e) {
            f.cancel(true);
            Thread.currentThread().interrupt();
            throw new InterruptedIOException("interrupted");
        } catch (ExecutionException e) {
            Throwable c = e.getCause();
            if (c instanceof IOException io) throw io;
            if (c instanceof RuntimeException re) throw re;
            throw new IOException(c);
        }
    }

    /** Collects the body; on a read error keeps the bytes already read if they are complete JSON. */
    private static final class LenientBody implements HttpResponse.BodySubscriber<byte[]> {
        private final ByteArrayOutputStream buf = new ByteArrayOutputStream();
        private final CompletableFuture<byte[]> result = new CompletableFuture<>();

        @Override
        public CompletionStage<byte[]> getBody() {
            return result;
        }

        @Override
        public void onSubscribe(Flow.Subscription s) {
            s.request(Long.MAX_VALUE);
        }

        @Override
        public void onNext(List<ByteBuffer> items) {
            for (ByteBuffer bb : items) {
                byte[] chunk = new byte[bb.remaining()];
                bb.get(chunk);
                buf.writeBytes(chunk);
            }
        }

        @Override
        public void onError(Throwable err) {
            byte[] partial = buf.toByteArray();
            if (partial.length > 0) {
                try {
                    Json.parse(new String(partial, StandardCharsets.UTF_8));
                    result.complete(partial);
                    return;
                } catch (RuntimeException notJson) {
                    // fall through: partial non-JSON is still a network error
                }
            }
            result.completeExceptionally(err);
        }

        @Override
        public void onComplete() {
            result.complete(buf.toByteArray());
        }
    }

    /** A client with this one's settings and an empty connection pool. */
    private HttpClient oneShot() {
        HttpClient.Builder nb = HttpClient.newBuilder().version(client.version()).followRedirects(client.followRedirects());
        client.proxy().ifPresent(nb::proxy);
        client.authenticator().ifPresent(nb::authenticator);
        client.cookieHandler().ifPresent(nb::cookieHandler);
        client.connectTimeout().ifPresent(nb::connectTimeout);
        client.executor().ifPresent(nb::executor);
        return nb.sslContext(client.sslContext()).sslParameters(client.sslParameters()).build();
    }
}

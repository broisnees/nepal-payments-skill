package np.payments;

import java.io.IOException;
import java.io.InterruptedIOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.HttpTimeoutException;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

/**
 * {@link HttpTransport} on {@code java.net.http.HttpClient}: HTTP/1.1, redirects followed (never https to http), and
 * the timeout bounds the whole exchange including the body, like {@code fetch} + {@code AbortSignal.timeout}.
 * Thread-safe; share one instance.
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
        r.headers().forEach(b::header);
        b.method(r.method(), r.body() == null
                ? HttpRequest.BodyPublishers.noBody()
                : HttpRequest.BodyPublishers.ofString(r.body(), StandardCharsets.UTF_8));
        CompletableFuture<HttpResponse<byte[]>> f = client.sendAsync(b.build(), HttpResponse.BodyHandlers.ofByteArray());
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
}

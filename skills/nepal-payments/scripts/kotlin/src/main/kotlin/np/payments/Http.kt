/*
 * HTTP behind a pluggable transport. The retry/timeout/JSON policy (TS core.ts `http()`) lives in [Http] and applies
 * to every transport; a transport only performs ONE exchange and must enforce [TransportRequest.timeout].
 *
 * Plug Ktor client, OkHttp, Spring WebClient... by implementing [HttpTransport]. The default is [JdkHttpTransport]
 * (java.net.http, non-blocking: HttpClient.sendAsync bridged with suspendCoroutine).
 */
package np.payments

import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.net.http.HttpTimeoutException
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CompletionException
import java.util.concurrent.ExecutionException
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
import kotlin.coroutines.cancellation.CancellationException
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlin.coroutines.suspendCoroutine
import kotlin.time.Duration
import kotlin.time.Duration.Companion.seconds

data class TransportRequest(
    val method: String,
    val url: String,
    /** Final header set, in order. Send exactly these. */
    val headers: Map<String, String>,
    /** UTF-8 request body, or null for none. Send these exact bytes (some providers sign the body). */
    val body: String?,
    /** Whole-exchange deadline (connect + send + full response body). */
    val timeout: Duration,
)

data class TransportResponse(
    val status: Int,
    /** Response body decoded as UTF-8. */
    val body: String,
    val headers: Map<String, List<String>> = emptyMap(),
)

/**
 * One HTTP exchange. Throw on network failure / timeout (any exception except CancellationException is treated as a
 * retryable network error); return non-2xx responses normally. Don't follow redirects for POSTs that would drop the body.
 */
fun interface HttpTransport {
    suspend fun execute(request: TransportRequest): TransportResponse

    companion object {
        /** Shared [JdkHttpTransport]. */
        val Default: HttpTransport by lazy { JdkHttpTransport() }
    }
}

/**
 * java.net.http transport. Non-blocking: the calling coroutine suspends while the request runs on the client's
 * executor. The deadline is enforced twice (HttpRequest.timeout for the response headers, and an overall
 * CompletableFuture deadline that also covers the body); on timeout or failure the in-flight exchange is cancelled.
 *
 * Note: stdlib-only coroutines can't observe coroutine cancellation, so a cancelled caller stops waiting only when the
 * request finishes or hits its timeout. Use a Ktor-client-based transport if you need prompt cancellation.
 */
class JdkHttpTransport(private val client: HttpClient = defaultClient) : HttpTransport {
    override suspend fun execute(request: TransportRequest): TransportResponse {
        val timeoutMs = request.timeout.inWholeMilliseconds.coerceAtLeast(1)
        val builder = HttpRequest.newBuilder(URI.create(request.url))
            .timeout(java.time.Duration.ofMillis(timeoutMs))
            .method(
                request.method,
                request.body?.let { HttpRequest.BodyPublishers.ofString(it, Charsets.UTF_8) } ?: HttpRequest.BodyPublishers.noBody(),
            )
        for ((name, value) in request.headers) builder.header(name, value)

        val inFlight: CompletableFuture<HttpResponse<ByteArray>> =
            client.sendAsync(builder.build(), HttpResponse.BodyHandlers.ofByteArray())
        val deadline = inFlight.thenApply { it }.orTimeout(timeoutMs, TimeUnit.MILLISECONDS)
        return try {
            suspendCoroutine { cont ->
                deadline.whenComplete { res, err ->
                    if (err != null) cont.resumeWithException(unwrap(err, timeoutMs))
                    else cont.resume(TransportResponse(res.statusCode(), decodeUtf8(res.body()), res.headers().map()))
                }
            }
        } catch (e: Throwable) {
            inFlight.cancel(true) // abort the exchange (no-op if it already finished)
            throw e
        }
    }

    private fun unwrap(err: Throwable, timeoutMs: Long): Throwable {
        var e = err
        while ((e is CompletionException || e is ExecutionException) && e.cause != null) e = e.cause!!
        return if (e is TimeoutException) HttpTimeoutException("request timed out after $timeoutMs ms") else e
    }

    companion object {
        /** HTTP/1.1 (like Node's fetch), follows same-or-safer redirects, 10 s connect timeout. */
        val defaultClient: HttpClient by lazy {
            HttpClient.newBuilder()
                .version(HttpClient.Version.HTTP_1_1)
                .followRedirects(HttpClient.Redirect.NORMAL)
                .connectTimeout(java.time.Duration.ofSeconds(10))
                .build()
        }
    }
}

/** Parsed response: [data] is the JSON value, or the raw text when the body isn't JSON, or null when empty. */
internal data class HttpResult(val status: Int, val data: Any?, val text: String)

/** TS `http()`: default headers, JSON bodies, timeouts, retries (idempotent reads only) with 300/600/1200 ms backoff. */
internal class Http(private val provider: ProviderId, private val transport: HttpTransport) {
    suspend fun request(
        url: String,
        method: String = "GET",
        headers: Map<String, String> = emptyMap(),
        /** String: sent as-is. Anything else: JSON-encoded. null: no body. */
        body: Any? = null,
        timeout: Duration = 15.seconds,
        /** Extra attempts on network error / 5xx / 429. */
        retries: Int = 0,
    ): HttpResult {
        val payload: String? = when (body) {
            null -> null
            is String -> body
            else -> Json.stringify(body)
        }
        val finalHeaders = LinkedHashMap<String, String>()
        finalHeaders["Accept"] = "application/json"
        for ((name, value) in headers) {
            finalHeaders.keys.removeIf { it.equals(name, ignoreCase = true) }
            finalHeaders[name] = value
        }
        if (payload != null && finalHeaders.keys.none { it.equals("Content-Type", ignoreCase = true) }) {
            finalHeaders["Content-Type"] = "application/json"
        }
        val request = TransportRequest(method, url, finalHeaders, payload, timeout)

        var lastErr: Throwable? = null
        for (attempt in 0..retries) {
            if (attempt > 0) sleepMillis(300L shl (attempt - 1))
            val res = try {
                transport.execute(request)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                lastErr = e
                if (attempt >= retries) break
                continue
            }
            if ((res.status >= 500 || res.status == 429) && attempt < retries) {
                lastErr = PaymentException("HTTP ${res.status}", provider, "upstream_error", res.status, res.body)
                continue
            }
            val data: Any? = if (res.body.isEmpty()) null else try {
                Json.parse(res.body)
            } catch (e: JsonException) {
                res.body // non-JSON body: keep text
            }
            return HttpResult(res.status, data, res.body)
        }
        val reason = lastErr?.message ?: lastErr?.javaClass?.simpleName ?: "unknown error"
        throw PaymentException("request to ${hostOf(url)} failed: $reason", provider, "network_error", null, lastErr, lastErr)
    }
}

/** Suspend without kotlinx-coroutines. */
internal suspend fun sleepMillis(ms: Long) {
    suspendCoroutine { cont ->
        CompletableFuture.delayedExecutor(ms, TimeUnit.MILLISECONDS).execute { cont.resume(Unit) }
    }
}

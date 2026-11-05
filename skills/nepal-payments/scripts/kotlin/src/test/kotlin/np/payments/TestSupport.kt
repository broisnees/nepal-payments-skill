package np.payments

import kotlinx.coroutines.runBlocking
import java.net.URI
import java.net.URLDecoder

/**
 * Test conventions: @DisplayName "[ts] ..." = ported 1:1 from scripts/ts/test/adapters.test.ts (same name, vectors,
 * mocked responses, assertions); "[py] ..." = Python-only case from scripts/python/tests; "[kt] ..." = Kotlin-specific.
 */
fun suspendTest(block: suspend () -> Unit) {
    runBlocking { block() }
}

/** Fetch mock: records every request; responses come from [handler]. Like the TS mockFetch, [respond] resets calls. */
class MockTransport : HttpTransport {
    val calls = mutableListOf<TransportRequest>()
    var handler: (TransportRequest) -> TransportResponse = { error("unexpected request to ${it.url}") }

    override suspend fun execute(request: TransportRequest): TransportResponse {
        calls += request
        return handler(request)
    }

    /** [body] is sent as-is when it's a String (raw JSON/XML/HTML), else JSON-encoded. */
    fun respond(body: Any?, status: Int = 200) {
        calls.clear()
        val text = if (body is String) body else Json.stringify(body)
        handler = { TransportResponse(status, text) }
    }
}

fun TransportRequest.header(name: String): String? = headers[name]

fun TransportRequest.jsonBody(): Map<String, Any?> = Json.parse(body!!).asJsonObject()!!

fun b64(s: String): String = toBase64(s.toByteArray(Charsets.UTF_8))

fun queryParams(url: String): Map<String, String> =
    URI(url).rawQuery.split("&").associate {
        val (k, v) = it.split("=", limit = 2)
        URLDecoder.decode(k, Charsets.UTF_8) to URLDecoder.decode(v, Charsets.UTF_8)
    }

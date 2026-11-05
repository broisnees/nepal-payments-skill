/*
 * Live sandbox smoke test (mirrors scripts/ts/test/sandbox.ts). Hits real provider sandboxes; no payment is completed.
 *   ./gradlew sandbox                          # eSewa (public creds) + Fonepay dev sample
 *   KHALTI_SECRET_KEY=... ./gradlew sandbox    # + Khalti (key from test-admin.khalti.com)
 * Exit code 1 if any check fails.
 */
package np.payments

import java.net.URI
import java.net.URLEncoder
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration
import kotlin.system.exitProcess

private var failed = 0

private suspend fun check(name: String, fn: suspend () -> String) {
    try {
        println("  ok   $name: ${fn()}")
    } catch (e: Exception) {
        failed++
        println("  FAIL $name: ${e.message ?: e}")
    }
}

private fun ensure(cond: Boolean, msg: () -> String) {
    if (!cond) throw IllegalStateException(msg())
}

/** No-redirect client, to look at the provider's 3xx itself (fetch redirect: "manual"). */
private val manual: HttpClient = HttpClient.newBuilder().followRedirects(HttpClient.Redirect.NEVER).connectTimeout(Duration.ofSeconds(15)).build()

private fun send(request: HttpRequest): HttpResponse<String> = manual.send(request, HttpResponse.BodyHandlers.ofString())

private fun formBody(fields: Map<String, String>) =
    fields.entries.joinToString("&") { URLEncoder.encode(it.key, Charsets.UTF_8) + "=" + URLEncoder.encode(it.value, Charsets.UTF_8) }

suspend fun main() {
    println("eSewa (rc sandbox)")
    val e = Esewa(EsewaSandbox.config())
    val id = newOrderId()
    check("signed form accepted (302 to login)") {
        val f = e.initiate(InitiateInput(id, 11050, "smoke", "https://example.com/payments/esewa/return/$id"), EsewaInitiateExtras(taxPaisa = 1000))
        ensure(f is InitiateResult.Form) { "expected form" }
        f as InitiateResult.Form
        val r = send(
            HttpRequest.newBuilder(URI.create(f.action)).timeout(Duration.ofSeconds(30))
                .header("Content-Type", "application/x-www-form-urlencoded")
                .POST(HttpRequest.BodyPublishers.ofString(formBody(f.fields))).build(),
        )
        val loc = r.headers().firstValue("location").orElse("")
        ensure(r.statusCode() == 302 && loc.contains("bookingId=")) { "got ${r.statusCode()} $loc ${r.body().take(200)}" }
        loc
    }
    check("status API: unpaid -> pending") {
        val v = e.verify(VerifyInput(id, 11050))
        ensure(v.status == PaymentStatus.PENDING) { "got ${v.status.wire}" }
        v.status.wire
    }
    check("status API: wrong total -> not_found") {
        val v = e.verify(VerifyInput(id, 99900))
        ensure(v.status == PaymentStatus.NOT_FOUND) { "got ${v.status.wire}" }
        v.status.wire
    }
    check("intent book -> status -> cancel") {
        val oid = newOrderId("I")
        val b = e.intentBook(oid, 10000, "https://example.com/cb", "https://example.com/done")
        val s = e.intentVerify(oid, b.providerRef)
        ensure(s.status == PaymentStatus.PENDING) { "status ${s.status.wire}" }
        val c = e.intentCancel(b.providerRef)
        ensure(c.field("data").field("status") == "CANCELED") { "cancel ${Json.stringify(c)}" }
        "${b.deeplink} BOOKED -> CANCELED"
    }

    println("Fonepay (dev gateway, public sample merchant NBQM)")
    val fp = Fonepay(FonepayConfig(Environment.SANDBOX, "NBQM", "a7e3512f5032480a83137793cb2021dc"))
    check("signed redirect accepted (303 to payment page)") {
        val r = fp.initiate(InitiateInput(newOrderId(), 1050, "smoke", "https://example.com/payments/fonepay/return")) as InitiateResult.Redirect
        val res = send(HttpRequest.newBuilder(URI.create(r.url)).timeout(Duration.ofSeconds(30)).GET().build())
        val loc = res.headers().firstValue("location").orElse("")
        ensure(res.statusCode() in 300..399 && loc.contains("fonepay.com")) { "got ${res.statusCode()} $loc ${res.body().take(200)}" }
        loc
    }
    check("bad DV rejected (no redirect to payment page)") {
        val r = fp.initiate(InitiateInput(newOrderId(), 1050, "smoke", "https://example.com/payments/fonepay/return")) as InitiateResult.Redirect
        val dv = queryParam(r.url, "DV")
        val tampered = r.url.replace("DV=$dv", "DV=" + dv.dropLast(4) + (if (dv.endsWith("0000")) "1111" else "0000"))
        val res = send(HttpRequest.newBuilder(URI.create(tampered)).timeout(Duration.ofSeconds(30)).GET().build())
        ensure(res.statusCode() !in 300..399 && res.statusCode() < 500) { "got ${res.statusCode()} ${res.headers().firstValue("location").orElse("")} ${res.body().take(200)}" }
        "${res.statusCode()} ${res.body().take(120)}"
    }

    val khaltiKey = System.getenv("KHALTI_SECRET_KEY")
    if (!khaltiKey.isNullOrEmpty()) {
        println("Khalti (dev.khalti.com)")
        val k = Khalti(KhaltiConfig(khaltiKey, Environment.SANDBOX, "https://example.com"))
        check("initiate -> lookup (Initiated)") {
            val oid = newOrderId()
            val r = k.initiate(InitiateInput(oid, 1000, "smoke", "https://example.com/payments/khalti/return")) as InitiateResult.Redirect
            val v = k.verify(VerifyInput(oid, 1000, providerRef = r.providerRef))
            ensure(v.status == PaymentStatus.PENDING) { "got ${v.status.wire}" }
            "${r.url} -> ${v.raw.field("status")}"
        }
    } else {
        println("Khalti: skipped (set KHALTI_SECRET_KEY from https://test-admin.khalti.com)")
    }

    println(if (failed > 0) "\n$failed check(s) failed" else "\nall sandbox checks passed")
    exitProcess(if (failed > 0) 1 else 0)
}

private fun queryParam(url: String, name: String): String =
    URI(url).rawQuery.split("&").first { it.startsWith("$name=") }.substringAfter("=")

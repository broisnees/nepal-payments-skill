// Shared app code for Kotlin (Ktor): payment types with settle(), the demo store,
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

export type Framework = "ktor";

export const types: Block[] = [
  {
    file: "src/main/kotlin/payments/Payments.kt",
    lang: "kotlin",
    code: `package payments

// Where to send the buyer: a redirect, or a form the browser auto-posts.
// providerRef: id the gateway hands back (Khalti pidx, ...), or null. The app stores it.
sealed interface Start {
    val providerRef: String?

    data class Redirect(val url: String, override val providerRef: String? = null) : Start
    // enctype: null posts urlencoded (the browser default); NPS needs "multipart/form-data".
    data class Form(
        val action: String,
        val fields: Map<String, String>,
        override val providerRef: String? = null,
        val enctype: String? = null,
    ) : Start
}

// status: paid, pending, failed, canceled, refunded or not_found
data class Outcome(val status: String, val providerRef: String? = null)

interface Gateway {
    suspend fun startPayment(attemptId: String, amountPaisa: Long, returnUrl: String, description: String): Start

    // params: the callback's query and body params, or an empty map from the reconcile job.
    suspend fun confirmPayment(attemptId: String, amountPaisa: Long, providerRef: String?, params: Map<String, String>): Outcome
}

// Bad signature, amount mismatch or a refusal from the provider.
// Any other exception from a gateway is a network or provider outage.
class PaymentException(message: String) : RuntimeException(message)

// Attempt states that can still change.
val OPEN = listOf("initiated", "pending")

// Apply a gateway answer to an attempt. Safe to call any number of times:
// transition() only succeeds once, so fulfil() runs once per order.
fun settle(store: Store, attempt: Attempt, outcome: Outcome) {
    when (outcome.status) {
        "paid", "failed", "canceled" ->
            if (store.transition(attempt.id, OPEN, outcome.status) && outcome.status == "paid") {
                // Keep the gateway's transaction id (refunds, support). A ref saved at start
                // (Khalti pidx, IME TokenId, NPS ProcessId) stays: confirm looks the payment up with it.
                if (outcome.providerRef != null && attempt.providerRef == null) {
                    store.setProviderRef(attempt.id, outcome.providerRef)
                }
                store.fulfil(attempt.orderId)
            }
        "pending" -> store.transition(attempt.id, listOf("initiated"), "pending")
        // not_found: leave it, the reconcile job expires it after an hour.
    }
}
`,
  },
];

export const store: Block[] = [
  {
    file: "src/main/kotlin/payments/Store.kt",
    lang: "kotlin",
    code: `package payments

import java.security.SecureRandom
import java.time.Duration
import java.time.Instant
import java.util.HexFormat

data class Order(val id: String, val amountPaisa: Long)

data class Attempt(
    val id: String,
    val orderId: String,
    val amountPaisa: Long,
    val status: String = "initiated",
    val providerRef: String? = null,
    val createdAt: Instant = Instant.now(),
)

// In-memory demo store: swap for your database (table in the article).
// Every method holds one lock, so transition() is an atomic compare-and-set.
class Store {
    private val lock = Any()
    private val random = SecureRandom()
    private val orders = mapOf("demo" to Order("demo", 10_000)) // Rs 100
    private val attempts = LinkedHashMap<String, Attempt>() // oldest first

    fun getOrder(id: String): Order? = orders[id]

    fun createAttempt(orderId: String, amountPaisa: Long): Attempt = synchronized(lock) {
        val id = HexFormat.of().formatHex(ByteArray(10).also(random::nextBytes)) // 20 lowercase hex chars
        Attempt(id, orderId, amountPaisa).also { attempts[id] = it }
    }

    fun getAttempt(id: String): Attempt? = synchronized(lock) { attempts[id] }

    fun latestAttempt(orderId: String): Attempt? = synchronized(lock) {
        attempts.values.lastOrNull { it.orderId == orderId }
    }

    fun setProviderRef(id: String, ref: String) = synchronized(lock) {
        attempts[id]?.let { attempts[id] = it.copy(providerRef = ref) }
    }

    // Move to \`to\` only if the status is in \`from\`.
    // In SQL: UPDATE payment_attempts SET status = ? WHERE id = ? AND status IN (...)
    fun transition(id: String, from: List<String>, to: String): Boolean = synchronized(lock) {
        val a = attempts[id] ?: return false
        if (a.status !in from) return false
        attempts[id] = a.copy(status = to)
        true
    }

    fun openAttempts(olderThan: Duration): List<Attempt> = synchronized(lock) {
        val cutoff = Instant.now() - olderThan
        attempts.values.filter { it.status in OPEN && !it.createdAt.isAfter(cutoff) }
    }

    fun fulfil(orderId: String) {
        println("order $orderId paid, fulfil it here")
    }
}
`,
  },
];

export const reconcile: Block[] = [
  {
    file: "src/main/kotlin/payments/Reconcile.kt",
    lang: "kotlin",
    code: `package payments

import java.time.Duration
import java.time.Instant
import kotlin.coroutines.cancellation.CancellationException

// Settle attempts whose buyer never came back. Run it every minute.
suspend fun reconcile(store: Store, gateway: Gateway) {
    val open = store.openAttempts(Duration.ofMinutes(2))
    for (a in open) {
        if (a.createdAt.isBefore(Instant.now() - Duration.ofDays(3))) {
            // Still open after 3 days: asking again rarely helps, so a person checks it
            // (gateway dashboard, bank statement) and closes it by hand.
            println("attempt \${a.id} still \${a.status} after 3 days, needs manual review")
            continue
        }
        try {
            // Empty params: the gateway module asks the status API.
            val outcome = gateway.confirmPayment(a.id, a.amountPaisa, a.providerRef, emptyMap())
            settle(store, a, outcome)
            if (outcome.status == "not_found" && a.createdAt.isBefore(Instant.now() - Duration.ofHours(1))) {
                store.transition(a.id, OPEN, "expired")
            }
        } catch (e: CancellationException) {
            throw e // the app is shutting down
        } catch (e: Exception) {
            System.err.println("reconcile \${a.id}: $e") // one bad attempt must not stop the rest
        }
    }
    println("reconcile: checked \${open.size} open attempts")
}
`,
  },
];

export function routes(g: GatewayRef): Record<Framework, Block[]> {
  return {
    ktor: [
      {
        file: "src/main/kotlin/shop/Application.kt",
        lang: "kotlin",
        code: `package shop

import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import io.ktor.http.Parameters
import io.ktor.server.application.Application
import io.ktor.server.application.ApplicationCall
import io.ktor.server.application.log
import io.ktor.server.engine.embeddedServer
import io.ktor.server.netty.Netty
import io.ktor.server.request.httpMethod
import io.ktor.server.request.receiveParameters
import io.ktor.server.response.respond
import io.ktor.server.response.respondText
import io.ktor.server.routing.RoutingContext
import io.ktor.server.routing.get
import io.ktor.server.routing.post
import io.ktor.server.routing.routing
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import payments.${g.kotlin}
import payments.Gateway
import payments.PaymentException
import payments.Start
import payments.Store
import payments.reconcile
import payments.settle
import kotlin.time.Duration.Companion.minutes

fun main() {
    embeddedServer(Netty, port = 8080, module = Application::module).start(wait = true)
}

fun Application.module() {
    val baseUrl = (System.getenv("BASE_URL") ?: "http://localhost:8080").trimEnd('/')
    val store = Store()
    val gateway: Gateway = ${g.kotlin}.fromEnv()

    // Reconcile open attempts every minute for as long as the app runs.
    launch {
        while (isActive) {
            reconcile(store, gateway)
            delay(1.minutes)
        }
    }

    routing {
        get("/") {
            call.respondText(
                """<h1>Order demo, Rs 100</h1><form method="post" action="/pay/demo"><button>Pay with ${g.name}</button></form>""",
                ContentType.Text.Html,
            )
        }

        post("/pay/{orderId}") {
            val order = store.getOrder(call.parameters["orderId"]!!) ?: return@post call.respond(HttpStatusCode.NotFound)
            val attempt = store.createAttempt(order.id, order.amountPaisa)

            // Path segment, never a query string: some gateways append their own query parameters to this URL.
            val returnUrl = "$baseUrl/pay/return/\${attempt.id}"
            val start = gateway.startPayment(attempt.id, attempt.amountPaisa, returnUrl, "Order \${order.id}")
            start.providerRef?.let { store.setProviderRef(attempt.id, it) }

            when (start) {
                is Start.Redirect -> call.seeOther(start.url)
                is Start.Form -> call.respondText(autoPostForm(start), ContentType.Text.Html)
            }
        }

        // GET and POST: most gateways redirect back, CyberSource and IME Pay POST a form.
        get("/pay/return/{attemptId}") { paymentReturn(store, gateway) }
        post("/pay/return/{attemptId}") { paymentReturn(store, gateway) }

        get("/orders/{orderId}") {
            val orderId = call.parameters["orderId"]!!
            call.respondText("Order $orderId: \${store.latestAttempt(orderId)?.status ?: "no payment yet"}")
        }
    }
}

private suspend fun RoutingContext.paymentReturn(store: Store, gateway: Gateway) {
    val attempt = store.getAttempt(call.parameters["attemptId"]!!) ?: return call.respond(HttpStatusCode.NotFound)

    // Query params plus the form body, if the gateway posted one.
    val body = if (call.request.httpMethod == HttpMethod.Post) call.receiveParameters() else Parameters.Empty
    val params = mutableMapOf<String, String>()
    for ((name, values) in call.request.queryParameters.entries() + body.entries()) params[name] = values.first()

    val outcome = try {
        // Stored amount and providerRef, never values from the callback.
        gateway.confirmPayment(attempt.id, attempt.amountPaisa, attempt.providerRef, params)
    } catch (e: PaymentException) {
        call.application.log.warn("attempt \${attempt.id}: \${e.message}")
        return call.respondText("Payment could not be verified", status = HttpStatusCode.BadRequest)
    } catch (e: Exception) {
        call.application.log.error("attempt \${attempt.id}", e) // the reconcile job retries later
        return call.respondText("Payment provider unavailable, try again shortly", status = HttpStatusCode.BadGateway)
    }

    settle(store, attempt, outcome)
    call.seeOther("/orders/\${attempt.orderId}")
}

private suspend fun ApplicationCall.seeOther(url: String) {
    response.headers.append(HttpHeaders.Location, url)
    respond(HttpStatusCode.SeeOther)
}

// A page that posts the gateway form as soon as it loads.
private fun autoPostForm(form: Start.Form): String {
    fun esc(s: String) = s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
        .replace("\\"", "&quot;").replace("'", "&#39;")
    val inputs = form.fields.entries.joinToString("") { (name, value) ->
        """<input type="hidden" name="\${esc(name)}" value="\${esc(value)}">"""
    }
    val enctype = form.enctype?.let { """ enctype="\${esc(it)}"""" } ?: ""
    return """<form id="pay" method="post" action="\${esc(form.action)}"$enctype>$inputs""" +
        """<noscript><button>Continue to payment</button></noscript></form>""" +
        """<script>document.getElementById("pay").submit()</script>"""
}
`,
      },
      {
        file: "build.gradle.kts",
        lang: "kotlin",
        code: `plugins {
    kotlin("jvm") version "2.4.21"
    application
}

repositories {
    mavenCentral()
}

dependencies {
    implementation("io.ktor:ktor-server-netty:3.6.1")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.12.0") // used by the gateway module
    implementation("org.slf4j:slf4j-simple:2.0.20") // Ktor logs through SLF4J
}

application {
    mainClass.set("shop.ApplicationKt")
}
`,
      },
    ],
  };
}

export const setup: Record<Framework, Block> = {
  ktor:
  {
    file: "Terminal",
    lang: "bash",
    code: `# Ktor 3 on JDK 21 with Gradle 8.14+ installed (or start from start.ktor.io)
mkdir -p shop/src/main/kotlin/payments shop/src/main/kotlin/shop && cd shop
echo 'rootProject.name = "shop"' > settings.gradle.kts
# build.gradle.kts at the root.
# Payments.kt, Store.kt, Reconcile.kt and the gateway class go in src/main/kotlin/payments/
# Application.kt goes in src/main/kotlin/shop/
gradle wrapper

export BASE_URL=http://localhost:8080
# export the gateway variables too

./gradlew run   # http://localhost:8080, reconcile runs every minute
`,
  },
};

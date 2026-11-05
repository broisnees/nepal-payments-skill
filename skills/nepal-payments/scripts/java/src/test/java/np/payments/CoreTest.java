package np.payments;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.math.BigDecimal;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/** Port of the "core" describe block of scripts/ts/test/adapters.test.ts, plus Python-only and Java-only cases. */
class CoreTest {
    private static final long H = 60 * 60_000L;

    @Test
    @DisplayName("money conversions are exact")
    void moneyConversions() {
        assertEquals("100", Money.paisaToRupees(10000));
        assertEquals("100.50", Money.paisaToRupees(10050));
        assertEquals("0.05", Money.paisaToRupees(5));
        assertEquals(100000, Money.rupeesToPaisa("1,000.0"));
        assertEquals(10010, Money.rupeesToPaisa(100.1));
        assertEquals(10, Money.rupeesToPaisa("0.1"));
        assertEquals(2000, Money.rupeesToPaisa("19.995"));
        assertEquals(101, Money.rupeesToPaisa(1.005)); // same as Python Decimal(str(x)); toFixed(2) would give 100
    }

    @Test
    @DisplayName("decideTransition: the state machine")
    void decideTransition() {
        VerifyResult paid = result(PaymentStatus.PAID, 1000L);
        assertEquals(AttemptStatus.PAID, StateMachine.decideTransition(AttemptStatus.INITIATED, paid, 1000, 0).next());
        // amount guard: mismatch and missing amount both go to review, never paid
        assertEquals(new TransitionDecision(AttemptStatus.UNKNOWN, true, false, "amount mismatch: stored 1000, provider 10"),
                StateMachine.decideTransition(AttemptStatus.PENDING, result(PaymentStatus.PAID, 10L), 1000, 0));
        assertTrue(StateMachine.decideTransition(AttemptStatus.PENDING, result(PaymentStatus.PAID, null), 1000, 0).reviewRequired());
        // not_found keeps the attempt open inside the window, expires after
        assertNull(StateMachine.decideTransition(AttemptStatus.INITIATED, result(PaymentStatus.NOT_FOUND, null), 1000, 5 * 60_000).next());
        assertEquals(AttemptStatus.EXPIRED, StateMachine.decideTransition(AttemptStatus.INITIATED, result(PaymentStatus.NOT_FOUND, null), 1000, 2 * H).next());
        // late payment after we closed it is recovered, not dropped
        TransitionDecision late = StateMachine.decideTransition(AttemptStatus.EXPIRED, paid, 1000, 3 * H);
        assertEquals(AttemptStatus.PAID, late.next());
        assertTrue(late.latePaid());
        // paid is terminal for automation; same status is a no-op
        assertNull(StateMachine.decideTransition(AttemptStatus.PAID, result(PaymentStatus.FAILED, null), 1000, 0).next());
        assertNull(StateMachine.decideTransition(AttemptStatus.PENDING, result(PaymentStatus.PENDING, null), 1000, 0).next());
        assertNull(StateMachine.decideTransition(AttemptStatus.FAILED, result(PaymentStatus.CANCELED, null), 1000, 0).next());
    }

    @Test
    @DisplayName("base64 tolerates '+' turned into space")
    void base64PlusAsSpace() {
        String b = Codec.toBase64(new byte[] {(byte) 251, (byte) 255, (byte) 190});
        assertEquals("+/++", b);
        assertArrayEquals(new byte[] {(byte) 251, (byte) 255, (byte) 190}, Codec.fromBase64(b.replace('+', ' ')));
    }

    @Test
    @DisplayName("newOrderId fits every provider")
    void newOrderId() {
        Pattern p = Pattern.compile("^[A-Z0-9]{17,20}$");
        for (int i = 0; i < 1000; i++) assertTrue(p.matcher(Payments.newOrderId()).matches());
    }

    @Test
    @DisplayName("auto-submit form escapes values")
    void formEscapes() {
        String html = Html.renderAutoSubmitForm(new InitiateResult.Form("https://x/pay", Map.of("a", "\"><script>")));
        assertTrue(html.contains("&quot;&gt;&lt;script&gt;"));
    }

    // ---------------------------------------------------------------- Python-only cases (scripts/python/tests)

    @Test
    @DisplayName("(python) b64 space restore: \" /  \" decodes to +/++")
    void pythonB64SpaceRestore() {
        assertArrayEquals(new byte[] {(byte) 251, (byte) 255, (byte) 190}, Codec.fromBase64(" /  "));
    }

    @Test
    @DisplayName("(python) form escape renders multipart enctype")
    void pythonFormEnctype() {
        String html = Html.renderAutoSubmitForm(new InitiateResult.Form("https://x", "POST", Map.of("a", "\"><script>"), "multipart/form-data", null));
        assertTrue(html.contains("&quot;&gt;&lt;script&gt;"));
        assertTrue(html.contains("enctype=\"multipart/form-data\""));
    }

    // ---------------------------------------------------------------- Java-only: http() semantics, money edge cases

    @Test
    @DisplayName("http: retries 5xx with 300/600 ms back-off and returns the last response")
    void httpRetries() {
        MockTransport t = new MockTransport().respond(502, "<html>Bad Gateway</html>");
        Http.Response r = new Http(t).request(ProviderId.ESEWA, "https://x/s", Http.Options.get().withRetries(2));
        assertEquals(3, t.calls.size());
        assertEquals(List.of(Duration.ofMillis(300), Duration.ofMillis(600)), t.sleeps);
        assertEquals(502, r.status());
        assertEquals("<html>Bad Gateway</html>", r.data()); // non-JSON body stays text
    }

    @Test
    @DisplayName("http: network failure after retries -> network_error with cause")
    void httpNetworkError() {
        MockTransport t = new MockTransport().handle(r -> {
            throw new IOException("connection reset");
        });
        PaymentException e = assertThrows(PaymentException.class,
                () -> new Http(t).request(ProviderId.KHALTI, "https://dev.khalti.com/api/v2/x/", Http.Options.post(Map.of("a", 1)).withRetries(1)));
        assertEquals("network_error", e.code());
        assertEquals(ProviderId.KHALTI, e.provider());
        assertEquals("request to dev.khalti.com failed: connection reset", e.getMessage());
        assertInstanceOf(IOException.class, e.getCause());
        assertEquals(2, t.calls.size());
    }

    @Test
    @DisplayName("http: default headers, JSON body, BOM stripped, empty body -> null")
    void httpHeadersAndParsing() {
        MockTransport t = new MockTransport().respond("﻿{\"ok\":1.50}");
        Http.Response r = new Http(t).request(ProviderId.NPS, "https://x", Http.Options.post(Map.of("k", "v")));
        HttpTransport.Request req = t.call(0);
        assertEquals("application/json", req.headers().get("Accept"));
        assertEquals("application/json", req.headers().get("Content-Type"));
        assertEquals("{\"k\":\"v\"}", req.body());
        assertEquals(Duration.ofSeconds(15), req.timeout());
        assertEquals(new BigDecimal("1.50"), Js.get(r.data(), "ok"));
        t.respond(204, "");
        assertNull(new Http(t).request(ProviderId.NPS, "https://x", Http.Options.get()).data());
    }

    @Test
    @DisplayName("money: invalid input rejected, negative amounts keep their sign")
    void moneyEdges() {
        assertThrows(IllegalArgumentException.class, () -> Money.rupeesToPaisa("1e3"));
        assertThrows(IllegalArgumentException.class, () -> Money.rupeesToPaisa(".5"));
        assertThrows(IllegalArgumentException.class, () -> Money.rupeesToPaisa(Double.NaN));
        assertEquals(-2000, Money.rupeesToPaisa("-19.995"));
        assertEquals(100000, Money.rupeesToPaisa(new BigDecimal("1000.0")));
        assertEquals("-0.50", Money.paisaToRupees(-50));
        assertEquals("-1.50", Money.paisaToRupees(-150));
        PaymentException e = assertThrows(PaymentException.class, () -> Money.assertPaisa(0, ProviderId.ESEWA));
        assertEquals("invalid_amount", e.code());
    }

    private static VerifyResult result(PaymentStatus status, Long amount) {
        return new VerifyResult(ProviderId.ESEWA, status, "O", amount, null, null);
    }
}

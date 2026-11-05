package np.payments;

import java.util.Map;

/** HTML helpers for {@link InitiateResult.Form} results. */
public final class Html {
    private Html() {}

    /** Escape for safe interpolation into HTML attribute values. */
    public static String escapeHtml(String s) {
        StringBuilder sb = new StringBuilder(s.length());
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '&' -> sb.append("&amp;");
                case '<' -> sb.append("&lt;");
                case '>' -> sb.append("&gt;");
                case '"' -> sb.append("&quot;");
                case '\'' -> sb.append("&#39;");
                default -> sb.append(c);
            }
        }
        return sb.toString();
    }

    /** Server-rendered auto-submitting form. Serve with Content-Type text/html; charset=utf-8. */
    public static String renderAutoSubmitForm(InitiateResult.Form r) {
        StringBuilder inputs = new StringBuilder();
        for (Map.Entry<String, String> e : r.fields().entrySet()) {
            inputs.append("<input type=\"hidden\" name=\"").append(escapeHtml(e.getKey()))
                    .append("\" value=\"").append(escapeHtml(e.getValue())).append("\">");
        }
        return "<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
                + "<title>Redirecting to payment…</title></head><body><form id=\"f\" method=\"POST\" action=\"" + escapeHtml(r.action()) + "\""
                + (r.enctype() != null ? " enctype=\"" + escapeHtml(r.enctype()) + "\"" : "")
                + ">" + inputs + "<noscript><button type=\"submit\">Continue to payment</button></noscript></form>"
                + "<script>document.getElementById(\"f\").submit()</script></body></html>";
    }
}

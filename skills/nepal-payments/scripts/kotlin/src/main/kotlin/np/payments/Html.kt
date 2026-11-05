package np.payments

/** Escape for safe interpolation into HTML text and attribute values. */
fun escapeHtml(s: String): String {
    val out = StringBuilder(s.length + 16)
    for (c in s) {
        when (c) {
            '&' -> out.append("&amp;")
            '<' -> out.append("&lt;")
            '>' -> out.append("&gt;")
            '"' -> out.append("&quot;")
            '\'' -> out.append("&#39;")
            else -> out.append(c)
        }
    }
    return out.toString()
}

/** Server-rendered auto-submitting form for [InitiateResult.Form] results. Serve it as text/html; charset=utf-8. */
fun renderAutoSubmitForm(form: InitiateResult.Form): String {
    val inputs = form.fields.entries.joinToString("") { (k, v) ->
        "<input type=\"hidden\" name=\"${escapeHtml(k)}\" value=\"${escapeHtml(v)}\">"
    }
    val enctype = form.enctype?.let { " enctype=\"${escapeHtml(it)}\"" } ?: ""
    return "<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">" +
        "<title>Redirecting to payment…</title></head><body>" +
        "<form id=\"f\" method=\"POST\" action=\"${escapeHtml(form.action)}\"$enctype>$inputs" +
        "<noscript><button type=\"submit\">Continue to payment</button></noscript></form>" +
        "<script>document.getElementById(\"f\").submit()</script></body></html>"
}

/** Server-rendered HTML helpers. */
import type { FormResult } from "./types.ts";

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Escape for safe interpolation into HTML attribute values. */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

/** JSON for embedding inside an inline <script>: "<" escaped so "</script>" cannot close it. */
export function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

/** `<!doctype html>...<head>` opening shared by every generated page. */
export function pageHead(title: string, withViewport = true): string {
  const viewport = withViewport
    ? `<meta name="viewport" content="width=device-width,initial-scale=1">`
    : "";
  return `<!doctype html><html><head><meta charset="utf-8">${viewport}<title>${title}</title>`;
}

/** Server-rendered auto-submitting form for `kind: "form"` results. */
export function renderAutoSubmitForm(r: FormResult): string {
  const inputs = Object.entries(r.fields)
    .map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`)
    .join("");
  const enctype = r.enctype ? ` enctype="${r.enctype}"` : "";
  return [
    pageHead("Redirecting to payment…"),
    `</head><body>`,
    `<form id="f" method="POST" action="${escapeHtml(r.action)}"${enctype}>`,
    inputs,
    `<noscript><button type="submit">Continue to payment</button></noscript>`,
    `</form>`,
    `<script>document.getElementById("f").submit()</script>`,
    `</body></html>`,
  ].join("");
}

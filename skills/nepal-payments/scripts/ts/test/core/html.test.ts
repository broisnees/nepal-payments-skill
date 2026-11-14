/** Server-rendered HTML helpers. */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { renderAutoSubmitForm } from "../../src/index.ts";

describe("html", () => {
  test("auto-submit form escapes values", () => {
    const html = renderAutoSubmitForm({
      kind: "form",
      action: "https://x/pay",
      method: "POST",
      fields: { a: `"><script>` },
    });
    assert.ok(html.includes("&quot;&gt;&lt;script&gt;"));
  });
});

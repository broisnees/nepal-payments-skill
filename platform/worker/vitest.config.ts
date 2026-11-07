import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: "./wrangler.jsonc" },
      // Workers AI is a remote-only binding; tests never call a model.
      remoteBindings: false,
      miniflare: {
        bindings: { INGEST_MAX_EVENTS: "100", APP_URL: "", GATEWAY_PROBES: "off", BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-0123", INBOUND_ENC_KEY: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=", TEST_MIGRATIONS: await readD1Migrations(fileURLToPath(new URL("./migrations", import.meta.url))) },
        // A low limit so the 429 path is testable; each test uses its own key.
        ratelimits: { INGEST_LIMITER: { namespace_id: "1001", simple: { limit: 8, period: 10 } }, AUTH_LIMITER: { namespace_id: "1002", simple: { limit: 1000, period: 60 } } },
      },
    })),
  ],
  test: {
    setupFiles: ["./test/setup.ts"],
    include: ["test/**/*.test.ts"],
    // Emails are logged in place of sending; keep them out of the test output.
    onConsoleLog: (log) => !log.includes("[discerns email]"),
  },
});

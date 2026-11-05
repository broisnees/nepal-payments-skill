import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: { INGEST_MAX_EVENTS: "100", APP_URL: "", TEST_MIGRATIONS: await readD1Migrations(fileURLToPath(new URL("./migrations", import.meta.url))) },
        // A low limit so the 429 path is testable; each test uses its own key.
        ratelimits: { INGEST_LIMITER: { namespace_id: "1001", simple: { limit: 8, period: 10 } } },
      },
    })),
  ],
  test: {
    setupFiles: ["./test/setup.ts"],
    include: ["test/**/*.test.ts"],
    // Emails are logged in place of sending; keep them out of the test output.
    onConsoleLog: (log) => !log.includes("[paynp email]"),
  },
});

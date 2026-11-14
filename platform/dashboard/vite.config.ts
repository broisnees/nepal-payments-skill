import react from "@vitejs/plugin-react";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";

/**
 * Publishes every docs page as plain Markdown at /docs/<slug>.md, plus /llms.txt listing them, so "Copy page",
 * "View as Markdown" and LLMs reading a link get the source instead of an empty SPA shell.
 */
function docsMarkdown(): Plugin {
  const dir = new URL("./src/public/docs/content/", import.meta.url);
  return {
    name: "docs-markdown",
    apply: "build",
    generateBundle() {
      const lines = ["# discerns", "", "> Payment observability for Nepali gateways: timelines, alerts, analytics, refunds, reconciliation, AI and MCP.", "", "## Docs", ""];
      for (const f of readdirSync(dir).filter((x) => x.endsWith(".md")).sort()) {
        const source = readFileSync(new URL(f, dir), "utf8");
        this.emitFile({ type: "asset", fileName: `docs/${f}`, source });
        const title = /^#\s+(.+)$/m.exec(source)?.[1] ?? f.replace(/\.md$/, "");
        lines.push(`- [${title}](https://discerns.app/docs/${f})`);
      }
      this.emitFile({ type: "asset", fileName: "llms.txt", source: `${lines.join("\n")}\n` });
    },
  };
}

const backend = process.env.PAYNP_BACKEND ?? "http://localhost:8787";
const proxy = (ws = false) => ({ target: backend, changeOrigin: false, ws });

export default defineConfig({
  plugins: [react(), docsMarkdown()],
  resolve: {
    alias: { "@paynp/shared": fileURLToPath(new URL("../shared/src/index.ts", import.meta.url)) },
  },
  server: {
    port: 5173,
    proxy: { "/api": proxy(true), "/auth": proxy(), "/v1": proxy() },
  },
  build: {
    outDir: "../worker/public",
    emptyOutDir: true,
    target: "es2022",
    cssCodeSplit: true,
    reportCompressedSize: true,
  },
  test: { include: ["src/**/*.test.ts"], environment: "node" },
});

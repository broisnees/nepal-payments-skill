import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const backend = "http://localhost:8787";
const proxy = (ws = false) => ({ target: backend, changeOrigin: false, ws });

export default defineConfig({
  plugins: [react()],
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

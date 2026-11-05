import { defineConfig } from "tsup";

// The shared event schema is bundled in (src/shared.ts), so the published package has no dependencies at all.
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "es2022",
  platform: "neutral",
  dts: true,
  clean: true,
  sourcemap: true,
});

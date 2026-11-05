import { defineConfig } from "tsup";

// One self-contained file: the shared files and packages it imports are bundled in; node: builtins are the only imports.
export default defineConfig({
  entry: { paynp: "src/main.ts" },
  format: ["esm"],
  target: "node20",
  platform: "node",
  clean: true,
  banner: { js: "#!/usr/bin/env node" },
  // The codemod's parser and editor are bundled too, so the published CLI is still one file with no dependencies.
  noExternal: ["@babel/parser", "magic-string"],
});

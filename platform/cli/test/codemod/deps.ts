// Real framework packages for the codemod fixtures, installed once per machine into a cache folder
// (npm's cache makes reinstalls offline). Fixtures symlink its node_modules, so tsc and tsx see the
// same packages a real app would. PAYNP_SKIP_DEPS=1 skips the tests that need them.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PACKAGES = {
  "@hono/node-server": "2.1.6",
  "@types/express": "5.0.6",
  "@types/node": "22.20.5",
  "@types/react": "19.3.0",
  "@types/react-dom": "19.3.0",
  express: "5.3.0",
  fastify: "5.12.8",
  hono: "4.13.16",
  next: "16.4.5",
  react: "19.3.0",
  "react-dom": "19.3.0",
  tsx: "4.23.15",
};

export const SDK_DIR = join(import.meta.dirname, "..", "..", "..", "sdk-ts");
export const TSC = join(import.meta.dirname, "..", "..", "..", "node_modules", "typescript", "bin", "tsc");

/** node_modules with every package above plus @paynp/sdk linked to this repo's SDK. */
export function depsDir(): string {
  const dir = process.env.PAYNP_CODEMOD_DEPS ?? join(tmpdir(), "paynp-codemod-deps-v1");
  const pkg = JSON.stringify({ name: "paynp-codemod-deps", private: true, dependencies: PACKAGES }, null, 2);
  const stamp = join(dir, "node_modules", ".paynp-stamp");
  if (!existsSync(stamp) || readFileSync(stamp, "utf8") !== pkg) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), pkg);
    execFileSync("npm", ["install", "--no-audit", "--no-fund", "--prefer-offline", "--loglevel=error"], { cwd: dir, stdio: "inherit" });
    writeFileSync(stamp, pkg);
  }
  // @paynp/sdk is this repo's SDK build. Its exports map only has an "import" condition, which a CommonJS
  // app (the blog's `npm init -y` setup, run by tsx) cannot resolve, so the package.json here adds
  // "default" next to it. Node 22.12+ then loads the ESM build through require().
  if (!existsSync(join(SDK_DIR, "dist", "index.js"))) execFileSync("npm", ["run", "build"], { cwd: SDK_DIR, stdio: "inherit" });
  const link = join(dir, "node_modules", "@paynp", "sdk");
  const sdkPkg = JSON.parse(readFileSync(join(SDK_DIR, "package.json"), "utf8"));
  const root = sdkPkg.exports?.["."] ?? {};
  sdkPkg.exports = { ...sdkPkg.exports, ".": { ...root, default: root.default ?? root.import ?? "./dist/index.js" } };
  rmSync(link, { recursive: true, force: true });
  mkdirSync(link, { recursive: true });
  writeFileSync(join(link, "package.json"), JSON.stringify(sdkPkg, null, 2));
  symlinkSync(join(SDK_DIR, "dist"), join(link, "dist"), "dir");
  return join(dir, "node_modules");
}

// The published package: built with tsup, zero runtime dependencies, nothing imported at runtime.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { VERSION } from "../src/version.ts";

const root = join(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

describe("published package", () => {
  beforeAll(() => {
    execFileSync("npm", ["run", "build"], { cwd: root, stdio: "pipe" });
  }, 60_000);

  it("declares no dependencies and matches the version in src", () => {
    expect(pkg.dependencies).toBeUndefined();
    expect(pkg.peerDependencies).toBeUndefined();
    expect(VERSION).toBe(pkg.version);
  });

  it("dist has no imports at all, and the types are self-contained", () => {
    const js = readFileSync(join(root, "dist/index.js"), "utf8");
    const dts = readFileSync(join(root, "dist/index.d.ts"), "utf8");
    expect(js).not.toMatch(/^\s*import\s/m);
    expect(js).not.toMatch(/\brequire\(/);
    expect(dts).not.toMatch(/from ['"]/);
    expect(dts).toMatch(/declare function createPaynp/);
  });

  it("the built ESM works", async () => {
    const mod = await import(/* @vite-ignore */ join(root, "dist/index.js"));
    const paynp = mod.createPaynp({ dev: false });
    expect(paynp.enabled).toBe(false);
    const m = { startPayment: async () => ({}) };
    expect(paynp.wrapGateway("esewa", m)).toBe(m);
    expect(mod.reasonOf(new Error("eSewa: amount mismatch (1)"))).toBe("amount_mismatch");
  });
});

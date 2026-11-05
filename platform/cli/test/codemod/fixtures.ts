// Apps assembled from the blog's own code blocks (website/src/data/blog-code), the same files a reader
// copies for each framework, plus an app that uses the skill's adapters. Each fixture is a git repo
// with everything committed, like a project right before `paynp init`.
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { esewa } from "../../../../website/src/data/blog-code/esewa.ts";
import { khalti } from "../../../../website/src/data/blog-code/khalti.ts";
import * as shared from "../../../../website/src/data/blog-code/shared/ts.ts";

export type Framework = "express" | "hono" | "nextjs" | "fastify";
type GatewayModule = { ts: { file: string; parts: Record<string, string> } };

const REPO = join(import.meta.dirname, "..", "..", "..", "..");
const GATEWAYS: Record<string, { mod: GatewayModule; names: shared.GatewayNames }> = {
  esewa: { mod: esewa as GatewayModule, names: { id: "esewa", name: "eSewa", ts: "esewa", py: "esewa", php: "EsewaGateway", go: "NewEsewa", java: "EsewaGateway", kotlin: "EsewaGateway" } },
  khalti: { mod: khalti as GatewayModule, names: { id: "khalti", name: "Khalti", ts: "khalti", py: "khalti", php: "KhaltiGateway", go: "NewKhalti", java: "KhaltiGateway", kotlin: "KhaltiGateway" } },
};

const DEPS: Record<Framework, Record<string, string>> = {
  express: { express: "5.3.0" },
  hono: { hono: "4.13.16", "@hono/node-server": "2.1.6" },
  fastify: { fastify: "5.12.8" },
  nextjs: { next: "16.4.5", react: "19.3.0", "react-dom": "19.3.0" },
};

// create-next-app's tsconfig; the others get the strict bundler config the blog's setup implies (tsx runs them).
const TSCONFIG = {
  node: { compilerOptions: { target: "ES2022", module: "preserve", moduleResolution: "bundler", strict: true, noEmit: true, skipLibCheck: true, esModuleInterop: true, lib: ["ES2023", "DOM"], types: ["node"] } },
  nextjs: {
    compilerOptions: {
      target: "ES2017", lib: ["dom", "dom.iterable", "esnext"], allowJs: true, skipLibCheck: true, strict: true, noEmit: true, esModuleInterop: true,
      module: "esnext", moduleResolution: "bundler", resolveJsonModule: true, isolatedModules: true, jsx: "react-jsx", incremental: true,
      plugins: [{ name: "next" }], paths: { "@/*": ["./*"] },
    },
    include: ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts", "**/*.mts"],
    exclude: ["node_modules"],
  },
};

export function write(dir: string, files: Record<string, string>): void {
  for (const [f, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), body);
  }
}

export function git(dir: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
}

export function commitAll(dir: string): void {
  git(dir, "init", "-q", "-b", "main");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "app");
}

/** The files a blog reader saves for one framework and one gateway. */
export function blogFiles(fw: Framework, gateway = "esewa"): Record<string, string> {
  const g = GATEWAYS[gateway];
  const files: Record<string, string> = {};
  for (const b of [shared.types, shared.store, shared.reconcile, ...shared.routes(g.names)[fw]]) files[b.file] = b.code;
  const m = g.mod.ts;
  files[m.file] = ["config", "sign", "start", "confirm"].filter((p) => m.parts[p]).map((p) => m.parts[p]).join("\n\n") + "\n";
  return files;
}

export function blogApp(fw: Framework, opts: { gateway?: string; extra?: Record<string, string> } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), `paynp-codemod-${fw}-`));
  write(dir, {
    ...blogFiles(fw, opts.gateway),
    "package.json": JSON.stringify({ name: "shop", version: "1.0.0", private: true, ...(fw === "nextjs" ? {} : { type: "commonjs" }), dependencies: DEPS[fw] }, null, 2) + "\n",
    "tsconfig.json": JSON.stringify(fw === "nextjs" ? TSCONFIG.nextjs : TSCONFIG.node, null, 2) + "\n",
    ".gitignore": "node_modules\n.env\n.next\n",
    ...opts.extra,
  });
  commitAll(dir);
  return dir;
}

/** An app that copied the skill's TypeScript adapters into src/server/payments, as SKILL.md says. */
export function adapterApp(): string {
  const dir = mkdtempSync(join(tmpdir(), "paynp-codemod-adapters-"));
  const src = join(REPO, "skills", "nepal-payments", "scripts", "ts", "src");
  mkdirSync(join(dir, "src", "server", "payments"), { recursive: true });
  for (const f of readdirSync(src)) cpSync(join(src, f), join(dir, "src", "server", "payments", f));
  write(dir, {
    "package.json": JSON.stringify({ name: "shop", private: true, type: "module", dependencies: { express: "5.3.0" } }, null, 2) + "\n",
    "tsconfig.json":
      JSON.stringify(
        { compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, noEmit: true, skipLibCheck: true, allowImportingTsExtensions: true, verbatimModuleSyntax: true, lib: ["ES2022", "DOM"], types: ["node"] } },
        null,
        2,
      ) + "\n",
    ".gitignore": "node_modules\n.env\n",
    "src/server/checkout.ts": `import express from "express";
import { createPayments, ESEWA_SANDBOX, newOrderId, paymentsConfigFromEnv, type ProviderId } from "./payments/index.ts";
import { esewa } from "./payments/index.ts";

const cfg = paymentsConfigFromEnv();
cfg.esewa ??= { env: "sandbox", ...ESEWA_SANDBOX };
const payments = createPayments(cfg);
const direct = esewa({ env: "sandbox", ...ESEWA_SANDBOX });

export const app = express();

app.post("/pay/:provider", async (req, res) => {
  const provider = req.params.provider as ProviderId;
  const orderId = newOrderId();
  const r = await payments.adapter(provider).initiate({ orderId, amountPaisa: 10000, description: "Order", returnUrl: \`http://localhost:3000/return/\${provider}/\${orderId}\` });
  res.json(r);
});

app.get("/return/esewa/:orderId", async (req, res) => {
  const v = await direct.verify({ orderId: req.params.orderId, amountPaisa: 10000, callback: req.query as Record<string, string> });
  const typed = await payments.get("esewa").verify({ orderId: req.params.orderId, amountPaisa: 10000 });
  res.json({ v, typed });
});
`,
    "src/server/types-only.ts": `import type { PaymentAdapter } from "./payments/index.ts";\nexport type A = PaymentAdapter;\n`,
  });
  commitAll(dir);
  return dir;
}

/** node_modules for tsc and tsx: a symlink to the shared deps folder. */
export function linkDeps(dir: string, nodeModules: string): void {
  symlinkSync(nodeModules, join(dir, "node_modules"), "dir");
}

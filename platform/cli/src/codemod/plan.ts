// Plans the edits that wire paynp into a JS/TS app. Nothing is written here: the plan holds the
// before and after text of every file, `applyPlan` writes them.
import MagicString from "magic-string";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, relative, sep } from "node:path";
import type { StackId } from "../stacks.ts";
import { exportedNames, hasMultilineTemplate, indentAt, lastImport, lineStart, parseFile, styleOf, walk, type t } from "./ast.ts";
import { dirtyFiles, insideProject, readAliases, resolveSpec, sourceFiles, type Aliases } from "./files.ts";
import { GATEWAY_NAMES, MARKER, actionsFile, adapterFile, gatewayFile, nextActionRoute, type Style } from "./templates.ts";

export const GATEWAY_IDS = Object.keys(GATEWAY_NAMES);
const ADAPTER_PACKAGE = "nepal-payments";
const WRAPPED = new Set([...GATEWAY_IDS, "createPayments"]);
const HANDLERS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
const PAYNP_EXTS = [".ts", ".mts", ".tsx", ".js", ".mjs", ".jsx"];
const SOURCE_EXT = /\.[cm]?[jt]sx?$/;
/** Code that already serves paynp actions. */
export const ACTION_ROUTE = /\b(?:nodeActionHandler|actionHandler)\s*\(|["'`]\/paynp\/actions["'`]/;
export const ACTION_PATH = "/paynp/actions";

export interface Change {
  file: string;
  rel: string;
  before: string | null; // null: new file
  after: string;
  what: string[];
}

export interface Plan {
  changes: Change[];
  skipped: { rel: string; reason: string }[];
  manual: string[];
  already: string[]; // files that are wired already
  /** Gateway modules or adapter imports were found (wired or not). False means: print the snippet. */
  found: boolean;
}

export interface PlanOptions {
  stack: StackId;
  force?: boolean;
  /** Files this run of init just wrote: their uncommitted changes are init's own, so they stay editable. */
  wrote?: string[];
}

type Serverless = { kind: "next"; after: boolean } | { kind: "workers"; hono: boolean } | null;

class Project {
  readonly files: string[];
  readonly aliases: Aliases;
  private readonly dirty: Set<string> | null;
  private readonly texts = new Map<string, string>();
  private readonly asts = new Map<string, t.File | null>();
  private readonly edits = new Map<string, { ms: MagicString; what: string[] }>();
  private readonly created = new Map<string, { text: string; what: string[] }>();
  private readonly skippedFiles = new Map<string, string>();
  readonly manual: string[] = [];
  readonly already = new Set<string>();
  found = false;

  readonly cwd: string;
  readonly opts: PlanOptions;

  /** Text of files as another plan leaves them (path -> text), for a plan that builds on one not yet written. */
  private readonly overlay: Map<string, string>;

  constructor(cwd: string, opts: PlanOptions, overlay = new Map<string, string>()) {
    this.cwd = cwd;
    this.opts = opts;
    this.overlay = overlay;
    const onDisk = sourceFiles(cwd);
    this.files = [...new Set([...onDisk, ...[...overlay.keys()].filter((f) => SOURCE_EXT.test(f))])].sort();
    this.aliases = readAliases(cwd);
    this.dirty = dirtyFiles(cwd);
  }

  exists(f: string): boolean {
    return this.overlay.has(f) || existsSync(f);
  }

  rel(f: string): string {
    return relative(this.cwd, f).split(sep).join("/");
  }

  text(f: string): string {
    let s = this.texts.get(f);
    if (s === undefined) {
      s = this.overlay.get(f) ?? readFileSync(f, "utf8");
      this.texts.set(f, s);
    }
    return s;
  }

  ast(f: string): t.File | null {
    if (!this.asts.has(f)) this.asts.set(f, parseFile(this.text(f), f));
    return this.asts.get(f)!;
  }

  resolve(from: string, spec: string): string | null {
    const hit = resolveSpec(from, spec, this.aliases);
    if (hit || !this.overlay.size) return hit;
    // A file the base plan creates (paynp.ts) is not on disk yet.
    let base: string | null = null;
    if (spec.startsWith("./") || spec.startsWith("../")) base = join(dirname(from), spec);
    else for (const [prefix, targets] of this.aliases.paths) if (spec.startsWith(prefix) && targets[0] !== undefined) base = join(this.aliases.baseUrl, targets[0] + spec.slice(prefix.length));
    if (!base) return null;
    const stemmed = base.replace(/\.[cm]?js$/, "");
    for (const f of this.overlay.keys()) if (f === base || f.replace(/\.[cm]?[jt]sx?$/, "") === stemmed) return f;
    return null;
  }

  /** May this file be edited? Records why not. */
  editable(f: string): boolean {
    if (this.skippedFiles.has(f)) return false;
    if (!insideProject(this.cwd, f)) {
      this.skippedFiles.set(f, "outside the project");
      return false;
    }
    if (!this.opts.force && !this.overlay.has(f) && !this.opts.wrote?.includes(f) && this.dirty && existsSync(f) && this.dirty.has(realpathSync(f))) {
      this.skippedFiles.set(f, "has uncommitted changes (commit or stash them, or rerun with --force)");
      return false;
    }
    return true;
  }

  edit(f: string, what: string): MagicString {
    let e = this.edits.get(f);
    if (!e) {
      e = { ms: new MagicString(this.text(f)), what: [] };
      this.edits.set(f, e);
    }
    if (!e.what.includes(what)) e.what.push(what);
    return e.ms;
  }

  create(f: string, text: string, what: string): void {
    this.created.set(f, { text, what: [what] });
  }

  willCreate(f: string): boolean {
    return this.created.has(f);
  }

  plan(): Plan {
    const changes: Change[] = [];
    for (const [file, { text, what }] of this.created) changes.push({ file, rel: this.rel(file), before: null, after: text, what });
    for (const [file, { ms, what }] of this.edits) {
      const after = ms.toString();
      if (after !== this.text(file)) changes.push({ file, rel: this.rel(file), before: this.text(file), after, what });
    }
    changes.sort((a, b) => (a.before === null) !== (b.before === null) ? (a.before === null ? -1 : 1) : a.rel < b.rel ? -1 : 1);
    return {
      changes,
      skipped: [...this.skippedFiles].map(([f, reason]) => ({ rel: this.rel(f), reason })),
      manual: this.manual,
      already: [...this.already].sort(),
      found: this.found,
    };
  }
}

// ---------------------------------------------------------------- helpers

const stem = (f: string) => basename(f, extname(f));
const isPaynpFile = (f: string) => stem(f) === "paynp";

/** "./esewa.js" -> "./paynp.js", "@/esewa" -> "@/paynp". */
function swapStem(spec: string, to: string): string {
  const m = /^(.*\/)?([^/]+?)(\.[cm]?[jt]sx?)?$/.exec(spec)!;
  return (m[1] ?? "") + to + (m[3] ?? "");
}

/** The paynp file in a folder: an existing one, else a new one whose extension follows `like`. */
function paynpPath(dir: string, like: string): string {
  for (const e of PAYNP_EXTS) if (existsSync(join(dir, "paynp" + e))) return join(dir, "paynp" + e);
  const e = extname(like);
  return join(dir, "paynp" + (e === ".mts" ? ".mts" : e === ".mjs" ? ".mjs" : [".js", ".jsx", ".cjs"].includes(e) ? ".js" : ".ts"));
}

/** A relative specifier from one file to another, with the extension style the importing file uses. */
function relSpec(p: Project, fromFile: string, toFile: string): string {
  let r = relative(dirname(fromFile), toFile).split(sep).join("/");
  if (!r.startsWith(".")) r = "./" + r;
  const base = r.slice(0, -extname(r).length);
  const ast = p.ast(fromFile);
  const specs = ast ? ast.program.body.flatMap((s) => (s.type === "ImportDeclaration" && s.source.value.startsWith(".") ? [s.source.value] : [])) : [];
  if (specs.some((s) => /\.ts$/.test(s))) return base + ".ts";
  if (specs.some((s) => /\.js$/.test(s))) return base + ".js";
  return base;
}

function serverless(p: Project): Serverless {
  if (p.opts.stack === "nextjs") {
    let after = true;
    try {
      const pkg = JSON.parse(readFileSync(join(p.cwd, "package.json"), "utf8"));
      const v = String({ ...pkg.devDependencies, ...pkg.dependencies }.next ?? "");
      const major = /(\d+)/.exec(v);
      if (major && Number(major[1]) < 15) after = false; // after() is stable from Next.js 15
    } catch {
      /* keep after */
    }
    return { kind: "next", after };
  }
  if (["wrangler.toml", "wrangler.json", "wrangler.jsonc"].some((f) => existsSync(join(p.cwd, f)))) return { kind: "workers", hono: p.opts.stack === "hono" };
  return null;
}

const isRouteFile = (rel: string) => /(^|\/)app\/(.+\/)?route\.[cm]?[jt]sx?$/.test(rel);
const isPagesApi = (rel: string) => /(^|\/)pages\/api\//.test(rel);

function styleFor(p: Project, file: string, workers: boolean): Style {
  const ast = p.ast(file);
  const s = ast ? styleOf(p.text(file), ast) : { q: '"', semi: ";" };
  return { ...s, ts: /\.[cm]?tsx?$/.test(file), workers };
}

/** Does the file need `paynp` in scope for a flush hook, and is that hook possible? */
function needsFlush(p: Project, file: string, sl: Serverless): "next" | "workers" | null {
  if (!sl) return null;
  const rel = p.rel(file);
  if (sl.kind === "next") {
    if (isRouteFile(rel)) {
      if (sl.after) return "next";
      p.manual.push(`${rel}: Next.js before 15 has no after(). Call \`await paynp.flush()\` before each handler returns.`);
    } else if (isPagesApi(rel)) {
      p.manual.push(`${rel}: call \`await paynp.flush()\` before the handler sends its response (import paynp from the paynp file).`);
    }
    return null;
  }
  const ast = p.ast(file);
  if (sl.hono && ast && honoApp(ast)) return "workers";
  p.manual.push(`${rel}: on Workers, hand the send to the runtime after the response: \`ctx.waitUntil(paynp.flush())\` (Hono: \`c.executionCtx.waitUntil(paynp.flush())\`).`);
  return null;
}

/** `const app = new Hono(...)` at the top level. */
function honoApp(ast: t.File): t.VariableDeclaration | null {
  for (const s of ast.program.body) {
    const d = s.type === "ExportNamedDeclaration" ? s.declaration : s;
    if (d?.type !== "VariableDeclaration") continue;
    for (const v of d.declarations) if (v.init?.type === "NewExpression" && v.init.callee.type === "Identifier" && v.init.callee.name === "Hono" && v.id.type === "Identifier") return d;
  }
  return null;
}

/** Adds the flush hook to a file whose imports now include `paynp` (as `ref`, e.g. "paynp" or "np.paynp"). */
function addFlush(p: Project, file: string, kind: "next" | "workers", ref: string): void {
  const code = p.text(file);
  const ast = p.ast(file)!;
  const flushCall = `${ref}.flush()`;
  const { q, semi } = styleOf(code, ast);
  if (kind === "workers") {
    if (code.includes(flushCall)) return;
    const decl = honoApp(ast)!;
    const appName = (decl.declarations.find((v) => v.init?.type === "NewExpression")!.id as t.Identifier).name;
    const ind = indentAt(code, decl.start!);
    const unit = indentUnit(code);
    p.edit(file, "sends events with c.executionCtx.waitUntil() after each response").appendLeft(
      decl.end!,
      `\n${ind}${appName}.use(async (c, next) => {\n${ind}${unit}await next()${semi}\n${ind}${unit}c.executionCtx.waitUntil(${flushCall})${semi}\n${ind}})${semi}`,
    );
    return;
  }
  // Next.js route handlers: after() runs once the response is sent, before the function is frozen.
  const bodies: t.BlockStatement[] = [];
  for (const s of ast.program.body) {
    if (s.type !== "ExportNamedDeclaration" || !s.declaration) continue;
    const d = s.declaration;
    if (d.type === "FunctionDeclaration" && d.id && HANDLERS.has(d.id.name)) bodies.push(d.body);
    if (d.type === "VariableDeclaration") {
      for (const v of d.declarations) {
        if (v.id.type !== "Identifier" || !HANDLERS.has(v.id.name)) continue;
        const init = v.init;
        if ((init?.type === "ArrowFunctionExpression" || init?.type === "FunctionExpression") && init.body.type === "BlockStatement") bodies.push(init.body);
      }
    }
  }
  const todo = bodies.filter((b) => !code.slice(b.start!, b.end!).includes(flushCall));
  if (!todo.length) return;
  const ms = p.edit(file, "sends events with after(() => paynp.flush()) once the response is out");
  const unit = indentUnit(code);
  for (const b of todo) {
    const first = b.body[0];
    const ind = first ? indentAt(code, first.start!) : indentAt(code, b.start!) + unit;
    ms.appendLeft(b.start! + 1, `\n${ind}after(() => ${flushCall})${semi}`);
  }
  // import { after } from "next/server"
  const nextImport = ast.program.body.find((s): s is t.ImportDeclaration => s.type === "ImportDeclaration" && s.source.value === "next/server" && s.importKind !== "type");
  const hasAfter = nextImport?.specifiers.some((sp) => sp.type === "ImportSpecifier" && sp.local.name === "after");
  if (hasAfter) return;
  const named = nextImport?.specifiers.filter((sp) => sp.type === "ImportSpecifier") ?? [];
  if (nextImport && named.length) ms.appendLeft(named[named.length - 1].end!, ", after");
  else {
    const firstImport = ast.program.body.find((s) => s.type === "ImportDeclaration");
    const at = firstImport ? firstImport.start! : 0;
    ms.prependLeft(at, `import { after } from ${q}next/server${q}${semi}\n`);
  }
}

function indentUnit(code: string): string {
  const m = /\n([ \t]+)\S/.exec(code);
  return m ? (m[1].startsWith("\t") ? "\t" : m[1].length >= 4 && m[1].length % 4 === 0 && !/\n {2}\S/.test(code) ? "    " : "  ") : "  ";
}

// ---------------------------------------------------------------- blog gateway modules

interface GwSite {
  file: string;
  module: string;
  local: string;
  spec: string;
  kind: "static" | "dynamic";
  decl: t.ImportDeclaration | t.VariableDeclarator;
  literal: t.StringLiteral;
}

function isGatewayModule(p: Project, f: string): boolean {
  if (!GATEWAY_IDS.includes(stem(f).toLowerCase())) return false;
  const ast = p.ast(f);
  if (!ast) return false;
  const names = exportedNames(ast);
  return names.has("startPayment") || names.has("confirmPayment");
}

function findGatewaySites(p: Project): GwSite[] {
  const sites: GwSite[] = [];
  for (const file of p.files) {
    if (isPaynpFile(file)) continue;
    const code = p.text(file);
    if (!GATEWAY_IDS.some((g) => code.includes(g)) && !code.includes("paynp") && !/import\s*\(/.test(code)) continue;
    const ast = p.ast(file);
    if (!ast) continue;
    const gw = (spec: string) => {
      const target = p.resolve(file, spec);
      return target && target !== file && isGatewayModule(p, target) ? target : null;
    };
    for (const s of ast.program.body) {
      if (s.type !== "ImportDeclaration" || s.importKind === "type") continue;
      const target = gw(s.source.value);
      if (!target) {
        const t2 = p.resolve(file, s.source.value);
        if (t2 && isPaynpFile(t2) && wrappedIn(p, t2).length) {
          p.found = true;
          p.already.add(p.rel(file));
        }
        continue;
      }
      p.found = true;
      const ns = s.specifiers.length === 1 && s.specifiers[0].type === "ImportNamespaceSpecifier" ? s.specifiers[0] : null;
      if (ns) sites.push({ file, module: target, local: ns.local.name, spec: s.source.value, kind: "static", decl: s, literal: s.source });
      else if (s.specifiers.some((sp) => sp.type !== "ImportSpecifier" || sp.importKind !== "type") && s.specifiers.length) {
        p.manual.push(`${p.rel(file)}: imports names from "${s.source.value}". Import the wrapped module instead: \`import { gateway } from "${swapStem(s.source.value, "paynp")}"\`, then call gateway.startPayment / gateway.confirmPayment.`);
      }
    }
    // const gateway = await import("./esewa")  (Next.js instrumentation.ts)
    walk(ast, (n) => {
      if (n.type === "VariableDeclarator" && n.id.type === "Identifier" && n.init?.type === "AwaitExpression") {
        const call = n.init.argument;
        if (call.type === "CallExpression" && call.callee.type === "Import" && call.arguments[0]?.type === "StringLiteral") {
          const lit = call.arguments[0];
          const target = gw(lit.value);
          if (target) {
            p.found = true;
            sites.push({ file, module: target, local: n.id.name, spec: lit.value, kind: "dynamic", decl: n, literal: lit });
          }
        }
        return;
      }
      if (n.type === "CallExpression" && n.arguments[0]?.type === "StringLiteral" && (n.callee.type === "Import" || (n.callee.type === "Identifier" && n.callee.name === "require"))) {
        const lit = n.arguments[0];
        if (gw(lit.value) && !sites.some((s) => s.literal === lit)) {
          p.found = true;
          p.manual.push(`${p.rel(file)}: loads "${lit.value}" with ${n.callee.type === "Import" ? "import()" : "require()"}. Load the wrapped module from "${swapStem(lit.value, "paynp")}" instead.`);
        }
      }
    });
  }
  return sites;
}

/** Gateways a paynp file wraps: the ids in its paynp.wrapGateway("esewa", ...) calls. */
function wrappedIn(p: Project, f: string): string[] {
  const ast = p.ast(f);
  const ids: string[] = [];
  if (!ast) return ids;
  walk(ast, (n) => {
    if (n.type === "CallExpression" && n.callee.type === "MemberExpression" && n.callee.property.type === "Identifier" && n.callee.property.name === "wrapGateway" && n.arguments[0]?.type === "StringLiteral") {
      ids.push(n.arguments[0].value);
    }
  });
  return ids;
}

function readIfOurs(f: string): boolean {
  try {
    return readFileSync(f, "utf8").includes(MARKER);
  } catch {
    return false;
  }
}

function wireGateways(p: Project, sl: Serverless): { paynpFile: string; gateway: string }[] {
  const sites = findGatewaySites(p);
  const byDir = new Map<string, GwSite[]>();
  for (const s of sites) {
    const d = dirname(s.module);
    byDir.set(d, [...(byDir.get(d) ?? []), s]);
  }
  const wired: { paynpFile: string; gateway: string }[] = [];
  // Already wired on an earlier run: settle() may still need its hook (it was dirty then, say).
  for (const rel of p.already) {
    const f = join(p.cwd, rel);
    for (const s of p.ast(f)?.program.body ?? []) {
      if (s.type !== "ImportDeclaration") continue;
      const target = p.resolve(f, s.source.value);
      if (target && isPaynpFile(target)) for (const g of wrappedIn(p, target)) wired.push({ paynpFile: target, gateway: g });
    }
  }
  for (const [dir, group] of byDir) {
    const modules = [...new Set(group.map((s) => s.module))].sort();
    const exportName = (m: string) => (modules.length === 1 ? "gateway" : stem(m).toLowerCase());
    const file = paynpPath(dir, modules[0]);
    const relFile = p.rel(file);
    if (existsSync(file)) {
      const ast = p.ast(file);
      const names = ast ? exportedNames(ast) : new Set<string>();
      const missing = modules.map(exportName).filter((n) => !names.has(n));
      if (!names.has("paynp") || missing.length) {
        p.manual.push(
          names.has("paynp")
            ? `${relFile} exists but has no ${missing.map((n) => `\`${n}\``).join(", ")} export. Add \`export const ${missing[0]} = paynp.wrapGateway("${modules.length === 1 ? stem(modules[0]) : missing[0]}", ...)\` there.`
            : `${relFile} exists and was not written by paynp init, so I left the gateway imports alone. Move it away and run init again.`,
        );
        continue;
      }
    }
    const editable = group.filter((s) => p.editable(s.file));
    if (!existsSync(file)) {
      if (!editable.length) continue;
      if (!p.editable(file)) continue;
      const first = editable[0];
      const style = styleFor(p, first.file, sl?.kind === "workers");
      const specOf = (m: string) => {
        const site = group.find((s) => s.module === m)!;
        // Same extension style the routes use: "./esewa", "./esewa.js" or "./esewa.ts".
        const ext = /\.[cm]?[jt]sx?$/.exec(site.spec)?.[0] ?? "";
        return "./" + stem(m) + ext;
      };
      p.create(
        file,
        gatewayFile(style, modules.map((m) => ({ id: stem(m).toLowerCase(), spec: specOf(m), exportName: exportName(m) }))),
        `wraps ${modules.map((m) => GATEWAY_NAMES[stem(m).toLowerCase()]).join(", ")} with createPaynp`,
      );
    }
    for (const s of editable) {
      const code = p.text(s.file);
      const name = exportName(s.module);
      const newSpec = swapStem(s.spec, "paynp");
      const flush = s.kind === "static" ? needsFlush(p, s.file, sl) : null;
      const what = `imports ${name} from ${newSpec}`;
      const ms = p.edit(s.file, what);
      if (s.kind === "static") {
        const decl = s.decl as t.ImportDeclaration;
        const q = code[decl.source.start!];
        const names = [name === s.local ? name : `${name} as ${s.local}`];
        if (flush && s.local !== "paynp") names.push("paynp");
        ms.overwrite(decl.start!, decl.end!, `import { ${names.join(", ")} } from ${q}${newSpec}${q}${code[decl.end! - 1] === ";" ? ";" : ""}`);
        if (flush) addFlush(p, s.file, flush, "paynp");
      } else {
        const v = s.decl as t.VariableDeclarator;
        ms.overwrite(v.id.start!, v.id.end!, `{ ${name === s.local ? name : `${name}: ${s.local}`} }`);
        ms.overwrite(s.literal.start! + 1, s.literal.end! - 1, newSpec);
      }
    }
    if (modules.length === 1) wired.push({ paynpFile: file, gateway: stem(modules[0]).toLowerCase() });
    else wired.push(...modules.map((m) => ({ paynpFile: file, gateway: stem(m).toLowerCase() })));
  }
  return wired;
}

// ---------------------------------------------------------------- settle() in payments.ts

function hookSettle(p: Project, wired: { paynpFile: string; gateway: string }[]): void {
  // The blog's payments.ts: export function settle(attempt, outcome)
  let file: string | null = null;
  let fn: t.FunctionDeclaration | null = null;
  for (const f of p.files) {
    if (isPaynpFile(f) || !p.text(f).includes("settle")) continue;
    const ast = p.ast(f);
    for (const s of ast?.program.body ?? []) {
      if (s.type === "ExportNamedDeclaration" && s.declaration?.type === "FunctionDeclaration" && s.declaration.id?.name === "settle") {
        file = f;
        fn = s.declaration;
      }
    }
    if (file) break;
  }
  if (!file || !fn) return;
  const rel = p.rel(file);
  const code = p.text(file);
  if (code.slice(fn.start!, fn.end!).includes("paynp.")) return void p.already.add(rel);
  const ids = [...new Set(wired.map((w) => w.gateway))];
  const paynpFiles = [...new Set(wired.map((w) => w.paynpFile))];
  if (!ids.length) return;
  const manual = (why: string): void =>
    void p.manual.push(
      `${rel}: ${why} In settle(), where transition() moved the attempt, add \`paynp.statusChanged({ attemptId, gateway, to })\`, and \`paynp.fulfilled({ attemptId, gateway, orderId })\` next to fulfil().`,
    );
  if (ids.length !== 1 || paynpFiles.length !== 1) return manual("the app has several gateways and settle() does not know which one an attempt used.");
  const gid = ids[0];
  const paynpFile = paynpFiles[0];
  if (!existsSync(paynpFile) && !p.willCreate(paynpFile)) return;

  const attempt = fn.params[0]?.type === "Identifier" ? fn.params[0].name : null;
  let moved: t.IfStatement | null = null;
  let pending: t.ExpressionStatement | null = null;
  const isTransition = (n: t.Node | null | undefined): n is t.CallExpression =>
    n?.type === "CallExpression" && n.callee.type === "Identifier" && n.callee.name === "transition" && n.arguments.length === 3;
  walk(fn.body, (n) => {
    if (n.type === "IfStatement" && n.test.type === "LogicalExpression" && n.test.operator === "&&" && isTransition(n.test.left)) {
      const r = n.test.right;
      if (r.type === "BinaryExpression" && r.operator === "===" && r.right.type === "StringLiteral" && r.right.value === "paid") moved = n;
    }
    if (n.type === "ExpressionStatement" && isTransition(n.expression)) pending = n;
  });
  const m = moved as t.IfStatement | null;
  if (!attempt || !m) return manual("settle() does not have the shape I know (`if (transition(...) && s === \"paid\") { ... fulfil(...) }`).");
  const cons = m.consequent;
  const oneLine = cons.type === "ExpressionStatement" && !code.slice(cons.start!, cons.end!).includes("\n");
  const block = cons as t.BlockStatement;
  const closeLine = cons.type === "BlockStatement" ? lineStart(code, block.end! - 1) : 0;
  if (!m.alternate && cons.type === "BlockStatement") {
    if (code.slice(closeLine, block.end! - 1).trim() !== "" || !block.body.length) return manual("settle() is formatted in a way I don't edit safely.");
  } else if (m.alternate || !oneLine) return manual("settle() is formatted in a way I don't edit safely.");
  if (!p.editable(file)) return;

  const style = styleOf(code, p.ast(file)!);
  const { q, semi } = style;
  const unit = indentUnit(code);
  const test = m.test as t.LogicalExpression;
  const tr = test.left as t.CallExpression;
  const toText = code.slice(tr.arguments[2].start!, tr.arguments[2].end!);
  const fields = (to: string) => `{ attemptId: ${attempt}.id, gateway: ${q}${gid}${q}, to: ${to}, orderId: ${attempt}.orderId, amountPaisa: ${attempt}.amountPaisa }`;
  const fulfilled = `paynp.fulfilled({ attemptId: ${attempt}.id, gateway: ${q}${gid}${q}, orderId: ${attempt}.orderId, amountPaisa: ${attempt}.amountPaisa })${semi}`;
  const ms = p.edit(file, "settle() reports each status change and the fulfilment");
  const paidTest = code.slice(test.right.start!, test.right.end!);

  if (oneLine) {
    // Earlier blog version: if (transition(...) && s === "paid") fulfil(attempt.orderId);
    const ind = indentAt(code, m.start!);
    ms.overwrite(
      m.start!,
      m.end!,
      [
        `if (${code.slice(tr.start!, tr.end!)}) {`,
        `${ind}${unit}paynp.statusChanged(${fields(toText)})${semi}`,
        `${ind}${unit}if (${paidTest}) {`,
        `${ind}${unit}${unit}${code.slice(cons.start!, cons.end!)}`,
        `${ind}${unit}${unit}${fulfilled}`,
        `${ind}${unit}}`,
        `${ind}}`,
      ].join("\n"),
    );
  } else {
    // if (transition(...) && s === "paid") { A; fulfil() }
    //   ->  if (transition(...)) { statusChanged; if (s === "paid") { A; fulfil(); fulfilled } }
    const inner = indentAt(code, block.body[0].start!);
    ms.remove(tr.end!, test.end!);
    ms.appendLeft(block.start! + 1, `\n${inner}paynp.statusChanged(${fields(toText)})${semi}\n${inner}if (${paidTest}) {`);
    if (!hasMultilineTemplate(block, code)) {
      for (let i = code.indexOf("\n", block.start!) + 1; i > 0 && i < closeLine; i = code.indexOf("\n", i) + 1) {
        if (code[i] !== "\n" && code[i] !== "\r") ms.prependRight(i, unit);
      }
    }
    const fulfil = block.body.find((s) => s.type === "ExpressionStatement" && s.expression.type === "CallExpression" && s.expression.callee.type === "Identifier" && s.expression.callee.name === "fulfil");
    ms.appendLeft((fulfil ?? block.body[block.body.length - 1]).end!, `\n${inner}${unit}${fulfilled}`);
    ms.appendLeft(closeLine, `${inner}}\n`);
  }

  // transition(id, ["initiated"], "pending");  ->  if (transition(...)) { statusChanged }
  const pend = pending as t.ExpressionStatement | null;
  if (pend) {
    const call = pend.expression as t.CallExpression;
    const ind = indentAt(code, pend.start!);
    const callText = code.slice(call.start!, call.end!);
    const to = code.slice(call.arguments[2].start!, call.arguments[2].end!);
    ms.overwrite(pend.start!, pend.end!, `if (${callText}) {\n${ind}${unit}paynp.statusChanged(${fields(to)})${semi}\n${ind}}`);
  }

  // import { paynp } from "./paynp"
  const last = lastImport(p.ast(file)!);
  const line = `import { paynp } from ${q}${relSpec(p, file, paynpFile)}${q}${semi}`;
  if (last) ms.appendLeft(last.end!, `\n${line}`);
  else ms.prependLeft(0, `${line}\n`);
}

// ---------------------------------------------------------------- skill adapters

interface AdSite {
  file: string;
  decl: t.ImportDeclaration;
  lib: string; // index file, or the package name
}

function isAdapterLib(p: Project, f: string): boolean {
  if (isPaynpFile(f)) return false;
  const ast = p.ast(f);
  if (!ast) return false;
  const names = exportedNames(ast);
  return names.has("createPayments") && GATEWAY_IDS.some((g) => names.has(g));
}

function wireAdapters(p: Project, sl: Serverless): void {
  const sites: AdSite[] = [];
  for (const file of p.files) {
    if (isPaynpFile(file)) continue;
    const code = p.text(file);
    if (!code.includes("createPayments") && !GATEWAY_IDS.some((g) => code.includes(g + "("))) continue;
    const ast = p.ast(file);
    if (!ast) continue;
    for (const s of ast.program.body) {
      if (s.type !== "ImportDeclaration" || s.importKind === "type") continue;
      const spec = s.source.value;
      let lib: string | null = null;
      if (spec === ADAPTER_PACKAGE) lib = spec;
      else {
        const target = p.resolve(file, spec);
        if (target && isAdapterLib(p, target) && !file.startsWith(dirname(target) + sep)) lib = target;
        else if (target && isPaynpFile(target) && readIfOurs(target) && p.text(target).includes("wrapAdapter")) {
          p.found = true;
          p.already.add(p.rel(file));
        }
      }
      if (!lib) continue;
      const wraps = s.specifiers.some((sp) => sp.type === "ImportNamespaceSpecifier" || (sp.type === "ImportSpecifier" && sp.importKind !== "type" && WRAPPED.has(sp.imported.type === "Identifier" ? sp.imported.name : sp.imported.value)));
      if (!wraps) continue;
      p.found = true;
      sites.push({ file, decl: s, lib });
    }
  }
  const byLib = new Map<string, AdSite[]>();
  for (const s of sites) byLib.set(s.lib, [...(byLib.get(s.lib) ?? []), s]);

  for (const [lib, group] of byLib) {
    const pkg = lib === ADAPTER_PACKAGE;
    const indexStyle = !pkg && stem(lib) === "index";
    // paynp goes next to the library: beside its folder for an index.ts, beside the file otherwise.
    let dir: string;
    if (pkg) {
      dir = dirname(group[0].file);
      for (const s of group) while (!(s.file.startsWith(dir + sep))) dir = dirname(dir);
    } else dir = indexStyle ? dirname(dirname(lib)) : dirname(lib);
    if (!insideProject(p.cwd, join(dir, "paynp.ts"))) {
      p.manual.push(`${p.rel(group[0].file)}: the adapters sit at the project root, so there is no folder beside them for paynp.ts. Wrap each adapter with paynp.wrapAdapter() yourself.`);
      continue;
    }
    const file = paynpPath(dir, pkg ? group[0].file : lib);
    const relFile = p.rel(file);
    if (existsSync(file) && !readIfOurs(file)) {
      p.manual.push(`${relFile} exists and was not written by paynp init, so I left the adapter imports alone. Move it away and run init again.`);
      continue;
    }
    const editable = group.filter((s) => p.editable(s.file));
    if (!existsSync(file)) {
      if (!editable.length || !p.editable(file)) continue;
      const first = group[0];
      const style = styleFor(p, first.file, sl?.kind === "workers");
      let libSpec = ADAPTER_PACKAGE;
      let factories = GATEWAY_IDS;
      let hasCreate = true;
      if (!pkg) {
        // Same style as the import it replaces: "./payments/index.ts", "./payments/index.js", "./payments", ...
        const spec = first.decl.source.value;
        const ext = /\.[cm]?[jt]sx?$/.exec(spec)?.[0] ?? "";
        const named = /\/index(\.[cm]?[jt]sx?)?$/.test(spec);
        libSpec = indexStyle ? `./${basename(dirname(lib))}${named ? `/index${ext}` : ""}` : `./${stem(lib)}${ext}`;
        const names = exportedNames(p.ast(lib)!);
        factories = GATEWAY_IDS.filter((g) => names.has(g));
        hasCreate = names.has("createPayments");
      }
      p.create(file, adapterFile(style, libSpec, factories, hasCreate), `wraps the nepal-payments adapters with createPaynp`);
    }
    for (const s of editable) {
      const src = s.decl.source;
      let newSpec: string;
      if (pkg) newSpec = relSpec(p, s.file, file);
      else {
        const spec = src.value;
        const ext = /\.[cm]?[jt]sx?$/.exec(spec)?.[0] ?? "";
        const base = indexStyle ? spec.replace(/\/index(\.[cm]?[jt]sx?)?$/, "") : spec;
        newSpec = swapStem(base.replace(/\.[cm]?[jt]sx?$/, ""), "paynp") + ext;
      }
      const ms = p.edit(s.file, `imports the adapters from ${newSpec}`);
      ms.overwrite(src.start! + 1, src.end! - 1, newSpec);
      const flush = needsFlush(p, s.file, sl);
      if (!flush) continue;
      const ns = s.decl.specifiers.find((sp) => sp.type === "ImportNamespaceSpecifier");
      if (ns) addFlush(p, s.file, flush, `${ns.local.name}.paynp`);
      else {
        const named = s.decl.specifiers.filter((sp) => sp.type === "ImportSpecifier");
        if (!named.some((sp) => sp.local.name === "paynp")) ms.appendLeft(named[named.length - 1].end!, ", paynp");
        addFlush(p, s.file, flush, "paynp");
      }
    }
  }
}

// ---------------------------------------------------------------- entry points

/** Works out every edit; reads files, writes nothing. */
export function planWiring(cwd: string, opts: PlanOptions): Plan {
  const p = new Project(cwd, opts);
  const sl = serverless(p);
  hookSettle(p, wireGateways(p, sl));
  wireAdapters(p, sl);
  const plan = p.plan();
  if (sl?.kind === "workers" && plan.changes.some((c) => c.before === null)) {
    plan.manual.push("Workers: set the key with `wrangler secret put PAYNP_KEY`. The paynp file reads it from the `cloudflare:workers` env.");
  }
  return plan;
}

/** Writes the planned files. Refuses any path outside the project. */
export function applyPlan(cwd: string, plan: Plan): void {
  for (const c of plan.changes) {
    if (!insideProject(cwd, c.file)) throw new Error(`refusing to write outside the project: ${c.file}`);
    if (c.before !== null && readFileSync(c.file, "utf8") !== c.before) throw new Error(`${c.rel} changed while init was running; run it again`);
    if (c.before === null && existsSync(c.file)) throw new Error(`${c.rel} appeared while init was running; run it again`);
  }
  for (const c of plan.changes) {
    if (c.before === null) mkdirSync(dirname(c.file), { recursive: true });
    writeFileSync(c.file, c.after);
  }
}

// ---------------------------------------------------------------- action route (opt-in)

/** "./paynp-actions" from `fromFile` to `toFile`, extension style copied from `like` (an import spec in the app). */
function specFrom(fromFile: string, toFile: string, like: string): string {
  let r = relative(dirname(fromFile), toFile).split(sep).join("/");
  if (!r.startsWith(".")) r = "./" + r;
  const base = r.slice(0, -extname(r).length);
  const ext = /\.([cm]?[jt]sx?)$/.exec(like)?.[1];
  if (!ext) return base;
  return base + (ext.endsWith("ts") || ext.endsWith("tsx") ? extname(toFile) : extname(toFile).replace(/ts(x?)$/, "js$1"));
}

/** "@/paynp" when the app imports through a "@/" alias that maps to the project root, else a relative spec. */
function aliasOrRel(p: Project, fromFile: string, toFile: string, like: string): string {
  if (like.startsWith("@/")) {
    const root = p.aliases.paths.find(([prefix, targets]) => prefix === "@/" && targets.some((t) => join(p.aliases.baseUrl, t) === join(p.cwd, "/") || join(p.aliases.baseUrl, t) === p.cwd));
    if (root) return "@/" + p.rel(toFile).replace(/\.[cm]?[jt]sx?$/, "");
  }
  return specFrom(fromFile, toFile, like);
}

/** The exported function `name` and its file, if exactly one file has it. */
function exporter(p: Project, name: string): string | null {
  const hits = p.files.filter((f) => !isPaynpFile(f) && p.text(f).includes(name) && (p.ast(f) ? exportedNames(p.ast(f)!).has(name) : false));
  return hits.length === 1 ? hits[0] : null;
}

/** The top-level `const app = express() | Fastify() | new Hono()` in a file. */
function appDecl(p: Project, f: string, stack: StackId): { decl: t.Statement; name: string; express?: string } | null {
  const ast = p.ast(f);
  if (!ast) return null;
  const defaultImport = (pkg: string) => {
    for (const s of ast.program.body) {
      if (s.type === "ImportDeclaration" && s.source.value === pkg) {
        const d = s.specifiers.find((sp) => sp.type === "ImportDefaultSpecifier");
        if (d) return d.local.name;
      }
    }
    return null;
  };
  const factory = stack === "express" ? defaultImport("express") : stack === "fastify" ? defaultImport("fastify") : null;
  for (const s of ast.program.body) {
    const d = s.type === "ExportNamedDeclaration" ? s.declaration : s;
    if (d?.type !== "VariableDeclaration") continue;
    for (const v of d.declarations) {
      if (v.id.type !== "Identifier" || !v.init) continue;
      const init = v.init;
      if (stack === "hono" && init.type === "NewExpression" && init.callee.type === "Identifier" && init.callee.name === "Hono") return { decl: s, name: v.id.name };
      if (factory && init.type === "CallExpression" && init.callee.type === "Identifier" && init.callee.name === factory) {
        return { decl: s, name: v.id.name, express: stack === "express" ? factory : undefined };
      }
    }
  }
  return null;
}

/**
 * Plans the opt-in action route: paynp-actions.ts next to the paynp file (recheck wired to the app's own
 * confirm + settle, refund left as a comment), and a POST /paynp/actions route in the app. `base` is a wiring
 * plan that is not written yet; this plan then applies on top of it.
 */
export function planActionRoute(cwd: string, opts: PlanOptions, base?: Plan): Plan {
  const overlay = new Map((base?.changes ?? []).map((c) => [c.file, c.after]));
  const p = new Project(cwd, opts, overlay);
  const route = p.files.find((f) => !isPaynpFile(f) && !/paynp-actions\.[cm]?[jt]sx?$/.test(f) && ACTION_ROUTE.test(p.text(f)));
  if (route) {
    p.found = true;
    p.already.add(p.rel(route));
    return p.plan();
  }
  const paynpFiles = p.files.filter((f) => isPaynpFile(f) && wrappedIn(p, f).length);
  if (!paynpFiles.length) {
    if (p.files.some((f) => isPaynpFile(f) && p.text(f).includes("wrapAdapter"))) {
      p.found = true;
      p.manual.push(`Action route: for the nepal-payments adapters, add it by hand: \`paynp.actionHandler({ recheck, refund })\` on POST ${ACTION_PATH} (see the @paynp/sdk README).`);
    }
    return p.plan();
  }
  p.found = true;
  if (paynpFiles.length > 1) {
    p.manual.push(`Action route: several paynp files (${paynpFiles.map((f) => p.rel(f)).join(", ")}). Add POST ${ACTION_PATH} by hand (see the @paynp/sdk README).`);
    return p.plan();
  }
  const paynpFile = paynpFiles[0];
  const ids = wrappedIn(p, paynpFile);
  if (ids.length !== 1) {
    p.manual.push(`Action route: ${p.rel(paynpFile)} wraps ${ids.join(", ")}; a recheck has to pick the module by \`a.gateway\`. Add POST ${ACTION_PATH} by hand (see the @paynp/sdk README).`);
    return p.plan();
  }
  const gid = ids[0];
  const exportName = exportedNames(p.ast(paynpFile)!).has("gateway") ? "gateway" : gid;
  const actionsPath = join(dirname(paynpFile), `paynp-actions${extname(paynpFile)}`);
  if (p.exists(actionsPath)) {
    p.manual.push(`${p.rel(actionsPath)} exists but no route uses it. Add POST ${ACTION_PATH} with \`paynp.actionHandler(actions)\`.`);
    return p.plan();
  }
  // The spec style the paynp file uses for the gateway module: "./esewa", "./esewa.js" or "./esewa.ts".
  const gwSpec = /from\s+["'](\.[^"']+)["']/.exec(p.text(paynpFile))?.[1] ?? "./x";
  const sl = serverless(p);
  const style = styleFor(p, paynpFile, sl?.kind === "workers");
  const settleFile = exporter(p, "settle");
  const storeFile = exporter(p, "getAttempt");
  const both = settleFile && storeFile;

  // Where the route goes, before anything is created: no route means no actions file either.
  const stack = opts.stack;
  if (stack === "nextjs") {
    const routes = p.files.filter((f) => isRouteFile(p.rel(f)));
    const appDir = routes.length ? p.rel(routes[0]).replace(/(^|\/)app\/.*$/, "$1app") : existsSync(join(cwd, "src", "app")) ? "src/app" : existsSync(join(cwd, "app")) ? "app" : null;
    if (!appDir) {
      p.manual.push(`Action route: no app/ directory found. Add app/paynp/actions/route.ts with \`export const POST = paynp.actionHandler(actions)\`.`);
      return p.plan();
    }
    const routeFile = join(cwd, appDir, "paynp", "actions", `route${extname(paynpFile) === ".js" ? ".js" : ".ts"}`);
    if (!p.editable(routeFile)) return p.plan();
    const like = routes.length ? (/from\s+["'](@\/[^"']+|\.[^"']+)["']/.exec(p.text(routes[0]))?.[1] ?? "./x") : "./x";
    p.create(routeFile, nextActionRoute(style, aliasOrRel(p, routeFile, paynpFile, like), aliasOrRel(p, routeFile, actionsPath, like)), `POST ${ACTION_PATH}: refunds and re-checks from the dashboard`);
  } else if (stack === "express" || stack === "fastify" || stack === "hono") {
    const candidates = p.files.filter((f) => !isPaynpFile(f) && appDecl(p, f, stack));
    const server = candidates.find((f) => p.text(f).includes("paynp")) ?? candidates[0];
    if (!server) {
      p.manual.push(`Action route: no top-level \`const app = ${stack === "hono" ? "new Hono()" : stack === "fastify" ? "Fastify()" : "express()"}\` found. Add POST ${ACTION_PATH} by hand (see the @paynp/sdk README).`);
      return p.plan();
    }
    if (!p.editable(server)) return p.plan();
    const code = p.text(server);
    const ast = p.ast(server)!;
    const app = appDecl(p, server, stack)!;
    const { q, semi } = styleOf(code, ast);
    const ms = p.edit(server, `adds POST ${ACTION_PATH} for refunds and re-checks from the dashboard`);
    const comment = "// Refunds and re-checks from the paynp dashboard, signed with PAYNP_ACTION_SECRET.";
    let line: string;
    if (stack === "express") {
      const raw = app.express ? `${app.express}.raw({ type: ${q}application/json${q} }), ` : "";
      line = `${app.name}.post(${q}${ACTION_PATH}${q}, ${raw}paynp.nodeActionHandler(actions))${semi}`;
    } else if (stack === "fastify") {
      line = `${app.name}.post(${q}${ACTION_PATH}${q}, paynp.nodeActionHandler(actions))${semi}`;
    } else if (sl?.kind === "workers") {
      const env = style.ts ? `(c.env as { PAYNP_ACTION_SECRET?: string })` : "c.env";
      line = `${app.name}.post(${q}${ACTION_PATH}${q}, (c) => paynp.actionHandler({ ...actions, secret: ${env}.PAYNP_ACTION_SECRET })(c.req.raw))${semi}`;
    } else {
      line = `${app.name}.post(${q}${ACTION_PATH}${q}, (c) => paynp.actionHandler(actions)(c.req.raw))${semi}`;
    }
    // Right after the app is created. On Hono, after the waitUntil middleware init may have added there.
    let at = app.decl.end!;
    if (stack === "hono") {
      const next = ast.program.body[ast.program.body.indexOf(app.decl) + 1];
      if (next && code.slice(next.start!, next.end!).includes(".flush()") && code.slice(next.start!, next.end!).startsWith(`${app.name}.use(`)) at = next.end!;
    }
    ms.appendLeft(at, `\n\n${comment}\n${line}`);
    // imports: paynp from the paynp file, actions from paynp-actions
    const paynpImport = ast.program.body.find((s): s is t.ImportDeclaration => s.type === "ImportDeclaration" && s.importKind !== "type" && p.resolve(server, s.source.value) === paynpFile);
    const likeSpec = paynpImport?.source.value ?? gwSpec;
    const imports: string[] = [];
    if (paynpImport) {
      const named = paynpImport.specifiers.filter((sp): sp is t.ImportSpecifier => sp.type === "ImportSpecifier");
      if (!named.some((sp) => sp.local.name === "paynp")) {
        if (named.length) ms.appendLeft(named[named.length - 1].end!, ", paynp");
        else imports.push(`import { paynp } from ${q}${likeSpec}${q}${semi}`);
      }
    } else imports.push(`import { paynp } from ${q}${specFrom(server, paynpFile, likeSpec)}${q}${semi}`);
    imports.push(`import { actions } from ${q}${specFrom(server, actionsPath, likeSpec)}${q}${semi}`);
    const last = lastImport(ast);
    if (last) ms.appendLeft(last.end!, `\n${imports.join("\n")}`);
    else ms.prependLeft(0, `${imports.join("\n")}\n`);
  } else {
    p.manual.push(`Action route: add POST ${ACTION_PATH} to the server with \`paynp.nodeActionHandler(actions)\` (Node http) or \`paynp.actionHandler(actions)\` (Fetch API). See the @paynp/sdk README.`);
    return p.plan();
  }

  if (!p.editable(actionsPath)) return p.plan();
  p.create(
    actionsPath,
    actionsFile(style, {
      gateway: gid,
      gatewaySpec: specFrom(actionsPath, paynpFile, gwSpec),
      exportName,
      settle: both ? { spec: specFrom(actionsPath, settleFile, gwSpec) } : undefined,
      store: both ? { spec: specFrom(actionsPath, storeFile, gwSpec) } : undefined,
    }),
    `the recheck (and refund) callbacks the action route runs`,
  );
  return p.plan();
}

// Finding the project's source files, resolving import specifiers to files, and reading git state.
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const SOURCE_EXTS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const SKIP_DIRS = new Set(["node_modules", ".git", ".next", ".nuxt", ".svelte-kit", ".turbo", ".vercel", ".wrangler", ".open-next", ".paynp", "dist", "build", "out", "coverage", "vendor"]);
const MAX_FILES = 5000;
const MAX_BYTES = 1_000_000;

/** Source files under cwd, sorted, never inside node_modules or build output, never through a symlink. */
export function sourceFiles(cwd: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 12 || out.length >= MAX_FILES) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) walk(p, depth + 1);
      } else if (e.isFile() && SOURCE_EXTS.includes(extname(e.name)) && !/\.d\.[cm]?ts$/.test(e.name)) {
        try {
          if (statSync(p).size <= MAX_BYTES) out.push(p);
        } catch {
          /* vanished */
        }
      }
    }
  };
  walk(cwd, 0);
  return out;
}

/** True when p is a real file or a missing path inside cwd, outside node_modules, not reached through a symlink. */
export function insideProject(cwd: string, p: string): boolean {
  const root = realpathSync(cwd);
  const abs = resolve(p);
  const rel = relative(cwd, abs);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return false;
  if (rel.split(sep).includes("node_modules")) return false;
  // Every existing segment must be a plain directory or file, so a symlink cannot lead outside.
  let cur = cwd;
  for (const part of rel.split(sep)) {
    cur = join(cur, part);
    if (!existsSync(cur)) break;
    if (lstatSync(cur).isSymbolicLink()) return false;
  }
  const parent = realpathSync(existsSync(abs) ? abs : dirname(abs));
  return parent === root || parent.startsWith(root + sep);
}

// ---------------------------------------------------------------- tsconfig paths

export interface Aliases {
  baseUrl: string;
  paths: [prefix: string, targets: string[]][]; // "@/" -> ["./"] for "@/*": ["./*"]
}

/** JSON with comments and trailing commas, as tsconfig allows. */
export function parseJsonc(text: string): unknown {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      const start = i;
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === "\\") i++;
      out += text.slice(start, i + 1);
    } else if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (ch === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2);
      if (i < 0) break;
      i++;
    } else out += ch;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

export function readAliases(cwd: string): Aliases {
  for (const f of ["tsconfig.json", "jsconfig.json"]) {
    try {
      const cfg = parseJsonc(readFileSync(join(cwd, f), "utf8")) as { compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> } };
      const co = cfg.compilerOptions ?? {};
      const baseUrl = resolve(cwd, co.baseUrl ?? ".");
      const paths: Aliases["paths"] = [];
      for (const [k, v] of Object.entries(co.paths ?? {})) {
        if (!k.endsWith("*") || !Array.isArray(v)) continue;
        paths.push([k.slice(0, -1), v.filter((t) => t.endsWith("*")).map((t) => t.slice(0, -1))]);
      }
      return { baseUrl, paths };
    } catch {
      /* missing or unreadable */
    }
  }
  return { baseUrl: cwd, paths: [] };
}

const TRY_EXTS = [".ts", ".tsx", ".mts", ".js", ".jsx", ".mjs", ".cts", ".cjs"];

function probe(base: string): string | null {
  const isFile = (p: string) => {
    try {
      return statSync(p).isFile();
    } catch {
      return false;
    }
  };
  if (SOURCE_EXTS.includes(extname(base)) && isFile(base)) return base;
  // NodeNext style: "./x.js" names x.ts.
  const m = base.match(/\.(m|c)?js$/);
  if (m) {
    const stem = base.slice(0, -m[0].length);
    for (const e of m[1] ? [`.${m[1]}ts`] : [".ts", ".tsx"]) if (isFile(stem + e)) return stem + e;
  }
  for (const e of TRY_EXTS) if (isFile(base + e)) return base + e;
  for (const e of TRY_EXTS) if (isFile(join(base, "index" + e))) return join(base, "index" + e);
  return null;
}

/** The project file a specifier names, or null (packages, missing files). */
export function resolveSpec(fromFile: string, spec: string, aliases: Aliases): string | null {
  if (spec.startsWith("./") || spec.startsWith("../") || spec === "." || spec === "..") return probe(resolve(dirname(fromFile), spec));
  for (const [prefix, targets] of aliases.paths) {
    if (!spec.startsWith(prefix)) continue;
    for (const t of targets) {
      const hit = probe(resolve(aliases.baseUrl, t + spec.slice(prefix.length)));
      if (hit) return hit;
    }
  }
  return null;
}

// ---------------------------------------------------------------- git

/** Absolute paths with uncommitted changes (staged, unstaged or untracked), or null outside a git work tree. */
export function dirtyFiles(cwd: string): Set<string> | null {
  const top = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" });
  if (top.status !== 0) return null;
  const root = top.stdout.trim();
  const st = spawnSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd, encoding: "utf8", maxBuffer: 64 << 20 });
  if (st.status !== 0) return null;
  const out = new Set<string>();
  const parts = st.stdout.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (entry.length < 4) continue;
    out.add(resolve(root, entry.slice(3)));
    if (entry[0] === "R" || entry[0] === "C") i++; // the original path follows a rename or copy
  }
  return out;
}

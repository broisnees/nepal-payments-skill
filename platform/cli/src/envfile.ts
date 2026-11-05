// .env and .gitignore rules for `paynp init`: create the file if needed, never overwrite a
// value that is already there, and make sure git ignores .env.
import { existsSync, readFileSync, writeFileSync } from "node:fs";

export interface EnvFile {
  exists: boolean;
  text: string;
  values: Record<string, string>;
}

export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    const q = v[0];
    if ((q === '"' || q === "'") && v.indexOf(q, 1) > 0) v = v.slice(1, v.indexOf(q, 1)); // quoted, maybe a comment after
    else v = v.replace(/\s+#.*$/, "");
    out[m[1]] = v;
  }
  return out;
}

export function readEnvFile(path: string): EnvFile {
  if (!existsSync(path)) return { exists: false, text: "", values: {} };
  const text = readFileSync(path, "utf8");
  return { exists: true, text, values: parseEnv(text) };
}

export interface EnvWrite {
  created: boolean;
  added: string[];
  kept: string[]; // already set (to any value): left alone
}

/** Adds the variables that are missing. Existing ones are never changed. */
export function addToEnvFile(path: string, vars: Record<string, string>): EnvWrite {
  const f = readEnvFile(path);
  const added: string[] = [];
  const kept: string[] = [];
  let text = f.text;
  for (const [k, v] of Object.entries(vars)) {
    if (Object.hasOwn(f.values, k)) {
      kept.push(k);
      continue;
    }
    if (text && !text.endsWith("\n")) text += "\n";
    text += `${k}=${v}\n`;
    added.push(k);
  }
  if (added.length) writeFileSync(path, text, { mode: 0o600 });
  return { created: !f.exists && added.length > 0, added, kept };
}

// Minimal .gitignore matching: is ".env" at the repo root ignored by any non-negated pattern?
function ignoresDotEnv(lines: string[]): boolean {
  let ignored = false;
  for (const raw of lines) {
    let p = raw.trim();
    if (!p || p.startsWith("#")) continue;
    const negate = p.startsWith("!");
    if (negate) p = p.slice(1);
    if (p.endsWith("/")) continue; // directories only
    p = p.replace(/^\//, "").replace(/^\*\*\//, "");
    if (p.includes("/")) continue;
    const re = new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]")}$`);
    if (re.test(".env")) ignored = !negate;
  }
  return ignored;
}

/** Appends ".env" to .gitignore (creating it) unless .env is already ignored. Returns true if it wrote. */
export function ensureGitignored(path: string): boolean {
  const text = existsSync(path) ? readFileSync(path, "utf8") : "";
  if (ignoresDotEnv(text.split(/\r?\n/))) return false;
  writeFileSync(path, `${text}${text && !text.endsWith("\n") ? "\n" : ""}.env\n`);
  return true;
}

// Where the CLI keeps things: the PAT in ~/.config/paynp/credentials.json (mode 600) and the
// project link in .paynp/project.json next to the app.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_ENDPOINT, NAME } from "../../shared/src/brand.ts";
import { readEnvFile } from "./envfile.ts";

export interface StoredToken {
  token: string;
  email?: string;
  dashboard?: string; // origin of the dashboard, learned from the device login
  created_at: string;
}
export interface Credentials {
  default?: string; // endpoint of the last login
  tokens: Record<string, StoredToken>;
}
export interface ProjectLink {
  org: string;
  project: string;
}

export const configDir = (): string => join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), NAME);
export const credentialsPath = (): string => join(configDir(), "credentials.json");

export function readCredentials(): Credentials {
  try {
    const c = JSON.parse(readFileSync(credentialsPath(), "utf8")) as Credentials;
    return { default: c.default, tokens: c.tokens ?? {} };
  } catch {
    return { tokens: {} };
  }
}

/** Writes atomically with mode 600 (and the directory 700). */
export function writeCredentials(c: Credentials): void {
  const file = credentialsPath();
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(c, null, 2) + "\n", { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
  if (Object.keys(c.tokens).length === 0) rmSync(file, { force: true });
}

export const normalizeEndpoint = (e: string): string => e.trim().replace(/\/+$/, "");

/**
 * The endpoint for this run: --endpoint, then PAYNP_ENDPOINT from the environment, then from
 * the project's .env, then the endpoint of the last login, then the default.
 */
export function resolveEndpoint(flag: string | undefined, cwd: string): string {
  const fromEnvFile = readEnvFile(join(cwd, ".env")).values.PAYNP_ENDPOINT;
  const pick = flag || process.env.PAYNP_ENDPOINT || fromEnvFile || readCredentials().default || DEFAULT_ENDPOINT;
  return normalizeEndpoint(pick);
}

export const linkPath = (cwd: string): string => join(cwd, `.${NAME}`, "project.json");

export function readLink(cwd: string): ProjectLink | null {
  try {
    const l = JSON.parse(readFileSync(linkPath(cwd), "utf8")) as Partial<ProjectLink>;
    return typeof l.org === "string" && typeof l.project === "string" ? { org: l.org, project: l.project } : null;
  } catch {
    return null;
  }
}

export function writeLink(cwd: string, link: ProjectLink): void {
  const file = linkPath(cwd);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ org: link.org, project: link.project }, null, 2) + "\n");
}

export const hasLink = (cwd: string): boolean => existsSync(linkPath(cwd));

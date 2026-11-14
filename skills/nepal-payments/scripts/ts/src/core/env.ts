/** Reading provider config from environment variables (see references/env.md). */
import type { Environment } from "./types.ts";

export type EnvVars = Record<string, string | undefined>;

/** "production" or "live" selects production; anything else (including unset) is sandbox. */
export function environmentFrom(value?: string): Environment {
  return value === "production" || value === "live" ? "production" : "sandbox";
}

/** PEMs in .env files usually carry literal "\n" sequences; turn them into real newlines. */
export function pemFromEnv(value: string): string {
  return value.replace(/\\n/g, "\n");
}

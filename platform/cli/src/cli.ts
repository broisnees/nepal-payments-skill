import { NAME } from "../../shared/src/brand.ts";
import { CliError, init, keys, login, logout, open, tail, test, type Ctx, type Flags } from "./commands.ts";
import { resolveEndpoint } from "./config.ts";
import { dev } from "./dev/index.ts";
import { defaultIo, type Io } from "./ui.ts";
import { VERSION } from "./version.ts";

const BOOLEAN = new Set(["yes", "y", "json", "no-browser", "skip-install", "help", "h", "version", "v", "live", "new-key", "create", "fresh", "open", "quiet", "memory", "dry-run", "force"]);

export function parseArgs(argv: string[]): { args: string[]; flags: Flags } {
  const args: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      args.push(...argv.slice(i + 1));
      break;
    }
    if (!a.startsWith("-") || a === "-") {
      args.push(a);
      continue;
    }
    const [rawKey, inline] = a.replace(/^--?/, "").split(/=(.*)/s, 2);
    const key = rawKey;
    if (inline !== undefined) flags[key] = inline;
    else if (BOOLEAN.has(key)) flags[key] = true;
    else if (i + 1 < argv.length && !argv[i + 1].startsWith("-")) flags[key] = argv[++i];
    else flags[key] = true;
  }
  if (flags.y) flags.yes = true;
  if (flags.h) flags.help = true;
  if (flags.v) flags.version = true;
  return { args, flags };
}

export const HELP = `${NAME} ${VERSION}: every Nepali payment in one place.

Usage: ${NAME} <command> [options]

  login              Sign in from the browser (device code) and save a token
  logout             Revoke the token and delete it from this machine
  init               Link this folder to a project, write PAYNP_KEY to .env, wire paynp into the code
  tail               Live events for the linked project   --json  --env test|live
  test               Send a synthetic eSewa payment with the test key
  keys [list]        Ingest keys of the linked project     --json
  keys create        New key                                --env test|live  --name <name>
  keys revoke <id>   Revoke a key
  open               Open the linked project in the dashboard
  dev                Local dashboard and ingest on http://localhost:4040, no account or key
                       --port <n>  --fresh (clear .paynp/dev)  --open (browser)  --quiet

Options:
  --endpoint <url>   API to talk to (or PAYNP_ENDPOINT), e.g. http://localhost:8787
  --yes, -y          Never prompt; pick defaults
  --no-browser       Print URLs instead of opening them
  init: --org <id> --project <id|slug|name> [--create] --gateway <id> --skip-install --new-key
        --dry-run (print the code edits, change nothing)  --force (also edit files with uncommitted changes)
`;

const COMMANDS: Record<string, (ctx: Ctx) => Promise<void>> = { login, logout, init, tail, test, keys, open, dev };

/** Runs one command. Returns the exit code; never calls process.exit. */
export async function run(argv: string[], opts: { cwd?: string; io?: Io; signal?: AbortSignal } = {}): Promise<number> {
  const io = opts.io ?? defaultIo();
  const { args, flags } = parseArgs(argv);
  if (flags.version) {
    io.out(VERSION);
    return 0;
  }
  const [cmd, ...rest] = args;
  if (!cmd || flags.help || cmd === "help") {
    io.out(HELP);
    return cmd || flags.help ? 0 : 1;
  }
  const fn = COMMANDS[cmd];
  if (!fn) {
    io.err(`${NAME}: unknown command "${cmd}". Run ${NAME} --help`);
    return 1;
  }
  const cwd = opts.cwd ?? process.cwd();
  const endpoint = resolveEndpoint(typeof flags.endpoint === "string" ? flags.endpoint : undefined, cwd);
  try {
    new URL(endpoint);
  } catch {
    io.err(`${NAME}: --endpoint must be a URL, got "${endpoint}"`);
    return 1;
  }
  try {
    await fn({ cwd, io, endpoint, flags, args: rest, signal: opts.signal });
    return 0;
  } catch (err) {
    if (err instanceof CliError) io.err(`${NAME}: ${err.message}`);
    else io.err(`${NAME}: ${(err as Error)?.stack ?? String(err)}`);
    return 1;
  }
}

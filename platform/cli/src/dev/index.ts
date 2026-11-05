// `paynp dev`: starts the local dev server and prints where to point the app.
import { existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { NAME } from "../../../shared/src/brand.ts";
import type { PaymentEvent } from "../../../shared/src/events.ts";
import { CliError, type Ctx } from "../commands.ts";
import { formatEvent } from "../format.ts";
import { openBrowser, paint } from "../ui.ts";
import { VERSION } from "../version.ts";
import { toEvent } from "./queries.ts";
import { DEFAULT_DEV_PORT, startDevServer } from "./server.ts";
import { DevStore } from "./store.ts";

export { startDevServer, DEFAULT_DEV_PORT } from "./server.ts";
export { DevStore } from "./store.ts";

/** The built dashboard: dist/dashboard next to the bundled CLI, or the package's dist/ when run from source. */
export function findDashboard(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const dir of [join(here, "dashboard"), join(here, "..", "..", "dist", "dashboard")]) {
    if (existsSync(join(dir, "index.html"))) return dir;
  }
  return null;
}

export async function dev(ctx: Ctx): Promise<void> {
  const { io, flags, cwd } = ctx;
  const c = (color: Parameters<typeof paint>[1], s: string) => paint(io.color, color, s);
  const rawPort = typeof flags.port === "string" ? flags.port : (process.env.PAYNP_DEV_PORT ?? String(DEFAULT_DEV_PORT));
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new CliError(`--port must be a port number, got "${rawPort}"`);

  const dir = join(cwd, `.${NAME}`, "dev");
  const store = await DevStore.open({ dir, fresh: !!flags.fresh, memory: !!flags.memory });
  const dashboard = findDashboard();
  let server;
  try {
    server = await startDevServer({
      port,
      store,
      dashboardDir: dashboard,
      onIngest: flags.quiet
        ? undefined
        : (env, out) => {
            for (const s of out.stored) io.out((env === "live" ? c("magenta", "live ") : "") + formatEvent(toEvent(s.event) as PaymentEvent, io.color));
          },
    });
  } catch (err) {
    store.close();
    if ((err as NodeJS.ErrnoException)?.code === "EADDRINUSE") throw new CliError(`port ${port} is in use. Is ${NAME} dev already running? Pick another with --port`);
    throw err;
  }

  const url = server.url;
  const storage =
    store.kind === "sqlite"
      ? `${relative(cwd, store.file!) || store.file} (kept across restarts, --fresh to clear)`
      : "memory (Node 22.5+ keeps events in .paynp/dev across restarts)";
  const counted = store.payments.size ? `, ${store.payments.size} payment(s) from earlier` : "";
  io.out("");
  io.out(`  ${c("bold", `${NAME} dev`)} ${c("gray", `v${VERSION}`)}  local dashboard and ingest, no account or key needed`);
  io.out("");
  io.out(`  Dashboard  ${c("cyan", url)}`);
  io.out(`  Ingest     ${url}/v1/events`);
  io.out(`  Storage    ${storage}${counted}`);
  if (!dashboard) io.out(c("yellow", "  This build has no dashboard bundled; the API works, the page is a placeholder."));
  io.out("");
  io.out("  Point the app here (in its .env, any key works):");
  io.out("");
  io.out(`    ${c("green", `PAYNP_ENDPOINT=${url}`)}`);
  io.out(`    ${c("green", "PAYNP_KEY=pnp_test_local")}`);
  io.out("");
  io.out(c("gray", `  With no PAYNP_KEY at all, @paynp/sdk finds this server by itself when NODE_ENV is not production.`));
  io.out(c("gray", "  Ctrl+C to stop."));
  io.out("");

  if (flags.open) openBrowser(url);

  await new Promise<void>((resolve) => {
    if (!ctx.signal) return; // no signal: run until the process is killed
    if (ctx.signal.aborted) return resolve();
    ctx.signal.addEventListener("abort", () => resolve(), { once: true });
  });
  await server.close();
  io.err(c("gray", `${NAME} dev stopped.`));
}

import { run } from "./cli.ts";

const major = Number(process.versions.node.split(".")[0]);
if (major < 20) {
  process.stderr.write(`paynp needs Node 20 or newer (this is ${process.versions.node}).\n`);
  process.exit(1);
}

const ac = new AbortController();
let interrupted = false;
process.on("SIGINT", () => {
  if (interrupted) process.exit(130);
  interrupted = true;
  ac.abort();
});

run(process.argv.slice(2), { signal: ac.signal }).then((code) => {
  process.exitCode = interrupted && code === 0 ? 0 : code;
  // Prompts and sockets are closed by now; exit so a stray handle never keeps the CLI alive.
  setImmediate(() => process.exit(process.exitCode));
});

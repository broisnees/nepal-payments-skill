// Terminal output and prompts. node:readline only; colors off for NO_COLOR, dumb terminals and pipes.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";

export interface Io {
  out: (s: string) => void;
  err: (s: string) => void;
  interactive: boolean;
  color: boolean;
  ask: (question: string) => Promise<string>;
}

const colorOn = (stream: NodeJS.WriteStream) =>
  !process.env.NO_COLOR && process.env.TERM !== "dumb" && (!!process.env.FORCE_COLOR || !!stream.isTTY);

export function defaultIo(): Io {
  return {
    out: (s) => void process.stdout.write(s + "\n"),
    err: (s) => void process.stderr.write(s + "\n"),
    interactive: !!process.stdin.isTTY && !!process.stdout.isTTY,
    color: colorOn(process.stdout),
    async ask(q) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return (await rl.question(q)).trim();
      } finally {
        rl.close();
      }
    },
  };
}

const codes = { red: 31, green: 32, yellow: 33, blue: 34, magenta: 35, cyan: 36, gray: 90, bold: 1, dim: 2 } as const;
export type Color = keyof typeof codes;
export const paint = (on: boolean, c: Color, s: string): string => (on ? `\x1b[${codes[c]}m${s}\x1b[0m` : s);

/** Numbered menu; returns the chosen index. `def` is used for an empty answer. */
export async function choose(io: Io, title: string, options: string[], def = 0): Promise<number> {
  io.out(title);
  options.forEach((o, i) => io.out(`  ${i + 1}) ${o}`));
  for (;;) {
    const a = await io.ask(`Choose 1-${options.length} [${def + 1}]: `);
    if (!a) return def;
    const n = Number(a);
    if (Number.isInteger(n) && n >= 1 && n <= options.length) return n - 1;
  }
}

/** Opens a URL in the default browser. Returns false when it could not (or should not) try. */
export function openBrowser(url: string): boolean {
  if (process.env.PAYNP_NO_BROWSER || process.env.CI) return false;
  const [cmd, args] =
    process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", '""', url]] : ["xdg-open", [url]];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

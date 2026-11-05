// Unified diffs (git style, 3 lines of context) for the edits init is about to make.
import { paint } from "../ui.ts";

type Op = [kind: " " | "-" | "+", line: string];

function splitLines(s: string): string[] {
  if (s === "") return [];
  const lines = s.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

// Line diff: common prefix and suffix, then an LCS table over the middle (edits are small and local).
function diffLines(a: string[], b: string[]): Op[] {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const am = a.slice(pre, a.length - suf);
  const bm = b.slice(pre, b.length - suf);
  const ops: Op[] = a.slice(0, pre).map((l) => [" ", l] as Op);
  if (am.length * bm.length > 4_000_000) {
    for (const l of am) ops.push(["-", l]);
    for (const l of bm) ops.push(["+", l]);
  } else {
    const n = am.length;
    const m = bm.length;
    const t = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) t[i][j] = am[i] === bm[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && am[i] === bm[j]) (ops.push([" ", am[i]]), i++, j++);
      else if (i < n && (j === m || t[i + 1][j] >= t[i][j + 1])) ops.push(["-", am[i++]]);
      else ops.push(["+", bm[j++]]);
    }
  }
  for (const l of a.slice(a.length - suf)) ops.push([" ", l]);
  return ops;
}

/** git-style unified diff; `before` null means a new file. Empty string when nothing changed. */
export function unifiedDiff(path: string, before: string | null, after: string, context = 3): string {
  if (before === after) return "";
  const ops = diffLines(splitLines(before ?? ""), splitLines(after));
  const out = [`--- ${before === null ? "/dev/null" : `a/${path}`}`, `+++ b/${path}`];
  // Group changes that are within 2*context lines of each other into one hunk.
  const changed = ops.map((o, i) => (o[0] !== " " ? i : -1)).filter((i) => i >= 0);
  let k = 0;
  while (k < changed.length) {
    let end = k;
    while (end + 1 < changed.length && changed[end + 1] - changed[end] <= 2 * context) end++;
    const from = Math.max(0, changed[k] - context);
    const to = Math.min(ops.length, changed[end] + context + 1);
    let aStart = 0;
    let bStart = 0;
    for (let i = 0; i < from; i++) {
      if (ops[i][0] !== "+") aStart++;
      if (ops[i][0] !== "-") bStart++;
    }
    const hunk = ops.slice(from, to);
    const aLen = hunk.filter((o) => o[0] !== "+").length;
    const bLen = hunk.filter((o) => o[0] !== "-").length;
    out.push(`@@ -${aLen ? aStart + 1 : aStart},${aLen} +${bLen ? bStart + 1 : bStart},${bLen} @@`);
    for (const [kind, line] of hunk) out.push(kind + line);
    k = end + 1;
  }
  return out.join("\n");
}

export function colorDiff(diff: string, color: boolean): string {
  if (!color) return diff;
  return diff
    .split("\n")
    .map((l) =>
      l.startsWith("+++") || l.startsWith("---") ? paint(true, "bold", l) : l.startsWith("@@") ? paint(true, "cyan", l) : l.startsWith("+") ? paint(true, "green", l) : l.startsWith("-") ? paint(true, "red", l) : l,
    )
    .join("\n");
}

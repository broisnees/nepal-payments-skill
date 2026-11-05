// First-load weight of the built dashboard: what the browser fetches to render a route, gzipped.
// Follows index.html, its static imports, and the route's page chunk with its own static and preload deps.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

const dir = process.argv[2] ?? "../worker/public";
const assets = join(dir, "assets");
const files = readdirSync(assets);
const gz = (f) => gzipSync(readFileSync(f)).length;
const html = readFileSync(join(dir, "index.html"), "utf8");

function deps(file, seen) {
  if (seen.has(file)) return;
  seen.add(file);
  if (!file.endsWith(".js")) return;
  const src = readFileSync(join(assets, file), "utf8");
  for (const m of src.matchAll(/(?:from|import)\s*"\.\/([^"]+\.js)"/g)) deps(m[1], seen);
}

const entry = new Set();
for (const m of html.matchAll(/assets\/([^"]+\.(?:js|css))/g)) deps(m[1], entry);

function route(name, extra = []) {
  const set = new Set(entry);
  for (const n of [name, ...extra]) {
    const f = files.find((x) => x.startsWith(`${n}-`) && x.endsWith(".js"));
    if (f) deps(f, set);
    const css = files.find((x) => x.startsWith(`${n}-`) && x.endsWith(".css"));
    if (css) set.add(css);
  }
  const total = [...set].reduce((s, f) => s + gz(join(assets, f)), gz(join(dir, "index.html")));
  return { total, set };
}

const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
const e = route("__none__");
console.log(`entry (index.html + JS + CSS): ${kb(e.total)} gzipped`);
for (const [r, extra] of [["Overview", ["TimeChart"]], ["Payments", []], ["PaymentDetail", []], ["Live", []], ["Analytics", ["TimeChart"]], ["SignIn", []]]) {
  console.log(`/${r.toLowerCase()} first load: ${kb(route(r, extra).total)} gzipped`);
}
const fonts = files.filter((f) => /inter-latin-opsz-normal|jetbrains-mono-latin-wght-normal/.test(f));
console.log(`fonts used by Latin text (woff2, already compressed): ${kb(fonts.reduce((s, f) => s + readFileSync(join(assets, f)).length, 0))}`);

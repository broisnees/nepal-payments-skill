// Screenshots of the public pages (landing, sign-up, sign-in, docs) at 1440 and 390 wide, light and dark.
// Usage: node scripts/public-shots.mjs <baseUrl> <outDir>  (needs the worker running, e.g. wrangler dev)
import { mkdir } from "node:fs/promises";
import puppeteer from "puppeteer-core";

const base = process.argv[2] ?? "http://localhost:8787";
const out = process.argv[3] ?? "screenshots-public";
const pages = [
  ["landing", "/"],
  ["signup", "/signup"],
  ["signup-errors", "/signup", { submit: true }],
  ["signin", "/signin"],
  ["docs-intro", "/docs/introduction"],
  ["docs-sdk", "/docs/sdk"],
];
await mkdir(out, { recursive: true });
const browser = await puppeteer.launch({ executablePath: process.env.CHROME ?? "/usr/bin/chromium", args: ["--no-sandbox", "--hide-scrollbars"] });
for (const [name, path, opts = {}] of pages) {
  for (const [w, h] of [[1440, 900], [390, 844]]) {
    for (const scheme of ["light", "dark"]) {
      const page = await browser.newPage();
      await page.setViewport({ width: w, height: h, deviceScaleFactor: 1 });
      await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: scheme }]);
      await page.goto(base + path, { waitUntil: "networkidle0" });
      if (opts.submit) await page.click("form button.btn-primary");
      await new Promise((r) => setTimeout(r, 400));
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      if (overflow > 0) console.log(`OVERFLOW ${name} ${w} ${scheme}: ${overflow}px`);
      await page.screenshot({ path: `${out}/${name}-${w}-${scheme}.png`, fullPage: true });
      await page.close();
    }
  }
}
await browser.close();
console.log("done");

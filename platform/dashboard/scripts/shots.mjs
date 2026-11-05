// Screenshots of every page in mock mode, desktop and phone, light and dark.
// Usage: node scripts/shots.mjs [baseUrl] [outDir] [filter]
import { mkdir } from "node:fs/promises";
import puppeteer from "puppeteer-core";

const base = process.argv[2] ?? "http://localhost:5179";
const out = process.argv[3] ?? "screenshots";
const only = process.argv[4];
const P = "/p/prj_storefront/live";

const pages = [
  ["sign-in", "/signin", { signedOut: true }],
  ["sign-in-error", "/signin?error=invalid_link", { signedOut: true }],
  ["check-email", "/signin/check?email=sita%40himalayanthreads.com.np", { signedOut: true }],
  ["device", "/device?code=WXYZ-4821"],
  ["overview", `${P}/overview`],
  ["overview-empty", "/p/prj_wholesale/test/overview"],
  ["payments", `${P}/payments`],
  ["payments-failed", `${P}/payments?status=failed`],
  ["payment-detail", `${P}/payments`, { clickFirst: "status=paid" }],
  ["payment-detail-failed", `${P}/payments?status=failed`, { clickFirst: "failed", expand: true }],
  ["live", `${P}/live`, { wait: 4000 }],
  ["analytics", `${P}/analytics`],
  ["alerts-rules", `${P}/alerts/rules`],
  ["alerts-new-rule", `${P}/alerts/rules`, { click: "New rule", then: "Failure rate" }],
  ["alerts-channels", `${P}/alerts/channels`],
  ["alerts-incidents", `${P}/alerts/incidents`],
  ["settings-general", `${P}/settings/general`],
  ["settings-account", `${P}/settings/account`],
  ["settings-keys", `${P}/settings/keys`],
  ["settings-key-created", `${P}/settings/keys`, { click: "Create key", then: "Create live key" }],
  ["settings-members", `${P}/settings/members`],
  ["settings-sessions", `${P}/settings/sessions`],
  ["settings-tokens", `${P}/settings/tokens`],
  ["switcher", `${P}/overview`, { click: "Storefront" }],
  ["payment-detail-duplicate", `${P}/refunds`, { clickCase: "Paid twice", openRefund: true }],
  ["payment-detail-mark-refund", `${P}/payments?status=paid`, { clickFirst: "paid", click: "Mark for refund" }],
  ["payment-detail-status-link", `${P}/payments?status=paid`, { clickFirst: "paid", click: "Send status link", then: "Create link" }],
  ["support-empty", `${P}/support`],
  ["support-phone", `${P}/support?q=9841234567`],
  ["support-none", `${P}/support?q=HT-99999`],
  ["refunds", `${P}/refunds`],
  ["refunds-case-failed", `${P}/refunds`, { clickCase: "Failed" }],
  ["refunds-case-done", `${P}/refunds`, { clickCase: "Refunded" }],
  ["refunds-test-no-endpoint", "/p/prj_storefront/test/refunds"],
  ["refunds-empty", "/p/prj_books/live/refunds"],
  ["reconcile", `${P}/reconcile`],
  ["reconcile-missing", `${P}/reconcile?tab=missing`],
  ["reconcile-mapping", `${P}/reconcile`, { upload: "scripts/fixtures/bank-export.csv" }],
  ["reconcile-empty", "/p/prj_storefront/test/reconcile"],
  ["go-live", `${P}/go-live`],
  ["go-live-test", "/p/prj_storefront/test/go-live"],
  ["go-live-ready", "/p/prj_books/live/go-live"],
  ["exports", `${P}/exports`],
  ["alerts-double-payment", `${P}/alerts/rules`, { click: "New rule", then: "Double payment" }],
  ["alerts-paid-not-fulfilled", `${P}/alerts/rules`, { click: "New rule", then: "Paid but not fulfilled" }],
  ["settings-actions", `${P}/settings/actions`],
  ["settings-actions-new", "/p/prj_storefront/test/settings/actions"],
];

const views = [
  ["desktop", { width: 1440, height: 900, deviceScaleFactor: 1 }],
  ["phone", { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true }],
];

await mkdir(out, { recursive: true });
const browser = await puppeteer.launch({ executablePath: "/usr/bin/chromium", headless: true, args: ["--no-sandbox", "--font-render-hinting=none"] });
const errors = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function clickText(page, text) {
  const ok = await page.evaluate((t) => {
    const els = [...document.querySelectorAll("button, a, [role=menuitem]")];
    const el = els.find((e) => e.textContent?.trim() === t) ?? els.find((e) => e.textContent?.includes(t));
    if (!el) return false;
    el.click();
    return true;
  }, text);
  if (!ok) throw new Error(`no element with text ${text}`);
}

for (const [vname, viewport] of views) {
  for (const theme of ["light", "dark"]) {
    for (const [name, path, opts = {}] of pages) {
      if (only && !name.includes(only)) continue;
      const page = await browser.newPage();
      page.on("pageerror", (e) => errors.push(`${name} ${vname} ${theme}: ${e.message}`));
      page.on("console", (m) => m.type() === "error" && errors.push(`${name} ${vname} ${theme}: console ${m.text()}`));
      await page.setViewport(viewport);
      await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: theme }, { name: "prefers-reduced-motion", value: "reduce" }]);
      await page.evaluateOnNewDocument((signedOut) => {
        try {
          localStorage.clear();
          if (signedOut) sessionStorage.setItem("paynp-mock-signed-out", "1");
          else sessionStorage.removeItem("paynp-mock-signed-out");
        } catch {}
      }, Boolean(opts.signedOut));
      await page.goto(base + path, { waitUntil: "networkidle0" });
      await sleep(900);
      if (opts.clickFirst) {
        await page.evaluate(() => document.querySelector("tbody tr.clickable a")?.click());
        if (opts.click) await sleep(600);
        await sleep(1200);
        if (opts.expand) {
          await page.evaluate(() => {
            const spans = [...document.querySelectorAll(".span-main")];
            (spans.find((s) => s.querySelector('.node[data-tone="bad"]')) ?? spans[0])?.click();
          });
          await sleep(400);
        }
      }
      if (opts.clickCase) {
        await page.evaluate((t) => [...document.querySelectorAll(".case-row")].find((a) => a.textContent.includes(t))?.click(), opts.clickCase);
        await sleep(700);
      }
      if (opts.openRefund) {
        // From a duplicate case, open the payment that should be refunded.
        await page.evaluate(() => [...document.querySelectorAll(".pay-card")].find((a) => a.dataset.role === "refund")?.click());
        await sleep(1200);
      }
      if (opts.upload) {
        const input = await page.$("input[type=file]");
        await input.uploadFile(opts.upload);
        await sleep(1500);
      }
      if (opts.click) {
        await clickText(page, opts.click);
        await sleep(500);
        if (opts.then) {
          await clickText(page, opts.then);
          await sleep(900);
        }
      }
      if (opts.wait) await sleep(opts.wait);
      const file = `${out}/${name}-${vname}-${theme}.png`;
      await page.screenshot({ path: file, fullPage: !["switcher", "live"].includes(name) });
      await page.close();
      process.stdout.write(".");
    }
  }
}
await browser.close();
console.log(`\n${errors.length ? errors.join("\n") : "no page errors"}`);

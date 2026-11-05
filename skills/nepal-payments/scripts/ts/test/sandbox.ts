/**
 * Live sandbox smoke test. Hits real provider sandboxes; no payment is completed.
 *   node test/sandbox.ts                    # eSewa (public creds) + Fonepay dev sample
 *   KHALTI_SECRET_KEY=... node test/sandbox.ts   # + Khalti (key from test-admin.khalti.com)
 * Exit code 1 if any check fails.
 */
import { esewa, ESEWA_SANDBOX, fonepay, khalti, newOrderId } from "../src/index.ts";

let failed = 0;
async function check(name: string, fn: () => Promise<string>) {
  try {
    console.log(`  ok   ${name}: ${await fn()}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL ${name}: ${e instanceof Error ? e.message : String(e)}`);
  }
}
const assert = (cond: unknown, msg: string) => {
  if (!cond) throw new Error(msg);
};

console.log("eSewa (rc sandbox)");
{
  const e = esewa({ env: "sandbox", ...ESEWA_SANDBOX });
  const id = newOrderId();
  await check("signed form accepted (302 to login)", async () => {
    const f = await e.initiate({ orderId: id, amountPaisa: 11050, taxPaisa: 1000, description: "smoke", returnUrl: `https://example.com/payments/esewa/return/${id}` });
    assert(f.kind === "form", "expected form");
    if (f.kind !== "form") return "";
    const r = await fetch(f.action, { method: "POST", body: new URLSearchParams(f.fields), redirect: "manual" });
    const loc = r.headers.get("location") ?? "";
    assert(r.status === 302 && loc.includes("bookingId="), `got ${r.status} ${loc} ${(await r.text()).slice(0, 200)}`);
    return loc;
  });
  await check("status API: unpaid -> pending", async () => {
    const v = await e.verify({ orderId: id, amountPaisa: 11050 });
    assert(v.status === "pending", `got ${v.status}`);
    return v.status;
  });
  await check("status API: wrong total -> not_found", async () => {
    const v = await e.verify({ orderId: id, amountPaisa: 99900 });
    assert(v.status === "not_found", `got ${v.status}`);
    return v.status;
  });
  await check("intent book -> status -> cancel", async () => {
    const oid = newOrderId("I");
    const b = await e.intentBook({ orderId: oid, amountPaisa: 10000, callbackUrl: "https://example.com/cb", redirectUrl: "https://example.com/done" });
    const s = await e.intentVerify(oid, b.providerRef);
    assert(s.status === "pending", `status ${s.status}`);
    const c: any = await e.intentCancel(b.providerRef);
    assert(c?.data?.status === "CANCELED", `cancel ${JSON.stringify(c)}`);
    return `${b.deeplink} BOOKED -> CANCELED`;
  });
}

console.log("Fonepay (dev gateway, public sample merchant NBQM)");
{
  const fp = fonepay({ env: "sandbox", merchantCode: "NBQM", secretKey: "a7e3512f5032480a83137793cb2021dc" });
  await check("signed redirect accepted (303 to payment page)", async () => {
    const r = await fp.initiate({ orderId: newOrderId(), amountPaisa: 1050, description: "smoke", returnUrl: "https://example.com/payments/fonepay/return" });
    if (r.kind !== "redirect") throw new Error("expected redirect");
    const res = await fetch(r.url, { redirect: "manual" });
    const loc = res.headers.get("location") ?? "";
    assert(res.status >= 300 && res.status < 400 && loc.includes("fonepay.com"), `got ${res.status} ${loc} ${(await res.text()).slice(0, 200)}`);
    return loc;
  });
}

if (process.env.KHALTI_SECRET_KEY) {
  console.log("Khalti (dev.khalti.com)");
  const k = khalti({ env: "sandbox", secretKey: process.env.KHALTI_SECRET_KEY, websiteUrl: "https://example.com" });
  await check("initiate -> lookup (Initiated)", async () => {
    const oid = newOrderId();
    const r = await k.initiate({ orderId: oid, amountPaisa: 1000, description: "smoke", returnUrl: "https://example.com/payments/khalti/return" });
    if (r.kind !== "redirect") throw new Error("expected redirect");
    const v = await k.verify({ orderId: oid, amountPaisa: 1000, providerRef: r.providerRef });
    assert(v.status === "pending", `got ${v.status}`);
    return `${r.url} -> ${(v.raw as any).status}`;
  });
} else {
  console.log("Khalti: skipped (set KHALTI_SECRET_KEY from https://test-admin.khalti.com)");
}

console.log(failed ? `\n${failed} check(s) failed` : "\nall sandbox checks passed");
process.exit(failed ? 1 : 0);

// The real eSewa module from the blog (website/src/data/blog-code/esewa.ts) and the real skill
// adapter, wrapped, against eSewa's public sandbox (rc-epay / rc.esewa.com.np) and a local
// ingest mock. Needs network; PAYNP_SKIP_SANDBOX=1 skips it.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { esewa as esewaBlog } from "../../../website/src/data/blog-code/esewa.ts";
import { store, types as typesBlock } from "../../../website/src/data/blog-code/shared/ts.ts";
import { ESEWA_SANDBOX, esewa as esewaAdapter } from "../../../skills/nepal-payments/scripts/ts/src/esewa.ts";
import { createPaynp, type Paynp } from "../src/index.ts";
import { TEST_KEY, byTime, startIngest, type MockIngest } from "./ingest.ts";

const FORM_URL = "https://rc-epay.esewa.com.np/api/epay/main/v2/form";
const dir = join(import.meta.dirname, ".generated", "esewa-blog");

// Same assembly as the blog reader does: payments.ts, store.ts, and esewa.ts from its four parts.
function assemble(): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "payments.ts"), typesBlock.code);
  writeFileSync(join(dir, "store.ts"), store.code);
  const e = esewaBlog.ts;
  writeFileSync(join(dir, e.file), (["config", "sign", "start", "confirm"] as const).map((p) => e.parts[p]).join("\n\n") + "\n");
  return join(dir, e.file);
}

type BlogModule = {
  startPayment(i: { attemptId: string; amountPaisa: number; returnUrl: string; description: string }): Promise<{ type: "form"; action: string; fields: Record<string, string> }>;
  confirmPayment(i: { attemptId: string; amountPaisa: number; providerRef: string | null; params: Record<string, string> }): Promise<{ status: string; providerRef?: string }>;
};

const hex = () => Array.from(crypto.getRandomValues(new Uint8Array(10)), (b) => b.toString(16).padStart(2, "0")).join("");

let ingest: MockIngest;
let paynp: Paynp;
let blog: BlogModule & { hmacBase64: (k: string, m: string) => Promise<string> };
let PaymentError: new (m: string) => Error;

// The sandbox sometimes takes over 10 s to accept a connection. Open one to each host first
// (undici keeps it alive), and retry a failed test once; every try uses a fresh attempt id.
async function warm(url: string): Promise<void> {
  for (let i = 0; i < 4; i++) {
    try {
      await (await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(15_000) })).arrayBuffer();
      return;
    } catch {
      /* try again */
    }
  }
}

describe.skipIf(process.env.PAYNP_SKIP_SANDBOX === "1")("eSewa sandbox, real modules", { retry: 2 }, () => {
  beforeAll(async () => {
    await Promise.all([warm("https://rc.esewa.com.np/"), warm("https://rc-epay.esewa.com.np/")]);
    const file = assemble();
    blog = await import(/* @vite-ignore */ file);
    ({ PaymentError } = await import(/* @vite-ignore */ join(dir, "payments.ts")));
    ingest = await startIngest();
    paynp = createPaynp({ key: TEST_KEY, endpoint: ingest.url, flushIntervalMs: 60_000 });
  }, 120_000);
  afterAll(() => ingest?.close());

  it("blog module: startPayment, eSewa accepts the form, confirmPayment({}) asks the real status API", async () => {
    const gateway = paynp.wrapGateway("esewa", blog);
    const attemptId = hex();
    const start = await gateway.startPayment({ attemptId, amountPaisa: 10000, returnUrl: `http://localhost:3000/pay/return/${attemptId}`, description: "Order demo" });
    expect(start.action).toBe(FORM_URL);

    // What the buyer's browser does with the auto-POST form.
    const res = await fetch(FORM_URL, { method: "POST", body: new URLSearchParams(start.fields), redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/epay?bookingId=");

    // The reconcile job: no callback, the module asks the status API.
    const outcome = await gateway.confirmPayment({ attemptId, amountPaisa: 10000, providerRef: null, params: {} });
    expect(["pending", "not_found"]).toContain(outcome.status);
    await paynp.flush();

    const evs = byTime(ingest.events.filter((e) => e.attempt_id === attemptId));
    expect(evs.map((e) => e.type)).toEqual(["payment.started", "payment.redirected", "gateway.request", "reconcile.checked"]);
    const [started, redirected, request, reconciled] = evs;
    expect(started).toMatchObject({ gateway: "esewa", amount_paisa: 10000, status: "initiated" });
    expect(started.data).toEqual({ return_https: false });
    expect(redirected.data).toEqual({ method: "POST", endpoint: "/api/epay/main/v2/form", gw_env: "sandbox" });
    expect(request.data).toEqual({ op: "status", method: "GET", endpoint: "/api/epay/transaction/status/", http_status: 200, gw_env: "sandbox" });
    expect(request.duration_ms).toBeGreaterThan(0);
    expect(reconciled.data?.source).toBe("reconcile");
    expect(reconciled.status).toBe(outcome.status === "pending" ? "pending" : undefined);
    expect(ingest.invalid).toEqual([]);
    console.log(`sandbox: status API took ${request.duration_ms} ms, outcome ${outcome.status}`);
  }, 60_000);

  it("blog module with a customer getter and an https return URL: started carries both, eSewa still accepts the form", async () => {
    const gateway = paynp.wrapGateway("esewa", blog, { customer: () => ({ phone: "9806800001", name: "Test Buyer" }) });
    const attemptId = hex();
    const start = await gateway.startPayment({ attemptId, amountPaisa: 10000, returnUrl: `https://shop.example.com/pay/return/${attemptId}`, description: "Order demo" });
    const res = await fetch(FORM_URL, { method: "POST", body: new URLSearchParams(start.fields), redirect: "manual" });
    expect(res.status).toBe(302);
    await paynp.flush();
    const evs = byTime(ingest.events.filter((e) => e.attempt_id === attemptId));
    expect(evs[0]).toMatchObject({ type: "payment.started", customer: { phone: "9806800001", name: "Test Buyer" }, data: { return_https: true } });
    expect(evs[1].data?.gw_env).toBe("sandbox");
  }, 60_000);

  it("blog module: a forged ?data= is rejected with the module's own PaymentError, no status call", async () => {
    const gateway = paynp.wrapGateway("esewa", blog);
    const attemptId = hex();
    const payload = {
      transaction_code: "000AAA1", status: "COMPLETE", total_amount: "100.0", transaction_uuid: attemptId, product_code: "EPAYTEST",
      signed_field_names: "transaction_code,status,total_amount,transaction_uuid,product_code,signed_field_names",
      signature: btoa("x".repeat(32)),
    };
    const data = btoa(JSON.stringify(payload));
    const err = await gateway.confirmPayment({ attemptId, amountPaisa: 10000, providerRef: null, params: { data } }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PaymentError);
    expect((err as Error).message).toBe("eSewa: bad signature on data");
    await paynp.flush();
    const evs = byTime(ingest.events.filter((e) => e.attempt_id === attemptId));
    expect(evs.map((e) => e.type)).toEqual(["callback.received", "signature.checked", "error"]);
    expect(evs[1].data).toEqual({ valid: false, reason: "bad_signature" });
    expect(evs[2].data?.reason).toBe("bad_signature");
    // the signed payload never reaches paynp
    expect(JSON.stringify(ingest.requests)).not.toContain(data);
  }, 60_000);

  it("blog module: a correctly signed ?data= passes, then the real status API answers", async () => {
    const gateway = paynp.wrapGateway("esewa", blog);
    const attemptId = hex();
    const names = "transaction_code,status,total_amount,transaction_uuid,product_code,signed_field_names";
    const fields: Record<string, string> = { transaction_code: "000AAA1", status: "COMPLETE", total_amount: "100.0", transaction_uuid: attemptId, product_code: "EPAYTEST", signed_field_names: names };
    const signature = await blog.hmacBase64(ESEWA_SANDBOX.secretKey, names.split(",").map((n) => `${n}=${fields[n]}`).join(","));
    const data = btoa(JSON.stringify({ ...fields, signature }));
    // Never submitted to eSewa, so the status API says NOT_FOUND: signature fine, attempt stays open.
    const outcome = await gateway.confirmPayment({ attemptId, amountPaisa: 10000, providerRef: null, params: { data } });
    expect(outcome.status).toBe("not_found");
    await paynp.flush();
    const evs = byTime(ingest.events.filter((e) => e.attempt_id === attemptId));
    expect(evs.map((e) => e.type)).toEqual(["callback.received", "signature.checked", "gateway.request"]);
    expect(evs[1].data).toEqual({ valid: true });
    expect(evs[2].data).toMatchObject({ endpoint: "/api/epay/transaction/status/", http_status: 200 });
    expect(evs[2].status).toBeUndefined(); // not_found says nothing about the attempt
  }, 60_000);

  it("skill adapter: initiate and verify against the sandbox", async () => {
    const adapter = paynp.wrapAdapter(esewaAdapter({ env: "sandbox", productCode: ESEWA_SANDBOX.productCode, secretKey: ESEWA_SANDBOX.secretKey }));
    const orderId = `pnp-${hex()}`;
    const r = await adapter.initiate({ orderId, amountPaisa: 10000, description: "Order demo", returnUrl: "http://localhost:3000/pay/return" });
    expect(r.kind).toBe("form");
    const v = await adapter.verify({ orderId, amountPaisa: 10000 });
    await paynp.flush();
    const evs = byTime(ingest.events.filter((e) => e.attempt_id === orderId));
    expect(evs.map((e) => e.type)).toEqual(["payment.started", "payment.redirected", "gateway.request", "reconcile.checked"]);
    expect(evs[2].data).toMatchObject({ op: "status", endpoint: "/api/epay/transaction/status/", http_status: 200, gw_env: "sandbox" });
    expect(evs[0].data).toEqual({ return_https: false });
    expect(evs[3].data).toMatchObject({ source: "reconcile", provider_status: "NOT_FOUND" });
    expect(v.status).toBe("not_found");
  }, 60_000);
});

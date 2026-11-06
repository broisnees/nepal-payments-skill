import { describe, expect, it } from "vitest";
import { createStatusClient } from "../src/index.ts";

const body = {
  gateways: [
    { gateway: "esewa", name: "eSewa", state: "down", action: "disable", message: "eSewa is not working right now." },
    { gateway: "khalti", name: "Khalti", state: "degraded", action: "warn", message: "Khalti is slow right now." },
    { gateway: "fonepay", name: "Fonepay", state: "operational", action: "show", message: null },
  ],
};

describe("createStatusClient", () => {
  it("reorders a checkout healthy first, keeps unknown ids last, and caches", async () => {
    let calls = 0;
    const fetch = (async () => {
      calls++;
      return new Response(JSON.stringify(body));
    }) as typeof globalThis.fetch;
    const s = createStatusClient({ fetch });
    const plan = await s.checkout(["esewa", "khalti", "paypal", "fonepay"]);
    expect(plan.order).toEqual(["fonepay", "khalti", "esewa", "paypal"]);
    expect(plan.available).toEqual(["fonepay", "khalti", "paypal"]);
    expect(await s.isAvailable("ESEWA")).toBe(false);
    expect(await s.isAvailable("khalti")).toBe(true);
    expect(calls).toBe(1);
  });

  it("fails open when the API is unreachable", async () => {
    const s = createStatusClient({ fetch: (async () => { throw new Error("offline"); }) as typeof globalThis.fetch });
    expect(await s.isAvailable("esewa")).toBe(true);
    expect((await s.checkout(["esewa", "khalti"])).available).toEqual(["esewa", "khalti"]);
  });
});

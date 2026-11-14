/** paymentsConfigFromEnv: which env vars enable which provider. */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createPayments, paymentsConfigFromEnv } from "../../src/index.ts";

describe("paymentsConfigFromEnv", () => {
  test("a provider is enabled only when its required vars are present", () => {
    assert.deepEqual(paymentsConfigFromEnv({}), {});
    assert.deepEqual(paymentsConfigFromEnv({ ESEWA_PRODUCT_CODE: "EPAYTEST" }), {});
    const cfg = paymentsConfigFromEnv({
      ESEWA_PRODUCT_CODE: "EPAYTEST",
      ESEWA_SECRET_KEY: "s",
      KHALTI_SECRET_KEY: "k",
      KHALTI_WEBSITE_URL: "https://shop.example",
      KHALTI_ENV: "live",
    });
    assert.deepEqual(Object.keys(cfg), ["esewa", "khalti"]);
    assert.equal(cfg.esewa?.env, "sandbox");
    assert.equal(cfg.khalti?.env, "production");
    assert.deepEqual(createPayments(cfg).enabled, ["esewa", "khalti"]);
  });

  test("PEMs from .env get real newlines; optional groups only when set", () => {
    const cfg = paymentsConfigFromEnv({
      ESEWA_PRODUCT_CODE: "EPAYTEST",
      ESEWA_SECRET_KEY: "s",
      ESEWA_INTENT_PRODUCT_CODE: "INTENT",
      ESEWA_INTENT_ACCESS_KEY: "a",
      NEPALPAY_ACQUIRER_ID: "00001701",
      NEPALPAY_MERCHANT_ID: "M",
      NEPALPAY_USERNAME: "u",
      NEPALPAY_PRIVATE_KEY_PEM: "line1\\nline2",
      NEPALPAY_CLIENT_ID: "cid",
    });
    assert.deepEqual(cfg.esewa?.intent, {
      productCode: "INTENT",
      accessKey: "a",
      baseUrl: undefined,
    });
    assert.equal(cfg.nepalpay?.privateKeyPem, "line1\nline2");
    assert.equal(cfg.nepalpay?.auth, "oauth");
    assert.equal(cfg.nepalpay?.clientSecret, "");
    assert.equal(cfg.nepalpay?.merchantCity, "Kathmandu");
    assert.equal("wsUrl" in (cfg.nepalpay ?? {}), false);
  });
});

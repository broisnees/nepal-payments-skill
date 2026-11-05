import { createHmac } from "node:crypto";
import { env } from "cloudflare:workers";
import { explain } from "@paynp/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderStatusPage } from "../src/ops/status-page.ts";
import { nptTime } from "../src/ops/verdict.ts";
import { call, cookieFrom, ev, ingest, json, setup, tokenFromMail, uniqueEmail, type Setup } from "./helpers.ts";

interface Received {
  url: string;
  headers: Headers;
  raw: string;
  body: any;
}
let received: Received[] = [];
/** What the fake merchant server answers next. */
let reply: (body: any) => Response | Promise<Response> = () => Response.json({ ok: true });

beforeEach(() => {
  received = [];
  reply = () => Response.json({ ok: true });
  const real = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const req = new Request(input as RequestInfo, init);
    if (!req.url.startsWith("https://merchant.test/")) return real(input as RequestInfo, init);
    const raw = await req.text();
    const body = JSON.parse(raw);
    received.push({ url: req.url, headers: req.headers, raw, body });
    return await reply(body);
  });
});
afterEach(() => vi.restoreAllMocks());

const api = (s: Setup, method: string, path: string, body?: unknown) => call(method, `/api/projects/${s.projectId}${path}`, { cookie: s.cookie, body });
const paid = (id: string, at: number, extra: Record<string, unknown> = {}, ref = `REF-${id}`) => [
  ev("payment.started", id, at, { status: "initiated", amount_paisa: 150000, ...extra }),
  ev("status.changed", id, at + 1000, { data: { to: "paid", provider_ref: ref } }),
];

/** Verifies an action request the way a merchant server would, with node:crypto only. */
function verify(r: Received, secret: string) {
  const ts = r.headers.get("x-paynp-timestamp")!;
  const expected = "sha256=" + createHmac("sha256", secret).update(`${ts}.${r.raw}`).digest("hex");
  expect(r.headers.get("x-paynp-signature")).toBe(expected);
  expect(Math.abs(Date.now() / 1000 - Number(ts))).toBeLessThan(300);
}

describe("action endpoint (3)", () => {
  it("PUT returns the secret once, GET masks it, rotate replaces it, test sends a signed ping, DELETE removes it", async () => {
    const s = await setup();
    expect((await api(s, "GET", "/action-endpoint?env=test")).status).toBe(404);
    const created = await api(s, "PUT", "/action-endpoint", { env: "test", url: "https://merchant.test/paynp/actions" });
    expect(created.status).toBe(201);
    const ep = await json(created);
    expect(ep.secret).toMatch(/^pas_[0-9A-Za-z]{40}$/);
    const got = await json(api(s, "GET", "/action-endpoint?env=test"));
    expect(got.secret).toContain("****");
    expect(got.secret).not.toBe(ep.secret);

    const updated = await json(api(s, "PUT", "/action-endpoint", { env: "test", url: "https://merchant.test/v2/actions" }));
    expect(updated.url).toBe("https://merchant.test/v2/actions");
    expect(updated.secret).toContain("****");

    const test = await api(s, "POST", "/action-endpoint/test", { env: "test" });
    expect(test.status).toBe(200);
    const action = await json(test);
    expect(action).toMatchObject({ kind: "ping", status: "ok" });
    expect(received).toHaveLength(1);
    expect(received[0].url).toBe("https://merchant.test/v2/actions");
    verify(received[0], ep.secret);
    expect(received[0].body).toMatchObject({ id: action.id, kind: "ping" });
    expect((await json(api(s, "GET", "/action-endpoint?env=test"))).last_ok_at).toBeGreaterThan(0);

    const rotated = await json(api(s, "PUT", "/action-endpoint", { env: "test", url: "https://merchant.test/v2/actions", rotate: true }));
    expect(rotated.secret).not.toBe(ep.secret);
    expect(rotated.secret).not.toContain("****");
    await api(s, "POST", "/action-endpoint/test", { env: "test" });
    verify(received[1], rotated.secret);

    // A server that answers badly is recorded on the endpoint and the action.
    reply = () => new Response("boom", { status: 500 });
    const bad = await api(s, "POST", "/action-endpoint/test", { env: "test" });
    expect(bad.status).toBe(502);
    expect((await json(bad)).response).toMatchObject({ ok: false, http_status: 500, error: "HTTP 500" });
    expect((await json(api(s, "GET", "/action-endpoint?env=test"))).last_error).toBe("HTTP 500");

    const log = await json(api(s, "GET", "/actions?env=test"));
    expect(log.items.map((a: any) => a.status)).toEqual(["failed", "ok", "ok"]);

    expect((await api(s, "DELETE", "/action-endpoint?env=test")).status).toBe(204);
    expect((await api(s, "GET", "/action-endpoint?env=test")).status).toBe(404);
  });

  it("live endpoints must be https; viewers cannot manage endpoints", async () => {
    const s = await setup();
    expect((await api(s, "PUT", "/action-endpoint", { env: "live", url: "http://shop.example.com/actions" })).status).toBe(400);
    expect((await api(s, "PUT", "/action-endpoint", { env: "live", url: "http://localhost:3000/actions" })).status).toBe(201);
    expect((await api(s, "PUT", "/action-endpoint", { env: "test", url: "http://shop.example.com/actions" })).status).toBe(201);
    const email = uniqueEmail("ov");
    await call("POST", `/api/orgs/${s.orgId}/invites`, { cookie: s.cookie, body: { email, role: "viewer" } });
    const viewer = cookieFrom(await call("GET", `/auth/invite?token=${tokenFromMail(email, "/auth/invite")}`));
    expect((await call("GET", `/api/projects/${s.projectId}/action-endpoint?env=test`, { cookie: viewer })).status).toBe(403);
    expect((await call("POST", `/api/projects/${s.projectId}/refunds`, { cookie: viewer, body: { env: "test", attempt_id: "x", reason: "y" } })).status).toBe(403);
    expect((await call("GET", `/api/projects/${s.projectId}/refunds?env=test`, { cookie: viewer })).status).toBe(200);
  });
});

describe("refund queue (4.1)", () => {
  it("lists duplicates with both payments and the gateway checklist; PATCH marks steps, records the ref and closes", async () => {
    const s = await setup();
    await ingest(s.key, [...paid("rq1", 0, { order_id: "ORD-Q", customer: { phone: "9841234567" } }), ...paid("rq2", 5000, { order_id: "ORD-Q" })]);
    const list = await json(api(s, "GET", "/refunds?env=test&status=open&kind=duplicate"));
    expect(list.open_count).toBe(1);
    expect(list.items).toHaveLength(1);
    const c = list.items[0];
    expect(c).toMatchObject({ kind: "duplicate", status: "open", attempt_id: "rq2", related_attempt_id: "rq1", can_send: false, has_refund_api: false });
    expect(c.payment).toMatchObject({ attempt_id: "rq2", status: "paid", provider_ref: "REF-rq2" });
    expect(c.related).toMatchObject({ attempt_id: "rq1", customer_mask: "98XXXXX567" });
    expect(c.checklist.map((x: any) => x.id)).toEqual(["portal", "confirm", "record"]);
    expect(c.checklist[0].text).toContain("eSewa merchant portal");
    expect(c.checklist[1].text).toContain("FULL_REFUND or PARTIAL_REFUND");

    const p1 = await json(api(s, "PATCH", `/refunds/${c.id}`, { checklist_step_done: "portal", note: "Emailed eSewa support" }));
    expect(p1.checklist[0]).toMatchObject({ id: "portal", by: s.email });
    expect(p1.checklist[0].done_at).toBeGreaterThan(0);
    expect(p1.note).toBe("Emailed eSewa support");
    expect((await api(s, "PATCH", `/refunds/${c.id}`, { checklist_step_done: "nope" })).status).toBe(400);
    const p2 = await json(api(s, "PATCH", `/refunds/${c.id}`, { refund_ref: "ES-RF-1", status: "refunded" }));
    expect(p2).toMatchObject({ status: "refunded", refund_ref: "ES-RF-1", resolved_by: s.email });
    expect(p2.checklist.find((x: any) => x.id === "record").done_at).toBeGreaterThan(0);
    expect((await json(api(s, "GET", "/refunds?env=test"))).open_count).toBe(0);
    const reopened = await json(api(s, "PATCH", `/refunds/${c.id}`, { status: "open" }));
    expect(reopened).toMatchObject({ status: "open", resolved_at: null });
  });

  it("POST creates a manual case for the unrefunded amount; validates the amount", async () => {
    const s = await setup();
    await ingest(s.key, [...paid("mc1", 0), ev("payment.refunded", "mc1", 3000, { amount_paisa: 50000 })]);
    const r = await api(s, "POST", "/refunds", { env: "test", attempt_id: "mc1", reason: "Buyer asked by phone", kind: "customer_request" });
    expect(r.status).toBe(201);
    expect(await json(r)).toMatchObject({ kind: "customer_request", status: "open", amount_paisa: 100000, reason: "Buyer asked by phone" });
    expect((await api(s, "POST", "/refunds", { env: "test", attempt_id: "mc1", reason: "x", amount_paisa: 100001 })).status).toBe(400);
    expect((await api(s, "POST", "/refunds", { env: "test", attempt_id: "nope", reason: "x" })).status).toBe(404);
    expect((await api(s, "POST", "/refunds", { env: "test", attempt_id: "mc1" })).status).toBe(400);
  });

  it("send: 409 without an endpoint; signed refund action; ok closes the case, ok:false marks it failed", async () => {
    const s = await setup();
    await ingest(s.key, [...paid("ks1", 0, { gateway: "khalti", order_id: "ORD-K" }, "GFq9PFS7b2iYvL8Lir9oXe"), ...paid("ks2", 4000, { gateway: "khalti", order_id: "ORD-K" }, "TXN-2")]);
    const [c] = (await json(api(s, "GET", "/refunds?env=test"))).items;
    expect(c).toMatchObject({ attempt_id: "ks2", gateway: "khalti", has_refund_api: true, can_send: false });
    expect(c.checklist.map((x: any) => x.id)).toEqual(["dashboard", "find", "refund", "record"]);
    const no = await api(s, "POST", `/refunds/${c.id}/send`);
    expect(no.status).toBe(409);
    expect((await json(no)).error.code).toBe("no_action_endpoint");

    const ep = await json(api(s, "PUT", "/action-endpoint", { env: "test", url: "https://merchant.test/actions" }));
    const withEp = await json(api(s, "GET", `/refunds/${c.id}`));
    expect(withEp.can_send).toBe(true);
    expect(withEp.checklist.map((x: any) => [x.id, x.kind])).toEqual([["send", "action"], ["confirm", "manual"]]);
    expect(withEp.checklist[0].text).toBe("Send refund via your server");

    reply = () => Response.json({ ok: false, error: "Khalti: transaction already refunded" });
    const failed = await api(s, "POST", `/refunds/${c.id}/send`);
    expect(failed.status).toBe(502);
    const f = await json(failed);
    expect(f.case).toMatchObject({ status: "failed", note: "Send failed: Khalti: transaction already refunded" });
    expect(f.action).toMatchObject({ kind: "refund", status: "failed" });

    reply = () => Response.json({ ok: true, refund_ref: "KH-REF-77", status: "refunded" });
    const sent = await api(s, "POST", `/refunds/${c.id}/send`);
    expect(sent.status).toBe(200);
    const out = await json(sent);
    expect(out.case).toMatchObject({ status: "refunded", refund_ref: "KH-REF-77", action_id: out.action.id, resolved_by: s.email });
    expect(out.case.checklist[0].done_at).toBeGreaterThan(0);
    const last = received[received.length - 1];
    verify(last, ep.secret);
    expect(last.body).toEqual({
      id: out.action.id,
      kind: "refund",
      attempt_id: "ks2",
      gateway: "khalti",
      order_id: "ORD-K",
      amount_paisa: 150000,
      provider_ref: "TXN-2",
      refund: { amount_paisa: 150000, reason: "Duplicate of ks1 (same order)" },
    });
    // Closed cases cannot be sent again.
    expect((await api(s, "POST", `/refunds/${c.id}/send`)).status).toBe(409);
    const log = await json(api(s, "GET", "/actions?env=test&attempt_id=ks2"));
    expect(log.items.map((a: any) => [a.kind, a.status])).toEqual([["refund", "ok"], ["refund", "failed"]]);
    expect(log.items[0].response).toMatchObject({ ok: true, refund_ref: "KH-REF-77" });
  });

  it("send keeps the action id when the merchant's SDK reports payment.refunded before it answers", async () => {
    const s = await setup();
    await ingest(s.key, [...paid("kr1", 0, { gateway: "khalti", order_id: "ORD-KR" }), ...paid("kr2", 4000, { gateway: "khalti", order_id: "ORD-KR" })]);
    const [c] = (await json(api(s, "GET", "/refunds?env=test"))).items;
    await api(s, "PUT", "/action-endpoint", { env: "test", url: "https://merchant.test/actions" });
    reply = async (body) => {
      // What @paynp/sdk does: emit payment.refunded and flush, then answer.
      await ingest(s.key, [ev("payment.refunded", body.attempt_id, 9000, { amount_paisa: body.refund.amount_paisa, data: { refund_ref: "KH-77", action_id: body.id } })]);
      return Response.json({ ok: true, refund_ref: "KH-77" });
    };
    const out = await json(api(s, "POST", `/refunds/${c.id}/send`));
    expect(out.case).toMatchObject({ status: "refunded", refund_ref: "KH-77", action_id: out.action.id, resolved_by: s.email });
    expect(out.case.checklist[0]).toMatchObject({ id: "send", by: s.email });
    expect(out.case.payment).toMatchObject({ status: "refunded", refunded_paisa: 150000 });
  });

  it("recheck sends a signed recheck action for the payment", async () => {
    const s = await setup();
    await ingest(s.key, [ev("payment.started", "rc1", 0, { status: "pending", amount_paisa: 1000, order_id: "ORD-RC" })]);
    expect((await api(s, "POST", "/payments/rc1/recheck", { env: "test" })).status).toBe(409);
    const ep = await json(api(s, "PUT", "/action-endpoint", { env: "test", url: "https://merchant.test/actions" }));
    reply = () => Response.json({ ok: true, status: "paid" });
    const r = await json(api(s, "POST", "/payments/rc1/recheck", { env: "test" }));
    expect(r).toMatchObject({ kind: "recheck", status: "ok", response: { ok: true, status: "paid" } });
    verify(received[0], ep.secret);
    expect(received[0].body).toMatchObject({ kind: "recheck", attempt_id: "rc1", order_id: "ORD-RC" });
  });
});

describe("lookup (4.2)", () => {
  async function seed() {
    const s = await setup();
    await ingest(s.key, [
      ...paid("lk1", 0, { order_id: "ORD-L1", customer: { phone: "+977 9851112233", email: "Ram@Example.com" } }, "0LD5CEH"),
      ev("payment.fulfilled", "lk1", 2000),
      ...paid("lk2", 60_000, { order_id: "ORD-L1", customer: { phone: "9851112233" } }, "0LD5CEJ"),
      ev("payment.started", "lk3", 120_000, { status: "initiated", amount_paisa: 150000, customer: { phone: "9851112233" } }),
      ev("payment.started", "lk4", 130_000, { status: "initiated", amount_paisa: 70000, customer: { phone: "9851112233" } }),
      ev("status.changed", "lk4", 131_000, { data: { to: "failed", reason: "amount_mismatch" } }),
      ev("payment.started", "lk5", 140_000, { status: "initiated", amount_paisa: 70000, order_id: "ORD-L5" }),
      ev("status.changed", "lk5", 141_000, { data: { to: "canceled" } }),
      ...paid("lk6", 150_000, { order_id: "ORD-L6" }, "0LD5CEK"),
      ev("payment.refunded", "lk6", 160_000, { amount_paisa: 150000, data: { refund_ref: "RF-L6" } }),
    ]);
    return s;
  }
  const lookup = async (s: Setup, qs: string) => json(api(s, "GET", `/lookup?env=test&${qs}`));
  const byId = (r: any) => Object.fromEntries(r.items.map((i: any) => [i.payment.attempt_id, i]));

  it("by phone in any format: every payment of that buyer with a verdict and one line of text", async () => {
    const s = await seed();
    for (const q of ["9851112233", "+977-985-111-2233", "09851112233"]) {
      const r = await lookup(s, `q=${encodeURIComponent(q)}`);
      expect(r.query.kind).toBe("phone");
      expect(r.items.map((i: any) => i.payment.attempt_id).sort()).toEqual(["lk1", "lk2", "lk3", "lk4"]);
    }
    const m = byId(await lookup(s, "q=9851112233"));
    const pay1 = (await env.DB.prepare("SELECT finished_at FROM payments WHERE project_id = ? AND attempt_id = 'lk1'").bind(s.projectId).first<{ finished_at: number }>())!;
    expect(m.lk1).toMatchObject({ verdict: "paid", fulfilled: true, matched_by: ["phone"], text: `Paid at ${nptTime(pay1.finished_at)}, eSewa ref 0LD5CEH.` });
    expect(m.lk1.text).toMatch(/^Paid at \d\d:\d\d on \d{1,2} [A-Z][a-z]{2} \d{4}, eSewa ref 0LD5CEH\.$/);
    expect(m.lk2).toMatchObject({ verdict: "paid_duplicate", duplicate_of: "lk1", fulfilled: false });
    expect(m.lk2.text).toMatch(/^Paid twice: .* a duplicate of lk1\. Refund this one\.$/);
    expect(m.lk3).toMatchObject({ verdict: "pending" });
    expect(m.lk3.text).toMatch(/but not finished: the buyer never came back\.$/);
    expect(m.lk4).toMatchObject({ verdict: "failed" });
    expect(m.lk4.text).toContain(explain({ gateway: "esewa", reason: "amount_mismatch" })!.title);
    expect(m.lk1.payment.customer_mask).toBe("98XXXXX233");
  });

  it("by email, provider ref, refund ref, attempt id and order id", async () => {
    const s = await seed();
    const email = await lookup(s, "q=ram%40example.com");
    expect(email.query.kind).toBe("email");
    expect(email.items.map((i: any) => i.payment.attempt_id)).toEqual(["lk1"]);
    expect(email.items[0].matched_by).toEqual(["email"]);

    const ref = await lookup(s, "q=0LD5CEJ");
    expect(ref.query.kind).toBe("ref");
    expect(ref.items.map((i: any) => [i.payment.attempt_id, i.matched_by])).toEqual([["lk2", ["ref"]]]);

    const refund = byId(await lookup(s, "q=RF-L6"));
    expect(refund.lk6).toMatchObject({ verdict: "refunded", matched_by: ["ref"] });
    expect(refund.lk6.text).toMatch(/^Refunded Rs 1,500\.00, eSewa ref 0LD5CEK\./);

    expect((await lookup(s, "q=lk5")).items.map((i: any) => [i.payment.attempt_id, i.verdict, i.matched_by])).toEqual([["lk5", "canceled", ["attempt"]]]);
    const order = await lookup(s, "q=ORD-L1");
    expect(order.items.map((i: any) => i.payment.attempt_id)).toEqual(["lk2", "lk1"]);
    expect(order.items[0].matched_by).toEqual(["order"]);
  });

  it("by amount in rupees or exact paisa, inside a time window", async () => {
    const s = await seed();
    const r = await lookup(s, "amount=1500");
    expect(r.query).toMatchObject({ kind: "none", amount_paisa: 150000 });
    expect(r.items.map((i: any) => i.payment.attempt_id).sort()).toEqual(["lk1", "lk2", "lk3", "lk6"]);
    expect(r.items[0].matched_by).toEqual(["amount"]);
    expect((await lookup(s, "amount=1%2C500.00")).items).toHaveLength(4);
    expect((await lookup(s, "amount_paisa=70000")).items.map((i: any) => i.payment.attempt_id).sort()).toEqual(["lk4", "lk5"]);
    const started = (await env.DB.prepare("SELECT started_at FROM payments WHERE project_id = ? AND attempt_id = 'lk3'").bind(s.projectId).first<{ started_at: number }>())!.started_at;
    const windowed = await lookup(s, `amount=1500&from=${started}&to=${started + 1}`);
    expect(windowed.items.map((i: any) => i.payment.attempt_id)).toEqual(["lk3"]);
    // Phone plus amount narrows.
    expect((await lookup(s, "q=9851112233&amount=700")).items.map((i: any) => i.payment.attempt_id)).toEqual(["lk4"]);
    expect((await api(s, "GET", "/lookup?env=test")).status).toBe(400);
    expect((await lookup(s, "q=nothing-here")).items).toEqual([]);
  });
});

describe("status links (4.2)", () => {
  it("creates a 7-day link; the public page shows status, amount, gateway, ref and the masked phone only", async () => {
    const s = await setup();
    await ingest(s.key, [
      ...paid("sl1", 0, { order_id: "ORD-SL", customer: { phone: "9812345678", email: "sita@example.com", name: "Sita Sharma" } }, "0LD5CEH"),
      ev("payment.started", "sl2", 0, { status: "initiated", amount_paisa: 2500 }),
    ]);
    const r = await api(s, "POST", "/payments/sl1/status-link", { env: "test" });
    expect(r.status).toBe(201);
    const link = await json(r);
    expect(link.url).toMatch(/^https:\/\/paynp\.test\/s\/[A-Za-z0-9_-]{43}$/);
    expect(link.expires_at - Date.now()).toBeGreaterThan(7 * 86_400_000 - 60_000);
    const token = link.url.split("/s/")[1];
    // Stored hashed.
    expect(await env.DB.prepare("SELECT 1 FROM status_links WHERE token_hash = ?").bind(token).first()).toBeNull();

    const page = await call("GET", `/s/${token}`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(page.headers.get("cache-control")).toBe("no-store");
    const html = await page.text();
    expect(html).toContain("<h1 class=\"ok\">Paid</h1>");
    expect(html).toContain("Rs 1,500.00");
    expect(html).toContain("eSewa");
    expect(html).toContain("0LD5CEH");
    expect(html).toContain("98XXXXX678");
    expect(html).toContain("Default"); // project name
    expect(html).toContain("prefers-color-scheme:dark");
    expect(html).not.toContain("<script");
    for (const pii of ["9812345678", "Sita", "sita@", "s***@"]) expect(html).not.toContain(pii);

    const pending = await json(api(s, "POST", "/payments/sl2/status-link", { env: "test", expires_days: 1 }));
    const html2 = await (await call("GET", `/s/${pending.url.split("/s/")[1]}`)).text();
    expect(html2).toContain("contact the merchant");

    // Expired: 404 page.
    const later = await renderStatusPage(env, pending.url.split("/s/")[1], Date.now() + 2 * 86_400_000);
    expect(later.status).toBe(404);
    expect(await later.text()).toContain("This link has expired");
    expect((await call("GET", "/s/not-a-real-token-but-long-enough")).status).toBe(404);
    expect((await api(s, "POST", "/payments/sl1/status-link", { env: "test", expires_days: 0 })).status).toBe(400);
    expect((await api(s, "POST", "/payments/none/status-link", { env: "test" })).status).toBe(404);
  });
});

describe("payment ops view", () => {
  it("customer mask and name, refunds, duplicate links both ways", async () => {
    const s = await setup();
    await ingest(s.key, [...paid("pv1", 0, { order_id: "ORD-PV", customer: { phone: "9800000002", name: "Hari" } }), ...paid("pv2", 3000, { order_id: "ORD-PV" })]);
    const a = await json(api(s, "GET", "/payments/pv1/ops?env=test"));
    expect(a).toMatchObject({ customer: { mask: "98XXXXX002", name: "Hari" }, refunded_paisa: 0, duplicate_of: null, duplicates: ["pv2"], refund_cases: [] });
    const b = await json(api(s, "GET", "/payments/pv2/ops?env=test"));
    expect(b.duplicate_of).toBe("pv1");
    expect(b.refund_cases).toHaveLength(1);
    expect((await api(s, "GET", "/payments/zz/ops?env=test")).status).toBe(404);
  });
});

import { evictDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { call, ev, ingest, json, setup, type Setup } from "./helpers.ts";

async function connect(s: Setup, opts: { pat?: string; origin?: string } = {}) {
  const path = `/api/projects/${s.projectId}/live?env=test${opts.pat ? `&access_token=${opts.pat}` : ""}`;
  const res = await call("GET", path, { cookie: opts.pat ? undefined : s.cookie, headers: { upgrade: "websocket", ...(opts.origin ? { origin: opts.origin } : {}) } });
  const ws = res.webSocket;
  const messages: any[] = [];
  if (ws) {
    ws.accept();
    ws.addEventListener("message", (m) => {
      messages.push(JSON.parse(m.data as string));
    });
  }
  return { res, ws, messages };
}

const tick = () => new Promise((r) => setTimeout(r, 50));

describe("ProjectLive", () => {
  it("sends the backlog first, then each accepted event with its payment, and pings on the alarm", async () => {
    const s = await setup();
    await ingest(s.key, [ev("payment.started", "lv1", 0, { status: "initiated", amount_paisa: 2000 })]);
    const { res, ws, messages } = await connect(s);
    expect(res.status).toBe(101);
    await tick();
    expect(messages[0].kind).toBe("backlog");
    expect(messages[0].events.map((e: { attempt_id: string }) => e.attempt_id)).toEqual(["lv1"]);

    const dup = ev("status.changed", "lv1", 1000, { data: { to: "paid" } });
    await ingest(s.key, [dup, dup]);
    await tick();
    const events = messages.filter((m) => m.kind === "event");
    expect(events).toHaveLength(1); // the duplicate is not broadcast
    expect(events[0].event).toMatchObject({ type: "status.changed", attempt_id: "lv1" });
    expect(events[0].event.received_at).toBeTypeOf("number");
    expect(events[0].payment).toMatchObject({ attempt_id: "lv1", status: "paid", amount_paisa: 2000, event_count: 2 });

    const stub = env.LIVE.getByName(`${s.projectId}:test`);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await tick();
    expect(messages.at(-1)).toEqual({ kind: "ping" });
    // The alarm re-arms while sockets are open.
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    ws!.send("ping");
    await tick();
    expect(messages.at(-1)).toEqual({ kind: "pong" });
    ws!.close(1000, "done");
  });

  it("keeps the last 200 events and rebuilds the backlog from D1 after eviction", async () => {
    const s = await setup();
    const { ws } = await connect(s);
    for (let b = 0; b < 3; b++) await ingest(s.key, Array.from({ length: 70 }, (_, i) => ev("gateway.request", `bk${b}`, b * 1000 + i)));
    const fresh = await connect(s);
    await tick();
    const backlog = fresh.messages[0].events;
    expect(backlog).toHaveLength(200);
    expect(backlog.at(-1).attempt_id).toBe("bk2");
    ws!.close();
    fresh.ws!.close();

    await evictDurableObject(env.LIVE.getByName(`${s.projectId}:test`), { webSockets: "close" });
    const after = await connect(s);
    await tick();
    expect(after.messages[0].events).toHaveLength(200);
    expect(after.messages[0].events.map((e: { id: string }) => e.id)).toEqual(backlog.map((e: { id: string }) => e.id));
    after.ws!.close();
  });

  it("needs a WebSocket upgrade, refuses cross-origin upgrades, accepts a PAT as access_token", async () => {
    const s = await setup();
    expect((await call("GET", `/api/projects/${s.projectId}/live?env=test`, { cookie: s.cookie })).status).toBe(400);
    expect((await connect(s, { origin: "https://evil.example" })).res.status).toBe(403);
    const d = await json(call("POST", "/auth/device"));
    await call("POST", "/api/device/approve", { cookie: s.cookie, body: { user_code: d.user_code } });
    const { token } = await json(call("POST", "/auth/device/token", { body: { device_code: d.device_code } }));
    const viaPat = await connect(s, { pat: token });
    expect(viaPat.res.status).toBe(101);
    viaPat.ws!.close();
    const other = await setup();
    // Only for projects the PAT's user can see.
    const res = await call("GET", `/api/projects/${other.projectId}/live?env=test&access_token=${token}`, { headers: { upgrade: "websocket" } });
    expect(res.status).toBe(404);
  });
});

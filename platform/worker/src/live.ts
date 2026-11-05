// ProjectLive: one Durable Object per "project:env" (platform/SPEC.md section 7).
// Hibernating WebSockets; a backlog of the last 200 events (rebuilt from D1 after eviction); a ping every 30 s.
import { DurableObject } from "cloudflare:workers";
import type { LiveMessage, Payment, StoredEvent } from "@paynp/shared";
import { toEvent } from "./lib/rows.ts";
import type { EventRow } from "./types.ts";

export const BACKLOG_SIZE = 200;
export const HEARTBEAT_MS = 30_000;

export interface LiveItem {
  event: StoredEvent;
  payment: Payment;
}

export class ProjectLive extends DurableObject<Env> {
  private backlog: StoredEvent[] | null = null;
  private loading: Promise<StoredEvent[]> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Clients may send "ping" as a keepalive; answered without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", JSON.stringify({ kind: "pong" })));
  }

  /** Memory first; after a cold start or eviction, the newest events from D1 (ingest writes there before publishing). */
  private load(projectId: string, envName: string): Promise<StoredEvent[]> {
    if (this.backlog) return Promise.resolve(this.backlog);
    this.loading ??= this.env.DB.prepare("SELECT * FROM events WHERE project_id = ? AND env = ? ORDER BY ts DESC, id DESC LIMIT ?")
      .bind(projectId, envName, BACKLOG_SIZE)
      .all<EventRow>()
      .then((r) => {
        this.backlog ??= r.results.reverse().map(toEvent);
        return this.backlog;
      })
      .finally(() => {
        this.loading = null;
      });
    return this.loading;
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("expected a WebSocket upgrade", { status: 426 });
    const url = new URL(request.url);
    const projectId = url.searchParams.get("project") ?? "";
    const envName = url.searchParams.get("env") ?? "test";
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    const backlog = await this.load(projectId, envName);
    server.send(JSON.stringify({ kind: "backlog", events: backlog } satisfies LiveMessage));
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + HEARTBEAT_MS);
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Called by ingest (RPC) with the accepted events and their updated payments. */
  async publish(projectId: string, envName: string, items: LiveItem[]): Promise<number> {
    const hadBacklog = this.backlog !== null;
    const backlog = await this.load(projectId, envName);
    // A backlog freshly read from D1 already holds these events.
    if (hadBacklog) {
      backlog.push(...items.map((i) => i.event));
      if (backlog.length > BACKLOG_SIZE) backlog.splice(0, backlog.length - BACKLOG_SIZE);
    }
    const sockets = this.ctx.getWebSockets();
    for (const item of items) {
      const msg = JSON.stringify({ kind: "event", event: item.event, payment: item.payment } satisfies LiveMessage);
      for (const ws of sockets) {
        try {
          ws.send(msg);
        } catch {
          // closed between getWebSockets() and send()
        }
      }
    }
    return sockets.length;
  }

  async alarm(): Promise<void> {
    const sockets = this.ctx.getWebSockets();
    if (!sockets.length) return;
    const ping = JSON.stringify({ kind: "ping" } satisfies LiveMessage);
    for (const ws of sockets) {
      try {
        ws.send(ping);
      } catch {
        // ignore
      }
    }
    await this.ctx.storage.setAlarm(Date.now() + HEARTBEAT_MS);
  }

  async webSocketMessage(): Promise<void> {
    // The stream is one way; anything other than the auto-answered "ping" is ignored.
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try {
      ws.close(code, reason);
    } catch {
      // already closed
    }
  }
}

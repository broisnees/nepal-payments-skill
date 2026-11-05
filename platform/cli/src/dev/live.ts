// The live stream for `paynp dev`: a small RFC 6455 server over the node:http upgrade event, speaking the
// same messages as the worker's ProjectLive (SPEC section 7): a backlog first, then one message per event,
// {"kind":"ping"} every 30 s, and "ping" from a client answered with {"kind":"pong"}.
import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { LiveMessage, Payment, StoredEvent } from "../../../shared/src/api.ts";
import { frame, parseFrames } from "../ws.ts";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
export const BACKLOG_SIZE = 200;
export const HEARTBEAT_MS = 30_000;

interface Client {
  socket: Duplex;
  env: string;
}

export class LiveHub {
  private readonly clients = new Set<Client>();
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(heartbeatMs = HEARTBEAT_MS) {
    this.timer = setInterval(() => this.broadcast(null, { kind: "ping" }), heartbeatMs);
    this.timer.unref();
  }

  get size(): number {
    return this.clients.size;
  }

  /** Completes the handshake and sends the backlog. Answers 400 to anything that is not a WebSocket upgrade. */
  accept(req: IncomingMessage, socket: Duplex, env: string, backlog: StoredEvent[]): void {
    const key = req.headers["sec-websocket-key"];
    if (req.headers.upgrade?.toLowerCase() !== "websocket" || typeof key !== "string") {
      socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      return;
    }
    const accept = createHash("sha1").update(key + GUID).digest("base64");
    socket.write(["HTTP/1.1 101 Switching Protocols", "Upgrade: websocket", "Connection: Upgrade", `Sec-WebSocket-Accept: ${accept}`, "", ""].join("\r\n"));
    const client: Client = { socket, env };
    this.clients.add(client);
    let buf: Buffer = Buffer.alloc(0);
    const drop = () => this.clients.delete(client);
    socket.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const { frames, rest } = parseFrames(buf);
      buf = rest;
      for (const f of frames) {
        if (f.opcode === 0x8) {
          // Echo the close and hang up.
          socket.end(frame(0x8, f.payload.subarray(0, 2), false));
          drop();
        } else if (f.opcode === 0x9) socket.write(frame(0xa, f.payload, false));
        else if (f.opcode === 0x1 && f.payload.toString("utf8") === "ping") this.send(client, { kind: "pong" } as unknown as LiveMessage);
      }
    });
    socket.on("close", drop);
    socket.on("error", drop);
    this.send(client, { kind: "backlog", events: backlog });
  }

  publish(env: string, items: { event: StoredEvent; payment: Payment }[]): void {
    for (const i of items) this.broadcast(env, { kind: "event", event: i.event, payment: i.payment });
  }

  private broadcast(env: string | null, msg: LiveMessage): void {
    for (const c of this.clients) if (env === null || c.env === env) this.send(c, msg);
  }

  private send(c: Client, msg: LiveMessage): void {
    try {
      c.socket.write(frame(0x1, Buffer.from(JSON.stringify(msg)), false));
    } catch {
      this.clients.delete(c);
    }
  }

  close(): void {
    clearInterval(this.timer);
    for (const c of this.clients) {
      try {
        c.socket.end(frame(0x8, Buffer.from([0x03, 0xe9]), false)); // 1001 going away
      } catch {
        // already gone
      }
      c.socket.destroy();
    }
    this.clients.clear();
  }
}

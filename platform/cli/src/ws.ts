// A small WebSocket client (RFC 6455) over node:http/https. Text frames, ping/pong, close.
// Written here instead of using the runtime's WebSocket because that one cannot send an
// Authorization header, and Node 20 has no global WebSocket at all.
import { randomBytes, createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Socket } from "node:net";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export interface WsHandlers {
  onOpen?: () => void;
  onMessage: (text: string) => void;
  onClose: (code: number, reason: string) => void;
  onError?: (err: Error) => void;
}

export interface WsConnection {
  close(code?: number): void;
}

/** Builds one masked client frame. */
export function frame(opcode: number, payload: Buffer, mask = true): Buffer {
  const len = payload.length;
  const head: number[] = [0x80 | opcode];
  const m = mask ? 0x80 : 0;
  if (len < 126) head.push(m | len);
  else if (len < 65536) head.push(m | 126, len >> 8, len & 255);
  else {
    head.push(m | 127, 0, 0, 0, 0);
    head.push((len >>> 24) & 255, (len >>> 16) & 255, (len >>> 8) & 255, len & 255);
  }
  if (!mask) return Buffer.concat([Buffer.from(head), payload]);
  const key = randomBytes(4);
  const body = Buffer.alloc(len);
  for (let i = 0; i < len; i++) body[i] = payload[i] ^ key[i & 3];
  return Buffer.concat([Buffer.from(head), key, body]);
}

/** Parses as many complete frames as `buf` holds. Returns them and the leftover bytes. */
export function parseFrames(buf: Buffer): { frames: { fin: boolean; opcode: number; payload: Buffer }[]; rest: Buffer } {
  const frames: { fin: boolean; opcode: number; payload: Buffer }[] = [];
  let off = 0;
  while (buf.length - off >= 2) {
    const b0 = buf[off];
    const b1 = buf[off + 1];
    let len = b1 & 0x7f;
    let p = off + 2;
    if (len === 126) {
      if (buf.length - p < 2) break;
      len = buf.readUInt16BE(p);
      p += 2;
    } else if (len === 127) {
      if (buf.length - p < 8) break;
      len = Number(buf.readBigUInt64BE(p));
      p += 8;
    }
    const masked = (b1 & 0x80) !== 0;
    let key: Buffer | undefined;
    if (masked) {
      if (buf.length - p < 4) break;
      key = buf.subarray(p, p + 4);
      p += 4;
    }
    if (buf.length - p < len) break;
    let payload = Buffer.from(buf.subarray(p, p + len));
    if (key) for (let i = 0; i < payload.length; i++) payload[i] ^= key[i & 3];
    frames.push({ fin: (b0 & 0x80) !== 0, opcode: b0 & 0x0f, payload });
    off = p + len;
  }
  return { frames, rest: buf.subarray(off) };
}

export function connect(url: string, headers: Record<string, string>, h: WsHandlers): WsConnection {
  const u = new URL(url);
  const secure = u.protocol === "wss:" || u.protocol === "https:";
  const key = randomBytes(16).toString("base64");
  const req = (secure ? httpsRequest : httpRequest)({
    host: u.hostname,
    port: u.port || (secure ? 443 : 80),
    path: u.pathname + u.search,
    headers: {
      ...headers,
      Connection: "Upgrade",
      Upgrade: "websocket",
      "Sec-WebSocket-Key": key,
      "Sec-WebSocket-Version": "13",
    },
  });
  let socket: Socket | undefined;
  let closed = false;
  const finish = (code: number, reason: string) => {
    if (closed) return;
    closed = true;
    socket?.destroy();
    h.onClose(code, reason);
  };

  req.on("response", (res) => {
    let body = "";
    res.setEncoding("utf8");
    res.on("data", (c) => (body += c));
    res.on("end", () => finish(res.statusCode ?? 0, body.slice(0, 300)));
  });
  req.on("error", (err) => {
    h.onError?.(err);
    finish(1006, err.message);
  });
  req.on("upgrade", (res, sock, head) => {
    socket = sock;
    const expected = createHash("sha1").update(key + GUID).digest("base64");
    if (res.headers["sec-websocket-accept"] !== expected) {
      finish(1002, "bad Sec-WebSocket-Accept");
      return;
    }
    sock.setNoDelay(true);
    h.onOpen?.();
    let buf: Buffer = Buffer.from(head);
    let parts: Buffer[] = [];
    const onData = (chunk: Buffer) => {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      const { frames, rest } = parseFrames(buf);
      buf = Buffer.from(rest);
      for (const f of frames) {
        if (f.opcode === 0x9) sock.write(frame(0xa, f.payload));
        else if (f.opcode === 0x8) {
          const code = f.payload.length >= 2 ? f.payload.readUInt16BE(0) : 1005;
          try {
            sock.write(frame(0x8, f.payload.subarray(0, 2)));
          } catch {
            /* already gone */
          }
          finish(code, f.payload.subarray(2).toString("utf8"));
          return;
        } else if (f.opcode === 0x1 || f.opcode === 0x0) {
          parts.push(f.payload);
          if (f.fin) {
            const text = Buffer.concat(parts).toString("utf8");
            parts = [];
            h.onMessage(text);
          }
        }
      }
    };
    if (buf.length) onData(Buffer.alloc(0));
    sock.on("data", onData);
    sock.on("close", () => finish(1006, "connection closed"));
    sock.on("error", (err) => {
      h.onError?.(err);
      finish(1006, err.message);
    });
  });
  req.end();

  return {
    close(code = 1000) {
      if (socket && !closed) {
        const p = Buffer.alloc(2);
        p.writeUInt16BE(code);
        try {
          socket.write(frame(0x8, p));
        } catch {
          /* ignore */
        }
      }
      req.destroy();
      finish(code, "closed by client");
    },
  };
}

// One WebSocket per project and environment, shared by every component that listens, with reconnect.
import type { Env, LiveMessage } from "@paynp/shared";
import { useEffect, useRef, useState } from "react";

export type LiveState = "connecting" | "open" | "closed";
type Handler = (m: LiveMessage) => void;

interface Conn {
  ws: WebSocket | null;
  handlers: Set<Handler>;
  states: Set<(s: LiveState) => void>;
  state: LiveState;
  retry: number;
  timer: ReturnType<typeof setTimeout> | null;
}

const conns = new Map<string, Conn>();

function url(project: string, env: Env) {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/api/projects/${encodeURIComponent(project)}/live?env=${env}`;
}

function setState(c: Conn, s: LiveState) {
  c.state = s;
  for (const fn of c.states) fn(s);
}

function open(key: string, project: string, env: Env, c: Conn) {
  setState(c, "connecting");
  const ws = new WebSocket(url(project, env));
  c.ws = ws;
  ws.onopen = () => {
    c.retry = 0;
    setState(c, "open");
  };
  ws.onmessage = (ev) => {
    let m: LiveMessage;
    try {
      m = JSON.parse(String(ev.data)) as LiveMessage;
    } catch {
      return;
    }
    for (const fn of c.handlers) fn(m);
  };
  ws.onclose = () => {
    c.ws = null;
    setState(c, "closed");
    if (!c.handlers.size) return;
    // 1s, 2s, 4s ... capped at 30s, with jitter so a deploy does not reconnect everyone at once.
    const delay = Math.min(30_000, 1000 * 2 ** c.retry++) * (0.75 + Math.random() * 0.5);
    c.timer = setTimeout(() => open(key, project, env, c), delay);
  };
}

export function subscribeLive(project: string, env: Env, handler: Handler, onState?: (s: LiveState) => void): () => void {
  const key = `${project}:${env}`;
  let c = conns.get(key);
  if (!c) {
    c = { ws: null, handlers: new Set(), states: new Set(), state: "connecting", retry: 0, timer: null };
    conns.set(key, c);
  }
  c.handlers.add(handler);
  if (onState) {
    c.states.add(onState);
    onState(c.state);
  }
  if (!c.ws && !c.timer) open(key, project, env, c);
  const conn = c;
  return () => {
    conn.handlers.delete(handler);
    if (onState) conn.states.delete(onState);
    if (conn.handlers.size) return;
    if (conn.timer) clearTimeout(conn.timer);
    conn.ws?.close();
    conns.delete(key);
  };
}

export function useLive(project: string | undefined, env: Env, handler: Handler, enabled = true): LiveState {
  const [state, setS] = useState<LiveState>("connecting");
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    if (!project || !enabled) return;
    return subscribeLive(project, env, (m) => ref.current(m), setS);
  }, [project, env, enabled]);
  return state;
}

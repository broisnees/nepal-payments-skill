// A small stale-while-revalidate cache keyed by URL. Enough for a dashboard; no library needed.
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { api } from "./api.ts";

interface Entry {
  data: unknown;
  error: unknown;
  loading: boolean;
  at: number;
  inflight: Promise<void> | null;
  subs: Set<() => void>;
  snapshot: Snapshot<unknown>;
}

export interface Snapshot<T> {
  data: T | undefined;
  error: unknown;
  loading: boolean;
}

const cache = new Map<string, Entry>();
const EMPTY: Snapshot<never> = { data: undefined, error: undefined, loading: false };

function entry(key: string): Entry {
  let e = cache.get(key);
  if (!e) {
    e = { data: undefined, error: undefined, loading: false, at: 0, inflight: null, subs: new Set(), snapshot: EMPTY };
    cache.set(key, e);
  }
  return e;
}

function publish(e: Entry) {
  e.snapshot = { data: e.data, error: e.error, loading: e.loading };
  for (const fn of e.subs) fn();
}

export function fetchKey(key: string): Promise<void> {
  const e = entry(key);
  if (e.inflight) return e.inflight;
  e.loading = true;
  publish(e);
  e.inflight = api<unknown>(key)
    .then(
      (data) => {
        e.data = data;
        e.error = undefined;
      },
      (err) => {
        e.error = err;
      },
    )
    .finally(() => {
      e.loading = false;
      e.at = Date.now();
      e.inflight = null;
      publish(e);
    });
  return e.inflight;
}

/** Refetches every cached key that starts with `prefix`. */
export function invalidate(prefix: string) {
  for (const [k, e] of cache) if (k.startsWith(prefix) && e.subs.size) void fetchKey(k);
  for (const [k, e] of cache) if (k.startsWith(prefix) && !e.subs.size) cache.delete(k);
}

/** Replaces cached data in place (optimistic and live updates). */
export function setData<T>(key: string, fn: (prev: T | undefined) => T | undefined) {
  const e = entry(key);
  e.data = fn(e.data as T | undefined);
  publish(e);
}

export function useQuery<T>(key: string | null, opts: { refreshMs?: number; staleMs?: number } = {}) {
  const subscribe = useCallback(
    (fn: () => void) => {
      if (!key) return () => {};
      const e = entry(key);
      e.subs.add(fn);
      return () => e.subs.delete(fn);
    },
    [key],
  );
  const snap = useSyncExternalStore(subscribe, () => (key ? (entry(key).snapshot as Snapshot<T>) : EMPTY));

  const staleMs = opts.staleMs ?? 15_000;
  useEffect(() => {
    if (!key) return;
    const e = entry(key);
    if (e.data === undefined || Date.now() - e.at > staleMs) void fetchKey(key);
    if (!opts.refreshMs) return;
    const id = setInterval(() => {
      if (document.visibilityState === "visible") void fetchKey(key);
    }, opts.refreshMs);
    return () => clearInterval(id);
  }, [key, opts.refreshMs, staleMs]);

  const refresh = useCallback(() => (key ? fetchKey(key) : Promise.resolve()), [key]);
  return { ...snap, refresh, initial: snap.data === undefined && snap.error === undefined };
}

/**
 * An optimistic change: the UI updates now, the request runs, and a failure puts the previous data back before
 * rethrowing. The key is refetched afterwards either way, so the screen ends on what the server holds.
 */
export async function optimistic<T, R = unknown>(key: string, update: (prev: T | undefined) => T | undefined, request: () => Promise<R>): Promise<R> {
  const e = entry(key);
  const before = e.data;
  setData<T>(key, update);
  try {
    return await request();
  } catch (err) {
    e.data = before;
    publish(e);
    throw err;
  } finally {
    invalidate(key);
  }
}

/** Drops one row from a cached page, for removals. */
export const without =
  <T extends { id: string }>(id: string) =>
  (pg: { items: T[]; next_cursor: string | null } | undefined) =>
    pg && { ...pg, items: pg.items.filter((x) => x.id !== id) };

/** Patches one row of a cached page in place. */
export const patchRow =
  <T extends { id: string }>(id: string, patch: Partial<T>) =>
  (pg: { items: T[]; next_cursor: string | null } | undefined) =>
    pg && { ...pg, items: pg.items.map((x) => (x.id === id ? { ...x, ...patch } : x)) };

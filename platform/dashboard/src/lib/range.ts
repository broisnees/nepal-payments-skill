import { useEffect, useState } from "react";

export type RangeKey = "24h" | "7d" | "30d";
export const RANGES: Record<RangeKey, { ms: number; bucket: "hour" | "day"; label: string; prev: string }> = {
  "24h": { ms: 86_400_000, bucket: "hour", label: "Last 24 hours", prev: "previous 24 hours" },
  "7d": { ms: 7 * 86_400_000, bucket: "day", label: "Last 7 days", prev: "previous 7 days" },
  "30d": { ms: 30 * 86_400_000, bucket: "day", label: "Last 30 days", prev: "previous 30 days" },
};

/** The end of the current minute, so query keys stay stable between renders and still include this minute. */
const endOfMinute = () => Math.ceil((Date.now() + 1) / 60_000) * 60_000;
export function useMinute(): number {
  const [t, setT] = useState(endOfMinute);
  useEffect(() => {
    const id = setInterval(() => setT(endOfMinute()), 15_000);
    return () => clearInterval(id);
  }, []);
  return t;
}

export function isRange(v: string | null): v is RangeKey {
  return v === "24h" || v === "7d" || v === "30d";
}

// Latency histogram for the public status page. status_minutes keeps counts per bucket so a p95 can be merged across
// projects, batches, minutes and hours without storing raw samples.

/** Upper bounds (ms) of buckets h0 to h7; h8 is everything above 10 s. */
export const BOUNDS = [100, 250, 500, 1000, 2000, 3000, 5000, 10_000] as const;
export const BUCKETS = BOUNDS.length + 1;
export const H_COLS = Array.from({ length: BUCKETS }, (_, i) => `h${i}`);

export const emptyHist = () => new Array<number>(BUCKETS).fill(0);

export function bucketOf(ms: number): number {
  for (let i = 0; i < BOUNDS.length; i++) if (ms <= BOUNDS[i]) return i;
  return BOUNDS.length;
}

export function addHist(into: number[], from: readonly number[]): number[] {
  for (let i = 0; i < BUCKETS; i++) into[i] += from[i] ?? 0;
  return into;
}

/** p95 as the upper bound of the bucket that holds the 95th percentile; above 10 s it is the largest sample seen. */
export function p95(hist: readonly number[], max: number): number | null {
  const n = hist.reduce((s, x) => s + x, 0);
  if (!n) return null;
  let c = 0;
  for (let i = 0; i < BOUNDS.length; i++) {
    c += hist[i];
    if (100 * c >= 95 * n) return BOUNDS[i];
  }
  return Math.max(max, BOUNDS[BOUNDS.length - 1] + 1);
}

/** The same p95 in SQL, over the sum of the stored row and the incoming one (for ON CONFLICT DO UPDATE). */
export function p95UpsertSql(): string {
  const h = (i: number) => `(${H_COLS[i]} + excluded.${H_COLS[i]})`;
  const cum = (k: number) => Array.from({ length: k + 1 }, (_, i) => h(i)).join(" + ");
  const n = cum(BUCKETS - 1);
  const whens = BOUNDS.map((b, i) => `WHEN 100 * (${cum(i)}) >= 95 * (${n}) THEN ${b}`).join(" ");
  return `CASE WHEN (${n}) = 0 THEN NULL ${whens} ELSE MAX(ms_max, excluded.ms_max, ${BOUNDS[BOUNDS.length - 1] + 1}) END`;
}

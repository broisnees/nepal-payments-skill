// uPlot wrapper for time series: thin marks, hairline grid, one y axis, crosshair tooltip, theme-aware colors.
import { useEffect, useRef } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { TZ, formatDay, formatFull, formatHM } from "../lib/format.ts";

export interface ChartSeries {
  label: string;
  values: (number | null)[];
  /** A CSS custom property, e.g. "--st-paid". Resolved at draw time so the theme toggle repaints it. */
  color: string;
  kind: "bar" | "line";
  /** Stacked bars: this series is drawn on top of the ones before it. */
  stack?: boolean;
  /** Tooltip value formatter for this series (defaults to the chart's yFormat). */
  format?: (v: number | null) => string;
}

export interface TimeChartProps {
  t: number[];
  series: ChartSeries[];
  height?: number;
  bucket: "hour" | "day";
  yFormat: (v: number) => string;
  yMax?: number;
  /** Counts: ticks stay on whole numbers. */
  integer?: boolean;
  ariaLabel: string;
}

const cssVar = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "#888";

export default function TimeChart({ t, series, height = 220, bucket, yFormat, yMax, integer, ariaLabel }: TimeChartProps) {
  const host = useRef<HTMLDivElement>(null);
  const tip = useRef<HTMLDivElement>(null);
  const plot = useRef<uPlot | null>(null);
  const allBars = series.every((s) => s.kind === "bar");

  useEffect(() => {
    const el = host.current;
    if (!el) return;

    // Stacked bars draw cumulative totals, the top segment first, so each segment shows its own share.
    const stacked: (number | null)[][] = [];
    let acc: number[] = t.map(() => 0);
    for (const s of series) {
      if (s.stack) {
        acc = acc.map((a, i) => a + (s.values[i] ?? 0));
        stacked.push([...acc]);
      } else stacked.push(s.values);
    }
    const order = series.map((_, i) => i);
    const drawOrder = allBars ? [...order].reverse() : order;

    const make = () => {
      const surface = cssVar("--bg");
      const muted = cssVar("--subtle");
      const grid = cssVar("--grid");
      const axis = cssVar("--axis");
      const font = `11px ${cssVar("--font").split(",")[0] || "sans-serif"}, system-ui, sans-serif`;
      const barW = bucket === "day" ? 0.6 : 0.7;
      const bars = uPlot.paths.bars!({ size: [barW, 24, 2], align: 0 });

      const opts: uPlot.Options = {
        width: el.clientWidth || 600,
        height,
        ms: 1,
        tzDate: (ts) => uPlot.tzDate(new Date(ts), TZ),
        padding: [8, allBars ? 4 : 20, 0, 0],
        legend: { show: false },
        cursor: {
          y: false,
          points: { size: 8, width: 2, stroke: () => surface, fill: (_u, i) => cssVar(series[i - 1]?.color ?? "--ink") },
          drag: { x: false, y: false },
        },
        select: { show: false, left: 0, top: 0, width: 0, height: 0 },
        scales: {
          x: { time: true, range: (_u, min, max) => (allBars ? [min - bucketMs(bucket) / 2, max + bucketMs(bucket) / 2] : [min, max]) },
          y: { range: (_u, _min, max) => [0, yMax ?? niceScale(max, integer).max] },
        },
        axes: [
          {
            stroke: muted,
            font,
            grid: { show: false },
            ticks: { show: true, stroke: axis, width: 1, size: 4 },
            border: { show: true, stroke: axis, width: 1 },
            values: (_u, splits) => splits.map((v) => (bucket === "day" ? formatDay(v) : formatHM(v))),
            // Daily data gets whole-day ticks only; otherwise a short range repeats each date at noon.
            incrs: bucket === "day" ? [86_400_000, 2 * 86_400_000, 7 * 86_400_000, 14 * 86_400_000, 30 * 86_400_000] : undefined,
            space: 64,
          },
          {
            stroke: muted,
            font,
            size: 52,
            gap: 6,
            grid: { stroke: grid, width: 1 },
            ticks: { show: false },
            values: (_u, splits) => splits.map((v) => yFormat(v)),
            splits: (_u, _ai, _min, max) => {
              const step = yMax ? yMax / 4 : niceScale(max, integer).step;
              const out: number[] = [];
              for (let v = 0; v <= max + step / 1000; v += step) out.push(v);
              return out;
            },
          },
        ],
        series: [
          {},
          ...drawOrder.map((i) => {
            const s = series[i];
            const color = cssVar(s.color);
            return s.kind === "bar"
              ? { label: s.label, fill: color, stroke: surface, width: 2, paths: bars, points: { show: false } }
              : { label: s.label, stroke: color, width: 2, fill: series.length === 1 ? withAlpha(color, 0.08) : undefined, points: { show: false }, spanGaps: false };
          }),
        ],
        hooks: {
          setCursor: [
            (u) => {
              const box = tip.current;
              if (!box) return;
              const idx = u.cursor.idx;
              if (idx === null || idx === undefined || u.cursor.left === undefined || u.cursor.left < 0) {
                box.style.display = "none";
                return;
              }
              const rows = series
                .map((s) => {
                  const v = s.values[idx];
                  const fmt = s.format ?? ((x: number | null) => (x === null ? "-" : yFormat(x)));
                  return `<div class="tip-row"><span class="sw" style="background:${cssVar(s.color)}"></span>${s.label}<span class="v">${fmt(v)}</span></div>`;
                })
                .join("");
              box.innerHTML = `<div class="tip-t">${bucket === "day" ? formatDay(t[idx]) : formatFull(t[idx]).replace(":00 NPT", " NPT")}</div>${rows}`;
              box.style.display = "block";
              const left = u.cursor.left + u.bbox.left / devicePixelRatio;
              const w = box.offsetWidth;
              const x = left + 14 + w > el.clientWidth ? left - w - 14 : left + 14;
              box.style.transform = `translate(${Math.max(0, x)}px, 8px)`;
            },
          ],
        },
      };
      const data: uPlot.AlignedData = [t, ...drawOrder.map((i) => stacked[i])];
      plot.current?.destroy();
      plot.current = new uPlot(opts, data, el);
    };

    make();
    const ro = new ResizeObserver(() => plot.current?.setSize({ width: el.clientWidth, height }));
    ro.observe(el);
    // Repaint with the other palette when the theme changes, from the toggle or the OS.
    const mo = new MutationObserver(make);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const mq = matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", make);
    return () => {
      ro.disconnect();
      mo.disconnect();
      mq.removeEventListener("change", make);
      plot.current?.destroy();
      plot.current = null;
    };
  }, [t, series, height, bucket, yFormat, yMax, integer, allBars]);

  return (
    <div className="chart" role="img" aria-label={ariaLabel} style={{ minHeight: height }}>
      <div ref={host} />
      <div ref={tip} className="chart-tip" />
    </div>
  );
}

function bucketMs(b: "hour" | "day") {
  return b === "day" ? 86_400_000 : 3_600_000;
}

/** Round ticks: about four steps of 1, 2, 2.5 or 5 times a power of ten, from zero. */
export function niceScale(max: number, integer = false): { max: number; step: number } {
  if (!max || max <= 0) return integer ? { max: 4, step: 1 } : { max: 1, step: 0.25 };
  if (integer && max <= 4) return { max: 4, step: 1 };
  const raw = max / 4;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw)!;
  const top = Math.ceil((max * 1.02) / step) * step;
  return { max: top, step };
}

function withAlpha(color: string, a: number): string {
  if (color.startsWith("#") && color.length === 7) {
    const n = parseInt(color.slice(1), 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
  }
  return color;
}

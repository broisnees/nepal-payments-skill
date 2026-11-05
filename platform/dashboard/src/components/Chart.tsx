import { lazy, Suspense } from "react";
import type { TimeChartProps } from "./TimeChart.tsx";

// uPlot loads in its own chunk, so the shell and the numbers paint before the charts do.
const TimeChart = lazy(() => import("./TimeChart.tsx"));

export function Chart(props: TimeChartProps) {
  return (
    <Suspense fallback={<div className="chart" style={{ height: props.height ?? 220 }} />}>
      <TimeChart {...props} />
    </Suspense>
  );
}

export type { ChartSeries } from "./TimeChart.tsx";

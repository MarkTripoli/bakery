import type { CSSProperties, HTMLAttributes } from "react";
import type { SemanticNativeProps } from "../foundations/semantic-native-props.ts";
import "../chart.css";

export type TimeSeriesChartPoint = Readonly<{
  label: string;
  value: number | null;
}>;

export type TimeSeriesChartGap = Readonly<{
  start: number;
  end: number;
  label: string;
}>;

export type TimeSeriesChartProps =
  & Omit<SemanticNativeProps<HTMLAttributes<HTMLElement>>, "children">
  & {
    label: string;
    points: readonly TimeSeriesChartPoint[];
    gaps: readonly TimeSeriesChartGap[];
    formatValue: (value: number) => string;
    height?: number;
  };

const TOP = 6;
const BOTTOM = 94;

function runsOf(points: readonly TimeSeriesChartPoint[]) {
  const runs: { index: number; value: number }[][] = [];
  let run: { index: number; value: number }[] = [];
  points.forEach((point, index) => {
    if (point.value === null) {
      if (run.length > 0) runs.push(run);
      run = [];
    } else run.push({ index, value: point.value });
  });
  if (run.length > 0) runs.push(run);
  return runs;
}

export function TimeSeriesChart(
  { label, points, gaps, formatValue, height, ...props }: TimeSeriesChartProps,
) {
  const runs = runsOf(points);
  const largest = Math.max(
    0,
    ...points.map((point) => point.value ?? 0),
  );
  const top = largest === 0 ? 1 : largest;
  const width = 100 / Math.max(points.length, 1);
  const x = (index: number) => (index + 0.5) * width;
  const y = (value: number) => BOTTOM - (value / top) * (BOTTOM - TOP);
  const style = height === undefined
    ? undefined
    : ({ "--chart-height": `${height}px` } as CSSProperties);
  return (
    <figure
      {...props}
      className="ui-time-series-chart"
      data-state={runs.length > 0 ? "ready" : "empty"}
      data-ui-component="timeSeriesChart"
      style={style}
    >
      <div className="ui-time-series-chart__plot">
        <span className="ui-time-series-chart__axis" data-edge="top">
          {formatValue(top)}
        </span>
        <span className="ui-time-series-chart__axis" data-edge="bottom">
          {formatValue(0)}
        </span>
        <svg
          aria-label={label}
          className="ui-time-series-chart__svg"
          focusable="false"
          preserveAspectRatio="none"
          role="img"
          viewBox="0 0 100 100"
        >
          {gaps.map((gap) => (
            <rect
              className="ui-time-series-chart__gap"
              height={100}
              key={`${gap.start}-${gap.end}`}
              width={(gap.end - gap.start + 1) * width}
              x={gap.start * width}
              y={0}
            >
              <title>{gap.label}</title>
            </rect>
          ))}
          <line
            className="ui-time-series-chart__baseline"
            x1={0}
            x2={100}
            y1={BOTTOM}
            y2={BOTTOM}
          />
          {runs.map((run) => (
            <polyline
              className="ui-time-series-chart__line"
              key={run[0].index}
              points={(run.length === 1 ? [run[0], run[0]] : run)
                .map((item) => `${x(item.index)},${y(item.value)}`)
                .join(" ")}
            />
          ))}
        </svg>
      </div>
      <div className="ui-time-series-chart__ends">
        <span>{points.at(0)?.label}</span>
        <span>{points.length > 1 ? points.at(-1)?.label : null}</span>
      </div>
    </figure>
  );
}

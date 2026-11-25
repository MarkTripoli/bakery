import type { HTMLAttributes, ReactNode } from "react";
import { useId } from "react";
import type { SemanticNativeProps } from "../foundations/semantic-native-props.ts";
import "../data.css";

export type LineChartPoint = Readonly<{ at: number; value: number }>;

export type LineChartGap = Readonly<{
  id: string;
  from: number;
  to: number;
  label: string;
  description: string;
}>;

export type LineChartProps =
  & SemanticNativeProps<Omit<HTMLAttributes<HTMLElement>, "title">>
  & {
    label: string;
    width: number;
    domain: readonly [number, number];
    pointCount: number;
    segments: readonly (readonly LineChartPoint[])[];
    gaps: readonly LineChartGap[];
    maximum: number;
    maximumLabel: string;
    startLabel: string;
    endLabel: string;
    describe: (hiddenGapLabels: readonly string[]) => ReactNode;
  };

const HEIGHT = 200;
const PAD = { top: 18, right: 12, bottom: 12, left: 44 };
const LABEL_WIDTH = 118;

export function lineChartBands(
  gaps: readonly LineChartGap[],
  domain: readonly [number, number],
  width: number,
  pointCount: number,
) {
  const plotWidth = width - PAD.left - PAD.right;
  const across = (time: number) =>
    PAD.left +
    ((time - domain[0]) / Math.max(1, domain[1] - domain[0])) * plotWidth;
  const slot = plotWidth / Math.max(1, pointCount - 1);
  return gaps.map((gap) => {
    const left = Math.max(PAD.left, across(gap.from) - slot / 2);
    const right = Math.min(width - PAD.right, across(gap.to) + slot / 2);
    const bandWidth = Math.max(3, right - left);
    return {
      gap,
      left,
      width: bandWidth,
      labelVisible: bandWidth >= LABEL_WIDTH,
    };
  });
}

export function LineChart(
  {
    label,
    width,
    domain,
    pointCount,
    segments,
    gaps,
    maximum,
    maximumLabel,
    startLabel,
    endLabel,
    describe,
    ...props
  }: LineChartProps,
) {
  const descriptionId = useId();
  const plotWidth = width - PAD.left - PAD.right;
  const plotHeight = HEIGHT - PAD.top - PAD.bottom;
  const across = (time: number) =>
    PAD.left +
    ((time - domain[0]) / Math.max(1, domain[1] - domain[0])) * plotWidth;
  const up = (value: number) =>
    PAD.top + plotHeight - (value / maximum) * plotHeight;
  const bands = lineChartBands(gaps, domain, width, pointCount);
  const hidden = bands.flatMap((band) =>
    band.labelVisible ? [] : [band.gap.description]
  );
  return (
    <figure
      className="ui-line-chart"
      {...props}
      data-state="default"
      data-ui-component="lineChart"
      data-variant="default"
    >
      <svg
        aria-describedby={descriptionId}
        aria-label={label}
        className="ui-line-chart__plot"
        height={HEIGHT}
        preserveAspectRatio="none"
        role="img"
        viewBox={`0 0 ${width} ${HEIGHT}`}
        width="100%"
      >
        {bands.map((band) => (
          <g key={band.gap.id}>
            <rect
              className="ui-line-chart__band"
              data-gap-band={band.gap.id}
              height={plotHeight}
              width={band.width}
              x={band.left}
              y={PAD.top}
            />
            {band.labelVisible
              ? (
                <text
                  className="ui-line-chart__band-label"
                  textAnchor="middle"
                  x={band.left + band.width / 2}
                  y={PAD.top + 16}
                >
                  {band.gap.label}
                </text>
              )
              : null}
          </g>
        ))}
        {segments.map((segment) =>
          segment.length === 1
            ? (
              <circle
                className="ui-line-chart__point"
                cx={across(segment[0]!.at)}
                cy={up(segment[0]!.value)}
                data-chart-point={segment[0]!.at}
                key={segment[0]!.at}
                r={3}
              />
            )
            : (
              <path
                className="ui-line-chart__line"
                d={segment
                  .map((point, index) =>
                    `${index === 0 ? "M" : "L"}${across(point.at)} ${
                      up(point.value)
                    }`
                  )
                  .join(" ")}
                data-chart-line={segment[0]!.at}
                key={segment[0]!.at}
              />
            )
        )}
        <text
          className="ui-line-chart__tick"
          data-chart-tick="max"
          textAnchor="end"
          x={PAD.left - 8}
          y={up(maximum) + 4}
        >
          {maximumLabel}
        </text>
      </svg>
      <div className="ui-line-chart__ends">
        <span className="ui-line-chart__end">{startLabel}</span>
        <span
          className="ui-line-chart__end"
          data-chart-tick="last"
          data-placement="end"
        >
          {endLabel}
        </span>
      </div>
      <figcaption className="ui-line-chart__description" id={descriptionId}>
        {describe(hidden)}
      </figcaption>
    </figure>
  );
}

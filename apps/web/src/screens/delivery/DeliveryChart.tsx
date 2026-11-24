import { type ReactNode, useId, useState } from "react";
import * as UI from "@bakery/ui";
import { useI18n } from "../../i18n/I18nProvider.tsx";
import {
  chartGaps,
  chartMaximum,
  type ChartPoint,
  chartSegments,
} from "./delivery-display.ts";

const WIDTH = 640;
const HEIGHT = 180;
const PAD = { top: 16, right: 16, bottom: 28, left: 56 };
const TICK_STYLE = { fontSize: 12, letterSpacing: 0, fontFamily: "inherit" };

export function DeliveryChart(
  {
    points,
    label,
    unitLabel,
    table,
    showMenu,
  }: {
    readonly points: readonly ChartPoint[];
    readonly label: string;
    readonly unitLabel: string;
    readonly table: ReactNode;
    readonly showMenu: ReactNode;
  },
) {
  const { translate, locale, timeZone } = useI18n();
  const [asTable, setAsTable] = useState(false);
  const descriptionId = useId();
  const segments = chartSegments(points);
  const gaps = chartGaps(points);
  const maximum = Math.max(1, chartMaximum(points));
  const times = points.map((point) => Date.parse(point.at));
  const first = times.length === 0 ? 0 : Math.min(...times);
  const last = times.length === 0 ? 1 : Math.max(...times);
  const plotWidth = WIDTH - PAD.left - PAD.right;
  const plotHeight = HEIGHT - PAD.bottom - PAD.top;
  const across = (time: number) =>
    PAD.left + ((time - first) / Math.max(1, last - first)) * plotWidth;
  const up = (value: number) =>
    PAD.top + plotHeight - (value / maximum) * plotHeight;
  const slot = plotWidth / Math.max(1, times.length - 1);
  const day = new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeZone,
  });
  const bands = gaps.map((gap) => {
    const from = across(Date.parse(gap.from));
    const to = across(Date.parse(gap.to));
    const left = Math.max(PAD.left, from - slot / 2);
    const right = Math.min(WIDTH - PAD.right, to + slot / 2);
    return {
      gap,
      left,
      width: Math.max(3, right - left),
      label: gap.from === gap.to
        ? translate("delivery.chart.gapDay", {
          date: day.format(new Date(gap.from)),
        })
        : translate("delivery.chart.gap", {
          from: day.format(new Date(gap.from)),
          to: day.format(new Date(gap.to)),
        }),
    };
  });
  return (
    <UI.SettingsSection
      data-section="delivery-over-time"
      title={translate("delivery.chart.heading")}
      variant="stack"
    >
      <UI.Inline gap="compact" variant="between">
        {showMenu}
        <UI.Button
          aria-pressed={asTable}
          onClick={() => setAsTable(!asTable)}
          variant="outline"
        >
          {translate(
            asTable ? "delivery.chart.asChart" : "delivery.chart.asTable",
          )}
        </UI.Button>
      </UI.Inline>
      {asTable ? table : (
        <>
          <svg
            aria-describedby={descriptionId}
            aria-label={label}
            data-testid="delivery-chart"
            role="img"
            style={{ display: "block", height: "auto", width: "100%" }}
            viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          >
            {bands.map((band) => (
              <g key={`${band.gap.from}-${band.gap.to}`}>
                <rect
                  data-gap-band={band.gap.from}
                  fill="currentColor"
                  fillOpacity={0.12}
                  height={HEIGHT - PAD.bottom - PAD.top}
                  width={band.width}
                  x={band.left}
                  y={PAD.top}
                />
                {band.width < 96 ? null : (
                  <text
                    fill="currentColor"
                    style={TICK_STYLE}
                    textAnchor="middle"
                    x={band.left + band.width / 2}
                    y={PAD.top + 14}
                  >
                    {band.label}
                  </text>
                )}
              </g>
            ))}
            {segments.map((segment) => (
              <path
                d={segment
                  .map((point, index) =>
                    `${index === 0 ? "M" : "L"}${
                      across(Date.parse(point.at))
                    } ${up(point.value)}`
                  )
                  .join(" ")}
                fill="none"
                key={segment[0]!.at}
                stroke="currentColor"
                strokeWidth={2}
              />
            ))}
            <text
              data-chart-tick="max"
              fill="currentColor"
              textAnchor="end"
              x={PAD.left - 8}
              y={up(maximum) + 4}
              style={TICK_STYLE}
            >
              {maximum}
            </text>
            <text
              fill="currentColor"
              x={PAD.left}
              y={HEIGHT - 8}
              style={TICK_STYLE}
            >
              {points.length === 0 ? "" : day.format(new Date(points[0]!.at))}
            </text>
            <text
              data-chart-tick="last"
              fill="currentColor"
              textAnchor="end"
              x={WIDTH - PAD.right}
              y={HEIGHT - 8}
              style={TICK_STYLE}
            >
              {points.length === 0
                ? ""
                : day.format(new Date(points.at(-1)!.at))}
            </text>
          </svg>
          <UI.Text id={descriptionId} variant="muted">
            {gaps.length === 0
              ? translate("delivery.chart.noGap", { unit: unitLabel })
              : translate("delivery.chart.gapCount", {
                count: gaps.reduce((sum, gap) => sum + gap.points, 0),
                gaps: bands.map((band) => band.label).join("; "),
              })}
          </UI.Text>
        </>
      )}
    </UI.SettingsSection>
  );
}

import { type ReactNode, useId, useState } from "react";
import * as UI from "@bakery/ui";
import { useShellViewport } from "../../app/responsive.ts";
import { useI18n } from "../../i18n/I18nProvider.tsx";
import {
  chartGaps,
  chartMaximum,
  type ChartPoint,
  chartSegments,
} from "./delivery-display.ts";

const HEIGHT = 200;
const PAD = { top: 18, right: 12, bottom: 12, left: 44 };
const LABEL_WIDTH = 118;

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
  const phone = useShellViewport() === "phone";
  const [asTable, setAsTable] = useState(false);
  const descriptionId = useId();
  const width = phone ? 360 : 900;
  const segments = chartSegments(points);
  const gaps = chartGaps(points);
  const measured = points.filter((point) => point.value !== null).length;
  const maximum = Math.max(1, chartMaximum(points));
  const times = points.map((point) => Date.parse(point.at));
  const first = times.length === 0 ? 0 : Math.min(...times);
  const last = times.length === 0 ? 1 : Math.max(...times);
  const plotWidth = width - PAD.left - PAD.right;
  const plotHeight = HEIGHT - PAD.top - PAD.bottom;
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
    const right = Math.min(width - PAD.right, to + slot / 2);
    const bandWidth = Math.max(3, right - left);
    return {
      left,
      width: bandWidth,
      labelVisible: bandWidth >= LABEL_WIDTH,
      key: `${gap.from}-${gap.to}`,
      label: gap.from === gap.to
        ? translate("delivery.chart.bandDay", {
          date: day.format(new Date(gap.from)),
        })
        : translate("delivery.chart.band", {
          from: day.format(new Date(gap.from)),
          to: day.format(new Date(gap.to)),
        }),
      description: gap.from === gap.to
        ? translate("delivery.chart.gapDay", {
          date: day.format(new Date(gap.from)),
        })
        : translate("delivery.chart.gap", {
          from: day.format(new Date(gap.from)),
          to: day.format(new Date(gap.to)),
        }),
      gap,
    };
  });
  const gapCount = gaps.reduce((sum, gap) => sum + gap.points, 0);
  const hiddenGapLabels = bands.flatMap((band) =>
    band.labelVisible ? [] : [band.description]
  );
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
      {asTable
        ? table
        : measured === 0
        ? (
          <UI.Text data-result="chart-empty" variant="muted">
            {translate("delivery.chart.noDataPeriod")}
          </UI.Text>
        )
        : (
          <>
            <svg
              aria-describedby={descriptionId}
              aria-label={label}
              data-testid="delivery-chart"
              height={HEIGHT}
              preserveAspectRatio="none"
              role="img"
              viewBox={`0 0 ${width} ${HEIGHT}`}
              width="100%"
            >
              {bands.map((band) => (
                <g key={band.key}>
                  <rect
                    data-gap-band={band.gap.from}
                    fill="currentColor"
                    fillOpacity={0.12}
                    height={plotHeight}
                    width={band.width}
                    x={band.left}
                    y={PAD.top}
                  />
                  {!band.labelVisible ? null : (
                    <text
                      fill="currentColor"
                      fontSize={11}
                      letterSpacing={0}
                      textAnchor="middle"
                      x={band.left + band.width / 2}
                      y={PAD.top + 16}
                    >
                      {band.label}
                    </text>
                  )}
                </g>
              ))}
              {segments.map((segment) =>
                segment.length === 1
                  ? (
                    <circle
                      cx={across(Date.parse(segment[0]!.at))}
                      cy={up(segment[0]!.value)}
                      data-chart-point={segment[0]!.at}
                      fill="currentColor"
                      key={segment[0]!.at}
                      r={3}
                    />
                  )
                  : (
                    <path
                      d={segment
                        .map((point, index) =>
                          `${index === 0 ? "M" : "L"}${
                            across(Date.parse(point.at))
                          } ${up(point.value)}`
                        )
                        .join(" ")}
                      data-chart-line={segment[0]!.at}
                      fill="none"
                      key={segment[0]!.at}
                      stroke="currentColor"
                      strokeWidth={2}
                    />
                  )
              )}
              <text
                data-chart-tick="max"
                fill="currentColor"
                fontSize={12}
                letterSpacing={0}
                textAnchor="end"
                x={PAD.left - 8}
                y={up(maximum) + 4}
              >
                {maximum}
              </text>
            </svg>
            <UI.Inline gap="standard">
              <UI.Text variant="caption">
                {day.format(new Date(points[0]!.at))}
              </UI.Text>
              <UI.Text
                data-placement="end"
                data-chart-tick="last"
                variant="caption"
              >
                {day.format(new Date(points.at(-1)!.at))}
              </UI.Text>
            </UI.Inline>
            <UI.Text id={descriptionId} variant="muted">
              {gaps.length === 0
                ? translate("delivery.chart.noGap", { unit: unitLabel })
                : hiddenGapLabels.length === 0
                ? translate("delivery.chart.gapCountLabeled", {
                  count: gapCount,
                })
                : translate("delivery.chart.gapCount", {
                  count: gapCount,
                  gaps: hiddenGapLabels.join("; "),
                })}
            </UI.Text>
          </>
        )}
    </UI.SettingsSection>
  );
}

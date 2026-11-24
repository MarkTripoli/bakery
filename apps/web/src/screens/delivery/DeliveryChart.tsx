import { type ReactNode, useId, useState } from "react";
import { Group } from "@visx/group";
import { scaleLinear, scalePoint } from "@visx/scale";
import { LinePath } from "@visx/shape";
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
const PAD = { top: 12, right: 12, bottom: 28, left: 40 };

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
  const x = scalePoint<string>({
    domain: points.map((point) => point.at),
    range: [PAD.left, WIDTH - PAD.right],
    padding: 0,
  });
  const y = scaleLinear({
    domain: [0, maximum],
    range: [HEIGHT - PAD.bottom, PAD.top],
    nice: true,
  });
  const day = new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeZone,
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
            className="ui-delivery-chart"
            data-testid="delivery-chart"
            height={HEIGHT}
            preserveAspectRatio="none"
            role="img"
            style={{ display: "block", width: "100%" }}
            viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          >
            {gaps.map((gap) => {
              const left = x(gap.from) ?? PAD.left;
              const right = x(gap.to) ?? left;
              return (
                <rect
                  className="ui-delivery-chart__gap"
                  fill="currentColor"
                  fillOpacity={0.08}
                  height={HEIGHT - PAD.bottom - PAD.top}
                  key={`${gap.from}-${gap.to}`}
                  width={Math.max(2, right - left)}
                  x={left}
                  y={PAD.top}
                />
              );
            })}
            <Group>
              {segments.map((segment) => (
                <LinePath
                  data={[...segment]}
                  key={segment[0]!.at}
                  stroke="currentColor"
                  strokeWidth={2}
                  x={(point) => x(point.at) ?? PAD.left}
                  y={(point) => y(point.value)}
                />
              ))}
            </Group>
            <text
              className="ui-delivery-chart__axis"
              fill="currentColor"
              fontSize={12}
              x={PAD.left - 6}
              y={y(maximum)}
              textAnchor="end"
            >
              {maximum}
            </text>
            <text
              className="ui-delivery-chart__axis"
              fill="currentColor"
              fontSize={12}
              x={PAD.left}
              y={HEIGHT - 8}
            >
              {points.length === 0 ? "" : day.format(new Date(points[0]!.at))}
            </text>
            <text
              className="ui-delivery-chart__axis"
              fill="currentColor"
              fontSize={12}
              textAnchor="end"
              x={WIDTH - PAD.right}
              y={HEIGHT - 8}
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
                gaps: gaps
                  .map((gap) =>
                    gap.from === gap.to
                      ? translate("delivery.chart.gapDay", {
                        date: day.format(new Date(gap.from)),
                      })
                      : translate("delivery.chart.gap", {
                        from: day.format(new Date(gap.from)),
                        to: day.format(new Date(gap.to)),
                      })
                  )
                  .join("; "),
              })}
          </UI.Text>
        </>
      )}
    </UI.SettingsSection>
  );
}

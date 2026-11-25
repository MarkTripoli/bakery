import { type ReactNode, useState } from "react";
import * as UI from "@bakery/ui";
import { useShellViewport } from "../../app/responsive.ts";
import { useI18n } from "../../i18n/I18nProvider.tsx";
import {
  chartGaps,
  chartMaximum,
  chartMissingDays,
  type ChartPoint,
  chartSegments,
  durationWords,
} from "./delivery-display.ts";

export function DeliveryChart(
  {
    points,
    hours,
    resolution,
    label,
    showMenu,
    table,
    status,
    to,
    onRetry,
  }: {
    readonly points: readonly ChartPoint[];
    readonly hours: boolean;
    readonly label: string;
    readonly resolution: "day" | "week";
    readonly table: ReactNode;
    readonly showMenu: ReactNode;
    readonly status: "loading" | "error" | "ready";
    readonly to: string;
    readonly onRetry: () => void;
  },
) {
  const { translate, locale } = useI18n();
  const phone = useShellViewport() === "phone";
  const [asTable, setAsTable] = useState(false);
  const width = phone ? 360 : 900;
  const segments = chartSegments(points).map((segment) =>
    segment.map((point) => ({ at: Date.parse(point.at), value: point.value }))
  );
  const gaps = chartGaps(points);
  const measured = points.filter((point) => point.value !== null).length;
  const maximum = Math.max(1, chartMaximum(points));
  const maximumWords = hours ? durationWords(maximum) : null;
  const times = points.map((point) => Date.parse(point.at));
  const domain: readonly [number, number] = [
    times.length === 0 ? 0 : Math.min(...times),
    times.length === 0 ? 1 : Math.max(...times),
  ];
  const day = new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeZone: "UTC",
  });
  const gapMarks = gaps.map((gap) => ({
    id: `${gap.from}-${gap.to}`,
    from: Date.parse(gap.from),
    to: Date.parse(gap.to),
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
  }));
  const gapCount = chartMissingDays(points, to);
  return (
    <UI.SettingsSection
      data-section="delivery-over-time"
      title={translate("delivery.chart.heading")}
      variant="stack"
    >
      <UI.Inline gap="compact" variant="between">
        <UI.Inline gap="compact">{showMenu}</UI.Inline>
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
      {status === "loading"
        ? <UI.Skeleton aria-label={translate("delivery.loading")} />
        : status === "error"
        ? (
          <UI.ErrorState
            action={
              <UI.Button onClick={onRetry}>
                {translate("delivery.chart.retry")}
              </UI.Button>
            }
            title={translate("delivery.chart.error")}
            variant="region"
          />
        )
        : asTable
        ? table
        : measured === 0
        ? (
          <UI.Text data-result="chart-empty" variant="muted">
            {translate("delivery.chart.noDataPeriod")}
          </UI.Text>
        )
        : (
          <UI.LineChart
            data-testid="delivery-chart"
            describe={(hiddenGapLabels) =>
              gaps.length === 0
                ? translate(
                  resolution === "week"
                    ? "delivery.chart.noGapWeek"
                    : "delivery.chart.noGap",
                  { series: label },
                )
                : hiddenGapLabels.length === 0
                ? translate("delivery.chart.gapCountLabeled", {
                  count: gapCount,
                })
                : translate("delivery.chart.gapCount", {
                  count: gapCount,
                  gaps: hiddenGapLabels.join("; "),
                })}
            domain={domain}
            endLabel={day.format(new Date(points.at(-1)!.at))}
            gaps={gapMarks}
            label={label}
            maximum={maximum}
            maximumLabel={maximumWords === null
              ? String(maximum)
              : translate(maximumWords.key, maximumWords.params)}
            pointCount={points.length}
            segments={segments}
            startLabel={day.format(new Date(points[0]!.at))}
            width={width}
          />
        )}
    </UI.SettingsSection>
  );
}

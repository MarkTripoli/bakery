import * as UI from "@bakery/ui";
import { formatDate, formatNumber } from "@bakery/i18n";
import { useShellViewport } from "../../app/responsive.ts";
import { useI18n } from "../../i18n/I18nProvider.tsx";
import {
  type ChartPoint,
  type ChartStep,
  type Gap,
  gapDays,
  hasLine,
  OVER_TIME_SHOWS,
  type OverTimeShow,
} from "./delivery-series.ts";

export type OverTimeView = Readonly<{
  status: "loading" | "error" | "ready";
  show: OverTimeShow;
  step: ChartStep;
  points: readonly ChartPoint[];
  gaps: readonly Gap[];
  asTable: boolean;
}>;

export type OverTimeHandlers = Readonly<{
  onShow: (show: OverTimeShow) => void;
  onAsTable: (on: boolean) => void;
  onRetry: () => void;
}>;

const SHOW_KEYS = {
  merged: "delivery.overTime.show.merged",
  opened: "delivery.overTime.show.opened",
  open: "delivery.overTime.show.open",
  closed: "delivery.overTime.show.closed",
  lines: "delivery.overTime.show.lines",
  taskTime: "delivery.overTime.show.taskTime",
} as const satisfies Record<OverTimeShow, string>;

const DAY_MS = 86_400_000;

export function OverTimeSection(
  { view, onShow, onAsTable, onRetry }: OverTimeHandlers & {
    readonly view: OverTimeView;
  },
) {
  const { translate, locale } = useI18n();
  const phone = useShellViewport() === "phone";
  const day = (date: Date) =>
    formatDate(date, locale, { dateStyle: "medium", timeZone: "UTC" });
  const lastDay = (date: Date) => new Date(date.getTime() - DAY_MS);
  const what = translate(SHOW_KEYS[view.show]);
  const value = (amount: number) =>
    view.show === "taskTime"
      ? translate("delivery.overTime.hours", {
        value: formatNumber(amount, locale),
      })
      : formatNumber(amount, locale);
  const range = (from: Date, to: Date) =>
    translate("delivery.overTime.range", {
      from: day(from),
      to: day(lastDay(to)),
    });
  const pointLabel = (point: ChartPoint) =>
    view.step === "day" ? day(point.from) : range(point.from, point.to);
  const indexOf = (date: Date) =>
    view.points.findIndex((point) => point.from.getTime() === date.getTime());
  const bands = view.gaps.map((gap) => ({
    start: indexOf(gap.from),
    end: indexOf(gap.from) + gap.buckets - 1,
    label: translate("delivery.overTime.gapBand", {
      from: day(gap.from),
      to: day(lastDay(gap.to)),
    }),
  }));
  const showItems: UI.MenuItem[] = OVER_TIME_SHOWS.map((choice) => ({
    id: choice,
    label: translate(SHOW_KEYS[choice]),
    selected: choice === view.show,
  }));
  const showLabel = `${translate("delivery.overTime.showWord")}: ${what}`;
  const columns: UI.DataTableColumn<ChartPoint>[] = [
    {
      id: "date",
      header: translate("delivery.overTime.table.date"),
      cell: (point) => pointLabel(point),
    },
    {
      id: "value",
      header: what,
      align: "end",
      cell: (point) =>
        point.value === null
          ? translate("delivery.overTime.table.noData")
          : value(point.value),
    },
  ];
  const days = gapDays(view.gaps);
  return (
    <UI.Stack data-testid="delivery-over-time" gap="standard">
      <UI.Inline gap="standard">
        <UI.Heading level="subsection">
          {translate("delivery.overTime.title")}
        </UI.Heading>
        <UI.Popover
          align="end"
          floating={phone}
          label={translate("delivery.overTime.showWord")}
          trigger={
            <>
              {showLabel}
              <UI.IconGlyph name="chevron-down" size="small" />
            </>
          }
          triggerAppearance="toolbar"
          triggerLabel={showLabel}
          variant="interactive"
        >
          <UI.Menu
            aria-label={translate("delivery.overTime.showWord")}
            items={showItems}
            onSelect={(id) => {
              const next = OVER_TIME_SHOWS.find((choice) => choice === id);
              if (next !== undefined) onShow(next);
            }}
            variant="selection"
          />
        </UI.Popover>
        {view.status === "ready"
          ? (
            <UI.Button onClick={() => onAsTable(!view.asTable)} variant="quiet">
              {translate(
                view.asTable
                  ? "delivery.overTime.asChart"
                  : "delivery.overTime.asTable",
              )}
            </UI.Button>
          )
          : null}
      </UI.Inline>
      {view.status === "loading"
        ? <UI.Skeleton aria-label={translate("delivery.overTime.loading")} />
        : view.status === "error"
        ? (
          <UI.InlineNotice
            action={
              <UI.Button onClick={onRetry} variant="quiet">
                {translate("delivery.retry")}
              </UI.Button>
            }
            tone="error"
          >
            {translate("delivery.overTime.error")}
          </UI.InlineNotice>
        )
        : view.asTable
        ? (
          <UI.DataTable<ChartPoint>
            caption={translate("delivery.overTime.chartLabel", { what })}
            captionHidden
            columns={columns}
            getRowKey={(point) => point.from.toISOString()}
            rows={[...view.points]}
          />
        )
        : (
          <UI.Stack gap="compact">
            {hasLine(view.points)
              ? (
                <UI.TimeSeriesChart
                  formatValue={value}
                  gaps={bands}
                  height={phone ? 200 : 240}
                  label={translate("delivery.overTime.chartLabel", { what })}
                  points={view.points.map((point) => ({
                    label: pointLabel(point),
                    value: point.value,
                  }))}
                />
              )
              : null}
            {hasLine(view.points)
              ? days > 0
                ? (
                  <UI.Text variant="muted">
                    {translate("delivery.overTime.gapNote", { count: days })}
                  </UI.Text>
                )
                : null
              : (
                <UI.Text variant="muted">
                  {translate("delivery.overTime.none")}
                </UI.Text>
              )}
            {view.step === "week"
              ? (
                <UI.Text variant="muted">
                  {translate("delivery.overTime.week")}
                </UI.Text>
              )
              : null}
          </UI.Stack>
        )}
    </UI.Stack>
  );
}

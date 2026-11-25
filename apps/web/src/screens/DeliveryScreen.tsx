import * as UI from "@bakery/ui";
import { formatDate, formatNumber } from "@bakery/i18n";
import { DeliveryChart } from "./delivery/DeliveryChart.tsx";
import { useShellViewport } from "../app/responsive.ts";
import { useI18n } from "../i18n/I18nProvider.tsx";
import {
  type ChartPoint,
  type DeliveryShow,
  durationWords,
  type Figure,
  type Freshness,
  isDeliveryShow,
  type LeadTime,
  type RecordRow,
  ruleKey,
  type TimePartId,
} from "./delivery/delivery-display.ts";
import {
  DELIVERY_PERIODS,
  type DeliveryPeriod,
  isDeliveryPeriod,
} from "./delivery/delivery-window.ts";

/**
 * The Delivery page: what was delivered and how long it took.
 *
 * The rule it is built around is the server's: a value nobody can know is
 * never a zero. A figure that was never read says Unknown, a record with a
 * hole in it stays in the list with the reason in the cell, and a source that
 * is disconnected says its figures are unknown, not that nothing happened.
 */

export type DeliveryRepository = {
  readonly id: string;
  readonly name: string;
};

export type DeliveryRecords = {
  readonly status: "loading" | "error" | "ready";
  readonly rows: readonly RecordRow[];
  readonly hasMore: boolean;
  readonly loadingMore: boolean;
  /** The measurement revision the rows were counted under, for the rule line. */
  readonly revision: string | null;
};

export type DeliveryScreenProps = {
  readonly state:
    | "loading"
    | "error"
    | "ready"
    | "noRepository"
    | "emptyPeriod"
    | "notFound";
  readonly figures: Readonly<Record<DeliveryShow, Figure>>;
  readonly freshness: Freshness | null;
  /** Records the reader may not open; the line shows only above zero. */
  readonly hiddenCount: number;
  readonly repositories: readonly DeliveryRepository[];
  readonly repositoryId: string | null;
  readonly period: DeliveryPeriod;
  readonly periodTooLong: boolean;
  readonly rangeReversed: boolean;
  readonly custom: { readonly from: string; readonly to: string };
  /** The window the figures were asked for, for the empty-period sentence. */
  readonly window: { readonly from: Date; readonly to: Date };
  readonly show: DeliveryShow | null;
  readonly missingOnly: boolean;
  readonly records: DeliveryRecords;
  /** How long tasks took and where the time went; null when no task was delivered. */
  readonly leadTime: LeadTime | null;
  readonly chart: {
    readonly status: "loading" | "error" | "ready";
    readonly points: readonly ChartPoint[];
    readonly to: string;
  };
  /** Admins are sent to reconnect; everyone else is told who can. */
  readonly canReconnect: boolean;
  readonly reconnectHref: string;
  readonly connectHref: string;
  readonly taskHref: (taskId: string) => string;
  readonly onRepositoryChange: (id: string | null) => void;
  readonly onPeriodChange: (period: DeliveryPeriod) => void;
  readonly onCustomChange: (range: { from: string; to: string }) => void;
  readonly onShow: (show: DeliveryShow | null) => void;
  readonly onMissingOnly: (on: boolean) => void;
  readonly onLoadMore: () => void;
  readonly onRetryRecords: () => void;
  readonly onRetryChart: () => void;
  readonly onRetry: () => void;
  readonly onRefresh: () => void;
  readonly onShowLast30Days: () => void;
  readonly onNavigate: (href: string) => void;
};

const PERIOD_KEYS = {
  last7: "delivery.period.last7",
  last30: "delivery.period.last30",
  thisMonth: "delivery.period.thisMonth",
  custom: "delivery.period.custom",
} as const satisfies Record<DeliveryPeriod, string>;

const FIGURES = [
  {
    show: "merged",
    label: "delivery.figure.merged.label",
    detail: "delivery.figure.merged.detail",
    help: "delivery.figure.merged.help",
  },
  {
    show: "tasks",
    label: "delivery.figure.tasks.label",
    detail: "delivery.figure.tasks.detail",
    help: "delivery.figure.tasks.help",
  },
  {
    show: "open",
    label: "delivery.figure.open.label",
    detail: "delivery.figure.open.detail",
    help: "delivery.figure.open.help",
  },
  {
    show: "closed",
    label: "delivery.figure.closed.label",
    detail: "delivery.figure.closed.detail",
    help: "delivery.figure.closed.help",
  },
] as const;

function showRecordsHeading() {
  const heading = document.getElementById("delivery-records-heading");
  if (heading === null) return;
  heading.scrollIntoView({ block: "start" });
  heading.focus({ preventScroll: true });
}

export function DeliveryScreen(props: DeliveryScreenProps) {
  const { translate } = useI18n();
  const { state } = props;
  const phone = useShellViewport() === "phone";

  if (state === "notFound") {
    return (
      <UI.EmptyState
        description={translate("delivery.notFound.body")}
        inset="page"
        layout="centered"
        title={translate("delivery.notFound.title")}
        variant="filtered"
      />
    );
  }

  return (
    <UI.Stack data-testid="delivery-page" gap="spacious">
      {phone
        ? (
          <UI.PageHeader
            actions={<Filters {...props} />}
            description={translate("delivery.description")}
            flush
            title={translate("delivery.title")}
            variant="list"
          />
        )
        : (
          // On a desktop the controls share the title's row.
          <UI.PageHeader
            actions={<Filters {...props} />}
            meta={translate("delivery.description")}
            title={translate("delivery.title")}
          />
        )}
      {props.rangeReversed
        ? (
          <UI.InlineNotice tone="warning">
            {translate("delivery.period.reversed")}
          </UI.InlineNotice>
        )
        : props.periodTooLong
        ? (
          <UI.InlineNotice tone="warning">
            {translate("delivery.period.tooLong")}
          </UI.InlineNotice>
        )
        : null}
      {state === "loading"
        ? (
          <UI.Stack gap="standard">
            <UI.Skeleton aria-label={translate("delivery.loading")} />
            <UI.Inline gap="standard" variant="quarters">
              {FIGURES.map((figure) => <UI.Skeleton key={figure.show} />)}
            </UI.Inline>
          </UI.Stack>
        )
        : state === "error"
        ? (
          <UI.ErrorState
            action={
              <UI.Button onClick={props.onRetry}>
                {translate("delivery.retry")}
              </UI.Button>
            }
            title={translate("delivery.error")}
          />
        )
        : state === "noRepository"
        ? (
          <UI.EmptyState
            action={
              <UI.Link
                href={props.connectHref}
                onClick={(event) => {
                  event.preventDefault();
                  props.onNavigate(props.connectHref);
                }}
                variant="button"
              >
                {translate("delivery.empty.none.action")}
              </UI.Link>
            }
            description={translate("delivery.empty.none.body")}
            title={translate("delivery.empty.none.title")}
          />
        )
        : <Ready {...props} />}
    </UI.Stack>
  );
}

/** The two filters, right of the title; both live in the address. */
function Filters(props: DeliveryScreenProps) {
  const { translate } = useI18n();
  const repository = props.repositories.find((r) =>
    r.id === props.repositoryId
  );
  const repositoryLabel = `${translate("delivery.repository")}: ${
    repository?.name ?? translate("delivery.repository.all")
  }`;
  const periodLabel = `${translate("delivery.period")}: ${
    translate(PERIOD_KEYS[props.period])
  }`;
  const repositoryItems: UI.MenuItem[] = [
    {
      id: "all",
      label: translate("delivery.repository.all"),
      selected: props.repositoryId === null,
    },
    ...props.repositories.map((r) => ({
      id: r.id,
      label: r.name,
      selected: r.id === props.repositoryId,
    })),
  ];
  const periodItems: UI.MenuItem[] = DELIVERY_PERIODS.map((choice) => ({
    id: choice,
    label: translate(PERIOD_KEYS[choice]),
    selected: choice === props.period,
  }));
  const picker = (
    label: string,
    word: string,
    items: UI.MenuItem[],
    onSelect: (id: string) => void,
  ) => (
    <UI.Popover
      align="end"
      label={word}
      trigger={
        <>
          {label}
          <UI.IconGlyph name="chevron-down" size="small" />
        </>
      }
      triggerAppearance="toolbar"
      triggerLabel={label}
      variant="interactive"
    >
      <UI.Menu
        aria-label={word}
        items={items}
        onSelect={onSelect}
        variant="selection"
      />
    </UI.Popover>
  );
  return (
    <UI.Stack gap="compact">
      <UI.Inline gap="compact">
        {picker(
          repositoryLabel,
          translate("delivery.repository"),
          repositoryItems,
          (id) => props.onRepositoryChange(id === "all" ? null : id),
        )}
        {picker(
          periodLabel,
          translate("delivery.period"),
          periodItems,
          (id) => {
            if (isDeliveryPeriod(id)) props.onPeriodChange(id);
          },
        )}
      </UI.Inline>
      {props.period === "custom"
        ? (
          <UI.Inline gap="compact">
            <UI.Field
              htmlFor="delivery-from"
              label={translate("delivery.period.from")}
            >
              <UI.TextInput
                autoComplete="off"
                id="delivery-from"
                name="from"
                onChange={(from) =>
                  props.onCustomChange({ ...props.custom, from })}
                type="date"
                value={props.custom.from}
              />
            </UI.Field>
            <UI.Field
              htmlFor="delivery-to"
              label={translate("delivery.period.to")}
            >
              <UI.TextInput
                autoComplete="off"
                id="delivery-to"
                name="to"
                onChange={(to) => props.onCustomChange({ ...props.custom, to })}
                type="date"
                value={props.custom.to}
              />
            </UI.Field>
          </UI.Inline>
        )
        : null}
    </UI.Stack>
  );
}

function Ready(props: DeliveryScreenProps) {
  const { translate, locale, timeZone } = useI18n();
  const number = (value: number) => formatNumber(value, locale);
  const figureText = (figure: Figure) =>
    figure.kind === "value"
      ? number(figure.value)
      : translate("delivery.figure.unknown");

  if (props.state === "emptyPeriod") {
    const day = (date: Date) =>
      formatDate(date, locale, { dateStyle: "medium", timeZone });
    return (
      <>
        <FreshnessNotice {...props} />
        <UI.EmptyState
          action={
            <UI.Button onClick={props.onShowLast30Days}>
              {translate("delivery.empty.period.action")}
            </UI.Button>
          }
          description={translate("delivery.empty.period.body", {
            from: day(props.window.from),
            to: day(props.window.to),
          })}
          title={translate("delivery.empty.period.title")}
        />
      </>
    );
  }

  return (
    <UI.Stack gap="spacious">
      <FreshnessNotice {...props} />
      <UI.Inline gap="standard" variant="quarters">
        {FIGURES.map((figure) => {
          const value = figureText(props.figures[figure.show]);
          const label = translate(figure.label);
          return (
            <UI.StatTile
              action={{
                label: translate("delivery.figure.show", { label, value }),
                onSelect: () => {
                  const next = props.show === figure.show ? null : figure.show;
                  props.onShow(next);
                  if (next !== null) showRecordsHeading();
                },
                selected: props.show === figure.show,
              }}
              detail={props.figures[figure.show].kind === "unknown"
                ? translate("delivery.figure.unknown.detail")
                : translate(figure.detail)}
              help={{ label, text: translate(figure.help) }}
              key={figure.show}
              label={label}
              value={value}
            />
          );
        })}
      </UI.Inline>
      {props.hiddenCount > 0
        ? (
          <UI.Text variant="muted">
            {translate("delivery.hidden", { count: props.hiddenCount })}
          </UI.Text>
        )
        : null}
      {props.leadTime === null ? null : <TimeWent lead={props.leadTime} />}
      <OverTime {...props} />
      <RecordsSection {...props} figureText={figureText} />
    </UI.Stack>
  );
}

function OverTime(props: DeliveryScreenProps) {
  const { translate, locale, timeZone } = useI18n();
  const shown: DeliveryShow = props.show ?? "merged";
  const figure = FIGURES.find((entry) => entry.show === shown)!;
  const series = props.chart;
  const day = new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeZone,
  });
  const numberFormat = new Intl.NumberFormat(locale);
  return (
    <DeliveryChart
      label={translate(figure.label)}
      onRetry={props.onRetryChart}
      points={series.points}
      to={series.to}
      status={series.status}
      showMenu={
        <UI.Combobox
          appearance="filter"
          id="delivery-chart-show"
          label={translate("delivery.chart.show")}
          onChange={(event) =>
            props.onShow(
              isDeliveryShow(event.target.value) ? event.target.value : null,
            )}
          options={FIGURES.map((entry) => ({
            label: translate(entry.label),
            value: entry.show,
          }))}
          value={shown}
        />
      }
      table={
        <UI.DataTable
          caption={translate(figure.label)}
          captionHidden
          columns={[
            {
              id: "day",
              header: translate("delivery.chart.column.day"),
              cell: (point: ChartPoint) => day.format(new Date(point.at)),
            },
            {
              id: "value",
              header: translate(figure.label),
              align: "end" as const,
              cell: (point: ChartPoint) =>
                point.value === null
                  ? translate("delivery.chart.noData")
                  : numberFormat.format(point.value),
            },
          ]}
          emptyMessage={translate("delivery.chart.noData")}
          getRowKey={(point) => point.at}
          rows={[...series.points]}
        />
      }
      unitLabel={translate(figure.detail)}
    />
  );
}

/** Fewer tasks than this are listed, not summarised: a typical time of three tasks says little. */
const MIN_TASKS_TO_SUMMARISE = 5;

const PART_TONES: Readonly<
  Record<TimePartId, "first" | "second" | "third" | "fourth" | "unknown">
> = {
  agentWorking: "first",
  queue: "second",
  review: "third",
  person: "fourth",
  blocked: "fourth",
  unaccounted: "unknown",
};

/**
 * How long a task took, and where the time went.
 *
 * The bar's parts add up to the total. Time no record covers is its own hatched
 * part, "Not accounted for", and Blocked is one line under the bar while Bakery
 * keeps no history of it: unknown, never a part of zero width.
 */
function TimeWent({ lead }: { readonly lead: LeadTime }) {
  const { translate } = useI18n();
  const words = (hours: number) => {
    const text = durationWords(hours);
    return translate(text.key, text.params);
  };
  const tooFew = lead.count < MIN_TASKS_TO_SUMMARISE;
  const sentence = lead.point === "merge"
    ? translate("delivery.time.sentence.merge")
    : lead.point === "run"
    ? translate("delivery.time.sentence.run")
    : translate("delivery.time.sentence.mixed", {
      runs: lead.runCount,
      count: lead.count,
    });
  const parts = lead.parts.map((part) => ({
    id: part.id,
    label: translate(`delivery.time.part.${part.id}` as never),
    value: part.hours,
    tone: PART_TONES[part.id],
    detail: words(part.hours),
  }));
  const hasUnaccounted = lead.parts.some((part) => part.id === "unaccounted");
  return (
    <UI.Stack gap="standard" data-testid="delivery-time">
      <UI.Inline gap="compact">
        <UI.Heading level="subsection" rank={2}>
          {translate("delivery.time.heading")}
        </UI.Heading>
        <UI.HelpTip label={translate("delivery.time.helpLabel")}>
          {translate("delivery.time.help")}
        </UI.HelpTip>
      </UI.Inline>
      {tooFew
        ? (
          <UI.Text>
            {translate("delivery.time.tooFew", { count: lead.count })}
          </UI.Text>
        )
        : (
          <UI.Inline gap="standard">
            {lead.median === null ? null : (
              <UI.Text>
                {translate("delivery.time.typical", {
                  time: words(lead.median),
                })}
              </UI.Text>
            )}
            {lead.p90 === null ? null : (
              <UI.Text>
                {translate("delivery.time.p90", { time: words(lead.p90) })}
              </UI.Text>
            )}
          </UI.Inline>
        )}
      <UI.Text variant="muted">{sentence}</UI.Text>
      {tooFew || parts.length === 0
        ? null
        : (
          <UI.Heading level="subsection" rank={3}>
            {translate("delivery.time.bar.heading")}
          </UI.Heading>
        )}
      {tooFew || parts.length === 0 ? null : (
        <UI.Text variant="muted">
          {translate("delivery.time.measure", { count: lead.count })}
          {lead.leftOut > 0
            ? ` ${translate("delivery.time.leftOut", { count: lead.leftOut })}`
            : ""}
        </UI.Text>
      )}
      {tooFew || parts.length === 0 ? null : (
        <UI.SegmentedBar
          label={translate("delivery.time.bar.label", {
            parts: parts.map((part) => `${part.label} ${part.detail}`).join(
              ", ",
            ),
          })}
          parts={parts}
        />
      )}
      {tooFew || !hasUnaccounted ? null : (
        <UI.Text variant="muted">
          <strong>{translate("delivery.time.unaccounted.name")}</strong>{" "}
          {translate("delivery.time.unaccounted.text")}
        </UI.Text>
      )}
      {tooFew || lead.blockedKnown ? null : (
        <UI.Text variant="muted">
          <strong>{translate("delivery.time.blockedUnknown.name")}</strong>{" "}
          {translate("delivery.time.blockedUnknown.text")}
        </UI.Text>
      )}
    </UI.Stack>
  );
}

/** The one line that says how far to trust the figures; always present. */
function FreshnessNotice(props: DeliveryScreenProps) {
  const { translate, locale, timeZone } = useI18n();
  const freshness = props.freshness;
  if (freshness === null) return null;
  const time = (iso: string | null) =>
    iso === null ? null : formatDate(new Date(iso), locale, {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone,
    });
  const name = (id: string) =>
    props.repositories.find((r) => r.id === id)?.name ?? id;

  if (freshness.kind === "disconnected") {
    const [first, ...others] = freshness.repositoryIds;
    const since = freshness.since === null ? null : formatDate(
      new Date(freshness.since),
      locale,
      { dateStyle: "medium", timeZone },
    );
    return (
      <UI.InlineNotice
        action={props.canReconnect
          ? (
            <UI.Link
              href={props.reconnectHref}
              onClick={(event) => {
                event.preventDefault();
                props.onNavigate(props.reconnectHref);
              }}
              variant="button"
            >
              {translate("delivery.fresh.disconnected.reconnect")}
            </UI.Link>
          )
          : (
            <UI.Text variant="muted">
              {translate("delivery.fresh.disconnected.askAdmin")}
            </UI.Text>
          )}
        tone="warning"
      >
        <UI.Stack gap="tight">
          <strong>
            {translate("delivery.fresh.disconnected.title", {
              repository: name(first ?? ""),
            })}
          </strong>
          <span>
            {since === null
              ? translate("delivery.fresh.disconnected.bodyNoDate")
              : translate("delivery.fresh.disconnected.body", { date: since })}
          </span>
          {others.length > 0
            ? (
              <span>
                {translate("delivery.fresh.disconnected.more", {
                  count: others.length,
                })}
              </span>
            )
            : null}
        </UI.Stack>
      </UI.InlineNotice>
    );
  }

  if (freshness.kind === "stale") {
    const when = time(freshness.lastRead);
    return (
      <UI.InlineNotice
        action={
          <UI.Button onClick={props.onRefresh} variant="outline">
            {translate("delivery.fresh.refresh")}
          </UI.Button>
        }
        tone="warning"
      >
        {when === null
          ? translate("delivery.fresh.staleUnknown")
          : translate("delivery.fresh.stale", { time: when })}
      </UI.InlineNotice>
    );
  }

  const when = time(freshness.asOf);
  if (freshness.kind === "complete") {
    return (
      <UI.InlineNotice tone="neutral">
        {when === null
          ? translate("delivery.fresh.asOfUnknown")
          : translate("delivery.fresh.complete", { time: when })}
      </UI.InlineNotice>
    );
  }
  return (
    <UI.InlineNotice
      action={
        <UI.Button
          onClick={() => {
            props.onShow(freshness.unmeasured > 0 ? "merged" : "tasks");
            props.onMissingOnly(true);
          }}
          variant="outline"
        >
          {translate("delivery.fresh.missing.action")}
        </UI.Button>
      }
      tone="information"
    >
      {[
        when === null
          ? translate("delivery.fresh.asOfUnknown")
          : translate("delivery.fresh.asOf", { time: when }),
        freshness.unmeasured > 0
          ? translate("delivery.fresh.lines", {
            unmeasured: formatNumber(freshness.unmeasured, locale),
            merged: freshness.merged,
          })
          : null,
        freshness.tasksMissing > 0
          ? translate("delivery.fresh.tasks", { tasks: freshness.tasksMissing })
          : null,
        translate("delivery.fresh.neverZero", {
          count: freshness.unmeasured + freshness.tasksMissing,
        }),
      ].filter((part) => part !== null).join(" ")}
    </UI.InlineNotice>
  );
}

/** The records behind a number; with no number chosen, the merged pull requests. */
function RecordsSection(
  props: DeliveryScreenProps & {
    readonly figureText: (figure: Figure) => string;
  },
) {
  const { translate, locale, timeZone } = useI18n();
  const phone = useShellViewport() === "phone";
  const shown: DeliveryShow = props.show ?? "merged";
  const version = props.records.revision?.split("@")[1] ?? null;
  const chosen = props.show !== null;
  const { records } = props;
  const missing = records.rows.filter((row) => row.missing !== null);
  const rows = props.missingOnly ? missing : records.rows;
  const figure = FIGURES.find((entry) => entry.show === shown)!;
  const figureValue = props.figures[shown];
  const dayAndTime = (iso: string | null) =>
    iso === null ? "\u2014" : formatDate(new Date(iso), locale, {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone,
    });
  const duration = (hours: number | null) => {
    if (hours === null) return "\u2014";
    const words = durationWords(hours);
    return translate(words.key, words.params);
  };
  const repositoryName = (id: string | null) =>
    props.repositories.find((r) => r.id === id)?.name ??
      translate("delivery.figure.unknown");
  const isTask = shown === "tasks";
  const heading = chosen && figureValue.kind === "value"
    ? translate(
      isTask
        ? "delivery.records.heading.tasks"
        : "delivery.records.heading.pullRequests",
      { count: figureValue.value, figure: translate(figure.label) },
    )
    : translate("delivery.records.heading");
  const reason = (row: RecordRow) =>
    row.missing === null ? null : translate(row.missing);

  const title = (row: RecordRow) => {
    const text = row.title ??
      (row.kind === "task"
        ? translate("delivery.records.untitledTask")
        : translate("delivery.records.untitled", {
          number: row.providerNumber ?? 0,
        }));
    const href = props.taskHref(row.taskId);
    return (
      <UI.Link
        href={href}
        onClick={(event) => {
          event.preventDefault();
          props.onNavigate(href);
        }}
      >
        {text}
      </UI.Link>
    );
  };
  const cellOrReason = (row: RecordRow, text: string | null) =>
    text !== null ? text : reason(row) ?? translate("delivery.figure.unknown");

  const columns: UI.DataTableColumn<RecordRow>[] = [
    {
      id: "title",
      header: translate("delivery.records.column.title"),
      cell: (row) => (
        <UI.Stack gap="none">
          {title(row)}
          {row.kind === "task" && row.missing !== null && row.value === null
            ? <UI.Text variant="muted">{reason(row)}</UI.Text>
            : null}
        </UI.Stack>
      ),
    },
    ...(isTask ? [] : [{
      id: "repository",
      header: translate("delivery.records.column.repository"),
      cell: (row: RecordRow) =>
        row.providerNumber === null
          ? repositoryName(row.repositoryId)
          : `${repositoryName(row.repositoryId)} #${row.providerNumber}`,
    }]),
    ...(isTask
      ? [
        {
          id: "requested",
          header: translate("delivery.records.column.requested"),
          cell: (row: RecordRow) => dayAndTime(row.requestedAt),
        },
        {
          id: "delivered",
          header: translate("delivery.records.column.delivered"),
          cell: (row: RecordRow) => (
            <UI.Stack gap="none">
              {dayAndTime(row.deliveredAt)}
              {row.deliveryPoint === null ? null : (
                <UI.Text variant="muted">
                  {translate(`delivery.point.${row.deliveryPoint}` as never)}
                </UI.Text>
              )}
            </UI.Stack>
          ),
        },
        {
          id: "total",
          header: translate("delivery.records.column.total"),
          align: "end" as const,
          cell: (row: RecordRow) => duration(row.value),
        },
        ...(["agentWorking", "queue", "review", "person"] as const).map((
          part,
        ) => ({
          id: part,
          header: translate(`delivery.time.part.${part}` as never),
          align: "end" as const,
          cell: (row: RecordRow) => duration(row.waitHours[part]),
        })),
        {
          id: "notAccounted",
          header: translate("delivery.records.column.notAccounted"),
          align: "end" as const,
          cell: (row: RecordRow) => duration(row.unaccountedHours),
        },
      ]
      : [
        {
          id: "opened",
          header: translate("delivery.records.column.opened"),
          cell: (row: RecordRow) => dayAndTime(row.openedAt),
        },
        ...(shown === "merged"
          ? [
            {
              id: "merged",
              header: translate("delivery.records.column.merged"),
              cell: (row: RecordRow) => dayAndTime(row.mergedAt),
            },
            {
              id: "openToMerge",
              header: translate("delivery.records.column.openToMerge"),
              align: "end" as const,
              cell: (row: RecordRow) => duration(row.openToMergeHours),
            },
            {
              id: "lines",
              header: translate("delivery.records.column.lines"),
              align: "end" as const,
              cell: (row: RecordRow) =>
                row.value === null
                  ? cellOrReason(row, null)
                  : formatNumber(row.value, locale),
            },
          ]
          : shown === "closed"
          ? [{
            id: "closed",
            header: translate("delivery.records.column.closed"),
            cell: (row: RecordRow) => dayAndTime(row.closedAt),
          }]
          : []),
      ]),
  ];

  return (
    <UI.Stack gap="standard" data-testid="delivery-records">
      <UI.Inline gap="compact" variant="between">
        <UI.Heading
          id="delivery-records-heading"
          level="subsection"
          rank={2}
          tabIndex={-1}
        >
          {heading}
        </UI.Heading>
        <UI.Inline gap="compact">
          {chosen
            ? (
              <UI.Button onClick={() => props.onShow(null)} variant="outline">
                {translate("delivery.records.clear")}
              </UI.Button>
            )
            : null}
          {missing.length === 0 && !props.missingOnly ? null : (
            <UI.Button
              aria-pressed={props.missingOnly}
              onClick={() => props.onMissingOnly(!props.missingOnly)}
              variant="outline"
            >
              {translate("delivery.records.missingOnly", {
                count: formatNumber(missing.length, locale),
              })}
            </UI.Button>
          )}
        </UI.Inline>
      </UI.Inline>
      {records.status === "loading"
        ? <UI.Skeleton aria-label={translate("delivery.records.loading")} />
        : records.status === "error"
        ? (
          <UI.ErrorState
            action={
              <UI.Button onClick={props.onRetryRecords}>
                {translate("delivery.retry")}
              </UI.Button>
            }
            title={translate("delivery.records.error")}
          />
        )
        : (
          <>
            {phone
              ? (
                // A phone has no room for a table: each record is a stacked
                // row with every value labelled.
                rows.length === 0
                  ? (
                    <UI.Text variant="muted">
                      {translate("delivery.records.empty")}
                    </UI.Text>
                  )
                  : (
                    <UI.Stack
                      aria-label={translate("delivery.records.caption")}
                      gap="none"
                      role="list"
                    >
                      {rows.map((row) => (
                        <div key={row.key} role="listitem">
                          <UI.StackedRow title={title(row)}>
                            {columns.slice(1).map((column) =>
                              column.id === "delivered"
                                ? (
                                  // The time on the label's line, the delivery
                                  // point under it in the caption style.
                                  <UI.Stack gap="none" key={column.id}>
                                    <UI.Text variant="caption">
                                      {column.header}:{" "}
                                      {dayAndTime(row.deliveredAt)}
                                    </UI.Text>
                                    {row.deliveryPoint === null
                                      ? null
                                      : (
                                        <UI.Text variant="caption">
                                          {translate(
                                            `delivery.point.${row.deliveryPoint}` as never,
                                          )}
                                        </UI.Text>
                                      )}
                                  </UI.Stack>
                                )
                                : (
                                  <UI.Text key={column.id} variant="caption">
                                    {column.header}: {column.cell(row)}
                                  </UI.Text>
                                )
                            )}
                          </UI.StackedRow>
                        </div>
                      ))}
                    </UI.Stack>
                  )
              )
              : (
                <UI.DataTable<RecordRow>
                  caption={translate("delivery.records.caption")}
                  captionHidden
                  columns={columns}
                  emptyMessage={translate("delivery.records.empty")}
                  getRowKey={(row) => row.key}
                  rows={[...rows]}
                />
              )}
            {records.hasMore
              ? (
                <UI.CursorControls
                  labels={{
                    controls: translate("delivery.records.caption"),
                    end: "",
                    loadMore: translate("delivery.records.loadMore"),
                    loading: translate("delivery.records.loading"),
                    next: translate("delivery.records.loadMore"),
                    previous: "",
                    retry: translate("delivery.retry"),
                  }}
                  name="delivery-records"
                  onNext={props.onLoadMore}
                  state={records.loadingMore ? "loading" : "ready"}
                  variant="loadMore"
                />
              )
              : null}
          </>
        )}
      <UI.Text variant="muted">
        {version === null
          ? translate(ruleKey(shown, null), { zone: timeZone })
          : translate(ruleKey(shown, version), { zone: timeZone, version })}
      </UI.Text>
    </UI.Stack>
  );
}

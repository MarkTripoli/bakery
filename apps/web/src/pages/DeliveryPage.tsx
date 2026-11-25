import { useMemo, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { formatDate } from "@bakery/i18n";
import { useBakeryApi } from "../api/context.tsx";
import { useConnectivity } from "../app/connectivity.ts";
import { useI18n } from "../i18n/I18nProvider.tsx";
import type { MetricsQuery } from "../api/client.ts";
import {
  effectiveAccessQueryOptions,
  metricSeriesQueryOptions,
  metricSourcesQueryOptions,
  repositoriesListQueryOptions,
} from "../api/query.ts";
import { isForbiddenFailure } from "../app/async-state.ts";
import { useProtectedScope } from "../app/query-scope-context.tsx";
import {
  DeliveryScreen,
  type DeliveryScreenProps,
} from "../screens/DeliveryScreen.tsx";
import {
  countFigure,
  type DeliveryShow,
  freshnessOf,
  isDeliveryShow,
  leadTimeOf,
  openFigure,
  recordRow,
  SHOW_METRIC,
  sizeAndQualityOf,
} from "../screens/delivery/delivery-display.ts";
import {
  deliveryWindow,
  deliveryWindowTooLong,
  formatDay,
  isDeliveryPeriod,
} from "../screens/delivery/delivery-window.ts";
import { ShellActiveNavigation } from "../shell/shell-slots.tsx";
import { INSTALLATION_INTEGRATIONS_PATH } from "../shell/InstallationSettingsNavigation.tsx";

/** Everything the page remembers is in the address, so a view can be linked to. */
const PERIOD = "period";
const REPOSITORY = "repository";
const FROM = "from";
const TO = "to";
const SHOW = "show";
const MISSING = "missing";

const RECORDS_PAGE = 50;
const CHART_DAILY_MAX_MS = 90 * 86_400_000;

/**
 * `/delivery`: what was delivered and how long it took.
 *
 * The page owns the reads and the rules that turn them into states; the screen
 * owns the words. A figure's records are the same window and repository as the
 * figure, so choosing a number can only ever show what that number counted.
 */
export function DeliveryPage() {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const connectivity = useConnectivity();
  const { locale, timeZone } = useI18n();

  const period = isDeliveryPeriod(search[PERIOD]) ? search[PERIOD] : "last30";
  const repositoryId = typeof search[REPOSITORY] === "string"
    ? search[REPOSITORY]
    : null;
  const custom = {
    from: typeof search[FROM] === "string" ? search[FROM] : "",
    to: typeof search[TO] === "string" ? search[TO] : "",
  };
  const show: DeliveryShow | null = isDeliveryShow(search[SHOW])
    ? search[SHOW]
    : null;
  const missingOnly = search[MISSING] === "1" || search[MISSING] === true;

  // The clock is read once per mount: a `new Date()` in render would mint a new
  // window every pass, change every query key and refetch forever.
  const [now] = useState(() => new Date());
  const window = useMemo(
    () => deliveryWindow(period, now, custom),
    [period, now, custom.from, custom.to],
  );
  const rangeReversed = window.from.getTime() > window.to.getTime();
  const tooLong = deliveryWindowTooLong(window) || rangeReversed;
  const base = {
    from: window.from.toISOString(),
    to: window.to.toISOString(),
    resolution: "day" as const,
    ...(repositoryId === null ? {} : { repositoryId }),
  };
  const enabled = !tooLong;
  const metric = SHOW_METRIC[show ?? "merged"];
  const chartMetric = show === null || show === "merged"
    ? "prs.merged"
    : metric;
  const merged = useSeries("prs.merged", base, enabled, "figure");
  const closed = useSeries("prs.closedUnmerged", base, enabled, "figure");
  const open = useSeries("prs.openAtCutoff", base, enabled, "figure");
  const tasks = useSeries("tasks.leadTimeHours", base, enabled, "figure");
  const lines = useSeries("prs.changedLines", base, enabled, "figure");
  const chartResolution = window.to.getTime() - window.from.getTime() >
      CHART_DAILY_MAX_MS
    ? "week" as const
    : "day" as const;
  const chart = useSeries(
    chartMetric,
    { ...base, resolution: chartResolution },
    enabled,
    "chart",
  );
  const repositories = useQuery(
    repositoriesListQueryOptions(api, scope, { limit: 100 }),
  );
  const access = useQuery(effectiveAccessQueryOptions(api, scope));

  const sources = useInfiniteQuery({
    ...metricSourcesQueryOptions(api, scope, {
      metric,
      from: base.from,
      to: base.to,
      ...(repositoryId === null ? {} : { repositoryId }),
      limit: RECORDS_PAGE,
    }),
    enabled: enabled && scope.organizationId !== null,
  });

  const queries = [merged, closed, open, tasks, lines];
  const failed = queries.find((query) => query.isError);
  const forbidden = failed !== undefined &&
    isForbiddenFailure(failed.error as never);
  const loading = queries.some((query) => query.isPending) || tooLong;
  const data = [merged.data, closed.data, open.data, tasks.data, lines.data];

  const mergedCount = countFigure(merged.data);
  const tasksCount = countFigure(tasks.data);
  const nothingInPeriod = merged.data !== undefined &&
    merged.data.completeness !== "unknown" &&
    [mergedCount, tasksCount, countFigure(closed.data), openFigure(open.data)]
      .every((figure) => figure.kind === "value" && figure.value === 0);

  const state: DeliveryScreenProps["state"] = forbidden
    ? "notFound"
    : loading
    ? "loading"
    : failed !== undefined
    ? "error"
    : merged.data !== undefined && merged.data.repositories.length === 0
    ? "noRepository"
    : nothingInPeriod
    ? "emptyPeriod"
    : "ready";

  const write = (next: Record<string, string | undefined>) => {
    void navigate({
      to: "/delivery",
      search: { ...search, ...next },
      // Replacing, not pushing: choosing a filter is not a place to go back to.
      replace: true,
    });
  };

  const pages = sources.data?.pages ?? [];
  const rows = pages.flatMap((page) => page.items.map(recordRow));
  const rowsStatus = sources.isError
    ? "error"
    : sources.isPending
    ? "loading"
    : "ready";

  const repositoryChoices = (repositories.data?.items ?? []).map((item) => ({
    id: item.id,
    name: `${item.owner}/${item.name}`,
  }));
  const hiddenCount = data.reduce(
    (most, entry) => Math.max(most, entry?.hiddenCount ?? 0),
    0,
  );

  return (
    <>
      <ShellActiveNavigation id="delivery" />
      <DeliveryScreen
        canReconnect={access.data?.role === "admin"}
        connectHref="/projects"
        custom={custom.from === "" && custom.to === ""
          ? {
            from: formatDay(window.from),
            to: formatDay(new Date(window.to.getTime() - 1)),
          }
          : custom}
        chart={{
          status: chart.isError
            ? "error"
            : chart.isPending
            ? "loading"
            : "ready",
          points: chart.data?.points ?? [],
          resolution: chartResolution,
          to: chart.data?.to ?? base.to,
        }}
        figures={{
          merged: mergedCount,
          tasks: tasksCount,
          open: openFigure(open.data),
          closed: countFigure(closed.data),
        }}
        freshness={state === "ready" || state === "emptyPeriod"
          ? freshnessOf({
            merged: merged.data,
            lines: lines.data,
            tasks: tasks.data,
          })
          : null}
        hiddenCount={hiddenCount}
        lastUpdated={merged.dataUpdatedAt > 0
          ? formatDate(new Date(merged.dataUpdatedAt), locale, {
            timeStyle: "short",
            timeZone,
          })
          : null}
        leadTime={leadTimeOf(tasks.data)}
        offline={connectivity === "offline" || connectivity === "reconnecting"}
        quality={sizeAndQualityOf(lines.data)}
        missingOnly={missingOnly}
        onCustomChange={(range) =>
          write({ [FROM]: range.from, [TO]: range.to })}
        onLoadMore={() => void sources.fetchNextPage()}
        onMissingOnly={(on) => write({ [MISSING]: on ? "1" : undefined })}
        onNavigate={(href) => void navigate({ to: href })}
        onPeriodChange={(choice) =>
          write({
            [PERIOD]: choice,
            ...(choice === "custom"
              ? {
                [FROM]: custom.from || formatDay(window.from),
                [TO]: custom.to || formatDay(new Date(window.to.getTime() - 1)),
              }
              : { [FROM]: undefined, [TO]: undefined }),
          })}
        onRefresh={() => {
          for (const query of queries) void query.refetch();
          void chart.refetch();
        }}
        onRepositoryChange={(id) => write({ [REPOSITORY]: id ?? undefined })}
        onRetry={() => {
          for (const query of queries) void query.refetch();
        }}
        onRetryRecords={() => void sources.refetch()}
        onRetryChart={() => void chart.refetch()}
        onShow={(next) =>
          write({ [SHOW]: next ?? undefined, [MISSING]: undefined })}
        onShowUncounted={() => write({ [SHOW]: "lines", [MISSING]: "1" })}
        onShowLast30Days={() =>
          write({ [PERIOD]: "last30", [FROM]: undefined, [TO]: undefined })}
        period={period}
        periodTooLong={tooLong}
        rangeReversed={rangeReversed}
        reconnectHref={INSTALLATION_INTEGRATIONS_PATH}
        records={{
          status: rowsStatus,
          rows,
          hasMore: sources.hasNextPage,
          loadingMore: sources.isFetchingNextPage,
          revision: {
            merged: lines.data,
            opened: chart.data,
            lines: lines.data,
            tasks: tasks.data,
            open: open.data,
            closed: closed.data,
          }[show ?? "merged"]?.measurementRevision ?? null,
        }}
        repositories={repositoryChoices}
        repositoryId={repositoryId}
        show={show}
        state={state}
        taskHref={(taskId) => `/tasks/${taskId}`}
        window={window}
      />
    </>
  );
}

type SeriesBase = {
  readonly from: string;
  readonly to: string;
  readonly resolution: NonNullable<MetricsQuery["resolution"]>;
  readonly repositoryId?: string;
};

/** One metric over the page's window; a refused or too-long window is not asked. */
function useSeries(
  metric: MetricsQuery["metric"],
  base: SeriesBase,
  enabled: boolean,
  purpose: "figure" | "chart",
) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const options = metricSeriesQueryOptions(api, scope, { ...base, metric });
  return useQuery({
    ...options,
    queryKey: [...options.queryKey, purpose],
    retry: purpose === "chart" ? false : undefined,
    enabled: enabled && scope.organizationId !== null,
  });
}

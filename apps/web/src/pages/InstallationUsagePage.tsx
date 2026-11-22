import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useBakeryApi } from "../api/context.tsx";
import { usageSummaryQueryOptions } from "../api/query.ts";
import { isForbiddenFailure } from "../app/async-state.ts";
import { useProtectedScope } from "../app/query-scope-context.tsx";
import { InstallationUsageScreen } from "../screens/InstallationUsageScreen.tsx";
import {
  isUsagePeriod,
  usageWindow,
  usageWindowTooLong,
} from "../screens/usage/usage-window.ts";

/** The period choices as they appear in the address bar. */
const PERIOD_QUERY = "period";
const PROVIDER_QUERY = "provider";

export function InstallationUsagePage() {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const period = isUsagePeriod(search[PERIOD_QUERY])
    ? search[PERIOD_QUERY]
    : "last30";
  const provider = typeof search[PROVIDER_QUERY] === "string" &&
      search[PROVIDER_QUERY] !== "all"
    ? search[PROVIDER_QUERY]
    : null;
  // Both filters live in the address so a figure can be linked to: a period in
  // the URL is the difference between "our spend is high" and a message someone
  // can open at the same window.
  // The clock is read once per mount, not in render. A `new Date()` in render
  // mints a fresh `from`/`to` to the millisecond on every pass, so the query
  // key changes every render and React Query answers by refetching forever -
  // the page sat on "Loading" while the server answered 200 in a loop. Holding
  // the instant also means the figure does not silently widen under a reader
  // who has been on the page a while: the period label and the numbers agree
  // until the page is opened again.
  const [now] = useState(() => new Date());
  const window = useMemo(() => usageWindow(period, now), [period, now]);
  const tooLong = usageWindowTooLong(window);
  const summary = useQuery({
    ...usageSummaryQueryOptions(api, scope, {
      from: window.from.toISOString(),
      to: window.to.toISOString(),
      ...(provider === null ? {} : { provider }),
    }),
    // A window the server refuses is not worth asking about: the request would
    // answer a validation error, and the page already says what to change.
    enabled: !tooLong,
  });

  const write = (next: Record<string, string | undefined>) => {
    void navigate({
      to: "/installation/usage",
      search: { ...search, ...next },
      // Replacing, not pushing: dragging the period picker should not fill the
      // Back button with a history of windows nobody meant to revisit.
      replace: true,
    });
  };

  const forbidden = summary.isError &&
    isForbiddenFailure(summary.error as never);
  const state = forbidden
    ? "notFound"
    : summary.isLoading || tooLong
    ? "loading"
    : summary.isError
    ? "error"
    : summary.data !== undefined && summary.data.byProvider.length === 0 &&
        summary.data.unknownCount === 0 &&
        summary.data.unverifiedCount === 0
    ? "empty"
    : "ready";

  return (
    <InstallationUsageScreen
      onPeriodChange={(choice) => write({ [PERIOD_QUERY]: choice })}
      onProviderChange={(choice) =>
        write({ [PROVIDER_QUERY]: choice ?? "all" })}
      onRetry={() => void summary.refetch()}
      onShowLast30Days={() => write({ [PERIOD_QUERY]: "last30" })}
      period={period}
      periodTooLong={tooLong}
      provider={provider}
      state={state}
      summary={summary.data ?? null}
    />
  );
}

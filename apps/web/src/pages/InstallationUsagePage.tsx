import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { formatDate } from "@bakery/i18n";
import { useBakeryApi } from "../api/context.tsx";
import { useConnectivity } from "../app/connectivity.ts";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { usageSummaryQueryOptions } from "../api/query.ts";
import { isForbiddenFailure } from "../app/async-state.ts";
import { useProtectedScope } from "../app/query-scope-context.tsx";
import { InstallationUsageScreen } from "../screens/InstallationUsageScreen.tsx";
import {
  customWindow,
  dateInput,
  isUsagePeriod,
  usageWindow,
  usageWindowReversed,
  usageWindowTooLong,
} from "../screens/usage/usage-window.ts";

/** The period choices as they appear in the address bar. */
const PERIOD_QUERY = "period";
const PROVIDER_QUERY = "provider";
const FROM_QUERY = "from";
const TO_QUERY = "to";

export function InstallationUsagePage() {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const { locale, timeZone } = useI18n();
  const connectivity = useConnectivity();
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
  const customFrom = typeof search[FROM_QUERY] === "string"
    ? search[FROM_QUERY]
    : "";
  const customTo = typeof search[TO_QUERY] === "string" ? search[TO_QUERY] : "";
  const candidate = period === "custom"
    ? customWindow(customFrom, customTo)
    : usageWindow(period, now);
  const reversed = candidate !== null && usageWindowReversed(candidate);
  const tooLong = candidate !== null && !reversed &&
    usageWindowTooLong(candidate);
  const periodError = period !== "custom"
    ? null
    : candidate === null
    ? "incomplete"
    : reversed
    ? "reversed"
    : tooLong
    ? "tooLong"
    : null;
  const lastValid = useRef(usageWindow("last30", now));
  if (candidate !== null && periodError === null) lastValid.current = candidate;
  const window = candidate !== null && periodError === null
    ? candidate
    : lastValid.current;
  const summary = useQuery({
    ...usageSummaryQueryOptions(api, scope, {
      from: window.from.toISOString(),
      to: window.to.toISOString(),
      ...(provider === null ? {} : { provider }),
    }),
  });

  const everyProvider = useQuery({
    ...usageSummaryQueryOptions(api, scope, {
      from: window.from.toISOString(),
      to: window.to.toISOString(),
    }),
    enabled: provider !== null,
  });
  const providers = [
    ...new Set(
      (provider === null ? summary.data : everyProvider.data)?.byProvider.map((
        row,
      ) => row.provider) ?? [],
    ),
  ];

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
    : summary.isLoading
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
      customFrom={customFrom}
      customTo={customTo}
      periodError={periodError}
      providers={providers}
      onCustomChange={(next) =>
        write({ [FROM_QUERY]: next.from, [TO_QUERY]: next.to })}
      onPeriodChange={(choice) =>
        write(
          choice === "custom" &&
            customWindow(customFrom, customTo) === null
            ? {
              [PERIOD_QUERY]: choice,
              [FROM_QUERY]: dateInput(
                new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000),
              ),
              [TO_QUERY]: dateInput(now),
            }
            : { [PERIOD_QUERY]: choice },
        )}
      onProviderChange={(choice) =>
        write({ [PROVIDER_QUERY]: choice ?? "all" })}
      lastUpdated={summary.dataUpdatedAt > 0
        ? formatDate(new Date(summary.dataUpdatedAt), locale, {
          timeStyle: "short",
          timeZone,
        })
        : null}
      offline={connectivity === "offline" || connectivity === "reconnecting"}
      onRetry={() => void summary.refetch()}
      onShowLast30Days={() => write({ [PERIOD_QUERY]: "last30" })}
      period={period}
      provider={provider}
      state={state}
      summary={summary.data ?? null}
    />
  );
}

import { useEffect, useState } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import type { TelemetryDestination } from "../api/client.ts";
import { asyncKindForError } from "../app/async-state.ts";
import {
  InstallationMonitoringScreen,
  type SaveNotice,
} from "../screens/InstallationMonitoringScreen.tsx";
import {
  type DestinationFilters,
  isStateFilter,
} from "../screens/monitoring/monitoring-display.ts";
import { noticeOf, useMonitoringList } from "./monitoring-shared.ts";

/** A value that follows `value` after it has been still for `delay` milliseconds. */
function useSettled<T>(value: T, delay: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = globalThis.setTimeout(() => setSettled(value), delay);
    return () => globalThis.clearTimeout(timer);
  }, [value, delay]);
  return settled;
}

/**
 * `/installation/monitoring`: the destinations as a table, a page at a time.
 * The search and both filters live in the address, so a view can be linked to,
 * and the server applies them. Every switch reads the list again; the list also
 * refreshes every 15 seconds.
 */
export function InstallationMonitoringPage() {
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const filters: DestinationFilters = {
    q: typeof search.q === "string" ? search.q : "",
    state: isStateFilter(search.state) ? search.state : "all",
    provider: typeof search.provider === "string" && search.provider !== ""
      ? search.provider
      : null,
  };
  // Typing in the search asks the server once the person pauses.
  const settledQuery = useSettled(filters.q, 250);
  const {
    api,
    list,
    kinds,
    providers,
    destinations,
    total,
    stateCounts,
    destinationLimit,
    failing,
    hasMore,
    loadingMore,
    loadMore,
    refresh,
  } = useMonitoringList({ ...filters, q: settledQuery });
  const [rowNotice, setRowNotice] = useState<SaveNotice | null>(null);
  const [pendingIds, setPendingIds] = useState<readonly string[]>([]);

  const writeFilters = (next: DestinationFilters) => {
    void navigate({
      to: "/installation/monitoring",
      search: {
        ...(next.q.trim() === "" ? {} : { q: next.q }),
        ...(next.state === "all" ? {} : { state: next.state }),
        ...(next.provider === null ? {} : { provider: next.provider }),
      },
      // Typing in the search must not fill the Back button.
      replace: true,
    });
  };
  const toggle = async (
    destination: TelemetryDestination,
    enabled: boolean,
  ) => {
    setPendingIds((ids) => [...ids, destination.id]);
    setRowNotice(null);
    try {
      const result = await api.telemetryDestinations.update({
        id: destination.id,
        input: { enabled },
        version: destination.version,
        idempotencyKey: crypto.randomUUID(),
      });
      if (!result.ok) setRowNotice(noticeOf(result.error));
      await refresh();
    } finally {
      setPendingIds((ids) => ids.filter((item) => item !== destination.id));
    }
  };

  const state = list.isPending
    ? "loading"
    : list.isError
    ? asyncKindForError(list.error) === "forbidden" ? "notFound" : "error"
    : "ready";

  return (
    <InstallationMonitoringScreen
      destinationLimit={destinationLimit}
      destinations={destinations}
      failing={failing}
      filters={filters}
      hasMore={hasMore}
      kinds={kinds}
      loadingMore={loadingMore}
      onAdd={() => void navigate({ to: "/installation/monitoring/new" })}
      onFiltersChange={writeFilters}
      onLoadMore={loadMore}
      onOpen={(destination) =>
        void navigate({
          to: "/installation/monitoring/$destinationId",
          params: { destinationId: destination.id },
        })}
      onRetry={() => void list.refetch()}
      onToggle={(destination, enabled) => void toggle(destination, enabled)}
      pendingIds={pendingIds}
      providers={providers}
      rowNotice={rowNotice}
      state={state}
      stateCounts={stateCounts}
      total={total}
    />
  );
}

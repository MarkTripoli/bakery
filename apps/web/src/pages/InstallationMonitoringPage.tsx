import { useState } from "react";
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
import { noticeOf, useMonitoringRead } from "./monitoring-shared.ts";

/**
 * `/installation/monitoring`: the destinations as a table. The search and
 * both filters live in the address, so a view can be linked to. Every switch
 * reads the list again; the list also refreshes every 15 seconds.
 */
export function InstallationMonitoringPage() {
  const { api, list, kinds, destinations, refresh } = useMonitoringRead();
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const filters: DestinationFilters = {
    q: typeof search.q === "string" ? search.q : "",
    state: isStateFilter(search.state) ? search.state : "all",
    kind: typeof search.kind === "string" && search.kind !== ""
      ? search.kind
      : null,
  };
  const [rowNotice, setRowNotice] = useState<SaveNotice | null>(null);
  const [pendingIds, setPendingIds] = useState<readonly string[]>([]);

  const writeFilters = (next: DestinationFilters) => {
    void navigate({
      to: "/installation/monitoring",
      search: {
        ...(next.q.trim() === "" ? {} : { q: next.q }),
        ...(next.state === "all" ? {} : { state: next.state }),
        ...(next.kind === null ? {} : { kind: next.kind }),
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
      destinations={destinations}
      filters={filters}
      kinds={kinds}
      onAdd={(kind) =>
        void navigate({
          to: "/installation/monitoring/new",
          search: { kind },
        })}
      onFiltersChange={writeFilters}
      onOpen={(destination) =>
        void navigate({
          to: "/installation/monitoring/$destinationId",
          params: { destinationId: destination.id },
        })}
      onRetry={() => void list.refetch()}
      onToggle={(destination, enabled) => void toggle(destination, enabled)}
      pendingIds={pendingIds}
      rowNotice={rowNotice}
      state={state}
    />
  );
}

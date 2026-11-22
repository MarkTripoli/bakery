import {
  keepPreviousData,
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useBakeryApi } from "../api/context.tsx";
import type { ApiFailure, TelemetryDestinationList } from "../api/client.ts";
import {
  telemetryDestinationQueryOptions,
  telemetryDestinationsQueryOptions,
} from "../api/query.ts";
import { failureStatus } from "../app/async-state.ts";
import { useProtectedScope } from "../app/query-scope-context.tsx";
import type { SaveNotice } from "../screens/InstallationMonitoringScreen.tsx";
import {
  type DestinationFilters,
  destinationsOf,
  detailOf,
  type FieldIssues,
  issuesByField,
  kindsOf,
  measurementsOf,
  providersOf,
  stateCountsOf,
} from "../screens/monitoring/monitoring-display.ts";

/** What a refused change says, from the server's answer. */
export function noticeOf(error: ApiFailure): SaveNotice {
  const status = failureStatus(error);
  if (status === 412) return "conflict";
  if (error.kind === "problem" && status === 409) {
    const reason = error.problem.reason;
    if (reason === "name_taken") return "nameTaken";
    if (reason === "destination_limit") return "limit";
    if (reason === "secrets_key_unavailable") return "noKey";
  }
  if (error.kind === "network") return "offline";
  return "failed";
}

/** The field messages of a 422, or none. */
export function issuesOf(error: ApiFailure): FieldIssues | null {
  return error.kind === "problem" && error.problem.status === 422 &&
      error.problem.issues !== undefined
    ? issuesByField(error.problem.issues)
    : null;
}

/** Every telemetry read, so a change or a refresh can reload them all. */
const isTelemetryRead = (query: { queryKey: readonly unknown[] }) =>
  JSON.stringify(query.queryKey).includes('"telemetryDestinations.');

function readsOf(
  data: { readonly pages: readonly TelemetryDestinationList[] } | undefined,
) {
  const pages = data?.pages ?? [];
  const first = pages[0];
  const last = pages[pages.length - 1];
  return {
    kinds: first === undefined ? [] : kindsOf(first),
    measurements: first === undefined ? [] : measurementsOf(first),
    providers: first === undefined ? [] : providersOf(first),
    destinations: pages.flatMap(destinationsOf),
    total: last?.total ?? 0,
    destinationLimit: first?.destinationLimit ?? 0,
    stateCounts: first === undefined ? null : stateCountsOf(first),
  };
}

/**
 * The list's read: the destinations that match the search and filters a page
 * at a time, with the kinds, measurements, providers and how many are in each
 * state. It refreshes every 15 seconds while visible.
 */
export function useMonitoringList(filters: DestinationFilters) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const queryClient = useQueryClient();
  const options = telemetryDestinationsQueryOptions(api, scope, {
    search: filters.q.trim(),
    state: filters.state === "all" ? undefined : filters.state,
    provider: filters.provider ?? undefined,
  });
  const list = useInfiniteQuery({
    ...options,
    placeholderData: keepPreviousData,
  });
  const reads = readsOf(list.data);
  // The notice names the one destination that is failing; it is read apart from
  // the page, so a search or filter never hides it.
  const failingOne = reads.stateCounts?.failing === 1;
  const failing = useInfiniteQuery({
    ...telemetryDestinationsQueryOptions(api, scope, {
      state: "failing",
      limit: 2,
    }),
    enabled: Boolean(scope.organizationId) && failingOne,
  });
  return {
    api,
    list,
    ...reads,
    failing: failingOne ? readsOf(failing.data).destinations : [],
    hasMore: list.hasNextPage,
    loadingMore: list.isFetchingNextPage,
    loadMore: () => void list.fetchNextPage(),
    refresh: () =>
      queryClient.invalidateQueries({ predicate: isTelemetryRead }),
  };
}

/**
 * What the add page needs: the kinds, the measurements and the providers. One
 * destination is enough to read them.
 */
export function useMonitoringChoices() {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const queryClient = useQueryClient();
  const list = useInfiniteQuery(
    telemetryDestinationsQueryOptions(api, scope, { limit: 1 }),
  );
  return {
    api,
    list,
    ...readsOf(list.data),
    refresh: () =>
      queryClient.invalidateQueries({ predicate: isTelemetryRead }),
  };
}

/** One destination's page: the destination, its kind and provider and the measurements. */
export function useMonitoringDestination(id: string) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const queryClient = useQueryClient();
  const read = useQuery(telemetryDestinationQueryOptions(api, scope, id));
  const detail = read.data === undefined ? null : detailOf(read.data);
  return {
    api,
    read,
    destination: detail?.destination ?? null,
    kind: detail?.kind ?? null,
    provider: detail?.provider ?? null,
    measurements: detail?.measurements ?? [],
    refresh: () =>
      queryClient.invalidateQueries({ predicate: isTelemetryRead }),
  };
}

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useBakeryApi } from "../api/context.tsx";
import type { ApiFailure } from "../api/client.ts";
import { telemetryDestinationsQueryOptions } from "../api/query.ts";
import { failureStatus } from "../app/async-state.ts";
import { useProtectedScope } from "../app/query-scope-context.tsx";
import type { SaveNotice } from "../screens/InstallationMonitoringScreen.tsx";
import {
  destinationsOf,
  type FieldIssues,
  issuesByField,
  kindsOf,
  measurementsOf,
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

/**
 * The one read the list and every destination's page are built from (kinds,
 * measurements, destinations). It refreshes every 15 seconds while visible.
 */
export function useMonitoringRead() {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const queryClient = useQueryClient();
  const options = telemetryDestinationsQueryOptions(api, scope);
  const list = useQuery(options);
  const data = list.data;
  return {
    api,
    list,
    kinds: data === undefined ? [] : kindsOf(data),
    measurements: data === undefined ? [] : measurementsOf(data),
    destinations: data === undefined ? [] : destinationsOf(data),
    refresh: () =>
      queryClient.invalidateQueries({ queryKey: options.queryKey }),
  };
}

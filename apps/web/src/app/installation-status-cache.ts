import type {
  ApiResult,
  BakeryApiClient,
  InstallationStatus,
} from "../api/client.ts";

let pending: Promise<ApiResult<InstallationStatus>> | null = null;

/**
 * Per-tab memoized `installation.status`, reused across navigations so the
 * root route's bootstrap redirect doesn't refetch on every route change.
 * Cleared on any transport/validation failure so the next navigation
 * retries, and by `reset()` whenever a caller's own fresh check (`/setup`'s
 * "Check again") should invalidate it for the next navigation.
 */
export function installationStatus(
  api: BakeryApiClient,
  signal: AbortSignal,
): Promise<ApiResult<InstallationStatus>> {
  pending ??= api.installationStatus(signal).then((result) => {
    if (!result.ok) pending = null;
    return result;
  });
  return pending;
}

/** Forgets the cached result so the next call re-fetches. */
export function reset(): void {
  pending = null;
}

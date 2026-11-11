import type {
  ApiFailure,
  ApiResult,
  BakeryApiClient,
  SyncResponse,
} from "./client.ts";

const DEFAULT_MAX_PAGES = 3;
const DEFAULT_PAGE_LIMIT = 100;
const DEFAULT_NETWORK_RETRIES = 1;
const MAX_RECENT_EVENT_IDS = 1_000;

type SyncEvent = SyncResponse["events"][number];

export type DurableTaskSyncAuthority = Readonly<{
  sessionGeneration: number;
  organizationId: string;
  taskId: string;
}>;

export type DurableSyncConnectivity =
  | "unknown"
  | "online"
  | "offline"
  | "reconnecting";

export type DurableTaskSyncState = Readonly<{
  authority: DurableTaskSyncAuthority;
  hasSnapshot: boolean;
  resourceState: SyncResponse["resourceState"] | null;
  confirmedCursor: string | null;
  caughtUp: boolean;
  connectivity: DurableSyncConnectivity;
  recentEventIds: readonly string[];
}>;

export type DurableTaskSyncAction =
  | Readonly<{
    type: "response";
    response: SyncResponse;
    requestedCursor: string | null;
    freshSnapshot: boolean;
  }>
  | Readonly<{
    type: "invalidation";
    eventId: string;
  }>
  | Readonly<{
    type: "connectivity";
    connectivity: DurableSyncConnectivity;
  }>;

export type DurableTaskSyncPollReason =
  | "caught-up"
  | "page-limit"
  | "offline"
  | "reconnecting"
  | "cancelled"
  | "scope-changed"
  | "error";

export type DurableTaskSyncPollResult = Readonly<{
  state: DurableTaskSyncState;
  reason: DurableTaskSyncPollReason;
  pages: number;
  attempts: number;
  resetPerformed: boolean;
  invalidationEventIds: readonly string[];
  failure?: ApiFailure;
}>;

export type DurableTaskSyncPollOptions = Readonly<{
  client: Pick<BakeryApiClient, "sync">;
  state: DurableTaskSyncState;
  signal: AbortSignal;
  isCurrent: (authority: DurableTaskSyncAuthority) => boolean;
  maxPages?: number;
  pageLimit?: number;
  networkRetries?: number;
}>;

export function createDurableTaskSyncState(
  authority: DurableTaskSyncAuthority,
): DurableTaskSyncState {
  return {
    authority: { ...authority },
    hasSnapshot: false,
    resourceState: null,
    confirmedCursor: null,
    caughtUp: false,
    connectivity: "unknown",
    recentEventIds: [],
  };
}

function rememberEventId(
  recentEventIds: readonly string[],
  eventId: string,
): readonly string[] {
  if (recentEventIds.includes(eventId)) return recentEventIds;
  return [...recentEventIds, eventId].slice(-MAX_RECENT_EVENT_IDS);
}

export function durableTaskSyncReducer(
  state: DurableTaskSyncState,
  action: DurableTaskSyncAction,
): DurableTaskSyncState {
  if (action.type === "connectivity") {
    return { ...state, connectivity: action.connectivity };
  }
  if (action.type === "invalidation") {
    const recentEventIds = rememberEventId(
      state.recentEventIds,
      action.eventId,
    );
    return recentEventIds === state.recentEventIds
      ? state
      : { ...state, recentEventIds };
  }

  const confirmedCursor = action.response.nextCursor ?? action.requestedCursor;
  let recentEventIds = state.recentEventIds;
  for (const event of action.response.events) {
    recentEventIds = rememberEventId(recentEventIds, event.id);
  }
  return {
    ...state,
    hasSnapshot: action.freshSnapshot || state.hasSnapshot,
    resourceState: action.freshSnapshot
      ? action.response.resourceState
      : state.resourceState,
    confirmedCursor,
    caughtUp: action.response.nextCursor === null,
    connectivity: "online",
    recentEventIds,
  };
}

export function noteDurableTaskInvalidation(
  state: DurableTaskSyncState,
  authority: DurableTaskSyncAuthority,
  event: Pick<SyncEvent, "id" | "taskId">,
): DurableTaskSyncState {
  if (
    authority.sessionGeneration !== state.authority.sessionGeneration ||
    authority.organizationId !== state.authority.organizationId ||
    authority.taskId !== state.authority.taskId ||
    event.taskId !== state.authority.taskId
  ) return state;
  return durableTaskSyncReducer(state, {
    type: "invalidation",
    eventId: event.id,
  });
}

function isResetRequired(failure: ApiFailure): boolean {
  return failure.kind === "problem" && failure.problem.status === 409 &&
    failure.problem.resetRequired === true &&
    failure.problem.retryWithoutAfter === true;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isInteger(value) && value > 0
    ? value
    : fallback;
}

function nonnegativeInteger(
  value: number | undefined,
  fallback: number,
): number {
  return value !== undefined && Number.isInteger(value) && value >= 0
    ? value
    : fallback;
}

export async function pollDurableTaskSync(
  options: DurableTaskSyncPollOptions,
): Promise<DurableTaskSyncPollResult> {
  const maxPages = positiveInteger(options.maxPages, DEFAULT_MAX_PAGES);
  const pageLimit = positiveInteger(options.pageLimit, DEFAULT_PAGE_LIMIT);
  const networkRetries = nonnegativeInteger(
    options.networkRetries,
    DEFAULT_NETWORK_RETRIES,
  );
  const initialState = options.state;
  let state = initialState;
  let pages = 0;
  let attempts = 0;
  let resetPerformed = false;
  const invalidationEventIds: string[] = [];
  const knownEventIds = new Set(initialState.recentEventIds);

  const authorityIsCurrent = () =>
    !options.signal.aborted && options.isCurrent(initialState.authority);
  const stopped = (): DurableTaskSyncPollResult => ({
    state: initialState,
    reason: options.signal.aborted ? "cancelled" : "scope-changed",
    pages: 0,
    attempts,
    resetPerformed,
    invalidationEventIds: [],
  });

  if (!authorityIsCurrent()) return stopped();

  while (pages < maxPages) {
    const requestedCursor = state.hasSnapshot ? state.confirmedCursor : null;
    let freshSnapshot = !state.hasSnapshot;
    let retries = 0;
    let result: ApiResult<SyncResponse>;

    while (true) {
      if (!authorityIsCurrent()) return stopped();
      attempts += 1;
      result = await options.client.sync({
        organizationId: state.authority.organizationId,
        scopeType: "task",
        scopeId: state.authority.taskId,
        ...(freshSnapshot ? {} : { after: requestedCursor ?? undefined }),
        limit: pageLimit,
        signal: options.signal,
      });
      if (!authorityIsCurrent()) return stopped();
      if (
        result.ok || result.error.kind !== "network" ||
        retries >= networkRetries
      ) break;
      retries += 1;
    }

    if (!result.ok) {
      if (isResetRequired(result.error) && !resetPerformed) {
        resetPerformed = true;
        freshSnapshot = true;
        let resetRetries = 0;
        while (true) {
          if (!authorityIsCurrent()) return stopped();
          attempts += 1;
          result = await options.client.sync({
            organizationId: state.authority.organizationId,
            scopeType: "task",
            scopeId: state.authority.taskId,
            limit: pageLimit,
            signal: options.signal,
          });
          if (!authorityIsCurrent()) return stopped();
          if (
            result.ok || result.error.kind !== "network" ||
            resetRetries >= networkRetries
          ) break;
          resetRetries += 1;
        }
      }
    }

    if (!result.ok) {
      const connectivity = result.error.kind === "network"
        ? state.hasSnapshot ? "reconnecting" : "offline"
        : "unknown";
      state = durableTaskSyncReducer(state, {
        type: "connectivity",
        connectivity,
      });
      return {
        state,
        reason: connectivity === "offline"
          ? "offline"
          : connectivity === "reconnecting"
          ? "reconnecting"
          : "error",
        pages,
        attempts,
        resetPerformed,
        invalidationEventIds,
        failure: result.error,
      };
    }
    if (
      result.data.resetRequired ||
      (freshSnapshot && result.data.nextCursor === null)
    ) {
      state = durableTaskSyncReducer(state, {
        type: "connectivity",
        connectivity: "unknown",
      });
      return {
        state,
        reason: "error",
        pages,
        attempts,
        resetPerformed,
        invalidationEventIds,
        failure: { kind: "invalid-response", status: 200 },
      };
    }

    for (const event of result.data.events) {
      if (!knownEventIds.has(event.id)) {
        knownEventIds.add(event.id);
        invalidationEventIds.push(event.id);
      }
    }
    state = durableTaskSyncReducer(state, {
      type: "response",
      response: result.data,
      requestedCursor: freshSnapshot ? null : requestedCursor,
      freshSnapshot,
    });
    pages += 1;

    if (result.data.nextCursor === null) {
      return {
        state,
        reason: "caught-up",
        pages,
        attempts,
        resetPerformed,
        invalidationEventIds,
      };
    }
  }

  return {
    state,
    reason: "page-limit",
    pages,
    attempts,
    resetPerformed,
    invalidationEventIds,
  };
}

import { useEffect, useMemo, useRef, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useBakeryApi } from "../api/context.tsx";
import {
  backupDrillsQueryOptions,
  backupOffsiteQueryOptions,
  backupPointInTimeQueryOptions,
  backupRunsQueryOptions,
  backupScheduleQueryOptions,
  backupStatusQueryOptions,
  installationRestoreQueryOptions,
} from "../api/query.ts";
import { isForbiddenFailure } from "../app/async-state.ts";
import { useSingleFlightSubmit } from "../app/auth-form.ts";
import { useProtectedScope } from "../app/query-scope-context.tsx";
import {
  type BackupsScreenState,
  InstallationBackupsScreen,
} from "../screens/InstallationBackupsScreen.tsx";
import { useRunnerKey } from "./useRunnerKey.ts";

const CLOCK_TICK_MS = 30_000;
const STATUS_REFRESH_MS = 15_000;

function useNowMs(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = globalThis.setInterval(
      () => setNow(Date.now()),
      CLOCK_TICK_MS,
    );
    return () => globalThis.clearInterval(timer);
  }, []);
  return now;
}

export function InstallationBackupsPage() {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const navigate = useNavigate();
  const nowMs = useNowMs();
  const statusOptions = backupStatusQueryOptions(api, scope);
  const status = useQuery({
    ...statusOptions,
    refetchInterval: STATUS_REFRESH_MS,
  });
  const runs = useInfiniteQuery(backupRunsQueryOptions(api, scope));
  const drills = useInfiniteQuery(backupDrillsQueryOptions(api, scope));
  const schedule = useQuery(backupScheduleQueryOptions(api, scope));
  const offsite = useQuery(backupOffsiteQueryOptions(api, scope));
  const pointInTime = useQuery(backupPointInTimeQueryOptions(api, scope));
  const restore = useQuery(installationRestoreQueryOptions(api, scope));

  const [startFailed, setStartFailed] = useState(false);
  const startKey = useRef<string | null>(null);
  useEffect(() => {
    setStartFailed(false);
    startKey.current = null;
  }, [scope.sessionGeneration]);

  const refreshAll = () => {
    void status.refetch();
    void runs.refetch();
  };

  const [starting, start] = useSingleFlightSubmit(async () => {
    startKey.current ??= crypto.randomUUID();
    setStartFailed(false);
    const result = await api.backups.start({
      idempotencyKey: startKey.current,
    });
    const alreadyWaiting = !result.ok && result.error.kind === "problem" &&
      result.error.problem.code === "STATE_CONFLICT";
    if (result.ok || alreadyWaiting) {
      startKey.current = null;
      refreshAll();
      return;
    }
    setStartFailed(true);
  });

  const { runnerKey, issue: makeKey, done: keyDone } = useRunnerKey();

  const runRows = useMemo(
    () => runs.data?.pages.flatMap((page) => page.items) ?? [],
    [runs.data],
  );
  const drillRows = useMemo(
    () => drills.data?.pages.flatMap((page) => page.items) ?? [],
    [drills.data],
  );

  const forbidden = status.isError && isForbiddenFailure(status.error as never);
  const state: BackupsScreenState = forbidden
    ? "notFound"
    : status.isPending
    ? "loading"
    : status.isError
    ? "error"
    : "ready";

  const listState = (query: { isPending: boolean; isError: boolean }) =>
    query.isPending
      ? "loading" as const
      : query.isError
      ? "error" as const
      : "ready" as const;

  return (
    <InstallationBackupsScreen
      drills={{
        state: listState(drills),
        rows: drillRows,
        hasMore: Boolean(drills.hasNextPage),
        loadingMore: drills.isFetchingNextPage,
      }}
      nowMs={nowMs}
      offsite={offsite.data ?? null}
      onKeyDone={keyDone}
      onMakeKey={() => void makeKey()}
      onMoreDrills={() => void drills.fetchNextPage()}
      onMoreRuns={() => void runs.fetchNextPage()}
      onNavigate={(path) => void navigate({ to: path })}
      onRetry={() => {
        void status.refetch();
        void runs.refetch();
        void drills.refetch();
      }}
      onRetryDrills={() => void drills.refetch()}
      onRetryRuns={() => void runs.refetch()}
      onStart={() => void start()}
      pointInTime={pointInTime.data ?? null}
      restoreHeld={restore.data !== undefined && restore.data !== null &&
        restore.data.releasedAt === null}
      runnerKey={runnerKey}
      runs={{
        state: listState(runs),
        rows: runRows,
        hasMore: Boolean(runs.hasNextPage),
        loadingMore: runs.isFetchingNextPage,
      }}
      schedule={schedule.data ?? null}
      startFailed={startFailed}
      starting={starting}
      state={state}
      status={status.data ?? null}
    />
  );
}

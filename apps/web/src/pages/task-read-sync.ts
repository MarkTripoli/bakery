import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useBakeryApi } from "../api/context.tsx";
import {
  createDurableTaskSyncState,
  type DurableSyncConnectivity,
  pollDurableTaskSync,
} from "../api/durable-sync.ts";
import { useConnectivity } from "../app/connectivity.ts";
import { useProtectedScope } from "../app/query-scope-context.tsx";

/** Events invalidate scoped reads; only their server responses render state. */
export function useTaskReadSync(taskId: string, runId: string | null) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const cache = useQueryClient();
  const currentRun = useRef(runId);
  useEffect(() => {
    currentRun.current = runId;
  }, [runId]);
  const [connectivity, setConnectivity] = useState<DurableSyncConnectivity>(
    "unknown",
  );
  const browser = useConnectivity();
  const priorBrowser = useRef(browser);
  const onBrowser = useRef<(next: typeof browser) => void>(() => {});
  useEffect(() => {
    // Only a change in the browser's connectivity reaches the poller.
    if (priorBrowser.current === browser) return;
    priorBrowser.current = browser;
    onBrowser.current(browser);
  }, [browser]);
  useEffect(() => {
    if (!scope.organizationId) return;
    const abort = new AbortController();
    let state = createDurableTaskSyncState({
      sessionGeneration: scope.sessionGeneration,
      organizationId: scope.organizationId,
      taskId,
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let running = false;
    setConnectivity("unknown");
    const poll = async () => {
      if (running || abort.signal.aborted) return;
      clearTimeout(timer);
      if (!navigator.onLine) {
        setConnectivity("offline");
        return;
      }
      running = true;
      const hadSnapshot = state.hasSnapshot;
      try {
        const result = await pollDurableTaskSync({
          client: api,
          state,
          signal: abort.signal,
          isCurrent: () => !abort.signal.aborted,
        });
        if (abort.signal.aborted) return;
        state = result.state;
        setConnectivity(state.connectivity);
        if (
          (!hadSnapshot && state.hasSnapshot) || result.resetPerformed ||
          result.invalidationEventIds.length > 0
        ) {
          await cache.invalidateQueries({
            predicate: ({ queryKey: key }) => {
              if (
                key[0] !== "protected" || key[1] !== scope.sessionGeneration ||
                key[2] !== scope.organizationId
              ) return false;
              const input = key[4];
              if (typeof input !== "object" || input === null) return false;
              return ("id" in input && input.id === taskId) ||
                ("taskId" in input && input.taskId === taskId) ||
                (currentRun.current !== null && "runId" in input &&
                  input.runId === currentRun.current);
            },
          });
        }
      } catch {
        if (!abort.signal.aborted) setConnectivity("unknown");
      } finally {
        running = false;
        if (!abort.signal.aborted) timer = setTimeout(() => void poll(), 3000);
      }
    };
    onBrowser.current = (next) => {
      if (next === "offline") {
        setConnectivity("offline");
      } else {
        setConnectivity("reconnecting");
        void poll();
      }
    };
    void poll();
    return () => {
      abort.abort();
      clearTimeout(timer);
      onBrowser.current = () => {};
    };
  }, [
    api,
    cache,
    scope.sessionGeneration,
    scope.organizationId,
    taskId,
  ]);
  return connectivity;
}

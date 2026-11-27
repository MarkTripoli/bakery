import { useEffect, useRef, useState } from "react";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import type {
  ApiFailure,
  ConnectionCheck,
  IntegrationConnection,
  IntegrationResource,
} from "../../api/client.ts";
import { useBakeryApi } from "../../api/context.tsx";
import { integrationConnectionQueryOptions } from "../../api/query.ts";
import { failureStatus } from "../../app/async-state.ts";
import { usePagedFocus } from "../../app/focus.ts";
import type { ProtectedScope } from "../../app/query-scope.ts";
import {
  type CheckedHealth,
  isTicked,
  type SelectionChange,
  selectionChanges,
} from "./model.ts";
import { hasSetupPages } from "./providers/index.ts";

const REPOSITORY_PAGE = 100;

type ResourcePage = {
  readonly items: IntegrationResource[];
  readonly nextCursor: string | null;
};

export type SelectionStatus =
  | "idle"
  | "saving"
  | "stale"
  | "keepOne"
  | "failed";
export type SwitchStatus =
  | "idle"
  | "saving"
  | "noSelection"
  | "stale"
  | "failed";
export type CheckStatus =
  | "idle"
  | "checking"
  | "pending"
  | "rateLimited"
  | "timeout"
  | "failed";

/** What a "Check now" found, as far as the page shows it. */
export type CheckOutcome = {
  readonly health: CheckedHealth | null;
  /** The check could not reach the provider; the earlier health stands. */
  readonly faulted: boolean;
};

function problemReason(error: ApiFailure): string | null {
  return error.kind === "problem" ? error.problem.reason ?? null : null;
}

function outcomeOf(data: ConnectionCheck): CheckOutcome {
  return { health: data.health ?? null, faulted: data.fault !== null };
}

/**
 * One connection's repositories, the selection a person is editing, turning
 * the connection on or off, and its health check. A selection is saved one
 * change at a time, each under the connection's current version, because the
 * server has no bulk call and every change moves the version on.
 */
export function useConnectionActions(
  { connection, organizationId, scope, listKey, sessionGeneration }: {
    readonly connection: IntegrationConnection;
    readonly organizationId: string;
    readonly scope: ProtectedScope;
    /** The connections list's query key, invalidated after a change. */
    readonly listKey: readonly unknown[];
    readonly sessionGeneration: number;
  },
) {
  const api = useBakeryApi();
  const queryClient = useQueryClient();
  const connectionQuery = integrationConnectionQueryOptions(
    api,
    scope,
    connection.id,
  );
  const repositoriesKey = [...listKey, "resources", connection.id] as const;
  const repositories = useInfiniteQuery<
    ResourcePage,
    ApiFailure,
    { pages: ResourcePage[] },
    readonly unknown[],
    string | undefined
  >({
    queryKey: repositoriesKey,
    enabled: hasSetupPages(connection.provider),
    initialPageParam: undefined,
    queryFn: async ({ pageParam, signal }) => {
      const result = await api.integrationResources.list({
        organizationId,
        connectionId: connection.id,
        query: {
          kind: "repository",
          limit: REPOSITORY_PAGE,
          ...(pageParam === undefined ? {} : { cursor: pageParam }),
        },
        signal,
      });
      if (!result.ok) throw result.error;
      return {
        items: result.data.items,
        nextCursor: result.data.nextCursor ?? null,
      };
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    retry: false,
  });
  const resources = repositories.data?.pages.flatMap((page) => page.items) ??
    [];
  const paging = usePagedFocus("repositories", {
    pending: repositories.isFetching,
    failed: repositories.isError,
    rowCount: resources.length,
    hasMore: repositories.hasNextPage,
    rowSelector: 'input[name="repository"]',
  });

  const saved = resources.map((item) => ({
    id: item.id,
    selected: item.selected,
  }));
  // What a person has toggled since the list was read, and nothing else: a
  // repository loaded later keeps its saved state until they toggle it.
  const [toggled, setToggled] = useState<ReadonlySet<string>>(new Set());
  const effective: ReadonlySet<string> = new Set(
    saved.filter((item) => isTicked(item, toggled)).map((item) => item.id),
  );
  const changes: readonly SelectionChange[] = selectionChanges(saved, toggled);
  const [selectionStatus, setSelectionStatus] = useState<SelectionStatus>(
    "idle",
  );
  const [switchStatus, setSwitchStatus] = useState<SwitchStatus>("idle");
  const [checkStatus, setCheckStatus] = useState<CheckStatus>("idle");
  const [checked, setChecked] = useState<CheckOutcome | null>(null);

  const refreshConnection = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: listKey, exact: true }),
      queryClient.invalidateQueries({
        queryKey: connectionQuery.queryKey,
        exact: true,
      }),
    ]);
  };
  /** The connection's version right now: every change moves it on. */
  const currentVersion = async (): Promise<number> => {
    const fresh = await queryClient.fetchQuery({
      ...connectionQuery,
      staleTime: 0,
    });
    return fresh.version;
  };

  const toggle = (id: string) => {
    const next = new Set(toggled);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectionStatus("idle");
    setToggled(next);
  };
  const discard = () => {
    setSelectionStatus("idle");
    setToggled(new Set());
  };

  const saving = useRef(false);
  const saveSelection = async () => {
    if (saving.current || changes.length === 0) return;
    saving.current = true;
    setSelectionStatus("saving");
    let status: SelectionStatus = "idle";
    try {
      let version = await currentVersion();
      for (const change of changes) {
        const update = (current: number) =>
          api.integrationResources.update({
            organizationId,
            connectionId: connection.id,
            resourceId: change.id,
            input: { selected: change.selected },
            version: current,
            idempotencyKey: crypto.randomUUID(),
          });
        let result = await update(version);
        // The version moved on under us: read it once and send this change again.
        if (!result.ok && failureStatus(result.error) === 412) {
          version = await currentVersion();
          result = await update(version);
        }
        if (!result.ok) {
          const code = failureStatus(result.error);
          status = problemReason(result.error) === "no_selected_resource"
            ? "keepOne"
            : code === 409 || code === 412
            ? "stale"
            : "failed";
          break;
        }
        version += 1;
      }
    } catch {
      status = "failed";
    } finally {
      saving.current = false;
    }
    // Whatever happened, show what the server now holds.
    setToggled(new Set());
    setSelectionStatus(status);
    await Promise.all([repositories.refetch(), refreshConnection()]);
  };

  const switching = useRef(false);
  const setEnabled = async (enabled: boolean) => {
    if (switching.current) return;
    switching.current = true;
    setSwitchStatus("saving");
    try {
      const attempt = (version: number) =>
        api.integrationConnections.update({
          organizationId,
          id: connection.id,
          input: { enabled },
          version,
          idempotencyKey: crypto.randomUUID(),
        });
      let result = await attempt(connection.version);
      if (!result.ok && failureStatus(result.error) === 412) {
        result = await attempt(await currentVersion());
      }
      if (result.ok) {
        setSwitchStatus("idle");
        await refreshConnection();
        return;
      }
      const code = failureStatus(result.error);
      if (problemReason(result.error) === "no_selected_resource") {
        setSwitchStatus("noSelection");
        if (hasSetupPages(connection.provider)) void repositories.refetch();
      } else if (code === 409 || code === 412) {
        setSwitchStatus("stale");
        await refreshConnection();
      } else {
        setSwitchStatus("failed");
      }
    } catch {
      setSwitchStatus("failed");
    } finally {
      switching.current = false;
    }
  };

  const checking = useRef(false);
  const check = async () => {
    if (checking.current) return;
    checking.current = true;
    setCheckStatus("checking");
    try {
      const result = await api.integrationConnections.check({
        organizationId,
        id: connection.id,
        idempotencyKey: crypto.randomUUID(),
      });
      if (result.ok) {
        setChecked(outcomeOf(result.data));
        setCheckStatus("idle");
        // The check records health and the time on the connection.
        await refreshConnection();
        return;
      }
      const code = failureStatus(result.error);
      const reason = problemReason(result.error);
      setCheckStatus(
        reason === "connection_pending" || reason === "no_selected_resource"
          ? "pending"
          : code === 429
          ? "rateLimited"
          : code === 504
          ? "timeout"
          : "failed",
      );
      if (code === 409) await refreshConnection();
    } finally {
      checking.current = false;
    }
  };

  // The generation changed (sign-out or organization switch): drop results.
  useEffect(() => {
    setChecked(null);
    setCheckStatus("idle");
    setSwitchStatus("idle");
    setSelectionStatus("idle");
    setToggled(new Set());
  }, [sessionGeneration]);

  return {
    check,
    checked,
    checkStatus,
    changes,
    discard,
    paging,
    repositories,
    resources,
    saveSelection,
    selectionStatus,
    setEnabled,
    switchStatus,
    ticked: effective,
    toggle,
  };
}

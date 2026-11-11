import { useEffect, useRef, useState } from "react";
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type {
  ApiFailure,
  ConnectionCheck,
  IntegrationConnection,
  IntegrationResource,
} from "../api/client.ts";
import { useBakeryApi } from "../api/context.tsx";
import { effectiveAccessQueryOptions } from "../api/query.ts";
import { failureStatus, isForbiddenFailure } from "../app/async-state.ts";
import {
  clearGitHubConnectHandoff,
  saveGitHubConnectHandoff,
  takeGitHubConnectUrl,
} from "../app/github-connect-handoff.ts";
import * as organizationSelection from "../app/organization-selection.ts";
import { protectedQueryKey } from "../app/query-scope.ts";
import { useProtectedScope } from "../app/query-scope-context.tsx";
import { useRestoreOrganizationScope } from "../app/restore-organization.ts";
import {
  type CheckResult,
  type CheckStatus,
  CONNECTION_OUTCOMES,
  type ConnectionOutcome,
  ConnectionPanel,
  type ConnectStatus,
  type EnableStatus,
  OrganizationIntegrationsScreen,
  type OrganizationIntegrationsView,
} from "../screens/OrganizationIntegrationsScreen.tsx";
import { ShellActiveNavigation } from "../shell/shell-slots.tsx";
import { InSettings } from "../shell/SettingsShellSlots.tsx";

/** Query parameters the GitHub callbacks redirect with (server contract). */
export const CONNECTION_OUTCOME_PARAMETER = "githubConnection";
export const CONNECTION_ID_PARAMETER = "connectionId";
export const ORGANIZATION_INTEGRATIONS_PATH =
  "/settings/organization/integrations";

const REPOSITORY_PAGE = 100;

/** Narrows an untrusted query value to a known outcome; anything else is none. */
export function parseConnectionOutcome(
  value: unknown,
): ConnectionOutcome | undefined {
  return CONNECTION_OUTCOMES.find((outcome) => outcome === value);
}

/** Leaves the page for github.com; replaced so Back skips the spent hop. */
function leaveForGitHub(url: string) {
  globalThis.location.replace(url);
}

function problemReason(error: ApiFailure): string | null {
  return error.kind === "problem" ? error.problem.reason ?? null : null;
}

export function OrganizationIntegrationsPage(
  { outcome, connectionId }: {
    readonly outcome: ConnectionOutcome | null;
    readonly connectionId: string | null;
  },
) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  // The live session generation, read after an await: `scope` itself is the
  // render's snapshot and never changes under a pending request.
  const generation = useRef(scope.sessionGeneration);
  generation.current = scope.sessionGeneration;
  const navigate = useNavigate();
  useRestoreOrganizationScope();
  const restoring = organizationSelection.hasRemembered();
  const organizationId = scope.organizationId ??
    (restoring ? organizationSelection.remembered() : null);
  const scoped = { ...scope, organizationId };
  const access = useQuery({
    ...effectiveAccessQueryOptions(api, scoped),
    retry: false,
  });
  const canManage = access.data?.role === "admin";
  const connectionsKey = protectedQueryKey(
    scoped,
    "integrationConnections.list",
    {},
  );
  const connections = useQuery<IntegrationConnection[], ApiFailure>({
    queryKey: connectionsKey,
    queryFn: async ({ signal }) => {
      const items: IntegrationConnection[] = [];
      let cursor: string | undefined;
      do {
        const result = await api.integrationConnections.list({
          organizationId: organizationId ?? "",
          cursor,
          signal,
        });
        if (!result.ok) throw result.error;
        items.push(...result.data.items);
        cursor = result.data.nextCursor ?? undefined;
      } while (cursor);
      return items;
    },
    enabled: organizationId !== null,
    retry: false,
  });

  // A redirect that stops half way continues to GitHub's other step on its
  // own: install first, then authorize (or the reverse), never by hand.
  const [continuing, setContinuing] = useState(false);
  const continued = useRef(false);
  useEffect(() => {
    if (organizationId === null || continued.current) return;
    if (
      outcome !== "awaiting_authorization" &&
      outcome !== "awaiting_installation"
    ) {
      // Any other outcome ends the attempt; its links are useless now.
      if (outcome !== null) clearGitHubConnectHandoff();
      return;
    }
    continued.current = true;
    const next = takeGitHubConnectUrl(
      organizationId,
      outcome === "awaiting_authorization"
        ? "authorizationUrl"
        : "installationUrl",
    );
    if (next === null) return;
    setContinuing(true);
    leaveForGitHub(next);
  }, [organizationId, outcome]);

  const [connectStatus, setConnectStatus] = useState<ConnectStatus>("idle");
  const connecting = useRef(false);
  const connect = async () => {
    if (organizationId === null || connecting.current) return;
    connecting.current = true;
    try {
      setConnectStatus("starting");
      clearGitHubConnectHandoff();
      const started = scope.sessionGeneration;
      const result = await api.integrationAuthAttempts.create({
        organizationId,
        idempotencyKey: crypto.randomUUID(),
      });
      if (started !== generation.current) return;
      if (!result.ok) {
        setConnectStatus(
          problemReason(result.error) === "provider_unregistered"
            ? "unregistered"
            : "failed",
        );
        return;
      }
      const { authorizationUrl, installationUrl, expiresAt } = result.data;
      // Install first: GitHub hands the state to the Setup URL, and the page
      // continues to authorization when the setup redirect lands here. The
      // install link is kept for an OAuth callback that still finds no
      // installation (`awaiting_installation`).
      const saved = saveGitHubConnectHandoff({
        organizationId,
        expiresAt,
        authorizationUrl,
        installationUrl: installationUrl ?? null,
      });
      if (!installationUrl || !saved) {
        setConnectStatus(saved ? "failed" : "storageUnavailable");
        if (saved) clearGitHubConnectHandoff();
        return;
      }
      setConnectStatus("redirecting");
      leaveForGitHub(installationUrl);
    } finally {
      connecting.current = false;
    }
  };

  const dismissOutcome = () => {
    void navigate({
      to: ORGANIZATION_INTEGRATIONS_PATH,
      search: {},
      replace: true,
    });
  };

  const accessForbidden = access.isError && isForbiddenFailure(access.error);
  const view: OrganizationIntegrationsView = accessForbidden ||
      (connections.isError && isForbiddenFailure(connections.error))
    ? "forbidden"
    : connections.isError
    ? "error"
    : organizationId === null && !restoring
    ? "forbidden"
    : !connections.data
    ? "loading"
    : "ready";
  const items = connections.data ?? [];
  return (
    <>
      <ShellActiveNavigation id="settings" />
      <InSettings section="settings.connections.section">
        <OrganizationIntegrationsScreen
          canManage={canManage}
          connectStatus={connectStatus}
          continuing={continuing}
          empty={items.length === 0}
          onConnect={() => void connect()}
          onDismissOutcome={dismissOutcome}
          onReload={() => void connections.refetch()}
          outcome={outcome}
          view={view}
        >
          {organizationId !== null
            ? items.map((connection) => (
              <ConnectionContainer
                canManage={canManage}
                connection={connection}
                connectionsKey={connectionsKey}
                highlighted={connection.id === connectionId}
                key={connection.id}
                organizationId={organizationId}
                sessionGeneration={scope.sessionGeneration}
              />
            ))
            : null}
        </OrganizationIntegrationsScreen>
      </InSettings>
    </>
  );
}

type ResourcePage = {
  readonly items: IntegrationResource[];
  readonly nextCursor: string | null;
};

/** One connection's repositories, selection, enable and check. */
function ConnectionContainer(
  {
    connection,
    connectionsKey,
    organizationId,
    sessionGeneration,
    canManage,
    highlighted,
  }: {
    readonly connection: IntegrationConnection;
    readonly connectionsKey: readonly unknown[];
    readonly organizationId: string;
    readonly sessionGeneration: number;
    readonly canManage: boolean;
    readonly highlighted: boolean;
  },
) {
  const api = useBakeryApi();
  const queryClient = useQueryClient();
  const repositoriesKey = [
    ...connectionsKey,
    "resources",
    connection.id,
  ] as const;
  const repositories = useInfiniteQuery<
    ResourcePage,
    ApiFailure,
    { pages: ResourcePage[] },
    readonly unknown[],
    string | undefined
  >({
    queryKey: repositoriesKey,
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
  const [saving, setSaving] = useState<ReadonlySet<string>>(new Set());
  const [selectionFailure, setSelectionFailure] = useState<
    "stale" | "failed" | null
  >(null);
  const [enableStatus, setEnableStatus] = useState<EnableStatus>("idle");
  const [checkStatus, setCheckStatus] = useState<CheckStatus>("idle");
  const [check, setCheck] = useState<CheckResult | null>(null);
  const resources = repositories.data?.pages.flatMap((page) => page.items) ??
    [];

  const replaceResource = (updated: IntegrationResource) => {
    queryClient.setQueryData<{ pages: ResourcePage[] }>(
      repositoriesKey,
      (data) =>
        data && {
          ...data,
          pages: data.pages.map((page) => ({
            ...page,
            items: page.items.map((item) =>
              item.id === updated.id ? updated : item
            ),
          })),
        },
    );
  };
  const refreshConnections = () =>
    queryClient.invalidateQueries({ queryKey: connectionsKey, exact: true });

  const toggle = async (id: string, selected: boolean) => {
    const resource = resources.find((item) => item.id === id);
    if (!resource || saving.has(id)) return;
    setSaving((current) => new Set(current).add(id));
    setSelectionFailure(null);
    setEnableStatus("idle");
    const result = await api.integrationResources.update({
      organizationId,
      connectionId: connection.id,
      resourceId: id,
      input: { selected },
      version: resource.version,
      idempotencyKey: crypto.randomUUID(),
    });
    setSaving((current) => {
      const next = new Set(current);
      next.delete(id);
      return next;
    });
    if (result.ok) {
      replaceResource(result.data);
      // A selection change bumps the connection's version.
      void refreshConnections();
      return;
    }
    const status = failureStatus(result.error);
    setSelectionFailure(status === 409 || status === 412 ? "stale" : "failed");
    void repositories.refetch();
  };

  const enabling = useRef(false);
  const enable = async () => {
    if (enabling.current) return;
    enabling.current = true;
    setEnableStatus("saving");
    try {
      const attempt = (version: number) =>
        api.integrationConnections.update({
          organizationId,
          id: connection.id,
          input: { enabled: true },
          version,
          idempotencyKey: crypto.randomUUID(),
        });
      let result = await attempt(connection.version);
      // Selecting a repository moves the connection's version on; when the
      // list has not caught up yet, read it once and send the fresh version
      // if the connection is still waiting to be enabled.
      if (!result.ok && failureStatus(result.error) === 412) {
        await queryClient.refetchQueries({
          queryKey: connectionsKey,
          exact: true,
        });
        const current = queryClient.getQueryData<IntegrationConnection[]>(
          connectionsKey,
        )?.find((item) => item.id === connection.id);
        if (
          current?.status === "pending" &&
          current.version !== connection.version
        ) result = await attempt(current.version);
      }
      if (result.ok) {
        queryClient.setQueryData<IntegrationConnection[]>(
          connectionsKey,
          (items) =>
            items?.map((item) =>
              item.id === result.data.id ? result.data : item
            ),
        );
        setEnableStatus("idle");
        return;
      }
      const status = failureStatus(result.error);
      if (problemReason(result.error) === "no_selected_resource") {
        setEnableStatus("noSelection");
        void repositories.refetch();
      } else if (status === 409 || status === 412) {
        setEnableStatus("stale");
        void refreshConnections();
      } else {
        setEnableStatus("failed");
      }
    } finally {
      enabling.current = false;
    }
  };

  const checking = useRef(false);
  const runCheck = async () => {
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
        setCheck(checkResult(result.data));
        setCheckStatus("idle");
        // The check records health and lastCheckedAt on the connection.
        void refreshConnections();
        return;
      }
      const status = failureStatus(result.error);
      const reason = problemReason(result.error);
      setCheckStatus(
        reason === "connection_pending" || reason === "no_selected_resource"
          ? "pending"
          : status === 429
          ? "rateLimited"
          : status === 504
          ? "timeout"
          : "failed",
      );
      if (status === 409) void refreshConnections();
    } finally {
      checking.current = false;
    }
  };

  // The generation changed (sign-out or organization switch): drop results.
  useEffect(() => {
    setCheck(null);
    setCheckStatus("idle");
    setEnableStatus("idle");
    setSelectionFailure(null);
  }, [sessionGeneration]);

  return (
    <ConnectionPanel
      canManage={canManage}
      check={check}
      checkStatus={checkStatus}
      enableStatus={enableStatus}
      highlighted={highlighted}
      id={connection.id}
      label={connection.label}
      lastCheckedAt={connection.lastCheckedAt}
      onCheck={() => void runCheck()}
      onEnable={() => void enable()}
      repositories={{
        state: repositories.isError
          ? "error"
          : repositories.data
          ? "ready"
          : "loading",
        items: resources.map((item) => ({
          id: item.id,
          name: item.displayName,
          url: item.safeUrl,
          selected: item.selected,
          available: item.available,
          saving: saving.has(item.id),
        })),
        hasMore: repositories.hasNextPage,
        loadingMore: repositories.isFetchingNextPage,
        onLoadMore: () => void repositories.fetchNextPage(),
        onRetry: () => void repositories.refetch(),
        onToggle: (id, selected) => void toggle(id, selected),
        failure: selectionFailure,
      }}
      status={connection.status}
    />
  );
}

function checkResult(data: ConnectionCheck): CheckResult {
  return {
    healthy: data.healthy,
    health: data.health ?? null,
    checkedAt: data.checkedAt,
    capabilities: data.capabilities,
    faulted: data.fault !== null,
  };
}

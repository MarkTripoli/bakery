import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type { ApiFailure, IntegrationConnection } from "../api/client.ts";
import { useBakeryApi } from "../api/context.tsx";
import { effectiveAccessQueryOptions } from "../api/query.ts";
import { isForbiddenFailure } from "../app/async-state.ts";
import * as organizationSelection from "../app/organization-selection.ts";
import { protectedQueryKey } from "../app/query-scope.ts";
import { useProtectedScope } from "../app/query-scope-context.tsx";
import { useRestoreOrganizationScope } from "../app/restore-organization.ts";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { ShellActiveNavigation } from "../shell/shell-slots.tsx";
import { InSettings } from "../shell/SettingsShellSlots.tsx";
import {
  connectionPath,
  connectionTimeFormatter,
} from "./integrations/format.ts";
import {
  type ConnectionRow,
  type IntegrationsHomeState,
  IntegrationsHomeView,
} from "./integrations/IntegrationsHomeView.tsx";
import { connectionHealth } from "./integrations/model.ts";
import {
  CONNECTION_OUTCOMES,
  type ConnectionOutcome,
} from "./integrations/outcomes.ts";
import { useProviderConnect } from "./integrations/providers/index.ts";

/** Query parameters the GitHub callbacks redirect with (server contract). */
export const CONNECTION_OUTCOME_PARAMETER = "githubConnection";
export const CONNECTION_ID_PARAMETER = "connectionId";
export const ORGANIZATION_INTEGRATIONS_PATH =
  "/settings/organization/integrations";

/** Narrows an untrusted query value to a known outcome; anything else is none. */
export function parseConnectionOutcome(
  value: unknown,
): ConnectionOutcome | undefined {
  return CONNECTION_OUTCOMES.find((outcome) => outcome === value);
}

/** Outcomes that name a connection and belong on that connection's own page. */
const OUTCOMES_FOR_THE_CONNECTION = new Set<ConnectionOutcome>([
  "pending",
  "refreshed",
  "already_connected",
]);

/** The organization's integrations: what is connected and what can be added. */
export function OrganizationIntegrationsPage(
  { outcome, connectionId }: {
    readonly outcome: ConnectionOutcome | null;
    readonly connectionId: string | null;
  },
) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const navigate = useNavigate();
  const { locale, timeZone } = useI18n();
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
  const connections = useQuery<IntegrationConnection[], ApiFailure>({
    queryKey: protectedQueryKey(scoped, "integrationConnections.list", {}),
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
  const connectFlow = useProviderConnect({ organizationId, outcome });

  // A callback that names the connection it made or refreshed lands on that
  // connection's page, on its next unfinished step, with the outcome shown.
  useEffect(() => {
    if (
      outcome !== null && connectionId !== null &&
      OUTCOMES_FOR_THE_CONNECTION.has(outcome)
    ) {
      void navigate({
        to: "/settings/organization/integrations/$connectionId",
        params: { connectionId },
        search: { githubConnection: outcome },
        replace: true,
      });
    }
  }, [outcome, connectionId, navigate]);

  const items = connections.data ?? [];
  const rows: ConnectionRow[] = items.map((connection) => ({
    id: connection.id,
    provider: connection.provider,
    account: connection.label,
    health: connectionHealth(connection),
    lastCheckedAt: connection.lastCheckedAt,
  }));
  const accessForbidden = access.isError && isForbiddenFailure(access.error);
  const state: IntegrationsHomeState = accessForbidden ||
      (connections.isError && isForbiddenFailure(connections.error))
    ? "forbidden"
    : connections.isError
    ? "error"
    : organizationId === null && !restoring
    ? "forbidden"
    : !connections.data
    ? "loading"
    : "ready";

  const reconnect = (id: string) => {
    const connection = items.find((item) => item.id === id);
    // A removed connection cannot be refreshed; it is connected again.
    void connectFlow.connect(
      connection?.status === "revoked" ? {} : {
        reconnectConnectionId: id,
        returnPath: connectionPath(id),
      },
    );
  };

  return (
    <>
      <ShellActiveNavigation id="settings" />
      <InSettings section="settings.connections.section">
        <IntegrationsHomeView
          canManage={canManage}
          connectStatus={connectFlow.connectStatus}
          continuing={connectFlow.continuing}
          formatTime={connectionTimeFormatter(locale, timeZone)}
          onConnect={() => void connectFlow.connect()}
          onDismissOutcome={() =>
            void navigate({
              to: ORGANIZATION_INTEGRATIONS_PATH,
              search: {},
              replace: true,
            })}
          onOpen={(id) =>
            void navigate({
              to: "/settings/organization/integrations/$connectionId",
              params: { connectionId: id },
              search: {},
            })}
          onReconnect={reconnect}
          onReload={() => void connections.refetch()}
          outcome={outcome}
          rows={rows}
          state={state}
        />
      </InSettings>
    </>
  );
}

import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type { ApiFailure, IntegrationConnection } from "../api/client.ts";
import { useBakeryApi } from "../api/context.tsx";
import {
  effectiveAccessQueryOptions,
  installationSettingsQueryOptions,
} from "../api/query.ts";
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
import {
  providerLook,
  useOAuthConnect,
  useProviderConnect,
} from "./integrations/providers/index.ts";

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
  "connected",
  "pending",
  "refreshed",
  "already_connected",
]);

/** The organization's integrations: what is connected and what can be added. */
export function OrganizationIntegrationsPage(
  { outcome, outcomeProvider, connectionId, removedId }: {
    readonly removedId: string | null;
    readonly outcome: ConnectionOutcome | null;
    readonly outcomeProvider: string;
    readonly connectionId: string | null;
  },
) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const navigate = useNavigate();
  const { locale, timeZone, translate } = useI18n();
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
  const installation = useQuery({
    ...installationSettingsQueryOptions(api, scoped),
    enabled: canManage,
    retry: false,
  });
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
  const connectFlow = useProviderConnect({
    organizationId,
    outcome: outcomeProvider === "slack" ? null : outcome,
  });
  const oauthFlow = useOAuthConnect({ organizationId, provider: "slack" });

  // A callback that names the connection it made or refreshed lands on that
  // connection's page, on its next unfinished step, with the outcome shown.
  const landing = outcome !== null && connectionId !== null &&
    OUTCOMES_FOR_THE_CONNECTION.has(outcome);
  useEffect(() => {
    if (landing) {
      void navigate({
        to: "/settings/organization/integrations/$connectionId",
        params: { connectionId },
        search: outcomeProvider === "slack"
          ? { slackConnection: outcome }
          : { githubConnection: outcome },
        replace: true,
      });
    }
  }, [landing, outcome, outcomeProvider, connectionId, navigate]);

  const items = connections.data ?? [];
  const rows: ConnectionRow[] = items.map((connection) => ({
    id: connection.id,
    provider: connection.provider,
    account: connection.label,
    health: connectionHealth(connection),
    lastCheckedAt: connection.lastCheckedAt,
  }));
  const removed = items.find((item) =>
    item.id === removedId && item.status === "revoked"
  );
  const removedName = removed === undefined
    ? null
    : translate("settings.connections.other.title", {
      provider: providerLook(removed.provider, translate).name,
      account: removed.label,
    });
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
          canOpenInstallation={installation.isSuccess}
          removedName={removedName}
          onDismissRemoved={() =>
            void navigate({
              to: ORGANIZATION_INTEGRATIONS_PATH,
              search: {},
              replace: true,
            })}
          onConnect={() => void connectFlow.connect()}
          onConnectProvider={oauthFlow.connectFor}
          providerConnectStatus={oauthFlow.connectStatus}
          outcomeProvider={outcomeProvider}
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
          outcome={landing ? null : outcome}
          rows={rows}
          state={state}
        />
      </InSettings>
    </>
  );
}

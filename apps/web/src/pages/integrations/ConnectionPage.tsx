import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import * as UI from "@bakery/ui";
import type { ApiFailure, IntegrationConnection } from "../../api/client.ts";
import { useBakeryApi } from "../../api/context.tsx";
import {
  effectiveAccessQueryOptions,
  integrationConnectionQueryOptions,
} from "../../api/query.ts";
import { failureStatus, isForbiddenFailure } from "../../app/async-state.ts";
import * as organizationSelection from "../../app/organization-selection.ts";
import { protectedQueryKey } from "../../app/query-scope.ts";
import { useProtectedScope } from "../../app/query-scope-context.tsx";
import { useRestoreOrganizationScope } from "../../app/restore-organization.ts";
import { useI18n } from "../../i18n/I18nProvider.tsx";
import { SETTINGS_HOME } from "../../shell/breadcrumb-paths.ts";
import { ShellActiveNavigation, ShellSlot } from "../../shell/shell-slots.tsx";
import {
  ConnectionView,
  type ConnectionViewProps,
  type ConnectionViewState,
} from "./ConnectionView.tsx";
import { connectionPath, connectionTimeFormatter } from "./format.ts";
import {
  connectionHealth,
  type ConnectionStatus,
  permissionsOf,
  setupSteps,
} from "./model.ts";
import type { ConnectionOutcome } from "./outcomes.ts";
import { useConnectionActions } from "./use-connection.ts";
import {
  hasSetupPages,
  PROVIDER_IDENTITY,
  providerLook,
  useProviderConnect,
} from "./providers/index.ts";

const INTEGRATIONS_PATH = "/settings/organization/integrations";

/** One connection's own page. */
export function ConnectionPage(
  { connectionId, outcome }: {
    readonly connectionId: string;
    readonly outcome: ConnectionOutcome | null;
  },
) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  useRestoreOrganizationScope();
  const restoring = organizationSelection.hasRemembered();
  const organizationId = scope.organizationId ??
    (restoring ? organizationSelection.remembered() : null);
  const scoped = { ...scope, organizationId };
  const access = useQuery({
    ...effectiveAccessQueryOptions(api, scoped),
    retry: false,
  });
  const read = useQuery<IntegrationConnection, ApiFailure>({
    ...integrationConnectionQueryOptions(api, scoped, connectionId),
    retry: false,
  });
  const forbidden = (access.isError && isForbiddenFailure(access.error)) ||
    (read.isError && isForbiddenFailure(read.error)) ||
    (organizationId === null && !restoring);
  const state: ConnectionViewState = forbidden
    ? "forbidden"
    : read.isError
    ? failureStatus(read.error) === 404 ? "notFound" : "error"
    : !read.data
    ? "loading"
    : "ready";
  const canManage = access.data?.role === "admin";
  return (
    <>
      <ShellActiveNavigation id="settings" />
      {state === "ready" && read.data && organizationId !== null
        ? (
          <Loaded
            canManage={canManage}
            connection={read.data}
            organizationId={organizationId}
            outcome={outcome}
            scope={scoped}
          />
        )
        : (
          <Frame
            state={state}
            onReload={() => void read.refetch()}
          />
        )}
    </>
  );
}

/** Breadcrumbs for a connection's page: Settings, Integrations, this one. */
function Crumbs({ title }: { readonly title: string }) {
  const { translate } = useI18n();
  return (
    <ShellSlot name="breadcrumbs">
      <UI.Breadcrumbs
        aria-label={translate("shell.navigation.breadcrumb")}
        items={[
          {
            href: SETTINGS_HOME,
            label: translate("shell.states.settingsTitle"),
          },
          {
            href: INTEGRATIONS_PATH,
            label: translate("shell.navigation.organizationIntegrations"),
          },
          { label: title },
        ]}
      />
    </ShellSlot>
  );
}

const NOTHING: Omit<
  ConnectionViewProps,
  "state" | "onReload" | "formatTime"
> = {
  canManage: false,
  account: "",
  provider: PROVIDER_IDENTITY.slug,
  granted: null,
  status: "enabled",
  health: connectionHealth({ status: "enabled", lastCheckedAt: null }),
  steps: null,
  permissions: [],
  createdAt: "",
  lastCheckedAt: null,
  outcome: null,
  continuing: false,
  connectStatus: "idle",
  checkStatus: "idle",
  checkFaulted: false,
  switchStatus: "idle",
  repositories: {
    state: "loading",
    items: [],
    hasMore: false,
    loadingMore: false,
    changed: false,
    saving: false,
    status: "idle",
    onToggle: () => {},
    onSave: () => {},
    onDiscard: () => {},
    onLoadMore: () => {},
    onRetry: () => {},
  },
  onFix: () => {},
  onCheck: () => {},
  onTurnOn: () => {},
  onTurnOff: () => {},
  onDismissOutcome: () => {},
};

/** The page before there is a connection to show: loading, missing, forbidden, failed. */
function Frame(
  { state, onReload }: {
    readonly state: ConnectionViewState;
    readonly onReload: () => void;
  },
) {
  const { translate } = useI18n();
  return (
    <>
      <Crumbs title={translate("settings.connections.title")} />
      <ConnectionView
        {...NOTHING}
        formatTime={String}
        onReload={onReload}
        state={state}
      />
    </>
  );
}

function Loaded(
  { connection, canManage, organizationId, outcome, scope }: {
    readonly connection: IntegrationConnection;
    readonly canManage: boolean;
    readonly organizationId: string;
    readonly outcome: ConnectionOutcome | null;
    readonly scope: ReturnType<typeof useProtectedScope>;
  },
) {
  const navigate = useNavigate();
  const { locale, timeZone, translate } = useI18n();
  const listKey = protectedQueryKey(scope, "integrationConnections.list", {});
  const connectFlow = useProviderConnect({ organizationId, outcome });
  const actions = useConnectionActions({
    connection,
    listKey,
    organizationId,
    scope,
    sessionGeneration: scope.sessionGeneration,
  });
  const status: ConnectionStatus = connection.status;
  const health = connectionHealth(connection, actions.checked?.health ?? null);
  const saved = actions.resources.filter((item) => item.selected).length;
  const reconnect = () =>
    void connectFlow.connect(
      status === "revoked" ? {} : {
        reconnectConnectionId: connection.id,
        returnPath: connectionPath(connection.id),
      },
    );
  const repositories = actions.repositories;
  return (
    <>
      <Crumbs
        title={hasSetupPages(connection.provider)
          ? translate("settings.connections.row.title", {
            account: connection.label,
          })
          : translate("settings.connections.other.title", {
            provider: providerLook(connection.provider, translate).name,
            account: connection.label,
          })}
      />
      <ConnectionView
        account={connection.label}
        provider={connection.provider}
        granted={connection.grantedScopes}
        canManage={canManage}
        checkFaulted={actions.checked?.faulted ?? false}
        checkStatus={actions.checkStatus}
        connectStatus={connectFlow.connectStatus}
        continuing={connectFlow.continuing}
        createdAt={connection.createdAt}
        formatTime={connectionTimeFormatter(locale, timeZone)}
        health={health}
        lastCheckedAt={connection.lastCheckedAt}
        onCheck={() => void actions.check()}
        onDismissOutcome={() =>
          void navigate({
            to: "/settings/organization/integrations/$connectionId",
            params: { connectionId: connection.id },
            search: {},
            replace: true,
          })}
        onFix={() => {
          if (health.action === "turnOn") void actions.setEnabled(true);
          else reconnect();
        }}
        onReload={() => void repositories.refetch()}
        onTurnOff={() => void actions.setEnabled(false)}
        onTurnOn={() => void actions.setEnabled(true)}
        outcome={outcome}
        permissions={permissionsOf(connection.grantedScopes)}
        repositories={{
          state: repositories.isError
            ? "error"
            : repositories.data
            ? "ready"
            : "loading",
          items: actions.resources.map((item) => ({
            id: item.id,
            name: item.displayName,
            ticked: actions.ticked.has(item.id),
            available: item.available,
          })),
          hasMore: repositories.hasNextPage,
          loadingMore: repositories.isFetchingNextPage,
          changed: actions.changes.length > 0,
          saving: actions.selectionStatus === "saving",
          status: actions.selectionStatus,
          onToggle: actions.toggle,
          onSave: () => void actions.saveSelection(),
          onDiscard: actions.discard,
          onLoadMore: () => {
            actions.paging.ask();
            void repositories.fetchNextPage();
          },
          onRetry: () => {
            actions.paging.ask(repositories.data ? "more" : "first");
            void repositories.refetch();
          },
        }}
        state="ready"
        status={status}
        steps={hasSetupPages(connection.provider)
          ? setupSteps(connection, actions.repositories.data ? saved : null)
          : null}
        switchStatus={actions.switchStatus}
      />
    </>
  );
}

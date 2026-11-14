import { useMemo, useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import type { MessageKey } from "@bakery/i18n";
import * as UI from "@bakery/ui";
import type { AuditEventItem } from "../api/client.ts";
import { useBakeryApi } from "../api/context.tsx";
import { isForbiddenFailure } from "../app/async-state.ts";
import { usePagedFocus } from "../app/focus.ts";
import { protectedQueryKey } from "../app/query-scope.ts";
import { useProtectedScope } from "../app/query-scope-context.tsx";
import * as organizationSelection from "../app/organization-selection.ts";
import { useRestoreOrganizationScope } from "../app/restore-organization.ts";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { ShellActiveNavigation } from "../shell/shell-slots.tsx";
import { AuditExportRetention } from "./AuditExportRetention.tsx";

export type AuditScope = "organization" | "installation";

const PAGE_SIZE = 25;
const PERIODS = [7, 30, 90] as const;
type Period = (typeof PERIODS)[number];
const PERIOD_KEYS: Readonly<Record<Period, MessageKey>> = {
  7: "settings.audit.since.7",
  30: "settings.audit.since.30",
  90: "settings.audit.since.90",
};

const OPERATION_KEYS: Readonly<Record<string, MessageKey>> = {
  "organizations.create": "settings.audit.operation.organizations.create",
  "organizations.update": "settings.audit.operation.organizations.update",
  "organizationMemberships.create":
    "settings.audit.operation.organizationMemberships.create",
  "organizationMemberships.update":
    "settings.audit.operation.organizationMemberships.update",
  "organizationMemberships.delete":
    "settings.audit.operation.organizationMemberships.delete",
  "organizationInvitations.create":
    "settings.audit.operation.organizationInvitations.create",
  "organizationInvitations.cancel":
    "settings.audit.operation.organizationInvitations.cancel",
  "organizationInvitations.recipientAccept":
    "settings.audit.operation.organizationInvitations.recipientAccept",
  "organizationInvitations.recipientReject":
    "settings.audit.operation.organizationInvitations.recipientReject",
  "connectedClients.revoke": "settings.audit.operation.connectedClients.revoke",
  "accessBindings.create": "settings.audit.operation.accessBindings.create",
  "accessBindings.delete": "settings.audit.operation.accessBindings.delete",
  "userPreferences.update": "settings.audit.operation.userPreferences.update",
  "browserSessions.revoke": "settings.audit.operation.browserSessions.revoke",
  "browserSessions.revokeOthers":
    "settings.audit.operation.browserSessions.revokeOthers",
  "installationSettings.update":
    "settings.audit.operation.installationSettings.update",
  "installationAdministrators.create":
    "settings.audit.operation.installationAdministrators.create",
  "installationAdministrators.revoke":
    "settings.audit.operation.installationAdministrators.revoke",
  "scimConnection.create": "settings.audit.operation.scimConnection.create",
  "scimConnection.rotate": "settings.audit.operation.scimConnection.rotate",
  "scimConnection.revoke": "settings.audit.operation.scimConnection.revoke",
  "scimProvisioning.create": "settings.audit.operation.scimProvisioning.create",
  "scimProvisioning.update": "settings.audit.operation.scimProvisioning.update",
  "scimProvisioning.deactivate":
    "settings.audit.operation.scimProvisioning.deactivate",
  "scimProvisioning.delete": "settings.audit.operation.scimProvisioning.delete",
  "auth.password.change": "settings.audit.operation.auth.password.change",
  "auth.passkey.add": "settings.audit.operation.auth.passkey.add",
  "auth.passkey.delete": "settings.audit.operation.auth.passkey.delete",
  "auth.passkey.rename": "settings.audit.operation.auth.passkey.rename",
  "auth.twoFactor.enable": "settings.audit.operation.auth.twoFactor.enable",
  "auth.twoFactor.disable": "settings.audit.operation.auth.twoFactor.disable",
  "auth.twoFactor.regenerateBackupCodes":
    "settings.audit.operation.auth.twoFactor.regenerateBackupCodes",
  "auth.sso.provider.create":
    "settings.audit.operation.auth.sso.provider.create",
  "auth.sso.provider.update":
    "settings.audit.operation.auth.sso.provider.update",
  "auth.sso.provider.delete":
    "settings.audit.operation.auth.sso.provider.delete",
  "auth.sso.domain.verify": "settings.audit.operation.auth.sso.domain.verify",
  "auth.sso.enforcement.update":
    "settings.audit.operation.auth.sso.enforcement.update",
};

/** Actions each list can contain, for the filter; the server stores every other value too. */
const SCOPE_OPERATIONS: Readonly<Record<AuditScope, readonly string[]>> = {
  organization: [
    "organizations.create",
    "organizations.update",
    "organizationMemberships.create",
    "organizationMemberships.update",
    "organizationMemberships.delete",
    "organizationInvitations.create",
    "organizationInvitations.cancel",
    "organizationInvitations.recipientAccept",
    "organizationInvitations.recipientReject",
    "connectedClients.revoke",
    "accessBindings.create",
    "accessBindings.delete",
    "userPreferences.update",
    "auth.sso.provider.create",
    "auth.sso.provider.update",
    "auth.sso.provider.delete",
    "auth.sso.domain.verify",
    "auth.sso.enforcement.update",
    "scimConnection.create",
    "scimConnection.rotate",
    "scimConnection.revoke",
    "scimProvisioning.create",
    "scimProvisioning.update",
    "scimProvisioning.deactivate",
    "scimProvisioning.delete",
  ],
  installation: [
    "installationSettings.update",
    "installationAdministrators.create",
    "installationAdministrators.revoke",
    "browserSessions.revoke",
    "browserSessions.revokeOthers",
    "auth.password.change",
    "auth.passkey.add",
    "auth.passkey.delete",
    "auth.passkey.rename",
    "auth.twoFactor.enable",
    "auth.twoFactor.disable",
    "auth.twoFactor.regenerateBackupCodes",
  ],
};

const OUTCOME_KEYS: Readonly<Record<string, MessageKey>> = {
  succeeded: "settings.audit.outcome.succeeded",
  allowed: "settings.audit.outcome.allowed",
  denied: "settings.audit.outcome.denied",
  failed: "settings.audit.outcome.failed",
};

/**
 * `/settings/audit` (organization administrators) and `/installation/audit`
 * (installation administrators): the append-only audit trail, newest first,
 * filtered by action and period and read a page at a time through the
 * server's keyset cursor. The server decides who may read; a refusal clears
 * the table and shows the forbidden notice.
 */
export function AuditEventsPage({ scope: audience }: {
  readonly scope: AuditScope;
}) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const { translate, locale, timeZone } = useI18n();
  useRestoreOrganizationScope();
  const restoring = audience === "organization" &&
    organizationSelection.hasRemembered();
  const organizationId = scope.organizationId ??
    (restoring ? organizationSelection.remembered() : null);
  const [operation, setOperation] = useState("");
  const [period, setPeriod] = useState<Period>(30);
  // The lower bound moves only when the person changes the period, never on a
  // re-render, so the query key and the server cursor binding stay stable.
  const since = useMemo(
    () => new Date(Date.now() - period * 86_400_000).toISOString(),
    [period],
  );
  const query = {
    ...(operation ? { operation } : {}),
    since,
    limit: PAGE_SIZE,
  };
  const events = useInfiniteQuery({
    queryKey: protectedQueryKey(
      { ...scope, organizationId },
      audience === "organization"
        ? "auditEvents.list"
        : "installationAuditEvents.list",
      { operation, period },
    ),
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam, signal }) => {
      const input = { ...query, cursor: pageParam };
      const result = audience === "organization"
        ? await api.auditEvents.list({
          organizationId: organizationId ?? "",
          query: input,
          signal,
        })
        : await api.installationAuditEvents.list({ query: input, signal });
      if (!result.ok) throw result.error;
      return result.data;
    },
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: audience === "installation" || organizationId !== null,
    retry: false,
  });
  const forbidden = events.isError && isForbiddenFailure(events.error);
  const rows: AuditEventItem[] = events.isError
    ? []
    : events.data?.pages.flatMap((page) => page.items) ?? [];
  const paging = usePagedFocus("audit", {
    pending: events.isFetchingNextPage,
    failed: events.isFetchNextPageError,
    rowCount: rows.length,
    hasMore: events.hasNextPage,
  });
  const when = new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone,
  });
  const label = (key: Readonly<Record<string, MessageKey>>, id: string) =>
    key[id] ? translate(key[id]) : id;
  const notice = forbidden
    ? translate("settings.audit.forbidden")
    : events.isError
    ? translate("settings.audit.loadError")
    : events.isPending
    ? translate("settings.audit.loading")
    : undefined;
  return (
    <>
      <ShellActiveNavigation id="settings" />
      <UI.SettingsContent data-testid={`audit-${audience}`}>
        <UI.Heading level="page">
          {translate("settings.audit.title")}
        </UI.Heading>
        <UI.Text variant="muted">
          {translate(
            audience === "organization"
              ? "settings.audit.description.organization"
              : "settings.audit.description.installation",
          )}
        </UI.Text>
        {notice
          ? (
            <UI.AlertBanner tone={events.isError ? "error" : "information"}>
              {notice}
            </UI.AlertBanner>
          )
          : null}
        {forbidden ? null : (
          <>
            {audience === "organization" && organizationId
              ? <AuditExportRetention organizationId={organizationId} />
              : null}
            <form
              aria-label={translate("settings.audit.filters")}
              onSubmit={(event) => event.preventDefault()}
            >
              <UI.Combobox
                label={translate("settings.audit.filter.operation")}
                value={operation}
                onChange={(event) => setOperation(event.target.value)}
                options={[
                  {
                    value: "",
                    label: translate("settings.audit.filter.operation.all"),
                  },
                  ...SCOPE_OPERATIONS[audience].map((value) => ({
                    value,
                    label: label(OPERATION_KEYS, value),
                  })),
                ]}
              />
              <UI.Combobox
                label={translate("settings.audit.filter.since")}
                value={String(period)}
                onChange={(event) =>
                  setPeriod(Number(event.target.value) as Period)}
                options={PERIODS.map((value) => ({
                  value: String(value),
                  label: translate(PERIOD_KEYS[value]),
                }))}
              />
            </form>
            <div data-paged-list="audit">
              <UI.DataTable<AuditEventItem>
                caption={translate("settings.audit.table.caption")}
                columns={[
                  {
                    id: "when",
                    header: translate("settings.audit.column.when"),
                    cell: (row) => when.format(new Date(row.createdAt)),
                  },
                  {
                    id: "actor",
                    header: translate("settings.audit.column.actor"),
                    cell: (row) =>
                      row.principalId
                        ? row.principalId.slice(0, 8)
                        : translate("settings.audit.actor.system"),
                  },
                  {
                    id: "action",
                    header: translate("settings.audit.column.action"),
                    cell: (row) => label(OPERATION_KEYS, row.operation),
                  },
                  {
                    id: "target",
                    header: translate("settings.audit.column.target"),
                    cell: (row) => row.resourceId,
                  },
                  {
                    id: "outcome",
                    header: translate("settings.audit.column.outcome"),
                    cell: (row) => label(OUTCOME_KEYS, row.outcome),
                  },
                ]}
                emptyMessage={translate("settings.audit.empty")}
                error={translate("settings.audit.loadError")}
                getRowKey={(row) => row.id}
                rows={rows}
                state={events.isPending
                  ? "loading"
                  : events.isError
                  ? "error"
                  : rows.length === 0
                  ? "empty"
                  : "ready"}
                variant="table"
              />
            </div>
            {events.hasNextPage
              ? (
                <UI.Button
                  data-paged-more="audit"
                  data-paged-retry={events.isFetchNextPageError
                    ? "audit"
                    : undefined}
                  loading={events.isFetchingNextPage}
                  onClick={() => {
                    paging.ask();
                    void events.fetchNextPage();
                  }}
                  type="button"
                >
                  {translate("settings.audit.loadMore")}
                </UI.Button>
              )
              : null}
          </>
        )}
      </UI.SettingsContent>
    </>
  );
}

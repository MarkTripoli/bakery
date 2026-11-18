import { useId, useMemo, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import type { MessageKey } from "@bakery/i18n";
import * as UI from "@bakery/ui";
import type { AuditEventItem } from "../api/client.ts";
import { useBakeryApi } from "../api/context.tsx";
import { isForbiddenFailure } from "../app/async-state.ts";
import { focusAfterPaint, usePagedFocus } from "../app/focus.ts";
import { organizationQueryOptions } from "../api/query.ts";
import { protectedQueryKey } from "../app/query-scope.ts";
import { useProtectedScope } from "../app/query-scope-context.tsx";
import * as organizationSelection from "../app/organization-selection.ts";
import { useRestoreOrganizationScope } from "../app/restore-organization.ts";
import { useShellViewport } from "../app/responsive.ts";
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

/** The kind a row's resource type is shown as; an unlisted type is spelled out from its name. */
const KIND_KEYS: Readonly<Record<string, MessageKey>> = {
  organization: "settings.audit.kind.organization",
  organization_membership: "settings.audit.kind.organization_membership",
  organization_invitation: "settings.audit.kind.organization_invitation",
  browser_session: "settings.audit.kind.browser_session",
  oauth_client: "settings.audit.kind.oauth_client",
  audit_retention: "settings.audit.kind.audit_retention",
  installation_settings: "settings.audit.kind.installation_settings",
  agent_definition: "settings.audit.kind.agent_definition",
  agent_version: "settings.audit.kind.agent_version",
};

/** "organization_role" -> "Organization role", for a type no one has worded yet. */
function spellOut(resourceType: string): string {
  const words = resourceType.replaceAll("_", " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** A long identifier shortened to its first eight characters; short ones stay whole. */
function shortId(id: string): string {
  return id.length > 12 ? id.slice(0, 8) : id;
}

const DEFAULT_PERIOD = 30;

/**
 * `/settings/audit` (organization administrators) and `/installation/audit`
 * (installation administrators): the append-only audit trail, newest first,
 * filtered by action and period and read a page at a time through the
 * server's keyset cursor. People and things are shown by name where this page
 * knows the name, and by kind and a short identifier where it does not. The
 * server decides who may read; a refusal clears the table and shows the
 * forbidden notice.
 */
export function AuditEventsPage({ scope: audience }: {
  readonly scope: AuditScope;
}) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const { translate, locale, timeZone } = useI18n();
  useRestoreOrganizationScope();
  const headingId = useId();
  const phone = useShellViewport() === "phone";
  const restoring = audience === "organization" &&
    organizationSelection.hasRemembered();
  const organizationId = scope.organizationId ??
    (restoring ? organizationSelection.remembered() : null);
  const [operation, setOperation] = useState("");
  const [period, setPeriod] = useState<Period>(DEFAULT_PERIOD);
  const [selected, setSelected] = useState<AuditEventItem | null>(null);
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
  // Names for the people and the organization a row mentions. Neither read is
  // needed to show the list, so a failure of either leaves short identifiers.
  const members = useQuery({
    queryKey: protectedQueryKey(
      { ...scope, organizationId },
      "principals.list",
      {},
    ),
    queryFn: async ({ signal }) => {
      const result = await api.principals.list({
        organizationId: organizationId ?? "",
        signal,
      });
      if (!result.ok) throw result.error;
      return result.data;
    },
    enabled: audience === "organization" && organizationId !== null &&
      !forbidden,
    retry: false,
  });
  const organization = useQuery({
    ...organizationQueryOptions(api, { ...scope, organizationId }),
    enabled: audience === "organization" && organizationId !== null,
    retry: false,
  });
  const retention = useQuery({
    queryKey: protectedQueryKey(
      { ...scope, organizationId },
      "auditRetention.get",
      {},
    ),
    queryFn: async ({ signal }) => {
      const result = await api.auditRetention.get({
        organizationId: organizationId ?? "",
        signal,
      });
      if (!result.ok) throw result.error;
      return result.data;
    },
    enabled: audience === "organization" && organizationId !== null &&
      !forbidden,
    retry: false,
  });
  const people = useMemo(
    () =>
      new Map(
        (members.data?.items ?? []).map((
          member,
        ) => [member.id, member] as const),
      ),
    [members.data],
  );
  const rows: AuditEventItem[] = events.isError
    ? []
    : events.data?.pages.flatMap((page) => page.items) ?? [];
  const paging = usePagedFocus("audit", {
    pending: events.isFetchingNextPage,
    failed: events.isFetchNextPageError,
    rowCount: rows.length,
    hasMore: events.hasNextPage,
    rowSelector: phone ? '[role="listitem"]' : undefined,
  });
  const when = new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone,
  });
  const whenFull = new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "long",
    timeZone,
  });
  const label = (key: Readonly<Record<string, MessageKey>>, id: string) =>
    key[id] ? translate(key[id]) : id;

  /** A person, a service account or the system, by name; never a bare identifier. */
  const actorOf = (row: AuditEventItem) => {
    if (!row.principalId) {
      return { name: translate("settings.audit.actor.system"), detail: null };
    }
    const person = people.get(row.principalId);
    if (!person) {
      return {
        name: translate("settings.audit.actor.unknown"),
        detail: shortId(row.principalId),
      };
    }
    return {
      name: person.displayName,
      detail: person.principalType === "human"
        ? null
        : translate("settings.audit.actor.serviceAccount"),
    };
  };
  /** The kind and the name of what changed; the kind and a short identifier when the name is not known. */
  const targetOf = (row: AuditEventItem) => {
    const kind = KIND_KEYS[row.resourceType]
      ? translate(KIND_KEYS[row.resourceType])
      : spellOut(row.resourceType);
    const known = people.get(row.resourceId)?.displayName ??
      (row.resourceId === organizationId ? organization.data?.name : undefined);
    return { kind, name: known ?? null, id: shortId(row.resourceId) };
  };

  const filtered = operation !== "" || period !== DEFAULT_PERIOD;
  const clearFilters = () => {
    setOperation("");
    setPeriod(DEFAULT_PERIOD);
  };
  const retry = () => {
    void events.refetch().then((result) => {
      // After a successful retry focus goes to the heading, the page's start.
      if (result.isSuccess) {
        focusAfterPaint(() => document.getElementById(headingId));
      }
    });
  };
  const showTable = !events.isError && !(
    !events.isPending && rows.length === 0
  );
  return (
    <>
      <ShellActiveNavigation id="settings" />
      <UI.SettingsContent data-testid={`audit-${audience}`}>
        <UI.Heading id={headingId} level="page" tabIndex={-1}>
          {translate("settings.audit.title")}
        </UI.Heading>
        <UI.Text variant="muted">
          {audience === "organization"
            ? translate("settings.audit.description.organization", {
              organization: organization.data?.name ??
                translate("settings.audit.thisOrganization"),
            })
            : translate("settings.audit.description.installation")}
        </UI.Text>
        {forbidden
          ? (
            <UI.AlertBanner tone="information">
              {translate("settings.audit.forbidden")}
            </UI.AlertBanner>
          )
          : events.isPending
          ? (
            <UI.AlertBanner tone="information">
              {translate("settings.audit.loading")}
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
              <UI.Inline gap="compact">
                <UI.Combobox
                  appearance="filter"
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
                  appearance="filter"
                  label={translate("settings.audit.filter.since")}
                  value={String(period)}
                  onChange={(event) =>
                    setPeriod(Number(event.target.value) as Period)}
                  options={PERIODS.map((value) => ({
                    value: String(value),
                    label: translate(PERIOD_KEYS[value]),
                  }))}
                />
                {retention.data?.retentionDays
                  ? (
                    <UI.HelpTip label={translate("settings.audit.help.label")}>
                      {translate("settings.audit.help.retention", {
                        days: retention.data.retentionDays,
                      })}
                    </UI.HelpTip>
                  )
                  : null}
              </UI.Inline>
            </form>
            {events.isError
              ? (
                <UI.ErrorState
                  action={
                    <UI.Button
                      loading={events.isRefetching}
                      onClick={retry}
                      type="button"
                      variant="secondary"
                    >
                      {translate("settings.audit.error.retry")}
                    </UI.Button>
                  }
                  description={translate("settings.audit.error.description")}
                  title={translate("settings.audit.error.title")}
                />
              )
              : null}
            {!events.isPending && !events.isError && rows.length === 0
              ? (
                <UI.EmptyState
                  action={filtered
                    ? (
                      <UI.Button
                        onClick={clearFilters}
                        type="button"
                        variant="secondary"
                      >
                        {translate("settings.audit.empty.clear")}
                      </UI.Button>
                    )
                    : undefined}
                  description={filtered
                    ? undefined
                    : translate("settings.audit.empty.none.description")}
                  title={translate(
                    filtered
                      ? "settings.audit.empty.filtered.title"
                      : "settings.audit.empty.none.title",
                  )}
                  variant={filtered ? "filtered" : "firstUse"}
                />
              )
              : null}
            {showTable && phone
              ? (
                <div
                  aria-label={translate("settings.audit.table.caption")}
                  data-paged-list="audit"
                  role="list"
                >
                  {rows.map((row) => {
                    const actor = actorOf(row);
                    const target = targetOf(row);
                    return (
                      <div key={row.id} role="listitem" tabIndex={-1}>
                        <UI.ListRow
                          controlLabel={translate("settings.audit.sheet.open", {
                            action: label(OPERATION_KEYS, row.operation),
                          })}
                          detail={[
                            actor.name,
                            target.name
                              ? `${target.kind} · ${target.name}`
                              : `${target.kind} · ${target.id}`,
                            when.format(new Date(row.createdAt)),
                          ].join(" · ")}
                          detailLines={2}
                          onSelect={() => setSelected(row)}
                          selected={selected?.id === row.id}
                          size="tall"
                          title={label(OPERATION_KEYS, row.operation)}
                          trailing={
                            <UI.Badge
                              tone={row.outcome === "failed" ||
                                  row.outcome === "denied"
                                ? "danger"
                                : "neutral"}
                            >
                              {label(OUTCOME_KEYS, row.outcome)}
                            </UI.Badge>
                          }
                        />
                      </div>
                    );
                  })}
                </div>
              )
              : null}
            {showTable && !phone
              ? (
                <div data-paged-list="audit">
                  <UI.DataTable<AuditEventItem>
                    caption={translate("settings.audit.table.caption")}
                    captionHidden
                    columns={[
                      {
                        id: "when",
                        header: translate("settings.audit.column.when"),
                        cell: (row) => when.format(new Date(row.createdAt)),
                      },
                      {
                        id: "actor",
                        header: translate("settings.audit.column.actor"),
                        cell: (row) => {
                          const actor = actorOf(row);
                          return (
                            <UI.Stack gap="none" title={row.principalId ?? ""}>
                              <span>{actor.name}</span>
                              {actor.detail
                                ? (
                                  <UI.DataText variant="code">
                                    {actor.detail}
                                  </UI.DataText>
                                )
                                : null}
                            </UI.Stack>
                          );
                        },
                      },
                      {
                        id: "action",
                        header: translate("settings.audit.column.action"),
                        cell: (row) => label(OPERATION_KEYS, row.operation),
                      },
                      {
                        id: "target",
                        header: translate("settings.audit.column.target"),
                        cell: (row) => {
                          const target = targetOf(row);
                          return (
                            <UI.Stack gap="none" title={row.resourceId}>
                              <span>
                                {target.kind}
                                {target.name ? ` · ${target.name}` : null}
                              </span>
                              {target.name ? null : (
                                <UI.DataText variant="code">
                                  {target.id}
                                </UI.DataText>
                              )}
                            </UI.Stack>
                          );
                        },
                      },
                      {
                        id: "outcome",
                        header: translate("settings.audit.column.outcome"),
                        cell: (row) => (
                          <UI.Badge
                            tone={row.outcome === "failed" ||
                                row.outcome === "denied"
                              ? "danger"
                              : "neutral"}
                          >
                            {label(OUTCOME_KEYS, row.outcome)}
                          </UI.Badge>
                        ),
                      },
                    ]}
                    emptyMessage=""
                    error=""
                    getRowKey={(row) => row.id}
                    onSelectRow={setSelected}
                    rows={rows}
                    selectedRowKey={selected?.id ?? null}
                    state={events.isPending ? "loading" : "ready"}
                    variant="table"
                  />
                </div>
              )
              : null}
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
        <UI.Sheet
          dismissLabel={translate("settings.audit.sheet.close")}
          onOpenChange={(open) => !open && setSelected(null)}
          open={selected !== null}
          title={translate("settings.audit.sheet.title")}
          variant="side"
        >
          {selected
            ? (
              <UI.DescriptionList data-testid="audit-event-detail">
                <UI.DescriptionItem
                  description={whenFull.format(new Date(selected.createdAt))}
                  title={translate("settings.audit.column.when")}
                />
                <UI.DescriptionItem
                  description={(() => {
                    const actor = actorOf(selected);
                    return actor.detail
                      ? `${actor.name} · ${actor.detail}`
                      : actor.name;
                  })()}
                  title={translate("settings.audit.column.actor")}
                />
                <UI.DescriptionItem
                  description={label(OPERATION_KEYS, selected.operation)}
                  title={translate("settings.audit.column.action")}
                />
                <UI.DescriptionItem
                  description={(() => {
                    const target = targetOf(selected);
                    return target.name
                      ? `${target.kind} · ${target.name}`
                      : `${target.kind} · ${selected.resourceId}`;
                  })()}
                  title={translate("settings.audit.column.target")}
                />
                <UI.DescriptionItem
                  description={label(OUTCOME_KEYS, selected.outcome)}
                  title={translate("settings.audit.column.outcome")}
                />
                <UI.DescriptionItem
                  description={
                    <UI.DataText variant="code">
                      {selected.requestId}
                    </UI.DataText>
                  }
                  title={translate("settings.audit.sheet.request")}
                />
                {Object.entries(selected.details ?? {}).map(([key, value]) => (
                  <UI.DescriptionItem
                    description={
                      <UI.DataText variant="code">
                        {typeof value === "string"
                          ? value
                          : JSON.stringify(value)}
                      </UI.DataText>
                    }
                    key={key}
                    title={key}
                  />
                ))}
              </UI.DescriptionList>
            )
            : null}
        </UI.Sheet>
      </UI.SettingsContent>
    </>
  );
}

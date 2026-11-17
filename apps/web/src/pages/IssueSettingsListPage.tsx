import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import * as UI from "@bakery/ui";
import { useBakeryApi } from "../api/context.tsx";
import {
  connectionRepositoriesQueryOptions,
  effectiveAccessQueryOptions,
  projectRepositoriesQueryOptions,
  ticketSourcesAllQueryOptions,
} from "../api/query.ts";
import { useConnectivity } from "../app/connectivity.ts";
import { useProtectedScope } from "../app/query-scope-context.tsx";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { sourceRows } from "./issue-sources.ts";
import {
  badgeOf,
  formOf,
  readAgeOf,
  type SourceBadge,
} from "./issues/settings-model.ts";

const BADGE_TONE: Record<
  SourceBadge,
  "success" | "warning" | "danger" | "neutral"
> = {
  working: "success",
  trouble: "warning",
  reconnecting: "danger",
  notReadYet: "neutral",
};

/**
 * `/issues/settings`: one row per connected repository, each linking to its
 * issue settings. A repository Bakery has never taken issues from offers "Set
 * up" instead of "Open". Administrators change the settings; everyone else
 * reads the list and is told who can change it.
 */
export function IssueSettingsListPage() {
  const { translate } = useI18n();
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const navigate = useNavigate();
  const offline = useConnectivity() === "offline";
  const repositories = useQuery(projectRepositoriesQueryOptions(api, scope));
  const connection = useQuery(
    connectionRepositoriesQueryOptions(api, scope, true),
  );
  const sources = useQuery(ticketSourcesAllQueryOptions(api, scope, true));
  const access = useQuery(effectiveAccessQueryOptions(api, scope));
  const isAdmin = access.data?.role === "admin";

  const rows = useMemo(
    () =>
      sourceRows(
        repositories.data?.items ?? [],
        connection.data?.resources ?? [],
        sources.data ?? [],
      ),
    [repositories.data, connection.data, sources.data],
  );
  const now = Date.now();
  const loading = repositories.isPending || sources.isPending ||
    connection.isPending;
  const failed = repositories.isError || sources.isError || connection.isError;

  return (
    <UI.Stack gap="spacious" data-testid="issue-settings-list">
      <UI.PageHeader
        flush
        title={translate("issues.settings.title")}
        subtitle={translate("issues.settings.description")}
        variant="list"
      />
      {isAdmin === false
        ? (
          <UI.InlineNotice tone="information">
            {translate("issues.settings.adminOnly")}
          </UI.InlineNotice>
        )
        : null}
      {loading ? <UI.Skeleton shape="row" /> : failed
        ? (
          <UI.ErrorState
            title={translate("issues.settings.error.title")}
            description={translate("issues.settings.error.description")}
            action={
              <UI.Button
                onClick={() => {
                  void repositories.refetch();
                  void sources.refetch();
                  void connection.refetch();
                }}
                type="button"
                variant="secondary"
              >
                {translate("issues.settings.error.retry")}
              </UI.Button>
            }
          />
        )
        : rows.length === 0
        ? (
          <UI.EmptyState
            title={translate("issues.settings.empty.title")}
            description={translate("issues.settings.empty.description")}
            action={isAdmin
              ? (
                <UI.Button
                  onClick={() =>
                    void navigate({
                      to: "/settings/organization/integrations",
                    })}
                  type="button"
                >
                  {translate("issues.settings.empty.open")}
                </UI.Button>
              )
              : undefined}
            variant="firstUse"
          />
        )
        : (
          <UI.Stack gap="compact" data-testid="issue-settings-rows">
            {rows.map((row) => {
              const form = formOf(row.source);
              const badge = badgeOf(row.source);
              const age = readAgeOf(row.source, now);
              const name = `${row.repository.owner}/${row.repository.name}`;
              return (
                <UI.Stack
                  data-testid="issue-settings-row"
                  gap="compact"
                  key={row.repository.id}
                >
                  <UI.Inline gap="standard" variant="between">
                    <UI.Stack gap="tight">
                      <UI.Text variant="strong">{name}</UI.Text>
                      <UI.Text variant="muted">
                        {form.enabled
                          ? translate("issues.settings.row.taking", {
                            label: form.start,
                            automatic: translate(
                              form.automatic
                                ? "issues.settings.row.automatic"
                                : "issues.settings.row.manual",
                            ),
                          })
                          : translate("issues.settings.row.notTaking")}
                      </UI.Text>
                    </UI.Stack>
                    <UI.Inline gap="compact">
                      <UI.Badge tone={BADGE_TONE[badge]}>
                        {translate(`issues.settings.badge.${badge}` as never)}
                      </UI.Badge>
                      {age === null ? null : (
                        <UI.Text variant="muted">
                          {age === "now"
                            ? translate("issues.settings.read.now")
                            : translate(
                              `issues.settings.read.${age.unit}` as never,
                              { count: age.count },
                            )}
                        </UI.Text>
                      )}
                      <UI.Button
                        disabled={offline}
                        onClick={() => {
                          if (row.source === null) {
                            // The Choose repositories sheet is where a
                            // repository first takes issues: it asks for the
                            // two labels a source cannot exist without.
                            void navigate({
                              to: "/issues",
                              search: { choose: true },
                            });
                            return;
                          }
                          void navigate({
                            to: "/issues/settings/$sourceId",
                            params: { sourceId: row.source.id },
                          });
                        }}
                        type="button"
                        variant={row.source === null ? "primary" : "secondary"}
                      >
                        {translate(
                          row.source === null
                            ? "issues.settings.row.setUp"
                            : "issues.settings.row.open",
                        )}
                      </UI.Button>
                    </UI.Inline>
                  </UI.Inline>
                </UI.Stack>
              );
            })}
          </UI.Stack>
        )}
    </UI.Stack>
  );
}

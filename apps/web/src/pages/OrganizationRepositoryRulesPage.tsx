import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import type { MessageKey, Translator } from "@bakery/i18n";
import * as UI from "@bakery/ui";
import type { OrganizationRepositoryRulesResponse } from "../api/client.ts";
import { useBakeryApi } from "../api/context.tsx";
import {
  organizationRepositoryRulesQueryOptions,
  organizationRepositoryRuleVersionsQueryOptions,
} from "../api/query.ts";
import { failureStatus, isForbiddenFailure } from "../app/async-state.ts";
import * as organizationSelection from "../app/organization-selection.ts";
import { useProtectedScope } from "../app/query-scope-context.tsx";
import { useShellViewport } from "../app/responsive.ts";
import { useRestoreOrganizationScope } from "../app/restore-organization.ts";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { ShellActiveNavigation, ShellSlot } from "../shell/shell-slots.tsx";

type Entry = OrganizationRepositoryRulesResponse["entries"][number];
type RuleKey = Entry["ruleKey"];

/** How many characters of a digest the page shows; the full value is the title. */
const DIGEST_CHARS = 8;

const RULE_NAME: Readonly<Record<RuleKey, MessageKey>> = {
  "commits.semantic": "settings.repositoryRules.rule.commits.semantic",
  "changeRequest.semanticTitle":
    "settings.repositoryRules.rule.changeRequest.semanticTitle",
  "changeRequest.description":
    "settings.repositoryRules.rule.changeRequest.description",
  "code.magicNumbers": "settings.repositoryRules.rule.code.magicNumbers",
  "code.magicStrings": "settings.repositoryRules.rule.code.magicStrings",
};

/** The one line under a rule's name: what it checks, from its options. */
function summarize(entry: Entry, translate: Translator): string {
  switch (entry.ruleKey) {
    case "commits.semantic":
      return translate(
        entry.options.range === "all_commits"
          ? "settings.repositoryRules.summary.commits.allCommits"
          : "settings.repositoryRules.summary.commits.finalSquash",
      );
    case "changeRequest.semanticTitle":
      return translate(
        entry.options.scope === "required"
          ? "settings.repositoryRules.summary.title.scopeRequired"
          : "settings.repositoryRules.summary.title.scopeOptional",
        { max: entry.options.maxSubjectLength },
      );
    case "changeRequest.description":
      return entry.options.requiredSections.length === 0
        ? translate("settings.repositoryRules.summary.description.none")
        : translate("settings.repositoryRules.summary.description", {
          sections: entry.options.requiredSections.join(", "),
        });
    case "code.magicNumbers":
      return entry.options.allowedNumbers.length === 0
        ? translate("settings.repositoryRules.summary.numbers.none")
        : translate("settings.repositoryRules.summary.numbers.allowed", {
          numbers: entry.options.allowedNumbers.join(", "),
        });
    case "code.magicStrings":
      return translate("settings.repositoryRules.summary.strings", {
        count: entry.options.allowedLiterals.length,
      });
  }
}

/** Enforcement as people read it: a switched-off rule is Off whatever its mode. */
function enforcementOf(entry: Entry): MessageKey {
  if (!entry.enabled) return "settings.repositoryRules.mode.off";
  return `settings.repositoryRules.mode.${entry.mode}`;
}

/**
 * An organization read the server refuses. Besides 403, the server answers a
 * person who may not read an organization's rules with the same 404 it gives a
 * foreign or unknown organization, so that nothing can be probed.
 */
function isRefusedRead(error: unknown): boolean {
  return isForbiddenFailure(error) || failureStatus(error) === 404;
}

/**
 * `/settings/organization/repository-rules`: the organization's published
 * repository rules baseline, rule by rule, and the history of its revisions.
 * Read only: the server decides who may read (administrators) and what the
 * baseline is; nothing here is policy of the page's own.
 */
export function OrganizationRepositoryRulesPage() {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const { translate, locale, timeZone } = useI18n();
  const phone = useShellViewport() === "phone";
  useRestoreOrganizationScope();
  const restoring = organizationSelection.hasRemembered();
  const organizationId = scope.organizationId ??
    (restoring ? organizationSelection.remembered() : null);
  const rulesScope = { ...scope, organizationId };

  const rules = useQuery(
    organizationRepositoryRulesQueryOptions(api, rulesScope),
  );
  const forbidden = rules.isError && isRefusedRead(rules.error);
  const versions = useInfiniteQuery({
    ...organizationRepositoryRuleVersionsQueryOptions(api, rulesScope),
    enabled: organizationId !== null && rules.isSuccess,
  });

  const when = new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone,
  });
  const data = rules.isSuccess ? rules.data : undefined;
  const waiting = !(organizationId === null && !restoring);
  const refusal = waiting && forbidden
    ? translate("settings.repositoryRules.forbidden")
    : null;
  // Rows already loaded stay on screen whatever a later read does.
  const history = versions.data?.pages.flatMap((page) => page.items) ?? [];
  const firstReadFailed = versions.isError && !versions.data;
  const moreFailed = versions.isFetchNextPageError;
  // A digest never wraps; the whole value is its title.
  const digestText = (value: string) => (
    <UI.DataText truncate title={value}>
      {value.slice(0, DIGEST_CHARS)}
    </UI.DataText>
  );

  return (
    <>
      <ShellActiveNavigation id="settings" />
      <ShellSlot name="breadcrumbs">
        <UI.Breadcrumbs
          aria-label={translate("shell.navigation.breadcrumb")}
          items={[
            { label: translate("settings.orgAccess.organization") },
            { label: translate("shell.navigation.repositoryRules") },
          ]}
        />
      </ShellSlot>
      <UI.SettingsContent data-testid="org-repository-rules">
        <UI.Stack gap="tight">
          <UI.Heading level="page">
            {translate("settings.repositoryRules.title")}
          </UI.Heading>
          <UI.Text variant="muted">
            {translate("settings.repositoryRules.description")}
          </UI.Text>
        </UI.Stack>
        {refusal
          ? <UI.AlertBanner tone="information">{refusal}</UI.AlertBanner>
          : null}
        {waiting && rules.isPending
          ? (
            <div
              aria-busy="true"
              aria-label={translate("settings.repositoryRules.loading")}
              data-testid="org-rules-loading"
              role="status"
            >
              <UI.Stack gap="compact">
                {[0, 1, 2, 3, 4].map((row) => (
                  <UI.Skeleton key={row} shape="row" />
                ))}
              </UI.Stack>
            </div>
          )
          : null}
        {waiting && rules.isError && !forbidden
          ? (
            <UI.ErrorState
              action={
                <UI.Button
                  loading={rules.isFetching}
                  onClick={() => void rules.refetch()}
                  type="button"
                >
                  {translate("core.actions.retry")}
                </UI.Button>
              }
              title={translate("settings.repositoryRules.loadError")}
            />
          )
          : null}
        {data
          ? (
            <>
              {data.revision === 0
                ? (
                  <UI.EmptyState
                    description={translate(
                      "settings.repositoryRules.empty.description",
                    )}
                    title={translate("settings.repositoryRules.empty.title")}
                  />
                )
                : (
                  <>
                    <UI.Text variant="muted" data-testid="org-rules-current">
                      {translate("settings.repositoryRules.current", {
                        revision: data.revision,
                        published: data.createdAt
                          ? when.format(new Date(data.createdAt))
                          : "",
                      })}
                    </UI.Text>
                    {phone
                      ? (
                        <div
                          role="list"
                          aria-label={translate(
                            "settings.repositoryRules.table.caption",
                          )}
                        >
                          {data.entries.map((row) => (
                            <div key={row.ruleKey} role="listitem">
                              <UI.ListRow
                                detail={summarize(row, translate)}
                                detailLines={2}
                                title={translate(RULE_NAME[row.ruleKey])}
                                trailing={translate(
                                  "settings.repositoryRules.enforcementAccess",
                                  {
                                    enforcement: translate(enforcementOf(row)),
                                    access: translate(
                                      row.locked
                                        ? "settings.repositoryRules.access.locked"
                                        : "settings.repositoryRules.access.override",
                                    ),
                                  },
                                )}
                              />
                            </div>
                          ))}
                        </div>
                      )
                      : (
                        <UI.DataTable<Entry>
                          caption={translate(
                            "settings.repositoryRules.table.caption",
                          )}
                          captionHidden
                          columns={[
                            {
                              id: "rule",
                              header: translate(
                                "settings.repositoryRules.column.rule",
                              ),
                              cell: (row) => (
                                <UI.Stack gap="tight">
                                  <UI.Text>
                                    {translate(RULE_NAME[row.ruleKey])}
                                  </UI.Text>
                                  <UI.Text
                                    lines={2}
                                    title={summarize(row, translate)}
                                    variant="muted"
                                  >
                                    {summarize(row, translate)}
                                  </UI.Text>
                                </UI.Stack>
                              ),
                            },
                            {
                              id: "enforcement",
                              header: translate(
                                "settings.repositoryRules.column.enforcement",
                              ),
                              cell: (row) => translate(enforcementOf(row)),
                            },
                            {
                              id: "access",
                              header: translate(
                                "settings.repositoryRules.column.access",
                              ),
                              cell: (row) =>
                                translate(
                                  row.locked
                                    ? "settings.repositoryRules.access.locked"
                                    : "settings.repositoryRules.access.override",
                                ),
                            },
                          ]}
                          emptyMessage={translate(
                            "settings.repositoryRules.empty.title",
                          )}
                          error={translate(
                            "settings.repositoryRules.loadError",
                          )}
                          getRowKey={(row) => row.ruleKey}
                          rows={data.entries}
                          state="ready"
                          variant="table"
                        />
                      )}
                    <UI.Heading level="section">
                      {translate("settings.repositoryRules.history.title")}
                    </UI.Heading>
                    {phone && versions.isPending
                      ? (
                        <div
                          aria-busy="true"
                          aria-label={translate(
                            "settings.repositoryRules.history.loading",
                          )}
                          data-testid="org-rules-history-loading"
                          role="status"
                        >
                          <UI.Stack gap="compact">
                            {[0, 1, 2].map((row) => (
                              <UI.Skeleton key={row} shape="row" />
                            ))}
                          </UI.Stack>
                        </div>
                      )
                      : firstReadFailed
                      ? (
                        <UI.ErrorState
                          action={
                            <UI.Button
                              loading={versions.isFetching}
                              onClick={() => void versions.refetch()}
                              type="button"
                            >
                              {translate("core.actions.retry")}
                            </UI.Button>
                          }
                          title={translate(
                            "settings.repositoryRules.history.loadError",
                          )}
                        />
                      )
                      : phone && history.length > 0
                      ? (
                        <div
                          role="list"
                          aria-label={translate(
                            "settings.repositoryRules.history.caption",
                          )}
                        >
                          {history.map((row) => (
                            <div key={row.id} role="listitem">
                              <UI.ListRow
                                detail={translate(
                                  "settings.repositoryRules.history.detail",
                                  {
                                    published: when.format(
                                      new Date(row.createdAt),
                                    ),
                                    count: row.entries.length,
                                  },
                                )}
                                title={translate(
                                  "settings.repositoryRules.history.revision",
                                  { revision: row.revision },
                                )}
                                trailing={digestText(row.digest)}
                              />
                            </div>
                          ))}
                        </div>
                      )
                      : (
                        <UI.DataTable<NonNullable<typeof history>[number]>
                          caption={translate(
                            "settings.repositoryRules.history.caption",
                          )}
                          captionHidden
                          columns={[
                            {
                              id: "revision",
                              header: translate(
                                "settings.repositoryRules.history.column.revision",
                              ),
                              cell: (row) => String(row.revision),
                            },
                            {
                              id: "published",
                              header: translate(
                                "settings.repositoryRules.history.column.published",
                              ),
                              cell: (row) =>
                                when.format(new Date(row.createdAt)),
                            },
                            {
                              id: "rules",
                              header: translate(
                                "settings.repositoryRules.history.column.rules",
                              ),
                              cell: (row) => String(row.entries.length),
                            },
                            {
                              id: "digest",
                              header: translate(
                                "settings.repositoryRules.history.column.digest",
                              ),
                              cell: (row) => digestText(row.digest),
                            },
                          ]}
                          emptyMessage={translate(
                            "settings.repositoryRules.history.empty",
                          )}
                          error={translate(
                            "settings.repositoryRules.history.loadError",
                          )}
                          getRowKey={(row) => row.id}
                          rows={history}
                          state={versions.isPending
                            ? "loading"
                            : history.length === 0
                            ? "empty"
                            : "ready"}
                          variant="table"
                        />
                      )}
                    {moreFailed
                      ? (
                        <UI.InlineNotice
                          action={
                            <UI.Button
                              loading={versions.isFetchingNextPage}
                              onClick={() => void versions.fetchNextPage()}
                              type="button"
                              variant="secondary"
                            >
                              {translate("core.actions.retry")}
                            </UI.Button>
                          }
                          tone="error"
                        >
                          {translate(
                            "settings.repositoryRules.history.loadMoreError",
                          )}
                        </UI.InlineNotice>
                      )
                      : versions.hasNextPage
                      ? (
                        <UI.Button
                          loading={versions.isFetchingNextPage}
                          onClick={() => void versions.fetchNextPage()}
                          type="button"
                        >
                          {translate(
                            "settings.repositoryRules.history.loadMore",
                          )}
                        </UI.Button>
                      )
                      : null}
                  </>
                )}
            </>
          )
          : null}
      </UI.SettingsContent>
    </>
  );
}

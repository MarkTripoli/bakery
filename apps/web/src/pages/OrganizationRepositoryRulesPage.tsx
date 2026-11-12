import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import type { MessageKey } from "@bakery/i18n";
import * as UI from "@bakery/ui";
import { useBakeryApi } from "../api/context.tsx";
import {
  organizationRepositoryRulesQueryOptions,
  organizationRepositoryRuleVersionsQueryOptions,
} from "../api/query.ts";
import { failureStatus, isForbiddenFailure } from "../app/async-state.ts";
import { useShellViewport } from "../app/responsive.ts";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { ShellActiveNavigation, ShellSlot } from "../shell/shell-slots.tsx";
import {
  accessOf,
  enforcementOf,
  RULE_KEYS,
  RULE_NAME,
  type RuleEntry,
  summarize,
} from "./repository-rules/presentation.ts";
import { useRulesDraft } from "./repository-rules/draft.ts";
import {
  focusAfterPaint,
  nextAfterConflict,
  pageHeading,
} from "./repository-rules/focus.ts";
import { LeaveGuard } from "./repository-rules/leave-guard.tsx";
import { ReviewPublishDialog } from "./repository-rules/ReviewPublishDialog.tsx";
import { useRulesScope } from "./repository-rules/use-rules-scope.ts";

/** How many characters of a digest the page shows; the full value is the title. */
const DIGEST_CHARS = 8;

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
  const { translate, locale, timeZone } = useI18n();
  const phone = useShellViewport() === "phone";
  const { organizationId, scope: rulesScope, waiting } = useRulesScope();

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
  const navigate = useNavigate();
  const drafts = useRulesDraft(rulesScope, data?.revision, data?.entries);
  const [discarding, setDiscarding] = useState(false);
  const [adding, setAdding] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  // The revision just published, until the banner is dismissed.
  const [published, setPublished] = useState<number | null>(null);
  // After a publish the heading takes focus: it replaces what the person was doing.
  useEffect(() => {
    if (published === null) return;
    const heading = document.querySelector<HTMLElement>(
      '[data-testid="org-repository-rules"] h1',
    );
    heading?.setAttribute("tabindex", "-1");
    heading?.focus();
  }, [published]);
  // A newer revision than the one the draft was made on: move the draft onto it.
  useEffect(() => {
    if (data && drafts.draft && drafts.draft.baseRevision !== data.revision) {
      drafts.rebase(data.revision, data.entries);
    }
  }, [data?.revision, drafts.draft?.baseRevision]);
  // The notice replaces what the person was doing, so it takes focus.
  const staleRevision = drafts.draft?.staleRevision ?? null;
  useEffect(() => {
    if (staleRevision === null) return;
    const notice = document.querySelector<HTMLElement>(
      '[data-testid="org-rules-stale"]',
    );
    notice?.setAttribute("tabindex", "-1");
    notice?.focus();
  }, [staleRevision]);
  // The rules as they would be once the draft is published.
  const shown = data ? drafts.entries : [];
  const changedKeys = new Set<string>(drafts.changed);
  const publishedBy = new Map(
    (data?.entries ?? []).map((entry) => [entry.ruleKey, entry]),
  );
  const missing = RULE_KEYS.filter((key) =>
    !shown.some((entry) => entry.ruleKey === key)
  );
  const openEditor = (ruleKey: string) =>
    void navigate({
      to: "/settings/organization/repository-rules/$ruleKey",
      params: { ruleKey },
    });
  /** What a changed cell used to say, as text, so the change never rests on colour. */
  const was = (row: RuleEntry, read: (entry: RuleEntry) => MessageKey) => {
    const before = publishedBy.get(row.ruleKey);
    if (!before || !changedKeys.has(row.ruleKey)) return null;
    if (read(before) === read(row)) return null;
    return (
      <UI.Text variant="muted">
        {translate("settings.repositoryRules.was", {
          value: translate(read(before)),
        })}
      </UI.Text>
    );
  };
  /** A rule on one line, for comparing two versions of it. */
  const describe = (entry: RuleEntry) =>
    [
      translate(enforcementOf(entry)),
      translate(accessOf(entry)),
      summarize(entry, translate),
    ].join(" · ");
  const editedBadge = (row: RuleEntry) =>
    changedKeys.has(row.ruleKey)
      ? <UI.Badge>{translate("settings.repositoryRules.edited")}</UI.Badge>
      : null;
  const addControl = data && missing.length > 0
    ? (
      <UI.Stack gap="tight">
        <UI.Inline>
          <UI.Button
            aria-expanded={adding}
            onClick={() => setAdding((open) => !open)}
            type="button"
            variant="outline"
          >
            {translate("settings.repositoryRules.add")}
          </UI.Button>
        </UI.Inline>
        <UI.Menu
          aria-label={translate("settings.repositoryRules.add.menu")}
          items={missing.map((key) => ({
            id: key,
            label: translate(RULE_NAME[key]),
          }))}
          onSelect={openEditor}
          open={adding}
        />
      </UI.Stack>
    )
    : null;
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
        {published !== null
          ? (
            <UI.AlertBanner onDismiss={() => setPublished(null)} tone="success">
              {translate("settings.repositoryRules.publish.done", {
                revision: published,
              })}
            </UI.AlertBanner>
          )
          : null}
        {drafts.draft && drafts.draft.staleRevision !== null
          ? (
            <UI.AlertBanner
              data-testid="org-rules-stale"
              onDismiss={() => drafts.acknowledge()}
              tone="warning"
            >
              <UI.Stack gap="tight">
                <UI.Text variant="strong">
                  {translate("settings.repositoryRules.stale.title", {
                    revision: drafts.draft.staleRevision,
                  })}
                </UI.Text>
                <UI.Text>
                  {translate("settings.repositoryRules.stale.body")}
                </UI.Text>
              </UI.Stack>
            </UI.AlertBanner>
          )
          : null}
        {drafts.draft && drafts.conflicts.length > 0
          ? (
            <UI.Stack data-testid="org-rules-conflicts">
              {drafts.conflicts.map((key) => {
                const mine = drafts.draft?.edited[key];
                const theirs = publishedBy.get(key);
                const name = translate(RULE_NAME[key]);
                const revision = drafts.draft?.baseRevision ?? 0;
                return (
                  <UI.Stack gap="tight" key={key}>
                    <UI.Inline>
                      <UI.Text variant="strong">{name}</UI.Text>
                      <UI.Badge>
                        {translate("settings.repositoryRules.stale.badge", {
                          revision,
                        })}
                      </UI.Badge>
                    </UI.Inline>
                    {mine && theirs
                      ? (
                        <UI.Text variant="muted">
                          {translate("settings.repositoryRules.stale.compare", {
                            mine: describe(mine),
                            revision,
                            theirs: describe(theirs),
                          })}
                        </UI.Text>
                      )
                      : null}
                    <UI.Inline>
                      <UI.Button
                        aria-label={translate(
                          "settings.repositoryRules.stale.useTheirs.named",
                          { revision, rule: name },
                        )}
                        onClick={() => {
                          drafts.resolve(key, "theirs");
                          focusAfterPaint(nextAfterConflict);
                        }}
                        type="button"
                        variant="secondary"
                      >
                        {translate("settings.repositoryRules.stale.useTheirs", {
                          revision,
                        })}
                      </UI.Button>
                      <UI.Button
                        aria-label={translate(
                          "settings.repositoryRules.stale.keepMine.named",
                          { rule: name },
                        )}
                        onClick={() => {
                          drafts.resolve(key, "mine");
                          focusAfterPaint(nextAfterConflict);
                        }}
                        type="button"
                        variant="secondary"
                      >
                        {translate("settings.repositoryRules.stale.keepMine")}
                      </UI.Button>
                    </UI.Inline>
                  </UI.Stack>
                );
              })}
            </UI.Stack>
          )
          : null}
        {shown.length > 0 ? addControl : null}
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
              {shown.length === 0
                ? (
                  <UI.EmptyState
                    description={translate(
                      "settings.repositoryRules.empty.description",
                    )}
                    title={translate("settings.repositoryRules.empty.title")}
                    action={addControl}
                  />
                )
                : (
                  <>
                    {data.revision > 0
                      ? (
                        <UI.Text
                          variant="muted"
                          data-testid="org-rules-current"
                        >
                          {translate("settings.repositoryRules.current", {
                            revision: data.revision,
                            published: data.createdAt
                              ? when.format(new Date(data.createdAt))
                              : "",
                          })}
                        </UI.Text>
                      )
                      : null}
                    {phone
                      ? (
                        <div
                          role="list"
                          aria-label={translate(
                            "settings.repositoryRules.table.caption",
                          )}
                        >
                          {shown.map((row) => (
                            <div key={row.ruleKey} role="listitem">
                              <UI.ListRow
                                controlLabel={translate(
                                  "settings.repositoryRules.edit.named",
                                  { rule: translate(RULE_NAME[row.ruleKey]) },
                                )}
                                detail={summarize(row, translate)}
                                detailLines={2}
                                onSelect={() =>
                                  openEditor(row.ruleKey)}
                                title={translate(RULE_NAME[row.ruleKey])}
                                trailing={
                                  <UI.Stack gap="tight">
                                    <UI.Inline>
                                      {editedBadge(row)}
                                      <span>
                                        {translate(
                                          "settings.repositoryRules.enforcementAccess",
                                          {
                                            enforcement: translate(
                                              enforcementOf(row),
                                            ),
                                            access: translate(
                                              row.locked
                                                ? "settings.repositoryRules.access.locked"
                                                : "settings.repositoryRules.access.override",
                                            ),
                                          },
                                        )}
                                      </span>
                                    </UI.Inline>
                                    {was(row, enforcementOf)}
                                    {was(row, accessOf)}
                                  </UI.Stack>
                                }
                              />
                            </div>
                          ))}
                        </div>
                      )
                      : (
                        <UI.DataTable<RuleEntry>
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
                                  <UI.Inline>
                                    <UI.Text>
                                      {translate(RULE_NAME[row.ruleKey])}
                                    </UI.Text>
                                    {editedBadge(row)}
                                  </UI.Inline>
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
                              cell: (row) => (
                                <UI.Stack gap="tight">
                                  <UI.Text>
                                    {translate(enforcementOf(row))}
                                  </UI.Text>
                                  {was(row, enforcementOf)}
                                </UI.Stack>
                              ),
                            },
                            {
                              id: "access",
                              header: translate(
                                "settings.repositoryRules.column.access",
                              ),
                              cell: (row) => (
                                <UI.Stack gap="tight">
                                  <UI.Text>{translate(accessOf(row))}</UI.Text>
                                  {was(row, accessOf)}
                                </UI.Stack>
                              ),
                            },
                            {
                              id: "actions",
                              header: translate(
                                "settings.repositoryRules.column.actions",
                              ),
                              cell: (row) => (
                                <UI.Button
                                  aria-label={translate(
                                    "settings.repositoryRules.edit.named",
                                    { rule: translate(RULE_NAME[row.ruleKey]) },
                                  )}
                                  onClick={() => openEditor(row.ruleKey)}
                                  type="button"
                                  variant="outline"
                                >
                                  {translate("settings.repositoryRules.edit")}
                                </UI.Button>
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
                          rows={shown}
                          state="ready"
                          variant="table"
                        />
                      )}
                    {data.revision > 0
                      ? (
                        <>
                          <UI.Heading level="section">
                            {translate(
                              "settings.repositoryRules.history.title",
                            )}
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
                                    onClick={() =>
                                      void versions.fetchNextPage()}
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
                      )
                      : null}
                  </>
                )}
            </>
          )
          : null}
        {drafts.count > 0 && drafts.draft
          ? (
            <UI.DraftBar
              detail={translate("settings.repositoryRules.draft.basis", {
                revision: drafts.draft.baseRevision,
              })}
              primaryAction={
                <UI.Button
                  data-testid="org-rules-review"
                  disabled={drafts.conflicts.length > 0}
                  onClick={() => setReviewing(true)}
                  type="button"
                >
                  {translate("settings.repositoryRules.draft.review")}
                </UI.Button>
              }
              secondaryAction={
                <UI.Button
                  onClick={() => setDiscarding(true)}
                  type="button"
                  variant="outline"
                >
                  {translate("settings.repositoryRules.draft.discard")}
                </UI.Button>
              }
              summary={translate("settings.repositoryRules.draft.summary", {
                count: drafts.count,
              })}
            />
          )
          : null}
        {drafts.draft
          ? (
            <ReviewPublishDialog
              baseRevision={drafts.draft.baseRevision}
              entries={drafts.entries}
              onOpenChange={setReviewing}
              onStale={() => setReviewing(false)}
              onPublished={(revision) => {
                setReviewing(false);
                drafts.discard();
                setPublished(revision);
              }}
              open={reviewing}
              scope={rulesScope}
            />
          )
          : null}
        <UI.AlertDialog
          cancelAction={
            <UI.Button
              onClick={() => setDiscarding(false)}
              type="button"
              variant="secondary"
            >
              {translate("settings.repositoryRules.draft.keepEditing")}
            </UI.Button>
          }
          confirmAction={
            <UI.Button
              onClick={() => {
                drafts.discard();
                setDiscarding(false);
                // The draft bar that held Discard is gone: start from the top of the page.
                focusAfterPaint(pageHeading);
              }}
              type="button"
              variant="destructive"
            >
              {translate("settings.repositoryRules.draft.discardConfirm")}
            </UI.Button>
          }
          onOpenChange={(open) => !open && setDiscarding(false)}
          open={discarding}
          title={translate("settings.repositoryRules.draft.discardTitle", {
            count: drafts.count,
          })}
          variant="destructive"
        >
          <UI.Text>
            {translate("settings.repositoryRules.draft.discardBody")}
          </UI.Text>
        </UI.AlertDialog>
        <LeaveGuard count={drafts.count} discard={drafts.discard} />
      </UI.SettingsContent>
    </>
  );
}

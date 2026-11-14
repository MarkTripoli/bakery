import { useEffect, useMemo, useState } from "react";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import * as UI from "@bakery/ui";
import { useBakeryApi } from "../api/context.tsx";
import {
  effectiveAccessQueryOptions,
  externalTicketsPagesQueryOptions,
  ticketSourcesListQueryOptions,
} from "../api/query.ts";
import { asyncKindForError, isForbiddenFailure } from "../app/async-state.ts";
import { usePagedFocus } from "../app/focus.ts";
import { useProtectedScope } from "../app/query-scope-context.tsx";
import { useNavigate } from "@tanstack/react-router";
import { useRestoreOrganizationScope } from "../app/restore-organization.ts";
import { useShellViewport } from "../app/responsive.ts";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { ShellActiveNavigation, ShellSlot } from "../shell/shell-slots.tsx";
import { IssuesList } from "./IssuesList.tsx";
import {
  ISSUE_FILTERS,
  type IssueFilter,
  issueMatchesFilter,
  issueSnapshot,
} from "./issue-state.ts";

/** Issues are read 25 at a time. */
const PAGE_SIZE = 25;

/** How long ago a time was, as the whole unit that fits: minutes, hours or days. */
function ageOf(
  then: string | null,
  now: number,
): { unit: "minute" | "hour" | "day"; count: number } | "now" | null {
  if (then === null) return null;
  const elapsed = now - Date.parse(then);
  if (!Number.isFinite(elapsed)) return null;
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return { unit: "minute", count: minutes };
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { unit: "hour", count: hours };
  return { unit: "day", count: Math.floor(hours / 24) };
}

/**
 * The GitHub issues Bakery has read for the organization, newest first, with
 * what can be started now by default. The list is the server's saved copy and
 * says how old it is; Refresh (administrators) asks the server to read GitHub
 * again.
 */
export function IssuesPage() {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { translate } = useI18n();
  useRestoreOrganizationScope();
  const phone = useShellViewport() === "phone";
  const [filter, setFilter] = useState<IssueFilter>("canStart");
  const [sourceId, setSourceId] = useState("");
  const [started, setStarted] = useState(false);

  const state = filter === "closed" ? "closed" : "open";
  const issues = useInfiniteQuery(
    externalTicketsPagesQueryOptions(api, scope, {
      sourceId: sourceId || undefined,
      state,
      limit: PAGE_SIZE,
    }),
  );
  const sources = useQuery(ticketSourcesListQueryOptions(api, scope));
  const access = useQuery(effectiveAccessQueryOptions(api, scope));
  const isAdmin = access.data?.role === "admin";

  const rows = useMemo(
    () => issues.data?.pages.flatMap((page) => page.items) ?? [],
    [issues.data],
  );
  const visible = rows.filter((row) => issueMatchesFilter(row, filter));
  const repositories = useMemo(() => {
    const seen = new Map<string, string>();
    for (const row of rows) {
      const name = issueSnapshot(row).repository;
      if (name && !seen.has(row.ticketSourceId)) {
        seen.set(row.ticketSourceId, name);
      }
    }
    return [...seen.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [rows]);

  const paging = usePagedFocus("issues", {
    pending: issues.isFetchingNextPage,
    failed: issues.isFetchNextPageError,
    rowCount: rows.length,
    hasMore: Boolean(issues.hasNextPage),
  });
  // A different organization means a different list.
  useEffect(() => setSourceId(""), [scope.organizationId]);

  const refresh = useMutation({
    mutationKey: ["ticketSources.sync"],
    mutationFn: async () => {
      const enabled = sources.data?.items.filter((source) => source.enabled) ??
        [];
      for (const source of enabled) {
        const result = await api.tickets.sync({
          organizationId: scope.organizationId as string,
          sourceId: source.id,
          idempotencyKey: crypto.randomUUID(),
        });
        if (!result.ok) throw result.error;
      }
    },
    onSuccess: () => {
      setStarted(true);
      void queryClient.invalidateQueries({ queryKey: ["protected"] });
    },
  });

  const lastSyncedAt = (sources.data?.items ?? [])
    .map((source) => source.lastSyncedAt)
    .filter((value): value is string => typeof value === "string")
    .sort()
    .at(-1) ?? null;
  const age = ageOf(lastSyncedAt, Date.now());
  const health = (sources.data?.items ?? []).map((source) => source.syncHealth);
  const trouble = health.includes("auth_required")
    ? "authRequired"
    : health.includes("degraded")
    ? "degraded"
    : null;

  // The page's one action: in the top bar on a wide screen, under the title on a
  // phone (the page header hides its actions on a wide one).
  const refreshButton = (
    <UI.Button
      variant="secondary"
      disabled={refresh.isPending}
      onClick={() => refresh.mutate()}
    >
      {translate("issues.refresh" as never)}
    </UI.Button>
  );
  const canRefresh = isAdmin && sources.isSuccess &&
    sources.data.items.length > 0;
  const forbidden = issues.isError && isForbiddenFailure(issues.error);
  const offline = issues.isError &&
    asyncKindForError(issues.error) === "offline";
  const noSources = sources.isSuccess && sources.data.items.length === 0;

  return (
    <>
      <ShellActiveNavigation id="issues" />
      {canRefresh && !phone
        ? <ShellSlot name="actions">{refreshButton}</ShellSlot>
        : null}
      <UI.Stack gap="spacious" data-testid="issues-page">
        <UI.PageHeader
          variant="list"
          title={translate("issues.title" as never)}
          subtitle={translate("issues.description" as never)}
          actions={canRefresh && phone ? refreshButton : null}
        />
        {started
          ? (
            <UI.InlineNotice tone="success">
              {translate("issues.refreshing" as never)}
            </UI.InlineNotice>
          )
          : null}
        {refresh.isError
          ? (
            <UI.InlineNotice tone="error">
              {translate("issues.refreshFailed" as never)}
            </UI.InlineNotice>
          )
          : null}
        {trouble !== null
          ? (
            <UI.AlertBanner
              tone={trouble === "authRequired" ? "error" : "warning"}
            >
              {translate(`issues.trouble.${trouble}` as never)}
            </UI.AlertBanner>
          )
          : null}
        {forbidden
          ? (
            <UI.EmptyState
              title={translate("issues.forbidden.title" as never)}
              description={translate("issues.forbidden.description" as never)}
              variant="firstUse"
            />
          )
          : noSources
          ? (
            <UI.EmptyState
              title={translate("issues.noSources.title" as never)}
              description={translate(
                (isAdmin
                  ? "issues.noSources.description"
                  : "issues.noSources.adminOnly") as never,
              )}
              action={isAdmin
                ? (
                  <UI.Button
                    variant="secondary"
                    onClick={() =>
                      void navigate({
                        to: "/settings/organization/integrations",
                      })}
                  >
                    {translate("issues.noSources.openIntegrations" as never)}
                  </UI.Button>
                )
                : undefined}
              variant="firstUse"
            />
          )
          : issues.isError && rows.length === 0
          ? (
            <UI.ErrorState
              title={translate(
                (offline
                  ? "issues.offline.title"
                  : "issues.error.title") as never,
              )}
              description={translate(
                (offline
                  ? "issues.offline.description"
                  : "issues.error.description") as never,
              )}
              action={
                <UI.Button
                  variant="secondary"
                  onClick={() => void issues.refetch()}
                >
                  {translate("issues.retry" as never)}
                </UI.Button>
              }
            />
          )
          : (
            <UI.Stack gap="standard">
              <UI.Inline gap="standard">
                <UI.SegmentedControl
                  aria-label={translate("issues.filter.label" as never)}
                  name="issue-filter"
                  variant="inline"
                  value={filter}
                  onChange={(value) => setFilter(value as IssueFilter)}
                  options={ISSUE_FILTERS.map((value) => ({
                    value,
                    label: translate(`issues.filter.${value}` as never),
                  }))}
                />
                {repositories.length > 1 || sourceId
                  ? (
                    <UI.ResourcePicker
                      label={translate("issues.filter.repository" as never)}
                      value={sourceId}
                      onChange={(event) => setSourceId(event.target.value)}
                      options={[
                        {
                          value: "",
                          label: translate(
                            "issues.filter.allRepositories" as never,
                          ),
                        },
                        ...repositories.map(([id, name]) => ({
                          value: id,
                          label: name,
                        })),
                      ]}
                    />
                  )
                  : null}
              </UI.Inline>
              {age !== null
                ? (
                  <UI.Text variant="muted">
                    {age === "now"
                      ? translate("issues.updatedNow" as never)
                      : translate("issues.updated" as never, {
                        age: translate(`issues.age.${age.unit}` as never, {
                          count: age.count,
                        }),
                      })}
                  </UI.Text>
                )
                : null}
              {visible.length === 0 && !issues.isPending
                ? (
                  <UI.EmptyState
                    title={translate(`issues.empty.${filter}.title` as never)}
                    description={translate(
                      `issues.empty.${filter}.description` as never,
                    )}
                    action={filter === "canStart"
                      ? (
                        <UI.Button
                          variant="secondary"
                          onClick={() => setFilter("open")}
                        >
                          {translate("issues.filter.open" as never)}
                        </UI.Button>
                      )
                      : undefined}
                    variant="firstUse"
                  />
                )
                : (
                  <div data-paged-list="issues">
                    <IssuesList
                      rows={visible}
                      loading={issues.isPending}
                      phone={phone}
                      translate={translate}
                    />
                  </div>
                )}
              {issues.isFetchNextPageError
                ? (
                  <UI.AlertBanner tone="error">
                    {translate("issues.pagination.error" as never)}
                  </UI.AlertBanner>
                )
                : null}
              {issues.hasNextPage
                ? (
                  <UI.Button
                    variant="secondary"
                    data-paged-more="issues"
                    data-paged-retry={issues.isFetchNextPageError
                      ? "issues"
                      : undefined}
                    disabled={issues.isFetchingNextPage}
                    onClick={() => {
                      paging.ask("more", rows.length);
                      void issues.fetchNextPage();
                    }}
                  >
                    {issues.isFetchingNextPage
                      ? translate("issues.pagination.loadingMore" as never)
                      : issues.isFetchNextPageError
                      ? translate("issues.retry" as never)
                      : translate("issues.pagination.loadMore" as never)}
                  </UI.Button>
                )
                : null}
            </UI.Stack>
          )}
      </UI.Stack>
    </>
  );
}

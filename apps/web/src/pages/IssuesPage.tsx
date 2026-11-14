import { useEffect, useMemo, useRef, useState } from "react";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import * as UI from "@bakery/ui";
import { useBakeryApi } from "../api/context.tsx";
import {
  connectionRepositoriesQueryOptions,
  effectiveAccessQueryOptions,
  externalTicketsPagesQueryOptions,
  ticketSourcesListQueryOptions,
} from "../api/query.ts";
import { asyncKindForError, isForbiddenFailure } from "../app/async-state.ts";
import { usePagedFocus } from "../app/focus.ts";
import { useProtectedScope } from "../app/query-scope-context.tsx";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useConnectivity } from "../app/connectivity.ts";
import { focusAfterPaint } from "../app/focus.ts";
import { useRestoreOrganizationScope } from "../app/restore-organization.ts";
import { useShellViewport } from "../app/responsive.ts";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { ShellActiveNavigation, ShellSlot } from "../shell/shell-slots.tsx";
import { IssuesList } from "./IssuesList.tsx";
import { ChooseRepositoriesSheet } from "./ChooseRepositoriesSheet.tsx";
import { IssuesTroubleBanner } from "./IssuesTroubleBanner.tsx";
import { type StartRefusal, StartWorkDialog } from "./StartWorkDialog.tsx";
import { StartWorkNotices } from "./StartWorkNotices.tsx";
import {
  ageOf,
  ISSUE_FILTERS,
  type IssueFilter,
  issueMatchesFilter,
  issueNumber,
  type IssueRow,
  issueSnapshot,
  startOffer,
  troubleOf,
} from "./issue-state.ts";

/** Issues are read 25 at a time. */
const PAGE_SIZE = 25;

/**
 * Can start and In progress are decided from each issue's saved check and
 * request, which the list route cannot filter on, so those views keep reading
 * pages while nothing matches, up to this many (200 issues), and then say so.
 */
const MAX_SEARCH_PAGES = 8;

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
  // The Choose repositories sheet: opened here, or by an issue that says its repository is off.
  const search = useSearch({ strict: false }) as { choose?: boolean };
  const [choosing, setChoosingOpen] = useState(search.choose === true);
  const chooser = useRef<HTMLElement | null>(null);
  const setChoosing = (open: boolean) => {
    if (open) {
      chooser.current = document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    }
    setChoosingOpen(open);
  };
  const [startFor, setStartFor] = useState<IssueRow | null>(null);
  // The row's Start work button that opened the confirmation.
  const opener = useRef<HTMLElement | null>(null);
  const [workStarted, setWorkStarted] = useState<number | null | false>(false);
  const [refusal, setRefusal] = useState<StartRefusal | null>(null);
  const offline = useConnectivity() === "offline";

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
  const searchable = filter === "canStart" || filter === "inProgress";
  const pagesRead = issues.data?.pages.length ?? 0;
  // Nothing matches yet but more pages exist: keep looking rather than say
  // "nothing" over a Load more button.
  const searching = searchable && visible.length === 0 &&
    issues.hasNextPage && !issues.isFetchNextPageError &&
    pagesRead < MAX_SEARCH_PAGES;
  // The search gave up at the page limit: say how far it looked.
  const searchedPartly = searchable && visible.length === 0 &&
    issues.hasNextPage && !searching && !issues.isPending;
  const fetchMore = issues.fetchNextPage;
  const fetchingMore = issues.isFetchingNextPage;
  useEffect(() => {
    if (searching && !fetchingMore) void fetchMore();
  }, [searching, fetchingMore, pagesRead, fetchMore]);
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
  const trouble = troubleOf(health);

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
  // Administrators also reach Choose repositories from a button beside Refresh.
  const moreMenu = isAdmin && sources.isSuccess
    ? (
      <UI.Button
        variant="secondary"
        disabled={offline}
        onClick={() => setChoosing(true)}
      >
        {translate("issues.choose.title" as never)}
      </UI.Button>
    )
    : null;
  const headerActions = canRefresh
    ? (
      <UI.Inline gap="compact">
        {refreshButton}
        {moreMenu}
      </UI.Inline>
    )
    : moreMenu;
  const sourceFor = (row: IssueRow) =>
    sources.data?.items.find((source) => source.id === row.ticketSourceId);
  // Start work is offered only where the answer is current: can start, GitHub
  // readable for that repository, and online.
  const startOffered = (row: IssueRow) => {
    const trouble = troubleOf(
      sourceFor(row) ? [sourceFor(row)!.syncHealth] : [],
    );
    return startOffer(row) === "start" && !offline &&
      trouble !== "authRequired" && trouble !== "degraded";
  };
  const forbidden = issues.isError && isForbiddenFailure(issues.error);
  const loadOffline = issues.isError &&
    asyncKindForError(issues.error) === "offline";
  const noSources = sources.isSuccess && sources.data.items.length === 0;
  const connection = useQuery(
    connectionRepositoriesQueryOptions(api, scope, isAdmin && noSources),
  );
  // Until it is read, an administrator is shown the choice, not a wrong dead end.
  const connected = !connection.isSuccess ||
    connection.data.connections.length > 0;

  return (
    <>
      <ShellActiveNavigation id="issues" />
      {headerActions !== null && !phone
        ? <ShellSlot name="actions">{headerActions}</ShellSlot>
        : null}
      <UI.Stack gap="spacious" data-testid="issues-page">
        <UI.PageHeader
          variant="list"
          flush
          title={translate("issues.title" as never)}
          subtitle={translate("issues.description" as never)}
          actions={headerActions !== null && phone ? headerActions : null}
        />
        {started
          ? (
            <UI.InlineNotice tone="success">
              {translate("issues.refreshing" as never)}
            </UI.InlineNotice>
          )
          : null}
        <StartWorkNotices
          number={workStarted === false ? null : workStarted}
          started={workStarted !== false}
          refusal={refusal}
          onDismiss={() => setRefusal(null)}
        />
        {refresh.isError
          ? (
            <UI.InlineNotice tone="error">
              {translate("issues.refreshFailed" as never)}
            </UI.InlineNotice>
          )
          : null}
        {trouble !== null
          ? (
            <IssuesTroubleBanner
              trouble={trouble}
              admin={isAdmin}
              refreshing={refresh.isPending}
              onRefresh={() => refresh.mutate()}
            />
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
              title={translate(
                (connected
                  ? "issues.noSources.title"
                  : "issues.noGithub.title") as never,
              )}
              description={translate(
                (!isAdmin
                  ? "issues.noSources.adminOnly"
                  : connected
                  ? "issues.noSources.description"
                  : "issues.noGithub.description") as never,
              )}
              action={isAdmin
                ? connected
                  ? (
                    <UI.Button
                      variant="primary"
                      disabled={offline}
                      onClick={() => setChoosing(true)}
                    >
                      {translate("issues.choose.title" as never)}
                    </UI.Button>
                  )
                  : (
                    <UI.Button
                      variant="secondary"
                      onClick={() =>
                        void navigate({
                          to: "/settings/organization/integrations",
                        })}
                    >
                      {translate("issues.noGithub.connect" as never)}
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
                (loadOffline
                  ? "issues.offline.title"
                  : "issues.error.title") as never,
              )}
              description={translate(
                (loadOffline
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
              {visible.length === 0 && !issues.isPending && searching
                ? (
                  <UI.Text variant="muted" role="status">
                    {translate(`issues.searching.${filter}` as never)}
                  </UI.Text>
                )
                : visible.length === 0 && !issues.isPending && searchedPartly
                ? (
                  <UI.InlineNotice tone="information">
                    {translate(`issues.partial.${filter}` as never)}
                  </UI.InlineNotice>
                )
                : visible.length === 0 && !issues.isPending
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
                      offered={startOffered}
                      onStart={(row) => {
                        opener.current = document.activeElement instanceof
                            HTMLElement
                          ? document.activeElement
                          : null;
                        setRefusal(null);
                        setWorkStarted(false);
                        setStartFor(row);
                      }}
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
      {startFor !== null
        ? (
          <StartWorkDialog
            intent="start"
            row={startFor}
            policyRevision={sourceFor(startFor)?.policyRevision ?? null}
            onClose={() => {
              setStartFor(null);
              // Cancel or Escape: back to the button that opened it.
              focusAfterPaint(() => opener.current);
            }}
            onDone={() => {
              setWorkStarted(issueNumber(startFor));
              setStartFor(null);
              focusAfterPaint(() =>
                document.querySelector<HTMLElement>("[data-start-notice]")
              );
            }}
            onRefused={(why) => {
              setRefusal(why);
              setStartFor(null);
              focusAfterPaint(() =>
                document.querySelector<HTMLElement>("[data-start-notice]")
              );
            }}
          />
        )
        : null}
      {choosing && isAdmin
        ? (
          <ChooseRepositoriesSheet
            onClose={() => {
              setChoosing(false);
              // Back to the control that opened the sheet.
              focusAfterPaint(() => chooser.current);
              if (search.choose) {
                void navigate({
                  to: "/issues",
                  search: { choose: undefined },
                  replace: true,
                });
              }
            }}
          />
        )
        : null}
    </>
  );
}

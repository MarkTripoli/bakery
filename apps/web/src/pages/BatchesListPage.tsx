import { useInfiniteQuery, useQueries } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import * as UI from "@bakery/ui";
import type { BatchResponse } from "../api/client.ts";
import { useBakeryApi } from "../api/context.tsx";
import {
  batchesListQueryOptions,
  externalTicketQueryOptions,
} from "../api/query.ts";
import { isForbiddenFailure } from "../app/async-state.ts";
import { useShellViewport } from "../app/responsive.ts";
import { useProtectedScope } from "../app/query-scope-context.tsx";
import { useSession } from "../app/session-context.tsx";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { ShellActiveNavigation, ShellSlot } from "../shell/shell-slots.tsx";
import {
  currentIssue,
  dollars,
  stateBadgeFor,
  waitingView,
  whyItEnded,
} from "./batches/batch-display.ts";
import { issueNumber, type IssueRow } from "./issue-state.ts";
import { say } from "./batches/say.ts";
import { BatchBreadcrumbs } from "./batches/BatchBreadcrumbs.tsx";
import { useBatchLookups } from "./batches/use-batch-lookups.ts";

/** Batches are read 25 at a time. */
const PAGE_SIZE = 25;
const BATCHES_PATH = "/issues/batches";
const NEW_BATCH_PATH = "/issues/batches/new";

/**
 * `/issues/batches`: one row per batch, newest first, for the whole
 * organization or one repository kept in the address.
 */
export function BatchesListPage() {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const { translate, locale } = useI18n();
  const navigate = useNavigate();
  const phone = useShellViewport() === "phone";
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const lookups = useBatchLookups();
  const readerPrincipalId = useSession().identity?.principalId ?? null;

  const repositoryId = typeof search.repository === "string" &&
      search.repository !== ""
    ? search.repository
    : null;
  const list = useInfiniteQuery(
    batchesListQueryOptions(api, scope, { repositoryId, limit: PAGE_SIZE }),
  );
  const batches = list.data?.pages.flatMap((page) => page.items) ?? [];
  const forbidden = list.isError && isForbiddenFailure(list.error);

  // A batch that waits for a person says which issue; its number is on the issue, so read the few that wait.
  const waitingBatches = batches.filter((batch) =>
    batch.state === "running" && waitingView(batch, readerPrincipalId) !== null
  );
  const waitingIssues = useQueries({
    queries: waitingBatches.map((batch) =>
      externalTicketQueryOptions(
        api,
        scope,
        currentIssue(batch)?.row.externalTicketId ?? "",
      )
    ),
  });
  const waitingNumber = (batch: BatchResponse): string | null => {
    const index = waitingBatches.findIndex((item) => item.id === batch.id);
    const row = index < 0
      ? undefined
      : (waitingIssues[index]?.data as IssueRow | undefined);
    const number = row === undefined ? null : issueNumber(row);
    return number === null ? null : String(number);
  };

  const open = (id: string) =>
    void navigate({ to: "/issues/batches/$batchId", params: { batchId: id } });
  const startBatch = () =>
    void navigate({
      to: NEW_BATCH_PATH,
      search: { repository: repositoryId ?? undefined },
    });
  const chooseRepository = (value: string) =>
    void navigate({
      to: BATCHES_PATH,
      search: { repository: value === "" ? undefined : value },
      replace: true,
    });

  const startButton = lookups.canControl
    ? (
      <UI.Button variant="primary" onClick={startBatch}>
        {translate("batches.start" as never)}
      </UI.Button>
    )
    : null;

  const repositoryLabel = (batch: BatchResponse) =>
    lookups.repositoryName(batch.repositoryId) ?? "—";
  const startedLine = (batch: BatchResponse) => {
    const name = lookups.personName(batch.startedBy);
    const when = lookups.time(batch.startedAt);
    return name === null
      ? when
      : translate("batches.cell.started" as never, { name, time: when });
  };
  const mergedText = (batch: BatchResponse) =>
    translate("batches.cell.of" as never, {
      done: batch.issuesDone,
      max: batch.maxIssues,
    });
  const spentText = (batch: BatchResponse) =>
    translate("batches.cell.of" as never, {
      done: lookups.money(dollars(batch.spentUsd)),
      max: lookups.money(dollars(batch.maxSpendUsd)),
    });
  const whyText = (batch: BatchResponse) => {
    const why = whyItEnded(batch, waitingNumber(batch));
    if (why === null) return "";
    // A reason starts the cell, so it starts with a capital.
    const text = say(translate, why);
    return text.charAt(0).toLocaleUpperCase(locale) + text.slice(1);
  };
  const stateBadge = (batch: BatchResponse) => {
    const badge = stateBadgeFor(batch, waitingView(batch, readerPrincipalId));
    return (
      <UI.Badge tone={badge.tone}>{translate(badge.key as never)}</UI.Badge>
    );
  };
  const openButton = (batch: BatchResponse) => (
    <UI.Button
      variant="secondary"
      aria-label={translate("batches.openBatch" as never, {
        repository: repositoryLabel(batch),
      })}
      onClick={() => open(batch.id)}
    >
      {translate("batches.open" as never)}
    </UI.Button>
  );
  const repositoryLink = (batch: BatchResponse) => (
    <UI.Link
      href={`${BATCHES_PATH}/${batch.id}`}
      onClick={(event) => {
        event.preventDefault();
        open(batch.id);
      }}
    >
      {repositoryLabel(batch)}
    </UI.Link>
  );

  const toolbar = (
    <UI.Inline gap="compact" variant="between">
      <UI.Combobox
        appearance="filter"
        label={translate("batches.list.repositoryLabel" as never)}
        value={repositoryId ?? ""}
        onChange={(event) => chooseRepository(event.target.value)}
        options={[
          {
            value: "",
            label: translate("batches.list.allRepositories" as never),
          },
          ...lookups.repositories.map((repository) => ({
            value: repository.id,
            label: repository.name,
          })),
        ]}
      />
      {list.isSuccess && batches.length > 0
        ? (
          <UI.Text variant="muted">
            {list.hasNextPage
              ? translate("batches.list.showing" as never, {
                shown: batches.length,
              })
              : translate("batches.list.count" as never, {
                count: batches.length,
              })}
          </UI.Text>
        )
        : null}
    </UI.Inline>
  );

  let body;
  if (forbidden) {
    body = (
      <UI.EmptyState
        variant="firstUse"
        title={translate("batches.forbidden.title" as never)}
        description={translate("batches.forbidden.description" as never)}
      />
    );
  } else if (list.isError) {
    body = (
      <UI.ErrorState
        variant="region"
        title={translate("batches.error.title" as never)}
        action={
          <UI.Button
            variant="secondary"
            onClick={() => void list.refetch()}
          >
            {translate("batches.retry" as never)}
          </UI.Button>
        }
      />
    );
  } else if (list.isPending) {
    body = (
      <UI.Stack
        gap="standard"
        role="list"
        aria-label={translate("batches.list.caption" as never)}
        aria-busy="true"
      >
        {[0, 1, 2].map((index) => (
          <div key={index} role="listitem">
            <UI.Skeleton shape="row" />
          </div>
        ))}
      </UI.Stack>
    );
  } else if (batches.length === 0) {
    body = (
      <UI.EmptyState
        variant="firstUse"
        title={translate("batches.empty.title" as never)}
        description={translate("batches.empty.description" as never)}
        action={startButton}
      />
    );
  } else if (phone) {
    body = (
      <UI.Stack
        gap="none"
        role="list"
        aria-label={translate("batches.list.caption" as never)}
      >
        {batches.map((batch) => (
          <div key={batch.id} role="listitem" data-batch-id={batch.id}>
            <UI.StackedRow
              titleLines="wrap"
              title={repositoryLink(batch)}
              status={stateBadge(batch)}
            >
              <UI.Text variant="caption">
                {translate("batches.list.phoneLine" as never, {
                  done: batch.issuesDone,
                  max: batch.maxIssues,
                  spent: lookups.money(dollars(batch.spentUsd)),
                  time: lookups.time(batch.startedAt),
                })}
              </UI.Text>
            </UI.StackedRow>
          </div>
        ))}
      </UI.Stack>
    );
  } else {
    body = (
      <UI.DataTable
        variant="ruled"
        inset="edge"
        rowSize="single"
        caption={translate("batches.list.caption" as never)}
        captionHidden
        rows={batches}
        getRowKey={(batch) => batch.id}
        getRowAttributes={(batch) => ({ "data-batch-id": batch.id })}
        columns={[
          {
            id: "repository",
            header: translate("batches.col.repository" as never),
            cell: repositoryLink,
          },
          {
            id: "state",
            header: translate("batches.col.state" as never),
            width: "132px",
            cell: stateBadge,
          },
          {
            id: "merged",
            header: translate("batches.col.merged" as never),
            width: "96px",
            cell: mergedText,
          },
          {
            id: "spent",
            header: translate("batches.col.spent" as never),
            width: "132px",
            cell: spentText,
          },
          {
            id: "started",
            header: translate("batches.col.started" as never),
            width: "220px",
            cell: startedLine,
          },
          {
            id: "why",
            header: translate("batches.col.why" as never),
            width: "220px",
            cell: (batch) => (
              <UI.Text variant={batch.state === "finished" ? "body" : "muted"}>
                {whyText(batch)}
              </UI.Text>
            ),
          },
          {
            id: "open",
            // The button says it; the heading is kept for screen readers only.
            header: (
              <UI.VisuallyHidden>
                {translate("batches.open" as never)}
              </UI.VisuallyHidden>
            ),
            width: "96px",
            align: "end",
            cell: openButton,
          },
        ]}
      />
    );
  }

  return (
    <>
      <ShellActiveNavigation id="issues" />
      <BatchBreadcrumbs />
      {startButton !== null && !phone
        ? <ShellSlot name="actions">{startButton}</ShellSlot>
        : null}
      <UI.Stack gap="spacious" data-testid="batches-page">
        <UI.PageHeader
          variant="list"
          flush
          title={translate("batches.title" as never)}
          subtitle={translate("batches.description" as never)}
          actions={startButton !== null && phone ? startButton : null}
        />
        {forbidden ? null : toolbar}
        {body}
        {list.hasNextPage
          ? (
            <UI.Button
              variant="secondary"
              disabled={list.isFetchingNextPage}
              aria-busy={list.isFetchingNextPage || undefined}
              onClick={() => void list.fetchNextPage()}
            >
              {translate("batches.list.loadMore" as never)}
            </UI.Button>
          )
          : null}
      </UI.Stack>
    </>
  );
}

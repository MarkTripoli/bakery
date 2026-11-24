import { useEffect, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import * as UI from "@bakery/ui";
import type { EvaluationBatch, EvaluationComparison } from "../api/client.ts";
import { useBakeryApi } from "../api/context.tsx";
import {
  evaluationBatchIsLive,
  evaluationBatchQueryOptions,
  evaluationCompareQueryOptions,
  evaluationResultsQueryOptions,
} from "../api/query.ts";
import {
  asyncKindForError,
  failureStatus,
  isForbiddenFailure,
} from "../app/async-state.ts";
import { useShellViewport } from "../app/responsive.ts";
import { useProtectedScope } from "../app/query-scope-context.tsx";
import { useRestoreOrganizationScope } from "../app/restore-organization.ts";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { WORK_HOME } from "../shell/breadcrumb-paths.ts";
import { ShellSlot } from "../shell/shell-slots.tsx";
import { EvaluationComparePicker } from "./library/EvaluationComparePicker.tsx";
import {
  caseGroups,
  caseNamesOf,
  type CaseRow,
  type ChangeTone,
  CLOSED_GROUPS,
  compareTitle,
  GROUP_PAGE,
  type GroupId,
  refusalWords,
  scorerLines,
  scorerNamesOf,
  stillRunning,
  sublineWords,
  unpairedRows,
} from "./library/evaluations-compare.ts";
import { candidatePin, type Words } from "./library/evaluations-state.ts";

const MAX_NAME_PAGES = 30;

function useCaseNames(batchId: string, enabled: boolean, live: boolean) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const read = useInfiniteQuery({
    ...evaluationResultsQueryOptions(api, scope, batchId, undefined, live, 100),
    enabled: enabled && Boolean(scope.organizationId) && batchId !== "",
  });
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = read;
  const pages = read.data?.pages.length ?? 0;
  useEffect(() => {
    if (
      enabled && hasNextPage && !isFetchingNextPage && pages < MAX_NAME_PAGES
    ) {
      void fetchNextPage();
    }
  }, [enabled, hasNextPage, isFetchingNextPage, pages, fetchNextPage]);
  const items = read.data?.pages.flatMap((page) => page.items) ?? [];
  return {
    names: caseNamesOf(items),
    done: !enabled || read.isError ||
      (read.isSuccess && (!hasNextPage || pages >= MAX_NAME_PAGES)),
  };
}

const TONE_TEXT: Record<ChangeTone, "positive" | "error" | "muted"> = {
  success: "positive",
  danger: "error",
  neutral: "muted",
};

type RowProps = {
  readonly rows: readonly {
    readonly key: string;
    readonly title: string;
    readonly line: string;
  }[];
  readonly label: string;
  readonly phone: boolean;
};

function Rows({ rows, label, phone }: RowProps) {
  const { translate } = useI18n();
  if (phone) {
    return (
      <UI.Stack aria-label={label} gap="none" role="list">
        {rows.map((row) => (
          <div data-row={row.key} key={row.key} role="listitem">
            <UI.StackedRow title={row.title}>
              <UI.Text variant="caption">{row.line}</UI.Text>
            </UI.StackedRow>
          </div>
        ))}
      </UI.Stack>
    );
  }
  return (
    <UI.DataTable
      caption={label}
      captionHidden
      columns={[
        {
          id: "case",
          header: translate("library.evaluations.compare.rows.case"),
          cell: (row) => <UI.Text>{row.title}</UI.Text>,
        },
        {
          id: "line",
          header: translate("library.evaluations.compare.rows.line"),
          align: "end",
          cell: (row) => <UI.Text variant="muted">{row.line}</UI.Text>,
        },
      ]}
      getRowAttributes={(row) => ({ "data-row": row.key })}
      getRowKey={(row) => row.key}
      headingsHidden
      rows={[...rows]}
      variant="ruled"
    />
  );
}

export function EvaluationComparePage(
  { batchId, otherId }: {
    readonly batchId: string;
    readonly otherId: string;
  },
) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const navigate = useNavigate();
  const { translate, locale, timeZone } = useI18n();
  useRestoreOrganizationScope();
  const phone = useShellViewport() === "phone";
  const [picking, setPicking] = useState(false);
  const [shown, setShown] = useState<Readonly<Record<string, number>>>({});
  const leftRun = useQuery(evaluationBatchQueryOptions(api, scope, batchId));
  const rightRun = useQuery(evaluationBatchQueryOptions(api, scope, otherId));
  const left = leftRun.data;
  const right = rightRun.data;
  const live = [left, right].some((run) =>
    run !== undefined && evaluationBatchIsLive(run.state)
  );
  const comparison = useQuery(
    evaluationCompareQueryOptions(api, scope, batchId, otherId, live),
  );
  const data: EvaluationComparison | undefined = comparison.data;
  const compatible = data?.compatible === true;
  const leftNames = useCaseNames(batchId, compatible, live);
  const rightNames = useCaseNames(
    otherId,
    compatible && (data?.onlyRight.length ?? 0) > 0,
    live,
  );
  const words = (entry: Words) => translate(entry.key, entry.values);
  const day = (iso: string) =>
    new Intl.DateTimeFormat(locale, {
      day: "numeric",
      month: "short",
      timeZone,
    }).format(new Date(iso));

  const breadcrumbs = (
    <ShellSlot name="breadcrumbs">
      <UI.Breadcrumbs
        aria-label={translate("shell.navigation.breadcrumb")}
        items={[
          { href: WORK_HOME, label: translate("shell.navigation.workspace") },
          {
            href: "/library?tab=evaluations",
            label: translate("library.title"),
          },
          { label: translate("library.evaluations.compare.crumb") },
        ]}
      />
    </ShellSlot>
  );
  const heading = (
    <UI.PageHeader
      flush
      title={translate("library.evaluations.compare.crumb")}
      variant="list"
    />
  );
  const back = () =>
    void navigate({ to: "/library", search: { tab: "evaluations" } });

  if (leftRun.isPending || rightRun.isPending || comparison.isPending) {
    return (
      <>
        {breadcrumbs}
        <UI.SettingsContent
          data-testid="evaluation-compare-page"
          variant="wide"
        >
          {heading}
          <UI.Stack aria-busy="true" gap="standard">
            <UI.Text role="status" variant="muted">
              {translate("library.evaluations.compare.loading")}
            </UI.Text>
            <UI.Skeleton shape="row" />
            <UI.Skeleton shape="row" />
          </UI.Stack>
        </UI.SettingsContent>
      </>
    );
  }
  const failure = leftRun.error ?? rightRun.error ?? comparison.error;
  if (
    leftRun.isError || rightRun.isError || comparison.isError ||
    left === undefined || right === undefined || data === undefined
  ) {
    const status = failureStatus(failure);
    const missing = status === 404 || isForbiddenFailure(failure);
    const offline = asyncKindForError(failure) === "offline";
    return (
      <>
        {breadcrumbs}
        <UI.SettingsContent
          data-testid="evaluation-compare-page"
          variant="wide"
        >
          {heading}
          {missing
            ? (
              <UI.EmptyState
                action={
                  <UI.Button variant="secondary" onClick={back}>
                    {translate("library.evaluation.back")}
                  </UI.Button>
                }
                description={translate(
                  "library.evaluation.notFound.description",
                )}
                title={translate("library.evaluation.notFound.title")}
                variant="filtered"
              />
            )
            : (
              <UI.ErrorState
                action={
                  <UI.Button
                    onClick={() => {
                      void leftRun.refetch();
                      void rightRun.refetch();
                      void comparison.refetch();
                    }}
                    variant="secondary"
                  >
                    {translate("library.evaluation.error.retry")}
                  </UI.Button>
                }
                description={translate(
                  offline
                    ? "library.offlineDescription"
                    : "library.error.description",
                )}
                title={translate(
                  offline
                    ? "library.offlineTitle"
                    : "library.evaluations.compare.error.title",
                )}
              />
            )}
        </UI.SettingsContent>
      </>
    );
  }

  const title = compareTitle(left, right);
  const titleText = title.same
    ? words(title.words)
    : translate("library.evaluations.compare.title.different", {
      left: words(title.left),
      right: words(title.right),
    });
  const a = candidatePin(left.candidate).version;
  const b = candidatePin(right.candidate).version;
  const versionA = a ?? 0;
  const versionB = b ?? 0;
  const chooseButton = (
    <UI.Button onClick={() => setPicking(true)} variant="secondary">
      {translate("library.evaluations.compare.choose")}
    </UI.Button>
  );
  const picker = picking
    ? (
      <EvaluationComparePicker
        current={left}
        onClose={() => setPicking(false)}
      />
    )
    : null;

  if (!data.compatible) {
    const reason = data.reason;
    return (
      <>
        {breadcrumbs}
        <UI.SettingsContent
          data-testid="evaluation-compare-page"
          variant="wide"
        >
          <UI.PageHeader flush title={titleText} variant="list" />
          <UI.AlertBanner
            action={chooseButton}
            data-testid="evaluation-compare-refused"
            tone="warning"
          >
            <UI.Stack gap="tight">
              <UI.Text variant="strong">
                {translate("library.evaluations.compare.refused.title")}
              </UI.Text>
              {reason === null ? null : (
                <UI.Text>
                  {words(
                    refusalWords(reason, {
                      left: left.datasetName,
                      right: right.datasetName,
                    }),
                  )}
                </UI.Text>
              )}
            </UI.Stack>
          </UI.AlertBanner>
        </UI.SettingsContent>
        {picker}
      </>
    );
  }

  const scorerNames = scorerNamesOf(left, right);
  const namesReady = leftNames.done && rightNames.done;
  const names = {
    cases: new Map([...rightNames.names, ...leftNames.names]),
    scorers: scorerNames,
  };
  const lines = scorerLines(data, scorerNames);
  const kindOf = (scorerId: string) =>
    left.scorers.find((scorer) => scorer.scorerId === scorerId)
        ?.evaluatorType === "deterministic"
      ? translate("library.evaluations.compare.scorer.check")
      : translate("library.evaluations.compare.scorer.rubric");
  const sideHeader = (version: number, run: EvaluationBatch) =>
    translate("library.evaluations.compare.table.side", {
      version,
      date: day(run.createdAt),
    });
  const sideCell = (
    side: { readonly rate: Words; readonly measured: Words | null },
  ) => (
    <UI.Stack gap="none">
      <UI.Text>{words(side.rate)}</UI.Text>
      {side.measured === null
        ? null
        : <UI.Text variant="caption">{words(side.measured)}</UI.Text>}
    </UI.Stack>
  );
  const running = stillRunning(left, right);
  const groups = namesReady
    ? caseGroups(data, names, {
      left: evaluationBatchIsLive(left.state),
      right: evaluationBatchIsLive(right.state),
    })
    : [];
  const rowLine = (row: CaseRow) =>
    translate("library.evaluations.compare.row.states", {
      scorer: row.scorerName,
      left: words(row.left),
      right: words(row.right),
    });
  const noteOf = (id: GroupId): Words | null =>
    id === "nowFailing"
      ? {
        key: "library.evaluations.compare.group.nowFailing.note",
        values: { a: versionA, b: versionB },
      }
      : id === "nowPassing"
      ? {
        key: "library.evaluations.compare.group.nowPassing.note",
        values: { a: versionA, b: versionB },
      }
      : id === "notMeasured"
      ? { key: "library.evaluations.compare.group.notMeasured.note" }
      : null;
  const head = (title: string, count: number, note: string | null) =>
    note === null
      ? translate("library.evaluations.compare.group.headBare", {
        title,
        count,
      })
      : translate("library.evaluations.compare.group.head", {
        title,
        count,
        note,
      });
  const more = (key: string, total: number) => {
    const visible = shown[key] ?? GROUP_PAGE;
    return total > visible
      ? (
        <UI.Button
          onClick={() =>
            setShown((current) => ({
              ...current,
              [key]: visible + GROUP_PAGE,
            }))}
          variant="secondary"
        >
          {translate("library.evaluations.compare.more", {
            count: total - visible,
          })}
        </UI.Button>
      )
      : null;
  };
  const groupBlock = (
    group: { readonly id: GroupId; readonly rows: readonly CaseRow[] },
  ) => {
    if (group.rows.length === 0) return null;
    const titleKey =
      `library.evaluations.compare.group.${group.id}.title` as const;
    const noteWords = noteOf(group.id);
    const label = head(
      translate(titleKey),
      group.rows.length,
      noteWords === null ? null : words(noteWords),
    );
    const visible = shown[group.id] ?? GROUP_PAGE;
    const body = (
      <UI.Stack gap="tight">
        <Rows
          label={label}
          phone={phone}
          rows={group.rows.slice(0, visible).map((row) => ({
            key: `${row.caseId}|${row.scorerId}`,
            title: row.caseName,
            line: rowLine(row),
          }))}
        />
        {more(group.id, group.rows.length)}
      </UI.Stack>
    );
    return CLOSED_GROUPS.includes(group.id)
      ? (
        <div data-group={group.id} key={group.id}>
          <UI.Disclosure summary={label}>{body}</UI.Disclosure>
        </div>
      )
      : (
        <UI.Stack data-group={group.id} gap="tight" key={group.id}>
          <UI.Text variant="strong">{label}</UI.Text>
          {body}
        </UI.Stack>
      );
  };
  const unpaired = (
    side: "left" | "right",
    entries: readonly { readonly caseId: string; readonly scorerId: string }[],
  ) => {
    if (entries.length === 0) return null;
    const version = side === "left" ? versionA : versionB;
    const rows = unpairedRows(entries, names);
    const label = head(
      translate("library.evaluations.compare.group.only.title", { version }),
      rows.length,
      translate("library.evaluations.compare.group.only.note"),
    );
    const key = `only-${side}`;
    const visible = shown[key] ?? GROUP_PAGE;
    return (
      <UI.Stack data-group={key} gap="tight" key={key}>
        <UI.Text variant="strong">{label}</UI.Text>
        <Rows
          label={label}
          phone={phone}
          rows={rows.slice(0, visible).map((row) => ({
            key: `${row.caseId}|${row.scorerName}`,
            title: row.caseName,
            line: row.scorerName,
          }))}
        />
        {more(key, rows.length)}
      </UI.Stack>
    );
  };

  return (
    <>
      {breadcrumbs}
      <UI.SettingsContent data-testid="evaluation-compare-page" variant="wide">
        <UI.PageHeader
          actions={chooseButton}
          flush
          subtitle={words(sublineWords(left, data))}
          title={titleText}
          variant="list"
        />
        {running === null ? null : (
          <UI.InlineNotice
            data-testid="evaluation-compare-running"
            tone="information"
          >
            {translate("library.evaluations.compare.running", {
              version: running === "left" ? versionA : versionB,
            })}
          </UI.InlineNotice>
        )}
        {phone
          ? (
            <UI.Stack
              aria-label={translate("library.evaluations.compare.table.label")}
              data-testid="evaluation-compare-scorers"
              gap="none"
              role="list"
            >
              {lines.map((line) => (
                <div
                  data-scorer={line.scorerId}
                  key={line.scorerId}
                  role="listitem"
                >
                  <UI.StackedRow title={line.name}>
                    <UI.Text variant="caption">{kindOf(line.scorerId)}</UI.Text>
                    <UI.Text variant="caption">
                      {translate("library.evaluations.compare.side.line", {
                        label: sideHeader(versionA, left),
                        rate: words(line.left.rate),
                      })}
                      {line.left.measured === null
                        ? ""
                        : ` · ${words(line.left.measured)}`}
                    </UI.Text>
                    <UI.Text variant="caption">
                      {translate("library.evaluations.compare.side.line", {
                        label: sideHeader(versionB, right),
                        rate: words(line.right.rate),
                      })}
                      {line.right.measured === null
                        ? ""
                        : ` · ${words(line.right.measured)}`}
                    </UI.Text>
                    <UI.Text variant={TONE_TEXT[line.change.tone]}>
                      {words(line.change.words)}
                    </UI.Text>
                  </UI.StackedRow>
                </div>
              ))}
            </UI.Stack>
          )
          : (
            <div data-testid="evaluation-compare-scorers">
              <UI.DataTable
                caption={translate("library.evaluations.compare.table.label")}
                captionHidden
                columns={[
                  {
                    id: "scorer",
                    header: translate(
                      "library.evaluations.compare.table.scorer",
                    ),
                    cell: (line) => (
                      <UI.Stack gap="none">
                        <UI.Text>{line.name}</UI.Text>
                        <UI.Text variant="caption">
                          {kindOf(line.scorerId)}
                        </UI.Text>
                      </UI.Stack>
                    ),
                  },
                  {
                    id: "left",
                    header: sideHeader(versionA, left),
                    cell: (line) => sideCell(line.left),
                  },
                  {
                    id: "right",
                    header: sideHeader(versionB, right),
                    cell: (line) => sideCell(line.right),
                  },
                  {
                    id: "change",
                    header: translate(
                      "library.evaluations.compare.table.change",
                    ),
                    cell: (line) => (
                      <UI.Text variant={TONE_TEXT[line.change.tone]}>
                        {words(line.change.words)}
                      </UI.Text>
                    ),
                  },
                ]}
                getRowAttributes={(line) => ({ "data-scorer": line.scorerId })}
                getRowKey={(line) => line.scorerId}
                rows={lines}
              />
            </div>
          )}
        <UI.Text variant="muted">
          {translate("library.evaluations.compare.caption")}
        </UI.Text>
        {namesReady
          ? (
            <UI.Stack data-testid="evaluation-compare-groups" gap="standard">
              {groups.map((group) => groupBlock(group))}
              {unpaired("left", data.onlyLeft)}
              {unpaired("right", data.onlyRight)}
            </UI.Stack>
          )
          : (
            <UI.Text role="status" variant="muted">
              {translate("library.evaluations.compare.names.loading")}
            </UI.Text>
          )}
      </UI.SettingsContent>
      {picker}
    </>
  );
}

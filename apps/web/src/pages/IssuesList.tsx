import type { Translator } from "@bakery/i18n";
import * as UI from "@bakery/ui";
import {
  decidingCheck,
  evidenceValue,
  issueNumber,
  type IssueRow,
  issueSnapshot,
  type IssueStatus,
  issueStatus,
  reasonKey,
  referencedNumber,
} from "./issue-state.ts";

/** The most labels a row names before it says how many more there are. */
const MAX_LABELS = 3;

const BADGE_TONE = {
  canStart: "success",
  waiting: "warning",
  cannotStart: "neutral",
  inProgress: "success",
  waitingToStart: "warning",
  paused: "danger",
  closed: "neutral",
  unknown: "neutral",
} as const satisfies Record<
  IssueStatus,
  "neutral" | "success" | "warning" | "danger"
>;

/** The sentence a reason code reads as, with the number or label its check read. */
export function reasonSentence(
  row: IssueRow,
  code: string,
  translate: Translator,
): string {
  const key = reasonKey(code);
  if (key === "unknown") {
    return translate("issues.reason.unknown" as never);
  }
  const check = decidingCheck(row);
  return translate(`issues.reason.${key}` as never, {
    number: referencedNumber(evidenceValue(check, "blocker")) ?? "",
    label: evidenceValue(check, "label") ?? "",
  });
}

/** The line under an issue's title: why it is not startable, or else where it lives and its labels. */
export function issueLine(row: IssueRow, translate: Translator): string {
  const { reason } = issueStatus(row);
  if (reason !== null) return reasonSentence(row, reason, translate);
  const { repository, labels } = issueSnapshot(row);
  const shown = labels.slice(0, MAX_LABELS);
  const more = labels.length - shown.length;
  return [
    repository,
    ...shown,
    ...(more > 0 ? [`+${more}`] : []),
  ].filter(Boolean).join(" · ");
}

function IssueBadge(
  { row, translate }: { row: IssueRow; translate: Translator },
) {
  const { status } = issueStatus(row);
  return (
    <UI.Badge tone={BADGE_TONE[status]}>
      {translate(`issues.status.${status}` as never)}
    </UI.Badge>
  );
}

function issueTitle(row: IssueRow): string {
  const number = issueNumber(row);
  const { title } = issueSnapshot(row);
  return number === null ? title : `#${number} ${title}`;
}

/**
 * The row's one control: the issue on GitHub, in a new tab. The issue's own page
 * and "Start work" come with the next part of this feature.
 */
function RowAction(
  { row, translate }: { row: IssueRow; translate: Translator },
) {
  return (
    <UI.Link
      href={row.safeUrl}
      variant="button"
      target="_blank"
      rel="noreferrer"
      aria-label={translate("issues.row.openNamed" as never, {
        title: issueTitle(row),
      })}
    >
      {translate("issues.row.open" as never)}
    </UI.Link>
  );
}

/**
 * One row per issue: its number and title, one line, ONE status and ONE
 * control. A table on a wide screen, stacked rows on a phone.
 */
export function IssuesList(
  { rows, loading, phone, translate }: {
    rows: readonly IssueRow[];
    loading: boolean;
    phone: boolean;
    translate: Translator;
  },
) {
  if (loading && rows.length === 0) {
    return (
      <>
        <UI.Text variant="muted" role="status">
          {translate("issues.loading" as never)}
        </UI.Text>
        <UI.Stack
          gap="standard"
          role="list"
          aria-label={translate("issues.list" as never)}
          aria-busy="true"
        >
          {[0, 1, 2].map((index) => (
            <div key={index} role="listitem">
              <UI.Skeleton shape="row" />
            </div>
          ))}
        </UI.Stack>
      </>
    );
  }
  if (phone) {
    return (
      <UI.Stack
        gap="none"
        role="list"
        aria-label={translate("issues.list" as never)}
      >
        {rows.map((row) => (
          <div key={row.id} role="listitem" data-issue-id={row.id}>
            <UI.StackedRow
              title={issueTitle(row)}
              status={<IssueBadge row={row} translate={translate} />}
            >
              <UI.Text variant="caption">{issueLine(row, translate)}</UI.Text>
              <RowAction row={row} translate={translate} />
            </UI.StackedRow>
          </div>
        ))}
      </UI.Stack>
    );
  }
  return (
    <UI.DataTable<IssueRow>
      caption={translate("issues.list" as never)}
      captionHidden
      variant="ruled"
      inset="edge"
      rowSize="double"
      rows={[...rows]}
      state="ready"
      emptyMessage={translate("issues.filter.empty" as never)}
      getRowKey={(row) => row.id}
      getRowAttributes={(row) => ({ "data-issue-id": row.id })}
      columns={[
        {
          id: "issue",
          width: "56%",
          header: translate("issues.column.issue" as never),
          cell: (row) => (
            <UI.CellStack
              title={issueTitle(row)}
              detail={issueLine(row, translate)}
            />
          ),
        },
        {
          id: "status",
          width: "20%",
          header: translate("issues.column.status" as never),
          cell: (row) => <IssueBadge row={row} translate={translate} />,
        },
        {
          id: "action",
          align: "end",
          header: translate("issues.column.action" as never),
          cell: (row) => <RowAction row={row} translate={translate} />,
        },
      ]}
    />
  );
}

import type { Translator } from "@bakery/i18n";
import { useNavigate } from "@tanstack/react-router";
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

const BADGE_TONE = {
  canStart: "success",
  waiting: "warning",
  cannotStart: "neutral",
  inProgress: "information",
  waitingToStart: "warning",
  paused: "danger",
  closed: "neutral",
  unknown: "neutral",
} as const satisfies Record<
  IssueStatus,
  "neutral" | "success" | "warning" | "danger" | "information"
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

/**
 * The line under an issue's title, the same shape on every row: the repository
 * first, then what to know about the issue when there is something (why it is
 * not startable, or that Bakery is working on it).
 */
export function issueLine(row: IssueRow, translate: Translator): string {
  const { status, reason } = issueStatus(row);
  const note = status === "inProgress"
    ? translate("issues.line.inProgress" as never)
    : reason !== null
    ? reasonSentence(row, reason, translate)
    : null;
  return [issueSnapshot(row).repository, note].filter(Boolean).join(" · ");
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

/** The row's accessible name: the issue, its status and its reason. */
function rowName(row: IssueRow, translate: Translator): string {
  const { status } = issueStatus(row);
  return `${issueTitle(row)}, ${
    translate(`issues.status.${status}` as never)
  }, ${issueLine(row, translate)}`;
}

/** The issue's title as a link to its page, named with its status and reason. */
function IssueTitle(
  { row, translate }: { row: IssueRow; translate: Translator },
) {
  const navigate = useNavigate();
  return (
    <UI.Link
      href={`/issues/${row.id}`}
      variant="quiet"
      aria-label={rowName(row, translate)}
      onClick={(event) => {
        event.preventDefault();
        void navigate({ to: "/issues/$issueId", params: { issueId: row.id } });
      }}
    >
      {issueTitle(row)}
    </UI.Link>
  );
}

/**
 * The row's one control: Start work (primary) on an issue that can start, which
 * opens the same confirmation as the issue page; Open, the issue's page, on
 * every other.
 */
function RowAction(
  { offered, onStart, row, translate }: {
    offered: boolean;
    onStart: (row: IssueRow) => void;
    row: IssueRow;
    translate: Translator;
  },
) {
  const navigate = useNavigate();
  if (offered) {
    return (
      <UI.Button
        variant="primary"
        aria-label={translate("issues.row.startNamed" as never, {
          title: issueTitle(row),
        })}
        onClick={() => onStart(row)}
      >
        {translate("issues.start.button" as never)}
      </UI.Button>
    );
  }
  return (
    <UI.Button
      variant="secondary"
      aria-label={translate("issues.row.openPageNamed" as never, {
        title: issueTitle(row),
      })}
      onClick={() =>
        void navigate({ to: "/issues/$issueId", params: { issueId: row.id } })}
    >
      {translate("issues.row.openPage" as never)}
    </UI.Button>
  );
}

/**
 * One row per issue: its number and title, one line, ONE status and ONE
 * control. A table on a wide screen, stacked rows on a phone.
 */
export function IssuesList(
  { offered, onStart, rows, loading, phone, translate }: {
    /** Whether Start work is offered on this row (can start, GitHub readable, online). */
    offered: (row: IssueRow) => boolean;
    onStart: (row: IssueRow) => void;
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
              title={<IssueTitle row={row} translate={translate} />}
              status={<IssueBadge row={row} translate={translate} />}
            >
              <UI.Text variant="caption">{issueLine(row, translate)}</UI.Text>
              <RowAction
                offered={offered(row)}
                onStart={onStart}
                row={row}
                translate={translate}
              />
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
            <UI.Stack gap="none">
              <IssueTitle row={row} translate={translate} />
              <UI.Text variant="caption">{issueLine(row, translate)}</UI.Text>
            </UI.Stack>
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
          cell: (row) => (
            <RowAction
              offered={offered(row)}
              onStart={onStart}
              row={row}
              translate={translate}
            />
          ),
        },
      ]}
    />
  );
}

import type { Translator } from "@bakery/i18n";
import { useNavigate } from "@tanstack/react-router";
import * as UI from "@bakery/ui";
import {
  issueNumber,
  type IssueRow,
  issueSnapshot,
  type IssueStatus,
  issueStatus,
  listedStatus,
  reasonMessage,
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
  needsAnswer: "warning",
} as const satisfies Record<
  IssueStatus | "needsAnswer",
  "neutral" | "success" | "warning" | "danger" | "information"
>;

/** The sentence a reason code reads as, with the number or label its check read. */
export function reasonSentence(
  row: IssueRow,
  code: string,
  translate: Translator,
): string {
  const message = reasonMessage(row, code);
  return translate(message.key as never, message.values);
}

/**
 * The line under an issue's title, the same shape on every row: the repository
 * first, then what to know about the issue when there is something (why it is
 * not startable, or that Bakery is working on it).
 */
export function issueLine(row: IssueRow, translate: Translator): string {
  const { status, reason } = issueStatus(row);
  const note = listedStatus(row) === "needsAnswer"
    ? translate("issues.line.needsAnswer" as never)
    : status === "inProgress"
    ? translate("issues.line.inProgress" as never)
    : reason !== null
    ? reasonSentence(row, reason, translate)
    : null;
  return [issueSnapshot(row).repository, note].filter(Boolean).join(" · ");
}

/** The row's one status. */
function StatusBadge(
  { row, translate }: { row: IssueRow; translate: Translator },
) {
  const status = listedStatus(row);
  return (
    <UI.Badge tone={BADGE_TONE[status]}>
      {translate(`issues.status.${status}` as never)}
    </UI.Badge>
  );
}

/** "In the batch": a live batch has started or merged this issue. */
function InBatchBadge({ translate }: { translate: Translator }) {
  return (
    <UI.Badge tone="neutral" data-in-batch="true">
      {translate("issues.batch.inBatch" as never)}
    </UI.Badge>
  );
}

/** The table's status cell: the status, and "In the batch" beside it when a live batch has the issue. */
function IssueBadge(
  { row, inBatch, translate }: {
    row: IssueRow;
    inBatch: boolean;
    translate: Translator;
  },
) {
  const badge = <StatusBadge row={row} translate={translate} />;
  if (!inBatch) return badge;
  return (
    <UI.Inline gap="compact">
      {badge}
      <InBatchBadge translate={translate} />
    </UI.Inline>
  );
}

function issueTitle(row: IssueRow): string {
  const number = issueNumber(row);
  const { title } = issueSnapshot(row);
  return number === null ? title : `#${number} ${title}`;
}

/** The row's accessible name: the issue, its status, whether a batch has it, and its reason. */
function rowName(
  row: IssueRow,
  inBatch: boolean,
  translate: Translator,
): string {
  const status = listedStatus(row);
  const batch = inBatch
    ? `, ${translate("issues.batch.inBatch" as never)}`
    : "";
  return `${issueTitle(row)}, ${
    translate(`issues.status.${status}` as never)
  }${batch}, ${issueLine(row, translate)}`;
}

/** The issue's title as a link to its page, named with its status and reason. */
function IssueTitle(
  { row, inBatch, translate }: {
    row: IssueRow;
    inBatch: boolean;
    translate: Translator;
  },
) {
  const navigate = useNavigate();
  return (
    <UI.Link
      href={`/issues/${row.id}`}
      variant="quiet"
      data-row-title="true"
      aria-label={rowName(row, inBatch, translate)}
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
  { offered, inBatch, onStart, rows, loading, phone, translate }: {
    /** Whether Start work is offered on this row (can start, GitHub readable, online). */
    offered: (row: IssueRow) => boolean;
    /** The ids of the issues a live batch has started or merged. */
    inBatch: ReadonlySet<string>;
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
              // A real title is long: it wraps rather than sharing its line with two badges.
              titleLines="wrap"
              title={
                <IssueTitle
                  row={row}
                  inBatch={inBatch.has(row.id)}
                  translate={translate}
                />
              }
              status={<StatusBadge row={row} translate={translate} />}
            >
              {inBatch.has(row.id)
                ? (
                  <UI.Inline gap="compact">
                    <InBatchBadge translate={translate} />
                  </UI.Inline>
                )
                : null}
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
              <IssueTitle
                row={row}
                inBatch={inBatch.has(row.id)}
                translate={translate}
              />
              <UI.Text variant="caption">{issueLine(row, translate)}</UI.Text>
            </UI.Stack>
          ),
        },
        {
          id: "status",
          width: "20%",
          header: translate("issues.column.status" as never),
          cell: (row) => (
            <IssueBadge
              row={row}
              inBatch={inBatch.has(row.id)}
              translate={translate}
            />
          ),
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

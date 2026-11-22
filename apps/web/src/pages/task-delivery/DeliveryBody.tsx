import { type ReactNode, useEffect, useState } from "react";
import * as UI from "@bakery/ui";
import { formatDate, formatList, type MessageKey } from "@bakery/i18n";
import { useShellViewport } from "../../app/responsive.ts";
import { useI18n } from "../../i18n/I18nProvider.tsx";
import { type AttentionItem, attentionItems } from "./attention.ts";
import {
  limitMinutes,
  nameList,
  orderChecks,
  tookCell,
  tryKey,
} from "./check-copy.ts";
import { mergeStepCopy } from "./merge-copy.ts";
import type { CheckRow, DeliveryModel, FindingRow, Try } from "./model.ts";

/** At most this many rows show before "Show all". */
const SHOWN = 5;

const CHECK_TONE = {
  passed: "success",
  failed: "danger",
  pending: "neutral",
  unavailable: "warning",
  canceled: "neutral",
} as const;

const CHECK_LABEL: Readonly<Record<CheckRow["result"], MessageKey>> = {
  passed: "tasks.delivery.check.passed",
  failed: "tasks.delivery.check.failed",
  pending: "tasks.delivery.check.running",
  unavailable: "tasks.delivery.check.unavailable",
  canceled: "tasks.delivery.check.canceled",
};

const SEVERITY_LABEL: Readonly<Record<FindingRow["severity"], MessageKey>> = {
  blocker: "tasks.delivery.severity.blocker",
  major: "tasks.delivery.severity.major",
  minor: "tasks.delivery.severity.minor",
  note: "tasks.delivery.severity.note",
};

const SEVERITY_TONE = {
  blocker: "danger",
  major: "warning",
  minor: "neutral",
  note: "neutral",
} as const;

type Column<Row> = Readonly<{
  id: string;
  header: string;
  cell: (row: Row) => ReactNode;
  width?: string;
}>;

/**
 * Rows the way the design wants them: a table with no heading row on a wide
 * screen, one ruled stacked row each on a phone. Each fact has one home, so the
 * phone shows the same cells in a different order, never different facts.
 */
function Rows<Row>(
  { caption, columns, phone, rowKey, rows, testId }: Readonly<{
    caption: string;
    columns: readonly Column<Row>[];
    phone: (row: Row) => Readonly<{
      title: ReactNode;
      status?: ReactNode;
      lines: readonly ReactNode[];
    }>;
    rowKey: (row: Row) => string;
    rows: readonly Row[];
    testId: string;
  }>,
) {
  const narrow = useShellViewport() === "phone";
  if (narrow) {
    return (
      <UI.Stack
        data-testid={testId}
        gap="none"
        role="list"
        aria-label={caption}
      >
        {rows.map((row) => {
          const shown = phone(row);
          // The article a stacked row draws cannot carry a list role, so each
          // row sits in its own list item.
          return (
            <UI.Stack gap="none" key={rowKey(row)} role="listitem">
              <UI.StackedRow
                flush
                status={shown.status}
                title={shown.title}
                titleLines="wrap"
              >
                {shown.lines.map((line, index) => (
                  <div key={index}>{line}</div>
                ))}
              </UI.StackedRow>
            </UI.Stack>
          );
        })}
      </UI.Stack>
    );
  }
  return (
    <div data-testid={testId}>
      <UI.DataTable
        caption={caption}
        captionHidden
        columns={columns.map((column) => ({
          cell: column.cell,
          header: column.header,
          id: column.id,
          width: column.width,
        }))}
        getRowKey={rowKey}
        variant="ruled"
        headingsHidden
        rows={[...rows]}
      />
    </div>
  );
}

function Attention(
  { items, onOpenRules }: Readonly<{
    items: readonly AttentionItem[];
    onOpenRules: () => void;
  }>,
) {
  const { translate: t } = useI18n();
  const [all, setAll] = useState(false);
  if (items.length === 0) return null;
  const shown = all ? items : items.slice(0, SHOWN);
  const what = (item: AttentionItem) =>
    item.kind === "finding"
      ? (
        <UI.Stack gap="none">
          <UI.Text>{t("tasks.delivery.attention.finding")}</UI.Text>
          <UI.DataText variant="code">
            {item.line === null ? item.path : `${item.path}:${item.line}`}
          </UI.DataText>
        </UI.Stack>
      )
      : <UI.DataText fit>{item.name}</UI.DataText>;
  const why = (item: AttentionItem) =>
    item.kind === "finding"
      ? (
        <UI.ExpandableText
          hideLabel={t("tasks.delivery.showLess")}
          showLabel={t("tasks.delivery.showAll")}
        >
          {item.text}
        </UI.ExpandableText>
      )
      : <UI.Text>{t(item.why.key, item.why.values)}</UI.Text>;
  const link = (item: AttentionItem) =>
    item.kind === "finding" ? null : item.rule
      ? (
        <UI.Link
          href="#run-details"
          variant="sentence"
          onClick={(event) => {
            event.preventDefault();
            onOpenRules();
          }}
        >
          {t("tasks.delivery.attention.openRules")}
        </UI.Link>
      )
      : item.evidenceVersionId === null
      ? null
      : (
        <UI.Link
          href={`/files/versions/${item.evidenceVersionId}`}
          variant="sentence"
        >
          {t("tasks.delivery.check.openOutput")}
        </UI.Link>
      );
  return (
    <UI.Stack data-testid="delivery-attention" gap="compact">
      <UI.Text variant="strong">{t("tasks.delivery.attention.label")}</UI.Text>
      <Rows
        caption={t("tasks.delivery.attention.label")}
        columns={[
          {
            id: "what",
            header: t("tasks.delivery.attention.colItem"),
            cell: what,
            width: "26%",
          },
          {
            id: "why",
            header: t("tasks.delivery.attention.colWhy"),
            cell: why,
          },
          {
            id: "link",
            header: t("tasks.delivery.attention.colLink"),
            cell: link,
            width: "22%",
          },
        ]}
        phone={(item) => ({
          title: what(item),
          lines: [why(item), link(item)].filter((line) => line !== null),
        })}
        rowKey={(item) => `${item.kind}-${item.id}`}
        rows={shown}
        testId="delivery-attention-rows"
      />
      {!all && items.length > SHOWN && (
        <UI.Button onClick={() => setAll(true)} variant="text">
          {t("tasks.delivery.showAll")}
        </UI.Button>
      )}
    </UI.Stack>
  );
}

/** One short line of what is settled or running: counts, never rows. */
function Line(
  { children, done, testId }: Readonly<{
    children: ReactNode;
    done: boolean;
    testId: string;
  }>,
) {
  return (
    <UI.Inline data-testid={testId} gap="compact">
      <UI.IconGlyph name={done ? "check" : "clock"} size="small" />
      {children}
    </UI.Inline>
  );
}

function Settled({ model }: Readonly<{ model: DeliveryModel }>) {
  const { locale, timeZone, translate: t } = useI18n();
  const { checks, review } = model;
  const lines: ReactNode[] = [];
  if (checks.rows.length === 0) {
    lines.push(
      <Line done={false} key="checks" testId="delivery-settled-checks">
        <UI.Text>{t("tasks.delivery.settled.checksNone")}</UI.Text>
      </Line>,
    );
  } else {
    if (checks.running > 0) {
      lines.push(
        <Line done={false} key="checks" testId="delivery-settled-checks">
          <UI.Text>
            {t("tasks.delivery.settled.checksProgress", {
              done: checks.total - checks.running,
              total: checks.total,
            })}
          </UI.Text>
        </Line>,
      );
    } else if (checks.passed > 0) {
      lines.push(
        <Line done key="checks" testId="delivery-settled-checks">
          <UI.Text>
            {t("tasks.delivery.settled.checksPassed", { count: checks.passed })}
          </UI.Text>
        </Line>,
      );
    }
    if (review === null) {
      lines.push(
        <Line done={false} key="review" testId="delivery-settled-review">
          <UI.Text>{t("tasks.delivery.settled.reviewNotStarted")}</UI.Text>
        </Line>,
      );
    } else if (review.status === "running" || review.olderSha !== null) {
      lines.push(
        <Line done={false} key="review" testId="delivery-settled-review">
          <UI.Text>{t("tasks.delivery.settled.reviewInProgress")}</UI.Text>
        </Line>,
      );
    } else if (review.status === "approved") {
      lines.push(
        <Line done key="review" testId="delivery-settled-review">
          <UI.Text>{t("tasks.delivery.settled.reviewClean")}</UI.Text>
        </Line>,
      );
    }
  }
  if (review?.accepted != null) {
    const date = formatDate(new Date(review.accepted.at), locale, {
      dateStyle: "medium",
      timeZone,
    });
    lines.push(
      <Line done key="accepted" testId="delivery-review-accepted">
        <UI.Text variant="strong">
          {t("tasks.delivery.settled.acceptedLead")}
        </UI.Text>
        <UI.Text>
          {review.accepted.by === null
            ? t("tasks.delivery.settled.acceptedNoName", {
              date,
              reason: review.accepted.reason,
            })
            : t("tasks.delivery.settled.acceptedBy", {
              name: review.accepted.by,
              date,
              reason: review.accepted.reason,
            })}
        </UI.Text>
      </Line>,
    );
  }
  const pullRequest = model.approval?.state === "approved"
    ? model.afterApproval.pullRequest
    : null;
  if (pullRequest !== null) {
    lines.push(
      <Line done key="pull-request" testId="delivery-pull-request-line">
        <UI.Link href={pullRequest.url} variant="external">
          {t("tasks.delivery.settled.pullRequest", {
            number: pullRequest.providerNumber,
          })}
        </UI.Link>
      </Line>,
    );
  }
  if (lines.length === 0) return null;
  return (
    <UI.Stack data-testid="delivery-settled" gap="compact">{lines}</UI.Stack>
  );
}

function Tried({ fixing }: Readonly<{ fixing: DeliveryModel["fixing"] }>) {
  const { locale, translate: t } = useI18n();
  if (fixing === null || fixing.tries.length === 0) return null;
  const minutes = limitMinutes(fixing.limits.durationMs);
  const names = (all: readonly string[]) => {
    const { shown, more } = nameList(all);
    const list = formatList(shown, locale);
    return more === 0
      ? list
      : t("tasks.delivery.fixing.tried.andMore", { names: list, count: more });
  };
  const asked = (entry: Try) =>
    t(
      tryKey({
        checks: entry.checkNames.length,
        blocking: entry.blocking,
      }),
      {
        checks: entry.checkNames.length,
        names: names(entry.checkNames),
        blocking: entry.blocking,
      },
    );
  return (
    <UI.Disclosure
      data-testid="delivery-tried"
      summary={t("tasks.delivery.links.tried")}
    >
      <UI.Stack gap="compact">
        <Rows
          caption={t("tasks.delivery.links.tried")}
          columns={[
            {
              id: "try",
              header: t("tasks.delivery.details.colTry"),
              cell: (entry: Try) => (
                <UI.Text>
                  {t("tasks.delivery.fixing.tried.try", { n: entry.n })}
                </UI.Text>
              ),
              width: "14%",
            },
            {
              id: "asked",
              header: t("tasks.delivery.details.colAsked"),
              cell: (entry: Try) => <UI.Text>{asked(entry)}</UI.Text>,
            },
            {
              id: "commit",
              header: t("tasks.delivery.details.colCommit"),
              cell: (entry: Try) => (
                <UI.DataText variant="code">{entry.sha}</UI.DataText>
              ),
              width: "14%",
            },
          ]}
          phone={(entry: Try) => ({
            title: t("tasks.delivery.fixing.tried.try", { n: entry.n }),
            status: <UI.DataText variant="code">{entry.sha}</UI.DataText>,
            lines: [<UI.Text key="asked">{asked(entry)}</UI.Text>],
          })}
          rowKey={(entry: Try) => String(entry.n)}
          rows={fixing.tries}
          testId="delivery-tried-rows"
        />
        <UI.Text variant="caption">
          {minutes === null
            ? t("tasks.delivery.fixing.tried.limitTries", {
              max: fixing.limits.max,
            })
            : t("tasks.delivery.fixing.tried.limit", {
              max: fixing.limits.max,
              minutes,
            })}
        </UI.Text>
      </UI.Stack>
    </UI.Disclosure>
  );
}

function ChecksTable(
  { caption, rows }: Readonly<{ caption: string; rows: readonly CheckRow[] }>,
) {
  const { translate: t } = useI18n();
  const result = (row: CheckRow) => (
    <UI.Badge tone={CHECK_TONE[row.result]}>
      {t(CHECK_LABEL[row.result])}
    </UI.Badge>
  );
  const took = (row: CheckRow) => {
    const cell = tookCell(row);
    return cell === null
      ? t("tasks.delivery.details.rule")
      : t(cell.key, "values" in cell ? cell.values : undefined);
  };
  const exit = (row: CheckRow) =>
    row.exitCode === null ? "" : String(row.exitCode);
  const link = (row: CheckRow) =>
    row.evidenceVersionId === null
      ? null
      : (
        <UI.Link href={`/files/versions/${row.evidenceVersionId}`}>
          {t("tasks.delivery.check.openOutput")}
        </UI.Link>
      );
  return (
    <Rows
      caption={caption}
      columns={[
        {
          id: "name",
          header: t("tasks.delivery.details.colCheck"),
          cell: (row: CheckRow) => <UI.DataText fit>{row.name}</UI.DataText>,
        },
        {
          id: "result",
          header: t("tasks.delivery.details.colResult"),
          cell: result,
          width: "16%",
        },
        {
          id: "took",
          header: t("tasks.delivery.details.colTook"),
          cell: (row: CheckRow) => <UI.Text>{took(row)}</UI.Text>,
          width: "16%",
        },
        {
          id: "exit",
          header: t("tasks.delivery.details.colExit"),
          cell: (row: CheckRow) => (
            <UI.DataText variant="metric">{exit(row)}</UI.DataText>
          ),
          width: "12%",
        },
        {
          id: "link",
          header: t("tasks.delivery.attention.colLink"),
          cell: link,
          width: "20%",
        },
      ]}
      phone={(row: CheckRow) => ({
        title: <UI.DataText fit>{row.name}</UI.DataText>,
        status: result(row),
        lines: [
          <UI.Text key="took">
            {took(row)}
            {exit(row) === ""
              ? ""
              : ` · ${t("tasks.delivery.details.colExit")} ${exit(row)}`}
          </UI.Text>,
          link(row),
        ].filter((line) => line !== null),
      })}
      rowKey={(row: CheckRow) => row.id}
      rows={rows}
      testId="delivery-checks-rows"
    />
  );
}

function Details({ model }: Readonly<{ model: DeliveryModel }>) {
  const { translate: t } = useI18n();
  const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => {
    if (copied !== "copied") return;
    const timer = globalThis.setTimeout(() => setCopied("idle"), 2500);
    return () => globalThis.clearTimeout(timer);
  }, [copied]);
  const { checks, review } = model;
  const after = model.approval?.state === "approved"
    ? model.afterApproval
    : null;
  const pullRequest = after?.pullRequest ?? null;
  const mergeCommit = pullRequest?.mergedSha ?? null;
  const mergeStep = mergeStepCopy(t, {
    merge: model.merge,
    pullRequest,
    mergeCommit,
  });
  const copyMergeCommit = async () => {
    if (mergeCommit === null) return;
    try {
      await navigator.clipboard.writeText(mergeCommit);
      setCopied("copied");
    } catch {
      setCopied("failed");
    }
  };
  const helpTip = (key: "checks" | "review") => (
    <UI.HelpTip label={t(`tasks.delivery.help.${key}.label` as MessageKey)}>
      {t(`tasks.delivery.help.${key}.text` as MessageKey)}
    </UI.HelpTip>
  );
  const commit = model.headSha === null
    ? t("tasks.delivery.changes.preparing")
    : model.baseSha === null
    ? t("tasks.delivery.changes.summaryNoBase", {
      head: model.headSha.slice(0, 7),
    })
    : t("tasks.delivery.changes.summary", {
      head: model.headSha.slice(0, 7),
      base: model.baseSha.slice(0, 7),
    });
  const current = orderChecks(
    checks.rows.filter((row) => row.olderSha === null),
  );
  const older = checks.rows.filter((row) => row.olderSha !== null);
  const olderShas = [...new Set(older.map((row) => row.olderSha as string))];
  const attentionIds = new Set(
    attentionItems(model).flatMap((item) =>
      item.kind === "finding" ? [item.id] : []
    ),
  );
  const accepted = review?.accepted != null;
  const findings = review?.findings ?? [];
  const acceptedFindings = accepted
    ? findings.filter((finding) => finding.blocking)
    : [];
  const notes = findings.filter((finding) =>
    !attentionIds.has(finding.id) && !acceptedFindings.includes(finding)
  );
  const findingLine = (finding: FindingRow) => (
    <UI.Text key={finding.id}>
      <UI.Badge tone={SEVERITY_TONE[finding.severity]}>
        {t(SEVERITY_LABEL[finding.severity])}
      </UI.Badge>{" "}
      {finding.body}{" "}
      <UI.DataText variant="code">
        {finding.line === null
          ? finding.path
          : `${finding.path}:${finding.line}`}
      </UI.DataText>
    </UI.Text>
  );
  const reviewSummary = review === null
    ? t("tasks.delivery.review.none")
    : review.status === "approved"
    ? t("tasks.delivery.review.approved", { count: review.others })
    : review.status === "running"
    ? t("tasks.delivery.review.running")
    : review.status === "failed"
    ? t("tasks.delivery.review.failed")
    : review.others === 0
    ? t("tasks.delivery.review.changesBlockingOnly", {
      blocking: review.blocking,
    })
    : t("tasks.delivery.review.changes", {
      blocking: review.blocking,
      others: review.others,
    });
  return (
    <UI.Disclosure
      data-testid="delivery-details"
      summary={t("tasks.delivery.links.details")}
    >
      <UI.Stack>
        <UI.Text>
          <UI.Text variant="strong">
            {t("tasks.delivery.details.commit")}
          </UI.Text>{" "}
          {commit}
        </UI.Text>
        {checks.rows.length === 0 ? null : (
          <UI.Stack gap="compact">
            <UI.Inline gap="compact">
              <UI.Text variant="strong">
                {t("tasks.delivery.checks.title")}
              </UI.Text>
              {helpTip("checks")}
            </UI.Inline>
            {current.length === 0 ? null : (
              <ChecksTable
                caption={t("tasks.delivery.checks.title")}
                rows={current}
              />
            )}
            {olderShas.map((sha) => (
              <UI.Stack gap="compact" key={sha}>
                <UI.Text variant="strong">
                  {t("tasks.delivery.details.earlier", { sha })}
                </UI.Text>
                <ChecksTable
                  caption={t("tasks.delivery.details.earlier", { sha })}
                  rows={older.filter((row) => row.olderSha === sha)}
                />
              </UI.Stack>
            ))}
          </UI.Stack>
        )}
        <UI.Stack gap="compact">
          <UI.Inline gap="compact">
            <UI.Text variant="strong">
              {t("tasks.delivery.review.title")}
            </UI.Text>
            {helpTip("review")}
          </UI.Inline>
          <UI.Text>{reviewSummary}</UI.Text>
          {acceptedFindings.length === 0 ? null : (
            <UI.Stack gap="compact">
              <UI.Text variant="muted">
                {t("tasks.delivery.details.acceptedFindings")}
              </UI.Text>
              {acceptedFindings.map(findingLine)}
            </UI.Stack>
          )}
          {notes.length === 0 ? null : (
            <UI.Disclosure
              summary={t("tasks.delivery.details.notesShow", {
                count: notes.length,
              })}
            >
              <UI.Stack gap="compact">{notes.map(findingLine)}</UI.Stack>
            </UI.Disclosure>
          )}
        </UI.Stack>
        {after === null ? null : (
          <UI.Stack gap="compact">
            <UI.Text>{mergeStep.summary}</UI.Text>
            {mergeCommit === null ? null : (
              <UI.Inline>
                <UI.Button
                  onClick={() => void copyMergeCommit()}
                  type="button"
                  variant="secondary"
                >
                  {t(
                    copied === "copied"
                      ? "tasks.delivery.afterApproval.merge.copied"
                      : copied === "failed"
                      ? "tasks.delivery.afterApproval.merge.copyFailed"
                      : "tasks.delivery.afterApproval.merge.copy",
                  )}
                </UI.Button>
              </UI.Inline>
            )}
            {after.others.length === 0 ? null : (
              <UI.Disclosure
                data-testid="delivery-earlier-pull-requests"
                summary={t("tasks.delivery.afterApproval.earlier", {
                  count: after.others.length,
                })}
              >
                <UI.Stack gap="compact" role="list">
                  {after.others.map((other) => (
                    <UI.Inline
                      gap="compact"
                      key={other.providerNumber}
                      role="listitem"
                    >
                      <UI.Link href={other.url} variant="external">
                        {t("tasks.delivery.afterApproval.earlierRow", {
                          number: other.providerNumber,
                        })}
                      </UI.Link>
                      <UI.Text variant="muted">
                        {t(
                          `tasks.delivery.afterApproval.status.${other.status}` as MessageKey,
                        )}
                      </UI.Text>
                    </UI.Inline>
                  ))}
                </UI.Stack>
              </UI.Disclosure>
            )}
          </UI.Stack>
        )}
      </UI.Stack>
    </UI.Disclosure>
  );
}

/**
 * Everything under the headline (#57 redesign, revision 2): what needs
 * attention, one settled line, and two closed links. Each fact has one home.
 */
export function DeliveryBody(
  { model, onOpenRules }: Readonly<{
    model: DeliveryModel;
    onOpenRules: () => void;
  }>,
) {
  return (
    <>
      <Attention items={attentionItems(model)} onOpenRules={onOpenRules} />
      <Settled model={model} />
      {model.checks.rows.length === 0 && model.review === null ? null : (
        <>
          <Tried fixing={model.fixing} />
          <Details model={model} />
        </>
      )}
    </>
  );
}

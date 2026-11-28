import * as UI from "@bakery/ui";
import type { MessageArguments, MessageKey, Translator } from "@bakery/i18n";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { useShellViewport } from "../app/responsive.ts";
import {
  type CheckResult,
  type CheckRow,
  groupCheckRows,
} from "./machine-checks.ts";
import { checkInfo } from "./machine-page-state.ts";

function message(
  translate: Translator,
  key: string,
  arguments_?: MessageArguments,
): string {
  return translate(key as MessageKey, arguments_);
}

const RESULT_BADGE = {
  pass: { tone: "success", key: "machines.checks.passed" },
  fail: { tone: "danger", key: "machines.checks.failed" },
  unknown: { tone: "warning", key: "machines.checks.unknown" },
  not_applicable: { tone: "neutral", key: "machines.checks.notApplicable" },
} as const satisfies Record<CheckResult, unknown>;

const OUT_OF_DATE = {
  tone: "neutral",
  key: "machines.checks.outOfDate",
} as const;

export function MachineCheckTable(
  { rows, reachable, formatDate }: {
    readonly rows: readonly CheckRow[];
    readonly reachable: boolean;
    readonly formatDate: (value: string) => string;
  },
) {
  const { translate } = useI18n();
  const phone = useShellViewport() === "phone";
  const name = (row: CheckRow) => {
    const info = checkInfo(row.checkId);
    if (info.nameKey === null) return row.checkId;
    return row.agent && info.nameKey.endsWith(".model")
      ? message(translate, "machines.check.name.capability.modelAgent", {
        agent: message(translate, `machines.agent.${row.agent}`),
      })
      : message(translate, info.nameKey, { agent: "" });
  };
  const outOfDate = (row: CheckRow) => !reachable && row.result === "unknown";
  const result = (row: CheckRow) => {
    const badge = outOfDate(row) ? OUT_OF_DATE : RESULT_BADGE[row.result];
    return (
      <UI.Badge tone={badge.tone}>{message(translate, badge.key)}</UI.Badge>
    );
  };
  const checked = (row: CheckRow) =>
    row.observedAt === null ? "—" : formatDate(row.observedAt);
  const advice = (row: CheckRow) => {
    if (row.result === "pass" || row.result === "not_applicable") return "—";
    const fix = outOfDate(row)
      ? "machines.checks.outOfDateAdvice"
      : row.result === "unknown"
      ? "machines.checks.couldNotRun"
      : checkInfo(row.checkId).fixKey;
    const reason = row.reason ??
      (row.result === "fail"
        ? message(translate, "machines.checks.noReason")
        : null);
    return (
      <UI.Stack gap="compact">
        {fix ? <UI.Text>{message(translate, fix)}</UI.Text> : null}
        {reason
          ? (
            <UI.ExpandableText
              lines={6}
              showLabel={message(translate, "machines.checks.showMore")}
              hideLabel={message(translate, "machines.checks.showLess")}
            >
              {reason}
            </UI.ExpandableText>
          )
          : null}
      </UI.Stack>
    );
  };
  return (
    <UI.Stack gap="standard">
      {rows.some((row) => row.result === "fail" || outOfDate(row))
        ? null
        : <UI.Text>{message(translate, "machines.checks.none")}</UI.Text>}
      {groupCheckRows(rows).map((section) => {
        const title = message(
          translate,
          `machines.checks.group.${section.group}`,
        );
        return (
          <UI.Stack key={section.group} gap="compact">
            <UI.Heading level="subsection-compact" rank={3}>
              {title}
            </UI.Heading>
            {phone
              ? (
                <UI.Stack gap="none" role="list" aria-label={title}>
                  {section.rows.map((row) => (
                    <div key={row.key} role="listitem">
                      <UI.StackedRow title={name(row)} status={result(row)}>
                        {row.observedAt === null
                          ? null
                          : (
                            <UI.Text variant="caption">
                              {message(translate, "machines.checks.checkedAt", {
                                time: checked(row),
                              })}
                            </UI.Text>
                          )}
                        {advice(row) === "—" ? null : advice(row)}
                      </UI.StackedRow>
                    </div>
                  ))}
                </UI.Stack>
              )
              : (
                <UI.DataTable
                  caption={title}
                  captionHidden
                  columns={[
                    {
                      id: "check",
                      width: "22%",
                      header: message(translate, "machines.checks.col.check"),
                      cell: name,
                    },
                    {
                      id: "result",
                      width: "18%",
                      header: message(translate, "machines.checks.col.result"),
                      cell: result,
                    },
                    {
                      id: "checked",
                      width: "22%",
                      header: message(translate, "machines.checks.col.checked"),
                      cell: checked,
                    },
                    {
                      id: "fix",
                      width: "38%",
                      header: message(translate, "machines.checks.col.fix"),
                      cell: advice,
                    },
                  ]}
                  emptyMessage={message(translate, "machines.checks.none")}
                  getRowKey={(row) => row.key}
                  rows={section.rows}
                />
              )}
          </UI.Stack>
        );
      })}
    </UI.Stack>
  );
}

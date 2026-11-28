import {
  type CheckGroup,
  type CheckInfo,
  checkInfo,
  groupChecks,
} from "./machine-page-state.ts";

export type CheckResult = "pass" | "fail" | "unknown" | "not_applicable";

export type ReportedCheck = Readonly<{
  checkId: string;
  componentKey: string | null;
  result: CheckResult;
  reason: string | null;
  observedAt: string;
}>;

export type FailedCheck = Readonly<{
  checkId: string;
  reason?: string | null;
}>;

export type CheckRow = Readonly<{
  key: string;
  checkId: string;
  agent: CheckInfo["agent"];
  result: CheckResult;
  reason: string | null;
  observedAt: string | null;
}>;

function agentOf(check: ReportedCheck): CheckInfo["agent"] {
  const component = check.componentKey?.replace(/^harness\./, "");
  return component === "claude" || component === "codex" || component === "pi"
    ? component
    : checkInfo(check.checkId).agent;
}

export function checkRows(
  reported: readonly ReportedCheck[],
  failed: readonly FailedCheck[],
): CheckRow[] {
  const unreported = failed.filter((check) =>
    !reported.some((entry) => entry.checkId === check.checkId)
  );
  return [
    ...reported.map((check) => ({
      key: `${check.checkId} ${check.componentKey ?? ""}`,
      checkId: check.checkId,
      agent: agentOf(check),
      result: check.result,
      reason: check.reason?.trim() || null,
      observedAt: check.observedAt,
    })),
    ...unreported.map((check) => ({
      key: check.checkId,
      checkId: check.checkId,
      agent: checkInfo(check.checkId).agent,
      result: "fail" as const,
      reason: check.reason?.trim() || null,
      observedAt: null,
    })),
  ];
}

export function groupCheckRows(
  rows: readonly CheckRow[],
): { group: CheckGroup; rows: CheckRow[] }[] {
  return groupChecks([...new Set(rows.map((row) => row.checkId))]).map((
    { group, ids },
  ) => ({
    group,
    rows: ids.flatMap((id) => rows.filter((row) => row.checkId === id)),
  }));
}

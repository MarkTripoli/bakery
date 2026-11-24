import type {
  ApprovalResponse,
  RunStepListResponse,
} from "../../api/client.ts";

type RunStepItem = RunStepListResponse["items"][number];

function stepApprovals(
  approvals: readonly ApprovalResponse[],
  runId: string,
): ApprovalResponse[] {
  return [...approvals]
    .filter((approval) =>
      approval.subjectType === "run_step" && approval.subjectId === runId
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function openStepApproval(
  approvals: readonly ApprovalResponse[],
  runId: string,
): ApprovalResponse | null {
  return stepApprovals(approvals, runId).find((approval) =>
    approval.status === "open"
  ) ?? null;
}

export function latestStepApproval(
  approvals: readonly ApprovalResponse[],
  runId: string,
): ApprovalResponse | null {
  return stepApprovals(approvals, runId)[0] ?? null;
}

export function approvalStep(
  steps: readonly RunStepItem[],
): RunStepItem | null {
  const newest = (items: readonly RunStepItem[]) =>
    [...items].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ??
      null;
  return newest(steps.filter((step) => step.status === "waiting")) ??
    newest(steps);
}

export function stepName(stepKey: string | null): string {
  if (stepKey === null) return "step";
  const words = stepKey.replace(/[._-]+/g, " ").trim().toLowerCase();
  return words === "" ? "step" : words;
}

export function capitalized(text: string): string {
  return text.length === 0 ? text : text[0]!.toUpperCase() + text.slice(1);
}

export type Decision = "approve" | "request_changes" | "reject";

export function decisionOf(approval: ApprovalResponse | null): Decision | null {
  const decision = approval?.decision;
  return decision === "approve" || decision === "request_changes" ||
      decision === "reject"
    ? decision
    : null;
}

export type RunOutcome = Readonly<{
  decision: "request_changes" | "reject";
  note: string;
  decidedBy: string | null;
}>;

export function runOutcome(
  approval: ApprovalResponse | null,
  runStatus: string | undefined,
): RunOutcome | null {
  const decision = decisionOf(approval);
  if (
    approval === null || runStatus !== "canceled" ||
    (decision !== "request_changes" && decision !== "reject")
  ) return null;
  return {
    decision,
    note: (approval.decisionComment ?? "").trim(),
    decidedBy: approval.decidedBy,
  };
}

export type Refusal =
  | "decided"
  | "newer"
  | "withdrawn"
  | "closed"
  | "outside"
  | "failed";

export function refusalOf(
  failure: { status: number | null; reason: string | null },
): Refusal {
  const reason = failure.reason;
  if (reason === "approval_decided") return "decided";
  if (reason === "approval_superseded" || reason === "approval_stale") {
    return "newer";
  }
  if (reason === "approval_revoked") return "withdrawn";
  if (
    reason === "approval_unavailable" || reason === "approval_expired" ||
    reason === "approval_consumed" || reason === "approval_withdrawn"
  ) return "closed";
  if (failure.status === 404) return "outside";
  return "failed";
}

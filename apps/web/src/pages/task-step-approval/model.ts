import type {
  ApprovalResponse,
  ArtifactVersionResponse,
  RunStepListResponse,
} from "../../api/client.ts";

type RunStepItem = RunStepListResponse["items"][number];

export type StepApproval = Readonly<{
  approval: ApprovalResponse;
  step: RunStepItem | null;
}>;

export function openStepApproval(
  approvals: readonly ApprovalResponse[],
  runId: string,
): ApprovalResponse | null {
  return [...approvals]
    .filter((approval) =>
      approval.subjectType === "run_step" && approval.status === "open" &&
      approval.subjectId === runId
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;
}

export function waitingStep(
  steps: readonly RunStepItem[],
): RunStepItem | null {
  return [...steps]
    .filter((step) => step.status === "waiting")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;
}

export function stepName(stepKey: string | null): string {
  if (stepKey === null) return "step";
  const words = stepKey.replace(/[._-]+/g, " ").trim().toLowerCase();
  return words === "" ? "step" : words;
}

export function capitalized(text: string): string {
  return text.length === 0 ? text : text[0]!.toUpperCase() + text.slice(1);
}

export function documentVersion(
  versions: readonly ArtifactVersionResponse[],
  stepIds: ReadonlySet<string>,
  waitingStepId: string | null,
): ArtifactVersionResponse | null {
  return [...versions]
    .filter((version) =>
      version.runStepId !== null && stepIds.has(version.runStepId) &&
      version.runStepId !== waitingStepId &&
      (version.mediaType.startsWith("text/") ||
        version.mediaType === "application/json")
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;
}

export function minutesLeft(
  expiresAt: string | null,
  now: number,
): { unit: "days" | "hours" | "minutes"; count: number } | null {
  if (expiresAt === null) return null;
  const minutes = Math.max(
    0,
    Math.floor((Date.parse(expiresAt) - now) / 60_000),
  );
  if (minutes >= 1_440) {
    return { unit: "days", count: Math.floor(minutes / 1_440) };
  }
  if (minutes >= 60) return { unit: "hours", count: Math.floor(minutes / 60) };
  return { unit: "minutes", count: minutes };
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

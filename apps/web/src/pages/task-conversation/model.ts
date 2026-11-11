import type {
  ApprovalResponse,
  MessageResponse,
  PlanRevisionResponse,
  QuestionResponse,
  TaskResponse,
} from "../../api/client.ts";

export type StageId = "discuss" | "plan" | "implement" | "review";
export type StageWait = "human_approval" | "automatic";

export const STAGES: readonly StageId[] = [
  "discuss",
  "plan",
  "implement",
  "review",
];

export type PlanBody = Readonly<{
  title: string;
  steps: readonly { id: string; title: string; detail: string }[];
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reads a plan body defensively; a malformed body renders as no steps. */
export function planBody(revision: PlanRevisionResponse): PlanBody {
  const body = revision.body;
  if (!isRecord(body)) return { title: "", steps: [] };
  const steps = Array.isArray(body.steps)
    ? body.steps.flatMap((step) =>
      isRecord(step) && typeof step.id === "string" &&
        typeof step.title === "string"
        ? [{
          id: step.id,
          title: step.title,
          detail: typeof step.detail === "string" ? step.detail : "",
        }]
        : []
    )
    : [];
  return {
    title: typeof body.title === "string" ? body.title : "",
    steps,
  };
}

/** The plan stage policy the task stored; a task without one is automatic. */
export function planPolicy(task: TaskResponse): StageWait {
  const policy = task.approvalPolicy;
  return isRecord(policy) && policy.plan === "human_approval"
    ? "human_approval"
    : "automatic";
}

/**
 * What a stage waits on: the plan policy the task stored, and the review
 * policy when the task stored one. Discuss and implement run automatically.
 */
export function stageWait(task: TaskResponse, stage: StageId): StageWait {
  if (stage === "plan") return planPolicy(task);
  const policy = task.approvalPolicy;
  return stage === "review" && isRecord(policy) &&
      policy.review === "human_approval"
    ? "human_approval"
    : "automatic";
}

/** The fixed workflow stage the task is in, from server state only. */
export function currentStage(
  task: TaskResponse,
  latestPlan: PlanRevisionResponse | undefined,
  openQuestion = false,
): StageId {
  if (task.currentRunId !== null) {
    return task.status === "completed" || task.status === "failed" ||
        task.status === "canceled"
      ? "review"
      : "implement";
  }
  return latestPlan || openQuestion ? "plan" : "discuss";
}

/** Latest revision first, as the server lists them. */
export function latestRevision(
  revisions: readonly PlanRevisionResponse[],
): PlanRevisionResponse | undefined {
  return [...revisions].sort((a, b) => b.revision - a.revision)[0];
}

/** The approval bound to this exact revision, newest first. */
export function approvalFor(
  revision: PlanRevisionResponse,
  approvals: readonly ApprovalResponse[],
): ApprovalResponse | undefined {
  return [...approvals]
    .filter((approval) =>
      approval.subjectType === "plan_revision" &&
      approval.subjectId === revision.id &&
      approval.subjectDigest === revision.digest
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}

/** Chronological transcript from newest-first pages. */
export function chronological(
  pages: readonly { items: readonly MessageResponse[] }[],
): MessageResponse[] {
  const seen = new Set<string>();
  const all: MessageResponse[] = [];
  for (const page of pages) {
    for (const message of page.items) {
      if (seen.has(message.id)) continue;
      seen.add(message.id);
      all.push(message);
    }
  }
  return all.sort((a, b) => {
    const left = BigInt(a.sequence);
    const right = BigInt(b.sequence);
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

export type QuestionOption = Readonly<{ id: string; label: string }>;

export function questionOptions(
  question: QuestionResponse,
): readonly QuestionOption[] {
  const options = question.options;
  if (!Array.isArray(options)) return [];
  return options.flatMap((option) =>
    isRecord(option) && typeof option.id === "string" &&
      typeof option.label === "string"
      ? [{ id: option.id, label: option.label }]
      : []
  );
}

/** Human text of a recorded answer: the option label and any free text. */
export function answerText(question: QuestionResponse): string {
  const answer = question.answer;
  if (!isRecord(answer)) return "";
  const label = typeof answer.optionId === "string"
    ? questionOptions(question).find((option) => option.id === answer.optionId)
      ?.label ?? answer.optionId
    : undefined;
  const text = typeof answer.text === "string" ? answer.text : undefined;
  return [label, text].filter((part) => part !== undefined).join(": ");
}

/** A failed API call as the conversation panel classifies it. */
export type CommandFailure =
  | "unknown"
  | "forbidden"
  | "conflict"
  | "error";

export function commandFailure(failure: {
  kind: string;
  problem?: { status: number; retryable: boolean; code?: string };
}): CommandFailure {
  if (failure.kind !== "problem" || !failure.problem) return "unknown";
  const { status, retryable } = failure.problem;
  if (retryable || status >= 500 || status === 408) return "unknown";
  if (status === 403) return "forbidden";
  // A reused key with a different payload is a client fault, not a stale revision.
  if (failure.problem.code === "IDEMPOTENCY_PAYLOAD_MISMATCH") return "error";
  if (status === 409 || status === 412) return "conflict";
  return "error";
}

/** One person in the shared conversation, named from the API projection. */
export type Person = Readonly<{
  id: string;
  /** Display name, or a short id when the API named no one. */
  name: string;
  named: boolean;
  you: boolean;
}>;

/**
 * People in the conversation: transcript authors plus the API's participant
 * projection (task creator, answerers, deciders). The current principal comes
 * first, the rest by name. A person the API did not name keeps a short id.
 */
export function participantsOf(
  authorIds: readonly (string | null)[],
  projection: readonly { principalId: string; displayName: string }[],
  principalId: string | null,
  fallback: (id: string) => string,
): Person[] {
  const names = new Map(
    projection.map((item) => [item.principalId, item.displayName]),
  );
  const ids = new Set<string>(names.keys());
  for (const id of authorIds) if (id !== null) ids.add(id);
  if (principalId !== null) ids.add(principalId);
  return [...ids].map((id) => {
    const name = names.get(id);
    return {
      id,
      name: name ?? fallback(id),
      named: name !== undefined,
      you: id === principalId,
    };
  }).sort((a, b) =>
    a.you === b.you ? a.name.localeCompare(b.name) : a.you ? -1 : 1
  );
}
